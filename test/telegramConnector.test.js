import assert from 'node:assert/strict';
import test from 'node:test';

import { getTelegramMessages, startTelegramSession } from '../src/connectors/telegram.js';

test('starts an isolated Telegram session through the managed connector', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ status: 'qr_ready' }), { status: 200 });
  };
  try {
    const result = await startTelegramSession({ baseUrl: 'https://connector.example/telegram', apiKey: 'secret', session: 'nzuko-one' });
    assert.equal(result.status, 'qr_ready');
    assert.equal(captured.url, 'https://connector.example/telegram/sessions/nzuko-one/start');
    assert.equal(captured.options.headers['X-Api-Key'], 'secret');
  } finally { global.fetch = originalFetch; }
});

test('requests messages only from the selected Telegram group', async () => {
  const originalFetch = global.fetch;
  let capturedUrl;
  global.fetch = async (url) => {
    capturedUrl = new URL(url);
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  try {
    await getTelegramMessages({ baseUrl: 'https://connector.example', apiKey: 'secret', session: 'workspace', chatId: '-100123', limit: 50 });
    assert.equal(capturedUrl.searchParams.get('chatId'), '-100123');
    assert.equal(capturedUrl.searchParams.get('limit'), '50');
  } finally { global.fetch = originalFetch; }
});
