import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function parseCookies(header = '') {
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

export function passcodeMatches(value, expectedSecret) {
  if (!expectedSecret) return true;
  const provided = hashSecret(value || '');
  const expected = hashSecret(expectedSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSCODE || 'nzuko-local-session-secret';
}

function signValue(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

export function createSessionToken(maxAgeSeconds) {
  const payload = base64UrlEncode(
    JSON.stringify({
      role: 'admin',
      exp: Date.now() + maxAgeSeconds * 1000,
    })
  );
  return `${payload}.${signValue(payload)}`;
}

export function readAdminSession(request) {
  const token = parseCookies(request.headers.get('cookie')).nzuko_admin;
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expectedSignature = signValue(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload));
    if (Number(parsed.exp) < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function cookieFlags(request, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

export function backgroundTaskSecret() {
  return process.env.BACKGROUND_TASK_SECRET || process.env.ADMIN_PASSCODE || 'nzuko-background-secret';
}
