function normaliseBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function headers(apiKey) {
  return { accept: 'application/json', 'content-type': 'application/json', 'X-Api-Key': apiKey };
}

async function parse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Telegram connector returned ${response.status}`);
  return payload;
}

async function request({ baseUrl, apiKey, session, action, method = 'GET', body, query }) {
  const url = new URL(`${normaliseBaseUrl(baseUrl)}/sessions/${encodeURIComponent(session)}/${action}`);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const response = await fetch(url, { method, headers: headers(apiKey), body: body ? JSON.stringify(body) : undefined });
  return parse(response);
}

export function startTelegramSession(options) { return request({ ...options, action: 'start', method: 'POST' }); }
export function startTelegramPhoneLogin(options) { return request({ ...options, action: 'phone', method: 'POST', body: { phoneNumber: options.phoneNumber } }); }
export function submitTelegramCode(options) { return request({ ...options, action: 'code', method: 'POST', body: { code: options.code } }); }
export function getTelegramStatus(options) { return request({ ...options, action: 'status' }); }
export function submitTelegramPassword(options) { return request({ ...options, action: 'password', method: 'POST', body: { password: options.password } }); }
export function listTelegramGroups(options) { return request({ ...options, action: 'groups' }); }
export async function getTelegramMessages(options) {
  const payload = await request({ ...options, action: 'messages', query: { chatId: options.chatId, limit: options.limit } });
  return {
    ...payload,
    messages: (payload.messages || []).map((message) => ({
      ...message,
      media: message.media?.path ? { ...message.media, url: `${normaliseBaseUrl(options.baseUrl)}${message.media.path}` } : message.media,
    })),
  };
}
export function logoutTelegramSession(options) { return request({ ...options, action: 'logout', method: 'POST' }); }
