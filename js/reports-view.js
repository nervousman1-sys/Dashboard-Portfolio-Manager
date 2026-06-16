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
    us: { ls: 'rep_uni_us', cur: '$', label: 'מניות (S&P 500 + Nasdaq-100)', search: 'חיפוש מניה (למשל: NVDA)…' },
    il: { ls: 'rep_uni_il', cur: '₪', label: 'ניירות (ת"א-125)', search: 'חיפוש נייר (למשל: TEVA)…' },
};
const _REP_SCORES_LS = 'rep_scores_v1';

let _repMarket = 'us';
let _repUniverse = { us: null, il: null };
let _repSearch = '';
let _repView = 'list';        // 'list' | 'detail'
let _repCurrent = null;       // current detail model
let _repCharts = [];          // live Chart.js instances to destroy on teardown

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
    if (typeof updateURLState === 'function') updateURLState({ view: 'reports' });
    if (typeof _setActiveNav === 'function') _setActiveNav('reports');

    _repMarket = 'us';
    _repView = 'list';
    _repRenderShell();
    window.scrollTo(0, 0);
    _repLoadUniverse();
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
            if (c && c.day === new Date().toISOString().slice(0, 10) && Array.isArray(c.tickers) && c.tickers.length) {
                _repUniverse[mkt] = c.tickers; _repRenderList(); return;
            }
        }
    } catch (e) { /* refetch */ }
    try {
        const r = await fetch(`/api/technicals?mode=tickers&market=${mkt}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        let tickers = (j.tickers || []).slice();
        // Drop index-tracking ETFs from IL — they have no financial statements.
        if (mkt === 'il') tickers = tickers.filter(t => /^[A-Z]/.test(t) && !/\d{3,}/.test(t));
        tickers.sort((a, b) => a.localeCompare(b));
        _repUniverse[mkt] = tickers;
        try { localStorage.setItem(cfg.ls, JSON.stringify({ day: new Date().toISOString().slice(0, 10), tickers })); } catch (e) { }
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

    const cards = list.map(t => {
        const disp = _repMarket === 'il' ? t.replace(/\.TA$/, '') : t;
        const s = scores[t];
        const chip = (s && s.score != null)
            ? `<span class="rep-card-score ${_repScoreClass(s.score)}">${s.score}</span>`
            : '<span class="rep-card-score rep-card-score-empty">—</span>';
        const beat = (s && s.improved) ? '<span class="rep-card-beat" title="שיפור מול תקופה קודמת">▲</span>' : '';
        return `<button class="rep-card" onclick="openReportDetail('${t}')">
            <span class="rep-card-ticker">${disp}${beat}</span>
            ${chip}
        </button>`;
    }).join('');

    body.innerHTML = `
        <div class="rep-grid">${cards || `<div class="adv-empty">אין חברות שתואמות "${_repSearch}".</div>`}</div>
        ${total ? `<div class="tech-foot">${total > CAP ? `מוצגות ${CAP} מתוך ${total} — חדד את החיפוש.` : `${total} חברות`}</div>` : ''}`;
}

// ── Detail: fetch report on demand → engine → render ──
async function openReportDetail(symbol) {
    _repView = 'detail';
    _repDestroyCharts();
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
    _repRenderList();
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
        const cells = rows.map(q => {
            const val = fmt(q[key]);
            const d = deltaKey ? q[deltaKey] : null;
            const dTxt = d != null ? `<span class="rep-delta ${_repDeltaClass(d)}">${_repFmtPct(d, true)}</span>` : '';
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
    const keyFig = (label, val) => `<div class="rep-keyfig"><span class="rep-keyfig-label">${label}</span><span class="rep-keyfig-val">${val}</span></div>`;

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
            ${keyFig('ביתא', _repFmtRatio(m.beta, 2))}
        </div>

        <div class="rep-section-title">דגלי סיכון</div>
        <div class="rep-flags">${flagsHtml}</div>

        <div class="rep-section-title">פרמטרים מרכזיים — עד 4 רבעונים</div>
        <div class="risk-table-scroll" style="max-height:none">
        <table class="risk-table rep-table">
            <thead><tr><th class="rep-metric-name">פרמטר</th>${qHead}</tr></thead>
            <tbody>
                ${metricRow('הכנסות', fmM, 'revenue', 'yoyRevenue')}
                ${metricRow('רווח גולמי', fmM, 'grossProfit')}
                ${metricRow('שיעור רווח גולמי', fmP, 'grossMargin')}
                ${metricRow('רווח תפעולי', fmM, 'operatingIncome')}
                ${metricRow('שיעור רווח תפעולי', fmP, 'operatingMargin')}
                ${metricRow('רווח נקי', fmM, 'netIncome', 'yoyNetIncome')}
                ${metricRow('שיעור רווח נקי', fmP, 'netMargin')}
                ${metricRow('רווח למניה (EPS)', fmE, 'eps', 'yoyEps')}
                ${metricRow('הון עצמי', fmM, 'totalEquity')}
                ${metricRow('סך התחייבויות', fmM, 'totalLiabilities')}
                ${metricRow('הון חוזר', fmM, 'workingCapital', null, 'נכסים שוטפים פחות התחייבויות שוטפות')}
                ${metricRow('יחס שוטף', fmR, 'currentRatio', null, 'נכסים שוטפים / התחייבויות שוטפות')}
                ${metricRow('מינוף (חוב/הון)', fmR, 'debtToEquity')}
                ${metricRow('תזרים תפעולי', fmM, 'operatingCashFlow')}
                ${metricRow('תזרים חופשי (FCF)', fmM, 'fcf', null, 'תזרים תפעולי פחות השקעות הוניות')}
            </tbody>
        </table>
        </div>

        <div class="rep-section-title">מגמות (8 רבעונים)</div>
        <div class="rep-charts">
            <div class="rep-chart-card"><div class="rep-chart-h">הכנסות</div><canvas id="repChartRev"></canvas></div>
            <div class="rep-chart-card"><div class="rep-chart-h">רווח נקי</div><canvas id="repChartNi"></canvas></div>
            <div class="rep-chart-card"><div class="rep-chart-h">תזרים חופשי (FCF)</div><canvas id="repChartFcf"></canvas></div>
        </div>

        <div class="rep-section-title">ניתוח SWOT</div>
        <div id="repSwot" class="rep-swot"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח SWOT…</div></div>

        <div class="rep-section-title">אסטרטגיה וויז'ן</div>
        <div id="repStrategy" class="rep-strategy"><div class="rep-ai-loading"><div class="rep-spinner"></div>מייצר ניתוח אסטרטגי…</div></div>
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
                x: { ticks: { color: '#8b96a8', font: { size: 9 } }, grid: { display: false } },
                y: { ticks: { color: '#8b96a8', font: { size: 9 }, callback: (val) => _repFmtMoney(val, cur) }, grid: { color: 'rgba(255,255,255,0.05)' } },
            },
        },
    });
    _repCharts.push(ch);
}
function _repRenderCharts(m, cur) {
    const chron = m.rows.slice().reverse(); // oldest → newest
    const mk = (key) => chron.map(q => ({ label: _repQuarterLabel(q), value: q[key] == null ? null : q[key] }));
    _repBarChart('repChartRev', mk('revenue'), 'rgba(56,189,248,0.75)', cur);
    _repBarChart('repChartNi', mk('netIncome'), 'rgba(132,204,22,0.75)', cur);
    _repBarChart('repChartFcf', mk('fcf'), 'rgba(168,85,247,0.75)', cur);
}

// ── AI SWOT + strategy (async, fills the placeholders) ──
async function _repLoadAI(m) {
    const swotEl = document.getElementById('repSwot');
    const stratEl = document.getElementById('repStrategy');
    try {
        const ctx = ReportsEngine.aiContext(m);
        const r = await fetch('/api/vision?mode=swot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: m.symbol, company: m.companyName, sector: m.sector, context: ctx }),
        });
        const j = await r.json();
        if (!r.ok || j.error || !j.swot) throw new Error(j.message || 'ai failed');
        if (swotEl) swotEl.innerHTML = _repSwotHtml(j.swot);
        if (stratEl) stratEl.innerHTML = _repStrategyHtml(j.strategy || {});
    } catch (e) {
        const msg = '<div class="adv-empty">ניתוח ה-AI אינו זמין כעת (ייתכן מכסת Gemini). נסה שוב מאוחר יותר.</div>';
        if (swotEl) swotEl.innerHTML = msg;
        if (stratEl) stratEl.innerHTML = '';
    }
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
}
