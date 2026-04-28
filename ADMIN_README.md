# Nzuko AI Admin Handover

Nzuko AI prepares draft minutes for one approved WhatsApp group. It is designed to reduce repeated arguments by capturing decisions, action items, unresolved questions, and reviewed voice-note summaries.

## What The Admin Does

1. Open the secure Nzuko AI link provided by the operator.
2. Enter the private admin passcode.
3. Confirm that the group approved the pilot.
4. Scan the WhatsApp Linked Devices QR with the approved WhatsApp account.
5. Select only the approved WhatsApp group.
6. Pull today's messages when a summary is needed.
7. Review the draft minutes.
8. Approve the post only after checking the content.
9. Ask members to reply with corrections within the review window.

The admin does not need to install Node, Docker, WAHA, or set API keys.

The login screen can include the family-approved photo supplied by the group. The operator should add it before hosting; do not use a private family image without consent.

The admin should receive only:

- The hosted Nzuko AI link.
- The private admin passcode.
- A short instruction to scan the WhatsApp Linked Devices QR with the approved account.

If the app is only running on a laptop, it will stop working when that laptop is closed, sleeping, offline, or restarted.

## Privacy Rules

- Use only the group approved by the admin and members.
- Do not connect private chats or unrelated WhatsApp groups.
- Treat voice notes as sensitive.
- Review Igbo, Pidgin, and English translations before posting.
- Keep automatic posting off until the pilot proves trust.
- Do not share raw exports, `.env` files, WAHA sessions, or message history with anyone who should not have access.

## What The Operator Handles

- Hosting the Nzuko AI app.
- Hosting the WAHA bridge with persistent storage.
- Adding the OpenAI API key on the server.
- Keeping the WAHA API key private.
- Backing up only approved minutes, not unnecessary raw chat history.
- Rotating secrets if a key is exposed.
- Stopping the pilot quickly if the group withdraws consent.

## Recommended Pilot Flow

Run the first 1-2 weeks in review-first mode:

1. The admin pulls the day's messages.
2. Nzuko AI generates draft minutes.
3. A human checks names, timestamps, voice-note translations, decisions, and action items.
4. The admin posts the approved minutes.
5. Members reply with corrections within 24 hours.

After the pilot, decide whether to keep it manual-review only or add scheduled draft generation.

## Important Sharing Warning

Do not send the current development folder to another person as the product. It can include secrets and private group data. Share a hosted link or a clean deployment package only.

## Estimated Cost Per Use

The current Nzuko AI build uses OpenAI API calls for voice-note handling and low-cost text processing.

Practical estimates:

- Text-only recap: usually about $0.001 to $0.01 depending on message volume.
- 1-minute voice note: about $0.006 to $0.007.
- 5-minute voice note: about $0.03 to $0.04.
- One day with a normal recap plus 10 minutes of voice notes may be around $0.06 to $0.08.

These numbers are only estimates, not fixed charges. Actual spend depends on:

- how many messages are included in the recap
- how many voice notes are processed
- how long the voice notes are
- future OpenAI pricing changes

Remember:

- API usage is separate from ChatGPT Plus.
- Laptop, tunnel, VPS, domain, and hosting costs are separate from API spend.

Reference: current OpenAI API pricing for gpt-4o-transcribe and gpt-4.1-mini:
- https://platform.openai.com/docs/pricing
- https://platform.openai.com/docs/models/gpt-4.1-mini
- https://platform.openai.com/docs/models/gpt-4o-transcribe

