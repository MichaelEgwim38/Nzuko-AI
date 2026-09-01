import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWorkflowReport, normaliseWorkflowType, workflowTemplates } from './workflowTemplates.js';
import { actionView, actionsFromApprovedRecap, updateOperationalAction } from './operationalActions.js';
import { loadCapturedMessages, saveCapturedMessage, timestampMs } from './storage.js';
import { buildPendingVoiceNote, isVoiceMedia, transcribeVoiceNote } from './transcription.js';
import { mockGroups, postApprovedRecap, sampleChat, sampleVoiceNotes } from './connectors/mockWhatsApp.js';
import {
  configureWahaWebhook,
  createWahaSession,
  getGroupMessagesFromWaha,
  getGroupMessagesFromWahaSearch,
  getWahaQr,
  getWahaStatus,
  listGroupsFromWaha,
  postRecapToWaha,
  startWahaSession,
} from './connectors/waha.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = normalize(join(__dirname, '..'));
const publicDir = join(rootDir, 'public');

function loadLocalEnv() {
  try {
    const envText = readFileSync(join(rootDir, '.env'), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (!process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  } catch {
    // Local .env is optional. The app can still run in mock mode without it.
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || 5177);
const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
const adminPasscode = process.env.ADMIN_PASSCODE || '';
const adminSessionMaxAgeSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 7);
const adminSessions = new Map();
const initialApprovedGroupId = process.env.APPROVED_GROUP_ID || '';
const initialCapturedMessages = await loadCapturedMessages({ groupId: initialApprovedGroupId, limit: 500 });

const state = {
  settings: {
    approvedGroupId: initialApprovedGroupId,
    approvedGroupName: process.env.APPROVED_GROUP_NAME || '',
    consentConfirmed: process.env.CONSENT_CONFIRMED === 'true',
    retentionDays: Number(process.env.RETENTION_DAYS || 14),
    postingMode: 'review-first',
    connectorMode: process.env.CONNECTOR_MODE === 'waha' ? 'waha' : 'mock',
    wahaBaseUrl: process.env.WAHA_BASE_URL || 'http://localhost:3000',
    wahaPublicUrl: process.env.WAHA_PUBLIC_URL || '',
    wahaSession: process.env.WAHA_SESSION || 'default',
    wahaApiKey: process.env.WAHA_API_KEY || '',
    workflowType: 'meeting-minutes',
    workflowCustomInstructions: '',
  },
  currentDraft: null,
  capturedMessages: initialCapturedMessages,
  auditLog: [],
  operationalActions: [],
  webhookStats: {
    received: 0,
    matchedApprovedGroup: 0,
    ignored: 0,
    lastReceivedAt: null,
    lastMatchedAt: null,
    lastIgnoredReason: '',
    lastIgnoredChatId: '',
  },
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function publicSettings(settings) {
  return {
    ...settings,
    wahaApiKey: settings.wahaApiKey ? 'configured' : '',
  };
}

function webhookBaseUrl() {
  return publicAppUrl || `http://host.docker.internal:${port}`;
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload, null, 2));
}

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separator = cookie.indexOf('=');
        if (separator === -1) return [cookie, ''];
        return [cookie.slice(0, separator), decodeURIComponent(cookie.slice(separator + 1))];
      })
  );
}

function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest();
}

function passcodeMatches(value) {
  if (!adminPasscode) return true;
  const provided = hashSecret(value || '');
  const expected = hashSecret(adminPasscode);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function cookieFlags(request, maxAgeSeconds = adminSessionMaxAgeSeconds) {
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function adminSession(request) {
  const token = parseCookies(request.headers.cookie).nzuko_admin;
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function publicApiRoute(pathname) {
  return pathname === '/api/auth/status' ||
    pathname === '/api/auth/login' ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/webhooks/waha';
}

function addCapturedMessage(message) {
  const stored = {
    ...message,
    groupId: message.groupId || state.settings.approvedGroupId,
    timestamp: timestampMs(message),
  };
  state.capturedMessages = state.capturedMessages.filter((item) => item.id !== stored.id);
  state.capturedMessages.unshift(stored);
  state.capturedMessages = state.capturedMessages.slice(0, 500);
  return saveCapturedMessage(stored).catch((error) => {
    console.error(`Failed to persist captured message: ${error.message}`);
    return stored;
  });
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

async function pullWahaMessagesForRange({ range, limit = 1000 }) {
  try {
    return await getGroupMessagesFromWaha({
      baseUrl: state.settings.wahaBaseUrl,
      session: state.settings.wahaSession,
      apiKey: state.settings.wahaApiKey,
      chatId: state.settings.approvedGroupId,
      limit,
      fromTimestamp: epochSeconds(range.from),
      toTimestamp: epochSeconds(range.to),
      downloadMedia: true,
    });
  } catch (primaryError) {
    try {
      return await getGroupMessagesFromWahaSearch({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
        chatId: state.settings.approvedGroupId,
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

async function captureMappedWahaMessage(message) {
  const storedMessage = {
    ...message,
    groupId: state.settings.approvedGroupId,
  };
  if (isVoiceMedia(storedMessage)) {
    await addCapturedMessage(buildPendingVoiceNote({ payload: storedMessage, reason: 'transcription queued' }));
    const transcribed = await transcribeVoiceNote({
      payload: storedMessage,
      wahaBaseUrl: state.settings.wahaBaseUrl,
      wahaApiKey: state.settings.wahaApiKey,
      openaiApiKey: process.env.OPENAI_API_KEY,
    });
    state.capturedMessages = state.capturedMessages.filter((item) => item.id !== transcribed.id);
    await addCapturedMessage({
      ...transcribed,
      groupId: state.settings.approvedGroupId,
    });
    return;
  }
  await addCapturedMessage(storedMessage);
}

async function captureApprovedWebhookPayload(payload) {
  if (isVoiceMedia(payload)) {
    await addCapturedMessage({
      ...buildPendingVoiceNote({ payload, reason: 'transcription queued' }),
      groupId: state.settings.approvedGroupId,
    });
    const transcribed = await transcribeVoiceNote({
      payload,
      wahaBaseUrl: state.settings.wahaBaseUrl,
      wahaApiKey: state.settings.wahaApiKey,
      openaiApiKey: process.env.OPENAI_API_KEY,
    });
    state.capturedMessages = state.capturedMessages.filter((message) => message.id !== transcribed.id);
    await addCapturedMessage({
      ...transcribed,
      groupId: state.settings.approvedGroupId,
    });
    return;
  }

  const body = messageBody(payload);
  if (body) {
    await addCapturedMessage({
      id: payload.id?._serialized || payload.id || `message-${Date.now()}`,
      groupId: state.settings.approvedGroupId,
      from: messageSender(payload),
      body,
      timestamp: payload.timestamp || Date.now(),
      hasMedia: Boolean(payload.hasMedia),
      type: payload.type || 'chat',
    });
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const safePath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = normalize(join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

async function handleApi(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/status') {
    sendJson(response, 200, {
      passcodeRequired: Boolean(adminPasscode),
      authenticated: Boolean(adminSession(request)),
      appName: 'Nzuko AI',
      groupName: state.settings.approvedGroupName,
    });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/login') {
    const body = await readBody(request);
    if (!passcodeMatches(body.passcode)) {
      sendJson(response, 401, { error: 'The admin passcode is not correct.' });
      return;
    }

    const token = randomUUID();
    adminSessions.set(token, {
      id: token,
      role: 'admin',
      createdAt: Date.now(),
      expiresAt: Date.now() + adminSessionMaxAgeSeconds * 1000,
    });
    sendJson(response, 200, {
      ok: true,
      passcodeRequired: Boolean(adminPasscode),
      message: adminPasscode
        ? 'Admin login confirmed.'
        : 'Local development login allowed. Set ADMIN_PASSCODE before hosting.',
    }, {
      'set-cookie': `nzuko_admin=${encodeURIComponent(token)}; ${cookieFlags(request)}`,
    });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/logout') {
    const token = parseCookies(request.headers.cookie).nzuko_admin;
    if (token) {
      adminSessions.delete(token);
    }
    sendJson(response, 200, { ok: true }, {
      'set-cookie': `nzuko_admin=; ${cookieFlags(request, 0)}`,
    });
    return;
  }

  if (!publicApiRoute(requestUrl.pathname) && !adminSession(request)) {
    sendJson(response, 401, { error: 'Admin login is required.' });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/webhooks/waha') {
    const body = await readBody(request);
    const payload = body.payload || body;
    const approvedGroupId = state.settings.approvedGroupId;
    const chatId = approvedGroupChatId(payload);
    state.webhookStats.received += 1;
    state.webhookStats.lastReceivedAt = new Date().toISOString();

    if (chatId === approvedGroupId) {
      state.webhookStats.matchedApprovedGroup += 1;
      state.webhookStats.lastMatchedAt = new Date().toISOString();
      captureApprovedWebhookPayload(payload).catch((error) => {
        addCapturedMessage(buildPendingVoiceNote({ payload, reason: error.message || 'transcription failed' }));
      });
    } else {
      state.webhookStats.ignored += 1;
      state.webhookStats.lastIgnoredChatId = chatId || 'not-a-group-message';
      state.webhookStats.lastIgnoredReason = chatId
        ? 'Webhook was for a different group chat.'
        : 'Webhook did not include a group chat id.';
    }

    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
    sendJson(response, 200, {
      app: 'Nzuko AI',
      connector: state.settings.connectorMode,
      settings: publicSettings(state.settings),
      draftReady: Boolean(state.currentDraft),
      auditCount: state.auditLog.length,
      capturedCount: state.capturedMessages.length,
      webhookStats: state.webhookStats,
      transcription: {
        openaiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
        language: process.env.TRANSCRIBE_LANGUAGE || 'auto',
      },
      workflowTemplates,
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/groups') {
    if (state.settings.connectorMode === 'waha') {
      const groups = await listGroupsFromWaha({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      sendJson(response, 200, { connector: 'waha', groups });
      return;
    }

    sendJson(response, 200, { connector: 'mock', groups: mockGroups });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/waha/status') {
    const status = await getWahaStatus({
      baseUrl: state.settings.wahaBaseUrl,
      session: state.settings.wahaSession,
      apiKey: state.settings.wahaApiKey,
    });
    sendJson(response, 200, { status });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/waha/start') {
    const status = await startWahaSession({
      baseUrl: state.settings.wahaBaseUrl,
      session: state.settings.wahaSession,
      apiKey: state.settings.wahaApiKey,
    });
    sendJson(response, 200, { status });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/waha/webhook') {
    const webhookUrl = `${webhookBaseUrl()}/api/webhooks/waha`;
    let status;
    try {
      status = await configureWahaWebhook({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
        webhookUrl,
      });
    } catch (error) {
      if (!String(error.message || '').includes('404')) {
        throw error;
      }
      status = await createWahaSession({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
        webhookUrl,
      });
    }
    sendJson(response, 200, { webhookUrl, status });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/waha/qr') {
    const qr = await getWahaQr({
      baseUrl: state.settings.wahaBaseUrl,
      session: state.settings.wahaSession,
      apiKey: state.settings.wahaApiKey,
    });
    sendJson(response, 200, { qr });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/sample') {
    sendJson(response, 200, { chatText: sampleChat, voiceNotes: sampleVoiceNotes });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/settings') {
    const body = await readBody(request);
    state.settings = {
      ...state.settings,
      approvedGroupId: body.approvedGroupId === undefined ? state.settings.approvedGroupId : String(body.approvedGroupId || '').trim(),
      approvedGroupName: body.approvedGroupName === undefined ? state.settings.approvedGroupName : String(body.approvedGroupName || '').trim(),
      consentConfirmed: Boolean(body.consentConfirmed),
      retentionDays: Number(body.retentionDays || state.settings.retentionDays),
      connectorMode: body.connectorMode === 'waha' ? 'waha' : 'mock',
      wahaBaseUrl: body.wahaBaseUrl || state.settings.wahaBaseUrl,
      wahaPublicUrl: body.wahaPublicUrl || state.settings.wahaPublicUrl,
      wahaSession: body.wahaSession || state.settings.wahaSession,
      wahaApiKey: body.wahaApiKey ?? state.settings.wahaApiKey,
      workflowType: normaliseWorkflowType(body.workflowType || state.settings.workflowType),
      workflowCustomInstructions: String(body.workflowCustomInstructions ?? state.settings.workflowCustomInstructions ?? '').trim().slice(0, 1000),
    };
    sendJson(response, 200, { settings: publicSettings(state.settings) });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/waha/pull') {
    if (!state.settings.consentConfirmed) {
      sendJson(response, 403, { error: 'Confirm group/admin consent before pulling WhatsApp group messages.' });
      return;
    }
    if (state.settings.connectorMode !== 'waha') {
      sendJson(response, 400, { error: 'Switch connector mode to WAHA before pulling real group messages.' });
      return;
    }
    if (!String(state.settings.approvedGroupId || '').endsWith('@g.us')) {
      sendJson(response, 400, { error: 'Choose an approved WAHA group chat ending in @g.us first.' });
      return;
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
      });
      for (const message of messages) {
        await captureMappedWahaMessage(message);
      }
      messages = await loadCapturedMessages({
        groupId: state.settings.approvedGroupId,
        limit: Number(body.limit || 100),
      });
    } catch (error) {
      warning = `WAHA history pull failed, so showing live-captured messages only: ${error.message}`;
      messages = await loadCapturedMessages({
        groupId: state.settings.approvedGroupId,
        limit: Number(body.limit || 100),
      });
    }
    const { chatText, voiceNotes } = splitMessageText(messages);
    sendJson(response, 200, { messages, chatText, voiceNotes, warning });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/captured') {
    const messages = await loadCapturedMessages({
      groupId: state.settings.approvedGroupId,
      from: requestUrl.searchParams.get('from'),
      to: requestUrl.searchParams.get('to'),
      limit: Number(requestUrl.searchParams.get('limit') || 500),
    });
    const { chatText, voiceNotes } = splitMessageText(messages);
    sendJson(response, 200, { messages, chatText, voiceNotes });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/messages/range') {
    const range = selectedDateRange({
      preset: requestUrl.searchParams.get('preset'),
      from: requestUrl.searchParams.get('from'),
      to: requestUrl.searchParams.get('to'),
    });
    const messages = await loadCapturedMessages({
      groupId: state.settings.approvedGroupId,
      from: range.from,
      to: range.to,
      limit: Number(requestUrl.searchParams.get('limit') || 1000),
    });
    const { chatText, voiceNotes } = splitMessageText(messages);
    sendJson(response, 200, { messages, chatText, voiceNotes, range });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/waha/pull-today') {
    if (!state.settings.consentConfirmed) {
      sendJson(response, 403, { error: 'Confirm group/admin consent before pulling WhatsApp group messages.' });
      return;
    }
    if (state.settings.connectorMode !== 'waha') {
      sendJson(response, 400, { error: 'Switch connector mode to WAHA before pulling real group messages.' });
      return;
    }

    const range = dateRangeForPreset('today');
    let messages = [];
    let historyAvailable = true;
    let warning = '';
    try {
      messages = await pullWahaMessagesForRange({ range, limit: 1000 });
      for (const message of messages) {
        await captureMappedWahaMessage(message);
      }
      messages = await loadCapturedMessages({
        groupId: state.settings.approvedGroupId,
        from: range.from,
        to: range.to,
        limit: 1000,
      });
    } catch (error) {
      historyAvailable = false;
      warning = `WAHA could not return today's WhatsApp history: ${error.message}`;
      messages = await loadCapturedMessages({
        groupId: state.settings.approvedGroupId,
        from: range.from,
        to: range.to,
        limit: 1000,
      });
    }
    const { chatText, voiceNotes } = splitMessageText(messages);
    sendJson(response, 200, { messages, chatText, voiceNotes, range, historyAvailable, warning });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/recap/generate') {
    const body = await readBody(request);
    let chatText = body.chatText;
    let voiceNotes = body.voiceNotes;
    let sourceMessages = [];
    let range = null;
    if (body.useStoredRange) {
      range = selectedDateRange(body.range || {});
      sourceMessages = await loadCapturedMessages({
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
      recap,
      range,
      source: body.useStoredRange ? 'stored-messages' : 'manual-input',
    };
    sendJson(response, 200, { draft: state.currentDraft });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/recap/approve') {
    if (!state.currentDraft) {
      sendJson(response, 400, { error: 'No recap draft is ready.' });
      return;
    }
    if (!state.settings.consentConfirmed) {
      sendJson(response, 403, { error: 'Confirm group/admin consent before approving a recap.' });
      return;
    }
    if (state.settings.connectorMode === 'waha' && !String(state.settings.approvedGroupId || '').endsWith('@g.us')) {
      sendJson(response, 400, { error: 'Choose an approved WAHA group chat ending in @g.us before posting.' });
      return;
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
    const approvedActions = actionsFromApprovedRecap(auditEntry.recap, auditEntry);
    state.operationalActions.unshift(...approvedActions);
    state.currentDraft = null;
    sendJson(response, 200, { auditEntry, approvedActions });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/audit') {
    sendJson(response, 200, { auditLog: state.auditLog });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/actions') {
    if (!state.operationalActions.length && state.auditLog.length) {
      state.operationalActions = state.auditLog.flatMap((entry) => actionsFromApprovedRecap(entry.recap, entry));
    }
    sendJson(response, 200, { actions: state.operationalActions.map((action) => actionView(action)) });
    return;
  }

  const actionRoute = requestUrl.pathname.match(/^\/api\/actions\/([^/]+)$/);
  if (request.method === 'PATCH' && actionRoute) {
    const actionId = decodeURIComponent(actionRoute[1]);
    const index = state.operationalActions.findIndex((entry) => entry.id === actionId);
    if (index < 0) {
      sendJson(response, 404, { error: 'Action not found.' });
      return;
    }
    state.operationalActions[index] = updateOperationalAction(state.operationalActions[index], await readBody(request), { name: 'Local user' });
    sendJson(response, 200, { action: actionView(state.operationalActions[index]) });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/purge') {
    state.currentDraft = null;
    sendJson(response, 200, { ok: true, message: 'Raw draft data cleared. Approved audit log retained.' });
    return;
  }

  sendJson(response, 404, { error: 'API route not found.' });
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApi(request, response);
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message || 'Unexpected server error.' });
  }
});

server.listen(port, () => {
  console.log(`Nzuko AI running at http://localhost:${port}`);
});
