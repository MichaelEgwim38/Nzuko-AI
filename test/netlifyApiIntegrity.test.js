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

test('Telegram login explains session authority and temporary credential handling', async () => {
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /Phone number linked to Telegram/);
  assert.match(page, /phone number, verification code and password are not saved/i);
  assert.match(page, /Only continue if you started this connection on nzukoai\.com/i);
  assert.match(page, /details authorise a Telegram session/i);
});

test('public mode discovery keeps five distinct selected-mode colour identities', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const modeColours = ['#76b82a', '#13a89e', '#e88d26', '#8157ce', '#3f75db'];
  for (const colour of modeColours) assert.match(styles, new RegExp(colour, 'i'));
  assert.doesNotMatch(styles, /Keep the public mode demonstration visually consistent across every use case/i);
  assert.match(styles, /linear-gradient\(145deg, var\(--mode-dark\), var\(--mode-dark-deep\)\)/);
});
