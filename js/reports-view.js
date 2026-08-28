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

// One tab per index. `db` = the market value the 24/7 reports-agent stores in
// company_reports (S&P 500 and Nasdaq-100 share the agent's 'us' sweep).
const _REP_MKT = {
    sp500: { ls: 'rep_uni_sp500_v1', cur: '$', label: 'מדד S&P 500', search: 'חיפוש מניה (למשל: NVDA)…', db: 'us' },
    ndx: { ls: 'rep_uni_ndx_v1', cur: '$', label: 'מדד נאסד"ק 100', search: 'חיפוש מניה (למשל: AAPL)…', db: 'us' },
    r2k: { ls: 'rep_uni_r2k_v1', cur: '$', label: 'מדד ראסל 2000', search: 'חיפוש מניה (למשל: SOFI)…', db: 'r2k' },
    il: { ls: 'rep_uni_il_v4', cur: '₪', label: 'מדד ת"א 125', search: 'חיפוש מניה (למשל: TEVA)…', db: 'il' },
};
// Legacy market ids (URLs, watchlist rows) → current tab.
const _REP_MKT_ALIAS = { us: 'sp500' };
const _REP_SCORES_LS = 'rep_scores_v1';

let _repMarket = 'sp500';
let _repUniverse = { sp500: null, ndx: null, r2k: null, il: null };
let _repSectors = { sp500: null, ndx: null, r2k: null, il: null };  // { ticker: GICS sector (English) }
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
    { key: 'revenue', canvas: 'repChartRev', title: 'הכנסות', color: 'rgba(56,189,248,0.85)', dayColor: '#0284c7' },
    { key: 'netIncome', canvas: 'repChartNi', title: 'רווח נקי', color: 'rgba(132,204,22,0.85)', dayColor: '#4d7c0f' },
    { key: 'ebitda', canvas: 'repChartEbitda', title: 'EBITDA', color: 'rgba(250,204,21,0.85)', dayColor: '#a16207' },
    { key: 'fcf', canvas: 'repChartFcf', title: 'תזרים חופשי (FCF)', color: 'rgba(168,85,247,0.85)', dayColor: '#7e22ce' },
];
// Chart chrome must follow the theme — light ticks are invisible on the day cream.
function _repChartTheme() {
    const day = typeof document !== 'undefined' && document.documentElement.classList.contains('day-mode');
    return day
        ? { tick: '#443e33', grid: 'rgba(58,50,36,0.12)' }
        : { tick: '#e8edf5', grid: 'rgba(255,255,255,0.05)' };
}
function _repChartColor(def) {
    const day = typeof document !== 'undefined' && document.documentElement.classList.contains('day-mode');
    return (day && def.dayColor) ? def.dayColor : def.color;
}

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
    _repMarket = _REP_MKT[urlMkt] ? urlMkt : (_REP_MKT_ALIAS[urlMkt] || 'sp500');
    _repView = 'list';
    _repSearch = ''; // always reopen on the full list, never a stale search filter
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: urlSym || null });

    _repRenderShell();
    document.querySelectorAll('#repMkt .tech-mkt-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-mkt') === _repMarket));
    const search = document.getElementById('repSearch');
    if (search) search.placeholder = _REP_MKT[_repMarket].search;
    window.scrollTo(0, 0);
    _repLoadUniverse();
    _repLoadIntel(); // 24/7 reports-agent freshness + "reported recently" strip
    _repLoadWatch(); // per-user watchlist bar + card stars
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
            <div class="macro-header-actions">
                <button class="macro-watch-btn" onclick="openWatchlistModal()" title="רשימת מעקב">⭐ רשימת מעקב</button>
            </div>
        </div>
        <div class="macro-content">
            <div class="risk-table-card glass-card">
                <div class="tech-toolbar">
                    <div class="tech-mkt" id="repMkt">
                        <button class="tech-mkt-btn" data-mkt="sp500" onclick="setRepMarket('sp500')">S&amp;P 500</button>
                        <button class="tech-mkt-btn" data-mkt="ndx" onclick="setRepMarket('ndx')">נאסד״ק 100</button>
                        <button class="tech-mkt-btn" data-mkt="r2k" onclick="setRepMarket('r2k')">ראסל 2000</button>
                        <button class="tech-mkt-btn" data-mkt="il" onclick="setRepMarket('il')">ת״א 125</button>
                    </div>
                    <input type="text" id="repSearch" class="tech-search" autocomplete="off"
                           placeholder="${(_REP_MKT[_repMarket] || _REP_MKT.sp500).search}"
                           oninput="_repSearch=this.value.toUpperCase().trim(); _repRenderListDebounced()" />
                    <!-- Earnings windows — LEFT end of the index-tabs bar (RTL: last = left) -->
                    <div class="rep-earn-actions">
                        <button class="qw-earn-btn" onclick="openUpcomingEarningsModal()" title="דוחות קרובים — כל המועדים הבאים">📅 דוחות קרובים</button>
                        <button class="qw-earn-btn" onclick="openRecentEarningsModal()" title="דיווחו לאחרונה — תוצאות, הכאה וסנטימנט">🆕 דיווחו לאחרונה</button>
                    </div>
                </div>
                <div id="repWatchBar" class="rep-intel"${(() => { try { return localStorage.getItem('rep_watch_has') === '1' ? ' style="min-height:40px"' : ''; } catch (e) { return ''; } })()}></div>
                <div id="repIntel" class="rep-intel"></div>
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
    _repLoadIntel();
    _repLoadWatch();
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
        const url = `/api/technicals?mode=tickers&market=${mkt}&sv=3` + (mkt === 'il' ? '&stocksOnly=1' : '');
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
// A report counts as having data only if at least one quarter carries a real core figure.
// Israeli (ת"א) coverage is partial — many TA-125 names return an empty skeleton; those are
// hidden from the list and shown a clean "no data" view instead of a page full of "—".
function _repHasData(m) {
    if (!m || !Array.isArray(m.rows) || !m.rows.length) return false;
    const CORE = ['revenue', 'netIncome', 'totalEquity', 'operatingCashFlow', 'grossProfit', 'totalLiabilities'];
    return m.rows.some(q => CORE.some(k => typeof q[k] === 'number' && !isNaN(q[k])));
}

function _repScoreClass(v) {
    if (v == null) return '';
    if (v >= 80) return 'rep-score-excellent';
    if (v >= 65) return 'rep-score-good';
    if (v >= 50) return 'rep-score-mid';
    if (v >= 35) return 'rep-score-weak';
    return 'rep-score-bad';
}

// Debounced list render for the search box — a full board rebuild per keystroke is
// heavy with ~2000 Russell-2000 cards; coalesce fast typing into one render.
let _repSearchTimer = null;
function _repRenderListDebounced() {
    if (_repSearchTimer) clearTimeout(_repSearchTimer);
    _repSearchTimer = setTimeout(() => { _repSearchTimer = null; _repRenderList(); }, 160);
}

// ── List of company cards (search-filtered, capped) ──
function _repRenderList() {
    if (_repView !== 'list') return;
    const body = document.getElementById('repBody');
    const uni = _repUniverse[_repMarket];
    if (!body) return;
    if (!uni) { body.innerHTML = '<div class="adv-empty">טוען רשימת חברות…</div>'; return; }

    _repSyncSupabaseReports(_repMarket); // pull the 24/7 reports-agent's fresh scores (once per market)
    const scores = _repScoreCache();
    // Hide Israeli (ת"א) names confirmed to have no report data — what we have nothing on
    // simply doesn't appear. US is left intact (near-full coverage).
    const hideNoData = _repMarket === 'il';
    let list = uni.filter(t => (!_repSearch || t.includes(_repSearch)) && !(hideNoData && scores[t] && scores[t].noData));
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
            <span class="rep-star ${_repWatch.has(t) ? 'on' : ''}" data-rep-star="${t}" onclick="event.stopPropagation(); _repToggleWatch('${t}')" title="הוסף / הסר ממעקב">★</span>
            <span class="rep-card-ticker">${disp}</span>
            <span class="rep-card-scoreblock"><span class="rep-card-beat-slot" data-rep-beat="${t}">${beat}</span>${chip}</span>
        </button>`;
    };

    const sectorMap = _repSectors[_repMarket];
    let listHtml;
    if (sectorMap && Object.keys(sectorMap).length) {
        // Group by sector → sections, ordered by the canonical sector order; unknown last.
        const groups = {};
        list.forEach(t => { const sec = sectorMap[t] || '__other'; (groups[sec] = groups[sec] || []).push(t); });
        // Dedupe: _REP_SECTOR_ORDER intentionally lists some sectors in both the US and IL
        // blocks (e.g. 'Energy'), which would otherwise render the same group twice.
        const order = [...new Set([..._REP_SECTOR_ORDER.filter(s => groups[s]), ...Object.keys(groups).filter(s => s !== '__other' && !_REP_SECTOR_ORDER.includes(s)).sort()])];
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

// ── Fresh scores from the 24/7 reports agent (Supabase `company_reports`) ──────────────
// The agent sweeps every company continuously, so a just-released report's updated score/beat
// lands here automatically — no need to open the company or wait for the per-ticker prefetch.
// Authoritative + fresh: overwrites the local score cache, then the on-demand prefetch only has
// to fill the few names the agent hasn't covered yet.
let _repSbSyncedAt = {};
async function _repSyncSupabaseReports(market) {
    // The agent stores by DB market ('us' covers both the S&P 500 and Nasdaq-100 tabs).
    const dbMkt = (_REP_MKT[market] && _REP_MKT[market].db) || market;
    if (Date.now() - (_repSbSyncedAt[dbMkt] || 0) < 5 * 60 * 1000) return; // re-sync at most every 5 min
    _repSbSyncedAt[dbMkt] = Date.now();
    if (typeof supabaseClient === 'undefined' || !supabaseClient) { _repSbSyncedAt[dbMkt] = 0; return; }
    try {
        // PostgREST caps a select at 1000 rows — page through (Russell 2000 has ~2000).
        let data = [];
        for (let from = 0; ; from += 1000) {
            const { data: page, error } = await supabaseClient
                .from('company_reports')
                .select('symbol,score,improved,as_of')
                .eq('market', dbMkt)
                .range(from, from + 999);
            if (error) throw error;
            data = data.concat(page || []);
            if (!page || page.length < 1000) break;
        }
        if (!data.length) { _repSbSyncedAt[dbMkt] = 0; return; }
        const cache = _repScoreCache();
        const now = Date.now();
        for (const r of data) {
            if (!r || !r.symbol) continue;
            cache[r.symbol] = { score: (r.score != null ? r.score : null), improved: !!r.improved, asOf: r.as_of || null, ts: now, src: 'agent' };
            if (r.score == null) cache[r.symbol].noData = true;
        }
        try { localStorage.setItem(_REP_SCORES_LS, JSON.stringify(cache)); } catch (e) { }
        // Live-update chips if we're still on this market's list. One DOM pass builds the
        // element maps (a per-symbol querySelector over ~2000 cards froze the r2k board).
        if (_repMarket === market && _repView === 'list') {
            const chipEl = {}, beatEl = {};
            document.querySelectorAll('[data-rep-score]').forEach(el => { chipEl[el.getAttribute('data-rep-score')] = el; });
            document.querySelectorAll('[data-rep-beat]').forEach(el => { beatEl[el.getAttribute('data-rep-beat')] = el; });
            for (const r of data) {
                if (r.score == null) continue;
                const chip = chipEl[r.symbol];
                if (chip) { chip.className = `rep-card-score ${_repScoreClass(r.score)}`; chip.textContent = r.score; }
                if (r.improved) {
                    const slot = beatEl[r.symbol];
                    if (slot && !slot.innerHTML) slot.innerHTML = '<span class="rep-card-beat" title="שיפור מול תקופה קודמת">▲</span>';
                }
            }
        }
    } catch (e) { _repSbSyncedAt[dbMkt] = 0; }
}

// ── Reports-page intel strip: 24/7 agent freshness + companies that reported most recently ──────
function _repAgo(ts) {
    if (!ts) return '';
    let s = Math.round((Date.now() - new Date(ts).getTime()) / 1000); if (s < 0) s = 0;
    if (s < 90) return 'ממש עכשיו';
    const m = Math.round(s / 60); if (m < 60) return `לפני ${m} דק׳`;
    const h = Math.round(m / 60); if (h < 24) return `לפני ${h} שע׳`;
    return `לפני ${Math.round(h / 24)} ימים`;
}
async function _repLoadIntel() {
    const el = document.getElementById('repIntel');
    if (!el || typeof supabaseClient === 'undefined' || !supabaseClient) return;
    // Reserve the status-strip height NOW (same frame as the shell render) so the async
    // fill doesn't push the whole board down — one of the "page jumps" reported.
    el.style.minHeight = '40px';
    const market = _repMarket;
    try {
        // Only the agent-status line is needed here now — the recent/upcoming lists moved
        // into their own windows, which fetch on open (two round-trips saved per board load).
        const statusRes = await supabaseClient.from('agent_status').select('last_run,last_result').eq('agent', 'reports').maybeSingle();
        if (document.getElementById('repIntel') !== el || _repMarket !== market || _repView !== 'list') return;
        const st = statusRes && statusRes.data;
        const live = !!(st && st.last_run && (Date.now() - new Date(st.last_run).getTime() < 6 * 3600 * 1000));
        const cnt = (st && st.last_result && (st.last_result.match(/(\d+)\s*\/\s*\d+/) || [])[1]) || '';
        const statusHtml = `<div class="rep-intel-status">
            <span class="rep-live ${live ? 'on' : ''}"></span>
            <b>${live ? 'מנוע הדוחות פעיל 24/7' : 'מנוע הדוחות — בודק'}</b>
            <span class="rep-intel-sub">${cnt ? cnt + ' חברות מנותחות · ' : ''}${st && st.last_run ? 'עודכן ' + _repAgo(st.last_run) : ''}</span>
        </div>`;
        // The "📅 דוחות קרובים" / "🆕 דיווחו לאחרונה" chip strips were retired — both now open
        // as full WINDOWS from the buttons at the LEFT end of the index-tabs bar above,
        // showing the complete list instead of a clipped row.
        el.innerHTML = statusHtml;
    } catch (e) { el.style.minHeight = ''; /* non-fatal — release the reserved strip space */ }
}

// ── Watchlist (per-user, Supabase `watchlist` with RLS) ─────────────────────────────────────────
let _repWatch = new Set();        // watched symbols (UPPER)
let _repWatchMkt = {};            // symbol → market
let _repWatchGroup = {};          // symbol → group_label (e.g. "תעודת סל בהתאמה אישית")
function _repIsWatched(sym) { return _repWatch.has(String(sym).toUpperCase()); }

// True for instruments that TRACK a commodity/index/bond (ETFs, gold, government bonds, crypto)
// — they have no company fundamentals, so the "📊 דוח" button must be hidden for them everywhere.
function assetHasNoReport(sym) {
    const raw = String(sym || '');
    const t = raw.replace(/\.TA$/i, '').toUpperCase();
    if (!t) return false;
    if (/-USD$/i.test(raw)) return true;                            // crypto pairs (BTC-USD…)
    if (typeof isUsEtf === 'function' && isUsEtf(t)) return true;   // US ETFs: index/bond/commodity/sector
    if (/^\d+$/.test(t)) return true;                              // numeric Israeli fund ids
    if (typeof window !== 'undefined' && window._ilFundInfo && window._ilFundInfo[t]) return true; // IL funds
    return false;
}
// Open a company report FROM the watchlist and remember to reopen the watchlist (and, if opened
// from a basket, that basket) when the user comes Back — instead of being dropped on the home page.
// The current history entry is tagged; the popstate handler in init.js restores it.
function _wlOpenReport(sym, basketId) {
    if (assetHasNoReport(sym)) return; // no fundamentals report for trackers
    try {
        const cur = (typeof history !== 'undefined' && history.state) ? history.state : {};
        history.replaceState(Object.assign({}, cur, { wlReopen: true, wlBasket: (basketId != null ? basketId : null) }), '', window.location.href);
    } catch (e) { }
    if (typeof closeBasketDetail === 'function') closeBasketDetail();
    closeWatchlistModal();
    if (typeof openReportForTicker === 'function') openReportForTicker(sym);
}
if (typeof window !== 'undefined') { window.assetHasNoReport = assetHasNoReport; window._wlOpenReport = _wlOpenReport; }

async function _repLoadWatch() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        const { data, error } = await supabaseClient.from('watchlist').select('symbol,market,group_label').order('created_at', { ascending: true });
        if (error) return;
        _repWatch = new Set((data || []).map(r => String(r.symbol).toUpperCase()));
        _repWatchMkt = {}; _repWatchGroup = {};
        (data || []).forEach(r => { const k = String(r.symbol).toUpperCase(); _repWatchMkt[k] = r.market || 'us'; if (r.group_label) _repWatchGroup[k] = r.group_label; });
        _repRenderWatchBar();
        _repRefreshStars();
    } catch (e) { /* not logged in / offline — fine */ }
}

async function _repRenderWatchBar() {
    // The watchlist no longer renders as an always-on strip — per the user's request it
    // lives ONLY behind the ⭐ buttons (reports header / dashboard header / mobile nav),
    // which open the shared watchlist modal (openWatchlistModal). Keep the bar empty and
    // clear the legacy height reservation so the board doesn't leave a gap.
    try { localStorage.setItem('rep_watch_has', '0'); } catch (e) { }
    const el = document.getElementById('repWatchBar');
    if (el) { el.innerHTML = ''; el.style.minHeight = ''; }
}

async function _repToggleWatch(symbol) {
    symbol = String(symbol || '').toUpperCase();
    if (!symbol || typeof supabaseClient === 'undefined' || !supabaseClient) return;
    const have = _repWatch.has(symbol);
    try {
        if (have) {
            const { error } = await supabaseClient.from('watchlist').delete().eq('symbol', symbol);
            if (error) throw error;
            _repWatch.delete(symbol);
        } else {
            // Store the DB-vocabulary market (us/r2k/il), not the tab id (sp500/ndx).
            const mkt = _repWatchMkt[symbol] || (/\.TA$/.test(symbol) ? 'il' : ((_REP_MKT[_repMarket] && _REP_MKT[_repMarket].db) || 'us'));
            const { error } = await supabaseClient.from('watchlist').insert({ symbol, market: mkt });
            if (error) throw error;
            _repWatch.add(symbol); _repWatchMkt[symbol] = mkt;
        }
    } catch (e) { if (typeof showToast === 'function') showToast('פעולת מעקב נכשלה — ודא שאתה מחובר', 'error'); return; }
    _repRenderWatchBar();
    _repRefreshStars();
    const db = document.getElementById('repWatchDetailBtn');
    if (db) { const on = _repWatch.has(symbol); db.classList.toggle('on', on); db.innerHTML = on ? '★ במעקב' : '☆ הוסף למעקב'; }
}
function _repRefreshStars() {
    document.querySelectorAll('[data-rep-star]').forEach(el => el.classList.toggle('on', _repWatch.has(el.getAttribute('data-rep-star'))));
}
// Add several symbols to the watchlist at once under a GROUP label (e.g. a custom-ETF
// basket from the correlation builder). Skips already-watched names. Real Supabase insert.
async function _repAddWatchGroup(symbols, groupLabel) {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return { added: 0 };
    const rows = [];
    for (const raw of (symbols || [])) {
        const symbol = String(raw || '').toUpperCase().trim();
        if (!symbol || _repWatch.has(symbol)) continue;
        const mkt = /\.TA$/.test(symbol) ? 'il' : 'us';
        rows.push({ symbol, market: mkt, group_label: groupLabel || null });
    }
    if (!rows.length) return { added: 0 };
    try {
        const { error } = await supabaseClient.from('watchlist').insert(rows);
        if (error) throw error;
        rows.forEach(r => { _repWatch.add(r.symbol); _repWatchMkt[r.symbol] = r.market; if (r.group_label) _repWatchGroup[r.symbol] = r.group_label; });
        _repRefreshStars();
        return { added: rows.length };
    } catch (e) { return { added: 0, error: e.message }; }
}
if (typeof window !== 'undefined') { window._repToggleWatch = _repToggleWatch; window._repLoadWatch = _repLoadWatch; window._repAddWatchGroup = _repAddWatchGroup; }

// ══ Watchlist MODAL — shared window (dashboard button + reports button + mobile nav) ══
// Shows each watched stock with its live price + a link to its report, plus a search
// field to add a stock. Reuses the Supabase `watchlist` state above.
async function openWatchlistModal() {
    let ov = document.getElementById('wlOverlay');
    if (!ov) {
        ov = document.createElement('div'); ov.id = 'wlOverlay'; ov.className = 'wl-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) closeWatchlistModal(); });
        document.body.appendChild(ov);
    }
    ov.innerHTML = `<div class="wl-box" dir="rtl">
        <div class="wl-head">
            <span class="wl-title">⭐ רשימת המעקב שלי</span>
            <button class="wl-close" onclick="closeWatchlistModal()" aria-label="סגור">✕</button>
        </div>
        <div class="wl-search-wrap">
            <input type="text" id="wlSearch" class="wl-search" autocomplete="off" placeholder="חיפוש מניה להוספה (למשל: NVDA, TEVA)…"
                oninput="_wlSuggest(this.value)" onkeydown="if(event.key==='Enter'){_wlAddFromSearch(this.value); this.value='';}" />
            <div id="wlSuggest" class="wl-suggest"></div>
        </div>
        <div id="wlList" class="wl-list"><div class="wl-empty"><div class="rep-spinner"></div>טוען…</div></div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    _wlPrimeUniverse();              // fill the search-suggestion pool (cheap; cached)
    await _repLoadWatch();            // refresh the per-symbol set from Supabase
    await _wlLoadBaskets();           // custom-ETF baskets (self-contained lists)
    _wlRenderList();
    setTimeout(() => { const s = document.getElementById('wlSearch'); if (s) s.focus(); }, 80);
}
// Fill _repUniverse for search suggestions WITHOUT rendering the reports list.
// Instant path: read every market's localStorage cache (returning users have these).
// Cold start (nothing cached): fetch the S&P 500 ticker list once so US names autocomplete.
let _wlPrimed = false;
async function _wlPrimeUniverse() {
    let any = false;
    for (const mkt of Object.keys(_REP_MKT)) {
        if (_repUniverse[mkt] && _repUniverse[mkt].length) { any = true; continue; }
        try {
            const raw = localStorage.getItem(_REP_MKT[mkt].ls);
            if (raw) { const c = JSON.parse(raw); if (c && Array.isArray(c.tickers) && c.tickers.length) { _repUniverse[mkt] = c.tickers; any = true; } }
        } catch (e) { }
    }
    if (any || _wlPrimed) { const s = document.getElementById('wlSearch'); if (s && s.value) _wlSuggest(s.value); return; }
    _wlPrimed = true; // fetch S&P 500 once even if the modal is reopened
    try {
        const r = await fetch('/api/technicals?mode=tickers&market=sp500&sv=3', { headers: { Accept: 'application/json' } });
        const j = await r.json();
        const tickers = (j.tickers || []).slice().sort((a, b) => a.localeCompare(b));
        if (tickers.length) {
            _repUniverse.sp500 = tickers;
            try { localStorage.setItem(_REP_MKT.sp500.ls, JSON.stringify({ day: new Date().toISOString().slice(0, 10), tickers, sectors: j.sectors || null })); } catch (e) { }
            const s = document.getElementById('wlSearch'); if (s && s.value) _wlSuggest(s.value);
        }
    } catch (e) { }
}
function closeWatchlistModal() {
    const ov = document.getElementById('wlOverlay');
    if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; }
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}
// Batch quotes via the same-origin /api/quote endpoint (Yahoo). Returns {SYM:{price,prevClose,currency}}.
async function _wlFetchPrices(symbols) {
    if (!symbols.length) return {};
    try {
        // Symbols are already in Yahoo form (TASE names carry the .TA suffix).
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        return (j && j.quotes) ? j.quotes : (j || {});
    } catch (e) { return {}; }
}
async function _wlRenderList() {
    const el = document.getElementById('wlList');
    if (!el) return;
    const syms = [..._repWatch];
    if (!syms.length) { el.innerHTML = '<div class="wl-empty">אין מניות במעקב עדיין. חפש מניה למעלה כדי להוסיף, או הוסף מכוכב ★ בעמוד הדוח.</div>'; return; }
    // Company names + report scores + report-signal fields from company_reports (best-effort).
    let info = {};
    try {
        const { data } = await supabaseClient.from('company_reports').select('symbol,score,company_name,improved,next_earnings,as_of').in('symbol', syms);
        (data || []).forEach(r => { info[String(r.symbol).toUpperCase()] = r; });
    } catch (e) { }
    const prices = await _wlFetchPrices(syms);
    if (document.getElementById('wlList') !== el) return;
    // Group labeled baskets (e.g. "תעודת סל בהתאמה אישית") under a header; ungrouped first.
    const rowHtml = (s) => {
        const r = info[s] || {};
        const disp = String(s).replace(/\.TA$/, '');
        const q = prices[s] || prices[disp] || {};
        const price = q.price != null ? q.price : (q.regularMarketPrice != null ? q.regularMarketPrice : null);
        const prev = q.prevClose != null ? q.prevClose : (q.previousClose != null ? q.previousClose : (q.regularMarketPreviousClose != null ? q.regularMarketPreviousClose : null));
        const chg = (price != null && prev) ? (price - prev) / prev * 100 : null;
        const cur = /\.TA$/.test(s) ? '₪' : '$';
        const priceHtml = price != null
            ? `<span class="wl-price">${cur}${Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>${chg != null ? `<span class="wl-chg ${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : ''}`
            : '<span class="wl-price wl-dim">—</span>';
        const sc = (r.score != null) ? `<span class="rep-card-score ${_repScoreClass(r.score)}">${r.score}</span>` : '';
        return `<div class="wl-row" data-wl-row="${s}">
            <div class="wl-main">
                <button class="wl-star" onclick="_wlRemove('${s}')" title="הסר ממעקב">★</button>
                <div class="wl-id"><span class="wl-tk">${disp}</span><span class="wl-co">${_repEscape(r.company_name || '')}</span></div>
                <div class="wl-priceblock">${priceHtml}</div>
                ${sc}
                ${assetHasNoReport(s) ? '' : `<button class="wl-report" onclick="_wlOpenReport('${s}')" title="ניתוח דוחות כספיים">📊 דוח</button>`}
                <button class="wl-report wl-tech" onclick="if(typeof openTechnicalForTicker==='function'){openTechnicalForTicker('${s}'); closeWatchlistModal();}" title="ניתוח טכני">📈 טכני</button>
            </div>
            <div class="wl-sig" id="wlSig-${disp}">${_wlReportSignals(r).join('')}</div>
        </div>`;
    };
    // Two categories: (1) stocks & other assets (the per-symbol watchlist), (2) custom-ETF baskets
    // (self-contained lists from watchlist_baskets — overlaps allowed). Each basket COLLAPSES to its
    // name; clicking it opens a detail window listing every asset (with delete options).
    let html = '';
    if (syms.length) {
        html += `<div class="wl-cat-head">📈 מניות ונכסים <span class="wl-cat-count">${syms.length}</span></div>`;
        html += syms.map(rowHtml).join('');
    }
    if (_wlBaskets.length) {
        html += `<div class="wl-cat-head wl-cat-etf">📦 תעודות סל בהתאמה אישית <span class="wl-cat-count">${_wlBaskets.length}</span></div>`;
        html += _wlBaskets.map(b => `<button class="wl-basket-row" onclick="openBasketDetail(${b.id})" title="פתח את פירוט הרשימה">
            <span class="wl-etf-name">📦 ${_repEscape(b.name)}</span>
            <span class="wl-etf-count">${(b.symbols || []).length} נכסים</span>
            <span class="wl-basket-open">פתח ›</span>
        </button>`).join('');
    }
    el.innerHTML = html || '<div class="wl-empty">אין מניות במעקב עדיין. חפש מניה למעלה כדי להוסיף, או הוסף מכוכב ★ בעמוד הדוח.</div>';
    // Significant signals (technical extremes + fresh company news) load async and patch in.
    _wlLoadSignals(syms);
}

// ── Custom-ETF baskets (self-contained lists) ──
let _wlBaskets = [];
async function _wlLoadBaskets() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) { _wlBaskets = []; return; }
    try {
        const { data, error } = await supabaseClient.from('watchlist_baskets').select('id,name,symbols,created_at').order('created_at', { ascending: true });
        if (error) { _wlBaskets = []; return; }
        _wlBaskets = (data || []).map(b => ({ id: b.id, name: b.name, symbols: Array.isArray(b.symbols) ? b.symbols.map(s => String(s).toUpperCase()) : [] }));
    } catch (e) { _wlBaskets = []; }
}
// Detail window for one basket — every asset with live price/score/links + per-asset & whole-list delete.
async function openBasketDetail(id) {
    const b = _wlBaskets.find(x => x.id === id);
    if (!b) return;
    let ov = document.getElementById('wlBasketOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'wlBasketOverlay'; ov.className = 'wl-overlay'; ov.addEventListener('click', e => { if (e.target === ov) closeBasketDetail(); }); document.body.appendChild(ov); }
    ov.innerHTML = `<div class="wl-box" dir="rtl">
        <div class="wl-head"><span class="wl-title">📦 ${_repEscape(b.name)}</span><button class="wl-close" onclick="closeBasketDetail()" aria-label="סגור">✕</button></div>
        <div class="wl-basket-actions">
            <button class="corr-run-btn corr-run-primary" onclick="_wlBasketBuy(${id})">🛒 קנה את הסל לתיק</button>
            <button class="wl-close-btn wl-basket-del" onclick="_wlDeleteBasket(${id})">🗑 מחק את כל הרשימה</button>
        </div>
        <div id="wlBasketList" class="wl-list"><div class="wl-empty"><div class="rep-spinner"></div>טוען…</div></div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    _wlRenderBasketDetail(b);
}
function closeBasketDetail() { const ov = document.getElementById('wlBasketOverlay'); if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; } if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock(); }
async function _wlRenderBasketDetail(b) {
    const el = document.getElementById('wlBasketList'); if (!el) return;
    const syms = (b.symbols || []).slice();
    if (!syms.length) { el.innerHTML = '<div class="wl-empty">הרשימה ריקה.</div>'; return; }
    let info = {};
    try { const { data } = await supabaseClient.from('company_reports').select('symbol,score,company_name').in('symbol', syms); (data || []).forEach(r => info[String(r.symbol).toUpperCase()] = r); } catch (e) { }
    const prices = await _wlFetchPrices(syms);
    if (!document.getElementById('wlBasketList')) return;
    const close2 = "closeBasketDetail(); closeWatchlistModal();";
    el.innerHTML = syms.map(s => {
        const r = info[s] || {};
        const disp = String(s).replace(/\.TA$/, '');
        const q = prices[s] || prices[disp] || {};
        const price = q.price != null ? q.price : (q.regularMarketPrice != null ? q.regularMarketPrice : null);
        const prev = q.prevClose != null ? q.prevClose : (q.previousClose != null ? q.previousClose : (q.regularMarketPreviousClose != null ? q.regularMarketPreviousClose : null));
        const chg = (price != null && prev) ? (price - prev) / prev * 100 : null;
        const cur = /\.TA$/.test(s) ? '₪' : '$';
        const priceHtml = price != null
            ? `<span class="wl-price">${cur}${Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>${chg != null ? `<span class="wl-chg ${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : ''}`
            : '<span class="wl-price wl-dim">—</span>';
        const sc = (r.score != null) ? `<span class="rep-card-score ${_repScoreClass(r.score)}">${r.score}</span>` : '';
        return `<div class="wl-row"><div class="wl-main">
            <button class="wl-star sa-del" onclick="_wlBasketRemoveSym(${b.id},'${s}')" title="הסר מהרשימה">✕</button>
            <div class="wl-id"><span class="wl-tk">${disp}</span><span class="wl-co">${_repEscape(r.company_name || '')}</span></div>
            <div class="wl-priceblock">${priceHtml}</div>
            ${sc}
            ${assetHasNoReport(s) ? '' : `<button class="wl-report" onclick="_wlOpenReport('${s}',${b.id})">📊 דוח</button>`}
            <button class="wl-report wl-tech" onclick="if(typeof openTechnicalForTicker==='function'){openTechnicalForTicker('${s}'); ${close2}}">📈 טכני</button>
        </div></div>`;
    }).join('');
}
async function _wlBasketRemoveSym(id, sym) {
    const b = _wlBaskets.find(x => x.id === id); if (!b) return;
    if ((b.symbols || []).length <= 1) return _wlDeleteBasket(id); // removing the last asset deletes the list
    if (typeof ensureSupabaseReady === 'function' && !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת', 'error'); return; }
    b.symbols = b.symbols.filter(x => x !== String(sym).toUpperCase());
    try {
        const { error } = await supabaseClient.from('watchlist_baskets').update({ symbols: b.symbols }).eq('id', id);
        if (error) throw error;
        _wlRenderBasketDetail(b);
        if (document.getElementById('wlList')) _wlRenderList();
    } catch (e) { if (typeof showToast === 'function') showToast('ההסרה נכשלה', 'error'); }
}
async function _wlDeleteBasket(id) {
    if (typeof ensureSupabaseReady === 'function' && !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת', 'error'); return; }
    try {
        const { error } = await supabaseClient.from('watchlist_baskets').delete().eq('id', id);
        if (error) throw error;
        _wlBaskets = _wlBaskets.filter(b => b.id !== id);
        if (typeof showToast === 'function') showToast('הרשימה נמחקה', 'success');
        closeBasketDetail();
        if (document.getElementById('wlList')) _wlRenderList();
    } catch (e) { if (typeof showToast === 'function') showToast('מחיקת הרשימה נכשלה', 'error'); }
}
function _wlBasketBuy(id) {
    const b = _wlBaskets.find(x => x.id === id); if (!b || !(b.symbols || []).length) return;
    const client = (typeof clients !== 'undefined' && clients[0]) || null;
    if (!client) { if (typeof openMgmtModal === 'function') openMgmtModal('addClient'); if (typeof showToast === 'function') showToast('צור תיק, ואז הוסף את מניות הסל', 'info'); return; }
    if (typeof openMgmtModal === 'function') openMgmtModal('addHolding', client);
    const first = String(b.symbols[0]).replace(/\.TA$/, '');
    setTimeout(() => { if (typeof selectSearchResult === 'function') selectSearchResult(first, '', 'USD', 'NASDAQ'); }, 140);
    if (typeof showToast === 'function') showToast('נפתחה הוספת נכס — הוסף כל מניה מהסל בתורה', 'info');
}

// ── Watchlist signals — anything MATERIAL about a watched name, shown next to it ──
// Reports: from company_reports (fresh filing / improved-vs-YoY / earnings coming up).
const _wlSig = (txt, cls, title) => `<span class="wl-sig-chip wl-sig-${cls}" title="${_repEscape(title || '')}">${txt}</span>`;
function _wlReportSignals(r) {
    const out = [];
    if (!r) return out;
    const today = new Date();
    const days = (d) => Math.round((new Date(d) - today) / 86400e3);
    if (r.as_of && days(r.as_of) >= -6) out.push(_wlSig('🆕 דיווחה', 'pos', `דוח כספי חדש פורסם (${_repHeDate(r.as_of)})`));
    if (r.improved) out.push(_wlSig('📈 דוח משתפר', 'pos', 'הרבעון האחרון השתפר מול הרבעון המקביל אשתקד'));
    if (r.next_earnings) {
        const d = days(r.next_earnings);
        if (d >= 0 && d <= 10) out.push(_wlSig(`📅 דוח ${d === 0 ? 'היום' : 'בעוד ' + d + ' ימים'}`, 'warn', `מועד הדוח הבא: ${_repHeDate(r.next_earnings)}`));
    }
    return out;
}
// Technical (live /api/technicals scan: RSI extremes, key-MA touch, FVG, unusual volume)
// + news (portfolio_alerts — the 24/7 SEC press agent) — appended to each row when found.
async function _wlLoadSignals(syms) {
    const patch = (sym, chips) => {
        const el = document.getElementById('wlSig-' + String(sym).replace(/\.TA$/, ''));
        if (el && chips.length) el.innerHTML += chips.join('');
    };
    // 1) Technical scan (single batched call; 60-symbol API cap).
    try {
        const today = new Date().toISOString().slice(0, 10);
        const r = await fetch(`/api/technicals?mode=scan&symbols=${encodeURIComponent(syms.slice(0, 60).join(','))}&d=${today}&v=2`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        const res = (j && j.results) || {};
        for (const s of syms) {
            const t = res[s] || res[String(s).replace(/\.TA$/, '')];
            if (!t) continue;
            const chips = [];
            if (t.rsiD != null && t.rsiD >= 70) chips.push(_wlSig('🔥 RSI קנוי־יתר', 'neg', `RSI יומי ${t.rsiD}`));
            else if (t.rsiD != null && t.rsiD <= 30) chips.push(_wlSig('🧊 RSI מכור־יתר', 'pos', `RSI יומי ${t.rsiD}`));
            const d200 = t.ma && t.ma.d200dist;
            if (d200 != null && Math.abs(d200) <= 2.5) chips.push(_wlSig('🎯 על ממוצע 200', 'warn', `${d200 > 0 ? '+' : ''}${d200}% מממוצע 200 יום — אזור תמיכה/התנגדות`));
            if ((t.fvgM && t.fvgM.inside) || (t.fvgQ && t.fvgQ.inside)) chips.push(_wlSig('🕳️ בתוך FVG', 'warn', 'המחיר בתוך פער שווי הוגן ' + (t.fvgM && t.fvgM.inside ? 'חודשי' : 'רבעוני')));
            if (t.vol != null && t.volAvg > 0 && t.vol >= 2 * t.volAvg) chips.push(_wlSig('📢 נפח חריג', 'warn', `נפח ${(t.vol / t.volAvg).toFixed(1)}× מהממוצע`));
            patch(s, chips);
        }
    } catch (e) { /* signals are best-effort */ }
    // 2) Fresh company news from the SEC press feed (last 7 days).
    try {
        const since = new Date(Date.now() - 7 * 86400e3).toISOString();
        const bases = syms.map(s => String(s).replace(/\.TA$/, ''));
        const { data } = await supabaseClient.from('portfolio_alerts')
            .select('ticker,summary_he,headline_en,published_at,materiality')
            .in('ticker', bases).gte('published_at', since)
            .order('published_at', { ascending: false }).limit(40);
        const seen = new Set();
        (data || []).forEach(a => {
            const tk = String(a.ticker || '').toUpperCase();
            if (!tk || seen.has(tk)) return;
            seen.add(tk);
            patch(tk, [_wlSig(a.materiality ? '📰 חדשות מהותיות' : '📰 חדשות', a.materiality ? 'neg' : 'info', a.summary_he || a.headline_en || 'הודעה לעיתונות')]);
        });
    } catch (e) { /* no alerts visible / offline — fine */ }
}
async function _wlRemove(sym) { await _repToggleWatch(sym); _wlRenderList(); }
// Add whatever the user typed (validate it resolves to a real quote first).
async function _wlAddFromSearch(raw) {
    let sym = String(raw || '').trim().toUpperCase();
    if (!sym) return;
    if (typeof showToast === 'function') showToast('מוסיף…', 'info');
    // TASE names: accept with or without the .TA suffix.
    const cand = /\.TA$/.test(sym) ? [sym] : [sym, sym + '.TA'];
    let resolved = null;
    try {
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(cand.join(','))}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        const q = (j && j.quotes) ? j.quotes : (j || {});
        resolved = cand.find(c => q[c] && (q[c].price != null || q[c].regularMarketPrice != null)) || null;
    } catch (e) { }
    if (!resolved) { if (typeof showToast === 'function') showToast('לא נמצאה מניה בשם ' + sym, 'error'); return; }
    if (!_repWatch.has(resolved)) await _repToggleWatch(resolved);
    const s = document.getElementById('wlSearch'); if (s) s.value = '';
    const sg = document.getElementById('wlSuggest'); if (sg) sg.innerHTML = '';
    _wlRenderList();
}
// As-you-type suggestions from the loaded reports universe (any market) — click to add.
function _wlSuggest(q) {
    const sg = document.getElementById('wlSuggest');
    if (!sg) return;
    q = String(q || '').trim().toUpperCase();
    if (q.length < 1) { sg.innerHTML = ''; return; }
    const pool = new Set();
    try { for (const m of Object.keys(_repUniverse)) (_repUniverse[m] || []).forEach(t => pool.add(t)); } catch (e) { }
    const matches = [...pool].filter(t => t.replace(/\.TA$/, '').includes(q)).slice(0, 8);
    sg.innerHTML = matches.length
        ? matches.map(t => `<button class="wl-sg-item" onclick="_wlAddFromSearch('${t}')">${t.replace(/\.TA$/, '')}${_repWatch.has(t) ? ' <span class="wl-sg-on">★ במעקב</span>' : ''}</button>`).join('')
        : '';
}
if (typeof window !== 'undefined') {
    window.openWatchlistModal = openWatchlistModal; window.closeWatchlistModal = closeWatchlistModal;
    window._wlRemove = _wlRemove; window._wlAddFromSearch = _wlAddFromSearch; window._wlSuggest = _wlSuggest;
    window._wlLoadBaskets = _wlLoadBaskets; window.openBasketDetail = openBasketDetail; window.closeBasketDetail = closeBasketDetail;
    window._wlBasketRemoveSym = _wlBasketRemoveSym; window._wlDeleteBasket = _wlDeleteBasket; window._wlBasketBuy = _wlBasketBuy;
}

// ══ EARNINGS WINDOWS — "דוחות קרובים" + "דיווחו לאחרונה" (index-strip buttons) ══
// Both read the 24/7 reports-agent's company_reports rows, so the lists are the same
// data the board shows. Holdings are flagged so a manager sees their own names first.
function _erHeldSet() {
    const held = new Set();
    try { (typeof clients !== 'undefined' ? clients : []).forEach(c => (c.holdings || []).forEach(h => { if (h.type === 'stock' && h.ticker) held.add(String(h.ticker).toUpperCase()); })); } catch (e) { }
    return held;
}
function _erShell(id, title, sub) {
    let ov = document.getElementById(id);
    if (!ov) {
        ov = document.createElement('div'); ov.id = id; ov.className = 'wl-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) _erClose(id); });
        document.body.appendChild(ov);
    }
    ov.innerHTML = `<div class="wl-box er-box" dir="rtl">
        <div class="wl-head">
            <span class="wl-title">${title}</span>
            <button class="wl-close" onclick="_erClose('${id}')" aria-label="סגור">✕</button>
        </div>
        <div class="er-sub">${sub}</div>
        <div id="${id}List" class="wl-list"><div class="rep-loading"><div class="rep-spinner"></div>טוען…</div></div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    return ov;
}
function _erClose(id) {
    const ov = document.getElementById(id);
    if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; }
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}

// Small gold bell (icon only) reused for the earnings-alert button.
const _ER_GOLD_BELL = '<svg class="gb-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2a2 2 0 0 0-2 2v.29A7 7 0 0 0 5 11v3.28l-1.55 2.33A1 1 0 0 0 4.28 18h15.44a1 1 0 0 0 .83-1.39L19 14.28V11a7 7 0 0 0-5-6.71V4a2 2 0 0 0-2-2z"/><path d="M10 20a2 2 0 0 0 4 0z"/></svg>';

// Which modal to reopen after the user views a company report and comes back (Back / חזור).
let _erReturnModal = null;
function _erOpenReport(sym, modalId) {
    _erReturnModal = modalId || null;
    _erClose(modalId);
    if (typeof openReportForTicker === 'function') openReportForTicker(sym);
}
function _erReopenAfterReport() {
    if (!_erReturnModal) return;
    const m = _erReturnModal; _erReturnModal = null;
    setTimeout(() => {
        if (m === 'erUpcoming' && typeof openUpcomingEarningsModal === 'function') openUpcomingEarningsModal();
        else if (m === 'erRecent' && typeof openRecentEarningsModal === 'function') openRecentEarningsModal();
    }, 80);
}

// ── 📅 Upcoming earnings — received reports first, then today, then soonest ──
async function openUpcomingEarningsModal() {
    _erShell('erUpcoming', '📅 דוחות קרובים', 'דוחות שכבר התקבלו מוצגים ראשונים · אחריהם לפי המועד הקרוב ביותר');
    const el = document.getElementById('erUpcomingList');
    if (!el) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const { data } = await supabaseClient.from('company_reports')
            .select('symbol,company_name,next_earnings,score,market')
            .gte('next_earnings', today).order('next_earnings', { ascending: true }).limit(120);
        if (document.getElementById('erUpcomingList') !== el) return;
        const rows = (data || []).filter(r => r && r.next_earnings);
        if (!rows.length) { el.innerHTML = '<div class="wl-empty">אין מועדי דוחות עתידיים ידועים כרגע.</div>'; return; }
        const held = _erHeldSet();
        const days = (d) => Math.round((new Date(d) - new Date(today)) / 86400e3);
        // Live earnings for imminent names → detect which reports are ALREADY OUT (received),
        // so they can be shown first with beat/miss — real Yahoo actual-vs-estimate, no agent lag.
        const imm = rows.filter(r => days(r.next_earnings) <= 3).map(r => String(r.symbol).toUpperCase());
        let erInfo = {};
        if (imm.length) {
            try {
                const rr = await fetch(`/api/technicals?mode=earnings&symbols=${encodeURIComponent(imm.slice(0, 24).join(','))}`, { headers: { Accept: 'application/json' } });
                const jj = await rr.json(); erInfo = (jj && jj.results) || {};
            } catch (e) { }
            if (document.getElementById('erUpcomingList') !== el) return;
        }
        const relOf = (r) => {
            const info = erInfo[String(r.symbol).toUpperCase()];
            if (!info || !info.reportedDate) return null;
            const sched = String(r.next_earnings).slice(0, 10);
            return ((new Date(info.reportedDate) - new Date(sched)) / 86400e3 >= -4) ? info : null;
        };
        // Order: received (tier −1) → today/soonest by days ascending. Held is a tiebreaker within a tier.
        const tier = (r) => relOf(r) ? -1 : days(r.next_earnings);
        rows.sort((a, b) => tier(a) - tier(b)
            || (held.has(b.symbol.toUpperCase()) - held.has(a.symbol.toUpperCase()))
            || a.next_earnings.localeCompare(b.next_earnings));
        el.innerHTML = rows.map(r => {
            const sym = String(r.symbol).toUpperCase(), disp = sym.replace(/\.TA$/, '');
            const d = days(r.next_earnings);
            const when = d === 0 ? 'היום' : d === 1 ? 'מחר' : `בעוד ${d} ימים`;
            const cls = d <= 3 ? 'warn' : d <= 10 ? 'info' : 'dim';
            const sc = (r.score != null) ? `<span class="rep-card-score ${_repScoreClass(r.score)}">${r.score}</span>` : '';
            const cname = _repEscape(r.company_name || '');
            const info = relOf(r);
            let whenHtml, beatLine = '';
            if (info) {
                const beat = (info.epsActual != null && info.epsEstimate != null) ? (info.epsActual >= info.epsEstimate)
                    : (info.surprisePct != null ? info.surprisePct >= 0 : null);
                const sp = info.surprisePct != null ? `${info.surprisePct >= 0 ? '+' : ''}${info.surprisePct}%` : '';
                const beatTxt = beat === true ? `<span class="er-beat er-beat-yes">▲ היכתה את התחזיות${sp ? ' · ' + sp : ''}</span>`
                    : beat === false ? `<span class="er-beat er-beat-no">▼ פספסה את התחזיות${sp ? ' · ' + sp : ''}</span>`
                        : `<span class="er-beat">הדוח התפרסם</span>`;
                const eps = (info.epsActual != null && info.epsEstimate != null) ? ` <span class="er-eps">EPS $${(+info.epsActual).toFixed(2)} מול צפי $${(+info.epsEstimate).toFixed(2)}</span>` : '';
                whenHtml = `<span class="er-when er-received">✓ התקבל הדוח</span>`;
                beatLine = `<div class="wl-sig er-beatline">${beatTxt}${eps}</div>`;
            } else {
                whenHtml = `<span class="er-when er-${cls}">${when}</span>`;
            }
            return `<div class="wl-row" data-er-sym="${sym}"><div class="wl-main">
                <div class="wl-id">
                    <span class="wl-tk">${disp}${held.has(sym) ? ' <span class="er-held">בתיק</span>' : ''}</span>
                    <span class="wl-co">${cname}</span>
                </div>
                <div class="wl-priceblock">
                    <span class="wl-price">${_repHeDate(r.next_earnings)}</span>
                    ${whenHtml}
                </div>
                ${sc}
                <div class="er-row-actions">
                    <button class="wl-report" onclick="_erOpenReport('${sym}','erUpcoming')">📊 דוח</button>
                    <button class="gold-bell-btn" onclick="if(typeof createEarningsAlert==='function')createEarningsAlert('${sym}','${r.next_earnings}')" title="קבל התראה בפעמון כשהדוח מתפרסם" aria-label="התראת דוח">${_ER_GOLD_BELL}</button>
                </div>
            </div>${beatLine}</div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = '<div class="wl-empty">טעינת המועדים נכשלה — נסה שוב בעוד רגע.</div>';
    }
}

// ── 🆕 Recently reported — what came out: score, beat-vs-YoY, market reaction, material news ──
// Recency label from a report date ("היום"/"אתמול"/"לפני N ימים").
function _erRecencyLabel(d) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const days = Math.round((today - new Date(String(d).slice(0, 10))) / 86400e3);
    if (days <= 0) return 'היום';
    if (days === 1) return 'אתמול';
    return `לפני ${days} ימים`;
}
async function openRecentEarningsModal() {
    _erShell('erRecent', '🆕 דיווחו לאחרונה', 'לפי מועד הפרסום — החדשים ביותר ראשונים · הכאת תחזיות (EPS בפועל מול צפי) · תגובת השוק');
    const el = document.getElementById('erRecentList');
    if (!el) return;
    const dayMinus = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
    const CUTOFF = dayMinus(35); // "recently" = reported within ~5 weeks
    try {
        // Candidate pool of RECENT reporters. The agent updates a company right after it reports —
        // clearing next_earnings (the next date isn't scheduled yet) — so "next_earnings IS NULL &&
        // recently updated" reliably flags fresh reporters even before the full financials (as_of)
        // catch up. Also include anyone whose full financials just posted (recent as_of).
        const [qNull, qAsOf] = await Promise.all([
            supabaseClient.from('company_reports').select('symbol,company_name,score,improved,as_of')
                .is('next_earnings', null).gte('updated_at', dayMinus(4)).not('score', 'is', null)
                .order('updated_at', { ascending: false }).limit(48),
            supabaseClient.from('company_reports').select('symbol,company_name,score,improved,as_of')
                .gte('as_of', CUTOFF).not('score', 'is', null).order('as_of', { ascending: false }).limit(48),
        ]);
        if (document.getElementById('erRecentList') !== el) return;
        const pool = {};
        [...(qNull.data || []), ...(qAsOf.data || [])].forEach(r => { if (r && r.symbol) { const k = String(r.symbol).toUpperCase(); if (!pool[k]) pool[k] = r; } });
        const candidates = Object.keys(pool);
        if (!candidates.length) { el.innerHTML = '<div class="wl-empty">אין דוחות אחרונים להצגה.</div>'; return; }
        // LIVE earnings (real reportedDate + EPS beat/miss) for the candidates — the moment a report
        // is out Yahoo has it, independent of the agent's slower full-financials refresh.
        const live = {};
        for (let i = 0; i < candidates.length && i < 48; i += 24) {
            try {
                const r = await fetch(`/api/technicals?mode=earnings&symbols=${encodeURIComponent(candidates.slice(i, i + 24).join(','))}`, { headers: { Accept: 'application/json' } });
                const j = await r.json(); Object.assign(live, (j && j.results) || {});
            } catch (e) { }
        }
        if (document.getElementById('erRecentList') !== el) return;
        // Effective report date = live reportedDate (if newer & recent) else the agent's as_of.
        const entries = candidates.map(sym => {
            const r = pool[sym], info = live[sym];
            let repDate = r.as_of, epsA = null, epsE = null, surprise = null, fresh = false;
            if (info && info.reportedDate && info.reportedDate >= CUTOFF && info.reportedDate >= (r.as_of || '')) {
                repDate = info.reportedDate; epsA = info.epsActual; epsE = info.epsEstimate; surprise = info.surprisePct; fresh = true;
            }
            return { sym, r, repDate, epsA, epsE, surprise, fresh };
        }).filter(e => e.repDate && e.repDate >= CUTOFF)
            .sort((a, b) => String(b.repDate).localeCompare(String(a.repDate)) || (b.r.score - a.r.score));
        if (!entries.length) { el.innerHTML = '<div class="wl-empty">אין דוחות שפורסמו בחמשת השבועות האחרונים.</div>'; return; }
        const held = _erHeldSet();
        const top = entries.slice(0, 40);
        // Stash each row's facts so the "למה זזה?" reaction button can pass them to the AI.
        _erReactData = {};
        top.forEach(e => { _erReactData[e.sym] = { company: (e.r.company_name || ''), epsA: e.epsA, epsE: e.epsE, surprise: e.surprise, repDate: e.repDate }; });
        el.innerHTML = top.map(e => {
            const r = e.r, sym = e.sym, disp = sym.replace(/\.TA$/, '');
            let beat;
            if (e.surprise != null || (e.epsA != null && e.epsE != null)) {
                const b = e.surprise != null ? e.surprise >= 0 : e.epsA >= e.epsE;
                const sp = e.surprise != null ? `${e.surprise >= 0 ? '+' : ''}${e.surprise}%` : '';
                const eps = (e.epsA != null && e.epsE != null) ? ` <span class="er-eps">EPS $${(+e.epsA).toFixed(2)} מול צפי $${(+e.epsE).toFixed(2)}</span>` : '';
                beat = (b ? `<span class="er-beat er-beat-yes">▲ היכתה את התחזיות${sp ? ' · ' + sp : ''}</span>` : `<span class="er-beat er-beat-no">▼ פספסה את התחזיות${sp ? ' · ' + sp : ''}</span>`) + eps;
            } else {
                beat = r.improved ? '<span class="er-beat er-beat-yes">▲ שיפור מול הרבעון המקביל</span>' : '<span class="er-beat er-beat-no">▼ ללא שיפור מול המקביל</span>';
            }
            const sc = `<span class="rep-card-score ${_repScoreClass(r.score)}">${r.score}</span>`;
            return `<div class="wl-row" data-er-row="${disp}"><div class="wl-main">
                    <div class="wl-id">
                        <span class="wl-tk">${disp}${held.has(sym) ? ' <span class="er-held">בתיק</span>' : ''}${e.fresh ? ' <span class="er-fresh">🆕</span>' : ''}</span>
                        <span class="wl-co">${_repEscape(r.company_name || '')}</span>
                    </div>
                    <div class="er-date-block"><span class="er-date-big">${_repHeDate(e.repDate)}</span><span class="er-date-when">${_erRecencyLabel(e.repDate)}</span></div>
                    <div class="wl-priceblock" id="erPx-${disp}"><span class="wl-price wl-dim">—</span></div>
                    ${sc}
                    <div class="er-row-actions">
                        <button class="wl-report" onclick="_erOpenReport('${sym}','erRecent')">📊 דוח</button>
                        <button class="er-why-btn" onclick="_erReaction('${sym}')" title="סנטימנט המשקיעים אחרי הדוח — הסיבה לתנועה, תחזיות ותגובת השוק">📖 סנטימנט משקיעים</button>
                    </div>
                </div>
                <div class="wl-sig">${beat}<span class="er-news" id="erNews-${disp}"></span></div>
                <div class="er-reaction" id="erReact-${disp}"></div>
            </div>`;
        }).join('');
        _erLoadReactions(top.map(e => e.sym));
    } catch (e) {
        el.innerHTML = '<div class="wl-empty">טעינת הדוחות נכשלה — נסה שוב בעוד רגע.</div>';
    }
}

// "למה זזה?" — AI (Gemini, Google-grounded) explanation of the post-earnings move: the
// after-hours/pre-market reaction %, WHY it moved (guidance / results / call), and the investor
// sentiment. Real/current — grounded, not the model's stale knowledge. Toggles open/closed.
let _erReactData = {};
async function _erReaction(sym) {
    const disp = String(sym).replace(/\.TA$/, '');
    const box = document.getElementById('erReact-' + disp);
    const d = _erReactData[sym] || {};
    if (!box) return;
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; } // toggle closed
    box.dataset.open = '1';
    box.innerHTML = '<div class="er-react-load"><div class="rep-spinner"></div>מנתח את תגובת השוק לדוח…</div>';
    try {
        const r = await fetch('/api/vision?mode=reaction', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: sym, company: d.company, epsActual: d.epsA, epsEstimate: d.epsE, surprisePct: d.surprise, reportDate: d.repDate }),
        });
        const j = await r.json();
        if (!r.ok || j.error || (!j.why_he && !j.move_he)) throw new Error(j.message || 'failed');
        box.innerHTML = `<div class="er-react-inner">
            ${j.move_he ? `<div class="er-react-move">📉 <b>תנועת המניה:</b> ${_repEscape(j.move_he)}</div>` : ''}
            ${j.why_he ? `<div class="er-react-why"><b>הסיבה:</b> ${_repEscape(j.why_he)}</div>` : ''}
            ${j.sentiment_he ? `<div class="er-react-sent"><b>סנטימנט המשקיעים:</b> ${_repEscape(j.sentiment_he)}</div>` : ''}
            <div class="er-react-foot">ניתוח AI מבוסס נתוני מחיר וכותרות חדשות אמיתיים · אינו ייעוץ השקעות</div>
        </div>`;
    } catch (e) {
        box.innerHTML = '<div class="er-react-err">לא ניתן להפיק ניתוח כרגע (ייתכן עומס זמני על מנוע ה-AI). נסה שוב בעוד רגע.</div>';
        box.dataset.open = '';
    }
}

// Market reaction: the REAL price move SINCE the report (not just today's tick) — so a stock
// that beat EPS but sold off after the report shows the actual drop, not a misleading "all green".
// Move = latest close vs the close on the report date (the pre-report level). Plus any MATERIAL
// press item near the report (portfolio_alerts — the 24/7 SEC press agent).
async function _erLoadReactions(syms) {
    try {
        const [prices, hist] = await Promise.all([
            _wlFetchPrices(syms.slice(0, 60)),
            (async () => { try { const r = await fetch(`/api/history?symbols=${encodeURIComponent(syms.slice(0, 40).join(','))}&range=2mo&interval=1d`, { headers: { Accept: 'application/json' } }); return await r.json() || {}; } catch (e) { return {}; } })(),
        ]);
        for (const s of syms) {
            const disp = s.replace(/\.TA$/, '');
            const q = prices[s] || prices[disp] || {};
            const price = q.price != null ? q.price : null;
            const prev = q.prevClose != null ? q.prevClose : null;
            const chg = (price != null && prev) ? (price - prev) / prev * 100 : null;
            const box = document.getElementById('erPx-' + disp);
            if (!box || price == null) continue;
            const cur = /\.TA$/.test(s) ? '₪' : '$';
            // Reaction since the report date (pre-report close → latest close).
            let reactPct = null;
            const pts = hist[s] || hist[disp];
            const rd = (_erReactData[s] && _erReactData[s].repDate) ? String(_erReactData[s].repDate).slice(0, 10) : null;
            if (Array.isArray(pts) && pts.length >= 2 && rd) {
                let base = null; for (const p of pts) { if (p.date <= rd) base = p; }
                if (!base) base = pts[0];
                const latest = pts[pts.length - 1];
                if (base && latest && base.close && base.close !== latest.close) reactPct = (latest.close - base.close) / base.close * 100;
            }
            const priceHtml = `<span class="wl-price">${cur}${Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>`;
            const moveHtml = reactPct != null
                ? `<span class="wl-chg ${reactPct >= 0 ? 'pos' : 'neg'}" title="תגובת המניה מאז פרסום הדוח">מאז הדוח ${reactPct >= 0 ? '+' : ''}${reactPct.toFixed(1)}%</span>`
                : (chg != null ? `<span class="wl-chg ${chg >= 0 ? 'pos' : 'neg'}" title="שינוי היום">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : '');
            box.innerHTML = priceHtml + moveHtml;
        }
    } catch (e) { /* prices are best-effort */ }
    // Material company news from the press agent (user's own alerts — RLS scoped).
    try {
        const since = new Date(Date.now() - 14 * 86400e3).toISOString();
        const { data } = await supabaseClient.from('portfolio_alerts')
            .select('ticker,summary_he,headline_en,sentiment,materiality,published_at')
            .in('ticker', syms.map(s => s.replace(/\.TA$/, ''))).gte('published_at', since)
            .order('published_at', { ascending: false }).limit(60);
        const seen = new Set();
        (data || []).forEach(a => {
            const tk = String(a.ticker || '').toUpperCase();
            if (!tk || seen.has(tk)) return;
            seen.add(tk);
            const el = document.getElementById('erNews-' + tk);
            if (!el) return;
            const s = +a.sentiment || 0;
            const cls = s > 0 ? 'pos' : s < 0 ? 'neg' : 'info';
            const mood = s > 0 ? 'חיובי' : s < 0 ? 'שלילי' : 'ניטרלי';
            el.innerHTML = `<span class="wl-sig-chip wl-sig-${cls}" title="${_repEscape(a.summary_he || a.headline_en || '')}">`
                + `${a.materiality ? '📰 מהותי' : '📰'} · סנטימנט ${mood}</span>`;
        });
    } catch (e) { /* no alerts visible / not logged in — fine */ }
}

if (typeof window !== 'undefined') {
    window.openUpcomingEarningsModal = openUpcomingEarningsModal;
    window.openRecentEarningsModal = openRecentEarningsModal;
    window._erClose = _erClose; window._erOpenReport = _erOpenReport; window._erReaction = _erReaction;
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
    const todo = uni.filter(t => {
        const s = scores[t];
        if (!s) return true;
        // Agent-sourced entries are refreshed continuously by the 24/7 sweep — never
        // re-fetch them client-side (this is what keeps the Russell-2000 board cheap).
        if (s.src === 'agent' && (s.score != null || s.noData)) return false;
        if (now - (s.ts || 0) > TTL) return true; // re-check stale entries (data may have appeared since)
        return s.score == null && !s.noData;       // still need a score, and not already known-empty
    });
    if (!todo.length) return;
    // Fill what's on screen first: with a search filter active, its matches jump the queue.
    if (_repSearch) todo.sort((a, b) => (b.includes(_repSearch) ? 1 : 0) - (a.includes(_repSearch) ? 1 : 0));

    let idx = 0;
    const CONCURRENCY = 8;
    const worker = async () => {
        while (idx < todo.length) {
            if (myToken !== _repPrefetchToken || _repView !== 'list' || _repMarket !== market) return;
            const t = todo[idx++];
            try {
                const r = await fetch(`/api/technicals?mode=report&symbol=${encodeURIComponent(t)}&market=${market}&fast=1&rv=4`, { headers: { Accept: 'application/json' } });
                const stillCurrent = () => myToken === _repPrefetchToken && _repView === 'list' && _repMarket === market;
                if (r.ok) {
                    const rep = await r.json();
                    const model = ReportsEngine.buildReport(rep);
                    if (model.score && model.score.value != null) {
                        _repSaveScore(t, { score: model.score.value, improved: model.beat && model.beat.improved });
                        if (stillCurrent()) _repUpdateCardChip(t, model.score.value, model.beat && model.beat.improved);
                    } else if (market === 'il' && !_repHasData(model)) {
                        _repSaveScore(t, { noData: true });          // confirmed empty ת"א name → drop from the list
                        if (stillCurrent()) _repRemoveCard(t);
                    }
                } else if (market === 'il' && r.status === 404) {
                    _repSaveScore(t, { noData: true });
                    if (stillCurrent()) _repRemoveCard(t);
                }
            } catch (e) { /* skip — transient errors must NOT mark a ticker as no-data */ }
            await new Promise(res => setTimeout(res, 60)); // gentle on the data source (most hits land on the CDN cache)
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

// Live-remove a card once prefetch confirms it has no data (Israeli list). Drops an emptied
// sector group too, and keeps the remaining sector count accurate.
function _repRemoveCard(symbol) {
    const chip = document.querySelector(`[data-rep-score="${symbol}"]`);
    const card = chip && chip.closest('.rep-card');
    if (!card) return;
    const group = card.closest('.rep-sector-group');
    card.remove();
    if (group) {
        const remaining = group.querySelectorAll('.rep-card').length;
        if (!remaining) group.remove();
        else { const c = group.querySelector('.rep-sector-count'); if (c) c.textContent = remaining; }
    }
}

// The 24/7 agent stores the FULL merged (fmp+yahoo) report in company_reports.report — built when
// FMP was reachable and kept fresh. The live mode=report fetch can transiently fall back to a stale
// Yahoo-only quarter when the free FMP key is rate-limited, so we read the stored blob too and use
// whichever is FRESHER. This keeps the detail view as current as the board, FMP-quota-independent.
async function _repFetchStoredReport(symbol) {
    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) return null;
        const { data, error } = await supabaseClient.from('company_reports')
            .select('report, next_earnings').eq('symbol', String(symbol).toUpperCase()).maybeSingle();
        if (error || !data || !data.report) return null;
        const rep = data.report;
        if (!rep || !Array.isArray(rep.quarters) || !rep.quarters.length) return null;
        if (!rep.nextEarningsDate && data.next_earnings) rep.nextEarningsDate = data.next_earnings;
        return rep;
    } catch (e) { return null; }
}
// The true REPORT (release) date — free from the Yahoo earnings feed (≠ fiscal period end), used when
// the report blob itself doesn't carry a filingDate (e.g. rows stored before that field existed).
async function _repFetchReportedDate(symbol) {
    try {
        const r = await fetch(`/api/technicals?mode=earnings&symbols=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const info = (j.results || {})[String(symbol).toUpperCase()] || null;
        return (info && info.reportedDate) ? info.reportedDate : null;
    } catch (e) { return null; }
}

// ── Detail: fetch report on demand → engine → render ──
async function openReportDetail(symbol) {
    _repView = 'detail';
    _repDestroyCharts();
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: symbol });
    const body = document.getElementById('repBody');
    if (body) body.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div><span>טוען דו"ח עבור ${symbol.replace(/\.TA$/, '')}…</span></div>`;

    try {
        // rv bumped when the report shape changes — also busts the 6h CDN cache of stale responses.
        const [liveRes, stored, reportedDate] = await Promise.all([
            fetch(`/api/technicals?mode=report&symbol=${encodeURIComponent(symbol)}&market=${_repMarket}&rv=6`, { headers: { Accept: 'application/json' } }).catch(() => null),
            _repFetchStoredReport(symbol),
            _repFetchReportedDate(symbol),
        ]);
        let liveReport = null;
        if (liveRes && liveRes.ok) { liveReport = await liveRes.json().catch(() => null); }
        const liveOk = liveReport && Array.isArray(liveReport.quarters) && liveReport.quarters.length;
        // Nothing usable from either source → surface the live error.
        if (!liveOk && !stored) {
            const status = liveRes ? liveRes.status : 0;
            const msg = status === 429 ? 'מכסת ה-API היומית נוצלה — נסה שוב מאוחר יותר.'
                : status === 404 ? 'לא נמצאו נתונים פונדמנטליים לחברה זו.'
                : 'משיכת הדו"ח נכשלה.';
            if (status === 404 && _repMarket === 'il') _repSaveScore(symbol, { noData: true }); // remember → drops from the IL list
            if (body) body.innerHTML = `<div class="adv-empty">${msg}<br><button class="macro-back-btn" style="margin-top:12px" onclick="backToReportsList()">חזרה לרשימה</button></div>`;
            return;
        }
        // Use whichever report is FRESHER (newest as_of). Stored wins ties so a rate-limited live FMP
        // fetch never downgrades the view to a stale Yahoo-only quarter.
        let report = liveOk ? liveReport : null;
        if (stored && stored.asOf && (!report || !report.asOf || stored.asOf >= report.asOf)) report = stored;
        // Stamp the real release date if the report blob lacks a valid one.
        if (reportedDate && report && reportedDate >= (report.asOf || '') && (!report.reportedDate || report.reportedDate < report.asOf)) {
            report.reportedDate = reportedDate;
        }
        const model = ReportsEngine.buildReport(report);
        _repCurrent = model;
        const hasData = _repHasData(model);
        if (model.score && model.score.value != null) _repSaveScore(symbol, { score: model.score.value, improved: model.beat && model.beat.improved });
        else if (!hasData && _repMarket === 'il') _repSaveScore(symbol, { noData: true });
        _repRenderDetail(model);         // a clean "no data" view is rendered when hasData is false
        if (hasData) _repLoadAI(model);  // async SWOT + strategy only when there's something to analyze
        if (hasData && model.market !== 'il') _repLoadSegments(model); // business segments (lazy, cached)
    } catch (e) {
        if (body) body.innerHTML = `<div class="adv-empty">שגיאה בטעינת הדו"ח.<br><button class="macro-back-btn" style="margin-top:12px" onclick="backToReportsList()">חזרה לרשימה</button></div>`;
    }
}

function backToReportsList() {
    _repView = 'list';
    _repDestroyCharts();
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: null });
    _repRenderList();
    if (typeof _erReopenAfterReport === 'function') _erReopenAfterReport(); // reopen the earnings modal if we came from it
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
        _repMarket = sym.endsWith('.TA') ? 'il' : 'sp500';
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
// RPO card — Remaining Performance Obligation: signed contracts NOT yet booked as revenue
// (committed future-revenue backlog). Real data from SEC XBRL; shown only when the company
// reports it (SaaS/subscription/contract firms). A rising RPO = strong forward demand.
function _repRpoHtml(m) {
    const r = m && m.rpo;
    if (!r || r.total == null) return '';
    const cur = '$';
    const pct = (a, b) => (a != null && b != null && b !== 0) ? (a - b) / b : null;
    const qoq = pct(r.total, r.prev);
    const yoy = pct(r.total, r.yoy);
    const chip = (label, v) => v == null ? '' :
        `<span class="rep-rpo-chip ${v >= 0 ? 'pos' : 'neg'}">${label} ${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%</span>`;
    const he = (d) => { try { return new Date(d).toLocaleDateString('he-IL'); } catch (e) { return d; } };
    return `
        <div class="rep-rpo-card">
            <div class="rep-rpo-head">
                <span class="rep-rpo-title">צבר הזמנות חוזי — RPO</span>
                <span class="rep-rpo-sub">עסקאות שנחתמו וטרם הוכרו כהכנסה · דיווח SEC נכון ל-${he(r.date)}</span>
            </div>
            <div class="rep-rpo-body">
                <div class="rep-rpo-main">
                    <span class="rep-rpo-val">${_repFmtMoney(r.total, cur)}</span>
                    <div class="rep-rpo-chips">${chip('רבעוני', qoq)}${chip('שנתי', yoy)}</div>
                </div>
                <p class="rep-rpo-note">הערך הכולל של חוזים חתומים שההכנסה מהם עדיין לא נרשמה בדוח — אינדיקטור מקדים לביקוש עתידי. עלייה = צבר מתחזק.</p>
            </div>
        </div>`;
}
// ── Credit-quality grade — "bond rating" derived from the real balance sheet ──
// Official S&P/Moody's/Fitch ratings are licensed and not freely available, so this is a
// TRANSPARENT credit-quality assessment computed from the same metrics agencies weight most:
// leverage (Net Debt / EBITDA), liquidity (current ratio) and solvency (debt/equity). Mapped
// to an investment-grade-style band, clearly labeled as derived (not an agency rating).
function _repCreditHtml(m) {
    const rows = Array.isArray(m.rows) ? m.rows : [];
    const latest = m.latest || rows[0];
    if (!latest) return '';
    const isNum = (x) => typeof x === 'number' && isFinite(x);
    // TTM EBITDA (sum of last 4 quarters) — the credit denominator.
    const ttm = rows.slice(0, 4);
    const ttmEbitda = (ttm.length === 4 && ttm.every(r => isNum(r.ebitda))) ? ttm.reduce((s, r) => s + r.ebitda, 0) : null;
    const netDebt = isNum(latest.netDebt) ? latest.netDebt : null;
    const cr = isNum(latest.currentRatio) ? latest.currentRatio : null;
    const de = isNum(latest.debtToEquity) ? latest.debtToEquity : null;
    // Need at least leverage OR solvency to say anything.
    const lev = (netDebt != null && ttmEbitda != null && ttmEbitda > 0) ? netDebt / ttmEbitda : null;
    if (lev == null && de == null) return '';

    // Cash runway for cash-burners: cash on hand ÷ TTM free-cash-flow burn.
    const cash = isNum(latest.cash) ? latest.cash : null;
    const ttmFcf = (ttm.length === 4 && ttm.every(r => isNum(r.fcf))) ? ttm.reduce((s, r) => s + r.fcf, 0) : null;
    const runwayYrs = (ttmFcf != null && ttmFcf < 0 && cash != null && cash > 0) ? cash / -ttmFcf : null;

    // Band by leverage (primary), nudged by liquidity. Net cash = strongest.
    let tier, special = null;
    const netCash = netDebt != null && netDebt < 0;
    if (ttmEbitda != null && ttmEbitda <= 0) {
        if (netCash) {
            // No net debt — the credit question is the BURN RATE, not leverage. Calling
            // a company sitting on net cash "מינוף כבד" was simply wrong.
            const strong = runwayYrs == null ? (cr != null && cr >= 2) : runwayYrs >= 2;
            tier = strong ? 3 : 4;
            const rwTxt = runwayYrs != null
                ? (runwayYrs >= 1 ? `~${runwayYrs.toFixed(1)} שנים` : `~${Math.max(1, Math.round(runwayYrs * 12))} חודשים`)
                : null;
            special = {
                label: 'EBITDA שלילי · עודף מזומן — הסיכון בקצב השריפה' + (rwTxt ? ` (אורך נשימה ${rwTxt})` : ''),
                cls: strong ? 'mid' : 'weak',
            };
        } else tier = 5;
    }
    else if (netCash || (lev != null && lev < 1)) tier = 0;
    else if (lev != null && lev < 2) tier = 1;
    else if (lev != null && lev < 3) tier = 2;
    else if (lev != null && lev < 4.5) tier = 3;
    else if (lev != null) tier = 4;
    else tier = (de != null && de < 1) ? 1 : (de != null && de < 2) ? 2 : 3; // no EBITDA → judge by D/E
    if (cr != null && cr < 1 && tier < 4) tier += 1;  // liquidity stress → one notch down

    const BANDS = [
        { label: 'איתנות פיננסית מצוינת · דמוי AAA–AA', cls: 'excellent' },
        { label: 'איתנות גבוהה · דירוג השקעה (דמוי A)', cls: 'good' },
        { label: 'איתנות טובה · דירוג השקעה (דמוי BBB)', cls: 'good' },
        { label: 'מינוף מוגבר · תשואה גבוהה (דמוי BB)', cls: 'mid' },
        { label: 'מינוף גבוה / ספקולטיבי · דמוי B', cls: 'weak' },
        { label: 'מינוף כבד · EBITDA שלילי · סיכון אשראי גבוה', cls: 'bad' },
    ];
    const b = special || BANDS[Math.min(tier, 5)];
    const cur = m.currency === 'ILS' ? '₪' : '$';
    const metric = (lbl, val) => val == null ? '' : `<span class="rep-cr-metric"><span class="rep-cr-mlabel">${lbl}</span><b>${val}</b></span>`;
    const levTxt = lev != null ? `${lev < 0 ? 'עודף מזומן' : lev.toFixed(1) + 'x'}` : (netCash ? 'עודף מזומן' : null);
    const runwayTxt = runwayYrs != null
        ? (runwayYrs >= 1 ? runwayYrs.toFixed(1) + ' שנים' : Math.max(1, Math.round(runwayYrs * 12)) + ' חודשים')
        : null;
    return `
        <div class="rep-cr-card rep-cr-${b.cls}">
            <div class="rep-cr-head">
                <span class="rep-cr-title">דירוג אשראי — הערכת איתנות</span>
                <span class="rep-cr-grade">${b.label}</span>
            </div>
            <div class="rep-cr-metrics">
                ${metric('חוב נטו / EBITDA', levTxt)}
                ${metric('יחס שוטף', cr != null ? cr.toFixed(2) : null)}
                ${metric('חוב / הון', de != null ? de.toFixed(2) : null)}
                ${metric('חוב נטו', netDebt != null ? _repFmtMoney(netDebt, cur) : null)}
                ${metric('אורך נשימה (מזומן ÷ שריפה)', runwayTxt)}
            </div>
            <p class="rep-cr-note">הערכת איכות-אשראי המחושבת ממבנה המאזן והתזרים בדוח — מינוף, נזילות ויחס חוב/הון (המדדים שסוכנויות הדירוג משקללות). אינה דירוג רשמי של S&amp;P / Moody's.</p>
        </div>`;
}

// ── Business segments — the divisions a company operates in + quarterly revenue each ──
// Lazy-loaded from /api/segments (FMP product + geographic, Supabase-cached). Rendered as
// two compact tables (segment rows × quarter columns) with a YoY-style latest-vs-first trend.
async function _repLoadSegments(m) {
    const el = document.getElementById('repSegments');
    if (!el || !m || !m.symbol) return;
    el.innerHTML = `<div class="rep-section-title">סגמנטים עסקיים — הכנסה לפי חטיבה</div>
        <div class="rep-ai-loading"><div class="rep-spinner"></div>טוען חלוקת הכנסות לפי סגמנט…</div>`;
    try {
        const r = await fetch(`/api/technicals?mode=segments&symbol=${encodeURIComponent(m.symbol)}&v=1`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (document.getElementById('repSegments') !== el || !_repCurrent || _repCurrent.symbol !== m.symbol) return; // navigated away
        const cur = m.currency === 'ILS' ? '₪' : '$';
        const blocks = [
            _repSegTable('חלוקה לפי מוצר / שירות', j.product, cur),
            _repSegTable('חלוקה גיאוגרפית', j.geographic, cur),
        ].filter(Boolean);
        el.innerHTML = blocks.length
            ? `<div class="rep-section-title">סגמנטים עסקיים — הכנסה לפי חטיבה</div>${blocks.join('')}
               <div class="rep-seg-foot">חלוקת ההכנסות כפי שדווחה בדוחות · מוצג עד 5 רבעונים אחרונים${j.cached ? '' : ' · נטען זה עתה'}</div>`
            : ''; // nothing to show → hide the whole section
    } catch (e) {
        if (document.getElementById('repSegments') === el) el.innerHTML = '';
    }
}
function _repSegTable(title, segs, cur) {
    if (!Array.isArray(segs) || !segs.length) return '';
    // Union of period dates across segments, chronological, last 5.
    const dates = [...new Set(segs.flatMap(s => (s.points || []).map(p => p.date)))].sort().slice(-5);
    if (!dates.length) return '';
    const shortD = (d) => { const s = String(d); const m2 = s.match(/(\d{4})-(\d{2})/); return m2 ? `${m2[2]}/${m2[1].slice(2)}` : s; };
    const head = dates.map(d => `<th>${shortD(d)}</th>`).join('');
    const rows = segs.map(s => {
        const byDate = {}; (s.points || []).forEach(p => { byDate[p.date] = p.value; });
        const cells = dates.map(d => `<td>${byDate[d] != null ? _repFmtMoney(byDate[d], cur) : '—'}</td>`).join('');
        // trend: latest vs earliest available in the window
        const vals = dates.map(d => byDate[d]).filter(v => v != null);
        const trend = (vals.length >= 2 && vals[0] !== 0) ? (vals[vals.length - 1] - vals[0]) / Math.abs(vals[0]) : null;
        const tChip = trend == null ? '' : `<span class="rep-seg-trend ${trend >= 0 ? 'pos' : 'neg'}">${trend >= 0 ? '▲' : '▼'} ${trend >= 0 ? '+' : ''}${(trend * 100).toFixed(0)}%</span>`;
        return `<tr><td class="rep-seg-name">${_repEscape(s.name)}${tChip}</td>${cells}</tr>`;
    }).join('');
    return `<div class="rep-seg-block">
        <div class="rep-seg-title">${_repEscape(title)}</div>
        <div class="risk-table-scroll">
        <table class="risk-table rep-table rep-seg-tbl">
            <thead><tr><th class="rep-metric-name">סגמנט</th>${head}</tr></thead>
            <tbody>${rows}</tbody>
        </table></div>
    </div>`;
}
function _repEscape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
if (typeof window !== 'undefined') window._repLoadSegments = _repLoadSegments;

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
    // No usable financials (common for partially-covered ת"א names) → a clean message instead of a
    // skeleton full of "—" and endless AI spinners. The IL list hides the name once prefetch confirms it.
    if (!_repHasData(m)) {
        const il = m.market === 'il' || /\.TA$/.test(m.symbol || '');
        body.innerHTML = `
        <div class="rep-detail" dir="rtl">
            <div class="rep-detail-top"><button class="macro-back-btn" onclick="backToReportsList()">→ חזרה לרשימה</button></div>
            <div class="rep-head"><div class="rep-head-id">
                <div class="rep-head-name">${m.companyName || m.symbol}</div>
                <div class="rep-head-sub">${m.symbol.replace(/\.TA$/, '')}${m.sector ? ' · ' + m.sector : ''}</div>
            </div></div>
            <div class="adv-empty">אין כרגע נתונים פיננסיים זמינים לחברה זו${il ? ' — הכיסוי למניות ת"א חלקי. החברה תוסתר מהרשימה ותחזור אוטומטית כשיהיו נתונים.' : '.'}</div>
        </div>`;
        return;
    }
    _repPeersLoaded = false; // fresh peer-comparison per company
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
            <button class="rep-watch-btn ${_repIsWatched(m.symbol) ? 'on' : ''}" id="repWatchDetailBtn" onclick="_repToggleWatch('${m.symbol}')">${_repIsWatched(m.symbol) ? '★ במעקב' : '☆ הוסף למעקב'}</button>
            <button class="rep-tech-link" onclick="openTechnicalForTicker('${m.symbol}')" title="פתח את ${(m.companyName || m.symbol).replace(/'/g, '')} בניתוח הטכני">📈 ניתוח טכני →</button>
            <button class="rep-web-link" onclick="_repOpenWebsite('${m.symbol}', this)" title="פתח את האתר הרשמי של ${(m.companyName || m.symbol).replace(/'/g, '')}">🔗 אתר החברה →</button>
        </div>

        <div class="rep-head">
            <div class="rep-head-id">
                <div class="rep-head-name">${m.companyName || m.symbol}</div>
                <div class="rep-head-sub">${m.symbol.replace(/\.TA$/, '')}${m.sector ? ' · ' + m.sector : ''}${(m.reportedDate && m.asOf && m.reportedDate >= m.asOf) ? ' · דוח אחרון פורסם: ' + _repHeDate(m.reportedDate) : (m.asOf ? ' · דוח אחרון: ' + _repHeDate(m.asOf) : '')}</div>
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
            ${(() => {
        // Guard: a cached PAST date must never render as the "next" report (Yahoo returns
        // the last report date for small caps whose next earnings isn't scheduled yet).
        const t = new Date().toISOString().slice(0, 10);
        const ne = (m.nextEarningsDate && String(m.nextEarningsDate).slice(0, 10) >= t) ? m.nextEarningsDate : null;
        return `<div class="rep-keyfig rep-keyfig-earn"><span class="rep-keyfig-label">מועד הדוח הבא</span><span class="rep-keyfig-val">${ne ? _repHeDate(ne) + (m.earningsIsEstimate ? ' <span class="rep-est">משוער</span>' : '') : '<span class="rep-est">טרם נקבע</span>'}</span></div>`;
    })()}
        </div>

        ${_repCreditHtml(m)}

        ${_repRpoHtml(m)}

        ${m.market !== 'il' ? '<div class="rep-seg-section" id="repSegments"></div>' : ''}

        <div class="rep-peers-cta">
            <button class="rep-peers-btn" onclick="_repTogglePeers()">
                📊 השוואת מכפילים מול הסקטור${m.sector ? ' · ' + m.sector : ''}
                <span class="rep-peers-chev" id="repPeersChev">▾</span>
            </button>
            <span class="rep-peers-hint">P/E · P/B · P/S · EV/EBITDA · ROE מול חברות באותו ענף</span>
        </div>
        <div id="repPeersPanel" class="rep-peers-panel" style="display:none"></div>

        <div class="rep-ai-sec" id="repSecSummary">
            <div class="rep-section-title">סיכום קצר</div>
            <div id="repSummary" class="rep-summary"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר סיכום עסקי…</div></div>
        </div>

        ${kp.length ? `<div class="rep-section-title">נקודות מפתח מהדוח</div>
        <ul class="rep-keypoints">${keyPointsHtml}</ul>` : ''}

        <div class="rep-section-title">דגלי סיכון</div>
        <div class="rep-flags">${flagsHtml}</div>

        ${(m.attentionNotes && m.attentionNotes.length) ? `
        <div class="rep-section-title">הערות לתשומת לב</div>
        <div class="rep-attention">
            ${m.attentionNotes.map((n, i) => `<div class="rep-attn rep-attn-${n.severity}"><span class="rep-attn-dot"></span><span>${n.he}<span class="rep-attn-why" data-attn-why="${i}"></span></span></div>`).join('')}
        </div>` : ''}

        ${(m.accountingNotes && m.accountingNotes.length) ? `
        <div class="rep-section-title">ביאורים — סעיפים המשפיעים על הרווח הנקי</div>
        <div class="rep-notes-sub">סעיפים שמאחורי המספרים, המחושבים ישירות מהדוחות: השקעה/מימוש רכוש קבוע (מכונות וציוד), פחת, סעיפים חד-פעמיים, מס, חוב, רכישה עצמית ומו"פ.</div>
        <div class="rep-notes">
            ${m.accountingNotes.map(n => `<div class="rep-note rep-note-${n.tone}"><span class="rep-note-dot"></span><span>${n.he}</span></div>`).join('')}
        </div>` : ''}

        <div class="rep-section-title">פרמטרים מרכזיים — עד 4 רבעונים</div>
        <div class="risk-table-scroll">
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
                ${metricRow('RPO', fmM, 'rpo', null, 'צבר הזמנות חוזי — ערך העסקאות שנחתמו וטרם הוכרו כהכנסה (דיווח SEC)')}
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

        <div class="rep-ai-sec" id="repSecSwot">
            <div class="rep-section-title">ניתוח SWOT</div>
            <div id="repSwot" class="rep-swot"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח SWOT…</div></div>
        </div>

        <div class="rep-ai-sec" id="repSecStrategy">
            <div class="rep-section-title">אסטרטגיה וויז'ן</div>
            <div id="repStrategy" class="rep-strategy"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח אסטרטגי…</div></div>
        </div>

        <div class="rep-ai-sec" id="repSecRisks">
            <div class="rep-section-title">תלות בספקים וסיכונים גיאופוליטיים</div>
            <div id="repRisks" class="rep-strategy"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח סיכונים…</div></div>
        </div>
    </div>`;

    _repRenderCharts(m, cur);
}

// ── Next-earnings date + sector peer-multiples comparison ──
function _repEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _repHeDate(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}
function _repMedian(arr) {
    const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
let _repPeersLoaded = false;
function _repTogglePeers() {
    const panel = document.getElementById('repPeersPanel');
    const chev = document.getElementById('repPeersChev');
    if (!panel) return;
    const show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    if (chev) chev.textContent = show ? '▴' : '▾';
    if (show && !_repPeersLoaded) _repLoadPeers();
}
async function _repLoadPeers() {
    const panel = document.getElementById('repPeersPanel');
    const m = _repCurrent;
    if (!panel || !m) return;
    panel.innerHTML = '<div class="rep-ai-loading"><div class="rep-spinner"></div>טוען השוואת מכפילים לסקטור…</div>';
    // Same-sector peers from the already-loaded universe (the board groups by sector).
    const secMap = _repSectors[_repMarket] || {};
    const mySec = secMap[m.symbol];
    let peers = mySec ? Object.keys(secMap).filter(t => t !== m.symbol && secMap[t] === mySec) : [];
    peers = peers.slice(0, 14);
    if (!peers.length) {
        panel.innerHTML = '<div class="rep-peers-empty">לא נמצאו חברות באותו סקטור להשוואה.</div>';
        _repPeersLoaded = true;
        return;
    }
    try {
        const r = await fetch(`/api/technicals?mode=peers&symbol=${encodeURIComponent(m.symbol)}&market=${_repMarket}&peers=${encodeURIComponent(peers.join(','))}&rv=1`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('peers ' + r.status);
        const data = await r.json();
        _repPeersLoaded = true;
        _repRenderPeers(data, m);
    } catch (e) {
        panel.innerHTML = '<div class="rep-peers-empty">לא ניתן לטעון השוואת מכפילים כרגע. נסה שוב מאוחר יותר.</div>';
    }
}
function _repRenderPeers(data, m) {
    const panel = document.getElementById('repPeersPanel');
    if (!panel) return;
    const base = data.base || null;
    const peers = Array.isArray(data.peers) ? data.peers : [];
    if (!base && !peers.length) {
        panel.innerHTML = '<div class="rep-peers-empty">אין נתוני מכפילים זמינים להשוואה בסקטור זה (כיסוי הנתונים חלקי בעיקר במניות קטנות / ת"א).</div>';
        return;
    }
    const all = [...(base ? [base] : []), ...peers];
    const med = {
        pe: _repMedian(all.map(x => x.pe)), pb: _repMedian(all.map(x => x.pb)), ps: _repMedian(all.map(x => x.ps)),
        ev: _repMedian(all.map(x => x.evToEbitda)), roe: _repMedian(all.map(x => x.roe)),
    };
    const f = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);
    const fRoe = (v) => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
    const fCap = (v) => (v == null || !isFinite(v)) ? '—' : (v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(0) + 'M' : '$' + Math.round(v));
    // Colour the BASE row vs the sector median (lower P/E·P/B·P/S·EV = cheaper = green; higher ROE = green).
    const cls = (v, mv, lowerBetter) => {
        if (v == null || mv == null || !isFinite(v) || !isFinite(mv)) return '';
        return (lowerBetter ? v < mv : v > mv) ? 'rep-peer-good' : 'rep-peer-bad';
    };
    const row = (s, isBase) => `<tr class="${isBase ? 'rep-peer-base' : ''}">
        <td class="rep-peer-name">${isBase ? '★ ' : ''}${_repEsc(s.name || s.symbol)} <span class="rep-peer-tk">${_repEsc((s.symbol || '').replace(/\.TA$/, ''))}</span></td>
        <td class="${isBase ? cls(s.pe, med.pe, true) : ''}">${f(s.pe)}</td>
        <td class="${isBase ? cls(s.pb, med.pb, true) : ''}">${f(s.pb, 2)}</td>
        <td class="${isBase ? cls(s.ps, med.ps, true) : ''}">${f(s.ps, 2)}</td>
        <td class="${isBase ? cls(s.evToEbitda, med.ev, true) : ''}">${f(s.evToEbitda)}</td>
        <td class="${isBase ? cls(s.roe, med.roe, false) : ''}">${fRoe(s.roe)}</td>
        <td>${fCap(s.marketCap)}</td></tr>`;
    panel.innerHTML = `
        <div class="rep-peers-head">השוואת מכפילים מול ${peers.length} חברות בסקטור${m && m.sector ? ' · ' + _repEsc(m.sector) : ''} · מקור: Yahoo</div>
        <div class="risk-table-scroll">
        <table class="risk-table rep-peers-table">
            <thead><tr><th>חברה</th><th>P/E</th><th>P/B</th><th>P/S</th><th>EV/EBITDA</th><th>ROE</th><th>שווי שוק</th></tr></thead>
            <tbody>
                ${base ? row(base, true) : ''}
                <tr class="rep-peer-median"><td>חציון הסקטור</td><td>${f(med.pe)}</td><td>${f(med.pb, 2)}</td><td>${f(med.ps, 2)}</td><td>${f(med.ev)}</td><td>${fRoe(med.roe)}</td><td>—</td></tr>
                ${peers.map(p => row(p, false)).join('')}
            </tbody>
        </table></div>
        <div class="rep-peers-legend">★ = החברה הנוכחית. צבע ירוק/אדום במכפילי החברה = זול/יקר ביחס לחציון הסקטור (ב-ROE: ירוק = גבוה מהחציון). חברות מוצגות לפי שווי שוק יורד.</div>`;
}
if (typeof window !== 'undefined') window._repTogglePeers = _repTogglePeers;

function _repQuarterLabel(q) {
    if (!q) return '';
    // Label by the CALENDAR period-end date, NOT the source's FISCAL period/year. Off-calendar filers
    // (e.g. NVDA — its quarter ending Jul-2026 is "fiscal Q2 2027" at FMP) otherwise show a confusing
    // future year. Calendar quarter = by the month the period ENDED in; year = that date's year.
    if (q.date && /^\d{4}-\d{2}/.test(q.date)) {
        if (q.period === 'FY') return q.date.slice(0, 4);
        const yy = q.date.slice(2, 4);
        const cq = Math.ceil(parseInt(q.date.slice(5, 7), 10) / 3);
        return `Q${cq} ${yy}'`;
    }
    if (q.period && q.fiscalYear && q.period !== 'FY') return `${q.period} ${String(q.fiscalYear).slice(-2)}'`;
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
                x: { ticks: { color: _repChartTheme().tick, font: { size: 9 } }, grid: { display: false } },
                y: { ticks: { color: _repChartTheme().tick, font: { size: 9 }, callback: (val) => _repFmtMoney(val, cur) }, grid: { color: _repChartTheme().grid } },
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
    _REP_CHARTS.forEach(c => _repBarChart(c.canvas, mk(c.key), _repChartColor(c), cur));
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
            data: { labels: series.map(s => s.label), datasets: [{ data: series.map(s => s.value), backgroundColor: _repChartColor(def), borderRadius: 4, maxBarThickness: 64 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => _repFmtMoney(c.parsed.y, cur) } } },
                scales: {
                    x: { ticks: { color: _repChartTheme().tick, font: { size: 13 } }, grid: { display: false } },
                    y: { ticks: { color: _repChartTheme().tick, font: { size: 13 }, callback: (val) => _repFmtMoney(val, cur) }, grid: { color: _repChartTheme().grid } },
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
// Durable per-company cache: the analysis is generated ONCE per quarterly report (keyed by
// symbol + report date) and then served from localStorage on every later view — so we don't
// re-call Gemini (whose free tier is rate-limited) for a report we already analyzed. One
// gentle retry on a transient/rate failure; no retry storm (that only triggers more 429s).
function _repAiCacheKey(m) { return `rep_ai_v4_${m.symbol}_${m.asOf || 'na'}`; }
// Fill an AI section, and hide its whole section (title included) when there's nothing to show —
// "what we have no data on simply doesn't appear", rather than an empty heading or a placeholder.
function _repSetAiSec(containerId, wrapperId, html) {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = html || '';
    const wrap = document.getElementById(wrapperId);
    if (wrap) wrap.style.display = (html && html.trim()) ? '' : 'none';
}
// ── Deterministic SWOT — computed straight from the report's own numbers ──
// EVERY company with data gets a structured SWOT even when the AI is rate-limited:
// strengths/weaknesses from the engine's key points + profitability/growth/FCF,
// opportunities from valuation + buyback/R&D notes + the next report date,
// threats from the engine's risk flags + beta/multiple sensitivity.
function _repFallbackSwot(m) {
    const S = [], W = [], O = [], T = [];
    const v = m.valuation || {};
    const q = (m.rows && m.rows[0]) || {};
    const pct = (x) => (x != null && isFinite(x)) ? (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%' : null;
    if (m.beat && m.beat.improved) S.push(m.beat.label || 'שיפור תוצאות מול הרבעון המקביל אשתקד');
    if (v.roeTTM != null && v.roeTTM >= 0.15) S.push('תשואה גבוהה על ההון: ROE ‏' + pct(v.roeTTM));
    if (q.yoyRevenue != null && q.yoyRevenue >= 0.10) S.push('צמיחת הכנסות של ' + pct(q.yoyRevenue) + ' ברבעון האחרון לעומת אשתקד');
    if (v.fcfYield != null && v.fcfYield >= 0.04) S.push('תזרים מזומנים חופשי חזק: תשואת FCF ‏' + pct(v.fcfYield));
    (m.keyPoints || []).filter(p => p && p.tone === 'good').forEach(p => { if (S.length < 5 && !S.includes(p.he)) S.push(p.he); });
    (m.keyPoints || []).filter(p => p && p.tone === 'bad').forEach(p => { if (W.length < 4) W.push(p.he); });
    if (q.yoyRevenue != null && q.yoyRevenue < -0.02) W.push('ירידת הכנסות של ' + pct(q.yoyRevenue) + ' לעומת אשתקד');
    if (v.fcfYield != null && v.fcfYield < 0) W.push('תזרים מזומנים חופשי שלילי — החברה שורפת מזומן');
    if (v.roeTTM != null && v.roeTTM < 0) W.push('תשואה שלילית על ההון — הפסדים ברמת השורה התחתונה');
    (m.accountingNotes || []).filter(n => n && n.tone === 'good').forEach(n => { if (O.length < 2) O.push(n.he); });
    if (v.peTrailing != null && v.peTrailing > 0 && v.peTrailing <= 15) O.push('תמחור נוח יחסית: מכפיל רווח ' + v.peTrailing.toFixed(1) + ' — מרווח ביטחון בשיערוך');
    if (v.evToEbitda != null && v.evToEbitda > 0 && v.evToEbitda <= 10) O.push('EV/EBITDA נמוך ‏(' + v.evToEbitda.toFixed(1) + ') — פוטנציאל לסגירת פער מול הסקטור');
    if (m.nextEarningsDate && String(m.nextEarningsDate).slice(0, 10) >= new Date().toISOString().slice(0, 10)) O.push('הדוח הבא ב-' + _repHeDate(m.nextEarningsDate) + ' — קטליזטור קרוב להמשך המומנטום');
    (m.flags || []).filter(f => f && f.severity && f.severity !== 'ok').forEach(f => { if (T.length < 3) T.push(f.he); });
    if (m.beta != null && isFinite(m.beta) && m.beta >= 1.4) T.push('ביתא גבוהה ‏(' + Number(m.beta).toFixed(2) + ') — רגישות מוגברת לירידות שוק');
    if (v.peTrailing != null && v.peTrailing >= 35) T.push('מכפיל רווח גבוה ‏(' + v.peTrailing.toFixed(0) + ') — תמחור שדורש עמידה בציפיות; אכזבה בדוח תתומחר בחדות');
    const cap = (a, fb) => { const out = a.filter(Boolean).slice(0, 4); return out.length ? out : [fb]; };
    return {
        strengths: cap(S, 'לא זוהו חוזקות בולטות בנתוני הדוח האחרון'),
        weaknesses: cap(W, 'לא זוהו חולשות מהותיות בנתוני הדוח האחרון'),
        opportunities: cap(O, 'שיפור עקבי בתוצאות עשוי להוביל לשיערוך כלפי מעלה'),
        threats: cap(T, 'סיכוני מאקרו וענף כלליים' + (m.sector ? ' — ' + m.sector : '')),
    };
}
function _repFallbackSwotHtml(m) {
    return _repSwotHtml(_repFallbackSwot(m)) +
        '<div class="rep-ai-fallback-note">ניתוח מובנה המחושב ישירות מנתוני הדוח · ניתוח ה-AI המורחב יתווסף אוטומטית כשהשרת פנוי</div>';
}

function _repApplyAI(j, m) {
    const swot = j.swot || {};
    const swotHasContent = ['strengths', 'weaknesses', 'opportunities', 'threats'].some(k => Array.isArray(swot[k]) && swot[k].length);
    _repSetAiSec('repSummary', 'repSecSummary', _repSummaryHtml(j.summary || {}));
    _repSetAiSec('repSwot', 'repSecSwot', swotHasContent ? _repSwotHtml(swot) : (m ? _repFallbackSwotHtml(m) : ''));
    _repSetAiSec('repStrategy', 'repSecStrategy', _repStrategyHtml(j.strategy || {}));
    _repSetAiSec('repRisks', 'repSecRisks', _repRisksHtml(j.risks || {}));
    const exps = Array.isArray(j.declineExplanations) ? j.declineExplanations : [];
    document.querySelectorAll('[data-attn-why]').forEach(el => {
        const i = parseInt(el.getAttribute('data-attn-why'), 10);
        if (exps[i]) el.textContent = ' — ' + exps[i];
    });
}
async function _repLoadAI(m, attempt) {
    attempt = attempt || 0;
    const summaryEl = document.getElementById('repSummary');
    const stillHere = () => document.getElementById('repSummary') === summaryEl && summaryEl;

    // 1) Serve from the durable cache instantly when we've already analyzed this report.
    if (attempt === 0) {
        try {
            const cached = JSON.parse(localStorage.getItem(_repAiCacheKey(m)) || 'null');
            if (cached && cached.swot) { _repApplyAI(cached, m); return; }
        } catch (e) { /* ignore */ }
    }
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
        _repApplyAI(j, m);
        try { localStorage.setItem(_repAiCacheKey(m), JSON.stringify(j)); } catch (e) { /* quota — fine */ }
    } catch (e) {
        if (!stillHere()) return;
        // The SWOT is NEVER empty: show the deterministic, report-data SWOT right away —
        // if the AI succeeds on retry it simply replaces it with the richer version.
        _repSetAiSec('repSwot', 'repSecSwot', _repFallbackSwotHtml(m));
        // ONE gentle retry after a longer wait (lets a rate/overload window pass).
        if (attempt < 1) {
            const note = `<div class="rep-ai-loading"><div class="rep-spinner"></div>שרת ה-AI עמוס כרגע — מנסה שוב בעוד מספר שניות…</div>`;
            if (summaryEl) summaryEl.innerHTML = note;
            _repSetAiSec('repStrategy', 'repSecStrategy', ''); _repSetAiSec('repRisks', 'repSecRisks', '');
            setTimeout(() => { if (stillHere()) _repLoadAI(m, attempt + 1); }, 9000);
            return;
        }
        const is429 = /429|RESOURCE_EXHAUSTED/i.test(e.message || '');
        const msg = is429
            ? '<div class="adv-empty">מכסת ה-AI היומית/דקתית של Gemini מוצתה כרגע. ניתוח ה-SWOT המוצג חושב ישירות מנתוני הדוח; הניתוח המורחב יתחדש מאליו בהמשך.</div>'
            : '<div class="adv-empty">ניתוח ה-AI המורחב אינו זמין כרגע — מוצג ניתוח מובנה מנתוני הדוח. נסה לרענן בעוד מספר דקות.</div>';
        if (summaryEl) summaryEl.innerHTML = msg;
        _repSetAiSec('repStrategy', 'repSecStrategy', ''); _repSetAiSec('repRisks', 'repSecRisks', '');
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
    return html || ''; // empty → the whole "סיכום קצר" section is hidden by _repSetAiSec
}
function _repRisksHtml(rk) {
    rk = rk || {};
    const part = (label, txt) => txt ? `<div class="rep-strat-part"><span class="rep-strat-label">${label}</span><p>${txt}</p></div>` : '';
    const html = `${part('תלות בספקים ובלקוחות', rk.supplierDependency)}${part('חשיפה גיאופוליטית', rk.geopolitical)}`;
    return html || ''; // empty → the whole risks section is hidden by _repSetAiSec
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

// Open the financial report for ANY ticker (works for non-S&P names too — the detail fetch is
// symbol-based, not universe-gated). Used by the Scanner Agent / other pages to deep-link a stock.
function openReportForTicker(ticker) {
    const sym = String(ticker || '').trim().toUpperCase();
    if (!sym) return;
    // Suppress intermediate history writes → ONE clean entry, so Back returns to where the user came from.
    if (typeof window !== 'undefined' && typeof window._navSuppressURL === 'function') window._navSuppressURL(true);
    try {
        if (typeof closeStockRecommendations === 'function') closeStockRecommendations();
        // Close every OTHER routed page so EXACTLY ONE is active. Leaving the source page (LHE/scanner/…)
        // active behind the reports page is what produced the broken "dashboard over the reports" state
        // after the browser Back button.
        if (typeof _VIEW_PAGES !== 'undefined' && Array.isArray(_VIEW_PAGES)) {
            _VIEW_PAGES.forEach(pg => {
                if (pg.view !== 'reports' && document.getElementById(pg.id)?.classList.contains('active')) {
                    try { pg.close(); } catch (e) { /* best effort */ }
                }
            });
        }
        if (typeof closeFullPortfolioList === 'function' && document.querySelector('.full-list-page')) closeFullPortfolioList();
        const mo = document.getElementById('modalOverlay');
        if (mo && mo.classList.contains('active')) {
            mo.classList.remove('active');
            if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
            try { currentModalClientId = null; } catch (e) { }
        }
        if (typeof openReportsPage === 'function') openReportsPage();
        _repMarket = sym.endsWith('.TA') ? 'il' : 'sp500';
        if (typeof openReportDetail === 'function') openReportDetail(sym);
    } finally {
        if (typeof window !== 'undefined' && typeof window._navSuppressURL === 'function') window._navSuppressURL(false);
    }
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym });
}

// Open the company's OFFICIAL website (from Yahoo assetProfile via the peers endpoint). Falls back
// to the Yahoo profile page if no website is on file, so every report links somewhere useful.
async function _repOpenWebsite(symbol, btn) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return;
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '🔗 טוען…'; }
    const restore = () => { if (btn) { btn.disabled = false; btn.textContent = label || '🔗 אתר החברה →'; } };
    let url = null;
    try {
        const r = await fetch(`/api/technicals?mode=peers&symbol=${encodeURIComponent(sym)}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        const w = j && j.base && j.base.website;
        if (w) url = /^https?:\/\//i.test(w) ? w : ('https://' + w);
    } catch (e) { }
    if (!url) url = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/profile`; // fallback
    window.open(url, '_blank', 'noopener');
    restore();
}

if (typeof window !== 'undefined') {
    window.openReportsPage = openReportsPage;
    window.openReportForTicker = openReportForTicker;
    window._repOpenWebsite = _repOpenWebsite;
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
