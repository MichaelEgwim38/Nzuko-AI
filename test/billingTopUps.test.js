import assert from 'node:assert/strict';
import test from 'node:test';

import { billingTopUpById, consumeAllowanceWithCredits } from '../src/billingTopUps.js';

test('defines the two initial top-up packs', () => {
  const transcription = billingTopUpById('transcription-100');
  const reports = billingTopUpById('reports-50');
  assert.equal(transcription?.transcriptionMinutes, 100);
  assert.equal(transcription?.amountCents, 1000);
  assert.equal(transcription?.priceLabel, '£10');
  assert.equal(reports?.recaps, 50);
  assert.equal(reports?.amountCents, 1500);
  assert.equal(reports?.priceLabel, '£15');
});

test('uses included allowance before purchased credits', () => {
  const result = consumeAllowanceWithCredits({ used: 25, limit: 30, credits: 50, count: 3 });
  assert.deepEqual(result, { used: 28, credits: 50 });
});

test('uses credits after the included allowance is exhausted', () => {
  const result = consumeAllowanceWithCredits({ used: 28, limit: 30, credits: 50, count: 5 });
  assert.deepEqual(result, { used: 30, credits: 47 });
});
