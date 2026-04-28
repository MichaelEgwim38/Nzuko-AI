# Hosting Nzuko AI

This app should be hosted on an always-on server before giving it to the Umuokoroji Family WhatsApp admin. If it only runs on a laptop, the dashboard and message capture stop when the laptop sleeps, closes, loses internet, or the process exits.

## Recommended Pilot Setup

- One small cloud/VPS server. For a free pilot, use Oracle Cloud Always Free if available in your region.
- Docker and Docker Compose installed on the server.
- HTTPS domain pointing to the server, for example `https://nzuko.example.com`.
- Caddy exposed on ports `80` and `443` for HTTPS.
- WAHA kept private on the Docker network, not publicly exposed.
- Persistent `data/` and `sessions/` folders on the server.

## Free Hosting Choice

Use Oracle Cloud Always Free for the pilot. Nzuko AI needs an always-on machine because WhatsApp capture and the WAHA linked-device session should not sleep.

Avoid free app platforms that sleep or scale to zero for this pilot. If the host sleeps, WAHA stops listening, live capture pauses, and the admin may need to reconnect or pull history again.

The free path still needs the owner to create the cloud account. Do not share Oracle passwords, SSH private keys, OpenAI keys, or WAHA keys in chat.

After creating the Oracle VM:

1. Use Ubuntu for the VM if possible.
2. Open inbound ports `80` and `443`.
3. Install Docker and Docker Compose.
4. Copy this project to the VM.
5. Configure `.env.host`.
6. Run `docker compose --env-file .env.host up -d --build`.

See [ORACLE_DEPLOYMENT.md](./ORACLE_DEPLOYMENT.md) for a focused Oracle VM checklist.

If you do not have a domain yet, use the VM public IP temporarily for setup, then add a domain/subdomain before giving the link to the admin. HTTPS is strongly preferred before real group use.

## Files

- `Dockerfile` builds the Nzuko AI app container.
- `docker-compose.yml` runs the app and WAHA together.
- `.env.host.example` is the hosted environment template.
- `.env.host` is the real hosted secret file and must not be shared.

## Hosted Setup

1. Copy the project to the server.
2. Copy `.env.host.example` to `.env.host`.
3. Set `PUBLIC_APP_URL` to the HTTPS URL users will open.
4. Set `PUBLIC_APP_HOST` to the same domain without `https://`.
5. Set `ADMIN_PASSCODE` to a private passcode known only to approved operators.
6. Set `OPENAI_API_KEY`.
7. Set `WAHA_API_KEY` to a strong private value.
8. Set `APPROVED_GROUP_ID` after the approved group is selected.
9. Start the services:

```bash
docker compose --env-file .env.host up -d --build
```

10. Open the hosted Nzuko AI URL.
11. Login with the admin passcode.
12. Start WAHA, show QR, and scan with the approved WhatsApp account.
13. Load WhatsApp groups and select only the approved Umuokoroji group.
14. Enable live capture.
15. Pull today's messages and generate a reviewed recap.

## HTTPS

The included `docker-compose.yml` runs Caddy in front of the app. Point DNS for `PUBLIC_APP_HOST` to the server, then Caddy can request and renew HTTPS certificates automatically.

Do not expose the WAHA service publicly unless you also add strong network restrictions. The admin should use the Nzuko AI dashboard, not the WAHA dashboard.

## Safety Checklist

- `ADMIN_PASSCODE` is set.
- `OPENAI_API_KEY` is set.
- `WAHA_API_KEY` is set.
- `PUBLIC_APP_URL` uses `https://`.
- WAHA session storage is persistent.
- `data/` is persistent.
- `.env.host`, `data/`, and `sessions/` are not shared with group members.
- The app processes only the approved WhatsApp group.
- Posting remains review-first during the pilot.
