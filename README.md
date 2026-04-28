# Nzuko AI

AI minutes for group chats. A privacy-first pilot app for summarising an approved WhatsApp group into daily minutes.

The MVP is intentionally review-first:

- one approved group only
- group/admin consent before use
- voice notes treated as sensitive
- raw message retention kept short
- human approval before posting summaries
- final decisions and action items kept in an audit log

## Run

```bash
npm run dev
```

Then open:

```text
http://localhost:5177
```

## Netlify MVP

This repo now includes a Netlify-ready MVP shape:

- static dashboard published from `public/`
- API routes served by Netlify Functions
- persistent app state and captured messages stored with Netlify Blobs
- WAHA kept as an external service
- voice-note transcription queued through a Netlify Background Function

Files added for this deploy path:

- `netlify.toml`
- `netlify/functions/api.mjs`
- `netlify/functions/process-voice-note-background.mjs`

Required Netlify environment variables:

- `ADMIN_SESSION_SECRET`
- `BACKGROUND_TASK_SECRET`
- `WAHA_BASE_URL`
- `WAHA_SESSION`
- `WAHA_API_KEY` when your WAHA instance requires it
- `OPENAI_API_KEY` for voice-note transcription and translation
- `PUBLIC_APP_URL` for webhook registration in production

Authentication now supports user signup with email plus passcode. `ADMIN_PASSCODE` is optional and only kept as a legacy fallback if you want a single shared admin secret during transition.

Voice-note language choices in the dashboard now include auto-detect, the five most common main languages in England and Wales from Census 2021, and extra community options requested for this pilot: Igbo, Yoruba, Zimbabwe (Shona), Ghana (Twi), and India (Hindi).

Netlify-specific behavior change:

- voice-note transcripts may appear shortly after capture instead of in the same request, because transcription is queued in the background

## Plug-and-play Product Direction

Do not share this development folder with a normal group admin. The folder can contain private `.env` values, WAHA session data, local message history, and logs.

For a nontechnical admin, Nzuko AI should be delivered as a hosted pilot:

1. The operator hosts the app and WAHA bridge.
2. The admin opens one secure web link.
3. The admin confirms group consent.
4. The admin enters the private `ADMIN_PASSCODE`.
5. The admin scans a WhatsApp Linked Devices QR with the approved account.
6. The admin selects only the approved group.
7. The admin reviews each draft before posting.

The admin should not install Node, Docker, WAHA, or manage API keys.

The login screen is customised for the Umuokoroji Family WhatsApp Group. To use a family-specific photo, place the approved image at `public/assets/umuokoroji-login.jpg` before hosting.

For hosting, use [HOSTING.md](./HOSTING.md). For the free route, use [FREE_HOSTING.md](./FREE_HOSTING.md). The short version: run Nzuko AI and WAHA on an always-on server, set `PUBLIC_APP_URL`, keep WAHA private, and give the admin only the hosted Nzuko AI link and passcode.

## Current State

This first scaffold uses a mock WhatsApp connector so the product flow can be tested without linking a real account yet. The next connector target is a self-hosted WAHA instance using an admin-approved assistant account.

The WAHA bridge controls are already present in the dashboard:

- set WAHA URL, session, and optional API key
- check session status
- load WhatsApp group chats
- choose only the approved group
- pull recent text messages into the recap draft
- post approved recaps through WAHA when the connector mode is set to WAHA

Captured approved-group messages are stored locally in `data/messages.json`, so Nzuko AI can build its own searchable history from the moment live capture is running. The dashboard can load or generate recaps for today, this week, this month, this year, or custom date ranges.

WAHA's historical chat pull may still fail for some WEBJS sessions. When that happens, the app falls back to the locally stored live-capture history.

Voice-note transcription is review-first. When `OPENAI_API_KEY` is configured, incoming approved-group voice notes are downloaded from WAHA and sent to `gpt-4o-transcribe` with an Igbo/Pidgin/English prompt. The app leaves language detection on automatic by default because real group voice notes may mix Igbo, Nigerian Pidgin, and English. The transcript is always marked as needing human review before posting.

If WhatsApp delivers a voice note in an unsupported audio format such as OGG/Opus, the app keeps it as pending instead of guessing. Add an audio conversion step before production rollout.

## Next Integration Step

1. Run WAHA separately.
2. Scan QR with the approved assistant/admin WhatsApp account.
3. Select only the approved group.
4. Stream group messages into this app.
5. Send approved recap text back through WAHA.

Do not connect a personal account silently. Use only the group and account approved by the group admin and members.

## Quick Docs

- [User Guide](./USER_GUIDE.md)
- [Admin Handover](./ADMIN_README.md)
- [Group Message](./GROUP_MESSAGE.md)

## Cost Notes

Current model usage in this app:

- Voice-note transcription: `gpt-4o-transcribe`
- Voice-note translate and summarize step: `gpt-4.1-mini`

Rough usage estimates:

- Text-only recap: about $0.001 to $0.01
- 1-minute voice note: about $0.006 to $0.007
- 5-minute voice note: about $0.03 to $0.04

These are API estimates only. ChatGPT Plus, hosting, tunnel, and server costs are separate.

Reference: current OpenAI API pricing for gpt-4o-transcribe and gpt-4.1-mini:
- https://platform.openai.com/docs/pricing
- https://platform.openai.com/docs/models/gpt-4.1-mini
- https://platform.openai.com/docs/models/gpt-4o-transcribe

