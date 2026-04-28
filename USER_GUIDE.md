# Nzuko AI User Guide

Nzuko AI helps the Umuokoroji Family WhatsApp Group capture decisions, action items, unresolved issues, and reviewed voice-note summaries.

## Who Uses It

- The admin or reviewer uses the dashboard.
- Group members continue chatting normally on WhatsApp.
- Members do not need to install anything if the admin is the one operating it.

## How To Access It

1. Open the Nzuko AI web link shared by the operator.
2. Enter the private admin passcode.
3. You will enter the dashboard.

## What The Admin Does

1. Confirm the approved WhatsApp group.
2. Connect the approved WhatsApp assistant account.
3. Load the WhatsApp group list.
4. Select the approved group only.
5. Pull recent messages.
6. Review the AI-generated summary.
7. Edit or correct anything if needed.
8. Approve the final recap.
9. Post the approved recap back to the WhatsApp group.

## What Nzuko AI Captures

- key discussion points
- decisions taken
- action items
- unresolved questions
- reviewed voice-note summaries

## Voice Notes

- Voice notes can be transcribed and summarized.
- If a voice note is in Igbo or mixed language, the app may transcribe it, translate it into English, and summarize the meaning.
- Voice-note output should still be reviewed by a human before posting.

## Privacy Rules

- Only the approved WhatsApp group should be connected.
- Private chats should not be accessed.
- The admin should review summaries before posting.
- The admin passcode should be shared privately, not in the group.

## Daily Use

1. Open Nzuko AI once or twice a day.
2. Pull recent group messages.
3. Review the draft summary.
4. Approve and post the recap.
5. Check the audit log for past approved minutes and corrections.

## What Group Members Need To Know

- Continue using WhatsApp as normal.
- Important decisions should be stated clearly in chat or voice notes.
- If a summary is wrong, members should reply with corrections.

## Current Limitation

If the app is running from a laptop with a temporary tunnel, the link may stop working if the laptop sleeps, restarts, loses internet, or the tunnel expires.

## Estimated Cost Per Use

These are rough API usage estimates for the current Nzuko AI setup and can change if OpenAI pricing changes.

- Text-only daily summary: usually a fraction of a cent, often about $0.001 to $0.01 depending on how many messages are included.
- One 1-minute voice note: about $0.006 to $0.007.
- One 5-minute voice note: about $0.03 to $0.04.
- A light daily usage pattern with one summary and about 10 minutes of voice notes could be around $0.06 to $0.08 for that day.

Why this is the rough cost:

- Voice-note transcription uses `gpt-4o-transcribe`, which is priced at about $0.006 per minute.
- Voice-note translation and summarization use `gpt-4.1-mini`, which is very low cost for normal recap-size prompts.
- Text recap generation also uses `gpt-4.1-mini`, so text-only summaries are usually very cheap.

Important:

- ChatGPT Plus does not cover API usage for this app.
- API usage is billed separately from your ChatGPT subscription.
- Hosting or server costs are separate from API costs.

Reference: current OpenAI API pricing for gpt-4o-transcribe and gpt-4.1-mini:
- https://platform.openai.com/docs/pricing
- https://platform.openai.com/docs/models/gpt-4.1-mini
- https://platform.openai.com/docs/models/gpt-4o-transcribe

