import assert from 'node:assert/strict';
import test from 'node:test';

import { billingTopUpById, consumeAllowanceWithCredits } from '../src/billingTopUps.js';

test('defines the two initial top-up packs', () => {
  assert.equal(billingTopUpById('transcription-100')?.transcriptionMinutes, 100);
  assert.equal(billingTopUpById('reports-50')?.recaps, 50);
});

test('uses included allowance before purchased credits', () => {
  const result = consumeAllowanceWithCredits({ used: 25, limit: 30, credits: 50, count: 3 });
  assert.deepEqual(result, { used: 28, credits: 50 });
});

test('uses credits after the included allowance is exhausted', () => {
  const result = consumeAllowanceWithCredits({ used: 28, limit: 30, credits: 50, count: 5 });
  assert.deepEqual(result, { used: 30, credits: 47 });
});
