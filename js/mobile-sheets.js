// ========== MOBILE SHEETS — progressive disclosure for phones only ==========
//
// Top-app pattern (Apple HIG / Revolut): long explainer paragraphs don't sit in the
// flow on a phone — they collapse behind a small "הסבר" button that opens a BOTTOM
// SHEET. Cuts page length dramatically ("יש יותר מדי גלילה") while keeping every
// word reachable in one tap.
//
// HARD ISOLATION: everything here no-ops above 768px. Desktop DOM is untouched —
// the module only ever adds classes/buttons on mobile, and un-collapses if the
// viewport grows back (orientation change / resize to tablet).

(function () {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const MQ = window.matchMedia('(max-width: 768px)');

    // Long explainer blocks → collapsed behind an "הסבר" button (per-page coverage).
    const EXPLAINERS = [
        '.tech-foot',           // technical + reports board footers
        '.risk-chart-legend',   // CML chart explanation paragraph
        '.reco-hint',           // recommendations how-to line
        '.corr-foot',           // correlation methodology foot
        '.rep-table-legend',    // report detail table legend
        '.ec-il-note',          // IL calendar note
        '.dc-card-foot',        // crisis indicator methodology foot
        '.lhe-subtitle',        // LHE model intro paragraph
        '.st-subtitle',         // stress-test intro paragraph
        '.lhe-gauge-foot',
        '.st-ai-foot',
    ];
    const SEL = EXPLAINERS.join(',');

    // ── Bottom sheet (one shared instance) ──
    let wrap = null;
    function ensureSheet() {
        if (wrap) return wrap;
        wrap = document.createElement('div');
        wrap.id = 'mobileSheetWrap';
        wrap.innerHTML = `
            <div class="msheet-backdrop"></div>
            <div class="msheet" dir="rtl" role="dialog" aria-modal="true">
                <div class="msheet-grip"></div>
                <div class="msheet-head">
                    <span class="msheet-title"></span>
                    <button class="msheet-close" type="button" aria-label="סגור">✕</button>
                </div>
                <div class="msheet-body"></div>
            </div>`;
        document.body.appendChild(wrap);
        const close = () => wrap.classList.remove('open');
        wrap.querySelector('.msheet-backdrop').addEventListener('click', close);
        wrap.querySelector('.msheet-close').addEventListener('click', close);
        return wrap;
    }
    function openSheet(title, html) {
        const w = ensureSheet();
        w.querySelector('.msheet-title').textContent = title || 'הסבר';
        w.querySelector('.msheet-body').innerHTML = html || '';
        w.classList.add('open');
    }
    window._openMobileSheet = openSheet;

    // ── Collapse one explainer element behind a button ──
    function collapse(el) {
        if (!el || el.dataset.msheet || !el.parentNode) return;
        const text = (el.textContent || '').trim();
        if (text.length < 60) return;             // short lines stay inline — no ceremony
        el.dataset.msheet = '1';
        el.classList.add('msheet-hidden');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msheet-btn';
        btn.innerHTML = '<span aria-hidden="true">ℹ️</span> הסבר קצר';
        const html = el.innerHTML;
        btn.addEventListener('click', (e) => { e.stopPropagation(); openSheet('הסבר קצר', html); });
        el.parentNode.insertBefore(btn, el);
    }
    function expandAll() {
        document.querySelectorAll('[data-msheet]').forEach(el => { el.classList.remove('msheet-hidden'); delete el.dataset.msheet; });
        document.querySelectorAll('.msheet-btn').forEach(b => b.remove());
    }

    // ── Dashboard: "סקירת חשיפה כוללת" folds on phones (closed by default) ──
    const EXP_LS = 'mob_exposure_open';
    function foldExposure() {
        const wrapEl = document.querySelector('#exposureSection .exposure-wrapper');
        if (!wrapEl || wrapEl.dataset.mfold) return;
        wrapEl.dataset.mfold = '1';
        const title = wrapEl.querySelector('.section-title');
        if (!title) return;
        let open = false;
        try { open = localStorage.getItem(EXP_LS) === '1'; } catch (e) { }
        wrapEl.classList.toggle('mfold-closed', !open);
        title.classList.add('mfold-title');
        title.addEventListener('click', () => {
            const closed = wrapEl.classList.toggle('mfold-closed');
            try { localStorage.setItem(EXP_LS, closed ? '0' : '1'); } catch (e) { }
        });
    }
    function unfoldExposure() {
        const wrapEl = document.querySelector('#exposureSection .exposure-wrapper');
        if (!wrapEl) return;
        wrapEl.classList.remove('mfold-closed');
        wrapEl.querySelector('.section-title')?.classList.remove('mfold-title');
        delete wrapEl.dataset.mfold;
    }

    function sweep(root) {
        if (!MQ.matches) return;
        const scope = root && root.querySelectorAll ? root : document;
        if (scope.matches && scope.matches(SEL)) collapse(scope);
        scope.querySelectorAll(SEL).forEach(collapse);
        foldExposure();
    }

    // Re-apply after every render (pages/cards rebuild their DOM constantly).
    const mo = new MutationObserver((muts) => {
        if (!MQ.matches) return;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) sweep(n);
            }
        }
    });

    function boot() {
        sweep(document);
        mo.observe(document.body, { childList: true, subtree: true });
        MQ.addEventListener('change', () => { if (MQ.matches) sweep(document); else { expandAll(); unfoldExposure(); } });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
