import { createHmac } from 'node:crypto';

export function validateOutboundWebhookUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid HTTPS webhook URL.'); }
  if (url.protocol !== 'https:') throw new Error('Webhook URLs must use HTTPS.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0' || host === '::1') {
    throw new Error('Local webhook addresses are not allowed.');
  }
  if (/^(10\.|127\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('Private network webhook addresses are not allowed.');
  }
  return url.toString();
}

export function signWebhookPayload(rawBody, secret = '') {
  if (!secret) return '';
  return createHmac('sha256', secret).update(String(rawBody || '')).digest('hex');
}

export async function deliverOutboundWebhook({ url, secret, event, data, fetchImpl = fetch }) {
  const endpoint = validateOutboundWebhookUrl(url);
  if (!endpoint) return { configured: false, delivered: false };
  const body = JSON.stringify({ event, occurredAt: new Date().toISOString(), data });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nzuko-event': event,
        ...(secret ? { 'x-nzuko-signature': `sha256=${signWebhookPayload(body, secret)}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    return { configured: true, delivered: response.ok, status: response.status };
  } catch (error) {
    return { configured: true, delivered: false, error: error.name === 'AbortError' ? 'Delivery timed out.' : error.message };
  } finally {
    clearTimeout(timeout);
  }
}
