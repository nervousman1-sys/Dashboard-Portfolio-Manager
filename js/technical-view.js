// ========== TECHNICAL ANALYSIS PAGE — ניתוח טכני למניות ==========
//
// Smart scanner over every S&P 500 + Nasdaq-100 stock (~516 tickers):
//   RSI(14) daily+weekly, SMA 200/300 days + 200/300 weeks (with ±3% "near" mark),
//   monthly + quarterly FVG (price inside an unfilled gap), ATR(14), volume.
// Filter chips: RSI<40, oversold/overbought (weekly), near-MA, in-FVG; search box;
// a TradingView button per stock for verification. Scan cached per day.

const _TECH_NEAR_PCT = 3;            // "near MA" = within ±3%
const _TECH_LS_KEY = 'tech_scan_v2';

let _techData = null;                // { TICKER: {...indicators} }
let _techFilter = 'all';
let _techSearch = '';
let _techLoading = false;

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
    try { localStorage.removeItem(_TECH_LS_KEY); } catch (e) { }
    _techData = null;
    _techLoad(true);
}

// ── Load: daily cache → otherwise batch-scan all constituents with progress ──
async function _techLoad(force) {
    if (_techLoading) return;
    const today = new Date().toISOString().slice(0, 10);
    if (!force) {
        try {
            const raw = localStorage.getItem(_TECH_LS_KEY);
            if (raw) {
                const c = JSON.parse(raw);
                if (c && c.day === today && c.data && Object.keys(c.data).length > 100) {
                    _techData = c.data;
                    _techRender();
                    return;
                }
            }
        } catch (e) { /* rescan */ }
    }

    _techLoading = true;
    const prog = document.getElementById('techProgress');
    const fill = document.getElementById('techProgressFill');
    const txt = document.getElementById('techProgressTxt');
    if (prog) prog.style.display = '';

    try {
        const tr = await fetch('/api/technicals?mode=tickers', { headers: { Accept: 'application/json' } });
        const tj = await tr.json();
        if (!tj.tickers || !tj.tickers.length) throw new Error('no tickers');
        const tickers = tj.tickers;
        if (txt) txt.textContent = `סורק ${tickers.length} מניות (S&P 500 + Nasdaq-100)…`;

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
                    const r = await fetch(`/api/technicals?mode=scan&symbols=${b.join(',')}&d=${today}`, { headers: { Accept: 'application/json' } });
                    const j = await r.json();
                    if (j.results) Object.assign(data, j.results);
                } catch (e) { /* skip failed batch */ }
                done++;
                const pct = Math.round(done / batches.length * 100);
                if (fill) fill.style.width = pct + '%';
                if (txt) txt.textContent = `סורק ${tickers.length} מניות… ${pct}%`;
            }));
            _techData = data;
            _techRender(); // progressive render as batches land
        }
        try { localStorage.setItem(_TECH_LS_KEY, JSON.stringify({ day: today, data })); } catch (e) { /* full */ }
    } catch (e) {
        const tbl = document.getElementById('techTable');
        if (tbl && !_techData) tbl.innerHTML = '<div class="adv-empty">הסריקה נכשלה — נסה שוב בעוד רגע.</div>';
    } finally {
        _techLoading = false;
        if (prog && _techData && Object.keys(_techData).length > 100) prog.style.display = 'none';
    }
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
    { id: 'near_d200', label: '200 יום', test: v => v.ma.d200dist != null && Math.abs(v.ma.d200dist) <= _TECH_NEAR_PCT },
    { id: 'near_d300', label: '300 יום', test: v => v.ma.d300dist != null && Math.abs(v.ma.d300dist) <= _TECH_NEAR_PCT },
    { id: 'near_w200', label: '200 שבועות', test: v => v.ma.w200dist != null && Math.abs(v.ma.w200dist) <= _TECH_NEAR_PCT },
    { id: 'near_w300', label: '300 שבועות', test: v => v.ma.w300dist != null && Math.abs(v.ma.w300dist) <= _TECH_NEAR_PCT },
    { id: 'fvgm', label: 'בתוך FVG חודשי', test: v => v.fvgM && v.fvgM.inside },
    { id: 'fvgq', label: 'בתוך FVG רבעוני', test: v => v.fvgQ && v.fvgQ.inside },
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

    const body = rows.slice(0, 250).map(([t, v]) => `
        <tr>
            <td class="risk-td-name">
                <div class="tech-name-cell">
                    <span>${t}</span>
                    <a class="tech-tv" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(t)}" target="_blank" rel="noopener" title="פתח גרף ב-TradingView לאימות">TradingView ↗</a>
                </div>
            </td>
            <td>$${(v.price ?? 0).toLocaleString('en-US')}</td>
            <td>${rsiDCell(v)}</td>
            <td>${rsiWChip(v)}</td>
            ${maCell(v.ma.d200dist)}${maCell(v.ma.d300dist)}${maCell(v.ma.w200dist)}${maCell(v.ma.w300dist)}
            ${fvgCell(v.fvgM)}${fvgCell(v.fvgQ)}
            <td>${v.atrPct != null ? v.atrPct + '%' : '—'}</td>
            <td title="ממוצע 20 ימים: ${fmtVol(v.volAvg)}">${fmtVol(v.vol)}</td>
        </tr>`).join('');

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
    window._techRescan = _techRescan;
    window._techRender = _techRender;
}
