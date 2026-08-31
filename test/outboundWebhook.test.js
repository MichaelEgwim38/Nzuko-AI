import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverOutboundWebhook, signWebhookPayload, validateOutboundWebhookUrl } from '../src/outboundWebhook.js';

test('accepts public HTTPS webhook destinations', () => {
  assert.equal(validateOutboundWebhookUrl('https://hooks.zapier.com/hooks/catch/123/abc'), 'https://hooks.zapier.com/hooks/catch/123/abc');
});

test('rejects local and insecure webhook destinations', () => {
  assert.throws(() => validateOutboundWebhookUrl('http://example.com/hook'), /HTTPS/);
  assert.throws(() => validateOutboundWebhookUrl('https://127.0.0.1/hook'), /Private network/);
});

test('signs and delivers a structured webhook event', async () => {
  let captured;
  const result = await deliverOutboundWebhook({
    url: 'https://example.com/hook', secret: 'test-secret', event: 'report.approved', data: { id: 'one' },
    fetchImpl: async (url, options) => { captured = { url, options }; return { ok: true, status: 200 }; },
  });
  assert.equal(result.delivered, true);
  assert.equal(captured.options.headers['x-nzuko-signature'], `sha256=${signWebhookPayload(captured.options.body, 'test-secret')}`);
});
