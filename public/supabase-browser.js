import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let client = null;
let cacheKey = '';

export function browserSupabase({ url, publishableKey }) {
  const nextKey = `${url}::${publishableKey}`;
  if (!url || !publishableKey) {
    throw new Error('Supabase Auth is not configured.');
  }
  if (!client || cacheKey !== nextKey) {
    client = createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    cacheKey = nextKey;
  }
  return client;
}
