# Mobile release pipeline (build → store → tracked in SanchalanOS)

SanchalanOS plans the work, the coding agent implements it, and CI builds and publishes the app. The
app binary (AAB/IPA) is built and uploaded to the store in CI — it can't be built in SanchalanOS's
cloud. After Fastlane uploads, CI calls SanchalanOS so the release shows the store status.

## One-time setup
1. In SanchalanOS: Project → Releases → **App store → Connect Google Play**, paste the service-account
   JSON, then **Link app** with the package name and track.
2. In the app repo, add GitHub Actions secrets:
   - `PLAY_SERVICE_ACCOUNT_JSON` — the same service-account JSON.
   - `SANCHALAN_URL` — e.g. https://www.sanchalan.hrpai.in
   - `SANCHALAN_KEY` — the project's coding-agent key (Project → Coding agent → keys).
   - (signing) `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
3. Copy `Fastfile` into `android/fastlane/` and `release.yml` into `.github/workflows/`.

## How a release flows
- You create tasks/stories under a release in SanchalanOS → the coding agent implements them and opens PRs.
- Merging to `main` (or pushing a tag) triggers `release.yml`: it builds a signed AAB, Fastlane uploads
  it to the chosen track, then calls the `store_submit` MCP tool so the release's status shows in
  SanchalanOS (uploaded → in_review → live). Google reviews it as usual.
- iOS is the same shape: add an App Store Connect key and a `build_ios`/`upload_to_testflight` lane.
