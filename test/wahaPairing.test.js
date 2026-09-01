import assert from 'node:assert/strict';
import test from 'node:test';
import { requestWahaPairingCode } from '../src/connectors/waha.js';

test('requests a same-phone WhatsApp pairing code', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ code: 'ABCD-EFGH' }), { status: 200 });
  };
  try {
    const result = await requestWahaPairingCode({ baseUrl: 'https://waha.example', session: 'workspace-one', apiKey: 'secret', phoneNumber: '447700900123' });
    assert.equal(result.code, 'ABCD-EFGH');
    assert.equal(captured.url, 'https://waha.example/api/workspace-one/auth/request-code');
    assert.deepEqual(JSON.parse(captured.options.body), { phoneNumber: '447700900123' });
  } finally { global.fetch = originalFetch; }
});
