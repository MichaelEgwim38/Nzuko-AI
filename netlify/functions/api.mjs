import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateRecap } from '../../src/minutesAgent.js';
import {
  countCapturedMessages,
  loadAppState,
  loadCapturedMessages,
  saveCapturedMessage,
  saveAppState,
  loadUsers,
  saveUsers,
} from '../../src/netlifyStore.js';
import { backgroundTaskSecret, cookieFlags, createSessionToken, readUserSession } from '../../src/netlifyAuth.js';
import { providerSessionUser, supabaseAuthConfig, verifySupabaseAccessToken } from '../../src/supabaseAuth.js';
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

const adminSessionMaxAgeSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 7);
const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
const managedWahaBaseUrl = String(process.env.WAHA_BASE_URL || '').replace(/\/+$/, '');
const managedWahaApiKey = String(process.env.WAHA_API_KEY || '');
const sharedWorkspaceScope = 'shared';
const trialDays = Number(process.env.TRIAL_DAYS || 3);
const trialRecapLimit = Number(process.env.TRIAL_RECAP_LIMIT || 2);
const trialVoiceNoteLimit = Number(process.env.TRIAL_VOICE_NOTE_LIMIT || 3);
const ownerTimeoutMinutes = Number(process.env.SHARED_SESSION_TIMEOUT_MINUTES || 45);
const activationWindowDays = Number(process.env.PAID_ACTIVATION_WINDOW_DAYS || 7);
const stripePaymentLinkUrl = String(
  process.env.STRIPE_PAYMENT_LINK_URL || 'https://buy.stripe.com/test_28E14pfxJ2sV7d2gJO2sM00'
).trim();
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const adminEmails = new Set(
  `${process.env.ADMIN_EMAILS || ''},${process.env.ADMIN_EMAIL || ''}`
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

function managedSettings(settings = {}) {
  return {
    ...settings,
    connectorMode: managedWahaBaseUrl ? 'waha' : settings.connectorMode,
    wahaBaseUrl: managedWahaBaseUrl || settings.wahaBaseUrl,
    wahaApiKey: managedWahaApiKey || settings.wahaApiKey,
    wahaSession: process.env.WAHA_SESSION || settings.wahaSession || 'default',
  };
}

function webhookToken() {
  return createHmac('sha256', process.env.ADMIN_SESSION_SECRET || 'nzuko-webhook-secret')
    .update(sharedWorkspaceScope)
    .digest('hex');
}

function publicSettings(settings) {
  return {
    ...settings,
    wahaApiKey: settings.wahaApiKey ? 'configured' : '',
  };
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function ownerTimeoutMs() {
  return ownerTimeoutMinutes * 60 * 1000;
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
    subscriptionStatus: 'trial',
    planName: 'Starter trial',
    activatedAt: null,
    activatedBy: '',
    subscriptionEndsAt: null,
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    lastPaymentAt: null,
    paymentReservationAt: null,
    paymentReservationSource: '',
  };
}

function ensureRecordDefaults(record = {}) {
  return {
    ...record,
    trialStartedAt: record.trialStartedAt || nowIso(),
    trialEndsAt: record.trialEndsAt || trialEndIso(record.trialStartedAt || nowIso()),
    trialRecapsUsed: Number(record.trialRecapsUsed || 0),
    trialVoiceNotesUsed: Number(record.trialVoiceNotesUsed || 0),
    subscriptionStatus: record.subscriptionStatus || 'trial',
    planName: record.planName || 'Starter trial',
    activatedAt: record.activatedAt || null,
    activatedBy: record.activatedBy || '',
    subscriptionEndsAt: record.subscriptionEndsAt || null,
    stripeCustomerId: record.stripeCustomerId || '',
    stripeSubscriptionId: record.stripeSubscriptionId || '',
    lastPaymentAt: record.lastPaymentAt || null,
    paymentReservationAt: record.paymentReservationAt || null,
    paymentReservationSource: record.paymentReservationSource || '',
  };
}

function pendingActivationRecord(state, email) {
  return state.billing?.pendingActivations?.[normaliseEmail(email)] || null;
}

function clearPendingActivation(state, email) {
  const key = normaliseEmail(email);
  if (state.billing?.pendingActivations?.[key]) {
    delete state.billing.pendingActivations[key];
  }
}

function queuePendingActivation(state, payload = {}) {
  const email = normaliseEmail(payload.email);
  if (!email) return;
  state.billing.pendingActivations[email] = {
    email,
    planName: payload.planName || 'Nzuko AI Starter',
    source: payload.source || 'stripe',
    eventId: payload.eventId || '',
    eventType: payload.eventType || '',
    customerId: payload.customerId || '',
    subscriptionId: payload.subscriptionId || '',
    checkoutSessionId: payload.checkoutSessionId || '',
    queuedAt: payload.queuedAt || nowIso(),
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
    object.metadata?.plan_name ||
    object.lines?.data?.[0]?.description ||
    object.display_items?.[0]?.custom?.name ||
    'Nzuko AI Starter'
  );
}

function markStripeEvent(state, event = {}) {
  state.billing.lastStripeEventId = event.id || '';
  state.billing.lastStripeEventType = event.type || '';
  state.billing.lastStripeEventAt = nowIso();
}

function billingSummary(record = {}) {
  return {
    subscriptionStatus: record.subscriptionStatus || 'trial',
    planName: record.planName || 'Starter trial',
    isSubscribed: String(record.subscriptionStatus || '').toLowerCase() === 'active',
    isPendingActivation: String(record.subscriptionStatus || '').toLowerCase() === 'pending_activation',
    activationWindowDays,
    upgradeUrl: stripePaymentLinkUrl,
    paymentMode: stripePaymentLinkUrl.includes('/test_') ? 'test' : 'live',
    activatedAt: record.activatedAt || null,
    subscriptionEndsAt: record.subscriptionEndsAt || null,
    lastPaymentAt: record.lastPaymentAt || null,
    paymentReservationAt: record.paymentReservationAt || null,
    stripeWebhookConfigured: Boolean(stripeWebhookSecret),
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
  const voiceNotesUsed = Number(record.trialVoiceNotesUsed || 0);

  return {
    subscriptionStatus: record.subscriptionStatus || 'trial',
    planName: record.planName || 'Starter trial',
    trialDays,
    trialEndsAt: record.trialEndsAt,
    daysRemaining,
    recapLimit: trialRecapLimit,
    recapUsed: recapsUsed,
    recapRemaining: Math.max(0, trialRecapLimit - recapsUsed),
    voiceNoteLimit: trialVoiceNoteLimit,
    voiceNoteUsed: voiceNotesUsed,
    voiceNoteRemaining: Math.max(0, trialVoiceNoteLimit - voiceNotesUsed),
    isSubscribed,
    isPendingActivation,
    isTrialActive,
    canUseApp: isSubscribed || isTrialActive,
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

async function normaliseSharedOwner(state) {
  const ownerSummary = ownerStateSummary(state);
  if (ownerSummary.isExpired) {
    clearSharedOwner(state);
    await saveAppState(sharedWorkspaceScope, state);
    return ownerStateSummary(state);
  }
  return ownerSummary;
}

async function claimSharedOwner(state, user) {
  const timestamp = nowIso();
  state.sharedSession = {
    ownerUserId: String(user.userId || ''),
    ownerName: sessionOwnerName(user),
    claimedAt: state.sharedSession?.ownerUserId === String(user.userId || '') && state.sharedSession?.claimedAt
      ? state.sharedSession.claimedAt
      : timestamp,
    lastActivityAt: timestamp,
  };
  await saveAppState(sharedWorkspaceScope, state);
  return ownerStateSummary(state, user);
}

async function touchSharedOwnerActivity(state, user) {
  if (String(state.sharedSession?.ownerUserId || '') !== String(user.userId || '')) {
    return ownerStateSummary(state, user);
  }
  state.sharedSession.lastActivityAt = nowIso();
  await saveAppState(sharedWorkspaceScope, state);
  return ownerStateSummary(state, user);
}

function ensureTrialAllowed(trial, feature = 'use Nzuko AI') {
  if (!trial.canUseApp) {
    throw httpError(403, 'Your trial limit has ended. Upgrade now if you want your full workspace activated within 7 days.');
  }
  if (feature === 'recap' && !trial.isSubscribed && trial.recapRemaining <= 0) {
    throw httpError(403, 'You have reached your trial recap limit. Upgrade now if you want your full workspace activated within 7 days.');
  }
}

function ensureSharedOwnerAllowed(ownerSummary, user, { allowTakeover = false } = {}) {
  if (!ownerSummary.hasOwner) return;
  if (ownerSummary.isCurrentUserOwner) return;
  if (ownerSummary.isExpired) return;
  if (allowTakeover) return;
  throw httpError(403, 'Another WhatsApp account is currently connected. Switch WhatsApp user to connect your own account.');
}

async function loadSharedWorkspaceContext(user) {
  const state = await loadAppState(sharedWorkspaceScope);
  state.settings = managedSettings(state.settings);
  const ownerSummary = await normaliseSharedOwner(state);
  const { users, record } = await loadOrCreateUserAccess(user);
  const pendingActivation = pendingActivationRecord(state, record.email);
  if (pendingActivation && String(record.subscriptionStatus || '').toLowerCase() !== 'active') {
    record.subscriptionStatus = 'pending_activation';
    record.planName = pendingActivation.planName || 'Nzuko AI Starter';
    record.paymentReservationAt = pendingActivation.queuedAt || nowIso();
    record.paymentReservationSource = pendingActivation.source || 'stripe';
    record.lastPaymentAt = pendingActivation.queuedAt || nowIso();
    await saveUserAccess(users, record);
  }
  return {
    scope: sharedWorkspaceScope,
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

async function ensureManagedWahaSession({ settings, requestUrl }) {
  const webhookUrl = `${webhookBaseUrl(requestUrl)}/api/webhooks/waha?token=${encodeURIComponent(webhookToken())}`;
  try {
    await configureWahaWebhook({
      baseUrl: settings.wahaBaseUrl,
      session: settings.wahaSession,
      apiKey: settings.wahaApiKey,
      webhookUrl,
    });
  } catch (error) {
    if (!String(error.message || '').includes('404')) {
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
  if (isVoiceMedia(payload)) {
    await saveCapturedMessage(scope, {
      ...buildPendingVoiceNote({ payload, reason: 'transcription queued in background' }),
      groupId: settings.approvedGroupId,
    });
    await enqueueVoiceNoteProcessing({
      requestUrl,
      scope,
      payload: {
        ...payload,
        groupId: settings.approvedGroupId,
      },
    });
    return;
  }

  const body = messageBody(payload);
  if (body) {
    await saveCapturedMessage(scope, {
      id: payload.id?._serialized || payload.id || `message-${Date.now()}`,
      groupId: settings.approvedGroupId,
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
      const context = session ? await loadSharedWorkspaceContext(session) : null;
      const supabase = supabaseAuthConfig();
      return sendJson(200, {
        authenticated: Boolean(session),
        user: session || null,
        appName: 'Nzuko AI',
        groupName: context?.state?.settings?.approvedGroupName || '',
        trial: context?.trial || null,
        sharedSession: context?.ownerSummary || null,
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

      const state = await loadAppState(sharedWorkspaceScope);
      state.settings = managedSettings(state.settings);
      logUsageEvent(state, {
        type: 'auth.login',
        actorUserId: user.userId || '',
        actorName: sessionOwnerName(user),
        actorEmail: user.email || '',
        summary: `${sessionOwnerName(user)} signed in.`,
      });
      await saveAppState(sharedWorkspaceScope, state);

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
      const state = await loadAppState(sharedWorkspaceScope);
      state.settings = managedSettings(state.settings);

      if (event.id && event.id === state.billing.lastStripeEventId) {
        return sendJson(200, { ok: true, duplicate: true });
      }

      const users = await loadUsers();
      const email = stripeEventEmail(event);
      const planName = stripeEventPlanName(event);
      const eventType = String(event.type || '');
      const object = event.data?.object || {};
      let matchingUser = email ? users.find((entry) => normaliseEmail(entry.email) === email) : null;

      if (eventType === 'checkout.session.completed' || eventType === 'invoice.paid') {
        if (!matchingUser && email) {
          matchingUser = ensureRecordDefaults({
            userId: '',
            email,
            displayName: email.split('@')[0] || 'Workspace member',
          });
          users.push(matchingUser);
        }
        queuePendingActivation(state, {
          email,
          planName,
          source: 'stripe',
          eventId: event.id,
          eventType,
          customerId: object.customer || '',
          subscriptionId: object.subscription || '',
          checkoutSessionId: object.id || '',
          queuedAt: nowIso(),
        });
        if (matchingUser) {
          matchingUser.subscriptionStatus = 'pending_activation';
          matchingUser.planName = planName;
          matchingUser.paymentReservationAt = nowIso();
          matchingUser.paymentReservationSource = 'stripe';
          matchingUser.lastPaymentAt = nowIso();
          matchingUser.stripeCustomerId = object.customer || matchingUser.stripeCustomerId || '';
          matchingUser.stripeSubscriptionId = object.subscription || matchingUser.stripeSubscriptionId || '';
        }
        logUsageEvent(state, {
          type: 'billing.payment_reserved',
          actorUserId: matchingUser?.userId || '',
          actorName: matchingUser?.displayName || '',
          actorEmail: email,
          summary: `Stripe payment recorded for ${email || 'unknown customer'}.`,
          details: {
            eventType,
            planName,
            customerId: object.customer || '',
            subscriptionId: object.subscription || '',
          },
        });
      } else if (eventType === 'customer.subscription.deleted' && matchingUser) {
        matchingUser.subscriptionStatus = 'canceled';
        matchingUser.subscriptionEndsAt = nowIso();
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
      await saveAppState(sharedWorkspaceScope, state);
      return sendJson(200, { ok: true });
    }

    const session = readUserSession(request);
    if (!publicApiRoute(pathname) && !session) {
      return sendJson(401, { error: 'Login is required.' });
    }

    if (request.method === 'POST' && pathname === '/api/webhooks/waha') {
      const scope = sharedWorkspaceScope;
      const token = requestUrl.searchParams.get('token') || '';
      const expectedToken = webhookToken();
      if (!token || token !== expectedToken) {
        return sendJson(401, { error: 'Invalid webhook token.' });
      }
      const body = await readBody(request);
      const payload = body.payload || body;
      const state = await loadAppState(scope);
      state.settings = managedSettings(state.settings);
      const approvedGroupId = state.settings.approvedGroupId;
      const chatId = approvedGroupChatId(payload);
      state.webhookStats.received += 1;
      state.webhookStats.lastReceivedAt = new Date().toISOString();

      if (chatId === approvedGroupId) {
        state.webhookStats.matchedApprovedGroup += 1;
        state.webhookStats.lastMatchedAt = new Date().toISOString();
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
        summary: chatId === approvedGroupId ? 'Captured an approved-group WhatsApp message.' : 'Ignored a WhatsApp webhook outside the approved group.',
        details: {
          chatId,
          approvedGroupId,
        },
      });

      await saveAppState(scope, state);
      return sendJson(200, { ok: true });
    }

    if (request.method === 'GET' && pathname === '/api/status') {
      const context = await loadSharedWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
      const capturedCount = await countCapturedMessages(scope, { groupId: state.settings.approvedGroupId });
      return sendJson(200, {
        app: 'Nzuko AI',
        connector: state.settings.connectorMode,
        settings: publicSettings(state.settings),
        userScoped: false,
        managedWahaConnection: Boolean(managedWahaBaseUrl),
        draftReady: Boolean(state.currentDraft),
        auditCount: state.auditLog.length,
        capturedCount,
        webhookStats: state.webhookStats,
        trial,
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
      });
    }

    if (request.method === 'GET' && pathname === '/api/admin/billing') {
      assertAdminUser(session);
      const state = await loadAppState(sharedWorkspaceScope);
      const users = (await loadUsers())
        .map((entry) => ensureRecordDefaults(entry))
        .sort((left, right) => new Date(right.lastPaymentAt || right.trialStartedAt || 0).getTime() - new Date(left.lastPaymentAt || left.trialStartedAt || 0).getTime());
      return sendJson(200, {
        users: users.map((entry) => ({
          userId: entry.userId,
          email: entry.email,
          displayName: entry.displayName,
          trial: trialStatus(entry),
          billing: billingSummary(entry),
        })),
        pendingActivations: Object.values(state.billing?.pendingActivations || {}),
        recentUsageEvents: (state.usageEvents || []).slice(0, 40),
        stripeWebhookConfigured: Boolean(stripeWebhookSecret),
      });
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
      const state = await loadAppState(sharedWorkspaceScope);
      match.subscriptionStatus = 'active';
      match.planName = String(body.planName || match.planName || 'Nzuko AI Starter').trim();
      match.activatedAt = nowIso();
      match.activatedBy = normaliseEmail(session.email);
      match.subscriptionEndsAt = body.subscriptionEndsAt ? String(body.subscriptionEndsAt) : match.subscriptionEndsAt;
      clearPendingActivation(state, match.email);
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
      await saveAppState(sharedWorkspaceScope, state);
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
      const state = await loadAppState(sharedWorkspaceScope);
      const resetRecord = resetUserTrial(match);
      Object.assign(match, resetRecord);
      clearPendingActivation(state, match.email);
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
      await saveAppState(sharedWorkspaceScope, state);
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
      const context = await loadSharedWorkspaceContext(session);
      const { state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      await touchSharedOwnerActivity(state, session);
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
        await saveAppState(sharedWorkspaceScope, state);
        return sendJson(200, { connector: 'waha', groups });
      }
      return sendJson(200, { connector: 'mock', groups: mockGroups });
    }

    if (request.method === 'GET' && pathname === '/api/waha/status') {
      const scope = sharedWorkspaceScope;
      const state = await loadAppState(scope);
      state.settings = managedSettings(state.settings);
      const status = await getWahaStatus({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      return sendJson(200, { status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/start') {
      const context = await loadSharedWorkspaceContext(session);
      const { state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      await claimSharedOwner(state, session);
      await ensureManagedWahaSession({ settings: state.settings, requestUrl });
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
        summary: `${sessionOwnerName(session)} started the shared WhatsApp session.`,
      });
      await saveAppState(sharedWorkspaceScope, state);
      return sendJson(200, { status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/logout') {
      const context = await loadSharedWorkspaceContext(session);
      const { state, trial } = context;
      ensureTrialAllowed(trial);
      const status = await logoutWahaSession({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      state.settings.approvedGroupId = '';
      state.settings.approvedGroupName = '';
      state.currentDraft = null;
      state.sharedSession = {
        ownerUserId: String(session.userId || ''),
        ownerName: sessionOwnerName(session),
        claimedAt: nowIso(),
        lastActivityAt: nowIso(),
      };
      logUsageEvent(state, {
        type: 'waha.session_switched',
        actorUserId: session.userId || '',
        actorName: sessionOwnerName(session),
        actorEmail: session.email || '',
        summary: `${sessionOwnerName(session)} ended the shared WhatsApp session for a new user.`,
      });
      await saveAppState(sharedWorkspaceScope, state);
      return sendJson(200, { status, sharedSession: ownerStateSummary(state, session) });
    }

    if (request.method === 'POST' && pathname === '/api/waha/webhook') {
      const context = await loadSharedWorkspaceContext(session);
      const { state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      const webhookUrl = await ensureManagedWahaSession({ settings: state.settings, requestUrl });
      const status = await getWahaStatus({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      await touchSharedOwnerActivity(state, session);
      return sendJson(200, { webhookUrl, status });
    }

    if (request.method === 'GET' && pathname === '/api/waha/qr') {
      const context = await loadSharedWorkspaceContext(session);
      const { state, trial, ownerSummary } = context;
      ensureTrialAllowed(trial);
      ensureSharedOwnerAllowed(ownerSummary, session);
      await claimSharedOwner(state, session);
      const qr = await getWahaQr({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      return sendJson(200, { qr });
    }

    if (request.method === 'GET' && pathname === '/api/sample') {
      return sendJson(200, { chatText: sampleChat, voiceNotes: sampleVoiceNotes });
    }

    if (request.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(request);
      const scope = sharedWorkspaceScope;
      const state = await loadAppState(scope);
      state.settings = {
        ...managedSettings(state.settings),
        approvedGroupId: body.approvedGroupId === undefined ? state.settings.approvedGroupId : String(body.approvedGroupId || '').trim(),
        approvedGroupName: body.approvedGroupName === undefined ? state.settings.approvedGroupName : String(body.approvedGroupName || '').trim(),
        consentConfirmed: Boolean(body.consentConfirmed),
        retentionDays: Number(body.retentionDays || state.settings.retentionDays),
        connectorMode: managedWahaBaseUrl ? 'waha' : body.connectorMode === 'waha' ? 'waha' : 'mock',
        transcribeLanguage: isValidTranscriptionLanguage(body.transcribeLanguage)
          ? body.transcribeLanguage
          : state.settings.transcribeLanguage,
      };
      await saveAppState(scope, state);
      return sendJson(200, { settings: publicSettings(state.settings) });
    }

    if (request.method === 'POST' && pathname === '/api/waha/pull') {
      const context = await loadSharedWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
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
      await saveAppState(sharedWorkspaceScope, state);
      await touchSharedOwnerActivity(state, session);
      return sendJson(200, {
        messages,
        chatText,
        voiceNotes,
        warning: warning || 'Voice notes are queued for background transcription and may appear after a short delay.',
      });
    }

    if (request.method === 'GET' && pathname === '/api/captured') {
      const scope = sharedWorkspaceScope;
      const state = await loadAppState(scope);
      state.settings = managedSettings(state.settings);
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
      const scope = sharedWorkspaceScope;
      const state = await loadAppState(scope);
      state.settings = managedSettings(state.settings);
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
      const context = await loadSharedWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
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
      await saveAppState(sharedWorkspaceScope, state);
      await touchSharedOwnerActivity(state, session);
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
      const context = await loadSharedWorkspaceContext(session);
      const { scope, state, trial, ownerSummary, users, userRecord } = context;
      ensureTrialAllowed(trial, 'recap');
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
      const recap = generateRecap({
        chatText: chatText || '',
        voiceNotes: voiceNotes || '',
        groupName: state.settings.approvedGroupName,
        messages: sourceMessages,
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
      userRecord.trialRecapsUsed = Number(userRecord.trialRecapsUsed || 0) + 1;
      await saveUserAccess(users, userRecord);
      await touchSharedOwnerActivity(state, session);
      return sendJson(200, { draft: state.currentDraft });
    }

    if (request.method === 'POST' && pathname === '/api/recap/approve') {
      const context = await loadSharedWorkspaceContext(session);
      const { scope, state, trial, ownerSummary } = context;
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
      await touchSharedOwnerActivity(state, session);
      return sendJson(200, { auditEntry });
    }

    if (request.method === 'GET' && pathname === '/api/audit') {
      const scope = sharedWorkspaceScope;
      const state = await loadAppState(scope);
      return sendJson(200, { auditLog: state.auditLog });
    }

    if (request.method === 'POST' && pathname === '/api/purge') {
      const context = await loadSharedWorkspaceContext(session);
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
