// ========== LHE PAGE — Liquidity Hydrodynamic Engine ==========
// A full routed PAGE (not a popup) — mirrors the reports/technical pages: it takes over the
// dashboard content area (#lhePage.active) instead of floating as an overlay. Displays the
// lhe_signals produced by the 24/7 LHE Agent (Supabase, read-only here — RLS allows SELECT;
// only the agent writes). Shows the global liquidity state (HPI), the asset-conduit ranking,
// and per-asset confluence cards. Auto-refreshes 24/7 while the page is open.

let _lheTimer = null;
let _lheSig = '';
let _lheLoaded = false;
const LHE_CACHE = 'lhe_signals_v1';

// ── Open as a page: hide the dashboard chrome, show #lhePage (same pattern as openReportsPage) ──
function openLHEPage() {
    const page = document.getElementById('lhePage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'lhePage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('lhe');
    if (typeof updateURLState === 'function') updateURLState({ view: 'lhe' });

    _lheRenderShell();
    window.scrollTo(0, 0);
    _lheLoad();
    if (_lheTimer) clearInterval(_lheTimer);
    _lheTimer = setInterval(() => { if (document.getElementById('lheBody')) _lheLoad(); }, 120000);
}

function closeLHEPage() {
    const page = document.getElementById('lhePage');
    if (_lheTimer) { clearInterval(_lheTimer); _lheTimer = null; }
    if (!page) return;
    page.classList.remove('active');
    page.innerHTML = '';
    const header = document.querySelector('.header');
    if (header) header.style.display = '';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { el.style.display = ''; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = '';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
}
// Back-compat aliases (older callers / history popstate).
if (typeof window !== 'undefined') {
    window.openLHEPage = openLHEPage; window.closeLHEPage = closeLHEPage;
    window.openLHE = openLHEPage; window.closeLHE = closeLHEPage;
}

function _lheRenderShell() {
    const page = document.getElementById('lhePage');
    if (!page) return;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">מנוע הנזילות ההידרודינמי</h1>
            <button class="macro-back-btn" onclick="closeLHEPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="lhe-intro">
                <p class="lhe-subtitle">מודל תלת-שכבתי: לחץ נזילות מאקרו (HPI) → תעלות הולכה לנכסים (רגישות) → כבידת אזורי חוסר-יעילות בגרף (FVG). הנכסים הגלובליים המרכזיים, מתעדכן אוטומטית 24/7.</p>
                <button class="lhe-refresh" onclick="_lheLoad(true)" title="רענן">⟳ רענן</button>
            </div>
            <div class="lhe-body" id="lheBody"><div class="lhe-loading">טוען מנוע נזילות…</div></div>
        </div>
    </div>`;
}

async function _lheLoad(force) {
    const body = document.getElementById('lheBody');
    if (!body) return;
    if (force) { body.innerHTML = '<div class="lhe-loading">מרענן…</div>'; _lheSig = ''; }
    // Instant paint from cache while the fresh fetch is in flight.
    if (!force && body.querySelector('.lhe-loading')) {
        try {
            const c = JSON.parse(localStorage.getItem(LHE_CACHE) || 'null');
            if (c && Array.isArray(c.rows) && c.rows.length) { body.innerHTML = _lheBuildHTML(c.rows, c.status); _lheLoaded = true; }
        } catch (e) { /* ignore */ }
    }
    let rows = null, status = null;
    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('no supabase client');
        const [sigRes, stRes] = await Promise.all([
            supabaseClient.from('lhe_signals').select('*'),
            supabaseClient.from('agent_status').select('*').eq('agent', 'lhe').maybeSingle(),
        ]);
        if (sigRes.error) throw sigRes.error;
        rows = sigRes.data || [];
        status = stRes && stRes.data ? stRes.data : null;
    } catch (e) {
        if (!_lheLoaded) body.innerHTML = `<div class="lhe-empty">שגיאה בטעינת מנוע הנזילות. נסה לרענן בעוד רגע.<br><small>${(e && e.message) || ''}</small></div>`;
        return;
    }
    if (!rows.length) {
        body.innerHTML = _lheStatusHTML(status) + `<div class="lhe-empty">🌊 הסוכן מאתחל — אין עדיין סיגנלים.<br>ברגע שהמנוע יחשב את מצב הנזילות, הסיגנלים יופיעו כאן אוטומטית.</div>`;
        _lheSig = '';
        return;
    }
    // Signature on the DISPLAYED values (not updated_at) — so the body re-renders ONLY when the
    // shown data actually changes, never just because the agent re-stamped updated_at. Prevents the
    // periodic full re-render that made the page "jump".
    const sig = rows.map(r => {
        const mf = (r.payload && r.payload.macroFit) ? r.payload.macroFit.verdict : '';
        return `${r.ticker}:${r.bias}:${Math.round(+r.confluence_score || 0)}:${r.hpi_score}:${r.regime}:${r.net_liquidity_flow}:${mf}`;
    }).join('|');
    if (!force && sig === _lheSig) {
        const sEl = document.getElementById('lheStatus');
        if (sEl) sEl.outerHTML = _lheStatusHTML(status); // tiny, height-stable status refresh only
        return;
    }
    _lheSig = sig;
    _lheLoaded = true;
    const _scrollY = window.scrollY;                     // preserve scroll across the rebuild
    body.innerHTML = _lheBuildHTML(rows, status);
    if (window.scrollY !== _scrollY) window.scrollTo(0, _scrollY);
    try { localStorage.setItem(LHE_CACHE, JSON.stringify({ rows, status })); } catch (e) { /* quota */ }
}

function _lheEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _lheRel(ts, future) {
    if (!ts) return ''; const d = new Date(ts); if (isNaN(d)) return '';
    let s = Math.round((future ? d.getTime() - Date.now() : Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 60) return future ? 'בעוד רגע' : 'ממש עכשיו';
    const m = Math.round(s / 60); if (m < 60) return (future ? 'בעוד ' : 'לפני ') + m + ' דק׳';
    const h = Math.round(m / 60); if (h < 24) return (future ? 'בעוד ' : 'לפני ') + h + ' שע׳';
    return (future ? 'בעוד ' : 'לפני ') + Math.round(h / 24) + ' ימים';
}

const _LHE_REGIME = {
    flood: { he: 'הצפת נזילות', cls: 'lhe-pos' },
    expansion: { he: 'התרחבות נזילות', cls: 'lhe-pos' },
    neutral: { he: 'נזילות מאוזנת', cls: 'lhe-neu' },
    drain: { he: 'ניקוז נזילות', cls: 'lhe-neg' },
    drought: { he: 'בצורת נזילות', cls: 'lhe-neg' },
};
function _lheRegime(r) { return _LHE_REGIME[r] || { he: r || '—', cls: 'lhe-neu' }; }
function _lheBiasMeta(bias) {
    if (bias === 'bullish') return { arrow: '▲', he: 'תרחיש עולה', cls: 'lhe-pos' };
    if (bias === 'bearish') return { arrow: '▼', he: 'תרחיש יורד', cls: 'lhe-neg' };
    return { arrow: '◆', he: 'מעורב', cls: 'lhe-neu' };
}
function _lheSevCls(sev) { return sev === 'critical' ? 'lhe-sev-crit' : sev === 'high' ? 'lhe-sev-high' : sev === 'elevated' ? 'lhe-sev-elev' : 'lhe-sev-info'; }

// Live "agent is computing" heartbeat line.
function _lheStatusHTML(st) {
    const last = st && st.last_run ? new Date(st.last_run) : null;
    const live = !!last && (Date.now() - last.getTime() < 3 * 3600 * 1000);
    const label = live ? 'המנוע פעיל ומחשב נזילות 24/7' : (last ? 'המנוע לא דיווח לאחרונה — בודק' : 'ממתין לחישוב ראשון מהמנוע');
    const bits = [];
    if (last) bits.push(`חישוב אחרון ${_lheRel(st.last_run, false)}`);
    if (st && st.next_run) bits.push(`הבא ${_lheRel(st.next_run, true)}`);
    const note = st && st.last_result ? `<div class="lhe-status-note">↳ ${_lheEsc(st.last_result)}</div>` : '';
    return `<div class="lhe-meta-bar" id="lheStatus">
        <div class="lhe-status-line"><span class="lhe-live ${live ? 'lhe-live-on' : 'lhe-live-warn'}"></span><b>${label}</b></div>
        <div class="lhe-status-sub">${bits.join(' · ')}</div>${note}
    </div>`;
}

// The global liquidity state panel (HPI gauge + net-liq + conduit ranking).
function _lheMacroHTML(m) {
    const reg = _lheRegime(m.regime);
    const score = Math.round(+m.hpi_score || 0);
    const delta = +m.hpi_delta || 0;
    const dArrow = delta > 1 ? '▲' : delta < -1 ? '▼' : '▬';
    const dCls = delta > 1 ? 'lhe-pos' : delta < -1 ? 'lhe-neg' : 'lhe-neu';
    const flow = +m.net_liquidity_flow || 0;

    return `<div class="lhe-macro">
        <div class="lhe-macro-top">
            <div class="lhe-gauge">
                <div class="lhe-gauge-head">
                    <span class="lhe-gauge-lbl">מדד הלחץ ההידראולי (HPI)</span>
                    <span class="lhe-regime ${reg.cls}">${reg.he}</span>
                </div>
                <div class="lhe-gauge-bar"><span class="lhe-gauge-marker" style="left:calc(${score}% - 2px)"></span></div>
                <div class="lhe-gauge-foot">
                    <span class="lhe-gauge-score ${reg.cls}">${score}<small>/100</small></span>
                    <span class="lhe-gauge-delta ${dCls}">${dArrow} מומנטום ${delta > 0 ? '+' : ''}${delta}</span>
                </div>
            </div>
            <div class="lhe-flow">
                <div class="lhe-flow-lbl">זרימת נזילות-נטו</div>
                <div class="lhe-flow-val ${flow >= 0 ? 'lhe-pos' : 'lhe-neg'}">${flow >= 0 ? '+' : '−'}$${Math.abs(flow).toFixed(0)}<small>מיליארד</small></div>
                <div class="lhe-flow-sub">בנקים מרכזיים − TGA − RRP</div>
            </div>
        </div>
        ${m.body ? `<div class="lhe-macro-body">${_lheEsc(m.body)}</div>` : ''}
        ${_lheConditionsHTML(m.payload && m.payload.conditions)}
    </div>`;
}

// ── Asset sensitivity heatmap — the REDESIGNED "conduit ranking". Clear & explained:
//    bar LENGTH = β (sensitivity to liquidity), bar COLOR = does the macro favor it now. ──
function _lheSensitivityHTML(assets) {
    if (!assets || !assets.length) return '';
    const sorted = assets.slice().sort((a, b) => (+b.liquidity_beta || 0) - (+a.liquidity_beta || 0));
    const maxBeta = Math.max(...sorted.map(a => +a.liquidity_beta || 0), 1);
    const rows = sorted.map(a => {
        const beta = +a.liquidity_beta || 0;
        const w = Math.max(7, Math.round(beta / maxBeta * 100));
        const fit = (a.payload && a.payload.macroFit) || {};
        const v = fit.verdict;
        const barCls = v === 'tailwind' ? 'lhe-bar-up' : v === 'headwind' ? 'lhe-bar-down' : 'lhe-bar-flat';
        const txtCls = v === 'tailwind' ? 'lhe-pos' : v === 'headwind' ? 'lhe-neg' : '';
        const fitTxt = v === 'tailwind' ? '✓ המאקרו תומך' : v === 'headwind' ? '✕ המאקרו מנוגד' : '◆ המאקרו ניטרלי';
        const sens = beta < 0.8 ? 'רגישות נמוכה · נכס מגן' : beta <= 1.3 ? 'רגישות בינונית' : 'רגישות גבוהה · אגרסיבי';
        const reason = fit.reason ? _lheEsc(fit.reason) : '';
        return `<div class="lhe-sens-row">
            <span class="lhe-sens-tk">${_lheEsc(a.ticker)}</span>
            <div class="lhe-sens-main">
                <span class="lhe-sens-track"><span class="lhe-sens-bar ${barCls}" style="width:${w}%"></span><span class="lhe-sens-beta">β ${beta.toFixed(1)}</span></span>
                <span class="lhe-sens-meta">${sens} · <span class="${txtCls}">${fitTxt}</span>${reason ? ` <span class="lhe-sens-reason">· ${reason}</span>` : ''}</span>
            </div>
        </div>`;
    }).join('');
    return `<div class="lhe-sens">
        <div class="lhe-sens-title">📊 רגישות הנכסים לנזילות — ומה המאקרו עושה לכל אחד</div>
        <div class="lhe-sens-legend">
            <div><b>אורך הפס = β (רגישות לנזילות):</b> כמה הנכס מגיב לכל שינוי בנזילות הגלובלית. <b>נמוך</b> = יציב/מגן (זהב, אג״ח); <b>גבוה</b> = אגרסיבי ומתנדנד (קריפטו, מניות).</div>
            <div><b>צבע הפס = האם המאקרו תומך בנכס כרגע:</b> <span class="lhe-leg lhe-bar-up">תומך (רוח גבית)</span> <span class="lhe-leg lhe-bar-down">מנוגד (רוח נגדית)</span> <span class="lhe-leg lhe-bar-flat">ניטרלי</span>.</div>
        </div>
        <div class="lhe-sens-rows">${rows}</div>
    </div>`;
}

// Broad liquidity factors — every input feeding the HPI (white text + colored direction arrow).
function _lheConditionsHTML(c) {
    if (!c) return '';
    const arrow = (good) => good === true ? '<span class="lhe-cond-arrow lhe-pos">▲</span>' : good === false ? '<span class="lhe-cond-arrow lhe-neg">▼</span>' : '';
    const chip = (label, val, good) => `<span class="lhe-cond">${label}: <b>${val}</b>${arrow(good)}</span>`;
    const items = [];
    if (c.nfci != null) items.push(chip('תנאים פיננסיים (NFCI)', (+c.nfci).toFixed(2), c.nfci < 0));
    if (c.cpi != null) items.push(chip('אינפלציה (CPI שנתי)', (+c.cpi).toFixed(1) + '%', c.cpi < 2.5));
    if (c.hyOAS != null) items.push(chip('מרווח אשראי HY', (+c.hyOAS).toFixed(2) + '%', c.hyOAS < 3.5));
    if (c.vix != null) items.push(chip('VIX', (+c.vix).toFixed(1), c.vix < 18));
    if (c.m2Growth != null) items.push(chip('M2 שנתי', (c.m2Growth >= 0 ? '+' : '') + (+c.m2Growth).toFixed(1) + '%', c.m2Growth > 0));
    if (c.dollarChange != null) items.push(chip('שינוי דולר רחב', (c.dollarChange >= 0 ? '+' : '') + (+c.dollarChange).toFixed(2), c.dollarChange < 0));
    if (c.reservesDelta != null) items.push(chip('Δ רזרבות בנקים', (c.reservesDelta >= 0 ? '+' : '') + Math.round(c.reservesDelta) + 'B$', c.reservesDelta > 0));
    return items.length ? `<div class="lhe-cond-title">גורמי נזילות נוספים (כל מה שמזין את המודל)</div><div class="lhe-conds">${items.join('')}</div>` : '';
}

// ── Squarified treemap (Bruls et al.) — keeps tiles close to square ────────────
function _lheWorst(areas, len) {
    let s = 0, mn = Infinity, mx = 0;
    for (const a of areas) { s += a; if (a < mn) mn = a; if (a > mx) mx = a; }
    if (s <= 0) return Infinity;
    const l2 = len * len, s2 = s * s;
    return Math.max(l2 * mx / s2, s2 / (l2 * mn));
}
function _lheSquarify(items, x, y, w, h) {
    const total = items.reduce((s, i) => s + i.value, 0);
    const out = [];
    if (total <= 0 || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total;
    const nodes = items.map(i => ({ ref: i.ref, area: Math.max(1e-9, i.value * scale) }));
    let rx = x, ry = y, rw = w, rh = h, i = 0;
    while (i < nodes.length) {
        const shorter = Math.min(rw, rh);
        let row = [nodes[i]], areas = [nodes[i].area], j = i + 1, cur = _lheWorst(areas, shorter);
        while (j < nodes.length) {
            const test = areas.concat(nodes[j].area);
            const wst = _lheWorst(test, shorter);
            if (wst <= cur) { row.push(nodes[j]); areas = test; cur = wst; j++; } else break;
        }
        const rowArea = areas.reduce((s, a) => s + a, 0), thick = rowArea / shorter;
        if (rw >= rh) { let oy = ry; for (const n of row) { const nh = n.area / rowArea * rh; out.push({ ref: n.ref, x: rx, y: oy, w: thick, h: nh }); oy += nh; } rx += thick; rw -= thick; }
        else { let ox = rx; for (const n of row) { const nw = n.area / rowArea * rw; out.push({ ref: n.ref, x: ox, y: ry, w: nw, h: thick }); ox += nw; } ry += thick; rh -= thick; }
        i = j;
    }
    return out;
}

const _LHE_GROUPS = [
    { key: 'market', he: 'מניות', cls: 'lhe-g-market' },
    { key: 'bonds', he: 'אג"ח', cls: 'lhe-g-bonds' },
    { key: 'cash', he: 'מזומן בצד', cls: 'lhe-g-cash' },
    { key: 'other', he: 'נכסים גלובליים', cls: 'lhe-g-other' },
];

// Liquidity MAP — a Finviz-style TREEMAP: every money pool is a rectangle sized by its
// $T, grouped by asset class, colored by group, flagged 🇺🇸 US vs 🌍 global.
function _lheMapHTML(m) {
    const map = m && m.payload && m.payload.liquidityMap;
    if (!map || !Array.isArray(map.pools) || !map.pools.length) return '';
    const W = 1000, H = 600, HEADER = 24;
    const groups = _LHE_GROUPS
        .map(g => { const pools = map.pools.filter(p => p.group === g.key); return { he: g.he, cls: g.cls, pools, value: pools.reduce((s, p) => s + (+p.valueT || 0), 0) }; })
        .filter(g => g.pools.length);
    const gRects = _lheSquarify(groups.map(g => ({ ref: g, value: g.value })), 0, 0, W, H);
    const tiles = [];
    gRects.forEach(gr => {
        const g = gr.ref;
        tiles.push({ type: 'group', he: g.he, cls: g.cls, value: g.value, x: gr.x, y: gr.y, w: gr.w, h: Math.min(HEADER, gr.h) });
        const innerY = gr.y + HEADER, innerH = Math.max(0, gr.h - HEADER);
        const sorted = g.pools.slice().sort((a, b) => (+b.valueT || 0) - (+a.valueT || 0));
        _lheSquarify(sorted.map(p => ({ ref: p, value: Math.max(0.02, +p.valueT || 0) })), gr.x, innerY, gr.w, innerH)
            // Clamp every pool tile strictly inside its group's inner box so a tiny tile (e.g. RRP)
            // can never spill over a neighbouring group's header.
            .forEach(r => {
                const x = Math.max(gr.x, r.x), y = Math.max(innerY, r.y);
                const w = Math.max(0, Math.min(r.w, gr.x + gr.w - x)), h = Math.max(0, Math.min(r.h, innerY + innerH - y));
                tiles.push({ type: 'pool', ref: r.ref, cls: g.cls, x, y, w, h });
            });
    });
    const html = tiles.map(t => {
        const style = `left:${(t.x / W * 100).toFixed(2)}%;top:${(t.y / H * 100).toFixed(2)}%;width:${(t.w / W * 100).toFixed(2)}%;height:${(t.h / H * 100).toFixed(2)}%`;
        if (t.type === 'group') return `<div class="lhe-tm-group ${t.cls}" style="${style}"><span class="lhe-tm-ghead">${_lheEsc(t.he)} · $${t.value.toFixed(0)}T</span></div>`;
        const p = t.ref;
        const arr = p.dir === 'up' ? '▲' : p.dir === 'down' ? '▼' : '';
        const scope = p.scope === 'global' ? '🌍' : '🇺🇸';
        const ultra = t.w < 28 || t.h < 16;        // sliver (e.g. RRP) → color + tooltip only
        const low = !ultra && t.h < 64;            // short tile → name + value on one line (compact)
        const name = _lheEsc(p.short || p.label);
        const title = `${_lheEsc(p.label)} — $${+p.valueT}T (${p.scope === 'global' ? 'גלובלי' : 'ארה״ב'})`;
        if (ultra) return `<div class="lhe-tm-tile lhe-tm-${p.dir || 'flat'} lhe-tm-ultra" style="${style}" title="${title}"></div>`;
        return `<div class="lhe-tm-tile lhe-tm-${p.dir || 'flat'}${low ? ' lhe-tm-low' : ''}" style="${style}" title="${title}">
            <span class="lhe-tm-scope">${scope}</span>
            <span class="lhe-tm-name">${name}</span>
            <span class="lhe-tm-val">$${+p.valueT}T ${arr}</span>
        </div>`;
    }).join('');
    return `<div class="lhe-map">
        <div class="lhe-map-title">🗺️ מפת נזילות — איפה נמצא הכסף (גודל המלבן = היקף)</div>
        <div class="lhe-map-sub">מזומן בצד: <b>$${map.cashSidelinesT}T</b> &nbsp;·&nbsp; 🇺🇸 ארה"ב &nbsp; 🌍 גלובלי &nbsp;·&nbsp; ▲/▼ כיוון תנועה &nbsp;·&nbsp; 🟢 חי / ~ אומדן</div>
        <div class="lhe-treemap">${html}</div>
    </div>`;
}

function _lheFitMeta(fit) {
    const v = fit && fit.verdict;
    if (v === 'tailwind') return { cls: 'lhe-fit-tailwind', icon: '✓', short: 'מאקרו תומך' };
    if (v === 'headwind') return { cls: 'lhe-fit-headwind', icon: '✕', short: 'מאקרו מנוגד' };
    return { cls: 'lhe-fit-neutral', icon: '◆', short: 'מאקרו ניטרלי' };
}

function _lheToggle(id) {
    const el = document.getElementById('lhe-card-' + id);
    if (el) el.classList.toggle('collapsed');
}
if (typeof window !== 'undefined') window._lheToggle = _lheToggle;

function _lheCardHTML(c) {
    const id = _lheEsc(String(c.ticker || Math.random().toString(36).slice(2)));
    const bias = _lheBiasMeta(c.bias);
    const conf = Math.round(+c.confluence_score || 0);
    const beta = (+c.liquidity_beta || 0).toFixed(2);
    const attr = Math.round(+c.attraction_score || 0);
    const sevCls = _lheSevCls(c.severity);
    const flags = Array.isArray(c.flags) ? c.flags : [];
    const t = c.target;
    const p = c.payload || {};
    const ss = p.structureShift;
    const fit = p.macroFit;
    const fitMeta = _lheFitMeta(fit);

    const flagChips = flags.map(f => `<span class="lhe-flag">${_lheEsc(_lheFlagHe(f))}</span>`).join('');
    const targetHTML = (t && t.zone) ? `
        <div class="lhe-target">
            <span class="lhe-target-lbl">🎯 יעד שאיבה (FVG)</span>
            <span class="lhe-target-zone">${(+t.zone[0]).toFixed(2)} – ${(+t.zone[1]).toFixed(2)}</span>
            <span class="lhe-target-meta">מילוי ${Math.round((+t.fillProbability || 0) * 100)}% · ~${t.expectedBarsToFill} ברים</span>
        </div>` : '';
    const ssHTML = (ss && ss.detected) ? `<span class="lhe-flag lhe-flag-mss">${ss.type === 'MSS' ? 'היפוך מבנה' : 'פריצת מבנה'} ${ss.direction === 'bullish' ? '▲' : '▼'}</span>` : '';
    // macro + momentum shown as clearly-labelled INPUTS feeding the one thesis (no contradiction).
    const mom = (p.momentum20d != null) ? +p.momentum20d : null;
    const momCls = mom > 1 ? 'lhe-pos' : mom < -1 ? 'lhe-neg' : '';
    const macroWord = fit ? (fit.verdict === 'tailwind' ? 'תומך' : fit.verdict === 'headwind' ? 'מנוגד' : 'ניטרלי') : '—';
    const macroCls = fit ? (fit.verdict === 'tailwind' ? 'lhe-pos' : fit.verdict === 'headwind' ? 'lhe-neg' : '') : '';

    return `
    <div class="lhe-card collapsed ${bias.cls}" id="lhe-card-${id}">
        <div class="lhe-card-head" onclick="_lheToggle('${id}')">
            <div class="lhe-card-head-l">
                <span class="lhe-caret">▸</span>
                <span class="lhe-card-bias ${bias.cls}">${bias.arrow}</span>
                <div class="lhe-card-id">
                    <span class="lhe-card-tk">${_lheEsc(c.ticker)}</span>
                    <span class="lhe-card-name">${_lheEsc(c.name || '')}</span>
                </div>
            </div>
            <div class="lhe-card-head-r">
                <span class="lhe-thesis-chip ${bias.cls}">${bias.arrow} ${bias.he}</span>
                <span class="lhe-conf ${sevCls}">שכנוע ${conf}</span>
            </div>
        </div>
        <div class="lhe-card-body">
            <div class="lhe-stats">
                <div class="lhe-stat"><span class="lhe-stat-v">${beta}</span><span class="lhe-stat-l">רגישות (β)</span></div>
                <div class="lhe-stat"><span class="lhe-stat-v ${momCls}">${mom != null ? (mom >= 0 ? '+' : '') + mom.toFixed(1) + '%' : '—'}</span><span class="lhe-stat-l">מומנטום 20י׳</span></div>
                <div class="lhe-stat"><span class="lhe-stat-v ${macroCls}">${macroWord}</span><span class="lhe-stat-l">מאקרו</span></div>
            </div>
            ${(flagChips || ssHTML) ? `<div class="lhe-flags">${ssHTML}${flagChips}</div>` : ''}
            ${c.body ? `<div class="lhe-card-narrative">${_lheEsc(c.body)}</div>` : ''}
            ${targetHTML}
            ${(typeof openTechnicalForTicker === 'function' || typeof openReportForTicker === 'function') ? `
            <div class="lhe-card-actions">
                ${typeof openTechnicalForTicker === 'function' ? `<button class="lhe-act" onclick="openTechnicalForTicker('${_lheEsc(c.ticker)}')">📈 ניתוח טכני</button>` : ''}
                ${typeof openReportForTicker === 'function' ? `<button class="lhe-act" onclick="openReportForTicker('${_lheEsc(c.ticker)}')">📄 דוחות</button>` : ''}
            </div>` : ''}
        </div>
    </div>`;
}

function _lheFlagHe(f) {
    const map = {
        MSS_BULLISH: 'היפוך מבנה עולה', MSS_BEARISH: 'היפוך מבנה יורד',
        MACRO_FVG_CONFLUENCE: 'התלכדות מאקרו–FVG', HIGH_CONDUIT_ATTRACTION: 'משיכת הון גבוהה',
        HIGH_LIQUIDITY_BETA: 'רגישות נזילות גבוהה', MACRO_FLOOD: 'הצפת נזילות', MACRO_DROUGHT: 'בצורת נזילות',
    };
    return map[f] || f;
}

function _lheBuildHTML(rows, status) {
    const macro = rows.find(r => r.kind === 'macro' || r.ticker === '_MACRO');
    const assets = rows.filter(r => r.kind !== 'macro' && r.ticker !== '_MACRO')
        .sort((a, b) => (+b.confluence_score || 0) - (+a.confluence_score || 0));
    return _lheStatusHTML(status) +
        (macro ? _lheMacroHTML(macro) : '') +
        (macro ? _lheMapHTML(macro) : '') +
        _lheSensitivityHTML(assets) +
        (assets.length ? `<div class="lhe-cards-title">סיגנלים לפי נכס — ${assets.length} נכסים</div><div class="lhe-cards">${assets.map(_lheCardHTML).join('')}</div>` : '');
}
