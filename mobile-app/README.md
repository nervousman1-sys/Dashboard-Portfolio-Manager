# Finextium — native app (Android + iOS)

A thin native shell (Capacitor 8) around the live platform at https://www.finextium.com.
The website is **not** modified for the app: the app's WebView tags itself (`FinextiumApp` in the
user agent → `<html class="is-app">`), and every app-only rule lives in `css/app.css` /
`js/app-shell.js`, scoped to that class.

Because the app loads the live site, **every website deploy reaches the app instantly** — rebuild
the app only when something in `mobile-app/` changes.

## What the shell adds
- Google sign-in through the phone's browser (Google blocks it inside app WebViews):
  `/app-auth.html` → Google → back into the app via `finextium://auth`.
- External links open in an in-app browser tab; `window.print()` → native print / Save-as-PDF.
- Navy system bars, portrait lock, Samsung forced-dark disabled, branded icon/splash, offline page.

## Builds
GitHub Actions (`.github/workflows/mobile-app.yml`) runs on every push that touches `mobile-app/`:
- **Android** → APK published at
  https://github.com/nervousman1-sys/Dashboard-Portfolio-Manager/releases/download/app-latest/Finextium.apk
- **iOS** → compile check for the simulator. A real-iPhone / App Store build needs an Apple Developer
  account ($99/yr) and signing in Xcode on a Mac (`npx cap open ios`).

Local Android build (needs JDK 21 + Android SDK): `npm ci && npx cap sync android && cd android && ./gradlew assembleDebug`.

### Stable signing (optional)
Add repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD` so every APK is signed with the same key (updates install over the old app).
Without them each CI build uses a fresh debug key — uninstall before installing a newer APK.

### Google sign-in
Supabase → Authentication → URL Configuration → Redirect URLs must allow
`https://www.finextium.com/app-auth.html` (or `https://www.finextium.com/**`).
