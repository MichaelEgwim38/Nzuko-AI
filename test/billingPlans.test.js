import assert from 'node:assert/strict';
import test from 'node:test';

import { paidPlanByPriceId, paidPlanForCheckout } from '../src/billingPlans.js';

test('defines Personal with its monthly operational allowances', () => {
  const personal = paidPlanForCheckout('personal', 'monthly');
  assert.equal(personal.priceLabel, '£12/month');
  assert.equal(personal.amountCents, 1200);
  assert.equal(personal.monthlyRecapLimit, 20);
  assert.equal(personal.monthlyTranscriptionMinuteLimit, 100);
  assert.equal(personal.groupLimit, 1);
});

test('selects monthly and annual checkout prices independently', () => {
  process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_monthly';
  process.env.STRIPE_STARTER_ANNUAL_PRICE_ID = 'price_starter_annual';

  const monthly = paidPlanForCheckout('starter', 'monthly');
  const annual = paidPlanForCheckout('starter', 'annual');

  assert.equal(monthly.stripePriceId, 'price_starter_monthly');
  assert.equal(monthly.billingInterval, 'monthly');
  assert.equal(monthly.priceLabel, '£39/month');
  assert.equal(monthly.amountCents, 3900);
  assert.equal(annual.stripePriceId, 'price_starter_annual');
  assert.equal(annual.billingInterval, 'annual');
  assert.equal(annual.priceLabel, '£390/year');
  assert.equal(annual.amountCents, 39000);
});

test('recognises an annual Stripe price when processing webhooks', () => {
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_pro_annual';
  assert.equal(paidPlanByPriceId('price_pro_annual')?.id, 'pro');
});

test('positions Starter as most popular and Pro for operations', () => {
  const starter = paidPlanForCheckout('starter', 'monthly');
  const pro = paidPlanForCheckout('pro', 'monthly');
  assert.equal(starter.recommended, true);
  assert.equal(starter.badgeLabel, 'Most popular');
  assert.equal(pro.recommended, false);
  assert.equal(pro.badgeLabel, 'Best for operations');
  assert.equal(pro.priceLabel, '£89/month');
  assert.equal(pro.prices.annual.label, '£890/year');
});

test('annual checkout remains unavailable until its price is configured', () => {
  delete process.env.STRIPE_STARTER_ANNUAL_PRICE_ID;
  const annual = paidPlanForCheckout('starter', 'annual');
  assert.equal(annual.checkoutEnabled, false);
  assert.equal(annual.stripePriceId, '');
});
