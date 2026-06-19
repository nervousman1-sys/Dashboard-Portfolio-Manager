// ========== FINANCIAL REPORTS PAGE — ניתוח דוחות כספיים ==========
//
// Master-detail page over every stock in the platform (US: S&P 500 + Nasdaq-100,
// IL: TA-125). The list is a cheap searchable directory (tickers only — no API
// cost); a full report is fetched ON DEMAND when a company is opened, because the
// FMP free key is ~250 calls/day. Opened companies' scores are cached in
// localStorage so the list can show their chip without re-fetching.
//
// Data: /api/reports (normalized financials) → ReportsEngine.buildReport (metrics,
// risk flags, score, "השתפרה" verdict) → rendered here. SWOT + strategy in Hebrew
// come from /api/report-ai (Gemini), loaded async into the detail view.

const _REP_MKT = {
    us: { ls: 'rep_uni_us_v3', cur: '$', label: 'מניות (S&P 500 + Nasdaq-100)', search: 'חיפוש מניה (למשל: NVDA)…' },
    il: { ls: 'rep_uni_il_v3', cur: '₪', label: 'מניות (ת"א-125)', search: 'חיפוש מניה (למשל: TEVA)…' },
};
const _REP_SCORES_LS = 'rep_scores_v1';

let _repMarket = 'us';
let _repUniverse = { us: null, il: null };
let _repSectors = { us: null, il: null };  // { ticker: GICS sector (English) }
let _repSearch = '';

// GICS sector → Hebrew label (for grouping the board).
const _REP_SECTOR_HE = {
    'Crypto': 'קריפטו',
    'Information Technology': 'טכנולוגיית מידע',
    'Health Care': 'בריאות',
    'Financials': 'פיננסים',
    'Consumer Discretionary': 'צריכה מחזורית',
    'Consumer Staples': 'מוצרי צריכה בסיסיים',
    'Communication Services': 'שירותי תקשורת',
    'Industrials': 'תעשייה',
    'Energy': 'אנרגיה',
    'Utilities': 'תשתיות וחשמל',
    'Real Estate': 'נדל"ן',
    'Materials': 'חומרי גלם',
    // ── Israeli TA-125 sector labels (exact Wikipedia strings → Hebrew) ──
    'Banks': 'בנקים',
    'Insurance': 'ביטוח',
    'Financial Services': 'שירותים פיננסיים',
    'Investment & Holdings': 'השקעות ואחזקות',
    'Investment in hi-tech': 'השקעות בהייטק',
    'Real-Estate & Construction': 'נדל"ן ובנייה',
    'Construction': 'בנייה',
    'Internet And Software': 'אינטרנט ותוכנה',
    'IT Services': 'שירותי IT',
    'Semiconductors': 'מוליכים למחצה',
    'Electronics And Optics': 'אלקטרוניקה ואופטיקה',
    'Electronics & Optics': 'אלקטרוניקה ואופטיקה',
    'Communications Equipment': 'ציוד תקשורת',
    'Communications & Media': 'תקשורת ומדיה',
    'Biomed': 'ביומד',
    'Medical Equipment': 'ציוד רפואי',
    'Pharmaceuticals': 'פארמה',
    'Energy': 'אנרגיה',
    'Cleantech': 'קלינטק',
    'Food': 'מזון',
    'Services - Commerce': 'מסחר ושירותים',
    'Commerce': 'מסחר',
    'Services': 'שירותים',
    'Fashion & Clothing': 'אופנה והלבשה',
    'Hotels & Tourism': 'מלונאות ותיירות',
    'Metal & Building Products': 'מתכת ומוצרי בנייה',
    'Chemical, Rubber & Plastic': 'כימיה, גומי ופלסטיק',
    'Wood & Paper': 'עץ ונייר',
    'Industry - Wood & Paper': 'תעשייה — עץ ונייר',
    'Defense': 'ביטחון',
};
const _REP_SECTOR_ORDER = ['Information Technology', 'Communication Services', 'Health Care', 'Financials', 'Consumer Discretionary', 'Consumer Staples', 'Industrials', 'Energy', 'Utilities', 'Real Estate', 'Materials', 'Crypto',
    // IL TA-125 sectors (by prevalence)
    'Banks', 'Insurance', 'Financial Services', 'Investment & Holdings', 'Real-Estate & Construction', 'Construction',
    'Internet And Software', 'IT Services', 'Semiconductors', 'Electronics And Optics', 'Communications Equipment', 'Communications & Media',
    'Biomed', 'Medical Equipment', 'Cleantech', 'Energy', 'Food', 'Services - Commerce', 'Commerce', 'Services',
    'Fashion & Clothing', 'Hotels & Tourism', 'Metal & Building Products', 'Chemical, Rubber & Plastic', 'Defense'];
let _repView = 'list';        // 'list' | 'detail'
let _repCurrent = null;       // current detail model
let _repCharts = [];          // live Chart.js instances to destroy on teardown
let _repChartCtx = null;      // { m, cur } for the enlarge modal
let _repBigChart = null;      // Chart.js instance inside the enlarge modal

// Trend charts shown in the detail view (each is clickable to enlarge).
const _REP_CHARTS = [
    { key: 'revenue', canvas: 'repChartRev', title: 'הכנסות', color: 'rgba(56,189,248,0.85)' },
    { key: 'netIncome', canvas: 'repChartNi', title: 'רווח נקי', color: 'rgba(132,204,22,0.85)' },
    { key: 'ebitda', canvas: 'repChartEbitda', title: 'EBITDA', color: 'rgba(250,204,21,0.85)' },
    { key: 'fcf', canvas: 'repChartFcf', title: 'תזרים חופשי (FCF)', color: 'rgba(168,85,247,0.85)' },
];

function openReportsPage() {
    const page = document.getElementById('reportsPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'reportsPage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('reports');

    // Restore market + open company from the URL (refresh / back-forward keep you here).
    const params = new URLSearchParams(window.location.search);
    const urlMkt = (params.get('mkt') || '').toLowerCase();
    const urlSym = (params.get('sym') || '').toUpperCase();
    _repMarket = _REP_MKT[urlMkt] ? urlMkt : 'us';
    _repView = 'list';
    _repSearch = ''; // always reopen on the full list, never a stale search filter
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: urlSym || null });

    _repRenderShell();
    document.querySelectorAll('#repMkt .tech-mkt-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-mkt') === _repMarket));
    const search = document.getElementById('repSearch');
    if (search) search.placeholder = _REP_MKT[_repMarket].search;
    window.scrollTo(0, 0);
    _repLoadUniverse();
    if (urlSym) openReportDetail(urlSym); // _repRenderList is a no-op while in detail view
}

function closeReportsPage() {
    const page = document.getElementById('reportsPage');
    if (!page) return;
    _repDestroyCharts();
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

// ── List shell (toolbar + container) ──
function _repRenderShell() {
    const page = document.getElementById('reportsPage');
    if (!page) return;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">ניתוח דוחות כספיים</h1>
            <button class="macro-back-btn" onclick="closeReportsPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="risk-table-card glass-card">
                <div class="tech-toolbar">
                    <div class="tech-mkt" id="repMkt">
                        <button class="tech-mkt-btn active" data-mkt="us" onclick="setRepMarket('us')">ארה״ב</button>
                        <button class="tech-mkt-btn" data-mkt="il" onclick="setRepMarket('il')">ישראל</button>
                    </div>
                    <input type="text" id="repSearch" class="tech-search" autocomplete="off"
                           placeholder="${_REP_MKT.us.search}"
                           oninput="_repSearch=this.value.toUpperCase().trim(); _repRenderList()" />
                </div>
                <div id="repBody"><div class="adv-empty">טוען רשימת חברות…</div></div>
                <div class="tech-foot">דו"ח נמשך בלחיצה על חברה · היסטוריה של עד 8 רבעונים · נתונים מתעדכנים אוטומטית מהדוח האחרון שהוגש · ציון 0–100 משוקלל מרווחיות, צמיחה, איתנות, תזרים ומומנטום</div>
            </div>
        </div>
    </div>`;
}

function setRepMarket(mkt) {
    if (!_REP_MKT[mkt] || mkt === _repMarket) return;
    _repMarket = mkt;
    _repView = 'list';
    _repSearch = '';
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: null });
    _repRenderShell();
    const search = document.getElementById('repSearch');
    if (search) { search.placeholder = _REP_MKT[mkt].search; }
    document.querySelectorAll('#repMkt .tech-mkt-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-mkt') === mkt));
    _repLoadUniverse();
}

// ── Universe = ticker directory from the existing technicals endpoint (no FMP cost) ──
async function _repLoadUniverse() {
    const mkt = _repMarket;
    const cfg = _REP_MKT[mkt];
    if (_repUniverse[mkt]) { _repRenderList(); return; }
    try {
        const raw = localStorage.getItem(cfg.ls);
        if (raw) {
            const c = JSON.parse(raw);
            if (c && c.day === new Date().toISOString().slice(0, 10) && Array.isArray(c.tickers) && c.tickers.length && c.sectors) {
                _repUniverse[mkt] = c.tickers; _repSectors[mkt] = c.sectors || null; _repRenderList(); return;
            }
        }
    } catch (e) { /* refetch */ }
    try {
        // IL: stocksOnly=1 → real TA-125 companies only (no index-tracking ETFs/funds,
        // which have no financial statements and would never get a score).
        const url = `/api/technicals?mode=tickers&market=${mkt}&sv=2` + (mkt === 'il' ? '&stocksOnly=1' : '');
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        let tickers = (j.tickers || []).slice();
        tickers.sort((a, b) => a.localeCompare(b));
        _repUniverse[mkt] = tickers;
        _repSectors[mkt] = j.sectors || null;
        try { localStorage.setItem(cfg.ls, JSON.stringify({ day: new Date().toISOString().slice(0, 10), tickers, sectors: j.sectors || null })); } catch (e) { }
        if (_repMarket === mkt && _repView === 'list') _repRenderList();
    } catch (e) {
        const body = document.getElementById('repBody');
        if (body && _repMarket === mkt) body.innerHTML = '<div class="adv-empty">טעינת רשימת החברות נכשלה — נסה שוב בעוד רגע.</div>';
    }
}

function _repScoreCache() { try { return JSON.parse(localStorage.getItem(_REP_SCORES_LS) || '{}'); } catch (e) { return {}; } }
function _repSaveScore(symbol, info) {
    try { const m = _repScoreCache(); m[symbol] = { ...info, ts: Date.now() }; localStorage.setItem(_REP_SCORES_LS, JSON.stringify(m)); } catch (e) { }
}

function _repScoreClass(v) {
    if (v == null) return '';
    if (v >= 80) return 'rep-score-excellent';
    if (v >= 65) return 'rep-score-good';
    if (v >= 50) return 'rep-score-mid';
    if (v >= 35) return 'rep-score-weak';
    return 'rep-score-bad';
}

// ── List of company cards (search-filtered, capped) ──
function _repRenderList() {
    if (_repView !== 'list') return;
    const body = document.getElementById('repBody');
    const uni = _repUniverse[_repMarket];
    if (!body) return;
    if (!uni) { body.innerHTML = '<div class="adv-empty">טוען רשימת חברות…</div>'; return; }

    const scores = _repScoreCache();
    let list = uni.filter(t => !_repSearch || t.includes(_repSearch));
    const total = list.length;
    // Show the full universe (S&P 500 ∪ Nasdaq-100 ≈ 514, or TA-125) — ~hundreds of
    // lightweight buttons render fine; a report is only fetched when one is clicked.
    const CAP = 2000;
    list = list.slice(0, CAP);

    const cardHtml = (t) => {
        const disp = _repMarket === 'il' ? t.replace(/\.TA$/, '') : t;
        const s = scores[t];
        const chip = (s && s.score != null)
            ? `<span class="rep-card-score ${_repScoreClass(s.score)}" data-rep-score="${t}">${s.score}</span>`
            : `<span class="rep-card-score rep-card-score-empty" data-rep-score="${t}">—</span>`;
        const beat = (s && s.improved) ? '<span class="rep-card-beat" title="שיפור מול תקופה קודמת">▲</span>' : '';
        return `<button class="rep-card" onclick="openReportDetail('${t}')">
            <span class="rep-card-ticker">${disp}<span class="rep-card-beat-slot" data-rep-beat="${t}">${beat}</span></span>
            ${chip}
        </button>`;
    };

    const sectorMap = _repSectors[_repMarket];
    let listHtml;
    if (sectorMap && Object.keys(sectorMap).length) {
        // Group by sector → sections, ordered by the canonical sector order; unknown last.
        const groups = {};
        list.forEach(t => { const sec = sectorMap[t] || '__other'; (groups[sec] = groups[sec] || []).push(t); });
        const order = [..._REP_SECTOR_ORDER.filter(s => groups[s]), ...Object.keys(groups).filter(s => s !== '__other' && !_REP_SECTOR_ORDER.includes(s)).sort()];
        if (groups['__other']) order.push('__other');
        listHtml = order.map(sec => {
            const he = sec === '__other' ? 'אחר' : (_REP_SECTOR_HE[sec] || sec);
            const cards = groups[sec].map(cardHtml).join('');
            return `<div class="rep-sector-group">
                <div class="rep-sector-head">${he} <span class="rep-sector-count">${groups[sec].length}</span></div>
                <div class="rep-grid">${cards}</div>
            </div>`;
        }).join('');
        if (!list.length) listHtml = `<div class="adv-empty">אין חברות שתואמות "${_repSearch}".</div>`;
    } else {
        listHtml = `<div class="rep-grid">${list.map(cardHtml).join('') || `<div class="adv-empty">אין חברות שתואמות "${_repSearch}".</div>`}</div>`;
    }

    body.innerHTML = `
        ${listHtml}
        ${total ? `<div class="tech-foot">${total > CAP ? `מוצגות ${CAP} מתוך ${total} — חדד את החיפוש.` : `${total} חברות`}${sectorMap ? ' · מסודרות לפי סקטור' : ''} · הציונים נטענים אוטומטית ברקע</div>` : ''}`;

    _repPrefetchScores(); // fill the board's score chips in the background (free Yahoo source)
}

// ── Background score fill — fetch reports for un-scored tickers (throttled), so the
// board shows scores without the user opening each one. Uses the free Yahoo path
// (fast=1) to avoid burning the FMP daily quota; results cached in localStorage. ──
let _repPrefetchToken = 0;
async function _repPrefetchScores() {
    const market = _repMarket;
    const uni = _repUniverse[market];
    if (!uni || !uni.length) return;
    const myToken = ++_repPrefetchToken; // cancels any prefetch from a previous list/market
    const TTL = 3 * 24 * 3600 * 1000;    // refresh scores older than 3 days (rolling updates)
    const now = Date.now();
    const scores = _repScoreCache();
    const todo = uni.filter(t => { const s = scores[t]; return !s || s.score == null || (now - (s.ts || 0) > TTL); });
    if (!todo.length) return;

    let idx = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
        while (idx < todo.length) {
            if (myToken !== _repPrefetchToken || _repView !== 'list' || _repMarket !== market) return;
            const t = todo[idx++];
            try {
                const r = await fetch(`/api/technicals?mode=report&symbol=${encodeURIComponent(t)}&market=${market}&fast=1`, { headers: { Accept: 'application/json' } });
                if (r.ok) {
                    const rep = await r.json();
                    const model = ReportsEngine.buildReport(rep);
                    if (model.score && model.score.value != null) {
                        _repSaveScore(t, { score: model.score.value, improved: model.beat && model.beat.improved });
                        if (myToken === _repPrefetchToken && _repView === 'list' && _repMarket === market) _repUpdateCardChip(t, model.score.value, model.beat && model.beat.improved);
                    }
                }
            } catch (e) { /* skip — try the next ticker */ }
            await new Promise(res => setTimeout(res, 140)); // gentle on the data source
        }
    };
    for (let w = 0; w < CONCURRENCY; w++) worker();
}

function _repUpdateCardChip(symbol, score, improved) {
    const chip = document.querySelector(`[data-rep-score="${symbol}"]`);
    if (chip) { chip.className = `rep-card-score ${_repScoreClass(score)}`; chip.textContent = score; }
    if (improved) {
        const slot = document.querySelector(`[data-rep-beat="${symbol}"]`);
        if (slot && !slot.innerHTML) slot.innerHTML = '<span class="rep-card-beat" title="שיפור מול תקופה קודמת">▲</span>';
    }
}

// ── Detail: fetch report on demand → engine → render ──
async function openReportDetail(symbol) {
    _repView = 'detail';
    _repDestroyCharts();
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: symbol });
    const body = document.getElementById('repBody');
    if (body) body.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div><span>טוען דו"ח עבור ${symbol.replace(/\.TA$/, '')}…</span></div>`;

    try {
        const r = await fetch(`/api/technicals?mode=report&symbol=${encodeURIComponent(symbol)}&market=${_repMarket}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            const msg = r.status === 429 ? 'מכסת ה-API היומית נוצלה — נסה שוב מאוחר יותר.'
                : r.status === 404 ? 'לא נמצאו נתונים פונדמנטליים לחברה זו.'
                : 'משיכת הדו"ח נכשלה.';
            if (body) body.innerHTML = `<div class="adv-empty">${msg}<br><button class="macro-back-btn" style="margin-top:12px" onclick="backToReportsList()">חזרה לרשימה</button></div>`;
            return;
        }
        const report = await r.json();
        const model = ReportsEngine.buildReport(report);
        _repCurrent = model;
        if (model.score && model.score.value != null) _repSaveScore(symbol, { score: model.score.value, improved: model.beat && model.beat.improved });
        _repRenderDetail(model);
        _repLoadAI(model); // async SWOT + strategy
    } catch (e) {
        if (body) body.innerHTML = `<div class="adv-empty">שגיאה בטעינת הדו"ח.<br><button class="macro-back-btn" style="margin-top:12px" onclick="backToReportsList()">חזרה לרשימה</button></div>`;
    }
}

function backToReportsList() {
    _repView = 'list';
    _repDestroyCharts();
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: null });
    _repRenderList();
}

// Open the financial-reports analysis for a specific ticker from anywhere (e.g. the
// portfolio recommendation cards). Closes any open overlays first, then deep-links
// into the report detail for that company.
function openReportForTicker(ticker) {
    const sym = String(ticker || '').trim().toUpperCase();
    if (!sym) return;
    // Suppress intermediate history writes so this whole hop adds ONE entry (the report),
    // and Back returns to exactly the page the user came from.
    if (typeof window !== 'undefined' && typeof window._navSuppressURL === 'function') window._navSuppressURL(true);
    try {
        if (typeof closeStockRecommendations === 'function') closeStockRecommendations();
        if (typeof closeDiscordNews === 'function' && document.getElementById('discordNewsPage')?.classList.contains('active')) closeDiscordNews();
        if (typeof closeTechnicalPage === 'function' && document.getElementById('technicalPage')?.classList.contains('active')) closeTechnicalPage();
        const mo = document.getElementById('modalOverlay');
        if (mo && mo.classList.contains('active')) {
            mo.classList.remove('active');
            if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
            try { currentModalClientId = null; } catch (e) { }
        }
        if (typeof openReportsPage === 'function') openReportsPage();
        _repMarket = sym.endsWith('.TA') ? 'il' : 'us';
        openReportDetail(sym);
    } finally {
        if (typeof window !== 'undefined' && typeof window._navSuppressURL === 'function') window._navSuppressURL(false);
    }
    // One clean history entry for this navigation.
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym });
}

// Return to the FULL company list, clearing any active search (used by the sidebar
// button so it always lands on the complete list, never a stale filtered view).
function _repToList() {
    _repSearch = '';
    const search = document.getElementById('repSearch');
    if (search) search.value = '';
    backToReportsList();
}

// Reconcile the reports page's internal state to the URL — called by the central
// history handler on Back/Forward so the browser's back button moves detail→list
// (and list→detail) without leaving the reports page. updateURLState is a no-op
// while the navigator is restoring, so this never pushes new history entries.
function _repSyncToURL() {
    const page = document.getElementById('reportsPage');
    if (!page || !page.classList.contains('active')) return;
    const params = new URLSearchParams(window.location.search);
    const sym = (params.get('sym') || '').toUpperCase();
    const mkt = (params.get('mkt') || '').toLowerCase();
    if (mkt && _REP_MKT[mkt] && mkt !== _repMarket) {
        // Market changed via history — rebuild the shell for that market.
        _repMarket = mkt;
        _repView = 'list';
        _repRenderShell();
        document.querySelectorAll('#repMkt .tech-mkt-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-mkt') === mkt));
        const search = document.getElementById('repSearch'); if (search) search.placeholder = _REP_MKT[mkt].search;
        _repLoadUniverse();
    }
    if (sym) {
        if (_repView !== 'detail' || !_repCurrent || _repCurrent.symbol !== sym) openReportDetail(sym);
    } else if (_repView !== 'list') {
        backToReportsList();
    }
}

// ── Formatting helpers ──
function _repFmtMoney(v, cur) {
    if (v == null || isNaN(v)) return '—';
    const s = cur || '$';
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}${s}${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}${s}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${s}${(abs / 1e3).toFixed(1)}K`;
    return `${sign}${s}${abs.toFixed(0)}`;
}
function _repFmtPct(v, withSign) {
    if (v == null || isNaN(v)) return '—';
    const p = v * 100;
    return `${withSign && p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}
function _repFmtRatio(v, d) {
    if (v == null || isNaN(v)) return '—';
    return v.toFixed(d == null ? 2 : d);
}
function _repDeltaClass(v) { return v == null || isNaN(v) ? '' : (v > 0 ? 'rep-up' : (v < 0 ? 'rep-down' : '')); }

// ── Detail render ──
function _repRenderDetail(m) {
    const body = document.getElementById('repBody');
    if (!body) return;
    const cur = m.currency === 'USD' ? '$' : (m.currency === 'ILS' ? '₪' : (m.currency ? m.currency + ' ' : '$'));
    const rows = m.rows.slice(0, 4); // up to 4 latest quarters in the table
    const score = m.score || {};
    const scoreCls = _repScoreClass(score.value);

    const qHead = rows.map(q => `<th>${_repQuarterLabel(q)}</th>`).join('');

    const metricRow = (label, fmt, key, deltaKey, hint) => {
        // Skip a row entirely when the metric is empty across ALL shown quarters
        // (e.g. banks have no gross profit / EBITDA / current ratio) — so every
        // visible table is full rather than peppered with "—".
        const hasAny = rows.some(q => q[key] != null && !(typeof q[key] === 'number' && isNaN(q[key])));
        if (!hasAny) return '';
        const cells = rows.map(q => {
            const val = fmt(q[key]);
            const d = deltaKey ? q[deltaKey] : null;
            const dTxt = d != null ? `<span class="rep-delta ${_repDeltaClass(d)}" title="שינוי לעומת הרבעון המקביל אשתקד (YoY)">${_repFmtPct(d, true)} <span class="rep-delta-ref">אשתקד</span></span>` : '';
            return `<td>${val}${dTxt}</td>`;
        }).join('');
        return `<tr><td class="rep-metric-name">${label}${hint ? `<span class="rep-hint" title="${hint}">ⓘ</span>` : ''}</td>${cells}</tr>`;
    };

    const fmM = (v) => _repFmtMoney(v, cur);
    const fmP = (v) => _repFmtPct(v);
    const fmR = (v) => _repFmtRatio(v);
    const fmE = (v) => v == null || isNaN(v) ? '—' : `${cur}${v.toFixed(2)}`;

    // Beat badge + flags
    const beatBadge = m.beat && m.beat.improved
        ? `<span class="rep-badge rep-badge-beat">✓ ${m.beat.label}</span>`
        : `<span class="rep-badge rep-badge-flat">${m.beat ? m.beat.label : '—'}</span>`;

    const flagsHtml = (m.flags && m.flags.length)
        ? m.flags.map(f => `<div class="rep-flag rep-flag-${f.severity}"><span class="rep-flag-dot"></span>${f.he}</div>`).join('')
        : '<div class="rep-flag rep-flag-ok"><span class="rep-flag-dot"></span>לא זוהו דגלי סיכון מהותיים בנתוני הדו"ח.</div>';

    const v = m.valuation || {};
    // Skip a key-figure card when its value couldn't be computed (renders as "—").
    const keyFig = (label, val) => (val == null || val === '—') ? '' : `<div class="rep-keyfig"><span class="rep-keyfig-label">${label}</span><span class="rep-keyfig-val">${val}</span></div>`;

    // Key points (deterministic highlights from the numbers).
    const kp = Array.isArray(m.keyPoints) ? m.keyPoints : [];
    const keyPointsHtml = kp.length
        ? kp.map(p => `<li class="rep-kp rep-kp-${p.tone}"><span class="rep-kp-dot"></span>${p.he}</li>`).join('')
        : '<li class="rep-kp rep-kp-neutral"><span class="rep-kp-dot"></span>אין מספיק נתונים להפקת נקודות מפתח.</li>';

    body.innerHTML = `
    <div class="rep-detail" dir="rtl">
        <div class="rep-detail-top">
            <button class="macro-back-btn" onclick="backToReportsList()">→ חזרה לרשימה</button>
        </div>

        <div class="rep-head">
            <div class="rep-head-id">
                <div class="rep-head-name">${m.companyName || m.symbol}</div>
                <div class="rep-head-sub">${m.symbol.replace(/\.TA$/, '')}${m.sector ? ' · ' + m.sector : ''}${m.asOf ? ' · דוח אחרון: ' + m.asOf : ''}</div>
                <div class="rep-head-badges">${beatBadge}${m.source === 'yahoo' ? '<span class="rep-badge rep-badge-src">מקור: Yahoo</span>' : ''}</div>
            </div>
            <div class="rep-score-box ${scoreCls}">
                <div class="rep-score-num">${score.value != null ? score.value : '—'}</div>
                <div class="rep-score-label">${score.verdict || ''}</div>
                <div class="rep-score-cap">ציון הדו"ח</div>
            </div>
        </div>

        <div class="rep-keyfigs">
            ${keyFig('שווי שוק', _repFmtMoney(m.marketCap, cur))}
            ${keyFig('מחיר', m.price != null ? `${cur}${m.price.toLocaleString('en-US')}` : '—')}
            ${keyFig('מכפיל רווח (P/E)', _repFmtRatio(v.peTrailing, 1))}
            ${keyFig('מכפיל הון (P/B)', _repFmtRatio(v.pb, 2))}
            ${keyFig('תשואה על ההון (ROE)', _repFmtPct(v.roeTTM))}
            ${keyFig('EV/EBITDA', _repFmtRatio(v.evToEbitda, 1))}
            ${keyFig('תשואת FCF', _repFmtPct(v.fcfYield))}
            ${keyFig('ביתא', _repFmtRatio(m.beta, 2))}
        </div>

        <div class="rep-section-title">סיכום קצר</div>
        <div id="repSummary" class="rep-summary"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר סיכום עסקי…</div></div>

        <div class="rep-section-title">נקודות מפתח מהדוח</div>
        <ul class="rep-keypoints">${keyPointsHtml}</ul>

        <div class="rep-section-title">דגלי סיכון</div>
        <div class="rep-flags">${flagsHtml}</div>

        ${(m.attentionNotes && m.attentionNotes.length) ? `
        <div class="rep-section-title">הערות לתשומת לב</div>
        <div class="rep-attention">
            ${m.attentionNotes.map((n, i) => `<div class="rep-attn rep-attn-${n.severity}"><span class="rep-attn-dot"></span><span>${n.he}<span class="rep-attn-why" data-attn-why="${i}"></span></span></div>`).join('')}
        </div>` : ''}

        <div class="rep-section-title">פרמטרים מרכזיים — עד 4 רבעונים</div>
        <div class="risk-table-scroll" style="max-height:none">
        <table class="risk-table rep-table">
            <thead><tr><th class="rep-metric-name">פרמטר</th>${qHead}</tr></thead>
            <tbody>
                ${metricRow('הכנסות', fmM, 'revenue', 'yoyRevenue')}
                ${metricRow('רווח גולמי', fmM, 'grossProfit')}
                ${metricRow('שולי רווח גולמי', fmP, 'grossMargin', null, 'רווח גולמי כאחוז מההכנסות')}
                ${metricRow('רווח תפעולי', fmM, 'operatingIncome')}
                ${metricRow('שולי רווח תפעולי', fmP, 'operatingMargin', null, 'רווח תפעולי כאחוז מההכנסות')}
                ${metricRow('EBITDA', fmM, 'ebitda', null, 'רווח לפני ריבית, מס, פחת והפחתות — רווחיות תפעולית-תזרימית')}
                ${metricRow('שולי EBITDA', fmP, 'ebitdaMargin', null, 'EBITDA כאחוז מההכנסות')}
                ${metricRow('רווח נקי', fmM, 'netIncome', 'yoyNetIncome')}
                ${metricRow('שולי רווח נקי', fmP, 'netMargin', null, 'רווח נקי כאחוז מההכנסות')}
                ${metricRow('רווח למניה (EPS)', fmE, 'eps', 'yoyEps')}
                ${metricRow('הון עצמי', fmM, 'totalEquity')}
                ${metricRow('סך התחייבויות', fmM, 'totalLiabilities')}
                ${metricRow('חוב נטו', fmM, 'netDebt', null, 'סך החוב פחות מזומן ושווי-מזומן (ערך שלילי = עודף מזומן)')}
                ${metricRow('הון חוזר', fmM, 'workingCapital', null, 'נכסים שוטפים פחות התחייבויות שוטפות')}
                ${metricRow('יחס שוטף', fmR, 'currentRatio', null, 'נכסים שוטפים / התחייבויות שוטפות')}
                ${metricRow('תשואה על ההון (ROE)', fmP, 'roe', null, 'רווח נקי רבעוני חלקי ההון העצמי')}
                ${metricRow('מינוף (חוב/הון)', fmR, 'debtToEquity')}
                ${metricRow('תזרים תפעולי', fmM, 'operatingCashFlow')}
                ${metricRow('תזרים חופשי (FCF)', fmM, 'fcf', null, 'תזרים תפעולי פחות השקעות הוניות')}
                ${metricRow('שולי FCF', fmP, 'fcfMargin', null, 'תזרים חופשי חלקי הכנסות')}
            </tbody>
        </table>
        </div>
        <div class="rep-table-legend">▲▼ האחוז הירוק/אדום (ליד הכנסות, רווח נקי ו-EPS) = שינוי לעומת הרבעון המקביל אשתקד (YoY) · שולי הרווח (גולמי, תפעולי, EBITDA, נקי, FCF) ו-ROE הם ערך הרבעון עצמו — לא שינוי.</div>

        <div class="rep-section-title">מגמות (8 רבעונים)</div>
        <div class="rep-charts">
            ${_REP_CHARTS.filter(c => m.rows.some(q => q[c.key] != null && !isNaN(q[c.key]))).map(c => `
            <div class="rep-chart-card rep-chart-clickable" onclick="_repEnlargeChart('${c.key}')" title="לחץ להגדלה">
                <div class="rep-chart-h">${c.title}<span class="rep-chart-zoom" aria-hidden="true">⤢</span></div>
                <canvas id="${c.canvas}"></canvas>
            </div>`).join('')}
        </div>

        <div class="rep-section-title">ניתוח SWOT</div>
        <div id="repSwot" class="rep-swot"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח SWOT…</div></div>

        <div class="rep-section-title">אסטרטגיה וויז'ן</div>
        <div id="repStrategy" class="rep-strategy"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח אסטרטגי…</div></div>

        <div class="rep-section-title">תלות בספקים וסיכונים גיאופוליטיים</div>
        <div id="repRisks" class="rep-strategy"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח סיכונים…</div></div>
    </div>`;

    _repRenderCharts(m, cur);
}

function _repQuarterLabel(q) {
    if (!q) return '';
    if (q.period && q.fiscalYear && q.period !== 'FY') return `${q.period} ${String(q.fiscalYear).slice(-2)}'`;
    if (q.date) return q.date.slice(0, 7);
    return q.fiscalYear || '';
}

// ── Charts: bars over up to 8 quarters (chronological) ──
function _repDestroyCharts() {
    _repCharts.forEach(c => { try { c.destroy(); } catch (e) { } });
    _repCharts = [];
    if (typeof _repCloseChartModal === 'function') _repCloseChartModal();
}
function _repBarChart(canvasId, series, color, cur) {
    const el = document.getElementById(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    if (typeof _destroyChartOnCanvas === 'function') _destroyChartOnCanvas(el);
    const ch = new Chart(el, {
        type: 'bar',
        data: {
            labels: series.map(s => s.label),
            datasets: [{ data: series.map(s => s.value), backgroundColor: color, borderRadius: 3, maxBarThickness: 26 }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => _repFmtMoney(c.parsed.y, cur) } },
            },
            scales: {
                x: { ticks: { color: '#e8edf5', font: { size: 9 } }, grid: { display: false } },
                y: { ticks: { color: '#e8edf5', font: { size: 9 }, callback: (val) => _repFmtMoney(val, cur) }, grid: { color: 'rgba(255,255,255,0.05)' } },
            },
        },
    });
    _repCharts.push(ch);
}
function _repRenderCharts(m, cur) {
    _repChartCtx = { m, cur };
    const chron = m.rows.slice().reverse(); // oldest → newest
    // Only plot quarters that actually have a value — no empty leading/gap bars.
    const mk = (key) => chron.filter(q => q[key] != null && !isNaN(q[key])).map(q => ({ label: _repQuarterLabel(q), value: q[key] }));
    _REP_CHARTS.forEach(c => _repBarChart(c.canvas, mk(c.key), c.color, cur));
}

// ── Enlarge a trend chart in a modal ──
function _repEnlargeChart(key) {
    const def = _REP_CHARTS.find(c => c.key === key);
    if (!def || !_repChartCtx) return;
    const { m, cur } = _repChartCtx;
    const chron = m.rows.slice().reverse();
    const series = chron.filter(q => q[key] != null && !isNaN(q[key])).map(q => ({ label: _repQuarterLabel(q), value: q[key] }));

    _repCloseChartModal();
    const ov = document.createElement('div');
    ov.id = 'repChartModal';
    ov.className = 'rep-chart-modal';
    ov.innerHTML = `
      <div class="rep-chart-modal-box" dir="rtl">
        <div class="rep-chart-modal-head">
          <span class="rep-chart-modal-title">${def.title} · ${m.companyName || m.symbol}</span>
          <button class="rep-chart-modal-x" onclick="_repCloseChartModal()" aria-label="סגור">✕</button>
        </div>
        <div class="rep-chart-modal-canvas"><canvas id="repChartBig"></canvas></div>
        <div class="rep-chart-modal-foot">8 רבעונים אחרונים · ${def.title}</div>
      </div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) _repCloseChartModal(); });
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';

    const el = document.getElementById('repChartBig');
    if (el && typeof Chart !== 'undefined') {
        _repBigChart = new Chart(el, {
            type: 'bar',
            data: { labels: series.map(s => s.label), datasets: [{ data: series.map(s => s.value), backgroundColor: def.color, borderRadius: 4, maxBarThickness: 64 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => _repFmtMoney(c.parsed.y, cur) } } },
                scales: {
                    x: { ticks: { color: '#e8edf5', font: { size: 13 } }, grid: { display: false } },
                    y: { ticks: { color: '#e8edf5', font: { size: 13 }, callback: (val) => _repFmtMoney(val, cur) }, grid: { color: 'rgba(255,255,255,0.06)' } },
                },
            },
        });
    }
    document.addEventListener('keydown', _repChartModalEsc);
}
function _repCloseChartModal() {
    if (_repBigChart) { try { _repBigChart.destroy(); } catch (e) { } _repBigChart = null; }
    const ov = document.getElementById('repChartModal');
    if (ov) ov.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _repChartModalEsc);
}
function _repChartModalEsc(e) { if (e.key === 'Escape') _repCloseChartModal(); }

// ── AI SWOT + strategy (async, fills the placeholders) ──
// `attempt` drives an automatic client-side retry: Gemini's transient 503 (model
// overloaded) is common, so a single failure self-heals after a short wait instead of
// leaving the user with a dead "try again later" message.
async function _repLoadAI(m, attempt) {
    attempt = attempt || 0;
    const summaryEl = document.getElementById('repSummary');
    const swotEl = document.getElementById('repSwot');
    const stratEl = document.getElementById('repStrategy');
    const risksEl = document.getElementById('repRisks');
    // Guard: if the user navigated away (different report open), abort.
    const stillHere = () => document.getElementById('repSummary') === summaryEl && summaryEl;
    try {
        const ctx = ReportsEngine.aiContext(m);
        const r = await fetch('/api/vision?mode=swot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: m.symbol, company: m.companyName, sector: m.sector, context: ctx }),
        });
        const j = await r.json();
        if (!r.ok || j.error || !j.swot) throw new Error(j.message || 'ai failed');
        if (!stillHere()) return;
        if (summaryEl) summaryEl.innerHTML = _repSummaryHtml(j.summary || {});
        if (swotEl) swotEl.innerHTML = _repSwotHtml(j.swot);
        if (stratEl) stratEl.innerHTML = _repStrategyHtml(j.strategy || {});
        if (risksEl) risksEl.innerHTML = _repRisksHtml(j.risks || {});
        // Fill each attention-note with its intelligent, company-specific explanation.
        const exps = Array.isArray(j.declineExplanations) ? j.declineExplanations : [];
        document.querySelectorAll('[data-attn-why]').forEach(el => {
            const i = parseInt(el.getAttribute('data-attn-why'), 10);
            if (exps[i]) el.textContent = ' — ' + exps[i];
        });
    } catch (e) {
        if (!stillHere()) return;
        // Auto-retry transient failures (Gemini 503 overload) up to 2 more times.
        if (attempt < 2) {
            const wait = 3500 * (attempt + 1);
            const note = `<div class="rep-ai-loading"><div class="rep-spinner"></div>שרת ה-AI עמוס כרגע — מנסה שוב…</div>`;
            if (summaryEl) summaryEl.innerHTML = note;
            if (swotEl) swotEl.innerHTML = '';
            if (stratEl) stratEl.innerHTML = '';
            if (risksEl) risksEl.innerHTML = '';
            setTimeout(() => { if (stillHere()) _repLoadAI(m, attempt + 1); }, wait);
            return;
        }
        const msg = '<div class="adv-empty">ניתוח ה-AI אינו זמין כעת (שרת ג\'מיני עמוס זמנית — לא חריגת מכסה). נסה לרענן בעוד דקה.</div>';
        if (summaryEl) summaryEl.innerHTML = msg;
        if (swotEl) swotEl.innerHTML = '';
        if (stratEl) stratEl.innerHTML = '';
        if (risksEl) risksEl.innerHTML = '';
    }
}
// Short business summary: activity sector, growth/hurt divisions, decline reasons,
// investments, key customers, recent deals, and recent insider activity.
function _repSummaryHtml(s) {
    s = s || {};
    // dot: 'up' → green, 'down' → red, '' → none.
    const row = (label, txt, dot) => txt
        ? `<div class="rep-sum-row"><span class="rep-sum-label">${dot ? `<span class="rep-sum-dot rep-sum-dot-${dot}"></span>` : ''}${label}</span><span class="rep-sum-val">${txt}</span></div>`
        : '';
    const growth = s.growthDivision || s.mainGrowthDivision;  // back-compat with older field name
    const hurtTxt = s.hurtDivision || '';
    // A "not hurt" answer shouldn't get a red dot — only flag red when a segment truly declined.
    const hurtIsNeg = hurtTxt && !/לא נפגע|אין סגמנט|לא זוהה|יציב|צומח/.test(hurtTxt);
    const html = [
        row('סקטור ותחום פעילות', s.activitySector),
        row('ענף שצומח', growth, 'up'),
        row('ענף שנפגע', hurtTxt, hurtIsNeg ? 'down' : ''),
        row('סיבות לירידה ברווחיות/תזרים', s.declineReasons),
        row('השקעות מרכזיות', s.investments),
        row('מיקוד המחקר והפיתוח (לאיזו חטיבה)', s.rdFocus),
        row('שותפויות אסטרטגיות', s.partnerships),
        row('לקוחות ושווקים מרכזיים', s.keyCustomers),
        row('חוזים ועסקאות גדולות לאחרונה', s.recentDeals),
        row('עסקאות בעלי עניין (בעיקר קניות)', s.insiderActivity),
    ].join('');
    return html || '<div class="adv-empty">לא נוצר סיכום.</div>';
}
function _repRisksHtml(rk) {
    rk = rk || {};
    const part = (label, txt) => txt ? `<div class="rep-strat-part"><span class="rep-strat-label">${label}</span><p>${txt}</p></div>` : '';
    const html = `${part('תלות בספקים ובלקוחות', rk.supplierDependency)}${part('חשיפה גיאופוליטית', rk.geopolitical)}`;
    return html || '<div class="adv-empty">לא זוהו סיכוני ספקים/גיאופוליטיקה מהותיים.</div>';
}
function _repList(items) {
    if (!Array.isArray(items) || !items.length) return '<li class="rep-swot-empty">—</li>';
    return items.map(x => `<li>${String(x)}</li>`).join('');
}
function _repSwotHtml(s) {
    s = s || {};
    return `
    <div class="rep-swot-quad rep-swot-s"><div class="rep-swot-h">חוזקות</div><ul>${_repList(s.strengths)}</ul></div>
    <div class="rep-swot-quad rep-swot-w"><div class="rep-swot-h">חולשות</div><ul>${_repList(s.weaknesses)}</ul></div>
    <div class="rep-swot-quad rep-swot-o"><div class="rep-swot-h">הזדמנויות</div><ul>${_repList(s.opportunities)}</ul></div>
    <div class="rep-swot-quad rep-swot-t"><div class="rep-swot-h">איומים</div><ul>${_repList(s.threats)}</ul></div>`;
}
function _repStrategyHtml(st) {
    st = st || {};
    const part = (label, txt) => txt ? `<div class="rep-strat-part"><span class="rep-strat-label">${label}</span><p>${txt}</p></div>` : '';
    const partners = Array.isArray(st.keyPartnerships) && st.keyPartnerships.length
        ? `<div class="rep-strat-part"><span class="rep-strat-label">שותפויות אסטרטגיות</span><ul class="rep-strat-partners">${st.keyPartnerships.map(p => `<li>${p}</li>`).join('')}</ul></div>`
        : '';
    return `${part("ויז'ן", st.vision)}${part('התקדמות לעבר היעד', st.progressToward)}${partners}${part('מבט קדימה', st.outlook)}`;
}

if (typeof window !== 'undefined') {
    window.openReportsPage = openReportsPage;
    window.closeReportsPage = closeReportsPage;
    window.setRepMarket = setRepMarket;
    window._repRenderList = _repRenderList;
    window.openReportDetail = openReportDetail;
    window.backToReportsList = backToReportsList;
    window._repEnlargeChart = _repEnlargeChart;
    window._repCloseChartModal = _repCloseChartModal;
    window._repSyncToURL = _repSyncToURL;
    window._repToList = _repToList;
    window.openReportForTicker = openReportForTicker;
}
