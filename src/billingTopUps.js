const definitions = [
  {
    id: 'transcription-100',
    name: '100 transcription minutes',
    priceLabel: '£10',
    amountCents: 1000,
    transcriptionMinutes: 100,
    recaps: 0,
    stripePriceEnv: 'STRIPE_TRANSCRIPTION_TOPUP_PRICE_ID',
  },
  {
    id: 'reports-50',
    name: '50 additional reports',
    priceLabel: '£15',
    amountCents: 1500,
    transcriptionMinutes: 0,
    recaps: 50,
    stripePriceEnv: 'STRIPE_REPORT_TOPUP_PRICE_ID',
  },
];

function publicTopUp(definition) {
  const stripePriceId = String(process.env[definition.stripePriceEnv] || '').trim();
  return { ...definition, stripePriceId, checkoutEnabled: Boolean(stripePriceId) };
}

export function listBillingTopUps() {
  return definitions.map(publicTopUp);
}

export function billingTopUpById(id = '') {
  return listBillingTopUps().find((entry) => entry.id === String(id || '').trim().toLowerCase()) || null;
}

export function consumeAllowanceWithCredits({ used = 0, limit = 0, credits = 0, count = 0 } = {}) {
  const safeUsed = Math.max(0, Number(used || 0));
  const safeLimit = Math.max(0, Number(limit || 0));
  const safeCredits = Math.max(0, Number(credits || 0));
  const safeCount = Math.max(0, Number(count || 0));
  const includedRemaining = Math.max(0, safeLimit - safeUsed);
  const includedConsumed = Math.min(includedRemaining, safeCount);
  const creditConsumed = Math.min(safeCredits, Math.max(0, safeCount - includedConsumed));
  return {
    used: safeUsed + includedConsumed,
    credits: safeCredits - creditConsumed,
  };
}
