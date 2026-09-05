import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Netlify API routes use the defined JSON request parser', async () => {
  const source = await readFile(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function readBody\(request\)/);
  assert.doesNotMatch(source, /\breadJson\(/);
});

test('browser client does not call removed tracker render functions', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\brenderOperationalActions\(/);
  assert.match(source, /function renderActions\(\)/);
});

test('WhatsApp pairing explains privacy and rejects account-security codes', async () => {
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /Phone number linked to WhatsApp/);
  assert.match(page, /not saved in your Nzuko AI workspace or database/);
  assert.match(page, /never ask for an SMS login code or your WhatsApp two-step-verification PIN/i);
});
