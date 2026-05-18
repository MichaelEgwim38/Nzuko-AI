# Netlify Deployment Checklist

This project is prepared for a Netlify MVP deploy from:

`C:\Users\Dell\Projects\whatsapp-minutes-agent`

## 1. Create a GitHub repository

Create a new empty GitHub repository, for example:

`nzuko-ai`

Then add it as the remote for this local project:

```powershell
git remote add origin https://github.com/<your-github-username>/nzuko-ai.git
```

## 2. Push this project

```powershell
git add .
git commit -m "Prepare Netlify MVP for Nzuko AI"
git push -u origin main
```

## 3. Import into Netlify

In Netlify:

1. Go to `https://app.netlify.com/`
2. Click `Add new site`
3. Click `Import an existing project`
4. Choose GitHub
5. Select the GitHub repo

Netlify should detect `netlify.toml` automatically.

## 4. Set environment variables in Netlify

Add these before production use:

- `ADMIN_SESSION_SECRET`
- `BACKGROUND_TASK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `WAHA_BASE_URL`
- `WAHA_SESSION`
- `WAHA_API_KEY` if your WAHA server needs it
- `OPENAI_API_KEY`
- `PUBLIC_APP_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_STARTER_PRICE_ID`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`

Optional:

- `ADMIN_PASSCODE`
- `APPROVED_GROUP_NAME`
- `APPROVED_GROUP_ID`
- `CONSENT_CONFIRMED`
- `RETENTION_DAYS`
- `TRANSCRIBE_LANGUAGE`
- `TRANSCRIBE_MODEL`
- `TRANSLATE_MODEL`

## 5. Recommended secret generation

Use strong random values for these two:

- `ADMIN_SESSION_SECRET`
- `BACKGROUND_TASK_SECRET`

`ADMIN_PASSCODE` is optional and only useful as a temporary legacy fallback.

## Supabase social login setup

This deploy now expects Supabase Auth for Google and Microsoft login.

1. Create a Supabase project.
2. In Supabase, go to `Authentication` -> `URL Configuration`.
3. Set the `Site URL` to your Netlify app URL.
4. Add your Netlify app URL to the redirect allow list.
5. Enable `Google` in Supabase Auth providers and add the Google client ID and secret.
6. Enable `Azure (Microsoft)` in Supabase Auth providers and add the Azure client ID and secret.
7. Copy your project URL and publishable key into Netlify as:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`

Provider setup references:

- Google: https://supabase.com/docs/guides/auth/social-login/auth-google
- Azure (Microsoft): https://supabase.com/docs/guides/auth/social-login/auth-azure

Example PowerShell commands:

```powershell
[guid]::NewGuid().ToString("N")
[guid]::NewGuid().ToString("N")
```

## 6. First deploy

After Netlify deploys, it will assign a site URL like:

`https://your-site-name.netlify.app`

Copy that URL and set:

`PUBLIC_APP_URL=https://your-site-name.netlify.app`

Then trigger a new deploy so webhook registration uses the final public URL.

## 7. WAHA notes

- WAHA remains external to Netlify
- the app should point to your hosted WAHA instance through `WAHA_BASE_URL`
- after deploy, use the dashboard to:
  - check WAHA
  - start session
  - show QR
  - choose approved group
  - enable live capture

## 8. Stripe billing setup

The app now expects Stripe for self-serve billing:

1. Create two recurring monthly Stripe prices:
   - `Starter` at `$15/month`
   - `Pro` at `$29/month`
2. Copy the Stripe price ids into:
   - `STRIPE_STARTER_PRICE_ID`
   - `STRIPE_PRO_PRICE_ID`
3. Copy your Stripe secret key into:
   - `STRIPE_SECRET_KEY`
4. Create a Stripe webhook endpoint pointing to:
   - `https://your-site-name.netlify.app/api/webhooks/stripe`
5. Subscribe these events:
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
6. Copy the webhook signing secret into:
   - `STRIPE_WEBHOOK_SECRET`

Use [STRIPE_SETUP.md](./STRIPE_SETUP.md) for the full checklist.

## 9. Voice-note behavior

- voice-note transcription runs in a background Netlify function
- transcripts may appear shortly after capture instead of in the same request
- officially supported language-code handling is strongest for languages such as English, Polish, Romanian, Hindi, and Urdu
- Igbo, Yoruba, Shona, and Twi are implemented with prompt-guided handling, so quality may vary more
