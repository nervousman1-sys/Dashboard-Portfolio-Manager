// ========== NATIVE APP SHELL — Finextium for Android / iOS ==========
// Runs ONLY inside the Finextium app (mobile-app/, Capacitor). index.html tags <html class="is-app">
// when the WebView's user agent carries "FinextiumApp"; on the website this file exits on line 1.
//
// The site bundles no Capacitor npm code — it talks to native through the bridge the app injects
// into this page: Capacitor.nativePromise(plugin, method, options) / Capacitor.addListener(...).
//
// What it adds in the app:
//   1. Google login through the phone's browser (Google blocks OAuth inside app WebViews) with PKCE —
//      the finextium://auth deep link carries only a one-time code, never session tokens.
//   2. External links (TradingView, company sites, news) open in an in-app browser tab instead of
//      replacing the platform.
//   3. window.print() (report "save as PDF") → native Android/iOS print sheet (WebViews ignore it).
//   4. Splash hand-off + light status-bar icons over the navy system-bar strips.
(function () {
    'use strict';
    const root = document.documentElement;
    if (!root.classList.contains('is-app')) return;

    const SITE_HOST = 'www.finextium.com';
    const SITE = 'https://' + SITE_HOST;
    const Cap = window.Capacitor;
    const hasBridge = !!(Cap && typeof Cap.nativePromise === 'function');
    const native = (plugin, method, opts) => hasBridge
        ? Cap.nativePromise(plugin, method, opts || {})
        : Promise.reject(new Error('native bridge unavailable'));
    const listen = (plugin, event, cb) => {
        try { if (Cap && typeof Cap.addListener === 'function') Cap.addListener(plugin, event, cb); } catch (e) { }
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Small self-contained toast (the platform's own toasts may not be loaded yet at auth time).
    function toast(msg, ms) {
        let el = document.getElementById('appShellToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'appShellToast';
            el.className = 'app-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('show'), ms || 2600);
    }

    // ── In-app browser for anything that isn't the platform itself ────────────────────────────
    const isExternal = (href) => {
        try {
            const u = new URL(href, location.href);
            return /^https?:$/.test(u.protocol) && u.host !== location.host && u.host !== SITE_HOST;
        } catch (e) { return false; }
    };
    function openExternal(href) {
        return native('Browser', 'open', { url: new URL(href, location.href).href, toolbarColor: '#0f1420' })
            .catch(() => { location.href = href; });
    }
    document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        if (/^(mailto|tel|sms):/i.test(href)) return;               // let the OS handle these
        if (isExternal(href)) { e.preventDefault(); openExternal(href); }
    }, true);
    const _origOpen = window.open;
    window.open = function (url, target, features) {
        if (url && isExternal(url)) { openExternal(url); return null; }
        return _origOpen ? _origOpen.call(window, url, target, features) : null;
    };

    // ── Report printing / "save as PDF" → native print sheet ───────────────────────────────────
    window.print = function () {
        native('AppPrint', 'print', { name: (document.title || 'Finextium').replace(/[\\/:*?"<>|]/g, ' ') })
            .catch(() => toast('הדפסה אינה זמינה במכשיר זה'));
    };

    // ── Google login via the system browser + deep link back — PKCE (RFC 8252) ─────────────────
    // Google blocks OAuth inside app WebViews, so sign-in runs in the phone browser (/app-auth.html)
    // and returns through the finextium://auth deep link. A custom URL scheme can be claimed by ANY app
    // on the phone, so the link must never carry session tokens: it carries only a one-time
    // authorization CODE. The secret code_verifier is generated and kept HERE (the app's own storage);
    // only its SHA-256 challenge goes to the browser. A rogue app that intercepts the link gets a code it
    // cannot redeem.
    const PKCE_KEY = "finx_app_pkce";
    const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    window.handleGoogleLogin = async function () {
        if (!hasBridge) { toast("עדכן את האפליקציה כדי להתחבר עם Google"); return; }
        try {
            const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));            // 64 chars
            const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
            localStorage.setItem(PKCE_KEY, JSON.stringify({ v: verifier, t: Date.now() }));
            await native("Browser", "open", { url: SITE + "/app-auth.html?start=1&cc=" + challenge, toolbarColor: "#0f1420" });
        } catch (e) {
            if (typeof showAuthError === "function") showAuthError("לא ניתן לפתוח את חלון ההתחברות של Google");
        }
    };

    let _authBusy = false;
    async function handleDeepLink(url) {
        url = String(url || "");
        if (!/^finextium:\/\/auth/i.test(url) || _authBusy) return;
        _authBusy = true;
        native("Browser", "close").catch(() => { });
        try {
            const p = new URLSearchParams(url.split("?")[1] || "");
            const code = p.get("code");
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(PKCE_KEY) || "null"); } catch (e) { }
            localStorage.removeItem(PKCE_KEY);                                     // single use
            if (!code) { toast(p.get("error") ? "ההתחברות עם Google לא הושלמה" : "ההתחברות בוטלה"); return; }
            if (!saved || !saved.v || Date.now() - saved.t > 15 * 60 * 1000) { toast("פג תוקף ההתחברות — נסה שוב"); return; }
            const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=pkce", {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
                body: JSON.stringify({ auth_code: code, code_verifier: saved.v }),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.access_token || !j.refresh_token) { toast("ההתחברות עם Google נכשלה"); return; }
            // supabase-config.js creates the client during boot — wait for it if the link arrived early.
            for (let i = 0; i < 80 && (typeof supabaseClient === "undefined" || !supabaseClient); i++) await sleep(100);
            if (typeof supabaseClient === "undefined" || !supabaseClient) { toast("שירות ההתחברות לא נטען — נסה שוב"); return; }
            const { error } = await supabaseClient.auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token });
            if (error) { toast("ההתחברות עם Google נכשלה"); return; }
            toast("מחובר ✓", 1200);
            location.replace("/");                       // clean boot with the persisted session
        } catch (e) {
            toast("ההתחברות עם Google נכשלה");
        } finally {
            _authBusy = false;
        }
    }
    listen('App', 'appUrlOpen', (ev) => handleDeepLink(ev && ev.url));
    native('App', 'getLaunchUrl').then(r => r && r.url && handleDeepLink(r.url)).catch(() => { });

    // ── Status bar + splash ────────────────────────────────────────────────────────────────────
    // The WebView is laid out BELOW the status bar / ABOVE the gesture bar (no viewport-fit=cover),
    // so those strips always show the app's navy window background in both themes → light icons.
    native('SystemBars', 'setStyle', { style: 'DARK' }).catch(() => { });

    const hideSplash = () => native('SplashScreen', 'hide', { fadeOutDuration: 250 }).catch(() => { });
    if (document.readyState === 'complete') hideSplash();
    else window.addEventListener('load', hideSplash, { once: true });
    setTimeout(hideSplash, 4000);                         // never leave the splash up
})();
