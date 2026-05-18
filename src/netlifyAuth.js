import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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
  if (!expectedSecret) return false;
  const provided = hashSecret(value || '');
  const expected = hashSecret(expectedSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function requiredSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function sessionSecret() {
  return requiredSecret('ADMIN_SESSION_SECRET');
}

function signValue(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

export function hashUserPasscode(passcode) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(passcode), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyUserPasscode(passcode, storedHash = '') {
  const [salt, hash] = String(storedHash).split(':');
  if (!salt || !hash) return false;
  const provided = Buffer.from(scryptSync(String(passcode), salt, 64).toString('hex'));
  const expected = Buffer.from(hash);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createSessionToken(session, maxAgeSeconds) {
  const payload = base64UrlEncode(
    JSON.stringify({
      ...session,
      exp: Date.now() + maxAgeSeconds * 1000,
    })
  );
  return `${payload}.${signValue(payload)}`;
}

export function readUserSession(request) {
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

export function normaliseEmail(value = '') {
  return String(value).trim().toLowerCase();
}

export function backgroundTaskSecret() {
  return requiredSecret('BACKGROUND_TASK_SECRET');
}
