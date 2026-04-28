import { createRemoteJWKSet, jwtVerify } from 'jose';

function supabaseUrl() {
  return String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
}

export function supabaseAuthConfig() {
  const url = supabaseUrl();
  const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || '');
  return {
    url,
    publishableKey,
    configured: Boolean(url && publishableKey),
    audience: process.env.SUPABASE_JWT_AUDIENCE || 'authenticated',
  };
}

function jwksUrl() {
  const { url } = supabaseAuthConfig();
  return url ? new URL(`${url}/auth/v1/.well-known/jwks.json`) : null;
}

let cachedSet;
let cachedUrl = '';

function remoteKeySet() {
  const url = jwksUrl();
  if (!url) {
    throw new Error('Supabase Auth is not configured.');
  }
  const nextUrl = url.toString();
  if (!cachedSet || cachedUrl !== nextUrl) {
    cachedSet = createRemoteJWKSet(url);
    cachedUrl = nextUrl;
  }
  return cachedSet;
}

export async function verifySupabaseAccessToken(accessToken) {
  const config = supabaseAuthConfig();
  if (!config.configured) {
    throw new Error('Supabase Auth is not configured.');
  }

  const issuer = `${config.url}/auth/v1`;
  const { payload } = await jwtVerify(String(accessToken || ''), remoteKeySet(), {
    issuer,
    audience: config.audience,
  });
  return payload;
}

export function providerSessionUser(payload = {}) {
  const email = String(payload.email || '');
  const userMetadata = payload.user_metadata || {};
  const fullName =
    String(userMetadata.full_name || userMetadata.name || payload.name || email || 'Nzuko user').trim();
  return {
    userId: String(payload.sub || ''),
    fullName,
    email,
    role: String(payload.role || 'authenticated'),
    provider: String(payload.app_metadata?.provider || ''),
  };
}
