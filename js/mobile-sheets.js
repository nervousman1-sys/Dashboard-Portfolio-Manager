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
            const opening = wrapEl.classList.contains('mfold-closed');
            try { localStorage.setItem(EXP_LS, opening ? '1' : '0'); } catch (e) { }
            if (opening && typeof window.renderExposureSection === 'function') {
                // Re-render on open: the donut was created inside display:none → 0-size
                // canvas. A fresh render draws it at real width (the MutationObserver
                // re-folds per the just-saved state, so it comes back OPEN).
                wrapEl.classList.remove('mfold-closed');
                delete wrapEl.dataset.mfold;
                window.renderExposureSection();
            } else {
                wrapEl.classList.toggle('mfold-closed');
            }
        });
    }
    function unfoldExposure() {
        const wrapEl = document.querySelector('#exposureSection .exposure-wrapper');
        if (!wrapEl) return;
        wrapEl.classList.remove('mfold-closed');
        wrapEl.querySelector('.section-title')?.classList.remove('mfold-title');
        delete wrapEl.dataset.mfold;
    }

    // ── Chip rails → "הצג הכל" opens a SHEET with the full list (no sideways
    // scrolling, no half-cut pills). The visible line keeps only WHOLE chips;
    // the sheet shows clones of every chip — their inline onclick works as-is,
    // and activating one closes the sheet. ──
    const RAILS = '.rep-new-chips, .tech-chips';
    function openRailSheet(el, title) {
        const w = ensureSheet();
        w.querySelector('.msheet-title').textContent = title;
        const body = w.querySelector('.msheet-body');
        body.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'msheet-chipwrap';
        for (const c of el.children) {
            if (c.classList && c.classList.contains('mrail-btn')) continue;
            const clone = c.cloneNode(true);
            clone.classList.remove('mrail-cut');
            grid.appendChild(clone);
        }
        grid.addEventListener('click', (ev) => {
            // A chip was activated → let its inline onclick run, then close the sheet.
            if (ev.target.closest('button, a, [onclick]')) setTimeout(() => w.classList.remove('open'), 120);
        });
        body.appendChild(grid);
        w.classList.add('open');
    }
    // Whole-pill clipping, re-measured on EVERY chip re-render: hide chips crossing
    // the rail's own left content edge (RTL overflow side). The button is a flex
    // SIBLING outside the rail — overlap is structurally impossible.
    function _recut(el) {
        const box = el.getBoundingClientRect();
        for (const c of el.children) {
            c.classList.remove('mrail-cut');
            if (c.getBoundingClientRect().left < box.left - 1) c.classList.add('mrail-cut');
        }
        const btn = el.nextElementSibling;
        if (btn && btn.classList.contains('mrail-btn')) btn.textContent = `הצג הכל · ${el.children.length}`;
    }
    function railify(el) {
        if (!el || !el.parentNode || !el.clientWidth) return;
        const hasBtn = el.nextElementSibling && el.nextElementSibling.classList && el.nextElementSibling.classList.contains('mrail-btn');
        if (!el.dataset.mrail) {
            if (el.scrollWidth <= el.clientWidth + 8) return;  // fits — nothing to do
            el.dataset.mrail = '1';
            el.classList.add('mrail');
        }
        if (!hasBtn) {
            const title = (el.closest('.rep-new-strip')?.querySelector('.rep-new-lbl')?.textContent || '').trim()
                || (el.classList.contains('tech-chips') ? 'כל המסננים והאינדיקטורים' : 'הרשימה המלאה');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mrail-btn';
            btn.addEventListener('click', (e) => { e.stopPropagation(); openRailSheet(el, title); });
            el.parentNode.insertBefore(btn, el.nextSibling); // SIBLING on the same flex row
        }
        _recut(el);
    }
    function unrailAll() {
        document.querySelectorAll('.mrail').forEach(el => { el.classList.remove('mrail', 'mrail-open'); delete el.dataset.mrail; });
        document.querySelectorAll('.mrail-cut').forEach(c => c.classList.remove('mrail-cut'));
        document.querySelectorAll('.mrail-btn').forEach(b => b.remove());
    }

    function sweep(root) {
        if (!MQ.matches) return;
        const scope = root && root.querySelectorAll ? root : document;
        if (scope.matches && scope.matches(SEL)) collapse(scope);
        scope.querySelectorAll(SEL).forEach(collapse);
        // Rails measure layout — wait a tick so freshly-inserted DOM has widths.
        setTimeout(() => {
            if (!MQ.matches) return;
            const sc = root && root.querySelectorAll ? root : document;
            if (sc.matches && sc.matches(RAILS)) railify(sc);
            sc.querySelectorAll(RAILS).forEach(railify);
        }, 60);
        foldExposure();
    }

    // Re-apply after every render (pages/cards rebuild their DOM constantly).
    const mo = new MutationObserver((muts) => {
        if (!MQ.matches) return;
        const railParents = new Set();
        for (const m of muts) {
            // A rail container often exists EMPTY first and only later gets its chips
            // (innerHTML fills) — the mutation then carries the chips, not the rail.
            // Measure the PARENT the chips landed in.
            if (m.target && m.target.nodeType === 1 && m.target.matches && m.target.matches(RAILS)) railParents.add(m.target);
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) sweep(n);
            }
        }
        if (railParents.size) {
            // A previously-railified rail whose innerHTML was just replaced lost its
            // anchored button — rebuild SYNCHRONOUSLY (no flicker window). Fresh rails
            // wait a tick for full layout.
            railParents.forEach(p => { if (p.dataset.mrail && !p.querySelector('.mrail-btn')) railify(p); });
            setTimeout(() => { if (MQ.matches) railParents.forEach(railify); }, 60);
        }
    });

    // ── Technical table: tap a stock row → sheet with the FULL metric set ──
    // The phone table shows the 5 decision columns; the sheet completes the picture
    // (ממוצע 200/300 יום ושבועות, FVG רבעוני, ATR, נפח) exactly like the desktop grid.
    const _esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const _fmtVol = (n) => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : n;
    function openTechSheet(sym) {
        if (typeof window._techSheetData !== 'function') return;
        const d = window._techSheetData(sym);
        if (!d) return;
        const v = d.v;
        const maRow = (label, dist) => {
            if (dist == null) return `<div class="msheet-kv"><span>${label}</span><b class="msheet-dim">—</b></div>`;
            const near = Math.abs(dist) <= (d.nearPct || 3);
            const val = `${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%`;
            return `<div class="msheet-kv"><span>${label}</span><b class="${near ? 'msheet-good' : 'msheet-dim'}">${near ? '✓' : '✗'} ${val}</b></div>`;
        };
        const fvgRow = (label, f) => f && f.inside
            ? `<div class="msheet-kv"><span>${label}</span><b class="msheet-good">✓ בפנים ${_esc(f.lo)}–${_esc(f.hi)}</b></div>`
            : `<div class="msheet-kv"><span>${label}</span><b class="msheet-dim">✗</b></div>`;
        const rsiCls = (x, lo, hi) => x == null ? 'msheet-dim' : x < lo ? 'msheet-warn' : x > hi ? 'msheet-bad' : '';
        const html = `
            <div class="msheet-tech-top">
                <div><span>מחיר</span><b>${d.cur}${(v.price ?? 0).toLocaleString('en-US')}</b></div>
                <div><span>RSI יומי</span><b class="${rsiCls(v.rsiD, 30, 70)}">${v.rsiD ?? '—'}</b></div>
                <div><span>RSI שבועי</span><b class="${rsiCls(v.rsiW, 30, 70)}">${v.rsiW ?? '—'}</b></div>
            </div>
            ${maRow('ממוצע 200 יום', v.ma && v.ma.d200dist)}
            ${maRow('ממוצע 300 יום', v.ma && v.ma.d300dist)}
            ${maRow('ממוצע 200 שבועות', v.ma && v.ma.w200dist)}
            ${maRow('ממוצע 300 שבועות', v.ma && v.ma.w300dist)}
            ${fvgRow('FVG חודשי', v.fvgM)}
            ${fvgRow('FVG רבעוני', v.fvgQ)}
            <div class="msheet-kv"><span>ATR יומי</span><b>${v.atrPct != null ? v.atrPct + '%' : '—'}</b></div>
            <div class="msheet-kv"><span>נפח · ממוצע 20 יום</span><b>${_fmtVol(v.vol)} · ${_fmtVol(v.volAvg)}</b></div>
            <a class="msheet-tv" href="${_esc(d.tv)}" target="_blank" rel="noopener">פתח גרף מלא ב-TradingView ↗</a>
            <div class="msheet-note">✓ ליד ממוצע = בטווח ±${d.nearPct || 3}% מהממוצע · FVG = פער שווי הוגן פתוח</div>`;
        openSheet(_esc(d.disp) + ' · ניתוח מלא', html);
    }
    document.addEventListener('click', (e) => {
        if (!MQ.matches) return;
        const tr = e.target.closest && e.target.closest('#techTable tbody tr[data-sym]');
        if (!tr || (e.target.closest && e.target.closest('a'))) return;
        openTechSheet(tr.getAttribute('data-sym'));
    });

    function boot() {
        sweep(document);
        mo.observe(document.body, { childList: true, subtree: true });
        MQ.addEventListener('change', () => { if (MQ.matches) sweep(document); else { expandAll(); unfoldExposure(); unrailAll(); } });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
