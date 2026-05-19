import { getStore } from '@netlify/blobs';
import { mockGroups } from './connectors/mockWhatsApp.js';

const usersKey = 'users';
const workspacesKey = 'workspaces';
const membershipsKey = 'memberships';
const sharedStateKey = 'app-state';
const sharedMessagesKey = 'captured-messages';
const legacySharedWorkspaceId = 'shared';

function blobStore() {
  return getStore({ name: 'nzuko-ai', consistency: 'strong' });
}

function normaliseScope(value = '') {
  const scoped = String(value || '').trim();
  return scoped
    ? scoped.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120)
    : 'shared';
}

function normaliseWorkspaceId(value = '') {
  const workspaceId = String(value || '').trim();
  return workspaceId
    ? workspaceId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120)
    : legacySharedWorkspaceId;
}

function stateKeyFor(scope) {
  return scope === 'shared' ? sharedStateKey : `users/${scope}/app-state`;
}

function messagesKeyFor(scope) {
  return scope === 'shared' ? sharedMessagesKey : `users/${scope}/captured-messages`;
}

function resolveScopeAndState(scopeOrState, maybeState) {
  if (maybeState === undefined) {
    return { scope: 'shared', state: scopeOrState };
  }
  return { scope: scopeOrState, state: maybeState };
}

function resolveScopeAndMessage(scopeOrMessage, maybeMessage) {
  if (maybeMessage === undefined) {
    return { scope: 'shared', message: scopeOrMessage };
  }
  return { scope: scopeOrMessage, message: maybeMessage };
}

function resolveScopeAndQuery(scopeOrQuery, maybeQuery) {
  if (maybeQuery === undefined && (typeof scopeOrQuery === 'object' || scopeOrQuery === undefined)) {
    return { scope: 'shared', query: scopeOrQuery || {} };
  }
  return { scope: scopeOrQuery, query: maybeQuery || {} };
}

function normaliseTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 20_000_000_000 ? numeric * 1000 : numeric;
  }
  return Date.now();
}

export function timestampMs(message = {}) {
  return normaliseTimestamp(message.timestamp || message.receivedAt || message.createdAt);
}

export function defaultSettings() {
  return {
    approvedGroupId: process.env.APPROVED_GROUP_ID || '',
    approvedGroupName: process.env.APPROVED_GROUP_NAME || '',
    consentConfirmed: process.env.CONSENT_CONFIRMED === 'true',
    retentionDays: Number(process.env.RETENTION_DAYS || 14),
    postingMode: 'review-first',
    connectorMode: process.env.CONNECTOR_MODE === 'waha' ? 'waha' : 'mock',
    wahaBaseUrl: process.env.WAHA_BASE_URL || 'http://localhost:3000',
    wahaPublicUrl: process.env.WAHA_PUBLIC_URL || '',
    wahaSession: process.env.WAHA_SESSION || 'default',
    wahaApiKey: process.env.WAHA_API_KEY || '',
    transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || 'auto',
  };
}

export function defaultWorkspaceRecord(workspace = {}) {
  const id = normaliseWorkspaceId(workspace.id || workspace.workspaceId);
  const legacyShared = id === legacySharedWorkspaceId;
  return {
    id,
    name: String(workspace.name || workspace.workspaceName || (legacyShared ? 'Shared workspace' : 'Nzuko workspace')).trim(),
    slug: String(workspace.slug || id).trim(),
    scope: normaliseScope(workspace.scope || (legacyShared ? 'shared' : `workspace-${id}`)),
    createdAt: workspace.createdAt || new Date().toISOString(),
    updatedAt: workspace.updatedAt || workspace.createdAt || new Date().toISOString(),
    ownerUserId: String(workspace.ownerUserId || '').trim(),
    legacyShared,
    archivedAt: workspace.archivedAt || null,
  };
}

export function defaultMembershipRecord(membership = {}) {
  const workspaceId = normaliseWorkspaceId(membership.workspaceId);
  const userId = String(membership.userId || '').trim();
  return {
    id: String(membership.id || `${workspaceId}:${userId || 'member'}`).trim(),
    workspaceId,
    userId,
    role: String(membership.role || 'owner').trim(),
    createdAt: membership.createdAt || new Date().toISOString(),
    updatedAt: membership.updatedAt || membership.createdAt || new Date().toISOString(),
  };
}

function defaultWebhookStats() {
  return {
    received: 0,
    matchedApprovedGroup: 0,
    ignored: 0,
    lastReceivedAt: null,
    lastMatchedAt: null,
    lastIgnoredReason: '',
    lastIgnoredChatId: '',
  };
}

function defaultSharedSession() {
  return {
    ownerUserId: '',
    ownerName: '',
    claimedAt: null,
    lastActivityAt: null,
  };
}

function defaultBillingState() {
  return {
    pendingActivations: {},
    lastStripeEventId: '',
    lastStripeEventType: '',
    lastStripeEventAt: null,
  };
}

function defaultUsageEvents() {
  return [];
}

export function createDefaultState() {
  return {
    settings: defaultSettings(),
    currentDraft: null,
    auditLog: [],
    webhookStats: defaultWebhookStats(),
    sharedSession: defaultSharedSession(),
    billing: defaultBillingState(),
    usageEvents: defaultUsageEvents(),
  };
}

function mergeState(stored = {}) {
  const defaults = createDefaultState();
  return {
    ...defaults,
    ...stored,
    settings: {
      ...defaults.settings,
      ...(stored.settings || {}),
    },
    auditLog: Array.isArray(stored.auditLog) ? stored.auditLog : [],
    webhookStats: {
      ...defaults.webhookStats,
      ...(stored.webhookStats || {}),
    },
    sharedSession: {
      ...defaults.sharedSession,
      ...(stored.sharedSession || {}),
    },
    billing: {
      ...defaults.billing,
      ...(stored.billing || {}),
      pendingActivations: {
        ...defaults.billing.pendingActivations,
        ...((stored.billing && stored.billing.pendingActivations) || {}),
      },
    },
    usageEvents: Array.isArray(stored.usageEvents) ? stored.usageEvents : [],
  };
}

async function loadJson(key, fallback) {
  const value = await blobStore().get(key, { type: 'json', consistency: 'strong' });
  return value ?? fallback;
}

async function saveJson(key, value) {
  await blobStore().setJSON(key, value);
  return value;
}

export async function loadAppState(scope = 'shared') {
  const stored = await loadJson(stateKeyFor(normaliseScope(scope)), null);
  return mergeState(stored || {});
}

export async function saveAppState(scope = 'shared', state) {
  const resolved = resolveScopeAndState(scope, state);
  return saveJson(stateKeyFor(normaliseScope(resolved.scope)), mergeState(resolved.state));
}

export async function mutateAppState(scope = 'shared', mutator) {
  const current = await loadAppState(scope);
  const next = (await mutator(current)) || current;
  return saveAppState(scope, next);
}

async function loadMessagesRaw(scope = 'shared') {
  const stored = await loadJson(messagesKeyFor(normaliseScope(scope)), []);
  return Array.isArray(stored) ? stored : [];
}

async function saveMessagesRaw(scope = 'shared', messages) {
  return saveJson(messagesKeyFor(normaliseScope(scope)), messages);
}

export async function cloneScopeData(sourceScope = 'shared', targetScope = 'shared') {
  const source = normaliseScope(sourceScope);
  const target = normaliseScope(targetScope);
  if (source === target) {
    return;
  }
  const [state, messages] = await Promise.all([
    loadAppState(source),
    loadMessagesRaw(source),
  ]);
  await Promise.all([
    saveAppState(target, state),
    saveMessagesRaw(target, messages),
  ]);
}

export async function saveCapturedMessage(scope = 'shared', message) {
  const resolved = resolveScopeAndMessage(scope, message);
  const messages = await loadMessagesRaw(resolved.scope);
  const stored = {
    ...resolved.message,
    timestamp: timestampMs(resolved.message),
    receivedAt: resolved.message.receivedAt || new Date().toISOString(),
  };
  const nextMessages = messages.filter((item) => item.id !== stored.id);
  nextMessages.unshift(stored);
  await saveMessagesRaw(resolved.scope, nextMessages.slice(0, 10_000));
  return stored;
}

export async function loadCapturedMessages(scopeOrQuery = 'shared', maybeQuery) {
  const resolved = resolveScopeAndQuery(scopeOrQuery, maybeQuery);
  const { groupId, from, to, limit = 500 } = resolved.query;
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  const messages = await loadMessagesRaw(resolved.scope);
  return messages
    .filter((message) => !groupId || message.groupId === groupId)
    .filter((message) => {
      const ms = timestampMs(message);
      if (fromMs && ms < fromMs) return false;
      if (toMs && ms > toMs) return false;
      return true;
    })
    .sort((a, b) => timestampMs(b) - timestampMs(a))
    .slice(0, limit);
}

export async function countCapturedMessages(scopeOrQuery = 'shared', maybeQuery) {
  const resolved = resolveScopeAndQuery(scopeOrQuery, maybeQuery);
  const { groupId } = resolved.query;
  const messages = await loadMessagesRaw(resolved.scope);
  return messages.filter((message) => !groupId || message.groupId === groupId).length;
}

export async function loadUsers() {
  const stored = await loadJson(usersKey, []);
  return Array.isArray(stored) ? stored : [];
}

export async function saveUsers(users) {
  return saveJson(usersKey, users);
}

export async function loadWorkspaces() {
  const stored = await loadJson(workspacesKey, []);
  const workspaces = Array.isArray(stored) ? stored.map(defaultWorkspaceRecord) : [];
  if (!workspaces.some((workspace) => workspace.id === legacySharedWorkspaceId)) {
    workspaces.unshift(defaultWorkspaceRecord({ id: legacySharedWorkspaceId, legacyShared: true }));
  }
  return workspaces;
}

export async function saveWorkspaces(workspaces) {
  const next = Array.isArray(workspaces) ? workspaces.map(defaultWorkspaceRecord) : [];
  if (!next.some((workspace) => workspace.id === legacySharedWorkspaceId)) {
    next.unshift(defaultWorkspaceRecord({ id: legacySharedWorkspaceId, legacyShared: true }));
  }
  return saveJson(workspacesKey, next);
}

export async function loadMemberships() {
  const stored = await loadJson(membershipsKey, []);
  return Array.isArray(stored) ? stored.map(defaultMembershipRecord) : [];
}

export async function saveMemberships(memberships) {
  const next = Array.isArray(memberships) ? memberships.map(defaultMembershipRecord) : [];
  return saveJson(membershipsKey, next);
}

export function workspaceScopeFor(workspace = {}) {
  return defaultWorkspaceRecord(workspace).scope;
}

export function legacyWorkspaceId() {
  return legacySharedWorkspaceId;
}
