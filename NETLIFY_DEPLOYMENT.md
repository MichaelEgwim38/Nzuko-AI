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
- `WAHA_BASE_URL`
- `WAHA_SESSION`
- `WAHA_API_KEY` if your WAHA server needs it
- `OPENAI_API_KEY`
- `PUBLIC_APP_URL`

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

`ADMIN_PASSCODE` is now optional. The app supports user signup with email and passcode. Only set `ADMIN_PASSCODE` if you want a temporary legacy fallback login.

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

## 8. Voice-note behavior

- voice-note transcription runs in a background Netlify function
- transcripts may appear shortly after capture instead of in the same request
- officially supported language-code handling is strongest for languages such as English, Polish, Romanian, Hindi, and Urdu
- Igbo, Yoruba, Shona, and Twi are implemented with prompt-guided handling, so quality may vary more
