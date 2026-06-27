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
    us: { ls: 'rep_uni_us_v4', cur: '$', label: 'מניות (S&P 500 + Nasdaq-100)', search: 'חיפוש מניה (למשל: NVDA)…' },
    il: { ls: 'rep_uni_il_v4', cur: '₪', label: 'מניות (ת"א-125)', search: 'חיפוש מניה (למשל: TEVA)…' },
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
                <div id="repWatchBar" class="rep-intel"></div>
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

// ── Fresh scores from the 24/7 reports agent (Supabase `company_reports`) ──────────────
// The agent sweeps every company continuously, so a just-released report's updated score/beat
// lands here automatically — no need to open the company or wait for the per-ticker prefetch.
// Authoritative + fresh: overwrites the local score cache, then the on-demand prefetch only has
// to fill the few names the agent hasn't covered yet.
let _repSbSyncedAt = {};
async function _repSyncSupabaseReports(market) {
    if (Date.now() - (_repSbSyncedAt[market] || 0) < 5 * 60 * 1000) return; // re-sync at most every 5 min
    _repSbSyncedAt[market] = Date.now();
    if (typeof supabaseClient === 'undefined' || !supabaseClient) { _repSbSyncedAt[market] = 0; return; }
    try {
        const { data, error } = await supabaseClient
            .from('company_reports')
            .select('symbol,score,improved,as_of')
            .eq('market', market);
        if (error || !Array.isArray(data) || !data.length) { _repSbSyncedAt[market] = 0; return; }
        const cache = _repScoreCache();
        const now = Date.now();
        for (const r of data) {
            if (!r || !r.symbol) continue;
            cache[r.symbol] = { score: (r.score != null ? r.score : null), improved: !!r.improved, asOf: r.as_of || null, ts: now, src: 'agent' };
            if (r.score == null) cache[r.symbol].noData = true;
        }
        try { localStorage.setItem(_REP_SCORES_LS, JSON.stringify(cache)); } catch (e) { }
        // Live-update chips if we're still on this market's list.
        if (_repMarket === market && _repView === 'list') {
            for (const r of data) if (r.score != null) _repUpdateCardChip(r.symbol, r.score, !!r.improved);
        }
    } catch (e) { _repSbSyncedAt[market] = 0; }
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
    const market = _repMarket;
    const todayStr = new Date().toISOString().slice(0, 10);
    // Tickers the user actually holds (across all portfolios) → their upcoming earnings.
    const held = new Set();
    try { (typeof clients !== 'undefined' ? clients : []).forEach(c => (c.holdings || []).forEach(h => { if (h.type === 'stock' && h.ticker) held.add(String(h.ticker).toUpperCase()); })); } catch (e) { }
    try {
        const [statusRes, recentRes, earnRes] = await Promise.all([
            supabaseClient.from('agent_status').select('last_run,last_result').eq('agent', 'reports').maybeSingle(),
            supabaseClient.from('company_reports').select('symbol,score,improved,as_of,company_name').eq('market', market).order('as_of', { ascending: false }).limit(16),
            held.size ? supabaseClient.from('company_reports').select('symbol,company_name,next_earnings').in('symbol', [...held]).gte('next_earnings', todayStr).order('next_earnings', { ascending: true }).limit(12) : Promise.resolve({ data: [] }),
        ]);
        if (document.getElementById('repIntel') !== el || _repMarket !== market || _repView !== 'list') return;
        const st = statusRes && statusRes.data;
        const live = !!(st && st.last_run && (Date.now() - new Date(st.last_run).getTime() < 6 * 3600 * 1000));
        const cnt = (st && st.last_result && (st.last_result.match(/(\d+)\s*\/\s*\d+/) || [])[1]) || '';
        const statusHtml = `<div class="rep-intel-status">
            <span class="rep-live ${live ? 'on' : ''}"></span>
            <b>${live ? 'מנוע הדוחות פעיל 24/7' : 'מנוע הדוחות — בודק'}</b>
            <span class="rep-intel-sub">${cnt ? cnt + ' חברות מנותחות · ' : ''}${st && st.last_run ? 'עודכן ' + _repAgo(st.last_run) : ''}</span>
        </div>`;
        const recent = (recentRes && Array.isArray(recentRes.data)) ? recentRes.data : [];
        const chips = recent.filter(r => r && r.score != null).slice(0, 14).map(r => {
            const disp = market === 'il' ? String(r.symbol).replace(/\.TA$/, '') : r.symbol;
            const co = String(r.company_name || '').replace(/"/g, '');
            return `<button class="rep-new-chip" onclick="openReportDetail('${r.symbol}')" title="${co} · דוח ${_repHeDate(r.as_of)}">
                <span class="rep-new-tk">${disp}</span><span class="rep-card-score ${_repScoreClass(r.score)}">${r.score}</span>
            </button>`;
        }).join('');
        // 📅 Upcoming earnings of the user's own holdings (the most actionable strip for a manager).
        const earn = (earnRes && Array.isArray(earnRes.data)) ? earnRes.data.filter(e => e && e.next_earnings) : [];
        const earnChips = earn.map(e => {
            const disp = String(e.symbol).replace(/\.TA$/, '');
            const co = String(e.company_name || '').replace(/"/g, '');
            return `<button class="rep-new-chip rep-earn-chip" onclick="openReportForTicker('${e.symbol}')" title="${co} · מועד דוח ${_repHeDate(e.next_earnings)}">
                <span class="rep-new-tk">${disp}</span><span class="rep-earn-date">${_repHeDate(e.next_earnings)}</span>
            </button>`;
        }).join('');
        const earnHtml = earnChips ? `<div class="rep-new-strip rep-earn-strip"><span class="rep-new-lbl">📅 דוחות קרובים שלך</span><div class="rep-new-chips">${earnChips}</div></div>` : '';
        el.innerHTML = statusHtml + earnHtml + (chips ? `<div class="rep-new-strip"><span class="rep-new-lbl">🆕 דיווחו לאחרונה</span><div class="rep-new-chips">${chips}</div></div>` : '');
    } catch (e) { /* non-fatal */ }
}

// ── Watchlist (per-user, Supabase `watchlist` with RLS) ─────────────────────────────────────────
let _repWatch = new Set();        // watched symbols (UPPER)
let _repWatchMkt = {};            // symbol → market
function _repIsWatched(sym) { return _repWatch.has(String(sym).toUpperCase()); }

async function _repLoadWatch() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        const { data, error } = await supabaseClient.from('watchlist').select('symbol,market').order('created_at', { ascending: true });
        if (error) return;
        _repWatch = new Set((data || []).map(r => String(r.symbol).toUpperCase()));
        _repWatchMkt = {}; (data || []).forEach(r => { _repWatchMkt[String(r.symbol).toUpperCase()] = r.market || 'us'; });
        _repRenderWatchBar();
        _repRefreshStars();
    } catch (e) { /* not logged in / offline — fine */ }
}

async function _repRenderWatchBar() {
    const el = document.getElementById('repWatchBar');
    if (!el) return;
    const syms = [..._repWatch];
    if (!syms.length) { el.innerHTML = ''; return; }
    let info = {};
    try {
        const { data } = await supabaseClient.from('company_reports').select('symbol,score,company_name').in('symbol', syms);
        (data || []).forEach(r => { info[String(r.symbol).toUpperCase()] = r; });
    } catch (e) { /* show without scores */ }
    if (document.getElementById('repWatchBar') !== el) return;
    const chips = syms.map(s => {
        const r = info[s] || {};
        const disp = String(s).replace(/\.TA$/, '');
        const sc = (r.score != null) ? `<span class="rep-card-score ${_repScoreClass(r.score)}">${r.score}</span>` : '';
        return `<span class="rep-watch-chip" onclick="openReportForTicker('${s}')" title="${String(r.company_name || '').replace(/"/g, '')}">
            <span class="rep-new-tk">${disp}</span>${sc}
            <span class="rep-watch-x" onclick="event.stopPropagation(); _repToggleWatch('${s}')" title="הסר ממעקב">✕</span>
        </span>`;
    }).join('');
    el.innerHTML = `<div class="rep-new-strip rep-watch-strip"><span class="rep-new-lbl">⭐ המעקב שלי</span><div class="rep-new-chips">${chips}</div></div>`;
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
            const mkt = _repWatchMkt[symbol] || (/\.TA$/.test(symbol) ? 'il' : (_repMarket || 'us'));
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
if (typeof window !== 'undefined') { window._repToggleWatch = _repToggleWatch; window._repLoadWatch = _repLoadWatch; }

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
        if (now - (s.ts || 0) > TTL) return true; // re-check stale entries (data may have appeared since)
        return s.score == null && !s.noData;       // still need a score, and not already known-empty
    });
    if (!todo.length) return;

    let idx = 0;
    const CONCURRENCY = 4;
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

// ── Detail: fetch report on demand → engine → render ──
async function openReportDetail(symbol) {
    _repView = 'detail';
    _repDestroyCharts();
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports', mkt: _repMarket, sym: symbol });
    const body = document.getElementById('repBody');
    if (body) body.innerHTML = `<div class="rep-loading"><div class="rep-spinner"></div><span>טוען דו"ח עבור ${symbol.replace(/\.TA$/, '')}…</span></div>`;

    try {
        const r = await fetch(`/api/technicals?mode=report&symbol=${encodeURIComponent(symbol)}&market=${_repMarket}&rv=4`, { headers: { Accept: 'application/json' } });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            const msg = r.status === 429 ? 'מכסת ה-API היומית נוצלה — נסה שוב מאוחר יותר.'
                : r.status === 404 ? 'לא נמצאו נתונים פונדמנטליים לחברה זו.'
                : 'משיכת הדו"ח נכשלה.';
            if (r.status === 404 && _repMarket === 'il') _repSaveScore(symbol, { noData: true }); // remember → drops from the IL list
            if (body) body.innerHTML = `<div class="adv-empty">${msg}<br><button class="macro-back-btn" style="margin-top:12px" onclick="backToReportsList()">חזרה לרשימה</button></div>`;
            return;
        }
        const report = await r.json();
        const model = ReportsEngine.buildReport(report);
        _repCurrent = model;
        const hasData = _repHasData(model);
        if (model.score && model.score.value != null) _repSaveScore(symbol, { score: model.score.value, improved: model.beat && model.beat.improved });
        else if (!hasData && _repMarket === 'il') _repSaveScore(symbol, { noData: true });
        _repRenderDetail(model);         // a clean "no data" view is rendered when hasData is false
        if (hasData) _repLoadAI(model);  // async SWOT + strategy only when there's something to analyze
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
            ${m.nextEarningsDate ? `<div class="rep-keyfig rep-keyfig-earn"><span class="rep-keyfig-label">מועד הדוח הבא</span><span class="rep-keyfig-val">${_repHeDate(m.nextEarningsDate)}${m.earningsIsEstimate ? ' <span class="rep-est">משוער</span>' : ''}</span></div>` : ''}
        </div>

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
        <div class="risk-table-scroll" style="max-height:none">
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
function _repApplyAI(j) {
    const swot = j.swot || {};
    const swotHasContent = ['strengths', 'weaknesses', 'opportunities', 'threats'].some(k => Array.isArray(swot[k]) && swot[k].length);
    _repSetAiSec('repSummary', 'repSecSummary', _repSummaryHtml(j.summary || {}));
    _repSetAiSec('repSwot', 'repSecSwot', swotHasContent ? _repSwotHtml(swot) : '');
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
            if (cached && cached.swot) { _repApplyAI(cached); return; }
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
        _repApplyAI(j);
        try { localStorage.setItem(_repAiCacheKey(m), JSON.stringify(j)); } catch (e) { /* quota — fine */ }
    } catch (e) {
        if (!stillHere()) return;
        // ONE gentle retry after a longer wait (lets a rate/overload window pass).
        if (attempt < 1) {
            const note = `<div class="rep-ai-loading"><div class="rep-spinner"></div>שרת ה-AI עמוס כרגע — מנסה שוב בעוד מספר שניות…</div>`;
            if (summaryEl) summaryEl.innerHTML = note;
            _repSetAiSec('repSwot', 'repSecSwot', ''); _repSetAiSec('repStrategy', 'repSecStrategy', ''); _repSetAiSec('repRisks', 'repSecRisks', '');
            setTimeout(() => { if (stillHere()) _repLoadAI(m, attempt + 1); }, 9000);
            return;
        }
        const is429 = /429|RESOURCE_EXHAUSTED/i.test(e.message || '');
        const msg = is429
            ? '<div class="adv-empty">מכסת ה-AI היומית/דקתית של Gemini מוצתה כרגע. הניתוח יתחדש מאליו בהמשך — או רענן בעוד מספר דקות. (דוחות שכבר נותחו נשמרים ולא נטענים מחדש.)</div>'
            : '<div class="adv-empty">ניתוח ה-AI אינו זמין כרגע (שרת ג\'מיני עמוס). נסה לרענן בעוד מספר דקות.</div>';
        if (summaryEl) summaryEl.innerHTML = msg;
        _repSetAiSec('repSwot', 'repSecSwot', ''); _repSetAiSec('repStrategy', 'repSecStrategy', ''); _repSetAiSec('repRisks', 'repSecRisks', '');
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
    if (typeof closeScannerAgent === 'function') closeScannerAgent();
    if (typeof closeDecisionCore === 'function') closeDecisionCore();
    const mo = document.getElementById('modalOverlay');
    if (mo && mo.classList.contains('active')) { mo.classList.remove('active'); if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock(); }
    if (typeof openReportsPage === 'function') openReportsPage();
    setTimeout(() => { _repMarket = sym.endsWith('.TA') ? 'il' : 'us'; if (typeof openReportDetail === 'function') openReportDetail(sym); }, 70);
}

if (typeof window !== 'undefined') {
    window.openReportsPage = openReportsPage;
    window.openReportForTicker = openReportForTicker;
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
