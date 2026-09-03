import assert from 'node:assert/strict';
import test from 'node:test';

import { getTelegramMessages, startTelegramPhoneLogin, startTelegramSession, submitTelegramCode } from '../src/connectors/telegram.js';

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

test('supports same-phone Telegram verification-code login', async () => {
  const originalFetch = global.fetch;
  const captured = [];
  global.fetch = async (url, options) => {
    captured.push({ url: String(url), options });
    return new Response(JSON.stringify({ status: captured.length === 1 ? 'code_required' : 'authorising' }), { status: 200 });
  };
  try {
    await startTelegramPhoneLogin({ baseUrl: 'https://connector.example/telegram', apiKey: 'secret', session: 'nzuko-one', phoneNumber: '+447700900123' });
    await submitTelegramCode({ baseUrl: 'https://connector.example/telegram', apiKey: 'secret', session: 'nzuko-one', code: '12345' });
    assert.equal(captured[0].url, 'https://connector.example/telegram/sessions/nzuko-one/phone');
    assert.deepEqual(JSON.parse(captured[0].options.body), { phoneNumber: '+447700900123' });
    assert.equal(captured[1].url, 'https://connector.example/telegram/sessions/nzuko-one/code');
    assert.deepEqual(JSON.parse(captured[1].options.body), { code: '12345' });
  } finally { global.fetch = originalFetch; }
});

test('requests messages only from the selected Telegram group', async () => {
  const originalFetch = global.fetch;
  let capturedUrl;
  global.fetch = async (url) => {
    capturedUrl = new URL(url);
    return new Response(JSON.stringify({ messages: [{ id: 'telegram-4', media: { path: '/sessions/workspace/media/4?chatId=-100123', mimetype: 'audio/ogg' } }] }), { status: 200 });
  };
  try {
    const payload = await getTelegramMessages({ baseUrl: 'https://connector.example', apiKey: 'secret', session: 'workspace', chatId: '-100123', limit: 50 });
    assert.equal(capturedUrl.searchParams.get('chatId'), '-100123');
    assert.equal(capturedUrl.searchParams.get('limit'), '50');
    assert.equal(payload.messages[0].media.url, 'https://connector.example/sessions/workspace/media/4?chatId=-100123');
  } finally { global.fetch = originalFetch; }
});
