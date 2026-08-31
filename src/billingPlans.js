const paidPlanDefinitions = [
  {
    id: 'starter',
    name: 'Starter',
    priceLabel: '£15/month',
    amountCents: 1500,
    groupLimit: 1,
    summary: 'For one small team that needs reliable minutes, handovers and action tracking.',
    monthlyRecapLimit: 30,
    monthlyTranscriptionMinuteLimit: 120,
    features: [
      '1 WhatsApp operations group',
      '30 structured reports per month',
      '120 voice-transcription minutes per month',
      'Standard and custom report workflows',
      'Human approval and audit trail',
    ],
    stripePriceEnv: 'STRIPE_STARTER_PRICE_ID',
  },
  {
    id: 'pro',
    name: 'Pro',
    priceLabel: '£29/month',
    amountCents: 2900,
    groupLimit: 5,
    summary: 'For busy operations teams running daily handovers and recurring reporting.',
    monthlyRecapLimit: 100,
    monthlyTranscriptionMinuteLimit: 600,
    features: [
      'Up to 5 WhatsApp operations groups',
      '100 structured reports per month',
      '600 voice-transcription minutes per month',
      'Capacity for daily shift and operations reporting',
      'Priority email support',
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
