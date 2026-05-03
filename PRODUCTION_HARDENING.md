## Production Hardening Checklist

Use this after the app-side billing and admin changes are deployed.

### 1. Put WAHA behind HTTPS

Do not leave WAHA on a public `http://IP:3000` endpoint for production use.

Recommended shape:

- Point a domain or subdomain such as `waha.yourdomain.com` to the Hetzner server
- Put Caddy or Nginx in front of WAHA
- Proxy `https://waha.yourdomain.com` to `http://127.0.0.1:3000`
- Only expose ports `80` and `443`
- Stop exposing `3000` publicly once the proxy is working

### 2. Update hosted app environment variables

In Netlify, set:

- `PUBLIC_APP_URL`
- `WAHA_BASE_URL=https://waha.yourdomain.com`
- `WAHA_API_KEY=<new rotated key>`
- `ADMIN_EMAILS=your-email@example.com`
- `STRIPE_PAYMENT_LINK_URL=<test-or-live-link>`
- `STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret>`

Optional trial and shared-session settings:

- `TRIAL_DAYS=3`
- `TRIAL_RECAP_LIMIT=2`
- `TRIAL_VOICE_NOTE_LIMIT=3`
- `SHARED_SESSION_TIMEOUT_MINUTES=45`
- `PAID_ACTIVATION_WINDOW_DAYS=7`

### 3. Rotate exposed secrets

Rotate these before real users pay or connect:

- WAHA API key
- WAHA dashboard password
- OpenAI API key
- ngrok token if it was ever exposed

### 4. Restrict server access

On the Hetzner server:

- disable password SSH login after adding an SSH key
- enable a firewall
- only allow `22`, `80`, and `443`
- remove public access to `3000`

### 5. Configure Stripe webhook destination

In Stripe:

- Add a webhook endpoint that points to:
  `https://your-app-domain.netlify.app/api/webhooks/stripe`
- Subscribe at minimum to:
  - `checkout.session.completed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.subscription.deleted`

### 6. Keep the shared-session limitation visible

While using WAHA Core:

- only one WhatsApp account can be connected at a time
- users must use `Switch WhatsApp user` to take over the session
- paid access does not remove that WAHA Core limitation

### 7. Verify admin billing controls

After deploy:

- sign in with an admin email listed in `ADMIN_EMAILS`
- confirm the `Admin billing` panel appears
- confirm you can activate and reset users
- confirm Stripe payment reservations appear after webhook delivery
