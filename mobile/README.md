# HRP Synapse on phones

Synapse ships in three layers. Each one wraps the same web app, so there's only one code base to maintain.

| Layer | What the user gets | Effort |
| --- | --- | --- |
| **Installable web app (PWA)** — live now | "Install app" in Chrome/Edge, "Add to Home Screen" in Safari. It opens full-screen on **My day** (`/field`), has push reminders, logs visits offline and checks in with GPS. | Nothing to build |
| **Android app (Trusted Web Activity)** — `mobile/twa` | A Play Store listing. Chrome renders the app without browser UI, and push and location work. | About 1 hour plus Play Console review |
| **Native shell (Capacitor)** — `mobile/capacitor` | Android and iOS store apps. Needed for the App Store and for later native plugins (background location, barcode scanner, contacts). | Half a day per platform |

Both store apps load the live site (`https://hrpsynapse.hrpai.in`). A web deploy updates them instantly; there's no store resubmission for features.

## 1. Installable web app (already done)

- The manifest is `apps/web/public/manifest.webmanifest`. The service worker is generated at build time from `apps/web/sw/sw.js`.
- **Push:** `pnpm setup` generates a VAPID key pair per environment and uploads it as Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).
  - Users turn push on per device from **My day** or **My account → Phone & notifications**.
  - Every in-app notification (follow-ups, assignments, SLA breaches, approvals, job updates) is also pushed.
- **Offline:** the app shell is cached.
  - On My day, check-ins, walk-in leads and task ticks are queued on the device (IndexedDB) and sent on reconnect.
  - Only the person who queued them can send them.
- iOS needs 16.4 or later for push, and only works after "Add to Home Screen".

## 2. Android app via Bubblewrap (TWA)

Prerequisites: Node 20+, a JDK 17 and the Android SDK. Bubblewrap can download the JDK and SDK for you.

```bash
npm i -g @bubblewrap/cli
cd mobile/twa
bubblewrap init --manifest https://hrpsynapse.hrpai.in/manifest.webmanifest   # answer prompts, or keep twa-manifest.json as provided
bubblewrap build                                                              # creates the keystore on first run and builds app-release-signed.apk / .aab
```

Next, make the site trust the app. Without this step Chrome shows a URL bar on top of the app.

1. Get the SHA-256 fingerprint of the signing key:
   - `keytool -list -v -keystore synapse-upload.keystore -alias synapse | grep SHA256`
   - If you use Play App Signing, use the **app signing key** fingerprint from Play Console → Setup → App integrity.
2. Set the Worker vars for production in `apps/api/wrangler.jsonc` under `env.production.vars`:
   ```jsonc
   "ANDROID_APP_ID": "in.hrpai.synapse",
   "ANDROID_CERT_SHA256": "AB:CD:…"   // comma-separate several (upload key + Play signing key)
   ```
3. Deploy. `https://hrpsynapse.hrpai.in/.well-known/assetlinks.json` now returns the statement.
4. Upload `app-release-bundle.aab` to Play Console (internal testing first).

Keep `synapse-upload.keystore` and its passwords safe and **out of git** (it's in `.gitignore`). You can't update the app without them.

## 3. Native shell with Capacitor (Android + iOS)

```bash
cd mobile/capacitor
npm install
npx cap add android        # creates android/ (Android Studio project)
npx cap add ios            # creates ios/ (Xcode project, macOS only)
npx cap sync
npx cap open android       # build / run / sign from Android Studio
```

- `capacitor.config.json` points `server.url` to the production site. `www/index.html` is only shown when the site can't be reached.
- **Android:** add `ACCESS_FINE_LOCATION` and `CAMERA` to `android/app/src/main/AndroidManifest.xml` for GPS check-ins and photo capture.
- **iOS:** add `NSLocationWhenInUseUsageDescription` and `NSCameraUsageDescription` to `ios/App/App/Info.plist`.
  - Web Push isn't delivered inside an iOS WKWebView. For iOS store builds, add `@capacitor/push-notifications` (APNs) when needed.
  - Until then, iPhone users who need reminders can use the home-screen web app.
- To point a build at the dev environment, change `server.url` to `https://hrpsynapse-dev.hrpai.in/field`.
