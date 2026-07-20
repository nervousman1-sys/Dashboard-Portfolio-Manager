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
    var GENERIC = '.wl-overlay.active, .chart-info-overlay.active, .fullscreen-chart-overlay.active, .pa-modal-overlay.active, #mobileSheetWrap.active';
    // Every dismissable window (generic + the app-managed modals + the sidebar drawer) — for SWIPE.
    var ANY = GENERIC + ', .modal-overlay.active, .mgmt-overlay.active, .reco-overlay.active, .dc-overlay.active, .sa-overlay.active, .sidebar.mobile-open';
    // expose the generic list so init.js's popstate handler closes the same set
    window._finxGenericOverlaySel = GENERIC;

    function topOf(sel) { var els = document.querySelectorAll(sel); return els.length ? els[els.length - 1] : null; }

    function closeOverlay(ov) {
        if (!ov) return false;
        if (ov.classList.contains('sidebar')) { if (typeof toggleMobileSidebar === 'function') toggleMobileSidebar(); else ov.classList.remove('mobile-open'); return true; }
        // Click the modal's OWN close button so its cleanup (history, scroll-lock) runs.
        var btn = ov.querySelector('.modal-close, .wl-close, .chart-info-close, .fs-close-btn, .msheet-close, .mgmt-close, [data-modal-close], [aria-label="סגור"], [aria-label="close"]');
        if (btn) { btn.click(); return true; }
        ov.classList.remove('active');
        return true;
    }
    window._finxCloseTopOverlay = function () { var ov = topOf(GENERIC); if (ov) { closeOverlay(ov); return true; } if (document.querySelector('.sidebar.mobile-open')) { closeOverlay(document.querySelector('.sidebar.mobile-open')); return true; } return false; };

    // ── BACK button: push a history entry whenever a generic overlay opens, so the phone Back
    //    button pops it (the pop is handled in init.js's popstate → _finxCloseTopOverlay). ──
    var pushed = 0;
    function syncHistory() {
        if (!isPhone()) return;
        var open = document.querySelectorAll(GENERIC).length + (document.querySelector('.sidebar.mobile-open') ? 1 : 0);
        while (pushed < open) { try { history.pushState({ finxOverlay: 1 }, '', location.href); } catch (e) { } pushed++; }
        if (open < pushed) pushed = open; // closed by ✕/back/swipe — resync (matches the app's existing pattern)
    }
    try { new MutationObserver(syncHistory).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] }); } catch (e) { }

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
        if (e.target.closest && e.target.closest('button, a, input, textarea, select, [role="button"], canvas, .slider, .ta-input')) return;
        var t = e.touches[0]; sx = t.clientX; sy = t.clientY; watching = ov;
        var sc = scrollableFrom(e.target, ov); startScroll = sc ? sc.scrollTop : 0;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
        if (!watching || !isPhone()) { watching = null; return; }
        var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
        var ax = Math.abs(dx), ay = Math.abs(dy);
        var downDismiss = dy > 95 && ay > ax * 1.4 && startScroll <= 2;  // pull down from the top
        var sideDismiss = ax > 115 && ax > ay * 1.4;                     // decisive horizontal swipe
        if (downDismiss || sideDismiss) closeOverlay(watching);
        watching = null;
    }, { passive: true });
})();
