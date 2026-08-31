import assert from 'node:assert/strict';
import test from 'node:test';

import { importedConversationText } from '../public/importText.js';

test('keeps plain text conversation exports intact', () => {
  assert.equal(importedConversationText('Alice: job complete', 'chat.txt'), 'Alice: job complete');
});

test('extracts common Slack or Teams JSON message fields', () => {
  const imported = importedConversationText(JSON.stringify({ messages: [
    { timestamp: '10:00', sender: 'Alice', text: 'Job complete' },
    { createdAt: '10:05', author: 'Ben', content: 'Part still required' },
  ] }), 'export.json');
  assert.match(imported, /Alice - Job complete/);
  assert.match(imported, /Ben - Part still required/);
});
