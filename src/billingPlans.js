const paidPlanDefinitions = [
  {
    id: 'starter',
    name: 'Starter',
    priceLabel: '$15/month',
    amountCents: 1500,
    summary: 'Best for one community group getting started with AI minutes.',
    features: [
      '1 approved WhatsApp group',
      '30 recap drafts per month',
      '40 voice-note transcriptions per month',
      'Review-first posting and audit log',
    ],
    stripePriceEnv: 'STRIPE_STARTER_PRICE_ID',
  },
  {
    id: 'pro',
    name: 'Pro',
    priceLabel: '$29/month',
    amountCents: 2900,
    summary: 'More recap capacity for busier groups that rely on voice notes.',
    features: [
      '1 approved WhatsApp group',
      '100 recap drafts per month',
      '150 voice-note transcriptions per month',
      'Priority support and future advanced reporting',
    ],
    stripePriceEnv: 'STRIPE_PRO_PRICE_ID',
  },
];

function stripePriceIdFor(definition) {
  return String(process.env[definition.stripePriceEnv] || '').trim();
}

function publicPlan(definition) {
  const stripePriceId = stripePriceIdFor(definition);
  return {
    id: definition.id,
    name: definition.name,
    priceLabel: definition.priceLabel,
    amountCents: definition.amountCents,
    summary: definition.summary,
    features: definition.features,
    stripePriceId,
    checkoutEnabled: Boolean(stripePriceId),
  };
}

export function listPaidPlans() {
  return paidPlanDefinitions.map(publicPlan);
}

export function paidPlanById(planId = '') {
  return listPaidPlans().find((plan) => plan.id === String(planId || '').trim().toLowerCase()) || null;
}

export function paidPlanByPriceId(priceId = '') {
  const value = String(priceId || '').trim();
  if (!value) return null;
  return listPaidPlans().find((plan) => plan.stripePriceId === value) || null;
}

export function defaultPaidPlan() {
  return paidPlanById('starter');
}

export function normalisePaidPlanId(planId = '') {
  return paidPlanById(planId)?.id || defaultPaidPlan()?.id || 'starter';
}

export function planNameForId(planId = '') {
  return paidPlanById(planId)?.name || defaultPaidPlan()?.name || 'Starter';
}
