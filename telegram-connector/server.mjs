import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

const port = Number(process.env.PORT || 3100);
const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = String(process.env.TELEGRAM_API_HASH || '');
const apiKeyHash = String(process.env.API_KEY_HASH || '').replace(/^sha512:/, '').toLowerCase();
const dataDir = process.env.SESSION_DIR || '/data';
const sessions = new Map();

if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required.');
await mkdir(dataDir, { recursive: true });

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorised(request) {
  if (!apiKeyHash) return false;
  const supplied = String(request.headers['x-api-key'] || '');
  const actual = createHash('sha512').update(supplied).digest('hex');
  const expectedBuffer = Buffer.from(apiKeyHash);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function safeSession(value) {
  const name = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
  if (!name) throw new Error('A valid session name is required.');
  return name;
}

function sessionFile(name) {
  return path.join(dataDir, `${safeSession(name)}.session`);
}

async function savedSession(name) {
  try { return (await readFile(sessionFile(name), 'utf8')).trim(); } catch { return ''; }
}

function publicState(entry) {
  return {
    status: entry.status,
    connected: entry.status === 'connected',
    qr: entry.qr || '',
    loginUrl: entry.loginUrl || '',
    qrExpiresAt: entry.qrExpiresAt || null,
    passwordRequired: entry.status === 'password_required',
    phoneCodeRequired: entry.status === 'code_required',
    phoneNumber: entry.phoneNumber ? `${entry.phoneNumber.slice(0, 3)}••••${entry.phoneNumber.slice(-3)}` : '',
    passwordHint: entry.passwordHint || '',
    error: entry.error || '',
    account: entry.account || null,
  };
}

async function entryFor(name) {
  const sessionName = safeSession(name);
  if (sessions.has(sessionName)) return sessions.get(sessionName);
  const client = new TelegramClient(new StringSession(await savedSession(sessionName)), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  const entry = { name: sessionName, client, status: 'disconnected', qr: '', loginUrl: '', error: '', loginPromise: null, phoneCodeResolver: null, passwordResolver: null, qrAbortController: null };
  sessions.set(sessionName, entry);
  return entry;
}

async function connectExisting(entry) {
  if (!entry.client.connected) await entry.client.connect();
  if (!(await entry.client.checkAuthorization())) return false;
  const me = await entry.client.getMe();
  entry.status = 'connected';
  entry.account = { id: String(me.id), name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Telegram user', username: me.username || '' };
  entry.qr = '';
  entry.loginUrl = '';
  return true;
}

async function startQrLogin(entry) {
  if (await connectExisting(entry)) return;
  if (entry.loginPromise) return;
  entry.status = 'starting';
  entry.error = '';
  entry.qrAbortController = new AbortController();
  entry.loginPromise = entry.client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async ({ token, expires }) => {
        const uri = `tg://login?token=${token.toString('base64url')}`;
        entry.loginUrl = uri;
        entry.qr = await QRCode.toDataURL(uri, { width: 320, margin: 2 });
        entry.qrExpiresAt = new Date(expires * 1000).toISOString();
        entry.status = 'qr_ready';
      },
      password: async (hint) => {
        entry.status = 'password_required';
        entry.passwordHint = hint || '';
        return new Promise((resolve) => { entry.passwordResolver = resolve; });
      },
      onError: async (error) => {
        entry.error = error.message || String(error);
        return false;
      },
      abortSignal: entry.qrAbortController.signal,
    }
  ).then(async (user) => {
    await writeFile(sessionFile(entry.name), entry.client.session.save(), { mode: 0o600 });
    entry.status = 'connected';
    entry.account = { id: String(user.id), name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Telegram user', username: user.username || '' };
    entry.qr = '';
    entry.loginUrl = '';
  }).catch((error) => {
    entry.status = 'error';
    entry.error = error.message || String(error);
  }).finally(() => { entry.loginPromise = null; entry.passwordResolver = null; entry.qrAbortController = null; });
}

async function stopPendingQrLogin(entry) {
  if (!entry.qrAbortController) return;
  entry.qrAbortController.abort();
  await entry.loginPromise?.catch(() => {});
  entry.loginPromise = null;
  entry.qrAbortController = null;
}

async function startPhoneLogin(entry, phoneNumber) {
  if (await connectExisting(entry)) return;
  await stopPendingQrLogin(entry);
  if (entry.loginPromise) throw new Error('A Telegram sign-in is already in progress.');
  entry.phoneNumber = String(phoneNumber || '').trim();
  entry.status = 'sending_code';
  entry.error = '';
  entry.qr = '';
  entry.loginUrl = '';
  entry.loginPromise = entry.client.signInUser(
    { apiId, apiHash },
    {
      phoneNumber: entry.phoneNumber,
      phoneCode: async () => {
        entry.status = 'code_required';
        return new Promise((resolve) => { entry.phoneCodeResolver = resolve; });
      },
      password: async (hint) => {
        entry.status = 'password_required';
        entry.passwordHint = hint || '';
        return new Promise((resolve) => { entry.passwordResolver = resolve; });
      },
      onError: async (error) => {
        entry.error = error.message || String(error);
        return false;
      },
    }
  ).then(async (user) => {
    await writeFile(sessionFile(entry.name), entry.client.session.save(), { mode: 0o600 });
    entry.status = 'connected';
    entry.account = { id: String(user.id), name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Telegram user', username: user.username || '' };
  }).catch((error) => {
    entry.status = 'error';
    entry.error = error.message || String(error);
  }).finally(() => {
    entry.loginPromise = null;
    entry.phoneCodeResolver = null;
    entry.passwordResolver = null;
  });
  for (let attempt = 0; attempt < 50 && entry.status === 'sending_code'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForQr(entry) {
  for (let attempt = 0; attempt < 30 && entry.status === 'starting'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function listGroups(entry) {
  if (!(await connectExisting(entry))) throw new Error('Telegram is not connected.');
  const dialogs = await entry.client.getDialogs({ limit: 200 });
  return dialogs.filter((dialog) => dialog.isGroup || dialog.entity?.megagroup || dialog.entity?.gigagroup).map((dialog) => ({
    id: String(dialog.id),
    name: dialog.title || dialog.name || String(dialog.id),
    unreadCount: Number(dialog.unreadCount || 0),
  }));
}

async function listMessages(entry, chatId, limit) {
  if (!(await connectExisting(entry))) throw new Error('Telegram is not connected.');
  const messages = await entry.client.getMessages(chatId, { limit: Math.min(Math.max(Number(limit || 100), 1), 500) });
  const mapped = [];
  for (const message of [...messages].reverse()) {
    const text = message.message || message.text || '';
    const audioAttribute = message.document?.attributes?.find((attribute) => attribute.className === 'DocumentAttributeAudio' || attribute.voice);
    const voice = Boolean(message.voice || message.media?.voice || audioAttribute?.voice);
    if (!text && !voice) continue;
    const sender = message.sender || await message.getSender().catch(() => null);
    mapped.push({
      id: `telegram-${message.id}`,
      from: sender?.title || [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || sender?.username || 'Group member',
      body: text,
      timestamp: message.date instanceof Date ? Math.floor(message.date.getTime() / 1000) : Number(message.date || 0),
      type: voice ? 'voice' : 'chat',
      hasMedia: voice,
      duration: Number(audioAttribute?.duration || 0),
      media: voice ? {
        mimetype: message.document?.mimeType || 'audio/ogg',
        filename: `telegram-voice-${message.id}.ogg`,
        path: `/sessions/${encodeURIComponent(entry.name)}/media/${message.id}?chatId=${encodeURIComponent(chatId)}`,
      } : undefined,
    });
  }
  return mapped;
}

async function downloadVoiceMedia(entry, chatId, messageId) {
  if (!(await connectExisting(entry))) throw new Error('Telegram is not connected.');
  const messages = await entry.client.getMessages(chatId, { ids: [Number(messageId)] });
  const message = messages?.[0];
  if (!message?.document) throw new Error('Telegram voice note was not found.');
  const audioAttribute = message.document.attributes?.find((attribute) => attribute.className === 'DocumentAttributeAudio' || attribute.voice);
  if (!audioAttribute?.voice && !String(message.document.mimeType || '').startsWith('audio/')) throw new Error('The requested Telegram message is not audio.');
  if (Number(message.document.size || 0) > 25 * 1024 * 1024) throw new Error('Telegram voice note exceeds the 25 MB download limit.');
  const content = await entry.client.downloadMedia(message, {});
  if (!content) throw new Error('Telegram returned an empty voice-note file.');
  return { content: Buffer.from(content), mimetype: message.document.mimeType || 'audio/ogg' };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/health') return json(response, 200, { ok: true });
    if (!authorised(request)) return json(response, 401, { error: 'Unauthorized' });
    const mediaMatch = url.pathname.match(/^\/sessions\/([^/]+)\/media\/([0-9]+)$/);
    if (request.method === 'GET' && mediaMatch) {
      const entry = await entryFor(decodeURIComponent(mediaMatch[1]));
      const media = await downloadVoiceMedia(entry, url.searchParams.get('chatId'), mediaMatch[2]);
      response.writeHead(200, {
        'content-type': media.mimetype,
        'content-length': media.content.length,
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="telegram-voice-${mediaMatch[2]}.ogg"`,
      });
      return response.end(media.content);
    }
    const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(start|phone|code|status|password|groups|messages|logout))?$/);
    if (!match) return json(response, 404, { error: 'Not found' });
    const entry = await entryFor(decodeURIComponent(match[1]));
    const action = match[2] || 'status';

    if (request.method === 'POST' && action === 'start') {
      await startQrLogin(entry);
      await waitForQr(entry);
      return json(response, 200, publicState(entry));
    }
    if (request.method === 'POST' && action === 'phone') {
      const payload = await body(request);
      const phoneNumber = String(payload.phoneNumber || '').replace(/[^0-9+]/g, '');
      if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber)) return json(response, 400, { error: 'Enter the full Telegram number with + and country code.' });
      await startPhoneLogin(entry, phoneNumber);
      return json(response, 200, publicState(entry));
    }
    if (request.method === 'POST' && action === 'code') {
      const payload = await body(request);
      if (!entry.phoneCodeResolver) return json(response, 409, { error: 'Request a Telegram login code first.' });
      entry.phoneCodeResolver(String(payload.code || '').replace(/\s/g, ''));
      entry.phoneCodeResolver = null;
      entry.status = 'authorising';
      return json(response, 202, publicState(entry));
    }
    if (request.method === 'GET' && action === 'status') {
      if (entry.status === 'disconnected') await connectExisting(entry);
      return json(response, 200, publicState(entry));
    }
    if (request.method === 'POST' && action === 'password') {
      const payload = await body(request);
      if (!entry.passwordResolver) return json(response, 409, { error: 'Telegram is not waiting for a password.' });
      entry.passwordResolver(String(payload.password || ''));
      entry.status = 'authorising';
      return json(response, 202, publicState(entry));
    }
    if (request.method === 'GET' && action === 'groups') return json(response, 200, { groups: await listGroups(entry) });
    if (request.method === 'GET' && action === 'messages') return json(response, 200, { messages: await listMessages(entry, url.searchParams.get('chatId'), url.searchParams.get('limit')) });
    if (request.method === 'POST' && action === 'logout') {
      if (entry.client.connected) await entry.client.invoke(new Api.auth.LogOut({})).catch(() => {});
      await entry.client.disconnect();
      await rm(sessionFile(entry.name), { force: true });
      sessions.delete(entry.name);
      return json(response, 200, { status: 'disconnected', connected: false });
    }
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error.message || 'Telegram connector failed.' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Nzuko Telegram connector listening on ${port}`));
