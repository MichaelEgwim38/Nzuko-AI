import assert from 'node:assert/strict';
import test from 'node:test';

import { paidPlanByPriceId, paidPlanForCheckout } from '../src/billingPlans.js';

test('selects monthly and annual checkout prices independently', () => {
  process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_monthly';
  process.env.STRIPE_STARTER_ANNUAL_PRICE_ID = 'price_starter_annual';

  const monthly = paidPlanForCheckout('starter', 'monthly');
  const annual = paidPlanForCheckout('starter', 'annual');

  assert.equal(monthly.stripePriceId, 'price_starter_monthly');
  assert.equal(monthly.billingInterval, 'monthly');
  assert.equal(monthly.priceLabel, '£15/month');
  assert.equal(annual.stripePriceId, 'price_starter_annual');
  assert.equal(annual.billingInterval, 'annual');
  assert.equal(annual.priceLabel, '£150/year');
});

test('recognises an annual Stripe price when processing webhooks', () => {
  process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_pro_annual';
  assert.equal(paidPlanByPriceId('price_pro_annual')?.id, 'pro');
});

test('annual checkout remains unavailable until its price is configured', () => {
  delete process.env.STRIPE_STARTER_ANNUAL_PRICE_ID;
  const annual = paidPlanForCheckout('starter', 'annual');
  assert.equal(annual.checkoutEnabled, false);
  assert.equal(annual.stripePriceId, '');
});
