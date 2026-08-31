import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateWorkflowReport, normaliseWorkflowType, workflowTemplates } from '../../src/workflowTemplates.js';
import {
  cloneScopeData,
  countCapturedMessages,
  defaultMembershipRecord,
  defaultWorkspaceRecord,
  legacyWorkspaceId,
  loadAppState,
  loadCapturedMessages,
  loadMemberships,
  saveCapturedMessage,
  saveAppState,
  loadUsers,
  loadWorkspaces,
  saveMemberships,
  saveWorkspaces,
  saveUsers,
  workspaceScopeFor,
} from '../../src/netlifyStore.js';
import { backgroundTaskSecret, cookieFlags, createSessionToken, readUserSession } from '../../src/netlifyAuth.js';
import { providerSessionUser, supabaseAuthConfig, verifySupabaseAccessToken } from '../../src/supabaseAuth.js';
import { defaultPaidPlan, listPaidPlans, normalisePaidPlanId, paidPlanById, paidPlanByPriceId, paidPlanForCheckout, planNameForId } from '../../src/billingPlans.js';
import { billingTopUpById, consumeAllowanceWithCredits, listBillingTopUps } from '../../src/billingTopUps.js';
import { createCustomerPortalSession, createSubscriptionCheckoutSession, createTopUpCheckoutSession, stripeCheckoutReady } from '../../src/stripeBilling.js';
import { buildPendingVoiceNote, isVoiceMedia } from '../../src/transcription.js';
import { isValidTranscriptionLanguage, transcriptionLanguageOptions } from '../../src/transcriptionLanguages.js';
import { mockGroups, postApprovedRecap, sampleChat, sampleVoiceNotes } from '../../src/connectors/mockWhatsApp.js';
import {
  configureWahaWebhook,
  createWahaSession,
  getGroupMessagesFromWaha,
  getGroupMessagesFromWahaSearch,
  getWahaQr,
  getWahaStatus,
  listGroupsFromWaha,
  logoutWahaSession,
  postRecapToWaha,
  startWahaSession,
} from '../../src/connectors/waha.js';
import { applyWorkspaceWahaSettings, selectWahaWorker } from '../../src/workspaceSession.js';
import { totalTranscriptionMinutes, transcriptionMinutes } from '../../src/audioUsage.js';
import { applyApprovedGroups, entitledApprovedGroups, groupLimitForPlan, normaliseApprovedGroups } from '../../src/groupAccess.js';
import { deliverOutboundWebhook, validateOutboundWebhookUrl } from '../../src/outboundWebhook.js';
import {
  getTelegramMessages,
  getTelegramStatus,
  listTelegramGroups,
  logoutTelegramSession,
  startTelegramSession,
  submitTelegramPassword,
} from '../../src/connectors/telegram.js';

const adminSessionMaxAgeSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 7);
const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
const managedWahaBaseUrl = String(process.env.WAHA_BASE_URL || '').replace(/\/+$/, '');
const managedTelegramBaseUrl = String(process.env.TELEGRAM_BASE_URL || (managedWahaBaseUrl ? `${managedWahaBaseUrl}/telegram` : '')).replace(/\/+$/, '');
const legacySharedScope = 'shared';
const trialDays = Number(process.env.TRIAL_DAYS || 3);
const trialRecapLimit = Number(process.env.TRIAL_RECAP_LIMIT || 2);
const trialTranscriptionMinuteLimit = Number(process.env.TRIAL_TRANSCRIPTION_MINUTES || 10);
const ownerTimeoutMinutes = Number(process.env.SHARED_SESSION_TIMEOUT_MINUTES || 45);
const activationWindowDays = Number(process.env.PAID_ACTIVATION_WINDOW_DAYS || 7);
const paidUsageWindowDays = Number(process.env.PAID_USAGE_WINDOW_DAYS || 30);
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const adminEmails = new Set(
  `${process.env.ADMIN_EMAILS || ''},${process.env.ADMIN_EMAIL || ''}`
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

function managedSettings(settings = {}, workspace = {}) {
  return applyWorkspaceWahaSettings(settings, workspace, process.env);
}

function requiredSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw httpError(500, `${name} is not configured.`);
  }
  return value;
}

function webhookToken(scope = legacySharedScope) {
  return createHmac('sha256', requiredSecret('ADMIN_SESSION_SECRET'))
    .update(String(scope || legacySharedScope))
    .digest('hex');
}

function publicSettings(settings) {
  return {
    ...settings,
    approvedGroups: normaliseApprovedGroups(settings),
    wahaApiKey: settings.wahaApiKey ? 'configured' : '',
    outboundWebhookSecret: settings.outboundWebhookSecret ? 'configured' : '',
  };
}

function nowIso() {
  return new Date().toISOString();
}

function telegramOptions(state) {
  if (!managedTelegramBaseUrl) throw new Error('The Telegram connector is not configured yet.');
  return {
    baseUrl: managedTelegramBaseUrl,
    apiKey: state.settings.wahaApiKey || process.env.WAHA_API_KEY || '',
    session: state.settings.wahaSession,
  };
}

function nowMs() {
  return Date.now();
}

function ownerTimeoutMs() {
  return ownerTimeoutMinutes * 60 * 1000;
}

function paidUsageWindowMs() {
  return paidUsageWindowDays * 24 * 60 * 60 * 1000;
}

function trialEndIso(startedAt) {
  return new Date(new Date(startedAt).getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();
}

function sessionOwnerName(user = {}) {
  const displaySource = String(user.displayName || user.name || '').trim();
  if (displaySource) {
    return displaySource.split(/\s+/)[0];
  }
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return 'Workspace member';
  const localPart = email.split('@')[0] || '';
  const candidate = localPart.split(/[._-]+/).find(Boolean) || localPart;
  if (!candidate) return 'Workspace member';
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

function workspaceIdForUser(user = {}) {
  const preferred = String(user.userId || user.email || '').trim().toLowerCase();
  const suffix = preferred.replace(/[^a-z0-9_-]/g, '-').slice(0, 80) || `workspace-${Date.now()}`;
  return `workspace-${suffix}`;
}

function workspaceNameForUser(user = {}) {
  const ownerName = sessionOwnerName(user);
  return ownerName === 'Workspace member'
    ? 'Nzuko workspace'
    : `${ownerName}'s workspace`;
}

function normaliseEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isAdminUser(user = {}) {
  const email = normaliseEmail(user.email);
  if (!email) return false;
  if (!adminEmails.size) {
    return false;
  }
  return adminEmails.has(email);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resetUserTrial(record = {}) {
  const startedAt = nowIso();
  return {
    ...record,
    trialStartedAt: startedAt,
    trialEndsAt: trialEndIso(startedAt),
    trialRecapsUsed: 0,
    trialVoiceNotesUsed: 0,
    trialTranscriptionMinutesUsed: 0,
    subscriptionStatus: 'trial',
    planId: 'trial',
    planName: 'Starter trial',
    activatedAt: null,
    activatedBy: '',
    subscriptionEndsAt: null,
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    stripeCheckoutSessionId: '',
    lastPaymentAt: null,
    paymentReservationAt: null,
    paymentReservationSource: '',
    usageWindowStartedAt: null,
    paidRecapsUsed: 0,
    paidVoiceNotesUsed: 0,
    paidTranscriptionMinutesUsed: 0,
    recapTopUpCredits: 0,
    transcriptionTopUpMinutes: 0,
    appliedTopUpSessionIds: [],
  };
}

function ensureRecordDefaults(record = {}) {
  const nextSubscriptionStatus = record.subscriptionStatus || 'trial';
  const nextPlanId = nextSubscriptionStatus === 'trial'
    ? 'trial'
    : (record.planId ? normalisePaidPlanId(record.planId) : defaultPaidPlan()?.id || 'starter');
  return {
    ...record,
    trialStartedAt: record.trialStartedAt || nowIso(),
    trialEndsAt: record.trialEndsAt || trialEndIso(record.trialStartedAt || nowIso()),
    trialRecapsUsed: Number(record.trialRecapsUsed || 0),
    trialVoiceNotesUsed: Number(record.trialVoiceNotesUsed || 0),
    trialTranscriptionMinutesUsed: Number(record.trialTranscriptionMinutesUsed ?? record.trialVoiceNotesUsed ?? 0),
    subscriptionStatus: nextSubscriptionStatus,
    planId: nextPlanId,
    planName: record.planName || (nextPlanId === 'trial' ? 'Starter trial' : planNameForId(nextPlanId)),
    workspaceId: record.workspaceId || '',
    activatedAt: record.activatedAt || null,
    activatedBy: record.activatedBy || '',
    subscriptionEndsAt: record.subscriptionEndsAt || null,
    stripeCustomerId: record.stripeCustomerId || '',
    stripeSubscriptionId: record.stripeSubscriptionId || '',
    stripeCheckoutSessionId: record.stripeCheckoutSessionId || '',
    lastPaymentAt: record.lastPaymentAt || null,
    paymentReservationAt: record.paymentReservationAt || null,
    paymentReservationSource: record.paymentReservationSource || '',
    usageWindowStartedAt: record.usageWindowStartedAt || record.activatedAt || record.lastPaymentAt || null,
    paidRecapsUsed: Number(record.paidRecapsUsed || 0),
    paidVoiceNotesUsed: Number(record.paidVoiceNotesUsed || 0),
    paidTranscriptionMinutesUsed: Number(record.paidTranscriptionMinutesUsed ?? record.paidVoiceNotesUsed ?? 0),
    recapTopUpCredits: Number(record.recapTopUpCredits || 0),
    transcriptionTopUpMinutes: Number(record.transcriptionTopUpMinutes || 0),
    appliedTopUpSessionIds: Array.isArray(record.appliedTopUpSessionIds) ? record.appliedTopUpSessionIds : [],
    suspendedAt: record.suspendedAt || null,
    suspendedBy: record.suspendedBy || '',
  };
}

function logUsageEvent(state, event = {}) {
  const nextEvent = {
    id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowIso(),
    type: event.type || 'event',
    actorUserId: event.actorUserId || '',
    actorName: event.actorName || '',
    actorEmail: event.actorEmail || '',
    summary: event.summary || '',
    details: event.details || {},
  };
  state.usageEvents = [nextEvent, ...(Array.isArray(state.usageEvents) ? state.usageEvents : [])].slice(0, 200);
}

function stripeSignatureParts(header = '') {
  const parts = String(header || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) || '';
  const signatures = parts
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3))
    .filter(Boolean);
  return { timestamp, signatures };
}

function safeHexEquals(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left || ''), 'hex');
    const rightBuffer = Buffer.from(String(right || ''), 'hex');
    if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  if (!stripeWebhookSecret) {
    throw httpError(500, 'Stripe webhook secret is not configured.');
  }
  const { timestamp, signatures } = stripeSignatureParts(signatureHeader);
  if (!timestamp || !signatures.length) {
    throw httpError(401, 'Missing Stripe signature details.');
  }
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = createHmac('sha256', stripeWebhookSecret).update(signedPayload).digest('hex');
  if (!signatures.some((signature) => safeHexEquals(signature, expectedSignature))) {
    throw httpError(401, 'Invalid Stripe signature.');
  }
}

function stripeEventEmail(event = {}) {
  const object = event.data?.object || {};
  return normaliseEmail(
    object.customer_email ||
      object.customer_details?.email ||
      object.receipt_email ||
      object.metadata?.email ||
      object.billing_details?.email
  );
}

function stripeEventPlanName(event = {}) {
  const object = event.data?.object || {};
  return (
    paidPlanById(object.metadata?.plan_id)?.name ||
    paidPlanByPriceId(object.items?.data?.[0]?.price?.id)?.name ||
    paidPlanByPriceId(object.lines?.data?.[0]?.price?.id)?.name ||
    object.metadata?.plan_name ||
    object.lines?.data?.[0]?.description ||
    object.display_items?.[0]?.custom?.name ||
    'Nzuko AI Starter'
  );
}

function unixToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

function stripeObjectCustomerId(object = {}) {
  return String(object.customer || object.customer_id || '').trim();
}

function stripeObjectSubscriptionId(object = {}) {
  if (String(object.object || '') === 'subscription') {
    return String(object.id || '').trim();
  }
  return String(object.subscription || '').trim();
}

function stripeObjectCheckoutSessionId(object = {}) {
  return String(object.id || '').trim();
}

function stripeEventPlanId(event = {}) {
  const object = event.data?.object || {};
  const candidatePlanId = String(
    object.metadata?.plan_id ||
    object.subscription_details?.metadata?.plan_id ||
    object.items?.data?.[0]?.plan?.metadata?.plan_id ||
    object.lines?.data?.[0]?.price?.metadata?.plan_id ||
    ''
  ).trim().toLowerCase();
  if (paidPlanById(candidatePlanId)) {
    return candidatePlanId;
  }
  return (
    paidPlanByPriceId(object.items?.data?.[0]?.price?.id)?.id ||
    paidPlanByPriceId(object.lines?.data?.[0]?.price?.id)?.id ||
    defaultPaidPlan()?.id ||
    'starter'
  );
}

function stripeEventPeriod(event = {}) {
  const object = event.data?.object || {};
  return {
    start:
      unixToIso(object.current_period_start) ||
      unixToIso(object.lines?.data?.[0]?.period?.start) ||
      null,
    end:
      unixToIso(object.current_period_end) ||
      unixToIso(object.lines?.data?.[0]?.period?.end) ||
      null,
  };
}

function matchingStripeUser(users, object = {}, email = '') {
  const customerId = stripeObjectCustomerId(object);
  const subscriptionId = stripeObjectSubscriptionId(object);
  return (
    users.find((entry) => subscriptionId && String(entry.stripeSubscriptionId || '') === subscriptionId) ||
    users.find((entry) => customerId && String(entry.stripeCustomerId || '') === customerId) ||
    users.find((entry) => email && normaliseEmail(entry.email) === normaliseEmail(email)) ||
    null
  );
}

function activatePaidUser(record, details = {}) {
  const activatedAt = details.activatedAt || nowIso();
  const planId = normalisePaidPlanId(details.planId || record.planId || defaultPaidPlan()?.id);
  const previousSubscriptionEndsAt = record.subscriptionEndsAt || null;
  record.subscriptionStatus = 'active';
  record.planId = planId;
  record.planName = details.planName || planNameForId(planId);
  record.activatedAt = record.activatedAt || activatedAt;
  record.lastPaymentAt = activatedAt;
  record.paymentReservationAt = null;
  record.paymentReservationSource = '';
  record.stripeCustomerId = details.customerId || record.stripeCustomerId || '';
  record.stripeSubscriptionId = details.subscriptionId || record.stripeSubscriptionId || '';
  record.stripeCheckoutSessionId = details.checkoutSessionId || record.stripeCheckoutSessionId || '';
  if (details.subscriptionEndsAt) {
    record.subscriptionEndsAt = details.subscriptionEndsAt;
  }
  if (!record.usageWindowStartedAt || (details.subscriptionEndsAt && details.subscriptionEndsAt !== previousSubscriptionEndsAt)) {
    record.usageWindowStartedAt = activatedAt;
    record.paidRecapsUsed = 0;
    record.paidVoiceNotesUsed = 0;
    record.paidTranscriptionMinutesUsed = 0;
  }
}

function markStripeEvent(state, event = {}) {
  state.billing.lastStripeEventId = event.id || '';
  state.billing.lastStripeEventType = event.type || '';
  state.billing.lastStripeEventAt = nowIso();
}

function activePaidPlan(record = {}) {
  if (String(record.subscriptionStatus || '').toLowerCase() !== 'active') {
    return null;
  }
  return paidPlanById(record.planId);
}

function normalisePaidUsageWindow(record, { resetAt } = {}) {
  const paidPlan = activePaidPlan(record);
  if (!paidPlan) {
    return false;
  }
  const startedAt = new Date(record.usageWindowStartedAt || record.lastPaymentAt || record.activatedAt || 0).getTime();
  const isExpired = !startedAt || Number.isNaN(startedAt) || nowMs() - startedAt >= paidUsageWindowMs();
  if (!record.usageWindowStartedAt || isExpired || resetAt) {
    record.usageWindowStartedAt = resetAt || record.lastPaymentAt || record.activatedAt || nowIso();
    record.paidRecapsUsed = 0;
    record.paidVoiceNotesUsed = 0;
    record.paidTranscriptionMinutesUsed = 0;
    return true;
  }
  return false;
}

function usageSummary(record = {}) {
  const normalisedRecord = ensureRecordDefaults({ ...record });
  const paidPlan = activePaidPlan(normalisedRecord);
  if (paidPlan) {
    normalisePaidUsageWindow(normalisedRecord);
    const recapLimit = Number(paidPlan.monthlyRecapLimit || 0);
    const transcriptionMinuteLimit = Number(paidPlan.monthlyTranscriptionMinuteLimit || 0);
    const recapUsed = Number(normalisedRecord.paidRecapsUsed || 0);
    const transcriptionMinutesUsed = Number(normalisedRecord.paidTranscriptionMinutesUsed || 0);
    return {
      mode: 'paid',
      windowDays: paidUsageWindowDays,
      windowStartedAt: normalisedRecord.usageWindowStartedAt || null,
      recapLimit,
      recapUsed,
      recapRemaining: Math.max(0, recapLimit - recapUsed) + Number(normalisedRecord.recapTopUpCredits || 0),
      recapTopUpCredits: Number(normalisedRecord.recapTopUpCredits || 0),
      transcriptionMinuteLimit,
      transcriptionMinutesUsed,
      transcriptionMinutesRemaining: Math.max(0, transcriptionMinuteLimit - transcriptionMinutesUsed) + Number(normalisedRecord.transcriptionTopUpMinutes || 0),
      transcriptionTopUpMinutes: Number(normalisedRecord.transcriptionTopUpMinutes || 0),
      planName: paidPlan.name,
    };
  }

  const trial = trialStatus(normalisedRecord);
  return {
    mode: 'trial',
    windowDays: trial.trialDays,
    windowStartedAt: normalisedRecord.trialStartedAt || null,
    recapLimit: trial.recapLimit,
    recapUsed: trial.recapUsed,
    recapRemaining: trial.recapRemaining,
    transcriptionMinuteLimit: trial.transcriptionMinuteLimit,
    transcriptionMinutesUsed: trial.transcriptionMinutesUsed,
    transcriptionMinutesRemaining: trial.transcriptionMinutesRemaining,
    planName: trial.planName,
  };
}

function ensureUsageAllowed(record, feature, count = 1) {
  const usage = usageSummary(record);
  if (feature === 'recap' && usage.recapRemaining < count) {
    throw httpError(
      403,
      usage.mode === 'paid'
        ? `You have reached the ${usage.planName} recap limit for this billing period.`
        : 'You have reached your trial recap limit. Upgrade to continue using this workspace.'
    );
  }
  if (feature === 'transcription-minute' && usage.transcriptionMinutesRemaining < count) {
    throw httpError(
      403,
      usage.mode === 'paid'
        ? `You have reached the ${usage.planName} transcription-minute limit for this billing period.`
        : 'You have reached your trial transcription-minute limit. Upgrade to continue using this workspace.'
    );
  }
}

function recordUsage(record, feature, count = 1) {
  if (activePaidPlan(record)) {
    normalisePaidUsageWindow(record);
    if (feature === 'recap') {
      const consumed = consumeAllowanceWithCredits({ used: record.paidRecapsUsed, limit: activePaidPlan(record).monthlyRecapLimit, credits: record.recapTopUpCredits, count });
      record.paidRecapsUsed = consumed.used;
      record.recapTopUpCredits = consumed.credits;
    }
    if (feature === 'transcription-minute') {
      const consumed = consumeAllowanceWithCredits({ used: record.paidTranscriptionMinutesUsed, limit: activePaidPlan(record).monthlyTranscriptionMinuteLimit, credits: record.transcriptionTopUpMinutes, count });
      record.paidTranscriptionMinutesUsed = Math.round(consumed.used * 10) / 10;
      record.transcriptionTopUpMinutes = Math.round(consumed.credits * 10) / 10;
    }
    return;
  }

  if (feature === 'recap') {
    record.trialRecapsUsed = Number(record.trialRecapsUsed || 0) + count;
  }
  if (feature === 'transcription-minute') {
    record.trialTranscriptionMinutesUsed = Math.round((Number(record.trialTranscriptionMinutesUsed || 0) + count) * 10) / 10;
  }
}

function billingSummary(record = {}) {
  const normalisedRecord = ensureRecordDefaults(record);
  const paidPlan = normalisedRecord.planId === 'trial' ? null : paidPlanById(normalisedRecord.planId);
  const usage = usageSummary(normalisedRecord);
  const plans = listPaidPlans().map((plan) => ({
    ...plan,
    isCurrent: Boolean(paidPlan?.id === plan.id),
  }));
  return {
    subscriptionStatus: normalisedRecord.subscriptionStatus || 'trial',
    planId: normalisedRecord.planId || 'trial',
    planName: normalisedRecord.planName || 'Starter trial',
    isSubscribed: String(normalisedRecord.subscriptionStatus || '').toLowerCase() === 'active',
    isPendingActivation: String(normalisedRecord.subscriptionStatus || '').toLowerCase() === 'pending_activation',
    activationWindowDays,
    checkoutReady: plans.some((plan) => stripeCheckoutReady(plan)),
    paymentMode: String(process.env.STRIPE_SECRET_KEY || '').includes('_test_') ? 'test' : 'live',
    activatedAt: normalisedRecord.activatedAt || null,
    subscriptionEndsAt: normalisedRecord.subscriptionEndsAt || null,
    lastPaymentAt: normalisedRecord.lastPaymentAt || null,
    paymentReservationAt: normalisedRecord.paymentReservationAt || null,
    stripeWebhookConfigured: Boolean(stripeWebhookSecret),
    currentPlan: paidPlan,
    plans,
    topUps: listBillingTopUps().map(({ stripePriceEnv, ...topUp }) => topUp),
    usage,
    customerPortalAvailable: Boolean(normalisedRecord.stripeCustomerId),
  };
}

async function loadOrCreateUserAccess(user = {}) {
  const users = await loadUsers();
  const userId = String(user.userId || '').trim();
  const email = String(user.email || '').trim().toLowerCase();
  let changed = false;
  let record = users.find((entry) => String(entry.userId || '') === userId);

  if (!record && email) {
    record = users.find((entry) => normaliseEmail(entry.email) === email) || null;
    if (record && String(record.userId || '') !== userId) {
      record.userId = userId;
      changed = true;
    }
  }

  if (!record) {
    record = ensureRecordDefaults({
      userId,
      email,
      displayName: sessionOwnerName(user),
    });
    users.push(record);
    changed = true;
  } else {
    record = ensureRecordDefaults(record);
    if (record.email !== email) {
      record.email = email;
      changed = true;
    }
    const displayName = sessionOwnerName(user);
    if (record.displayName !== displayName) {
      record.displayName = displayName;
      changed = true;
    }
  }

  if (changed) {
    await saveUsers(users);
  }

  return { users, record };
}

async function saveUserAccess(users, record) {
  const nextUsers = users.map((entry) => (entry.userId === record.userId ? record : entry));
  await saveUsers(nextUsers);
  return record;
}

function trialStatus(record = {}) {
  const expiresAtMs = new Date(record.trialEndsAt || 0).getTime();
  const msRemaining = expiresAtMs - nowMs();
  const subscriptionStatus = String(record.subscriptionStatus || '').toLowerCase();
  const isSubscribed = subscriptionStatus === 'active';
  const isPendingActivation = subscriptionStatus === 'pending_activation';
  const isTrialActive = !isSubscribed && msRemaining > 0;
  const daysRemaining = isSubscribed ? null : Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
  const recapsUsed = Number(record.trialRecapsUsed || 0);
  const transcriptionMinutesUsed = Number(record.trialTranscriptionMinutesUsed ?? record.trialVoiceNotesUsed ?? 0);
  const isSuspended = Boolean(record.suspendedAt);

  return {
    subscriptionStatus: record.subscriptionStatus || 'trial',
    planName: record.planName || 'Starter trial',
    trialDays,
    trialEndsAt: record.trialEndsAt,
    daysRemaining,
    recapLimit: trialRecapLimit,
    recapUsed: recapsUsed,
    recapRemaining: Math.max(0, trialRecapLimit - recapsUsed),
    transcriptionMinuteLimit: trialTranscriptionMinuteLimit,
    transcriptionMinutesUsed,
    transcriptionMinutesRemaining: Math.max(0, trialTranscriptionMinuteLimit - transcriptionMinutesUsed),
    isSubscribed,
    isPendingActivation,
    isTrialActive,
    isSuspended,
    suspendedAt: record.suspendedAt || null,
    canUseApp: !isSuspended && (isSubscribed || isTrialActive),
  };
}

async function loadWorkspaceOwnerAccess(state) {
  const ownerUserId = String(state.sharedSession?.ownerUserId || '').trim();
  if (!ownerUserId) {
    return null;
  }
  const users = await loadUsers();
  const record = users.find((entry) => String(entry.userId || '') === ownerUserId);
  if (!record) {
    return null;
  }
  return {
    users,
    record: ensureRecordDefaults(record),
  };
}

async function workspaceMaps() {
  const [workspaces, memberships] = await Promise.all([loadWorkspaces(), loadMemberships()]);
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const membershipByUserId = new Map(
    memberships
      .filter((membership) => membership.userId)
      .map((membership) => [String(membership.userId || ''), membership])
  );
  return {
    workspaces,
    memberships,
    workspaceById,
    membershipByUserId,
  };
}

function userWorkspaceId(record, membershipByUserId) {
  return String(
    record.workspaceId ||
    membershipByUserId.get(String(record.userId || ''))?.workspaceId ||
    ''
  ).trim();
}

async function resolveWorkspaceMembership(user = {}) {
  const workspaces = await loadWorkspaces();
  const memberships = await loadMemberships();
  const sharedWorkspace =
    workspaces.find((workspace) => workspace.id === legacyWorkspaceId()) ||
    defaultWorkspaceRecord({ id: legacyWorkspaceId(), scope: legacySharedScope, legacyShared: true });
  const userId = String(user.userId || '').trim();

  let changed = false;
  let workspace = sharedWorkspace;
  let membership =
    memberships.find((entry) => String(entry.userId || '').trim() === userId) ||
    null;
  const sharedWorkspaceMembers = memberships.filter((entry) => entry.workspaceId === sharedWorkspace.id);

  if (membership) {
    workspace =
      workspaces.find((entry) => entry.id === membership.workspaceId) ||
      sharedWorkspace;
    if (workspace.id !== membership.workspaceId) {
      membership.workspaceId = workspace.id;
      membership.updatedAt = nowIso();
      changed = true;
    }
    if (workspace.legacyShared && sharedWorkspaceMembers.length <= 1 && userId) {
      const migratedWorkspace = defaultWorkspaceRecord({
        id: workspaceIdForUser(user),
        name: workspaceNameForUser(user),
        ownerUserId: userId,
      });
      if (!workspaces.some((entry) => entry.id === migratedWorkspace.id)) {
        workspaces.push(migratedWorkspace);
      }
      await cloneScopeData(workspaceScopeFor(sharedWorkspace), workspaceScopeFor(migratedWorkspace));
      membership.workspaceId = migratedWorkspace.id;
      membership.updatedAt = nowIso();
      workspace = migratedWorkspace;
      changed = true;
    }
  } else if (userId) {
    workspace = defaultWorkspaceRecord({
      id: workspaceIdForUser(user),
      name: workspaceNameForUser(user),
      ownerUserId: userId,
    });
    if (!workspaces.some((entry) => entry.id === workspace.id)) {
      workspaces.push(workspace);
    }
    membership = defaultMembershipRecord({
      workspaceId: workspace.id,
      userId,
      role: 'owner',
    });
    memberships.push(membership);
    changed = true;
  }

  if (!workspaces.some((entry) => entry.id === sharedWorkspace.id)) {
    workspaces.unshift(sharedWorkspace);
    changed = true;
  }

  const assignedWorker = selectWahaWorker(workspace, process.env);
  if (assignedWorker && workspace.wahaWorkerId !== assignedWorker.id) {
    workspace.wahaWorkerId = assignedWorker.id;
    workspace.updatedAt = nowIso();
    changed = true;
  }

  if (changed) {
    await saveWorkspaces(workspaces);
    await saveMemberships(memberships);
  }

  return {
    workspace,
    membership,
  };
}

function ownerStateSummary(state, user = {}) {
  const sharedSession = state.sharedSession || {};
  const ownerUserId = String(sharedSession.ownerUserId || '');
  const lastActivityAt = sharedSession.lastActivityAt ? new Date(sharedSession.lastActivityAt).getTime() : 0;
  const isExpired = ownerUserId ? (nowMs() - lastActivityAt > ownerTimeoutMs()) : false;
  const activeOwnerUserId = isExpired ? '' : ownerUserId;
  const isCurrentUserOwner = Boolean(activeOwnerUserId) && activeOwnerUserId === String(user.userId || '');
  return {
    ownerUserId: activeOwnerUserId,
    ownerName: isExpired ? '' : String(sharedSession.ownerName || ''),
    claimedAt: isExpired ? null : sharedSession.claimedAt,
    lastActivityAt: isExpired ? null : sharedSession.lastActivityAt,
    isExpired,
    hasOwner: Boolean(activeOwnerUserId),
    isCurrentUserOwner,
    timeoutMinutes: ownerTimeoutMinutes,
  };
}

function clearSharedOwner(state) {
  state.sharedSession = {
    ownerUserId: '',
    ownerName: '',
    claimedAt: null,
    lastActivityAt: null,
  };
}

async function normaliseSharedOwner(scope, state) {
  const ownerSummary = ownerStateSummary(state);
  if (ownerSummary.isExpired) {
    clearSharedOwner(state);
    await saveAppState(scope, state);
    return ownerStateSummary(state);
  }
  return ownerSummary;
}

async function claimSharedOwner(scope, state, user) {
  const timestamp = nowIso();
  state.sharedSession = {
    ownerUserId: String(user.userId || ''),
    ownerName: sessionOwnerName(user),
    claimedAt: state.sharedSession?.ownerUserId === String(user.userId || '') && state.sharedSession?.claimedAt
      ? state.sharedSession.claimedAt
      : timestamp,
    lastActivityAt: timestamp,
  };
  await saveAppState(scope, state);
  return ownerStateSummary(state, user);
}

async function touchSharedOwnerActivity(scope, state, user) {
  if (String(state.sharedSession?.ownerUserId || '') !== String(user.userId || '')) {
    return ownerStateSummary(state, user);
  }
  state.sharedSession.lastActivityAt = nowIso();
  await saveAppState(scope, state);
  return ownerStateSummary(state, user);
}

function ensureTrialAllowed(trial, feature = 'use Nzuko AI') {
  if (!trial.canUseApp) {
    throw httpError(403, 'Your trial limit has ended. Upgrade to continue using this workspace.');
  }
  if (feature === 'recap' && !trial.isSubscribed && trial.recapRemaining <= 0) {
    throw httpError(403, 'You have reached your trial recap limit. Upgrade to continue using this workspace.');
  }
}

function ensureSharedOwnerAllowed(ownerSummary, user, { allowTakeover = false } = {}) {
  if (!ownerSummary.hasOwner) return;
  if (ownerSummary.isCurrentUserOwner) return;
  if (ownerSummary.isExpired) return;
  if (allowTakeover) return;
  throw httpError(403, 'Another WhatsApp account is currently connected. Switch WhatsApp user to connect your own account.');
}

async function loadWorkspaceContext(user) {
  const { workspace, membership } = await resolveWorkspaceMembership(user);
  const scope = workspaceScopeFor(workspace);
  const state = await loadAppState(scope);
  state.settings = managedSettings(state.settings, workspace);
  const ownerSummary = await normaliseSharedOwner(scope, state);
  const { users, record } = await loadOrCreateUserAccess(user);
  if (record.workspaceId !== workspace.id) {
    record.workspaceId = workspace.id;
    await saveUserAccess(users, record);
  }
  return {
    scope,
    workspace,
    membership,
    state,
    ownerSummary: ownerStateSummary(state, user),
    users,
    userRecord: record,
    trial: trialStatus(record),
  };
}

function sendJson(statusCode, payload, headers = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function publicApiRoute(pathname) {
  return pathname === '/api/auth/status' ||
    pathname === '/api/auth/social-session' ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/webhooks/waha' ||
    pathname === '/api/webhooks/stripe';
}

function routePathname(requestUrl) {
  const redirectedPath = requestUrl.searchParams.get('path');
  if (!redirectedPath) return requestUrl.pathname;
  return `/api/${redirectedPath.replace(/^\/+/, '')}`;
}

function routeUrl(request) {
  const requestUrl = new URL(request.url);
  return {
    requestUrl,
    pathname: routePathname(requestUrl),
  };
}

function assertAdminUser(user = {}) {
  if (!isAdminUser(user)) {
    throw httpError(403, 'Admin access is required for this action.');
  }
}

function webhookBaseUrl(requestUrl) {
  return publicAppUrl || requestUrl.origin;
}

async function readBody(request) {
  const raw = await request.text();
  return raw ? JSON.parse(raw) : {};
}

async function readRawBody(request) {
  return request.text();
}

function approvedGroupChatId(payload = {}) {
  const candidates = [
    payload.chatId,
    payload.chat?.id?._serialized,
    payload.chat?.id,
    payload.from,
    payload.to,
    payload.author,
    payload.participant,
    payload.id?.remote,
    payload.id?.remoteJid,
    payload.id?.participant,
    payload.key?.remoteJid,
    payload.message?.key?.remoteJid,
    payload._data?.chatId,
    payload._data?.id?.remote,
    payload._data?.id?.remoteJid,
    payload._data?.from,
    payload._data?.to,
    payload._data?.key?.remoteJid,
    payload._data?.message?.key?.remoteJid,
  ].filter(Boolean);
  const exact = candidates.find((candidate) => String(candidate).endsWith('@g.us'));
  if (exact) return exact;
  const serialized = JSON.stringify(payload);
  const match = serialized.match(/\d+(?:-\d+)?@g\.us/);
  return match?.[0] || '';
}

function messageBody(payload = {}) {
  return (
    payload.body ||
    payload.text ||
    payload.caption ||
    payload._data?.body ||
    payload._data?.text ||
    payload.message?.conversation ||
    payload._data?.message?.conversation ||
    payload.message?.extendedTextMessage?.text ||
    payload._data?.message?.extendedTextMessage?.text ||
    ''
  );
}

function messageSender(payload = {}) {
  const sender =
    payload.fromMe
      ? 'Assistant account'
      : payload.pushName ||
        payload.notifyName ||
        payload.author ||
        payload.participant ||
        payload.key?.participant ||
        payload._data?.key?.participant ||
        payload.from ||
        'Group member';
  return String(sender).endsWith('@g.us') ? 'Group member' : sender;
}

function splitMessageText(messages) {
  const voiceTypes = new Set(['audio', 'ptt']);
  const isVoiceNote = (message) => message.voiceNote || message.needsReview || voiceTypes.has(String(message.type || '').toLowerCase());
  return {
    chatText: messages
      .filter((message) => !isVoiceNote(message))
      .map((message) => `${message.from}: ${message.body}`)
      .join('\n'),
    voiceNotes: messages
      .filter(isVoiceNote)
      .map((message) => `${message.from}: ${message.body}`)
      .join('\n'),
  };
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateRangeForPreset(preset) {
  const now = new Date();
  const end = new Date(now.getTime() + 1);
  if (preset === 'year') {
    return { from: new Date(now.getFullYear(), 0, 1).toISOString(), to: end.toISOString() };
  }
  if (preset === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: end.toISOString() };
  }
  if (preset === 'week') {
    const today = startOfDay(now);
    const mondayOffset = (today.getDay() + 6) % 7;
    today.setDate(today.getDate() - mondayOffset);
    return { from: today.toISOString(), to: end.toISOString() };
  }
  return { from: startOfDay(now).toISOString(), to: end.toISOString() };
}

function selectedDateRange({ preset, from, to }) {
  if (from || to) {
    return {
      from: from ? new Date(`${from}T00:00:00`).toISOString() : null,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : new Date().toISOString(),
    };
  }
  return dateRangeForPreset(preset || 'today');
}

function epochSeconds(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

async function pullWahaMessagesForRange({ settings, range, limit = 1000 }) {
  try {
    return await getGroupMessagesFromWaha({
      baseUrl: settings.wahaBaseUrl,
      session: settings.wahaSession,
      apiKey: settings.wahaApiKey,
      chatId: settings.approvedGroupId,
      limit,
      fromTimestamp: epochSeconds(range.from),
      toTimestamp: epochSeconds(range.to),
      downloadMedia: true,
    });
  } catch (primaryError) {
    try {
      return await getGroupMessagesFromWahaSearch({
        baseUrl: settings.wahaBaseUrl,
        session: settings.wahaSession,
        apiKey: settings.wahaApiKey,
        chatId: settings.approvedGroupId,
        limit,
        fromTimestamp: epochSeconds(range.from),
        toTimestamp: epochSeconds(range.to),
        downloadMedia: true,
      });
    } catch (fallbackError) {
      fallbackError.message = `${primaryError.message}; alternate WAHA search also failed: ${fallbackError.message}`;
      throw fallbackError;
    }
  }
}

async function ensureManagedWahaSession({ settings, requestUrl, scope }) {
  const resolvedScope = String(scope || legacySharedScope).trim() || legacySharedScope;
  const webhookUrl = `${webhookBaseUrl(requestUrl)}/api/webhooks/waha?scope=${encodeURIComponent(resolvedScope)}&token=${encodeURIComponent(webhookToken(resolvedScope))}`;
  try {
    await configureWahaWebhook({
      baseUrl: settings.wahaBaseUrl,
      session: settings.wahaSession,
      apiKey: settings.wahaApiKey,
      webhookUrl,
    });
  } catch (error) {
    if (error.status !== 404 && !/404|session not found/i.test(String(error.message || ''))) {
      throw error;
    }
    await createWahaSession({
      baseUrl: settings.wahaBaseUrl,
      session: settings.wahaSession,
      apiKey: settings.wahaApiKey,
      webhookUrl,
    });
  }
  return webhookUrl;
}

async function enqueueVoiceNoteProcessing({ requestUrl, payload, scope }) {
  try {
    await fetch(`${requestUrl.origin}/.netlify/functions/process-voice-note-background`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nzuko-task-secret': backgroundTaskSecret(),
      },
      body: JSON.stringify({ payload, scope }),
    });
  } catch (error) {
    console.error(`Background voice-note dispatch failed: ${error.message}`);
  }
}

function transcriptionMinutesForVoiceMessages(messages = []) {
  return totalTranscriptionMinutes(messages.filter((message) => isVoiceMedia(message)));
}

function messageIdentifier(message = {}) {
  return String(message.id?._serialized || message.id || message._data?.id?._serialized || '').trim();
}

async function unmeteredVoiceMessages(scope, messages = []) {
  const existing = await loadCapturedMessages(scope, { limit: 5000 });
  const existingIds = new Set(existing.map(messageIdentifier).filter(Boolean));
  return messages.filter((message) => isVoiceMedia(message) && (!messageIdentifier(message) || !existingIds.has(messageIdentifier(message))));
}

async function captureMappedWahaMessage({ message, requestUrl, settings, scope }) {
  const storedMessage = {
    ...message,
    groupId: settings.approvedGroupId,
  };
  if (isVoiceMedia(storedMessage)) {
    await saveCapturedMessage(scope, {
      ...buildPendingVoiceNote({ payload: storedMessage, reason: 'transcription queued in background' }),
      groupId: settings.approvedGroupId,
    });
    await enqueueVoiceNoteProcessing({ requestUrl, payload: storedMessage, scope });
    return;
  }
  await saveCapturedMessage(scope, storedMessage);
}

async function captureApprovedWebhookPayload({ payload, requestUrl, settings, scope }) {
  const groupId = approvedGroupChatId(payload) || settings.approvedGroupId;
  if (isVoiceMedia(payload)) {
    await saveCapturedMessage(scope, {
      ...buildPendingVoiceNote({ payload, reason: 'transcription queued in background' }),
      groupId,
    });
    await enqueueVoiceNoteProcessing({
      requestUrl,
      scope,
      payload: {
        ...payload,
        groupId,
      },
    });
    return;
  }

  const body = messageBody(payload);
  if (body) {
    await saveCapturedMessage(scope, {
      id: payload.id?._serialized || payload.id || `message-${Date.now()}`,
      groupId,
      from: messageSender(payload),
      body,
      timestamp: payload.timestamp || Date.now(),
      hasMedia: Boolean(payload.hasMedia),
      type: payload.type || 'chat',
    });
  }
}

export default async function handler(request) {
  const { requestUrl, pathname } = routeUrl(request);

  try {
    if (request.method === 'GET' && pathname === '/api/auth/status') {
      const session = readUserSession(request);
      const context = session ? await loadWorkspaceContext(session) : null;
      const supabase = supabaseAuthConfig();
      return sendJson(200, {
        authenticated: Boolean(session),
        user: session || null,
        appName: 'Nzuko AI',
        groupName: context?.state?.settings?.approvedGroupName || '',
        trial: context?.trial || null,
        workspaceSession: context?.ownerSummary || null,
        sharedSession: context?.ownerSummary || null,
        workspace: context?.workspace || null,
        auth: {
          configured: supabase.configured,
          providers: ['google'],
          supabaseUrl: supabase.url,
          supabasePublishableKey: supabase.publishableKey,
        },
      });
    }

    if (request.method === 'POST' && pathname === '/api/auth/social-session') {
      const body = await readBody(request);
      const accessToken = String(body.accessToken || '');
      if (!accessToken) {
        return sendJson(400, { error: 'Missing social access token.' });
      }
      const claims = await verifySupabaseAccessToken(accessToken);
      const user = providerSessionUser(claims);
      if (!user.userId || !user.email) {
        return sendJson(401, { error: 'The provider did not return a usable account profile.' });
      }

      const state = await loadAppState(legacySharedScope);
      state.settings = managedSettings(state.settings, { id: legacyWorkspaceId(), legacyShared: true });
      logUsageEvent(state, {
        type: 'auth.login',
        actorUserId: user.userId || '',
        actorName: sessionOwnerName(user),
        actorEmail: user.email || '',
        summary: `${sessionOwnerName(user)} signed in.`,
      });
      await saveAppState(legacySharedScope, state);

      const token = createSessionToken(user, adminSessionMaxAgeSeconds);
      return sendJson(200, {
        ok: true,
        message: 'Sign-in confirmed.',
        user,
      }, {
        'set-cookie': `nzuko_admin=${encodeURIComponent(token)}; ${cookieFlags(request, adminSessionMaxAgeSeconds)}`,
      });
    }

    if (request.method === 'POST' && pathname === '/api/auth/logout') {
      return sendJson(200, { ok: true }, {
        'set-cookie': `nzuko_admin=; ${cookieFlags(request, 0)}`,
      });
    }

    if (request.method === 'POST' && pathname === '/api/webhooks/stripe') {
      const rawBody = await readRawBody(request);
      verifyStripeWebhookSignature(rawBody, request.headers.get('stripe-signature') || '');
      const event = rawBody ? JSON.parse(rawBody) : {};
      const state = await loadAppState(legacySharedScope);
      state.settings = managedSettings(state.settings);

      if (event.id && event.id === state.billing.lastStripeEventId) {
        return sendJson(200, { ok: true, duplicate: true });
      }

      const users = await loadUsers();
      const email = stripeEventEmail(event);
      const planId = stripeEventPlanId(event);
      const planName = stripeEventPlanName(event);
      const eventType = String(event.type || '');
      const object = event.data?.object || {};
      const isTopUpCheckout = eventType === 'checkout.session.completed' && object.metadata?.purchase_type === 'topup';
      const stripePeriod = stripeEventPeriod(event);
      const eventAt = unixToIso(event.created) || nowIso();
      let matchingUser = matchingStripeUser(users, object, email);

      const shouldCreateUser = [
        'checkout.session.completed',
        'invoice.paid',
        'customer.subscription.updated',
      ].includes(eventType);

      if (!matchingUser && email && shouldCreateUser) {
        matchingUser = ensureRecordDefaults({
          userId: String(object.metadata?.user_id || object.client_reference_id || '').trim(),
          email,
          displayName: email.split('@')[0] || 'Workspace member',
        });
        users.push(matchingUser);
      }

      if (isTopUpCheckout) {
        const topUp = billingTopUpById(object.metadata?.topup_id);
        const sessionId = stripeObjectCheckoutSessionId(object);
        if (matchingUser && topUp && !matchingUser.appliedTopUpSessionIds.includes(sessionId)) {
          matchingUser.recapTopUpCredits = Number(matchingUser.recapTopUpCredits || 0) + Number(topUp.recaps || 0);
          matchingUser.transcriptionTopUpMinutes = Number(matchingUser.transcriptionTopUpMinutes || 0) + Number(topUp.transcriptionMinutes || 0);
          matchingUser.appliedTopUpSessionIds = [sessionId, ...matchingUser.appliedTopUpSessionIds].slice(0, 100);
          logUsageEvent(state, {
            type: 'billing.topup_credited',
            actorUserId: matchingUser.userId || '',
            actorName: matchingUser.displayName || '',
            actorEmail: matchingUser.email || email,
            summary: `${topUp.name} credited to ${matchingUser.email || 'workspace member'}.`,
            details: { topUpId: topUp.id, checkoutSessionId: sessionId },
          });
        }
      } else if (eventType === 'checkout.session.completed' || eventType === 'invoice.paid') {
        if (matchingUser) {
          activatePaidUser(matchingUser, {
            planId,
            planName,
            customerId: stripeObjectCustomerId(object),
            subscriptionId: stripeObjectSubscriptionId(object),
            checkoutSessionId: stripeObjectCheckoutSessionId(object),
            subscriptionEndsAt: stripePeriod.end,
            activatedAt: eventAt,
          });
        } else if (email) {
          matchingUser = ensureRecordDefaults({
            userId: String(object.metadata?.user_id || object.client_reference_id || '').trim(),
            email,
            displayName: email.split('@')[0] || 'Workspace member',
            subscriptionStatus: 'pending_activation',
            planId,
            planName,
            paymentReservationAt: eventAt,
            paymentReservationSource: 'stripe',
            lastPaymentAt: eventAt,
            stripeCustomerId: stripeObjectCustomerId(object),
            stripeSubscriptionId: stripeObjectSubscriptionId(object),
            stripeCheckoutSessionId: stripeObjectCheckoutSessionId(object),
          });
          users.push(matchingUser);
        }
        logUsageEvent(state, {
          type: 'billing.subscription_activated',
          actorUserId: matchingUser?.userId || '',
          actorName: matchingUser?.displayName || '',
          actorEmail: email,
          summary: `Stripe activated paid access for ${email || 'unknown customer'}.`,
          details: {
            eventType,
            planId,
            planName,
            customerId: stripeObjectCustomerId(object),
            subscriptionId: stripeObjectSubscriptionId(object),
          },
        });
      } else if (eventType === 'customer.subscription.updated' && matchingUser) {
        const status = String(object.status || '').toLowerCase();
        if (status === 'active' || status === 'trialing') {
          activatePaidUser(matchingUser, {
            planId,
            planName,
            customerId: stripeObjectCustomerId(object),
            subscriptionId: stripeObjectSubscriptionId(object),
            subscriptionEndsAt: stripePeriod.end,
            activatedAt: eventAt,
          });
          logUsageEvent(state, {
            type: 'billing.subscription_updated',
            actorUserId: matchingUser.userId || '',
            actorName: matchingUser.displayName || '',
            actorEmail: matchingUser.email || '',
            summary: `Subscription updated for ${matchingUser.email || 'workspace member'}.`,
            details: {
              eventType,
              status,
              planId,
              planName,
            },
          });
        } else if (status === 'past_due' || status === 'unpaid') {
          matchingUser.subscriptionStatus = 'past_due';
          matchingUser.subscriptionEndsAt = stripePeriod.end || matchingUser.subscriptionEndsAt;
          logUsageEvent(state, {
            type: 'billing.payment_failed',
            actorUserId: matchingUser.userId || '',
            actorName: matchingUser.displayName || '',
            actorEmail: matchingUser.email || '',
            summary: `Subscription payment issue for ${matchingUser.email || 'workspace member'}.`,
            details: {
              eventType,
              status,
              planId,
              planName,
            },
          });
        } else if (status === 'canceled' || status === 'incomplete_expired') {
          matchingUser.subscriptionStatus = 'canceled';
          matchingUser.subscriptionEndsAt = stripePeriod.end || eventAt;
          logUsageEvent(state, {
            type: 'billing.subscription_canceled',
            actorUserId: matchingUser.userId || '',
            actorName: matchingUser.displayName || '',
            actorEmail: matchingUser.email || '',
            summary: `Subscription canceled for ${matchingUser.email || 'workspace member'}.`,
            details: {
              eventType,
              status,
              planId,
              planName,
            },
          });
        }
      } else if (eventType === 'customer.subscription.deleted' && matchingUser) {
        matchingUser.subscriptionStatus = 'canceled';
        matchingUser.subscriptionEndsAt = stripePeriod.end || eventAt;
        logUsageEvent(state, {
          type: 'billing.subscription_canceled',
          actorUserId: matchingUser.userId || '',
          actorName: matchingUser.displayName || '',
          actorEmail: matchingUser.email || '',
          summary: `Subscription canceled for ${matchingUser.email || 'workspace member'}.`,
          details: {
            eventType,
            planName,
          },
        });
      } else if (eventType === 'invoice.payment_failed' && matchingUser) {
        matchingUser.subscriptionStatus = 'past_due';
        matchingUser.subscriptionEndsAt = stripePeriod.end || matchingUser.subscriptionEndsAt;
        logUsageEvent(state, {
          type: 'billing.payment_failed',
          actorUserId: matchingUser.userId || '',
          actorName: matchingUser.displayName || '',
          actorEmail: matchingUser.email || '',
          summary: `Payment failed for ${matchingUser.email || 'workspace member'}.`,
          details: {
            eventType,
            planName,
          },
        });
      }

      markStripeEvent(state, event);
      await saveUsers(users.map((entry) => ensureRecordDefaults(entry)));
      await saveAppState(legacySharedScope, state);
      return sendJson(200, { ok: true });
    }

    const session = readUserSession(request);
    if (!publicApiRoute(pathname) && !session) {
      return sendJson(401, { error: 'Login is required.' });
    }

    if (request.method === 'POST' && pathname === '/api/webhooks/waha') {
      const scope = String(requestUrl.searchParams.get('scope') || legacySharedScope).trim() || legacySharedScope;
      const token = requestUrl.searchParams.get('token') || '';
      const expectedToken = webhookToken(scope);
      if (!token || token !== expectedToken) {
        return sendJson(401, { error: 'Invalid webhook token.' });
      }
      const body = await readBody(request);
      const payload = body.payload || body;
      const state = await loadAppState(scope);
      const webhookWorkspaces = await loadWorkspaces();
      const webhookWorkspace = webhookWorkspaces.find((entry) => workspaceScopeFor(entry) === scope) || {
        id: scope,
        legacyShared: scope === legacySharedScope,
      };
      state.settings = managedSettings(state.settings, webhookWorkspace);
      const workspaceOwnerAccess = await loadWorkspaceOwnerAccess(state);
      const approvedGroups = entitledApprovedGroups(state.settings, workspaceOwnerAccess?.record?.planId || 'trial');
      const approvedGroupIds = new Set(approvedGroups.map((group) => group.id));
      const chatId = approvedGroupChatId(payload);
      state.webhookStats.received += 1;
      state.webhookStats.lastReceivedAt = new Date().toISOString();

      if (approvedGroupIds.has(chatId)) {
        state.webhookStats.matchedApprovedGroup += 1;
        state.webhookStats.lastMatchedAt = new Date().toISOString();
        if (isVoiceMedia(payload)) {
          const ownerAccess = await loadWorkspaceOwnerAccess(state);
          if (ownerAccess) {
            const [unmetered] = await unmeteredVoiceMessages(scope, [payload]);
            if (unmetered) {
              const minutes = transcriptionMinutes(unmetered);
              ensureUsageAllowed(ownerAccess.record, 'transcription-minute', minutes);
              recordUsage(ownerAccess.record, 'transcription-minute', minutes);
              await saveUserAccess(ownerAccess.users, ownerAccess.record);
            }
          }
        }
        await captureApprovedWebhookPayload({
          payload,
          requestUrl,
          settings: state.settings,
          scope,
        });
      } else {
        state.webhookStats.ignored += 1;
        state.webhookStats.lastIgnoredChatId = chatId || 'not-a-group-message';
        state.webhookStats.lastIgnoredReason = chatId
          ? 'Webhook was for a different group chat.'
          : 'Webhook did not include a group chat id.';
      }

      logUsageEvent(state, {
        type: 'waha.webhook_received',
        actorUserId: '',
        actorName: '',
        actorEmail: '',
        summary: approvedGroupIds.has(chatId) ? 'Captured an approved-group WhatsApp message.' : 'Ignored a WhatsApp webhook outside the approved groups.',
        details: {
          chatId,
          approvedGroupIds: [...approvedGroupIds],
        },
      });

      await saveAppState(scope, state);
      return sendJson(200, { ok: true });
    }

    if (request.method === 'GET' && pathname === '/api/status') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary, workspace, userRecord } = context;
      const capturedCount = await countCapturedMessages(scope, { groupId: state.settings.approvedGroupId });
      return sendJson(200, {
        app: 'Nzuko AI',
        user: {
          userId: session.userId || '',
          email: session.email || '',
          displayName: session.displayName || session.name || '',
        },
        connector: state.settings.connectorMode,
        settings: publicSettings(applyApprovedGroups(state.settings, entitledApprovedGroups(state.settings, userRecord.planId))),
        userScoped: !workspace?.legacyShared,
        workspace,
        managedWahaConnection: Boolean(managedWahaBaseUrl),
        groupAccess: {
          limit: groupLimitForPlan(userRecord.planId),
          approvedCount: normaliseApprovedGroups(state.settings).length,
        },
        draftReady: Boolean(state.currentDraft),
        auditCount: state.auditLog.length,
        capturedCount,
        webhookStats: state.webhookStats,
        trial,
        workspaceSession: ownerSummary,
        sharedSession: ownerSummary,
        billing: billingSummary(context.userRecord),
        admin: {
          isAdmin: isAdminUser(session),
        },
        transcription: {
          openaiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
          model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
          language: state.settings.transcribeLanguage || 'auto',
          languageOptions: transcriptionLanguageOptions.map(({ value, label }) => ({ value, label })),
        },
        workflowTemplates,
      });
    }

    if (request.method === 'POST' && pathname === '/api/billing/checkout') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, userRecord } = context;
      const body = await readBody(request);
      const plan = paidPlanForCheckout(body.planId || defaultPaidPlan()?.id, body.billingInterval);
      if (!plan) {
        return sendJson(400, { error: 'Choose a valid subscription plan first.' });
      }
      if (!stripeCheckoutReady(plan)) {
        return sendJson(500, { error: `Stripe checkout is not configured for the ${plan.name} plan yet.` });
      }
      if (String(userRecord.subscriptionStatus || '').toLowerCase() === 'active' && userRecord.stripeCustomerId) {
        return sendJson(400, { error: 'Your subscription is already active. Use Manage billing to change plans.' });
      }

      const checkout = await createSubscriptionCheckoutSession({
        plan,
        customerEmail: userRecord.email || session.email || '',
        customerId: userRecord.stripeCustomerId || '',
        publicAppUrl: publicAppUrl || requestUrl.origin,
        userId: userRecord.userId || session.userId || '',
      });

      logUsageEvent(state, {
        type: 'billing.checkout_started',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} started Stripe checkout for ${plan.name} (${plan.billingInterval}).`,
        details: {
          planId: plan.id,
          planName: plan.name,
          billingInterval: plan.billingInterval,
          checkoutSessionId: checkout.id,
        },
      });
      await saveAppState(scope, state);
      return sendJson(200, {
        url: checkout.url,
        plan: {
          id: plan.id,
          name: plan.name,
        },
      });
    }

    if (request.method === 'POST' && pathname === '/api/billing/portal') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, userRecord } = context;
      if (!userRecord.stripeCustomerId) {
        return sendJson(400, { error: 'No active Stripe customer was found for this workspace yet.' });
      }

      const portal = await createCustomerPortalSession({
        customerId: userRecord.stripeCustomerId,
        publicAppUrl: publicAppUrl || requestUrl.origin,
      });

      logUsageEvent(state, {
        type: 'billing.portal_opened',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} opened the Stripe customer portal.`,
      });
      await saveAppState(scope, state);
      return sendJson(200, { url: portal.url });
    }

    if (request.method === 'POST' && pathname === '/api/billing/topup-checkout') {
      const { scope, state, userRecord } = await loadWorkspaceContext(session);
      if (String(userRecord.subscriptionStatus || '').toLowerCase() !== 'active') {
        return sendJson(403, { error: 'Top-ups are available to active subscribers.' });
      }
      const body = await readBody(request);
      const topUp = billingTopUpById(body.topUpId);
      if (!topUp) return sendJson(400, { error: 'Choose a valid top-up first.' });
      if (!topUp.checkoutEnabled) return sendJson(500, { error: `${topUp.name} is not configured in Stripe yet.` });
      const checkout = await createTopUpCheckoutSession({
        topUp,
        customerEmail: userRecord.email || session.email || '',
        customerId: userRecord.stripeCustomerId || '',
        publicAppUrl: publicAppUrl || requestUrl.origin,
        userId: userRecord.userId || session.userId || '',
      });
      logUsageEvent(state, {
        type: 'billing.topup_checkout_started',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} started checkout for ${topUp.name}.`,
        details: { topUpId: topUp.id, checkoutSessionId: checkout.id },
      });
      await saveAppState(scope, state);
      return sendJson(200, { url: checkout.url });
    }

    if (request.method === 'GET' && pathname === '/api/admin/billing') {
      assertAdminUser(session);
      const { workspaces, workspaceById, membershipByUserId } = await workspaceMaps();
      const workspaceStates = await Promise.all(
        workspaces.map(async (workspace) => {
          const scope = workspaceScopeFor(workspace);
          const state = await loadAppState(scope);
          const settings = managedSettings(state.settings, workspace);
          let connectionStatus = 'not_started';
          try {
            const connection = await getWahaStatus({
              baseUrl: settings.wahaBaseUrl,
              session: settings.wahaSession,
              apiKey: settings.wahaApiKey,
            });
            connectionStatus = String(connection?.status || 'reachable').toLowerCase();
          } catch (error) {
            connectionStatus = error.status === 404 || /session not found/i.test(String(error.message || ''))
              ? 'not_started'
              : 'unavailable';
          }
          return {
            workspace,
            state,
            connectionStatus,
            capturedCount: await countCapturedMessages(scope),
          };
        })
      );
      const users = (await loadUsers())
        .map((entry) => ensureRecordDefaults(entry))
        .sort((left, right) => new Date(right.lastPaymentAt || right.trialStartedAt || 0).getTime() - new Date(left.lastPaymentAt || left.trialStartedAt || 0).getTime());
      const recentUsageEvents = workspaceStates
        .flatMap(({ workspace, state }) =>
          (state.usageEvents || []).map((event) => ({
            ...event,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          }))
        )
        .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
        .slice(0, 40);
      const pendingActivations = users
        .filter((entry) => String(entry.subscriptionStatus || '').toLowerCase() === 'pending_activation')
        .map((entry) => {
          const workspaceId = userWorkspaceId(entry, membershipByUserId);
          const workspace = workspaceById.get(workspaceId);
          return {
            email: entry.email,
            planId: entry.planId,
            planName: entry.planName,
            queuedAt: entry.paymentReservationAt || entry.lastPaymentAt || entry.trialStartedAt || '',
            workspaceId,
            workspaceName: workspace?.name || 'Workspace pending assignment',
          };
        });
      const workspaceSummaries = workspaceStates
        .filter(({ workspace }) => !workspace.legacyShared || users.some((entry) => userWorkspaceId(entry, membershipByUserId) === workspace.id))
        .map(({ workspace, state, connectionStatus, capturedCount }) => {
          const events = Array.isArray(state.usageEvents) ? state.usageEvents : [];
          const lastEvent = events
            .slice()
            .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())[0] || null;
          return {
            id: workspace.id,
            name: workspace.name,
            createdAt: workspace.createdAt,
            groupName: state.settings?.approvedGroupName || '',
            connectionStatus,
            capturedCount,
            approvedRecapCount: Array.isArray(state.auditLog) ? state.auditLog.length : 0,
            lastActivityAt: lastEvent?.createdAt || state.webhookStats?.lastReceivedAt || null,
            lastActivitySummary: lastEvent?.summary || '',
          };
        })
        .sort((left, right) => new Date(right.lastActivityAt || right.createdAt || 0).getTime() - new Date(left.lastActivityAt || left.createdAt || 0).getTime());
      const paidUsers = users.filter((entry) => String(entry.subscriptionStatus || '').toLowerCase() === 'active');
      const activeTrials = users.filter((entry) => {
        const trial = trialStatus(entry);
        return trial.isTrialActive && !trial.isSuspended;
      });
      const endedTrials = users.filter((entry) => {
        const trial = trialStatus(entry);
        return !trial.isSubscribed && !trial.isTrialActive && !trial.isPendingActivation;
      });
      return sendJson(200, {
        summary: {
          totalUsers: users.length,
          totalWorkspaces: workspaceSummaries.length,
          activeTrials: activeTrials.length,
          endedTrials: endedTrials.length,
          paidUsers: paidUsers.length,
          pendingActivations: pendingActivations.length,
          connectedWorkspaces: workspaceSummaries.filter((entry) => ['working', 'connected', 'authenticated'].includes(entry.connectionStatus)).length,
          unavailableWorkspaces: workspaceSummaries.filter((entry) => entry.connectionStatus === 'unavailable').length,
          totalRecaps: workspaceSummaries.reduce((total, entry) => total + entry.approvedRecapCount, 0),
          totalCapturedMessages: workspaceSummaries.reduce((total, entry) => total + entry.capturedCount, 0),
        },
        users: users.map((entry) => ({
          userId: entry.userId,
          email: entry.email,
          displayName: entry.displayName,
          workspaceId: userWorkspaceId(entry, membershipByUserId),
          workspaceName: workspaceById.get(userWorkspaceId(entry, membershipByUserId))?.name || 'Workspace pending assignment',
          trial: trialStatus(entry),
          billing: billingSummary(entry),
        })),
        workspaces: workspaceSummaries,
        pendingActivations,
        recentUsageEvents,
        stripeWebhookConfigured: Boolean(stripeWebhookSecret),
      });
    }

    if (request.method === 'POST' && pathname === '/api/admin/users/access') {
      assertAdminUser(session);
      const body = await readBody(request);
      const email = normaliseEmail(body.email);
      const userId = String(body.userId || '').trim();
      const action = String(body.action || '').trim().toLowerCase();
      if (!['suspend', 'restore'].includes(action)) {
        return sendJson(400, { error: 'Choose suspend or restore.' });
      }
      const users = await loadUsers();
      const match = users.find((entry) => (userId && String(entry.userId || '') === userId) || (email && normaliseEmail(entry.email) === email));
      if (!match) {
        return sendJson(404, { error: 'User not found.' });
      }
      if (isAdminUser(match)) {
        return sendJson(400, { error: 'The owner account cannot be suspended.' });
      }
      match.suspendedAt = action === 'suspend' ? nowIso() : null;
      match.suspendedBy = action === 'suspend' ? normaliseEmail(session.email) : '';
      const { membershipByUserId } = await workspaceMaps();
      const scope = workspaceScopeFor({ id: userWorkspaceId(match, membershipByUserId) || legacyWorkspaceId() });
      const state = await loadAppState(scope);
      logUsageEvent(state, {
        type: action === 'suspend' ? 'admin.user_suspended' : 'admin.user_restored',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${action === 'suspend' ? 'Suspended' : 'Restored'} access for ${match.email}.`,
        details: { userId: match.userId },
      });
      await Promise.all([
        saveUsers(users.map((entry) => ensureRecordDefaults(entry))),
        saveAppState(scope, state),
      ]);
      return sendJson(200, { ok: true });
    }

    if (request.method === 'POST' && pathname === '/api/admin/billing/activate') {
      assertAdminUser(session);
      const body = await readBody(request);
      const email = normaliseEmail(body.email);
      const userId = String(body.userId || '').trim();
      const users = await loadUsers();
      const match = users.find((entry) => (userId && String(entry.userId || '') === userId) || (email && normaliseEmail(entry.email) === email));
      if (!match) {
        return sendJson(404, { error: 'User not found for activation.' });
      }
      const { membershipByUserId } = await workspaceMaps();
      const scope = workspaceScopeFor({
        id: userWorkspaceId(match, membershipByUserId) || legacyWorkspaceId(),
      });
      const state = await loadAppState(scope);
      match.subscriptionStatus = 'active';
      match.planId = normalisePaidPlanId(body.planId || match.planId || defaultPaidPlan()?.id);
      match.planName = String(body.planName || planNameForId(match.planId)).trim();
      match.activatedAt = nowIso();
      match.activatedBy = normaliseEmail(session.email);
      match.subscriptionEndsAt = body.subscriptionEndsAt ? String(body.subscriptionEndsAt) : match.subscriptionEndsAt;
      match.paymentReservationAt = null;
      match.paymentReservationSource = '';
      logUsageEvent(state, {
        type: 'billing.user_activated',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `Activated paid access for ${match.email}.`,
        details: {
          userId: match.userId,
          planName: match.planName,
        },
      });
      await saveUsers(users.map((entry) => ensureRecordDefaults(entry)));
      await saveAppState(scope, state);
      return sendJson(200, {
        ok: true,
        user: {
          userId: match.userId,
          email: match.email,
          displayName: match.displayName,
          trial: trialStatus(match),
          billing: billingSummary(match),
        },
      });
    }

    if (request.method === 'POST' && pathname === '/api/admin/billing/reset') {
      assertAdminUser(session);
      const body = await readBody(request);
      const email = normaliseEmail(body.email);
      const userId = String(body.userId || '').trim();
      const users = await loadUsers();
      const match = users.find((entry) => (userId && String(entry.userId || '') === userId) || (email && normaliseEmail(entry.email) === email));
      if (!match) {
        return sendJson(404, { error: 'User not found for reset.' });
      }
      const { membershipByUserId } = await workspaceMaps();
      const scope = workspaceScopeFor({
        id: userWorkspaceId(match, membershipByUserId) || legacyWorkspaceId(),
      });
      const state = await loadAppState(scope);
      const resetRecord = resetUserTrial(match);
      Object.assign(match, resetRecord);
      logUsageEvent(state, {
        type: 'billing.user_reset',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `Reset ${match.email} back to trial access.`,
        details: {
          userId: match.userId,
        },
      });
      await saveUsers(users.map((entry) => ensureRecordDefaults(entry)));
      await saveAppState(scope, state);
      return sendJson(200, {
        ok: true,
        user: {
          userId: match.userId,
          email: match.email,
          displayName: match.displayName,
          trial: trialStatus(match),
          billing: billingSummary(match),
        },
      });
    }

    if (request.method === 'GET' && pathname === '/api/groups') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      await touchSharedOwnerActivity(scope, state, session);
      if (state.settings.connectorMode === 'waha') {
        const groups = await listGroupsFromWaha({
          baseUrl: state.settings.wahaBaseUrl,
          session: state.settings.wahaSession,
          apiKey: state.settings.wahaApiKey,
        });
        logUsageEvent(state, {
          type: 'waha.groups_loaded',
          actorUserId: session.userId || '',
          actorName: sessionOwnerName(session),
          actorEmail: session.email || '',
          summary: `${sessionOwnerName(session)} loaded WhatsApp groups.`,
          details: { count: groups.length },
        });
        await saveAppState(scope, state);
        return sendJson(200, { connector: 'waha', groups });
      }
      return sendJson(200, { connector: 'mock', groups: mockGroups });
    }

    if (request.method === 'GET' && pathname === '/api/waha/status') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, workspace } = context;
      state.settings = managedSettings(state.settings, workspace);
      const status = await getWahaStatus({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      return sendJson(200, { status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/start') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      await claimSharedOwner(scope, state, session);
      await ensureManagedWahaSession({ settings: state.settings, requestUrl, scope });
      const status = await startWahaSession({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      logUsageEvent(state, {
        type: 'waha.session_started',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} started the workspace-owned WhatsApp session.`,
      });
      await saveAppState(scope, state);
      return sendJson(200, { status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/logout') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial } = context;
      ensureTrialAllowed(trial);
      const status = await logoutWahaSession({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      state.settings.approvedGroupId = '';
      state.settings.approvedGroupName = '';
      state.settings.approvedGroups = [];
      state.currentDraft = null;
      clearSharedOwner(state);
      logUsageEvent(state, {
        type: 'waha.session_switched',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} ended the workspace-owned WhatsApp session for a new user.`,
      });
      await saveAppState(scope, state);
      const ownerSummary = ownerStateSummary(state, session);
      return sendJson(200, { status, workspaceSession: ownerSummary, sharedSession: ownerSummary });
    }

    if (request.method === 'POST' && pathname === '/api/waha/webhook') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      const webhookUrl = await ensureManagedWahaSession({ settings: state.settings, requestUrl, scope });
      const status = await getWahaStatus({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      await touchSharedOwnerActivity(scope, state, session);
      return sendJson(200, { webhookUrl, status });
    }

    if (request.method === 'GET' && pathname === '/api/waha/qr') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      await claimSharedOwner(scope, state, session);
      await ensureManagedWahaSession({ settings: state.settings, requestUrl, scope });
      const qr = await getWahaQr({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      return sendJson(200, { qr });
    }

    if (request.method === 'POST' && pathname === '/api/telegram/start') {
      const context = await loadWorkspaceContext(session);
      const { state, trial } = context;
      ensureTrialAllowed(trial);
      return sendJson(200, await startTelegramSession(telegramOptions(state)));
    }

    if (request.method === 'GET' && pathname === '/api/telegram/status') {
      const context = await loadWorkspaceContext(session);
      return sendJson(200, await getTelegramStatus(telegramOptions(context.state)));
    }

    if (request.method === 'POST' && pathname === '/api/telegram/password') {
      const body = await readBody(request);
      const context = await loadWorkspaceContext(session);
      if (!body.password) return sendJson(400, { error: 'Enter your Telegram two-step verification password.' });
      return sendJson(202, await submitTelegramPassword({ ...telegramOptions(context.state), password: body.password }));
    }

    if (request.method === 'GET' && pathname === '/api/telegram/groups') {
      const context = await loadWorkspaceContext(session);
      return sendJson(200, await listTelegramGroups(telegramOptions(context.state)));
    }

    if (request.method === 'POST' && pathname === '/api/telegram/logout') {
      const context = await loadWorkspaceContext(session);
      const result = await logoutTelegramSession(telegramOptions(context.state));
      context.state.settings.telegramGroupId = '';
      context.state.settings.telegramGroupName = '';
      await saveAppState(context.scope, context.state);
      return sendJson(200, result);
    }

    if (request.method === 'POST' && pathname === '/api/telegram/pull') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, users, userRecord } = context;
      ensureTrialAllowed(trial);
      if (!state.settings.consentConfirmed) return sendJson(403, { error: 'Confirm permission before loading Telegram group messages.' });
      if (!state.settings.telegramGroupId) return sendJson(400, { error: 'Choose a Telegram group first.' });
      const payload = await getTelegramMessages({
        ...telegramOptions(state),
        chatId: state.settings.telegramGroupId,
        limit: 200,
      });
      let messages = payload.messages || [];
      const transcriptionMinuteCount = transcriptionMinutesForVoiceMessages(await unmeteredVoiceMessages(scope, messages));
      if (transcriptionMinuteCount) {
        ensureUsageAllowed(userRecord, 'transcription-minute', transcriptionMinuteCount);
        recordUsage(userRecord, 'transcription-minute', transcriptionMinuteCount);
        await saveUserAccess(users, userRecord);
      }
      for (const message of messages) {
        await captureMappedWahaMessage({
          message,
          requestUrl,
          settings: { ...state.settings, approvedGroupId: state.settings.telegramGroupId },
          scope,
        });
      }
      messages = await loadCapturedMessages(scope, { groupId: state.settings.telegramGroupId, limit: 500 });
      const { chatText, voiceNotes } = splitMessageText(messages);
      return sendJson(200, { messages, chatText, voiceNotes });
    }

    if (request.method === 'GET' && pathname === '/api/sample') {
      return sendJson(200, { chatText: sampleChat, voiceNotes: sampleVoiceNotes });
    }

    if (request.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(request);
      const context = await loadWorkspaceContext(session);
      const { scope, state, userRecord } = context;
      const previousSettings = { ...state.settings };
      const requestedGroups = body.approvedGroups === undefined
        ? normaliseApprovedGroups(state.settings)
        : normaliseApprovedGroups({ approvedGroups: body.approvedGroups });
      const groupLimit = groupLimitForPlan(userRecord.planId);
      if (requestedGroups.length > groupLimit) {
        return sendJson(403, { error: `${planNameForId(userRecord.planId)} supports up to ${groupLimit} WhatsApp group${groupLimit === 1 ? '' : 's'}.` });
      }
      state.settings = {
        ...managedSettings(state.settings, context.workspace),
        approvedGroupId: body.approvedGroupId === undefined ? state.settings.approvedGroupId : String(body.approvedGroupId || '').trim(),
        approvedGroupName: body.approvedGroupName === undefined ? state.settings.approvedGroupName : String(body.approvedGroupName || '').trim(),
        consentConfirmed: Boolean(body.consentConfirmed),
        retentionDays: Number(body.retentionDays || state.settings.retentionDays),
        connectorMode: managedWahaBaseUrl ? 'waha' : body.connectorMode === 'waha' ? 'waha' : 'mock',
        transcribeLanguage: isValidTranscriptionLanguage(body.transcribeLanguage)
          ? body.transcribeLanguage
          : state.settings.transcribeLanguage,
        workflowType: normaliseWorkflowType(body.workflowType || state.settings.workflowType),
        workflowCustomInstructions: String(body.workflowCustomInstructions ?? state.settings.workflowCustomInstructions ?? '').trim().slice(0, 1000),
        outboundWebhookUrl: body.outboundWebhookUrl === undefined
          ? state.settings.outboundWebhookUrl || ''
          : validateOutboundWebhookUrl(body.outboundWebhookUrl),
        outboundWebhookSecret: body.outboundWebhookSecret
          ? String(body.outboundWebhookSecret).trim().slice(0, 256)
          : state.settings.outboundWebhookSecret || '',
        outboundWebhookEnabled: body.outboundWebhookEnabled === undefined
          ? Boolean(state.settings.outboundWebhookEnabled)
          : Boolean(body.outboundWebhookEnabled),
        telegramGroupId: body.telegramGroupId === undefined ? state.settings.telegramGroupId || '' : String(body.telegramGroupId || '').trim(),
        telegramGroupName: body.telegramGroupName === undefined ? state.settings.telegramGroupName || '' : String(body.telegramGroupName || '').trim().slice(0, 200),
      };
      state.settings = applyApprovedGroups(state.settings, requestedGroups);
      if (body.approvedGroupId) {
        const selected = requestedGroups.find((group) => group.id === String(body.approvedGroupId));
        if (selected) {
          state.settings.approvedGroupId = selected.id;
          state.settings.approvedGroupName = selected.name;
        }
      }
      if (Boolean(previousSettings.consentConfirmed) !== Boolean(state.settings.consentConfirmed)) {
        logUsageEvent(state, {
          type: 'workspace.consent_updated',
          actorUserId: session.userId || '',
          actorName: sessionOwnerName(session),
          actorEmail: session.email || '',
          summary: state.settings.consentConfirmed
            ? `${sessionOwnerName(session)} confirmed permission to summarize the selected WhatsApp group.`
            : `${sessionOwnerName(session)} cleared the permission-to-summarize confirmation.`,
          details: {
            approvedGroupId: state.settings.approvedGroupId || '',
            approvedGroupName: state.settings.approvedGroupName || '',
          },
        });
      }
      await saveAppState(scope, state);
      return sendJson(200, { settings: publicSettings(state.settings) });
    }

    if (request.method === 'POST' && pathname === '/api/integrations/webhook/test') {
      const context = await loadWorkspaceContext(session);
      const { state, workspace } = context;
      const result = await deliverOutboundWebhook({
        url: state.settings.outboundWebhookUrl,
        secret: state.settings.outboundWebhookSecret,
        event: 'integration.test',
        data: { workspaceId: workspace.id, workspaceName: workspace.name, message: 'Nzuko AI webhook test successful.' },
      });
      if (!result.configured) return sendJson(400, { error: 'Save a webhook URL first.' });
      if (!result.delivered) return sendJson(502, { error: result.error || `Webhook returned HTTP ${result.status}.` });
      return sendJson(200, { ok: true, status: result.status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/pull') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary, users, userRecord } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      if (!state.settings.consentConfirmed) {
        return sendJson(403, { error: 'Confirm group/admin consent before pulling WhatsApp group messages.' });
      }
      if (state.settings.connectorMode !== 'waha') {
        return sendJson(400, { error: 'Switch connector mode to WAHA before pulling real group messages.' });
      }
      if (!String(state.settings.approvedGroupId || '').endsWith('@g.us')) {
        return sendJson(400, { error: 'Choose an approved WAHA group chat ending in @g.us first.' });
      }

      const body = await readBody(request);
      let messages;
      let warning = '';
      try {
        messages = await getGroupMessagesFromWaha({
          baseUrl: state.settings.wahaBaseUrl,
          session: state.settings.wahaSession,
          apiKey: state.settings.wahaApiKey,
          chatId: state.settings.approvedGroupId,
          limit: Number(body.limit || 100),
          downloadMedia: true,
        });
        const transcriptionMinuteCount = transcriptionMinutesForVoiceMessages(await unmeteredVoiceMessages(scope, messages));
        if (transcriptionMinuteCount) {
          ensureUsageAllowed(userRecord, 'transcription-minute', transcriptionMinuteCount);
          recordUsage(userRecord, 'transcription-minute', transcriptionMinuteCount);
          await saveUserAccess(users, userRecord);
        }
        for (const message of messages) {
          await captureMappedWahaMessage({ message, requestUrl, settings: state.settings, scope });
        }
        messages = await loadCapturedMessages(scope, {
          groupId: state.settings.approvedGroupId,
          limit: Number(body.limit || 100),
        });
      } catch (error) {
        warning = `WAHA history pull failed, so showing live-captured messages only: ${error.message}`;
        messages = await loadCapturedMessages(scope, {
          groupId: state.settings.approvedGroupId,
          limit: Number(body.limit || 100),
        });
      }
      const { chatText, voiceNotes } = splitMessageText(messages);
      logUsageEvent(state, {
        type: 'waha.messages_pulled',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} pulled recent WhatsApp messages.`,
        details: { count: messages.length, warning },
      });
      await saveAppState(scope, state);
      await touchSharedOwnerActivity(scope, state, session);
      return sendJson(200, {
        messages,
        chatText,
        voiceNotes,
        warning: warning || 'Voice notes are queued for background transcription and may appear after a short delay.',
      });
    }

    if (request.method === 'GET' && pathname === '/api/captured') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, workspace } = context;
      state.settings = managedSettings(state.settings, workspace);
      const messages = await loadCapturedMessages(scope, {
        groupId: state.settings.approvedGroupId,
        from: requestUrl.searchParams.get('from'),
        to: requestUrl.searchParams.get('to'),
        limit: Number(requestUrl.searchParams.get('limit') || 500),
      });
      const { chatText, voiceNotes } = splitMessageText(messages);
      return sendJson(200, { messages, chatText, voiceNotes });
    }

    if (request.method === 'GET' && pathname === '/api/messages/range') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, workspace } = context;
      state.settings = managedSettings(state.settings, workspace);
      const range = selectedDateRange({
        preset: requestUrl.searchParams.get('preset'),
        from: requestUrl.searchParams.get('from'),
        to: requestUrl.searchParams.get('to'),
      });
      const messages = await loadCapturedMessages(scope, {
        groupId: state.settings.approvedGroupId,
        from: range.from,
        to: range.to,
        limit: Number(requestUrl.searchParams.get('limit') || 1000),
      });
      const { chatText, voiceNotes } = splitMessageText(messages);
      return sendJson(200, { messages, chatText, voiceNotes, range });
    }

    if (request.method === 'POST' && pathname === '/api/waha/pull-today') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary, users, userRecord } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      if (!state.settings.consentConfirmed) {
        return sendJson(403, { error: 'Confirm group/admin consent before pulling WhatsApp group messages.' });
      }
      if (state.settings.connectorMode !== 'waha') {
        return sendJson(400, { error: 'Switch connector mode to WAHA before pulling real group messages.' });
      }

      const range = dateRangeForPreset('today');
      let messages = [];
      let historyAvailable = true;
      let warning = '';
      try {
        messages = await pullWahaMessagesForRange({ settings: state.settings, range, limit: 1000 });
        const transcriptionMinuteCount = transcriptionMinutesForVoiceMessages(await unmeteredVoiceMessages(scope, messages));
        if (transcriptionMinuteCount) {
          ensureUsageAllowed(userRecord, 'transcription-minute', transcriptionMinuteCount);
          recordUsage(userRecord, 'transcription-minute', transcriptionMinuteCount);
          await saveUserAccess(users, userRecord);
        }
        for (const message of messages) {
          await captureMappedWahaMessage({ message, requestUrl, settings: state.settings, scope });
        }
        messages = await loadCapturedMessages(scope, {
          groupId: state.settings.approvedGroupId,
          from: range.from,
          to: range.to,
          limit: 1000,
        });
      } catch (error) {
        historyAvailable = false;
        warning = `WAHA could not return today's WhatsApp history: ${error.message}`;
        messages = await loadCapturedMessages(scope, {
          groupId: state.settings.approvedGroupId,
          from: range.from,
          to: range.to,
          limit: 1000,
        });
      }
      const { chatText, voiceNotes } = splitMessageText(messages);
      logUsageEvent(state, {
        type: 'waha.today_loaded',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} loaded today's WhatsApp messages.`,
        details: { count: messages.length, historyAvailable },
      });
      await saveAppState(scope, state);
      await touchSharedOwnerActivity(scope, state, session);
      return sendJson(200, {
        messages,
        chatText,
        voiceNotes,
        range,
        historyAvailable,
        warning: warning || 'Voice notes are queued for background transcription and may continue processing after this response.',
      });
    }

    if (request.method === 'POST' && pathname === '/api/recap/generate') {
      const body = await readBody(request);
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary, users, userRecord } = context;
      ensureTrialAllowed(trial, 'recap');
      ensureUsageAllowed(userRecord, 'recap');
      ensureSharedOwnerAllowed(ownerSummary, session);
      let chatText = body.chatText;
      let voiceNotes = body.voiceNotes;
      let sourceMessages = [];
      let range = null;
      if (body.useStoredRange) {
        range = selectedDateRange(body.range || {});
        sourceMessages = await loadCapturedMessages(scope, {
          groupId: state.settings.approvedGroupId,
          from: range.from,
          to: range.to,
          limit: Number(body.limit || 1000),
        });
        const split = splitMessageText(sourceMessages);
        chatText = split.chatText;
        voiceNotes = split.voiceNotes;
      }
      const recap = generateWorkflowReport({
        chatText: chatText || '',
        voiceNotes: voiceNotes || '',
        groupName: state.settings.approvedGroupName,
        messages: sourceMessages,
        workflowType: state.settings.workflowType,
        customInstructions: state.settings.workflowCustomInstructions,
      });
      state.currentDraft = {
        id: `draft-${Date.now()}`,
        createdAt: new Date().toISOString(),
        ownerUserId: String(session.userId || ''),
        ownerName: sessionOwnerName(session),
        recap,
        range,
        source: body.useStoredRange ? 'stored-messages' : 'manual-input',
      };
      logUsageEvent(state, {
        type: 'recap.generated',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} generated a recap draft.`,
        details: {
          source: body.useStoredRange ? 'stored-messages' : 'manual-input',
          groupName: state.settings.approvedGroupName,
        },
      });
      await saveAppState(scope, state);
      recordUsage(userRecord, 'recap');
      await saveUserAccess(users, userRecord);
      await touchSharedOwnerActivity(scope, state, session);
      return sendJson(200, { draft: state.currentDraft });
    }

    if (request.method === 'POST' && pathname === '/api/recap/approve') {
      const context = await loadWorkspaceContext(session);
      const { scope, state, trial, ownerSummary, workspace } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      if (!state.currentDraft) {
        return sendJson(400, { error: 'No recap draft is ready.' });
      }
      if (String(state.currentDraft.ownerUserId || '') && String(state.currentDraft.ownerUserId) !== String(session.userId || '')) {
        return sendJson(403, { error: 'Only the user who generated this draft can approve it.' });
      }
      if (!state.settings.consentConfirmed) {
        return sendJson(403, { error: 'Confirm group/admin consent before approving a recap.' });
      }
      if (state.settings.connectorMode === 'waha' && !String(state.settings.approvedGroupId || '').endsWith('@g.us')) {
        return sendJson(400, { error: 'Choose an approved WAHA group chat ending in @g.us before posting.' });
      }

      const posted =
        state.settings.connectorMode === 'waha'
          ? await postRecapToWaha({
              baseUrl: state.settings.wahaBaseUrl,
              session: state.settings.wahaSession,
              apiKey: state.settings.wahaApiKey,
              chatId: state.settings.approvedGroupId,
              text: state.currentDraft.recap.text,
            })
          : await postApprovedRecap({
              groupName: state.settings.approvedGroupName,
              text: state.currentDraft.recap.text,
            });
      const auditEntry = {
        id: `audit-${Date.now()}`,
        approvedAt: new Date().toISOString(),
        groupName: state.settings.approvedGroupName,
        recap: state.currentDraft.recap,
        posted,
      };
      if (state.settings.outboundWebhookEnabled && state.settings.outboundWebhookUrl) {
        auditEntry.integrationDelivery = await deliverOutboundWebhook({
          url: state.settings.outboundWebhookUrl,
          secret: state.settings.outboundWebhookSecret,
          event: 'report.approved',
          data: {
            workspace: { id: workspace.id, name: workspace.name },
            report: { id: auditEntry.id, approvedAt: auditEntry.approvedAt, groupName: auditEntry.groupName, recap: auditEntry.recap },
          },
        });
      }
      state.auditLog.unshift(auditEntry);
      state.currentDraft = null;
      logUsageEvent(state, {
        type: 'recap.approved',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} approved a recap for ${state.settings.approvedGroupName || 'the selected group'}.`,
        details: {
          groupName: state.settings.approvedGroupName,
        },
      });
      await saveAppState(scope, state);
      await touchSharedOwnerActivity(scope, state, session);
      return sendJson(200, { auditEntry });
    }

    if (request.method === 'GET' && pathname === '/api/audit') {
      const context = await loadWorkspaceContext(session);
      const { scope, state } = context;
      return sendJson(200, { auditLog: state.auditLog });
    }

    if (request.method === 'POST' && pathname === '/api/purge') {
      const context = await loadWorkspaceContext(session);
      const { scope, state } = context;
      if (state.currentDraft && String(state.currentDraft.ownerUserId || '') && String(state.currentDraft.ownerUserId) !== String(session.userId || '')) {
        return sendJson(403, { error: 'Only the user who generated this draft can clear it.' });
      }
      state.currentDraft = null;
      await saveAppState(scope, state);
      return sendJson(200, { ok: true, message: 'Raw draft data cleared. Approved audit log retained.' });
    }

    return sendJson(404, { error: 'API route not found.' });
  } catch (error) {
    return sendJson(error.statusCode || 500, { error: error.message || 'Unexpected server error.' });
  }
}
