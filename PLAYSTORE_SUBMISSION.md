# Play Store Submission Handoff

This file captures the exact local Android release artifacts and the remaining manual steps required in Google Play Console.

## Release artifact

Primary upload file:

- `android/app/build/outputs/bundle/release/app-release.aab`

Debug install file:

- `android/app/build/outputs/apk/debug/app-debug.apk`

## App identity

- App name: `Nzuko AI`
- Package name: `com.roharigroup.nzukoai`

## Upload signing certificate

Current local upload key certificate:

- Owner: `CN=Nzuko AI, OU=Mobile, O=RohariGroup LTD, L=London, ST=London, C=GB`
- SHA1: `59:AB:56:2E:F3:08:5E:1A:C8:8E:A6:C0:24:C4:7D:60:CC:0B:94:84`
- SHA256: `15:44:F8:4E:D1:D0:67:DD:D2:F3:6F:AA:6B:FC:27:55:D8:C6:24:0D:A0:5B:B2:B5:D7:2C:DB:D4:79:FF:C8:B7`

## Sensitive signing files

These files are local-only and git-ignored:

- `android/upload-keystore.jks`
- `android/keystore.properties`

Back them up before changing machines.

## Before uploading

1. Test the debug APK on an Android device:
   - Google sign-in
   - Stripe checkout
   - return from Stripe
   - WhatsApp/WAHA flow
   - background/resume behavior
2. Confirm the privacy policy URL is public.
3. Confirm the terms URL is public.
4. Review app name, icon, and support contact.

## Recommended public URLs

Use hosted URLs after deployment:

- Privacy Policy: `/privacy.html`
- Terms of Service: `/terms.html`

Example:

- `https://nzuko-ai-pilot.netlify.app/privacy.html`
- `https://nzuko-ai-pilot.netlify.app/terms.html`

## Play Console tasks you still must do manually

These cannot be completed from this repo alone:

1. Create or access the Google Play Console app entry.
2. Upload the `.aab`.
3. Complete store listing fields:
   - title
   - short description
   - full description
   - screenshots
   - feature graphic
   - support email
   - privacy policy URL
4. Complete Google Play policy declarations.
5. Create a testing track or production release.
6. Submit for review.

## Suggested listing copy

### Short description

AI-powered WhatsApp meeting minutes, voice-note transcription, and workspace recaps.

### Full description

Nzuko AI helps approved communities and teams turn WhatsApp conversations into clear meeting minutes, recap drafts, and action-item summaries.

Use Nzuko AI to:

- generate recap drafts from approved WhatsApp groups
- transcribe voice notes
- capture decisions and action items
- keep a workspace-based activity history
- manage access through simple subscription plans

Nzuko AI is designed for review-first workflows, so recap drafts can be checked before they are shared.
