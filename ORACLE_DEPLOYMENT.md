# Oracle Always Free Deployment

Use this when deploying Nzuko AI to an Oracle Cloud Always Free Ubuntu VM.

## What You Must Do

I cannot create the Oracle account for you because Oracle account creation can require your personal email, phone, card verification, and identity checks. Do not share those details in chat.

Create:

- Oracle Cloud Free Tier account
- Always Free Ubuntu VM
- Ingress/security rules for ports `80` and `443`
- SSH access to the VM

Oracle's Free Tier includes Always Free resources, including compute VM options. See Oracle's Free Tier page: https://www.oracle.com/cloud/free/

## After The VM Exists

Send only these non-secret details:

- VM public IP address
- SSH username, usually `ubuntu`
- Whether you already have a domain/subdomain

Do not paste passwords, private keys, OpenAI keys, Oracle card details, or WAHA keys.

## Server Bootstrap

On the Oracle Ubuntu VM, run:

```bash
sudo apt-get update
sudo apt-get install -y git
```

Then copy this project to the VM and run:

```bash
bash scripts/bootstrap-ubuntu.sh
```

If Docker permission changes require it, log out and back into SSH.

## Configure Hosted Secrets

On the VM:

```bash
cp .env.host.example .env.host
nano .env.host
```

Set:

- `PUBLIC_APP_HOST`
- `PUBLIC_APP_URL`
- `OPENAI_API_KEY`
- `WAHA_API_KEY`
- `ADMIN_PASSCODE`
- `APPROVED_GROUP_ID` once known

For initial setup without a domain, use the server IP only temporarily. Before real admin use, use a domain with HTTPS.

## Deploy

```bash
bash scripts/deploy-host.sh
```

Then open the hosted URL, login with the admin passcode, scan the WhatsApp linked-device QR, select the approved group, and enable live capture.
