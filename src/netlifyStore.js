import { getStore } from '@netlify/blobs';
import { mockGroups } from './connectors/mockWhatsApp.js';

const stateKey = 'app-state';
const messagesKey = 'captured-messages';

function blobStore() {
  return getStore({ name: 'nzuko-ai', consistency: 'strong' });
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
    approvedGroupId: process.env.APPROVED_GROUP_ID || mockGroups[0].id,
    approvedGroupName: process.env.APPROVED_GROUP_NAME || mockGroups[0].name,
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

export function createDefaultState() {
  return {
    settings: defaultSettings(),
    currentDraft: null,
    auditLog: [],
    webhookStats: defaultWebhookStats(),
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

export async function loadAppState() {
  const stored = await loadJson(stateKey, null);
  return mergeState(stored || {});
}

export async function saveAppState(state) {
  return saveJson(stateKey, mergeState(state));
}

export async function mutateAppState(mutator) {
  const current = await loadAppState();
  const next = (await mutator(current)) || current;
  return saveAppState(next);
}

async function loadMessagesRaw() {
  const stored = await loadJson(messagesKey, []);
  return Array.isArray(stored) ? stored : [];
}

async function saveMessagesRaw(messages) {
  return saveJson(messagesKey, messages);
}

export async function saveCapturedMessage(message) {
  const messages = await loadMessagesRaw();
  const stored = {
    ...message,
    timestamp: timestampMs(message),
    receivedAt: message.receivedAt || new Date().toISOString(),
  };
  const nextMessages = messages.filter((item) => item.id !== stored.id);
  nextMessages.unshift(stored);
  await saveMessagesRaw(nextMessages.slice(0, 10_000));
  return stored;
}

export async function loadCapturedMessages({ groupId, from, to, limit = 500 } = {}) {
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  const messages = await loadMessagesRaw();
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

export async function countCapturedMessages({ groupId } = {}) {
  const messages = await loadMessagesRaw();
  return messages.filter((message) => !groupId || message.groupId === groupId).length;
}
