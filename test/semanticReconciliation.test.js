import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecap } from '../src/minutesAgent.js';

test('reconciles unresolved proposals and infers action owners and deadlines', () => {
  const recap = generateRecap({
    groupName: 'Community operations',
    chatText: [
      'Ada: The group discussed late payments. Most people supported reminders first before penalties. No final penalty was approved.',
      'Chair: Decision: penalties will apply to late payments.',
      'Secretary: No final penalty was approved.',
      'Yusuf: I can collect the receipts every Saturday and post the totals.',
      'Chair: Decision: Yusuf will collect receipts and share screenshots on Saturdays.',
      'Tunde: I will draft the contribution list before Friday.',
      'Chair: We agreed to continue meeting every evening at 8pm.',
    ].join('\n'),
  });

  const decisionsSection = recap.text.split('Confirmed / likely decisions:')[1].split('Action items:')[0];
  assert.doesNotMatch(decisionsSection, /late payments|penalty/i);
  assert.match(decisionsSection, /Yusuf will collect receipts/i);
  assert.match(decisionsSection, /meeting every evening at 8pm/i);

  const actionsSection = recap.text.split('Action items:')[1].split('Discussion points:')[0];
  assert.doesNotMatch(actionsSection, /No final penalty was approved/i);
  assert.match(actionsSection, /Owner: Yusuf/i);
  assert.equal((actionsSection.match(/Owner: Yusuf/gi) || []).length, 1);
  assert.match(actionsSection, /Due: (Every Saturday|Saturdays)/i);
  assert.match(actionsSection, /Owner: Tunde/i);
  assert.match(actionsSection, /Due: Before Friday/i);

  assert.match(recap.text, /Discussion points:[\s\S]*late payments/i);
  assert.match(recap.text, /Open questions \/ needs confirmation:[\s\S]*No final penalty was approved/i);
  assert.match(recap.text, /Human review required:[\s\S]*describe the same action for Yusuf/i);
});
