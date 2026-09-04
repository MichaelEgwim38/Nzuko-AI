import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Netlify API routes use the defined JSON request parser', async () => {
  const source = await readFile(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function readBody\(request\)/);
  assert.doesNotMatch(source, /\breadJson\(/);
});
