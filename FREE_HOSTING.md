# Free Hosting Plan

Nzuko AI should not be hosted on a sleeping free web app service. WhatsApp capture needs an always-on process.

## Best Free Option

Use Oracle Cloud Always Free:

- Create an Oracle Cloud Free Tier account.
- Create an Always Free Ubuntu VM.
- Open ports `80` and `443`.
- Install Docker and Docker Compose.
- Deploy Nzuko AI with `docker compose`.

Oracle may ask for a payment card for account verification, even when using Always Free resources. Do not create paid resources unless you intentionally choose to.

See [ORACLE_DEPLOYMENT.md](./ORACLE_DEPLOYMENT.md) for the deployment checklist and bootstrap commands.

## Why Not Sleeping Free App Hosts

Sleeping hosts are poor fits for this app because:

- WAHA may stop running when idle.
- Webhooks may be missed.
- WhatsApp live capture becomes unreliable.
- Admins may need to reconnect the QR more often.

## What The Admin Gets

The admin should receive only:

- the hosted Nzuko AI link
- the admin passcode
- instruction to scan the WhatsApp Linked Devices QR with the approved account

The admin should not install Docker, Node, WAHA, or handle API keys.
