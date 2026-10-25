// ========== NATIVE APP SHELL — Finextium for Android / iOS ==========
// Runs ONLY inside the Finextium app (mobile-app/, Capacitor). index.html tags <html class="is-app">
// when the WebView's user agent carries "FinextiumApp"; on the website this file exits on line 1.
//
// The site bundles no Capacitor npm code — it talks to native through the bridge the app injects
// into this page: Capacitor.nativePromise(plugin, method, options) / Capacitor.addListener(...).
//
// What it adds in the app:
//   1. Google login through the phone's browser (Google blocks OAuth inside app WebViews) and a
//      finextium://auth deep link back into the app with the session tokens.
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

    // ── Google login via the system browser + deep link back ───────────────────────────────────
    // /app-auth.html (on the site, opened in the browser tab) starts Supabase's Google flow and,
    // once Google returns, forwards #access_token/#refresh_token to finextium://auth.
    window.handleGoogleLogin = async function () {
        if (!hasBridge) { toast('עדכן את האפליקציה כדי להתחבר עם Google'); return; }
        try {
            await native('Browser', 'open', { url: SITE + '/app-auth.html?start=1', toolbarColor: '#0f1420' });
        } catch (e) {
            if (typeof showAuthError === 'function') showAuthError('לא ניתן לפתוח את חלון ההתחברות של Google');
        }
    };

    let _authBusy = false;
    async function handleDeepLink(url) {
        url = String(url || '');
        if (!/^finextium:\/\/auth/i.test(url) || _authBusy) return;
        _authBusy = true;
        native('Browser', 'close').catch(() => { });
        try {
            const frag = url.includes('#') ? url.split('#')[1] : (url.split('?')[1] || '');
            const p = new URLSearchParams(frag);
            const at = p.get('access_token'), rt = p.get('refresh_token');
            if (!at || !rt) { toast(p.get('error_description') ? 'ההתחברות עם Google נכשלה' : 'ההתחברות בוטלה'); return; }
            // supabase-config.js creates the client during boot — wait for it if the link arrived early.
            for (let i = 0; i < 80 && (typeof supabaseClient === 'undefined' || !supabaseClient); i++) await sleep(100);
            if (typeof supabaseClient === 'undefined' || !supabaseClient) { toast('שירות ההתחברות לא נטען — נסה שוב'); return; }
            const { error } = await supabaseClient.auth.setSession({ access_token: at, refresh_token: rt });
            if (error) { toast('ההתחברות עם Google נכשלה'); return; }
            toast('מחובר ✓', 1200);
            location.replace('/');                       // clean boot with the persisted session
        } catch (e) {
            toast('ההתחברות עם Google נכשלה');
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
