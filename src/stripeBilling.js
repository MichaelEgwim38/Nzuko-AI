function stripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

function appendFormValue(params, key, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendFormValue(params, `${key}[${index}]`, entry));
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => {
      appendFormValue(params, `${key}[${childKey}]`, childValue);
    });
    return;
  }
  params.append(key, String(value));
}

async function stripeRequest(path, payload) {
  const secretKey = stripeSecretKey();
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }

  const params = new URLSearchParams();
  Object.entries(payload || {}).forEach(([key, value]) => appendFormValue(params, key, value));

  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    throw new Error(parsed.error?.message || `Stripe request failed with ${response.status}.`);
  }

  return parsed;
}

export function stripeCheckoutReady(plan) {
  return Boolean(stripeSecretKey() && plan?.stripePriceId);
}

export async function createSubscriptionCheckoutSession({
  plan,
  customerEmail,
  customerId,
  publicAppUrl,
  userId,
}) {
  if (!plan?.stripePriceId) {
    throw new Error(`Stripe price is not configured for the ${plan?.name || 'selected'} plan.`);
  }

  const appUrl = String(publicAppUrl || '').replace(/\/+$/, '');
  if (!appUrl) {
    throw new Error('PUBLIC_APP_URL is not configured.');
  }

  const session = await stripeRequest('/checkout/sessions', {
    mode: 'subscription',
    success_url: `${appUrl}?payment=success`,
    cancel_url: `${appUrl}?payment=cancel`,
    allow_promotion_codes: true,
    customer: customerId || undefined,
    customer_email: customerId ? undefined : customerEmail,
    client_reference_id: userId || undefined,
    line_items: [
      {
        price: plan.stripePriceId,
        quantity: 1,
      },
    ],
    metadata: {
      plan_id: plan.id,
      billing_interval: plan.billingInterval || 'monthly',
      customer_email: customerEmail,
      user_id: userId || '',
    },
    subscription_data: {
      metadata: {
        plan_id: plan.id,
        billing_interval: plan.billingInterval || 'monthly',
        customer_email: customerEmail,
        user_id: userId || '',
      },
    },
  });

  return {
    id: session.id,
    url: session.url,
  };
}

export async function createTopUpCheckoutSession({ topUp, customerEmail, customerId, publicAppUrl, userId }) {
  if (!topUp?.stripePriceId) throw new Error('Stripe price is not configured for this top-up.');
  const appUrl = String(publicAppUrl || '').replace(/\/+$/, '');
  if (!appUrl) throw new Error('PUBLIC_APP_URL is not configured.');
  const session = await stripeRequest('/checkout/sessions', {
    mode: 'payment',
    success_url: `${appUrl}?payment=topup-success`,
    cancel_url: `${appUrl}?payment=cancel`,
    customer: customerId || undefined,
    customer_email: customerId ? undefined : customerEmail,
    client_reference_id: userId || undefined,
    line_items: [{ price: topUp.stripePriceId, quantity: 1 }],
    metadata: {
      purchase_type: 'topup',
      topup_id: topUp.id,
      customer_email: customerEmail,
      user_id: userId || '',
    },
  });
  return { id: session.id, url: session.url };
}

export async function createCustomerPortalSession({ customerId, publicAppUrl }) {
  const appUrl = String(publicAppUrl || '').replace(/\/+$/, '');
  if (!customerId) {
    throw new Error('Stripe customer id is missing.');
  }
  if (!appUrl) {
    throw new Error('PUBLIC_APP_URL is not configured.');
  }

  const session = await stripeRequest('/billing_portal/sessions', {
    customer: customerId,
    return_url: appUrl,
  });

  return {
    id: session.id,
    url: session.url,
  };
}
