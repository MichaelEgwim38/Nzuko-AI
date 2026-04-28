import { generateRecap } from '../../src/minutesAgent.js';
import {
  countCapturedMessages,
  loadAppState,
  loadCapturedMessages,
  saveCapturedMessage,
  saveAppState,
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
  postRecapToWaha,
  startWahaSession,
} from '../../src/connectors/waha.js';

const adminSessionMaxAgeSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 7);
const publicAppUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');

function publicSettings(settings) {
  return {
    ...settings,
    wahaApiKey: settings.wahaApiKey ? 'configured' : '',
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
    pathname === '/api/webhooks/waha';
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

function webhookBaseUrl(requestUrl) {
  return publicAppUrl || requestUrl.origin;
}

async function readBody(request) {
  const raw = await request.text();
  return raw ? JSON.parse(raw) : {};
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

async function enqueueVoiceNoteProcessing({ requestUrl, payload }) {
  try {
    await fetch(`${requestUrl.origin}/.netlify/functions/process-voice-note-background`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nzuko-task-secret': backgroundTaskSecret(),
      },
      body: JSON.stringify({ payload }),
    });
  } catch (error) {
    console.error(`Background voice-note dispatch failed: ${error.message}`);
  }
}

async function captureMappedWahaMessage({ message, requestUrl, settings }) {
  const storedMessage = {
    ...message,
    groupId: settings.approvedGroupId,
  };
  if (isVoiceMedia(storedMessage)) {
    await saveCapturedMessage({
      ...buildPendingVoiceNote({ payload: storedMessage, reason: 'transcription queued in background' }),
      groupId: settings.approvedGroupId,
    });
    await enqueueVoiceNoteProcessing({ requestUrl, payload: storedMessage });
    return;
  }
  await saveCapturedMessage(storedMessage);
}

async function captureApprovedWebhookPayload({ payload, requestUrl, settings }) {
  if (isVoiceMedia(payload)) {
    await saveCapturedMessage({
      ...buildPendingVoiceNote({ payload, reason: 'transcription queued in background' }),
      groupId: settings.approvedGroupId,
    });
    await enqueueVoiceNoteProcessing({
      requestUrl,
      payload: {
        ...payload,
        groupId: settings.approvedGroupId,
      },
    });
    return;
  }

  const body = messageBody(payload);
  if (body) {
    await saveCapturedMessage({
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
      const state = await loadAppState();
      const session = readUserSession(request);
      const supabase = supabaseAuthConfig();
      return sendJson(200, {
        authenticated: Boolean(session),
        user: session || null,
        appName: 'Nzuko AI',
        groupName: state.settings.approvedGroupName,
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

    const session = readUserSession(request);
    if (!publicApiRoute(pathname) && !session) {
      return sendJson(401, { error: 'Login is required.' });
    }

    if (request.method === 'POST' && pathname === '/api/webhooks/waha') {
      const body = await readBody(request);
      const payload = body.payload || body;
      const state = await loadAppState();
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
        });
      } else {
        state.webhookStats.ignored += 1;
        state.webhookStats.lastIgnoredChatId = chatId || 'not-a-group-message';
        state.webhookStats.lastIgnoredReason = chatId
          ? 'Webhook was for a different group chat.'
          : 'Webhook did not include a group chat id.';
      }

      await saveAppState(state);
      return sendJson(200, { ok: true });
    }

    if (request.method === 'GET' && pathname === '/api/status') {
      const state = await loadAppState();
      const capturedCount = await countCapturedMessages({ groupId: state.settings.approvedGroupId });
      return sendJson(200, {
        app: 'Nzuko AI',
        connector: state.settings.connectorMode,
        settings: publicSettings(state.settings),
        draftReady: Boolean(state.currentDraft),
        auditCount: state.auditLog.length,
        capturedCount,
        webhookStats: state.webhookStats,
        transcription: {
          openaiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
          model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
          language: state.settings.transcribeLanguage || 'auto',
          languageOptions: transcriptionLanguageOptions.map(({ value, label }) => ({ value, label })),
        },
      });
    }

    if (request.method === 'GET' && pathname === '/api/groups') {
      const state = await loadAppState();
      if (state.settings.connectorMode === 'waha') {
        const groups = await listGroupsFromWaha({
          baseUrl: state.settings.wahaBaseUrl,
          session: state.settings.wahaSession,
          apiKey: state.settings.wahaApiKey,
        });
        return sendJson(200, { connector: 'waha', groups });
      }
      return sendJson(200, { connector: 'mock', groups: mockGroups });
    }

    if (request.method === 'GET' && pathname === '/api/waha/status') {
      const state = await loadAppState();
      const status = await getWahaStatus({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      return sendJson(200, { status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/start') {
      const state = await loadAppState();
      const status = await startWahaSession({
        baseUrl: state.settings.wahaBaseUrl,
        session: state.settings.wahaSession,
        apiKey: state.settings.wahaApiKey,
      });
      return sendJson(200, { status });
    }

    if (request.method === 'POST' && pathname === '/api/waha/webhook') {
      const state = await loadAppState();
      const webhookUrl = `${webhookBaseUrl(requestUrl)}/api/webhooks/waha`;
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
      return sendJson(200, { webhookUrl, status });
    }

    if (request.method === 'GET' && pathname === '/api/waha/qr') {
      const state = await loadAppState();
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
      const state = await loadAppState();
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
        transcribeLanguage: isValidTranscriptionLanguage(body.transcribeLanguage)
          ? body.transcribeLanguage
          : state.settings.transcribeLanguage,
      };
      await saveAppState(state);
      return sendJson(200, { settings: publicSettings(state.settings) });
    }

    if (request.method === 'POST' && pathname === '/api/waha/pull') {
      const state = await loadAppState();
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
          await captureMappedWahaMessage({ message, requestUrl, settings: state.settings });
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
      return sendJson(200, {
        messages,
        chatText,
        voiceNotes,
        warning: warning || 'Voice notes are queued for background transcription and may appear after a short delay.',
      });
    }

    if (request.method === 'GET' && pathname === '/api/captured') {
      const state = await loadAppState();
      const messages = await loadCapturedMessages({
        groupId: state.settings.approvedGroupId,
        from: requestUrl.searchParams.get('from'),
        to: requestUrl.searchParams.get('to'),
        limit: Number(requestUrl.searchParams.get('limit') || 500),
      });
      const { chatText, voiceNotes } = splitMessageText(messages);
      return sendJson(200, { messages, chatText, voiceNotes });
    }

    if (request.method === 'GET' && pathname === '/api/messages/range') {
      const state = await loadAppState();
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
      return sendJson(200, { messages, chatText, voiceNotes, range });
    }

    if (request.method === 'POST' && pathname === '/api/waha/pull-today') {
      const state = await loadAppState();
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
          await captureMappedWahaMessage({ message, requestUrl, settings: state.settings });
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
      const state = await loadAppState();
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
      const recap = generateRecap({
        chatText: chatText || '',
        voiceNotes: voiceNotes || '',
        groupName: state.settings.approvedGroupName,
        messages: sourceMessages,
      });
      state.currentDraft = {
        id: `draft-${Date.now()}`,
        createdAt: new Date().toISOString(),
        recap,
        range,
        source: body.useStoredRange ? 'stored-messages' : 'manual-input',
      };
      await saveAppState(state);
      return sendJson(200, { draft: state.currentDraft });
    }

    if (request.method === 'POST' && pathname === '/api/recap/approve') {
      const state = await loadAppState();
      if (!state.currentDraft) {
        return sendJson(400, { error: 'No recap draft is ready.' });
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
      await saveAppState(state);
      return sendJson(200, { auditEntry });
    }

    if (request.method === 'GET' && pathname === '/api/audit') {
      const state = await loadAppState();
      return sendJson(200, { auditLog: state.auditLog });
    }

    if (request.method === 'POST' && pathname === '/api/purge') {
      const state = await loadAppState();
      state.currentDraft = null;
      await saveAppState(state);
      return sendJson(200, { ok: true, message: 'Raw draft data cleared. Approved audit log retained.' });
    }

    return sendJson(404, { error: 'API route not found.' });
  } catch (error) {
    return sendJson(500, { error: error.message || 'Unexpected server error.' });
  }
}
