// ══ Mobile-only: universal close for pop-up windows — phone BACK button + swipe to dismiss ══
//
// The app already history-manages SOME modals (portfolio via the URL, mgmt/reco/scanner via
// pushState + the popstate handler in init.js). This module extends the SAME behaviour to the
// remaining "generic" overlays (watchlist, earnings, correlation matrix, chart-info, fullscreen
// chart, press modal, the mobile bottom-sheet) and adds a swipe-down / swipe-side gesture that
// dismisses whichever window is on top — for EVERY modal, portfolio and watchlist included.
//
// Everything here is gated to phones (≤1023px); desktop is untouched. The matching generic-close
// lives in the init.js popstate handler (so there's a single popstate listener, no conflicts).
(function () {
    'use strict';
    var mq = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : null;
    function isPhone() { return mq ? mq.matches : window.innerWidth <= 1023; }

    // Generic overlays that DON'T manage their own history (we push a back-state for these).
    // NB: the mobile bottom-sheet toggles `.open` (not `.active`).
    var GENERIC = '.wl-overlay.active, .chart-info-overlay.active, .fullscreen-chart-overlay.active, .pa-modal-overlay.active, .pa-modal-overlay.open, #repChartModal, #mobileSheetWrap.open';
    // Every dismissable window (generic + the app-managed modals + the sidebar drawer) — for SWIPE.
    var ANY = GENERIC + ', .modal-overlay.active, .mgmt-overlay.active, .reco-overlay.active, .dc-overlay.active, .sa-overlay.active, .wl-overlay.active, .sidebar.mobile-open';
    // expose the generic list so init.js's popstate handler closes the same set
    window._finxGenericOverlaySel = GENERIC;

    function topOf(sel) { var els = document.querySelectorAll(sel); return els.length ? els[els.length - 1] : null; }

    function closeOverlay(ov) {
        if (!ov) return false;
        if (ov.classList.contains('sidebar')) { if (typeof toggleMobileSidebar === 'function') toggleMobileSidebar(); else ov.classList.remove('mobile-open'); return true; }
        // Click the modal's OWN close button so its cleanup (history, scroll-lock) runs.
        // (In the Android app these buttons are hidden — Back is the close — but still clickable from here.)
        var btn = ov.querySelector('.modal-close, .wl-close, .chart-info-close, .fs-close-btn, .fs-mob-x, .msheet-close, .mgmt-close, .pf-x, .pa-modal-x, .rep-chart-modal-x, .mcoll-modal-x, [data-modal-close], [aria-label="סגור"], [aria-label="close"]');
        if (btn) { btn.click(); return true; }
        ov.classList.remove('active');
        return true;
    }
    window._finxCloseTopOverlay = function () { var ov = topOf(GENERIC); if (ov) { closeOverlay(ov); return true; } if (document.querySelector('.sidebar.mobile-open')) { closeOverlay(document.querySelector('.sidebar.mobile-open')); return true; } return false; };

    // ── BACK button: push a history entry whenever a generic overlay opens, so the phone Back
    //    button pops it (the pop is handled in init.js's popstate → _finxCloseTopOverlay). ──
    var pushed = 0;
    function syncHistory() {
        if (grab) grab.classList.toggle('on', isPhone() && !!topOf(DISMISS));
        if (!isPhone()) return;
        var open = document.querySelectorAll(GENERIC).length + (document.querySelector('.sidebar.mobile-open') ? 1 : 0);
        while (pushed < open) { try { history.pushState({ finxOverlay: 1 }, '', location.href); } catch (e) { } pushed++; }
        if (open < pushed) pushed = open; // closed by ✕/back/swipe — resync (matches the app's existing pattern)
    }
    // childList too: some windows (report chart) are added/removed rather than class-toggled.
    var _syncQueued = false;
    function queueSync() { if (_syncQueued) return; _syncQueued = true; requestAnimationFrame(function () { _syncQueued = false; syncHistory(); }); }
    try { new MutationObserver(queueSync).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); } catch (e) { }

    // ── SWIPE UP from the bottom pill — close a window the way you close an app on the phone. ──
    // While dragging, the window follows the finger, shrinks, rounds its corners and fades, so the
    // page it was opened from shows behind it. Released past ~25% of the screen (or flicked) it
    // flies away and closes; otherwise it springs back into place.
    var DISMISS = ANY.replace(', .sidebar.mobile-open', '');
    var grab = document.createElement('div');
    grab.className = 'finx-grab';
    grab.setAttribute('aria-hidden', 'true');
    grab.innerHTML = '<span></span>';
    if (document.body) document.body.appendChild(grab);
    else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(grab); }, { once: true });

    function paint(ov, transform, opacity, radius, transition) {
        var st = ov.style;
        st.transition = transition || 'none';
        st.transformOrigin = '50% 100%';
        st.transform = transform;
        st.opacity = opacity;
        st.clipPath = radius ? 'inset(0 round ' + radius + 'px)' : '';
    }
    function unpaint(ov) {
        var st = ov.style;
        st.transition = 'none'; st.transform = ''; st.opacity = ''; st.clipPath = ''; st.willChange = ''; st.transformOrigin = '';
    }
    // Animate a window away, then run its own close (history/scroll-lock cleanup), then clear styles.
    function flyOut(ov, transform) {
        paint(ov, transform, 0, 26, 'transform .3s cubic-bezier(.2,.75,.25,1), opacity .26s ease-out');
        setTimeout(function () { closeOverlay(ov); setTimeout(function () { unpaint(ov); }, 400); }, 240);
    }

    var g = null;
    grab.addEventListener('touchstart', function (e) {
        var ov = topOf(DISMISS);
        if (!ov || e.touches.length !== 1) return;
        var y = e.touches[0].clientY;
        g = { ov: ov, y0: y, y: y, trail: [[performance.now(), y]] };
        ov.style.willChange = 'transform, opacity';
    }, { passive: true });
    grab.addEventListener('touchmove', function (e) {
        if (!g) return;
        e.preventDefault();
        var y = e.touches[0].clientY;
        g.y = y;
        g.trail.push([performance.now(), y]);
        if (g.trail.length > 6) g.trail.shift();
        var up = Math.max(0, g.y0 - y), down = Math.max(0, y - g.y0);
        var p = Math.min(1, up / (window.innerHeight * 0.55));
        paint(g.ov, 'translateY(' + (-up + down * 0.12) + 'px) scale(' + (1 - 0.16 * p) + ')', 1 - 0.28 * p, 30 * Math.min(1, p * 3));
    }, { passive: false });
    function release() {
        if (!g) return;
        var ov = g.ov, up = g.y0 - g.y, H = window.innerHeight;
        var a = g.trail[0], b = g.trail[g.trail.length - 1];
        var v = (a[1] - b[1]) / Math.max(1, b[0] - a[0]);          // px/ms, upward positive
        g = null;
        if (up > H * 0.25 || (v > 0.5 && up > 28)) flyOut(ov, 'translateY(' + (-H) + 'px) scale(0.7)');
        else {
            paint(ov, 'translateY(0) scale(1)', 1, 0, 'transform .36s cubic-bezier(.25,1.3,.4,1), opacity .2s ease');
            setTimeout(function () { unpaint(ov); }, 380);
        }
    }
    grab.addEventListener('touchend', release);
    grab.addEventListener('touchcancel', release);

    // ── SWIPE to dismiss: a pull-DOWN from the top of the content, or a decisive SIDE swipe. ──
    var sx = 0, sy = 0, watching = null, startScroll = 0;
    function scrollableFrom(el, stop) {
        while (el && el !== stop && el !== document.body) {
            var oy = getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
            el = el.parentElement;
        }
        return null;
    }
    document.addEventListener('touchstart', function (e) {
        watching = null;
        if (!isPhone() || e.touches.length !== 1) return;
        var ov = topOf(ANY); if (!ov) return;
        // Don't hijack gestures that start on interactive controls / charts.
        if (e.target.closest && e.target.closest('button, a, input, textarea, select, [role="button"], canvas, .slider, .ta-input, .finx-grab')) return;
        var t = e.touches[0]; sx = t.clientX; sy = t.clientY; watching = ov;
        var sc = scrollableFrom(e.target, ov); startScroll = sc ? sc.scrollTop : 0;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
        if (!watching || !isPhone()) { watching = null; return; }
        var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
        var ax = Math.abs(dx), ay = Math.abs(dy);
        var downDismiss = dy > 95 && ay > ax * 1.4 && startScroll <= 2;  // pull down from the top
        var sideDismiss = ax > 115 && ax > ay * 1.4;                     // decisive horizontal swipe
        if (downDismiss) flyOut(watching, 'translateY(' + Math.round(window.innerHeight * 0.9) + 'px) scale(0.9)');
        else if (sideDismiss) flyOut(watching, 'translateX(' + (dx > 0 ? '' : '-') + Math.round(window.innerWidth * 0.9) + 'px) scale(0.92)');
        watching = null;
    }, { passive: true });
})();
