# Stripe Setup

Use this checklist to turn the new self-serve billing flow on for Nzuko AI.

## What this enables

- `Starter` plan at `$15/month`
- `Pro` plan at `$29/month`
- Stripe Checkout from the dashboard
- Stripe Customer Portal for managing subscriptions
- automatic subscription activation from Stripe webhooks

## 1. Create Products In Stripe

Create two recurring monthly prices in Stripe:

1. `Nzuko AI Starter`
2. `Nzuko AI Pro`

Recommended prices:

- `Starter`: `$15/month`
- `Pro`: `$29/month`

After creating them, copy the Stripe price ids:

- `price_...` for Starter
- `price_...` for Pro

## 2. Collect The Stripe Secrets

From Stripe, collect:

- `Secret key` -> `STRIPE_SECRET_KEY`
- `Webhook signing secret` -> `STRIPE_WEBHOOK_SECRET`
- `Starter price id` -> `STRIPE_STARTER_PRICE_ID`
- `Pro price id` -> `STRIPE_PRO_PRICE_ID`

## 3. Add Netlify Environment Variables

In Netlify, set:

- `STRIPE_SECRET_KEY`
- `STRIPE_STARTER_PRICE_ID`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`

Also make sure this already exists:

- `PUBLIC_APP_URL=https://nzuko-ai-pilot.netlify.app`

## 4. Create The Stripe Webhook

Create a Stripe webhook endpoint pointing to:

`https://nzuko-ai-pilot.netlify.app/api/webhooks/stripe`

Subscribe these events:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Copy the webhook signing secret into:

- `STRIPE_WEBHOOK_SECRET`

## 5. Redeploy Netlify

After updating the environment variables:

1. Trigger a new deploy in Netlify
2. Open the live app
3. Confirm the plan cards are enabled

## 6. Expected Behavior

If Stripe is configured correctly:

- trial users see enabled `Starter` and `Pro` buttons
- clicking a plan redirects to Stripe Checkout
- successful checkout returns to the app
- Stripe webhook marks the subscription as active
- paid users see `Manage billing`

## 7. Important Current Limitation

Billing is now mapped into the app, but the app still uses one shared workspace and one shared WAHA session.

That means:

- billing is closer to production
- full self-serve multi-customer isolation is still the next major refactor

## 8. Suggested Next Build Step

After Stripe is live, the next code milestone should be:

- replace the shared workspace model with per-customer workspaces

That means introducing data models for:

- `users`
- `workspaces`
- `memberships`
- `subscriptions`
- `workspace_settings`
- `workspace_messages`
