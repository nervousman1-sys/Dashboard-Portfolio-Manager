// ========== TECHNICAL ANALYSIS PAGE — ניתוח טכני למניות ==========
//
// Smart scanner over every S&P 500 + Nasdaq-100 stock (~516 tickers):
//   RSI(14) daily+weekly, SMA 200/300 days + 200/300 weeks (with ±3% "near" mark),
//   monthly + quarterly FVG (price inside an unfilled gap), ATR(14), volume.
// Filter chips: RSI<40, oversold/overbought (weekly), near-MA, in-FVG; search box;
// a TradingView button per stock for verification. Scan cached per day.

const _TECH_NEAR_PCT = 3;            // "near MA" = within ±3%
// Two markets: US (S&P 500 + Nasdaq-100) and IL (TA-125 + index-tracking ETFs)
const _TECH_MKT = {
    us: { ls: 'tech_scan_v3', min: 100, cur: '$', scanLabel: 'מניות (S&P 500 + Nasdaq-100)' },
    il: { ls: 'tech_scan_il_v2', min: 40, cur: '₪', scanLabel: 'ניירות (ת"א-125 + תעודות סל)' },
};

let _techMarket = 'us';              // default — US market
let _techDataMkt = { us: null, il: null };
let _techData = null;                // alias of _techDataMkt[_techMarket]
let _techFilter = 'all';
let _techSearch = '';
let _techLoading = { us: false, il: false };

function openTechnicalPage() {
    const page = document.getElementById('technicalPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => {
        if (el.id !== 'technicalPage') el.style.display = 'none';
    });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'technical' });
    if (typeof _setActiveNav === 'function') _setActiveNav('technical');

    _techMarket = 'us'; // always open on the US market
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">ניתוח טכני למניות</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="macro-back-btn" onclick="_techRescan()">סרוק מחדש</button>
                <button class="macro-back-btn" onclick="closeTechnicalPage()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">
            <div class="risk-table-card glass-card">
                <div class="tech-toolbar">
                    <div class="tech-mkt" id="techMkt">
                        <button class="tech-mkt-btn active" data-mkt="us" onclick="setTechMarket('us')">ארה״ב</button>
                        <button class="tech-mkt-btn" data-mkt="il" onclick="setTechMarket('il')">ישראל</button>
                    </div>
                    <input type="text" id="techSearch" class="tech-search" autocomplete="off"
                           placeholder="חיפוש מניה (למשל: NVDA)…"
                           oninput="_techSearch=this.value.toUpperCase().trim(); _techRender()" />
                    <div class="tech-chips" id="techChips"></div>
                </div>
                <div id="techProgress" class="tech-progress" style="display:none">
                    <div class="tech-progress-track"><div class="tech-progress-fill" id="techProgressFill"></div></div>
                    <span id="techProgressTxt">מתחיל סריקה…</span>
                </div>
                <div class="risk-table-scroll" style="max-height:none">
                    <div id="techTable"><div class="adv-empty">טוען נתוני סריקה…</div></div>
                </div>
                <div class="tech-foot">RSI(14) · ממוצעים 200/300 יום ו-200/300 שבועות (✓ = בטווח ±${_TECH_NEAR_PCT}% מהממוצע) · FVG = פער שווי הוגן פתוח בנרות חודשיים/רבעוניים · נתוני סגירה, נסרק יומית</div>
            </div>
        </div>
    </div>`;
    window.scrollTo(0, 0);
    _techLoad();
}

function closeTechnicalPage() {
    const page = document.getElementById('technicalPage');
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

function _techRescan() {
    try { localStorage.removeItem(_TECH_MKT[_techMarket].ls); } catch (e) { }
    _techDataMkt[_techMarket] = null;
    _techData = null;
    _techLoad(true);
}

// ── Market toggle (ארה"ב / ישראל) ──
function setTechMarket(mkt) {
    if (!_TECH_MKT[mkt] || mkt === _techMarket) return;
    _techMarket = mkt;
    document.querySelectorAll('#techMkt .tech-mkt-btn').forEach(b =>
        b.classList.toggle('active', b.getAttribute('data-mkt') === mkt));
    const search = document.getElementById('techSearch');
    if (search) search.placeholder = mkt === 'il' ? 'חיפוש נייר (למשל: TEVA)…' : 'חיפוש מניה (למשל: NVDA)…';
    _techData = _techDataMkt[mkt];
    const tbl = document.getElementById('techTable');
    if (_techData) {
        _techRender();
        if (!_techLoading[mkt]) { const p = document.getElementById('techProgress'); if (p) p.style.display = 'none'; }
    } else if (tbl) {
        tbl.innerHTML = '<div class="adv-empty">טוען נתוני סריקה…</div>';
    }
    _techLoad();
}

// ── Load: daily cache → otherwise batch-scan all constituents with progress ──
async function _techLoad(force) {
    const mkt = _techMarket;
    const cfg = _TECH_MKT[mkt];
    if (_techLoading[mkt]) return;
    const today = new Date().toISOString().slice(0, 10);
    if (!force) {
        try {
            const raw = localStorage.getItem(cfg.ls);
            if (raw) {
                const c = JSON.parse(raw);
                if (c && c.day === today && c.data && Object.keys(c.data).length > cfg.min) {
                    _techDataMkt[mkt] = c.data;
                    if (_techMarket === mkt) { _techData = c.data; _techRender(); }
                    return;
                }
            }
        } catch (e) { /* rescan */ }
    }

    _techLoading[mkt] = true;
    const prog = document.getElementById('techProgress');
    const fill = document.getElementById('techProgressFill');
    const txt = document.getElementById('techProgressTxt');
    if (prog && _techMarket === mkt) prog.style.display = '';

    try {
        const tr = await fetch(`/api/technicals?mode=tickers&market=${mkt}`, { headers: { Accept: 'application/json' } });
        const tj = await tr.json();
        if (!tj.tickers || !tj.tickers.length) throw new Error('no tickers');
        const tickers = tj.tickers;
        if (txt && _techMarket === mkt) txt.textContent = `סורק ${tickers.length} ${cfg.scanLabel}…`;

        const data = {};
        const BATCH = 50;
        const batches = [];
        for (let i = 0; i < tickers.length; i += BATCH) batches.push(tickers.slice(i, i + BATCH));
        let done = 0;
        // 3 batches in flight at a time
        for (let i = 0; i < batches.length; i += 3) {
            const wave = batches.slice(i, i + 3);
            await Promise.all(wave.map(async (b) => {
                try {
                    const r = await fetch(`/api/technicals?mode=scan&symbols=${b.join(',')}&d=${today}&v=2`, { headers: { Accept: 'application/json' } });
                    const j = await r.json();
                    if (j.results) Object.assign(data, j.results);
                } catch (e) { /* skip failed batch */ }
                done++;
                const pct = Math.round(done / batches.length * 100);
                if (_techMarket === mkt) {
                    if (fill) fill.style.width = pct + '%';
                    if (txt) txt.textContent = `סורק ${tickers.length} ${cfg.scanLabel}… ${pct}%`;
                }
            }));
            _techDataMkt[mkt] = data;
            if (_techMarket === mkt) { _techData = data; _techRender(); } // progressive render as batches land
        }
        try { localStorage.setItem(cfg.ls, JSON.stringify({ day: today, data })); } catch (e) { /* full */ }
    } catch (e) {
        const tbl = document.getElementById('techTable');
        if (tbl && _techMarket === mkt && !_techData) tbl.innerHTML = '<div class="adv-empty">הסריקה נכשלה — נסה שוב בעוד רגע.</div>';
    } finally {
        _techLoading[mkt] = false;
        if (prog && _techMarket === mkt && _techData && Object.keys(_techData).length > cfg.min) prog.style.display = 'none';
    }
}

// Builds a TradingView link that opens the chart with the indicators relevant to
// THIS stock's live signals already applied — so a name that's near its 200-day MA
// AND oversold on RSI opens with BOTH the SMA(200) and the RSI study open. Routes
// through our /tv.html widget page, which reliably loads studies via URL.
function _techTvUrl(tvSym, v) {
    const m = v.ma || {};
    const near = (d) => d != null && Math.abs(d) <= _TECH_NEAR_PCT;
    const inds = [];
    let tf = 'D';
    // The moving average the price is hugging (daily preferred; else weekly → 1W chart)
    if (near(m.d200dist)) inds.push('sma200');
    else if (near(m.d300dist)) inds.push('sma300');
    else if (near(m.w200dist)) { inds.push('sma200'); tf = 'W'; }
    else if (near(m.w300dist)) { inds.push('sma300'); tf = 'W'; }
    // RSI when the stock is in an extreme (daily <40, or weekly oversold/overbought)
    if ((v.rsiD != null && v.rsiD < 40) || (v.rsiW != null && (v.rsiW < 30 || v.rsiW > 70))) inds.push('rsi');
    // FVG isn't a built-in TradingView study — the chart still opens for inspection.
    const q = `s=${encodeURIComponent(tvSym)}&tf=${tf}${inds.length ? '&ind=' + inds.join(',') : ''}`;
    return `/tv.html?${q}`;
}

// ── Predicates ──
function _tNearAnyMA(v) {
    const m = v.ma || {};
    return [m.d200dist, m.d300dist, m.w200dist, m.w300dist].some(d => d != null && Math.abs(d) <= _TECH_NEAR_PCT);
}
const _TECH_FILTERS = [
    { id: 'all', label: 'הכל', test: () => true },
    { id: 'rsi40', label: 'RSI יומי<40', test: v => v.rsiD != null && v.rsiD < 40 },
    { id: 'oversold', label: 'RSI Oversold שבועי', test: v => v.rsiW != null && v.rsiW < 30 && v.rsiD != null && v.rsiD < 30 },
    { id: 'overbought', label: 'RSI Overbought שבועי', test: v => v.rsiW != null && v.rsiW > 70 },
    { id: 'near_d200', label: 'ממוצע 200 יום', test: v => v.ma.d200dist != null && Math.abs(v.ma.d200dist) <= _TECH_NEAR_PCT },
    { id: 'near_d300', label: 'ממוצע 300 יום', test: v => v.ma.d300dist != null && Math.abs(v.ma.d300dist) <= _TECH_NEAR_PCT },
    { id: 'near_w200', label: 'ממוצע 200 שבועות', test: v => v.ma.w200dist != null && Math.abs(v.ma.w200dist) <= _TECH_NEAR_PCT },
    { id: 'near_w300', label: 'ממוצע 300 שבועות', test: v => v.ma.w300dist != null && Math.abs(v.ma.w300dist) <= _TECH_NEAR_PCT },
    { id: 'fvgm', label: 'FVG חודשי', test: v => v.fvgM && v.fvgM.inside },
    { id: 'fvgq', label: 'FVG רבעוני', test: v => v.fvgQ && v.fvgQ.inside },
];

function setTechFilter(id) {
    _techFilter = id;
    _techRender();
}

function _techRender() {
    const tbl = document.getElementById('techTable');
    const chipsEl = document.getElementById('techChips');
    if (!tbl || !_techData) return;
    const entries = Object.entries(_techData);

    // Chips with live counts
    if (chipsEl) {
        chipsEl.innerHTML = _TECH_FILTERS.map(f => {
            const n = f.id === 'all' ? entries.length : entries.filter(([, v]) => f.test(v)).length;
            return `<button class="dn-tab ${_techFilter === f.id ? 'active' : ''}" onclick="setTechFilter('${f.id}')">${f.label} <span class="dn-tab-n">${n}</span></button>`;
        }).join('');
    }

    const filter = _TECH_FILTERS.find(f => f.id === _techFilter) || _TECH_FILTERS[0];
    let rows = entries.filter(([t, v]) => filter.test(v) && (!_techSearch || t.includes(_techSearch)));

    // Relevance sort per filter
    if (_techFilter === 'rsi40' || _techFilter === 'oversold') rows.sort((a, b) => (a[1].rsiD ?? 99) - (b[1].rsiD ?? 99));
    else if (_techFilter === 'overbought') rows.sort((a, b) => (b[1].rsiW ?? 0) - (a[1].rsiW ?? 0));
    else if (_techFilter.startsWith('near_')) {
        const key = _techFilter.replace('near_', '') + 'dist';
        rows.sort((a, b) => Math.abs(a[1].ma[key] ?? 99) - Math.abs(b[1].ma[key] ?? 99));
    }
    else rows.sort((a, b) => a[0].localeCompare(b[0]));

    const maCell = (dist) => {
        if (dist == null) return '<td class="tech-na">—</td>';
        const near = Math.abs(dist) <= _TECH_NEAR_PCT;
        return `<td class="${near ? 'tech-yes' : 'tech-no'}">${near ? '✓' : '✗'} <span class="tech-dist">${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%</span></td>`;
    };
    const fvgCell = (f) => f && f.inside
        ? `<td class="tech-yes" title="פער פתוח ${f.lo}–${f.hi}">✓ בפנים</td>`
        : '<td class="tech-no">✗</td>';
    const rsiWChip = (v) => {
        if (v.rsiW == null) return '—';
        if (v.rsiW > 70) return `${v.rsiW} <span class="tech-warn ob">⚠ RSI Overbought</span>`;
        if (v.rsiW < 30) return `${v.rsiW} <span class="tech-warn os">⚠ RSI Oversold</span>`;
        return v.rsiW;
    };
    const rsiDCell = (v) => {
        if (v.rsiD == null) return '—';
        if (v.rsiD < 30) return `<span class="tech-low">${v.rsiD}</span>`;
        if (v.rsiD < 40) return `<span class="tech-mid">${v.rsiD}</span>`;
        return v.rsiD;
    };
    const fmtVol = (n) => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : n;

    const isIL = _techMarket === 'il';
    const curSym = _TECH_MKT[_techMarket].cur;
    const body = rows.slice(0, 250).map(([t, v]) => {
        const disp = isIL ? t.replace(/\.TA$/, '') : t;
        const tvSym = isIL ? `TASE:${disp}` : t;
        return `
        <tr>
            <td class="risk-td-name">
                <div class="tech-name-cell">
                    <span>${disp}</span>
                    <a class="tech-tv" href="${_techTvUrl(tvSym, v)}" target="_blank" rel="noopener" title="פתח גרף ב-TradingView עם האינדיקטורים הרלוונטיים">TradingView ↗</a>
                </div>
            </td>
            <td>${curSym}${(v.price ?? 0).toLocaleString('en-US')}</td>
            <td>${rsiDCell(v)}</td>
            <td>${rsiWChip(v)}</td>
            ${maCell(v.ma.d200dist)}${maCell(v.ma.d300dist)}${maCell(v.ma.w200dist)}${maCell(v.ma.w300dist)}
            ${fvgCell(v.fvgM)}${fvgCell(v.fvgQ)}
            <td>${v.atrPct != null ? v.atrPct + '%' : '—'}</td>
            <td title="ממוצע 20 ימים: ${fmtVol(v.volAvg)}">${fmtVol(v.vol)}</td>
        </tr>`;
    }).join('');

    tbl.innerHTML = `
        <table class="risk-table tech-table">
            <thead><tr>
                <th>מניה</th><th>מחיר</th><th>RSI יומי</th><th>RSI שבועי</th>
                <th>ממוצע 200 יום</th><th>ממוצע 300 יום</th><th>ממוצע 200 שבועות</th><th>ממוצע 300 שבועות</th>
                <th>FVG חודשי</th><th>FVG רבעוני</th><th>ATR יומי</th><th>נפח</th>
            </tr></thead>
            <tbody>${body || `<tr><td colspan="12" class="adv-empty">אין מניות שעונות על הסינון${_techSearch ? ' / החיפוש' : ''}.</td></tr>`}</tbody>
        </table>
        ${rows.length > 250 ? `<div class="tech-foot">מוצגות 250 מתוך ${rows.length} — חדד את הסינון/חיפוש.</div>` : ''}`;
}

if (typeof window !== 'undefined') {
    window.openTechnicalPage = openTechnicalPage;
    window.closeTechnicalPage = closeTechnicalPage;
    window.setTechFilter = setTechFilter;
    window.setTechMarket = setTechMarket;
    window._techRescan = _techRescan;
    window._techRender = _techRender;
}
