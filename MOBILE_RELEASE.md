# Mobile Release Plan

Nzuko AI can now be shipped in two mobile forms:

- `PWA`: installable from Android Chrome and iPhone Safari
- `Android wrapper`: a future Play Store package using Capacitor

## Current local setup

This repo now includes:

- `public/manifest.webmanifest`
- `public/sw.js`
- `public/offline.html`
- install icons in `public/assets/`
- `capacitor.config.json`

The Capacitor configuration is set up in `hosted web app` mode.

That means the Android app should load:

- `https://nzuko-ai-pilot.netlify.app`

instead of trying to run the app fully offline from bundled static files.

This is intentional because the product depends on:

- Netlify Functions at `/api/...`
- Supabase authentication
- Stripe checkout and customer portal
- live WAHA connectivity

## Why hosted mode is the right first Android build

If we bundled only `public/` into a local WebView right now, these routes would break or need extra native proxy work:

- `/api/auth/status`
- `/api/billing/checkout`
- `/api/billing/portal`
- `/api/webhooks/...`

Using the live hosted app keeps the mobile wrapper thin and reduces launch risk.

## Next commands when you're ready to install Android tooling

Install Capacitor core and Android packages:

```bash
npm install @capacitor/cli @capacitor/core @capacitor/android
```

Then add and sync Android:

```bash
npm run mobile:add:android
npm run mobile:sync
npm run mobile:open:android
```

## Current machine blocker

The Android project has been generated successfully in `android/`, but this machine cannot build it yet because Gradle could not find Java:

```text
ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

Before building the Android app on this machine, install and configure:

1. `Android Studio`
2. a supported `JDK`
3. `JAVA_HOME`
4. Android SDK / platform tools from Android Studio

After that, re-run:

```bash
cmd /c android\gradlew.bat assembleDebug
```

Update: this blocker has now been resolved locally by installing a user-level JDK and Android SDK tools.

## Release signing

For Play Store upload, use a dedicated upload keystore instead of an unsigned bundle.

This repo now supports release signing through:

- `android/keystore.properties`
- `android/upload-keystore.jks`

These files are intentionally git-ignored.

An example template is included at:

- `android/keystore.properties.example`

## Before the first Play Store submission

1. Test Google sign-in inside the Android app.
2. Test Stripe checkout redirect and return flow.
3. Test WhatsApp connection setup from the wrapped app.
4. Test app resume/background behavior after opening Stripe or browser tabs.
5. Replace the Netlify subdomain with a production custom domain if possible.
6. Add Android app icons, splash assets, and final package metadata in Android Studio.
7. Prepare the Play Store listing:
   - app name
   - short description
   - full description
   - screenshots
   - privacy policy URL
   - support email

## Mobile flow caveats to verify early

### Google sign-in

The app currently uses Supabase browser OAuth flow.

Verify that:

- Google sign-in opens correctly from the Android wrapper
- the user returns to the app after authentication
- the Supabase session is still available after the handoff

If this feels unreliable in the wrapper later, move Google login to a native-browser handoff strategy instead of relying on an embedded flow.

### Stripe checkout and billing portal

The app currently redirects with:

- `window.location.href = payload.url`

Verify that:

- checkout opens successfully from the Android wrapper
- returning from Stripe lands back on the app
- the billing portal can also round-trip correctly

If this is awkward in the final Android app, open checkout and billing links in the system browser or Chrome Custom Tabs rather than keeping them inside the WebView.

## Important caveats

- The Play Store app is `not` ready yet just because Capacitor is configured.
- This local setup is only the scaffolding for the Android stage.
- Real device testing is still required before any store submission.
