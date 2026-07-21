// ========== AI TRADING AGENT — natural-language automated strategies (PAPER / ALERT only) ==========
//
// Users describe a trading strategy in plain language ("if oil drops below $70, buy USO for $500").
// The agent parses it (LLM → structured StrategyRule via /api/vision?mode=strategy), shows a
// Strategy Card for confirmation, saves it to Supabase `automated_strategies`, then MONITORS the
// conditions against REAL live data (price / RSI / earnings-surprise / news) and, when they fire,
// runs the action.
//
// ⚠️ SAFETY: there is NO brokerage integration. Every strategy runs in PAPER (simulated) or ALERT
// mode — the agent records a simulated trade + notifies; it NEVER moves real money. Real execution
// is deliberately out of scope (would require a broker API + explicit per-order authorization).
//
// The 24/7 monitoring here runs client-side while the app is open (checks every few minutes). A
// true always-on evaluator belongs in a VPS agent (see the reports/press agents) — future work.
//
// ── Types (the codebase is vanilla JS; these JSDoc typedefs are the type contract) ──
/**
 * @typedef {Object} StrategyCondition
 * @property {'price'|'rsi'|'ma'|'eps_surprise'|'news'|'macro'} factor
 * @property {string|null} subject   ticker or entity/index (USO, NVDA, Iran, oil)
 * @property {string|null} keyword   comma-separated keywords for news, else null
 * @property {'ABOVE'|'BELOW'|'CROSSES_ABOVE'|'CROSSES_BELOW'|'GTE'|'LTE'|'EQUALS'|'CONTAINS'} operator
 * @property {number|string|null} threshold
 * @property {string|null} timeframe '4h' | 'daily' | 'weekly' | null
 * @typedef {Object} StrategyAmount
 * @property {'SHARES'|'CASH_USD'|'PORTFOLIO_PCT'} type
 * @property {number} value
 * @typedef {Object} StrategyRisk
 * @property {number|null} stop_loss_pct
 * @property {number|null} max_slippage_pct
 * @property {number|null} max_portfolio_pct
 * @typedef {Object} StrategyRule
 * @property {string} name
 * @property {'NEWS_SENTIMENT'|'MACRO_EVENT'|'PRICE_LEVEL'|'EARNINGS_BEAT'|'TECHNICAL_INDICATOR'} trigger_type
 * @property {'ANY'|'ALL'} logic
 * @property {StrategyCondition[]} conditions
 * @property {'BUY'|'SELL'|'ALERT_ONLY'} action
 * @property {string|null} target_asset
 * @property {StrategyAmount} amount
 * @property {StrategyRisk} risk_limits
 * @typedef {Object} AutomatedStrategyRow
 * @property {number} id
 * @property {string} name
 * @property {'ACTIVE'|'PAUSED'|'TRIGGERED'|'EXPIRED'} status
 * @property {'PAPER'|'ALERT'} mode
 * @property {StrategyRule} parsed_rule
 * @property {Array<{ts:string,kind:string,message:string}>} execution_logs
 */

let _taStrategies = [];         // cached rows
let _taBrokers = [];            // cached broker_connections rows
let _taPendingRule = null;      // the just-parsed rule awaiting confirmation
let _taEditingId = null;        // id of the strategy currently being edited (null = creating new)
let _taChecking = false;
const _taEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Thousand-separator formatting for the amount field (e.g. 50000 → "50,000").
function _taFmtNum(v) {
    let s = String(v == null ? '' : v).replace(/,/g, '').replace(/[^\d.]/g, '');
    if (s === '') return '';
    const parts = s.split('.');
    let intPart = (parts[0] || '').replace(/^0+(?=\d)/, '') || '0';
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? intPart + '.' + parts[1].slice(0, 4) : intPart;
}
function _taNum(v) { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : NaN; }
// Human amount label used by the action box + summaries (comma-formatted).
function _taAmtLabel(type, value) {
    return type === 'SHARES' ? `${_taFmtNum(value)} מניות` : type === 'PORTFOLIO_PCT' ? `${value}% מהתיק` : `$${_taFmtNum(value)}`;
}
// Live-refresh the "פעולה" (action) box in the card from the current amount input + type.
function _taUpdateActPreview() {
    const box = document.getElementById('taActBox');
    if (!box || !_taPendingRule) return;
    const rule = _taPendingRule;
    const actHe = rule.action === 'BUY' ? 'קנייה' : rule.action === 'SELL' ? 'מכירה' : 'התראה בלבד';
    let amtHe = '';
    if (rule.action === 'BUY' || rule.action === 'SELL') {
        const v = _taNum((document.getElementById('taAmtVal') || {}).value);
        const t = (document.getElementById('taAmtType') || {}).value;
        if (isFinite(v)) amtHe = _taAmtLabel(t, v);
    }
    box.innerHTML = `${actHe}${amtHe ? ' · ' + _taEsc(amtHe) : ''}${rule.target_asset ? ' · <b>' + _taEsc(rule.target_asset) + '</b>' : ''}`;
}
// Live-format the amount input while preserving the caret position (by digit count).
function _taFmtAmtInput(el) {
    const oldVal = el.value, oldPos = el.selectionStart || 0;
    const digitsBefore = oldVal.slice(0, oldPos).replace(/[^\d]/g, '').length;
    const formatted = _taFmtNum(oldVal);
    el.value = formatted;
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < digitsBefore) { if (/\d/.test(formatted[pos])) seen++; pos++; }
    try { el.setSelectionRange(pos, pos); } catch (e) { }
}

const _TA_EXAMPLES = [
    'אם הנפט יורד מתחת ל-$70 או שיש אזכור של איראן/טראמפ בחדשות, תקנה USO ב-500 דולר',
    'מכור 50% מהאחזקה ב-NVDA אם ה-RSI עולה מעל 80',
    'לפי הדוחות, הסקטורים, מנוע הנזילות והמאקרו בפלטפורמה — אילו מניות הכי רלוונטיות עכשיו?',
    'מה מצב האחזקות שלי בתיק לפי הטכני והדוחות?',
];

// ── Routed page (mirrors the correlation/stress-test page pattern) ──
function openTradingAgentPage() {
    const page = document.getElementById('tradingAgentPage');
    if (!page) return;
    const header = document.querySelector('.header'); if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'tradingAgentPage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid'); if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header'); if (psh) psh.style.display = 'none';
    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('tradingagent');
    if (typeof updateURLState === 'function') updateURLState({ view: 'tradingagent' });
    _taRenderShell();
    _taUpdateMonitorBar();
    _taLoadServerStatus();
    if (window._taSrvTimer) clearInterval(window._taSrvTimer);
    window._taSrvTimer = setInterval(_taLoadServerStatus, 60000);
    _taLoadBrokers();
    _taLoadStrategies();
    _taGatherContext().catch(() => { }); // warm the platform-data cache so the first ask is instant
    window.scrollTo(0, 0);
}
function closeTradingAgentPage() {
    const page = document.getElementById('tradingAgentPage');
    if (!page) return;
    page.classList.remove('active'); page.innerHTML = '';
    const header = document.querySelector('.header'); if (header) header.style.display = '';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { el.style.display = ''; });
    const grid = document.getElementById('clientsGrid'); if (grid) grid.style.display = '';
    const psh = document.querySelector('.portfolio-section-header'); if (psh) psh.style.display = '';
    if (window._taSrvTimer) { clearInterval(window._taSrvTimer); window._taSrvTimer = null; }
    if (typeof clearURLState === 'function') clearURLState();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
}
// Read the VPS agent's heartbeat and CONFIRM (or not) that it's running 24/7 — this timestamp
// advances even while the site is closed, so a recent beat proves autonomous server execution.
async function _taLoadServerStatus() {
    const el = document.getElementById('taSrvStatus'); const dot = document.getElementById('taMonDot');
    if (!el || typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        const { data } = await supabaseClient.from('agent_status').select('last_run, last_result').eq('agent', 'strategy').maybeSingle();
        if (data && data.last_run) {
            const ageMin = (Date.now() - new Date(data.last_run)) / 60000;
            const hhmm = new Date(data.last_run).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
            if (ageMin <= 20) { el.innerHTML = `<b class="ta-srv-on">פעיל</b> — הפקודות מתבצעות אוטומטית גם כשהאתר סגור · פעימה אחרונה ${hhmm}`; if (dot) dot.className = 'ta-mon-dot ta-dot-on'; return; }
            el.innerHTML = `<b class="ta-srv-off">לא מגיב</b> — פעימה אחרונה ${hhmm}`; if (dot) dot.className = 'ta-mon-dot ta-dot-warn';
        } else {
            el.innerHTML = `<b class="ta-srv-off">כבוי</b> — סוכן השרת עדיין לא הופעל`; if (dot) dot.className = 'ta-mon-dot ta-dot-off';
        }
    } catch (e) { el.textContent = '—'; }
}

function _taRenderShell() {
    const page = document.getElementById('tradingAgentPage');
    if (!page) return;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header"><h1 class="macro-main-title">סוכן מסחר AI</h1></div>
        <div class="macro-content">
            <div class="ta-safety"><b>נתונים אמיתיים · ביצוע מבוקר</b> — הסוכן מנטר את התנאים על נתוני שוק אמיתיים. כל אסטרטגיה מקושרת ל<b>תיק בפלטפורמה</b> (מבצע בתיק הנייר) או ל<b>ברוקר חיצוני</b> (מצב Live), או שולח <b>התראה בלבד</b>. אין זה ייעוץ השקעות.</div>
            <div class="ta-monitor-bar" id="taMonBar">
                <span class="ta-mon-dot" id="taMonDot"></span>
                <span class="ta-mon-txt">מנוע 24/7 בשרת: <span id="taSrvStatus">בודק…</span></span>
                <span class="ta-mon-last" id="taMonLast"></span>
                <button class="ta-mini ta-mini-on" onclick="_taCheckStrategies(true)">בדוק עכשיו</button>
            </div>
            <div class="risk-table-card glass-card" style="padding:18px">
                <div class="ta-chat-title">תאר אסטרטגיה בשפה חופשית — או שאל שאלת שוק פתוחה. הסוכן מחובר לכל נתוני הפלטפורמה.</div>
                <div class="ta-chat-row">
                    <textarea id="taInput" class="ta-input" rows="2" placeholder="למשל: מכור 50% מ-NVDA אם ה-RSI מעל 80 · או: אילו מניות מתאימות לתקופה הקרובה?" onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){_taParse();}"></textarea>
                    <button class="corr-run-btn corr-run-primary" id="taParseBtn" onclick="_taParse()">בצע אסטרטגיה</button>
                </div>
                <div class="ta-examples">${_TA_EXAMPLES.map(e => `<button class="ta-example" onclick="document.getElementById('taInput').value=this.textContent;_taParse()">${_taEsc(e)}</button>`).join('')}</div>
                <div id="taCard"></div>
            </div>
            <div class="ta-list-head">חיבור לברוקר <span class="ta-broker-sub">תשתית להרצה אמיתית</span> <button class="ta-broker-add" onclick="_taOpenBrokerForm()">הוסף חיבור</button></div>
            <div id="taBrokerCard" class="risk-table-card glass-card" style="padding:10px 14px"><div class="wl-empty"><div class="rep-spinner"></div>טוען…</div></div>
            <div class="ta-list-head">האסטרטגיות שלי <span id="taCount" class="wl-cat-count">0</span></div>
            <div id="taList" class="risk-table-card glass-card" style="padding:10px 14px"><div class="wl-empty"><div class="rep-spinner"></div>טוען…</div></div>
        </div>
    </div>`;
}

// ══════════════ PLATFORM DATA CONTEXT — wire the agent's chat into every data source ══════════════
// Builds a COMPACT, real-data snapshot of the whole platform so the chat reasons with the same data
// the user sees: the user's portfolios, company reports, sector strength, catalysts (Early-Alpha),
// tweets, the liquidity engine (LHE), macro indicators + geo-macro news, and live technicals for the
// holdings. Every source is best-effort, size-capped, and time-boxed — a slow/unavailable source is
// simply skipped (never blocks the chat, never fabricated). Cached ~2 min so repeat asks are instant.
let _taCtx = null, _taCtxAt = 0;
async function _taGatherContext(force) {
    if (!force && _taCtx && (Date.now() - _taCtxAt) < 120000) return _taCtx;
    const ctx = {}; const sb = (typeof supabaseClient !== 'undefined') ? supabaseClient : null;
    // Portfolios + holdings (already in memory — free).
    try {
        if (typeof clients !== 'undefined' && Array.isArray(clients)) {
            ctx.portfolios = clients.slice(0, 8).map(c => ({
                name: c.name,
                holdings: (c.holdings || []).slice(0, 40).map(h => String(h.ticker || h.symbol || '').toUpperCase()).filter(Boolean),
            })).filter(p => (p.holdings && p.holdings.length) || p.name);
        }
    } catch (e) { }
    const holdingSyms = [...new Set((ctx.portfolios || []).flatMap(p => p.holdings))].slice(0, 25);
    const jobs = [];
    // Company reports — top US by score (fundamental strength) + sector strength derived from them.
    jobs.push((async () => {
        if (!sb) return;
        try {
            const { data } = await sb.from('company_reports').select('symbol,company_name,score,sector,improved').eq('market', 'us').order('score', { ascending: false }).limit(40);
            if (data && data.length) {
                ctx.top_reports = data.slice(0, 15).map(r => ({ t: r.symbol, n: r.company_name, score: r.score, sector: r.sector, up: !!r.improved }));
                const bySec = {};
                data.forEach(r => { if (!r.sector) return; (bySec[r.sector] = bySec[r.sector] || []).push(+r.score || 0); });
                ctx.sectors = Object.entries(bySec).map(([s, arr]) => ({ sector: s, avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length), n: arr.length })).sort((a, b) => b.avg - a.avg).slice(0, 10);
            }
        } catch (e) { }
    })());
    // The user's holdings' fundamental scores.
    jobs.push((async () => {
        if (!sb || !holdingSyms.length) return;
        try { const { data } = await sb.from('company_reports').select('symbol,score,sector,improved').in('symbol', holdingSyms); if (data && data.length) ctx.holdings_reports = data.map(r => ({ t: r.symbol, score: r.score, sector: r.sector, up: !!r.improved })); } catch (e) { }
    })());
    // Catalysts (Early-Alpha intelligence — sector, thesis, stealth tickers).
    jobs.push((async () => {
        if (!sb) return;
        try {
            const { data } = await sb.from('catalyst_cards').select('sector_name,thesis,stealth_targets,stage_score,created_at').eq('status', 'active').order('created_at', { ascending: false }).limit(6);
            if (data && data.length) ctx.catalysts = data.map(c => ({ sector: c.sector_name, thesis: String(c.thesis || '').slice(0, 160), tickers: (Array.isArray(c.stealth_targets) ? c.stealth_targets : []).map(t => String(t.ticker || '').toUpperCase()).filter(Boolean).slice(0, 5), stage: c.stage_score }));
        } catch (e) { }
    })());
    // Liquidity engine (LHE) signals — bias/regime/confluence per ticker.
    jobs.push((async () => {
        if (!sb) return;
        try {
            const { data } = await sb.from('lhe_signals').select('ticker,bias,confluence_score,regime,net_liquidity_flow').order('confluence_score', { ascending: false }).limit(10);
            if (data && data.length) ctx.liquidity = data.map(r => ({ t: r.ticker, bias: r.bias, conf: Math.round(+r.confluence_score || 0), regime: r.regime, flow: r.net_liquidity_flow }));
        } catch (e) { }
    })());
    // Macro indicators (persisted, US) — compact key/value.
    jobs.push((async () => {
        if (!sb) return;
        try {
            const { data } = await sb.from('macro_data').select('country,indicators').eq('country', 'us').maybeSingle();
            const ind = data && data.indicators ? data.indicators : null;
            if (ind && typeof ind === 'object') ctx.macro = Object.entries(ind).slice(0, 14).map(([k, v]) => ({ k, v: (v && typeof v === 'object') ? (v.actual != null ? v.actual : v.value != null ? v.value : null) : v })).filter(x => x.v != null);
        } catch (e) { }
    })());
    // Geo-macro / economy news headlines.
    jobs.push((async () => {
        try { const r = await fetch('/api/news?macro=1', { headers: { Accept: 'application/json' } }); const j = await r.json(); const items = (j && Array.isArray(j.macro)) ? j.macro : []; if (items.length) ctx.macro_news = items.slice(0, 8).map(n => String(n.he || n.en || '').slice(0, 140)).filter(Boolean); } catch (e) { }
    })());
    // Live technicals for the user's holdings (RSI/price) — the same scan the Technical page uses.
    jobs.push((async () => {
        if (!holdingSyms.length) return;
        try { const r = await fetch(`/api/technicals?mode=scan&symbols=${holdingSyms.slice(0, 20).join(',')}&v=2`, { headers: { Accept: 'application/json' } }); const j = await r.json(); const res = j && j.results; if (res) ctx.technicals = Object.entries(res).map(([t, v]) => ({ t, rsiD: v.rsiD != null ? Math.round(v.rsiD) : null, rsiW: v.rsiW != null ? Math.round(v.rsiW) : null, px: v.price })).slice(0, 20); } catch (e) { }
    })());
    // Tweets from tracked X accounts (best-effort — empty until the RapidAPI provider is subscribed).
    jobs.push((async () => {
        try { const r = await fetch('/api/vision?twitter=1', { headers: { Accept: 'application/json' } }); const j = await r.json(); if (j && Array.isArray(j.tweets) && j.tweets.length) ctx.tweets = j.tweets.slice(0, 8).map(tw => ({ u: tw.user, txt: String(tw.text || '').slice(0, 140) })); } catch (e) { }
    })());
    await Promise.race([Promise.allSettled(jobs), new Promise(r => setTimeout(r, 6500))]);
    _taCtx = ctx; _taCtxAt = Date.now();
    return ctx;
}

// ── Parse the NL text → StrategyRule (LLM + fallback), then show the confirmation card ──
async function _taParse() {
    const inp = document.getElementById('taInput');
    const box = document.getElementById('taCard');
    const text = inp ? inp.value.trim() : '';
    if (!text || !box) return;
    // Chat flow: move the question into the answer and clear the box so the user can keep typing.
    if (inp) { inp.value = ''; inp.style.height = ''; }
    const ask = `<div class="ta-ask"><span class="ta-ask-tag">שאלת</span><span class="ta-ask-txt">${_taEsc(text)}</span></div>`;
    box.innerHTML = ask + '<div class="ta-card-load"><div class="rep-spinner"></div>מנתח את הבקשה מול נתוני הפלטפורמה…</div>';
    try {
        const context = await _taGatherContext();
        const r = await fetch('/api/vision?mode=strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, context }) });
        const j = await r.json();
        if (j && j.advice) { _taPendingRule = null; box.innerHTML = ask + _taAdviceCardHtml(j.advice); return; }
        if (!r.ok || j.error || !j.rule) { box.innerHTML = ask + `<div class="ta-card-err">${_taEsc(j.message || 'לא הצלחתי להבין את הבקשה. נסה לתאר אסטרטגיה (טריגר → פעולה → נכס) או לשאול שאלת שוק.')}</div>`; return; }
        _taPendingRule = j.rule;
        if (j.rule.screener) { _taScrMatches = null; box.innerHTML = ask + _taScreenerCardHtml(j.rule, j.source, null); _taRunScreenerPreview(); return; }
        box.innerHTML = ask + _taStrategyCardHtml(j.rule, j.summary_he, j.source);
    } catch (e) {
        box.innerHTML = ask + '<div class="ta-card-err">מנוע ה-AI עמוס כרגע. נסה שוב בעוד רגע.</div>';
    }
}

// ── Advisory card — for open-ended market questions ("which stocks fit the coming period?") ──
let _taSuggestion = null;
function _taAdviceCardHtml(a) {
    _taSuggestion = a && a.suggested_strategy_he ? a.suggested_strategy_he : null;
    const parasOf = (s) => String(s || '').split(/\n\s*\n/).filter(Boolean).map(p => `<p class="ta-adv-p">${_taEsc(p)}</p>`).join('');
    // 1) Executive insight (fall back to answer_he for older payloads)
    const execHtml = parasOf(a.executive_he || a.answer_he);
    // 2) Connected logic (macro → sector → stock)
    const logicHtml = a.logic_he ? parasOf(a.logic_he) : '';
    // 3) Verified live data points
    const liveArr = Array.isArray(a.live_data) ? a.live_data : [];
    const liveHtml = liveArr.length
        ? `<ul class="ta-adv-live-list">${liveArr.map(d => `<li>${_taEsc(d)}</li>`).join('')}</ul>`
        : '<div class="ta-adv-live-empty">לא נמשכו נתונים חיים ספציפיים לשאלה זו כרגע.</div>';
    const ideas = (a.ideas || []).map(i => `
        <div class="ta-idea">
            <div class="ta-idea-head"><span class="ta-idea-tk">${_taEsc(i.ticker)}</span>${i.name ? `<span class="ta-idea-name">${_taEsc(i.name)}</span>` : ''}</div>
            ${i.why ? `<div class="ta-idea-why">${_taEsc(i.why)}</div>` : ''}
            <div class="ta-idea-acts">
                <button class="ta-mini" onclick="if(typeof openReportForTicker==='function')openReportForTicker('${_taEsc(i.ticker)}')" title="דוח כספי של ${_taEsc(i.ticker)}">📊 דוח</button>
                <button class="ta-mini" onclick="if(typeof openTechnicalForTicker==='function')openTechnicalForTicker('${_taEsc(i.ticker)}')" title="ניתוח טכני של ${_taEsc(i.ticker)}">📈 טכני</button>
                <button class="ta-mini ta-mini-on" onclick="_taIdeaToStrategy('${_taEsc(i.ticker)}')">בנה אסטרטגיה</button>
            </div>
        </div>`).join('');
    return `<div class="ta-advice">
        <div class="ta-card-top"><span class="ta-card-name">${_taEsc(a.title || 'ניתוח והמלצות')}</span><span class="ta-trig">אנליסט AI</span></div>
        ${execHtml ? `<div class="ta-adv-sec"><div class="ta-adv-sec-lbl">📌 תובנה מנהלתית</div><div class="ta-adv-body">${execHtml}</div></div>` : ''}
        ${logicHtml ? `<div class="ta-adv-sec ta-adv-logic"><div class="ta-adv-sec-lbl">🔗 הקשר והיגיון מחובר</div><div class="ta-adv-body">${logicHtml}</div></div>` : ''}
        <div class="ta-adv-sec"><div class="ta-adv-sec-lbl">🟢 נתוני אמת מאומתים</div>${liveHtml}</div>
        ${ideas ? `<div class="ta-adv-ideas-lbl">רעיונות רלוונטיים</div><div class="ta-adv-ideas">${ideas}</div>` : ''}
        ${_taSuggestion ? `<div class="ta-adv-strat">אסטרטגיה מוצעת: <b>${_taEsc(_taSuggestion)}</b> <button class="ta-mini ta-mini-on" onclick="_taUseSuggestion()">נסח אותה</button></div>` : ''}
        <div class="ta-adv-disc">ניתוח AI למטרות מידע בלבד — אינו ייעוץ השקעות. אמת את הנתונים לפני פעולה.</div>
    </div>`;
}
function _taIdeaToStrategy(tk) {
    const i = document.getElementById('taInput');
    if (i) { i.value = `קנה ${tk} ב-1000 דולר אם ה-RSI היומי יורד מתחת ל-35`; i.focus(); _taParse(); }
}
function _taUseSuggestion() {
    const i = document.getElementById('taInput');
    if (i && _taSuggestion) { i.value = _taSuggestion; i.focus(); _taParse(); }
}

// ══════════════ INDEX SCREENER — scan a whole index, buy each stock that meets the condition ══════════════
let _taScrMatches = null;                 // cached matches [{ticker,row}] for the pending screener card
const _taScrUniHe = { NDX: 'נאסד"ק 100', SP500: 'S&P 500' };

function _taScreenerCardHtml(rule, source, existing) {
    const portfolios = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : [];
    const sc = rule.screener || {};
    const sm = sc.split_mode === 'equal' ? 'equal' : 'fixed';
    const uniHe = _taScrUniHe[sc.universe] || 'נאסד"ק 100';
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע נע' };
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל-', CROSSES_ABOVE: 'חוצה מעלה', CROSSES_BELOW: 'חוצה מטה', EQUALS: 'נוגעת ב', GTE: '≥', LTE: '≤' };
    const tfHe = { weekly: 'שבועי', daily: 'יומי', '4h': '4 שעות' };
    const conds = (rule.conditions || []).map(c => {
        if (c.factor === 'ma') { const unit = c.timeframe === 'weekly' ? ' שבועות' : ' ימים'; return c.operator === 'EQUALS' ? `נוגעת בממוצע ${c.period || 200}${unit}` : `מחיר ${opHe[c.operator] || ''} ממוצע ${c.period || 200}${unit}`; }
        return `${facHe[c.factor] || c.factor} ${opHe[c.operator] || c.operator} <b>${_taEsc(c.threshold)}</b>${c.timeframe ? ` [${tfHe[c.timeframe] || c.timeframe}]` : ''}`;
    }).join(rule.logic === 'ALL' ? ' וגם ' : ' או ');
    const selPf = existing ? existing.portfolio_id : null;
    const sel = (a, b) => a === b ? 'selected' : '';
    return `<div class="ta-card ta-scr-card">
        <div class="ta-card-top"><span class="ta-card-name">${_taEsc(rule.name || 'סורק מדד')}</span><span class="ta-trig">סורק מדד</span>${source === 'fallback' ? '<span class="ta-draft">טיוטה</span>' : ''}</div>
        <div class="ta-scr-desc">כל מניה ב<b id="taScrUniLbl">${uniHe}</b> שבה <span class="ta-scr-cond">${conds}</span> — נקנית אוטומטית (המניה עצמה, לא תעודת סל).</div>
        <div class="ta-scr-alloc">
            <label class="ta-mode-lbl">מדד לסריקה:
                <select id="taScrUniverse" class="st-pf-select" onchange="_taScrUniverseChange()">
                    <option value="NDX" ${sc.universe === 'SP500' ? '' : 'selected'}>נאסד"ק 100</option>
                    <option value="SP500" ${sc.universe === 'SP500' ? 'selected' : ''}>S&P 500</option>
                </select>
            </label>
            <label class="ta-mode-lbl">אופן חלוקה:
                <select id="taScrMode" class="st-pf-select" onchange="_taScrModeChange()">
                    <option value="fixed" ${sm === 'fixed' ? 'selected' : ''}>סכום קבוע לכל מניה</option>
                    <option value="equal" ${sm === 'equal' ? 'selected' : ''}>חלוקה שווה של התקציב</option>
                </select>
            </label>
            <label class="ta-mode-lbl" id="taScrPerWrap" style="display:${sm === 'equal' ? 'none' : 'inline-flex'}">סכום לכל מניה: $
                <input id="taScrPer" type="text" inputmode="numeric" value="${_taFmtNum(sc.per_stock_usd)}" oninput="_taFmtAmtInput(this);_taRunScreenerPreview()" class="st-pf-select ta-amt-input">
            </label>
            <label class="ta-mode-lbl">תקציב כולל: $
                <input id="taScrTotal" type="text" inputmode="numeric" value="${_taFmtNum(sc.total_budget_usd)}" oninput="_taFmtAmtInput(this);_taRunScreenerPreview()" class="st-pf-select ta-amt-input">
            </label>
        </div>
        <div class="ta-scr-preview" id="taScrPreview"><div class="ta-card-load"><div class="rep-spinner"></div>סורק את המדד ומחשב חלוקה…</div></div>
        <div class="ta-card-actions">
            <label class="ta-mode-lbl">אופן:
                <select id="taMode" class="st-pf-select"><option value="PAPER">בצע בתיק (Paper)</option><option value="ALERT">התראה בלבד</option></select>
            </label>
            <span class="ta-mode-lbl" id="taPortfolioPick">תיק יעד:
                <select id="taPortfolioSel" class="st-pf-select">${portfolios.length ? portfolios.map(p => `<option value="${p.id}" ${sel(selPf, p.id)}>${_taEsc(p.name)}</option>`).join('') : '<option value="">אין תיקים — צור תיק בדף הבית</option>'}</select>
            </span>
            <button class="corr-run-btn corr-run-primary" onclick="_taEnable()">${existing ? 'שמור שינויים' : '▶ הפעל סורק'}</button>
            <button class="wl-close-btn" onclick="_taCancelCard()">בטל</button>
        </div>
    </div>`;
}
// Fetch the whole index's technical scan (rsiW/rsiD/ma/price per stock), batched.
async function _taScreenUniverse(universe) {
    const market = universe === 'SP500' ? 'sp500' : 'ndx';
    try {
        const tj = await fetch(`/api/technicals?mode=tickers&market=${market}&sv=3`, { headers: { Accept: 'application/json' } }).then(r => r.json());
        const tickers = (tj && tj.tickers) || [];
        const results = {};
        for (let i = 0; i < tickers.length; i += 40) {
            const batch = tickers.slice(i, i + 40);
            try { const sj = await fetch(`/api/technicals?mode=scan&symbols=${batch.join(',')}&v=2`, { headers: { Accept: 'application/json' } }).then(r => r.json()); if (sj && sj.results) Object.assign(results, sj.results); } catch (e) { }
        }
        return { tickers, results };
    } catch (e) { return { tickers: [], results: {} }; }
}
function _taScrRowMatch(row, c) {
    if (!row) return false;
    if (c.factor === 'rsi') { const v = (c.timeframe === 'weekly') ? row.rsiW : row.rsiD; if (v == null) return false; return (c.operator === 'ABOVE' || c.operator === 'GTE' || c.operator === 'CROSSES_ABOVE') ? v >= c.threshold : v <= c.threshold; }
    if (c.factor === 'ma') { const k = (c.timeframe === 'weekly' ? 'w' : 'd') + (c.period || 200); const dist = (row.ma || {})[k + 'dist']; if (dist == null) return false; if (c.operator === 'EQUALS') return Math.abs(dist) <= 2.5; return (c.operator === 'ABOVE' || c.operator === 'CROSSES_ABOVE') ? dist >= 0 : dist <= 0; }
    if (c.factor === 'price') { const p = row.price; if (p == null) return false; return c.operator === 'ABOVE' ? p >= c.threshold : p <= c.threshold; }
    return false;
}
function _taScrMatchStock(row, rule) {
    const conds = rule.conditions || [];
    return rule.logic === 'ALL' ? conds.every(c => _taScrRowMatch(row, c)) : conds.some(c => _taScrRowMatch(row, c));
}
// The metric text for the row — MUST reflect the condition's actual timeframe (weekly→rsiW, daily→rsiD),
// so a stock that matched on daily RSI never displays its (different) weekly value.
function _taScrMetric(row, rule) {
    const c = (rule.conditions || []).find(x => ['rsi', 'ma', 'price'].includes(x.factor)) || (rule.conditions || [])[0] || {};
    if (!row) return '';
    if (c.factor === 'rsi') { const wk = c.timeframe === 'weekly'; const v = wk ? row.rsiW : row.rsiD; return `RSI ${wk ? 'שבועי' : 'יומי'} ${v != null ? (+v).toFixed(1) : '—'}`; }
    if (c.factor === 'ma') { const k = (c.timeframe === 'weekly' ? 'w' : 'd') + (c.period || 200); const dist = (row.ma || {})[k + 'dist']; return `מרחק מממוצע ${c.period || 200} ${dist != null ? (dist >= 0 ? '+' : '') + (+dist).toFixed(1) + '%' : '—'}`; }
    if (c.factor === 'price') { return `מחיר $${row.price != null ? (+row.price).toFixed(2) : '—'}`; }
    return '';
}
function _taScrModeChange() {
    const mode = (document.getElementById('taScrMode') || {}).value;
    const perWrap = document.getElementById('taScrPerWrap');
    if (perWrap) perWrap.style.display = mode === 'equal' ? 'none' : 'inline-flex';
    _taRunScreenerPreview();
}
// Switch the scanned index (NDX ↔ S&P 500) — updates the rule, the label, and re-scans from scratch.
function _taScrUniverseChange() {
    const u = (document.getElementById('taScrUniverse') || {}).value;
    if (!_taPendingRule || !_taPendingRule.screener || !u) return;
    _taPendingRule.screener.universe = u;
    const lbl = document.getElementById('taScrUniLbl'); if (lbl) lbl.textContent = _taScrUniHe[u] || u;
    _taScrMatches = null;              // different universe → re-scan
    _taRunScreenerPreview();
}
// Render the allocation preview: which stocks match now + how the budget is divided among them.
async function _taRunScreenerPreview() {
    const el = document.getElementById('taScrPreview');
    const rule = _taPendingRule;
    if (!el || !rule || !rule.screener) return;
    const mode = (document.getElementById('taScrMode') || {}).value || rule.screener.split_mode || 'fixed';
    const per = _taNum((document.getElementById('taScrPer') || {}).value) || 0;
    const budget = _taNum((document.getElementById('taScrTotal') || {}).value) || 0;
    const uniHe = _taScrUniHe[rule.screener.universe] || 'המדד';
    if (!_taScrMatches) {
        el.innerHTML = `<div class="ta-card-load"><div class="rep-spinner"></div>סורק את ${uniHe} ומחשב חלוקה…</div>`;
        const { tickers, results } = await _taScreenUniverse(rule.screener.universe);
        if (!document.getElementById('taScrPreview')) return;
        _taScrMatches = tickers.filter(t => _taScrMatchStock(results[t], rule)).map(t => ({ ticker: t, row: results[t] }));
    }
    const matches = _taScrMatches || [];
    if (!matches.length) { el.innerHTML = `<div class="ta-scr-empty">כרגע אף מניה ב${uniHe} לא עונה על התנאי. הסורק יישאר פעיל ויקנה כל מניה שתעבור את התנאי בעתיד.</div>`; return; }
    // Allocation per division mode.
    let allocated, note;
    if (mode === 'equal') {
        const eachRaw = budget > 0 ? Math.floor(budget / matches.length) : 0;   // equal split of the budget
        allocated = matches.map(m => ({ ...m, amt: eachRaw }));
        note = `<div class="ta-scr-note">חלוקה שווה: התקציב <b>$${_taFmtNum(budget)}</b> מחולק בין <b>${matches.length}</b> מניות → <b>$${_taFmtNum(eachRaw)}</b> לכל אחת.</div>`;
    } else {
        const maxStocks = (per > 0 && budget > 0) ? Math.floor(budget / per) : matches.length;
        allocated = matches.slice(0, maxStocks).map(m => ({ ...m, amt: per }));
        note = matches.length > allocated.length
            ? `<div class="ta-scr-note">נמצאו <b>${matches.length}</b> מניות תואמות · התקציב מכסה <b>${allocated.length}</b> מהן ($${_taFmtNum(per)} לכל אחת).</div>`
            : `<div class="ta-scr-note"><b>${matches.length}</b> מניות תואמות כרגע · $${_taFmtNum(per)} לכל אחת.</div>`;
    }
    const totalAlloc = allocated.reduce((s, m) => s + (m.amt || 0), 0);
    const rows = allocated.map(m => {
        return `<div class="ta-scr-row"><span class="ta-scr-tk">${_taEsc(m.ticker)}</span><span class="ta-scr-metric">${_taEsc(_taScrMetric(m.row, rule))}</span><span class="ta-scr-amt">$${_taFmtNum(m.amt)}</span></div>`;
    }).join('');
    el.innerHTML = `<div class="ta-scr-prev-head">חלוקה צפויה עכשיו — ${allocated.length} מניות</div>${note}<div class="ta-scr-list">${rows}</div><div class="ta-scr-total">סה"כ מוקצב עכשיו: <b>$${_taFmtNum(totalAlloc)}</b>${budget > 0 ? ` מתוך תקציב $${_taFmtNum(budget)}` : ''}</div>`;
}

// ── The visual "Strategy Card": trigger → action → risk, with Enable/Disable ──
function _taStrategyCardHtml(rule, summaryHe, source, existing) {
    const connBrokers = (_taBrokers || []).filter(b => b.status === 'CONNECTED');
    const isTrade = rule.action === 'BUY' || rule.action === 'SELL';
    const portfolios = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : [];
    const amtType = (rule.amount && rule.amount.type) || 'CASH_USD';
    const amtVal = (rule.amount && rule.amount.value) || 0;
    // When editing an existing strategy, pre-select its mode + destination.
    const selMode = existing ? (existing.mode || 'PAPER') : (isTrade ? 'PAPER' : 'ALERT');
    const selPf = existing ? existing.portfolio_id : null;
    const selBk = existing ? existing.broker_connection_id : null;
    const sel = (a, b) => a === b ? 'selected' : '';
    const trigHe = { NEWS_SENTIMENT: 'חדשות/סנטימנט', MACRO_EVENT: 'אירוע מאקרו', PRICE_LEVEL: 'רמת מחיר', EARNINGS_BEAT: 'הפתעת דוחות', TECHNICAL_INDICATOR: 'אינדיקטור טכני' };
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע נע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'מאקרו' };
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל-', CROSSES_ABOVE: 'חוצה מעלה', CROSSES_BELOW: 'חוצה מטה', GTE: '≥', LTE: '≤', EQUALS: '=', CONTAINS: 'מזכיר' };
    const tfHe = { weekly: 'שבועי', daily: 'יומי', '4h': '4 שעות', '1h': 'שעתי' };
    const conds = (rule.conditions || []).map(c => {
        const subj = c.subject ? ` <b>${_taEsc(c.subject)}</b>` : '';
        let body;
        if (c.factor === 'news') {
            body = `אזכור בחדשות: <b>${_taEsc(c.keyword || c.subject || '')}</b>`;
        } else if (c.factor === 'ma') {
            const unit = c.timeframe === 'weekly' ? ' שבועות' : c.timeframe === 'daily' ? ' ימים' : '';
            body = c.operator === 'EQUALS'
                ? `מחיר${subj} נוגע בממוצע נע <b>${_taEsc(c.period || 200)}${unit}</b>`
                : `מחיר${subj} ${opHe[c.operator] || c.operator} ממוצע נע <b>${_taEsc(c.period || 200)}${unit}</b>`;
        } else {
            body = `${facHe[c.factor] || c.factor}${subj} ${opHe[c.operator] || c.operator} <b>${_taEsc(c.threshold != null ? c.threshold + (c.factor === 'eps_surprise' ? '%' : '') : '')}</b>${c.timeframe ? ` <span class="ta-tf">[${_taEsc(tfHe[c.timeframe] || c.timeframe)}]</span>` : ''}`;
        }
        return `<li class="ta-cond">${body}</li>`;
    }).join('');
    const actCls = rule.action === 'BUY' ? 'ta-buy' : rule.action === 'SELL' ? 'ta-sell' : 'ta-alert';
    const actHe = rule.action === 'BUY' ? 'קנייה' : rule.action === 'SELL' ? 'מכירה' : 'התראה בלבד';
    const amtHe = rule.action === 'ALERT_ONLY' ? '' : _taAmtLabel(amtType, amtVal);
    const rl = rule.risk_limits || {};
    const riskBits = [rl.stop_loss_pct != null ? `Stop-Loss ${rl.stop_loss_pct}%` : '', rl.max_slippage_pct != null ? `סליפג׳ מקס ${rl.max_slippage_pct}%` : '', rl.max_portfolio_pct != null ? `עד ${rl.max_portfolio_pct}% מהתיק` : ''].filter(Boolean);
    return `<div class="ta-card">
        <div class="ta-card-top"><span class="ta-card-name">${_taEsc(rule.name)}</span><span class="ta-trig">${trigHe[rule.trigger_type] || rule.trigger_type}</span>${source === 'fallback' ? '<span class="ta-draft" title="פוענח היוריסטית — בדוק שהחוקים נכונים">טיוטה</span>' : ''}</div>
        <div class="ta-flow">
            <div class="ta-flow-col"><span class="ta-flow-lbl">טריגר (${rule.logic === 'ALL' ? 'כל התנאים' : 'לפחות תנאי אחד'})</span><ul class="ta-conds">${conds}</ul></div>
            <div class="ta-flow-arrow">←</div>
            <div class="ta-flow-col"><span class="ta-flow-lbl">פעולה</span><div class="ta-act ${actCls}" id="taActBox">${actHe}${amtHe ? ' · ' + _taEsc(amtHe) : ''}${rule.target_asset ? ' · <b>' + _taEsc(rule.target_asset) + '</b>' : ''}</div></div>
            <div class="ta-flow-arrow">←</div>
            <div class="ta-flow-col"><span class="ta-flow-lbl">ניהול סיכון</span><div class="ta-risk">${riskBits.length ? riskBits.map(b => `<span class="ta-risk-chip">${_taEsc(b)}</span>`).join('') : '<span class="ta-risk-none">לא הוגדרו מגבלות</span>'}</div></div>
        </div>
        <div class="ta-card-actions">
            ${isTrade ? `<label class="ta-mode-lbl">סכום:
                <input id="taAmtVal" type="text" inputmode="decimal" value="${_taFmtNum(amtVal)}" oninput="_taFmtAmtInput(this);_taUpdateActPreview()" class="st-pf-select ta-amt-input">
                <select id="taAmtType" class="st-pf-select" onchange="_taUpdateActPreview()">
                    <option value="CASH_USD" ${amtType === 'CASH_USD' ? 'selected' : ''}>$ מזומן</option>
                    <option value="SHARES" ${amtType === 'SHARES' ? 'selected' : ''}>מניות</option>
                    <option value="PORTFOLIO_PCT" ${amtType === 'PORTFOLIO_PCT' ? 'selected' : ''}>% מהתיק</option>
                </select>
            </label>` : ''}
            <label class="ta-mode-lbl">אופן:
                <select id="taMode" class="st-pf-select" onchange="_taOnModeChange()">
                    ${isTrade ? `<option value="PAPER" ${sel(selMode, 'PAPER')}>בצע בתיק (Paper)</option>` : ''}
                    <option value="ALERT" ${sel(selMode, 'ALERT')}>התראה בלבד</option>
                    ${isTrade && connBrokers.length ? `<option value="LIVE" ${sel(selMode, 'LIVE')}>בצע בברוקר (Live)</option>` : ''}
                    ${isTrade && !connBrokers.length ? '<option value="LIVE" disabled>Live — דרוש חיבור ברוקר</option>' : ''}
                </select>
            </label>
            ${isTrade ? `<span class="ta-mode-lbl" id="taPortfolioPick" style="display:${selMode === 'PAPER' ? 'inline-flex' : 'none'}">תיק יעד:
                <select id="taPortfolioSel" class="st-pf-select">${portfolios.length ? portfolios.map(p => `<option value="${p.id}" ${sel(selPf, p.id)}>${_taEsc(p.name)}</option>`).join('') : '<option value="">אין תיקים — צור תיק בדף הבית</option>'}</select>
            </span>` : ''}
            ${isTrade ? `<span class="ta-mode-lbl" id="taBrokerPick" style="display:${selMode === 'LIVE' ? 'inline-flex' : 'none'}">ברוקר:
                <select id="taBrokerSel" class="st-pf-select">${connBrokers.map(b => `<option value="${b.id}" ${sel(selBk, b.id)}>${_taEsc(b.label || b.broker)}</option>`).join('')}</select>
            </span>` : ''}
            <button class="corr-run-btn corr-run-primary" onclick="_taEnable()">${existing ? 'שמור שינויים' : 'הפעל אסטרטגיה'}</button>
            <button class="wl-close-btn" onclick="_taCancelCard()">בטל</button>
        </div>
    </div>`;
}

// ── Save + enable the pending strategy (status ACTIVE). Immediately evaluates it once. ──
async function _taEnable() {
    if (!_taPendingRule) return;
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    const modeSel = (document.getElementById('taMode') || {}).value;
    const mode = modeSel === 'ALERT' ? 'ALERT' : modeSel === 'LIVE' ? 'LIVE' : 'PAPER';
    // ── Screener strategy (scan an index, buy each matching stock up to a budget) ──
    if (_taPendingRule.screener) {
        const splitMode = (document.getElementById('taScrMode') || {}).value === 'equal' ? 'equal' : 'fixed';
        const per = _taNum((document.getElementById('taScrPer') || {}).value) || 0;
        const budget = _taNum((document.getElementById('taScrTotal') || {}).value) || 0;
        if (splitMode === 'fixed' && !(per > 0)) { if (typeof showToast === 'function') showToast('הזן סכום לכל מניה (גדול מ-0)', 'error'); return; }
        if (splitMode === 'equal' && !(budget > 0)) { if (typeof showToast === 'function') showToast('הזן תקציב כולל לחלוקה שווה', 'error'); return; }
        _taPendingRule.screener = { ..._taPendingRule.screener, per_stock_usd: per, total_budget_usd: budget, split_mode: splitMode };
        _taPendingRule.amount = { type: 'CASH_USD', value: per || (budget || 0) };
        let portfolioId = null;
        if (mode === 'PAPER') { portfolioId = +(((document.getElementById('taPortfolioSel') || {}).value) || 0) || null; if (!portfolioId) { if (typeof showToast === 'function') showToast('בחר תיק בפלטפורמה לביצוע', 'error'); return; } }
        const pfName = portfolioId && typeof clients !== 'undefined' ? (clients.find(c => c.id === portfolioId) || {}).name : null;
        const modeHe = mode === 'PAPER' ? (pfName ? `סורק פעיל · ביצוע בתיק «${pfName}»` : 'סורק פעיל') : 'סורק · התראה בלבד';
        const common = { name: _taPendingRule.name || 'סורק מדד', status: 'ACTIVE', mode, portfolio_id: portfolioId, broker_connection_id: null, parsed_rule: _taPendingRule, screener_state: { spent: 0, bought: [] }, updated_at: new Date().toISOString() };
        try {
            if (_taEditingId) {
                await supabaseClient.from('automated_strategies').update({ ...common }).eq('id', _taEditingId);
                if (typeof showToast === 'function') showToast('הסורק עודכן', 'success');
            } else {
                await supabaseClient.from('automated_strategies').insert({ ...common, execution_logs: [{ ts: new Date().toISOString(), kind: 'created', message: `הסורק נוצר והופעל — ${modeHe}` }] });
                if (typeof showToast === 'function') showToast('הסורק הופעל — יסרוק את המדד ויקנה מניות תואמות', 'success');
            }
            const box = document.getElementById('taCard'); if (box) box.innerHTML = '';
            const inp = document.getElementById('taInput'); if (inp) inp.value = '';
            _taPendingRule = null; _taEditingId = null; _taScrMatches = null;
            await _taLoadStrategies();
            _taCheckStrategies(true);
        } catch (e) { if (typeof showToast === 'function') showToast('שמירת הסורק נכשלה', 'error'); }
        return;
    }
    const isTrade = _taPendingRule.action === 'BUY' || _taPendingRule.action === 'SELL';
    // Let the user override the parsed amount (comma-formatted → number).
    if (isTrade) {
        const v = _taNum((document.getElementById('taAmtVal') || {}).value);
        const t = (document.getElementById('taAmtType') || {}).value;
        if (isFinite(v) && v > 0) _taPendingRule.amount = { type: (['CASH_USD', 'SHARES', 'PORTFOLIO_PCT'].includes(t) ? t : 'CASH_USD'), value: v };
        if (!(_taPendingRule.amount && _taPendingRule.amount.value > 0)) {
            if (typeof showToast === 'function') showToast('הזן סכום לפעולה (גדול מ-0)', 'error');
            const el = document.getElementById('taAmtVal'); if (el) el.focus();
            return;
        }
    }
    let brokerId = null, portfolioId = null;
    if (isTrade && mode === 'PAPER') {
        portfolioId = +(((document.getElementById('taPortfolioSel') || {}).value) || 0) || null;
        if (!portfolioId) { if (typeof showToast === 'function') showToast('בחר תיק בפלטפורמה לביצוע — או צור תיק בדף הבית', 'error'); return; }
    }
    if (mode === 'LIVE') {
        brokerId = +(((document.getElementById('taBrokerSel') || {}).value) || 0) || null;
        if (!brokerId) { if (typeof showToast === 'function') showToast('בחר חיבור ברוקר פעיל למצב אמיתי', 'error'); return; }
    }
    const pfName = portfolioId && typeof clients !== 'undefined' ? (clients.find(c => c.id === portfolioId) || {}).name : null;
    const modeHe = mode === 'PAPER' ? (pfName ? `ביצוע בתיק «${pfName}»` : 'סימולציה') : mode === 'LIVE' ? 'אמיתי (Live)' : 'התראה';
    const common = { name: _taPendingRule.name || 'אסטרטגיה', status: 'ACTIVE', mode, broker_connection_id: brokerId, portfolio_id: portfolioId, parsed_rule: _taPendingRule, updated_at: new Date().toISOString() };
    try {
        if (_taEditingId) {
            const editId = _taEditingId;
            const cur = _taStrategies.find(x => x.id === editId);
            const logs = (cur && Array.isArray(cur.execution_logs) ? cur.execution_logs : []).slice(-40);
            logs.push({ ts: new Date().toISOString(), kind: 'edited', message: `האסטרטגיה עודכנה — ${modeHe}` });
            const { error } = await supabaseClient.from('automated_strategies').update({ ...common, execution_logs: logs }).eq('id', editId);
            if (error) throw error;
            if (typeof showToast === 'function') showToast('האסטרטגיה עודכנה', 'success');
        } else {
            const { error } = await supabaseClient.from('automated_strategies')
                .insert({ ...common, execution_logs: [{ ts: new Date().toISOString(), kind: 'created', message: `האסטרטגיה נוצרה והופעלה — ${modeHe}` }] });
            if (error) throw error;
            if (typeof showToast === 'function') showToast('האסטרטגיה הופעלה — הסוכן מנטר את התנאים', 'success');
        }
        const box = document.getElementById('taCard'); if (box) box.innerHTML = '';
        const inp = document.getElementById('taInput'); if (inp) inp.value = '';
        _taPendingRule = null; _taEditingId = null;
        await _taLoadStrategies();
        _taCheckStrategies(true); // evaluate right away
    } catch (e) { if (typeof showToast === 'function') showToast('שמירת האסטרטגיה נכשלה', 'error'); }
}

// ── The user's strategies list ──
async function _taLoadStrategies() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        const { data, error } = await supabaseClient.from('automated_strategies').select('*').order('created_at', { ascending: false });
        if (error) return;
        _taStrategies = data || [];
        _taRenderList();
    } catch (e) { }
}
function _taRenderList() {
    const el = document.getElementById('taList');
    const cnt = document.getElementById('taCount');
    if (cnt) cnt.textContent = _taStrategies.length;
    if (!el) return;
    if (!_taStrategies.length) { el.innerHTML = '<div class="wl-empty">אין אסטרטגיות עדיין. תאר אסטרטגיה למעלה כדי להתחיל.</div>'; return; }
    const statusHe = { ACTIVE: ['פעילה', 'ta-st-active'], PAUSED: ['מושהית', 'ta-st-paused'], TRIGGERED: ['הופעלה', 'ta-st-trig'], EXPIRED: ['הסתיימה', 'ta-st-exp'] };
    el.innerHTML = _taStrategies.map(s => {
        const st = statusHe[s.status] || [s.status, ''];
        const summary = _taEsc((typeof _taRuleSummary === 'function') ? _taRuleSummary(s.parsed_rule) : (s.parsed_rule && s.parsed_rule.name) || '');
        const logs = Array.isArray(s.execution_logs) ? s.execution_logs : [];
        const last = logs.length ? logs[logs.length - 1] : null;
        // Destination label — which portfolio / broker the strategy acts on.
        let dest = '';
        if (s.portfolio_id && typeof clients !== 'undefined' && Array.isArray(clients)) { const c = clients.find(x => x.id === s.portfolio_id); if (c) dest = ` · תיק «${_taEsc(c.name)}»`; }
        else if (s.broker_connection_id && Array.isArray(_taBrokers)) { const b = _taBrokers.find(x => x.id === s.broker_connection_id); if (b) dest = ` · ${_taEsc(b.label || b.broker)}`; }
        const modeHe = (s.mode === 'ALERT' ? 'התראה' : s.mode === 'LIVE' ? 'אמיתי' : 'בתיק') + dest;
        return `<div class="ta-strat" data-ta-id="${s.id}">
            <div class="ta-strat-main">
                <div class="ta-strat-id"><span class="ta-strat-name">${_taEsc((s.name || '').replace(/\s*\(?\s*טיוטה\s*\)?/g, '').trim() || 'אסטרטגיה')}</span><span class="ta-strat-sum">${summary}</span></div>
                <span class="ta-st-badge ${st[1]}">${st[0]}</span>
                <span class="ta-mode-badge">${modeHe}</span>
                <button class="ta-mini" onclick="_taToggleStructure(${s.id})" title="מבנה האסטרטגיה">מבנה</button>
                <button class="ta-mini" onclick="_taEditStrategy(${s.id})" title="ערוך">ערוך</button>
                <button class="ta-mini ${s.status === 'ACTIVE' ? '' : 'ta-mini-on'}" onclick="_taToggle(${s.id})">${s.status === 'ACTIVE' ? 'השהה' : 'הפעל'}</button>
                <button class="ta-mini ta-mini-del" onclick="_taDelete(${s.id})" title="מחק">מחק</button>
            </div>
            ${last ? `<div class="ta-strat-log"><span class="ta-log-time">${_taWhen(last.ts)}</span> · ${_taEsc(last.message)}</div>` : ''}
            <div class="ta-struct" id="taStruct-${s.id}" style="display:none"></div>
        </div>`;
    }).join('');
}
// Read-only structure panel — "the strategy's makeup in terms of actions".
function _taStructureHtml(s) {
    const rule = s.parsed_rule || {};
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע נע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'מאקרו' };
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל-', CROSSES_ABOVE: 'חוצה מעלה', CROSSES_BELOW: 'חוצה מטה', GTE: '≥', LTE: '≤', EQUALS: '=', CONTAINS: 'מזכיר' };
    const conds = (rule.conditions || []).map(c => {
        let body;
        if (c.factor === 'news') body = `אזכור בחדשות: "${_taEsc(c.keyword || c.subject || '')}"`;
        else if (c.factor === 'ma') { const unit = c.timeframe === 'weekly' ? ' שבועות' : c.timeframe === 'daily' ? ' ימים' : ''; const op = c.operator === 'EQUALS' ? 'נוגע בממוצע' : (opHe[c.operator] || c.operator) + ' ממוצע'; body = `מחיר${c.subject ? ' ' + _taEsc(c.subject) : ''} ${op} ${c.period || 200}${unit}`; }
        else body = `${facHe[c.factor] || c.factor}${c.subject ? ' ' + _taEsc(c.subject) : ''} ${opHe[c.operator] || c.operator} ${c.threshold != null ? _taEsc(c.threshold) + (c.factor === 'eps_surprise' ? '%' : '') : ''}${c.timeframe && c.factor !== 'ma' ? ' [' + _taEsc(c.timeframe) + ']' : ''}`;
        return `<li>${body}</li>`;
    }).join('');
    const actHe = rule.action === 'BUY' ? 'קנייה' : rule.action === 'SELL' ? 'מכירה' : 'התראה בלבד';
    const amtHe = rule.action === 'ALERT_ONLY' ? '' : (rule.amount.type === 'SHARES' ? `${_taFmtNum(rule.amount.value)} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? `${rule.amount.value}% מהתיק` : `$${_taFmtNum(rule.amount.value)}`);
    let destHe = 'התראה בלבד (ללא ביצוע)';
    if (s.portfolio_id && typeof clients !== 'undefined') { const c = clients.find(x => x.id === s.portfolio_id); destHe = `ביצוע בתיק «${_taEsc(c ? c.name : s.portfolio_id)}» (Paper)`; }
    else if (s.broker_connection_id && Array.isArray(_taBrokers)) { const b = _taBrokers.find(x => x.id === s.broker_connection_id); destHe = `ביצוע דרך ${_taEsc(b ? (b.label || b.broker) : 'ברוקר')} (Live)`; }
    const rl = rule.risk_limits || {};
    const riskBits = [rl.stop_loss_pct != null ? `Stop-Loss ${rl.stop_loss_pct}%` : '', rl.max_slippage_pct != null ? `סליפג׳ מקס ${rl.max_slippage_pct}%` : '', rl.max_portfolio_pct != null ? `עד ${rl.max_portfolio_pct}% מהתיק` : ''].filter(Boolean);
    return `<div class="ta-struct-inner">
        <div class="ta-struct-row"><span class="ta-struct-lbl">טריגר (${rule.logic === 'ALL' ? 'כל התנאים' : 'לפחות תנאי אחד'})</span><ul class="ta-struct-conds">${conds}</ul></div>
        <div class="ta-struct-row"><span class="ta-struct-lbl">פעולה</span><span class="ta-struct-val">${actHe}${amtHe ? ' · ' + amtHe : ''}${rule.target_asset ? ' · ' + _taEsc(rule.target_asset) : ''}</span></div>
        <div class="ta-struct-row"><span class="ta-struct-lbl">יעד ביצוע</span><span class="ta-struct-val">${destHe}</span></div>
        <div class="ta-struct-row"><span class="ta-struct-lbl">ניהול סיכון</span><span class="ta-struct-val">${riskBits.length ? riskBits.join(' · ') : 'לא הוגדרו מגבלות'}</span></div>
    </div>`;
}
function _taToggleStructure(id) {
    const box = document.getElementById('taStruct-' + id);
    const s = _taStrategies.find(x => x.id === id);
    if (!box || !s) return;
    if (box.style.display === 'none' || !box.style.display) { box.innerHTML = _taStructureHtml(s); box.style.display = 'block'; }
    else { box.style.display = 'none'; box.innerHTML = ''; }
}
// Open an existing strategy in the card for editing (amount / mode / destination).
function _taEditStrategy(id) {
    const s = _taStrategies.find(x => x.id === id);
    if (!s || !s.parsed_rule) return;
    _taEditingId = id;
    _taPendingRule = JSON.parse(JSON.stringify(s.parsed_rule));
    const box = document.getElementById('taCard');
    if (box) {
        if (_taPendingRule.screener) { _taScrMatches = null; box.innerHTML = _taScreenerCardHtml(_taPendingRule, 'edit', s); _taRunScreenerPreview(); }
        else box.innerHTML = _taStrategyCardHtml(_taPendingRule, _taRuleSummary(_taPendingRule), 'edit', s);
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}
function _taRuleSummary(rule) {
    if (!rule) return '';
    if (rule.screener) {
        const uniHe = _taScrUniHe[rule.screener.universe] || 'נאסד"ק 100';
        const c = (rule.conditions || [])[0] || {};
        const cond = c.factor === 'rsi' ? `RSI ${c.timeframe === 'weekly' ? 'שבועי' : 'יומי'} ${c.operator === 'ABOVE' ? 'מעל' : 'מתחת ל-'}${c.threshold}` : 'תנאי';
        const alloc = rule.screener.split_mode === 'equal' ? `חלוקה שווה של $${_taFmtNum(rule.screener.total_budget_usd)}` : `$${_taFmtNum(rule.screener.per_stock_usd)} למניה (תקציב $${_taFmtNum(rule.screener.total_budget_usd)})`;
        return `סורק ${uniHe} — כל מניה: ${cond} ← קנייה ${alloc}`;
    }
    // Mirror the server _strategySummaryHe for the list (kept in sync).
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל-', CROSSES_ABOVE: 'חוצה מעלה', CROSSES_BELOW: 'חוצה מטה', GTE: '≥', LTE: '≤', EQUALS: '=', CONTAINS: 'מזכיר' };
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'מאקרו' };
    const conds = (rule.conditions || []).map(c => {
        if (c.factor === 'news') return `אזכור "${c.keyword || c.subject}"`;
        if (c.factor === 'ma') { const unit = c.timeframe === 'weekly' ? ' שבועות' : c.timeframe === 'daily' ? ' ימים' : ''; const op = c.operator === 'EQUALS' ? 'נוגע בממוצע' : (opHe[c.operator] || '') + ' ממוצע'; return `מחיר${c.subject ? ' ' + c.subject : ''} ${op} ${c.period || 200}${unit}`.trim(); }
        return `${facHe[c.factor] || c.factor}${c.subject ? ' ' + c.subject : ''} ${opHe[c.operator] || ''} ${c.threshold != null ? c.threshold + (c.factor === 'eps_surprise' ? '%' : '') : ''}`.trim();
    });
    const act = rule.action === 'BUY' ? 'קנייה' : rule.action === 'SELL' ? 'מכירה' : 'התראה';
    const amt = rule.action === 'ALERT_ONLY' ? '' : (rule.amount.type === 'SHARES' ? ` ${_taFmtNum(rule.amount.value)} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? ` ${rule.amount.value}%` : ` $${_taFmtNum(rule.amount.value)}`);
    return `אם ${conds.join(rule.logic === 'ALL' ? ' וגם ' : ' או ')} ← ${act}${amt}${rule.target_asset ? ' ' + rule.target_asset : ''}`;
}
function _taWhen(ts) { try { const d = new Date(ts); return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

async function _taToggle(id) {
    const s = _taStrategies.find(x => x.id === id); if (!s) return;
    if (typeof ensureSupabaseReady === 'function' && !(await ensureSupabaseReady())) return;
    const next = s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    try { await supabaseClient.from('automated_strategies').update({ status: next, updated_at: new Date().toISOString() }).eq('id', id); s.status = next; _taRenderList(); if (next === 'ACTIVE') _taCheckStrategies(true); } catch (e) { }
}
async function _taDelete(id) {
    if (typeof ensureSupabaseReady === 'function' && !(await ensureSupabaseReady())) return;
    try { await supabaseClient.from('automated_strategies').delete().eq('id', id); _taStrategies = _taStrategies.filter(x => x.id !== id); _taRenderList(); } catch (e) { }
}

// ══════════════ BROKER CONNECTION INFRASTRUCTURE ══════════════
// A broker adapter is the seam between a fired strategy and order execution. Every strategy runs
// through an adapter: the built-in PAPER simulator (always available, never real money) or a real
// broker (IBKR/Alpaca). Real adapters are INFRASTRUCTURE ONLY — they require a secure server-side
// proxy (OAuth + a hosted IB Gateway) and, until that exists, they FAIL SAFE: no live order is sent.
const _TA_BROKER_DEFS = {
    PAPER: { label: 'סימולטור (Paper)', icon: '', instant: true, real: false, note: 'חשבון מסחר מדומה מובנה — אין כסף אמיתי, מתחבר מיידית.' },
    IBKR: { label: 'Interactive Brokers', icon: '', instant: false, real: true, note: 'דורש OAuth + IB Gateway מתארח בצד השרת. הסודות לעולם אינם נשמרים בצד הלקוח.' },
    ALPACA: { label: 'Alpaca', icon: '', instant: false, real: true, note: 'דורש מפתחות API בצד השרת (proxy מאובטח). הסודות לעולם אינם נשמרים בצד הלקוח.' },
};
// Return an adapter object for a broker_connections row. { broker, real, connect(), placeOrder(order) }.
function _taBrokerAdapter(conn) {
    const broker = (conn && conn.broker) || 'PAPER';
    if (broker === 'PAPER') {
        return {
            broker, real: false,
            async connect() { return { ok: true, status: 'CONNECTED', message: 'חשבון סימולציה מחובר' }; },
            async placeOrder(o) { return { ok: true, real: false, message: `סימולציה דרך הברוקר: ${o.side} ${o.qtyLabel} ${o.symbol}${o.price != null ? ` @ ~$${(+o.price).toFixed(2)}` : ''}` }; },
        };
    }
    // Real broker — the terminal is a deliberate safe stub until the server proxy is wired.
    return {
        broker, real: true,
        async connect() { return { ok: false, status: 'PENDING', message: `חיבור ${broker} דורש שרת proxy מאובטח (OAuth + Gateway). ההגדרה טרם הושלמה בצד השרת — החיבור נשמר כ"ממתין".` }; },
        async placeOrder(o) { return { ok: false, real: false, message: `${broker}: ה-Gateway אינו מוגדר — לא נשלחה פקודת אמת (${o.side} ${o.qtyLabel} ${o.symbol}).` }; },
    };
}

async function _taLoadBrokers() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        const { data, error } = await supabaseClient.from('broker_connections').select('*').order('created_at', { ascending: false });
        if (error) return;
        _taBrokers = data || [];
        _taRenderBrokers();
    } catch (e) { }
}
function _taRenderBrokers() {
    const el = document.getElementById('taBrokerCard');
    if (!el) return;
    const stHe = { CONNECTED: ['מחובר', 'ta-bk-on'], PENDING: ['ממתין להגדרה', 'ta-bk-pend'], DISCONNECTED: ['מנותק', 'ta-bk-off'], ERROR: ['שגיאה', 'ta-bk-err'] };
    const rows = _taBrokers.map(b => {
        const def = _TA_BROKER_DEFS[b.broker] || { label: b.broker, icon: '' };
        const st = stHe[b.status] || [b.status, ''];
        const modeHe = b.account_mode === 'LIVE' ? 'אמיתי' : 'מדומה';
        const cfg = b.config || {};
        const meta = [cfg.account_id ? `חשבון ${_taEsc(cfg.account_id)}` : '', cfg.gateway_url ? _taEsc(cfg.gateway_url) : ''].filter(Boolean).join(' · ');
        return `<div class="ta-bk-row">
            <div class="ta-bk-id"><span class="ta-bk-name">${_taEsc(b.label || def.label)}</span><span class="ta-bk-meta">${_taEsc(def.label)}${meta ? ' · ' + meta : ''} · ${modeHe}</span></div>
            <span class="ta-bk-badge ${st[1]}">${st[0]}</span>
            ${b.status !== 'CONNECTED' ? `<button class="ta-mini ta-mini-on" onclick="_taConnectBroker(${b.id})">חבר</button>` : `<button class="ta-mini" onclick="_taConnectBroker(${b.id})">בדוק</button>`}
            <button class="ta-mini ta-mini-del" onclick="_taDeleteBroker(${b.id})" title="מחק">מחק</button>
        </div>`;
    }).join('');
    el.innerHTML = `<div id="taBrokerForm"></div>${_taBrokers.length ? rows : '<div class="wl-empty">אין חיבורי ברוקר. הוסף חיבור כדי לאפשר מצב הרצה אמיתי (Live). מצב סימולציה והתראה עובדים גם בלי חיבור.</div>'}`;
}
function _taOpenBrokerForm() {
    const holder = document.getElementById('taBrokerForm');
    if (!holder) return;
    if (holder.dataset.open === '1') { holder.innerHTML = ''; holder.dataset.open = ''; return; }
    holder.dataset.open = '1';
    const opts = Object.keys(_TA_BROKER_DEFS).map(k => `<option value="${k}">${_taEsc(_TA_BROKER_DEFS[k].label)}</option>`).join('');
    holder.innerHTML = `<div class="ta-bk-form">
        <div class="ta-bk-form-grid">
            <label>ברוקר<select id="taBkType" onchange="_taBrokerFormNote()">${opts}</select></label>
            <label>כינוי<input id="taBkLabel" placeholder="למשל: חשבון ראשי"></label>
            <label>מצב חשבון<select id="taBkMode"><option value="PAPER">מדומה (Paper)</option><option value="LIVE">אמיתי (Live)</option></select></label>
            <label>מזהה חשבון<input id="taBkAccount" placeholder="לא סודי — למשל U1234567"></label>
            <label>כתובת Gateway<input id="taBkGateway" placeholder="https://… (אופציונלי)"></label>
        </div>
        <div class="ta-bk-note" id="taBkNote">${_taEsc(_TA_BROKER_DEFS.PAPER.note)}</div>
        <div class="ta-bk-secnote">סיסמאות ומפתחות API לעולם אינם נשמרים כאן. חיבור אמיתי מתבצע דרך שרת proxy מאובטח בלבד.</div>
        <div class="ta-bk-form-actions">
            <button class="corr-run-btn corr-run-primary" onclick="_taSaveBroker()">שמור חיבור</button>
            <button class="wl-close-btn" onclick="_taOpenBrokerForm()">בטל</button>
        </div>
    </div>`;
}
function _taBrokerFormNote() {
    const t = (document.getElementById('taBkType') || {}).value;
    const n = document.getElementById('taBkNote');
    if (n && _TA_BROKER_DEFS[t]) n.textContent = _TA_BROKER_DEFS[t].note;
}
async function _taSaveBroker() {
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    const broker = (document.getElementById('taBkType') || {}).value || 'PAPER';
    const label = ((document.getElementById('taBkLabel') || {}).value || '').trim() || (_TA_BROKER_DEFS[broker] || {}).label || broker;
    const account_mode = (document.getElementById('taBkMode') || {}).value === 'LIVE' ? 'LIVE' : 'PAPER';
    const config = { account_id: ((document.getElementById('taBkAccount') || {}).value || '').trim() || null, gateway_url: ((document.getElementById('taBkGateway') || {}).value || '').trim() || null };
    const def = _TA_BROKER_DEFS[broker] || {};
    // Paper connects instantly; real brokers start PENDING (need the server-side proxy).
    const status = def.instant ? 'CONNECTED' : 'PENDING';
    try {
        const { error } = await supabaseClient.from('broker_connections').insert({ broker, label, status, account_mode, config, last_check: new Date().toISOString() });
        if (error) throw error;
        if (typeof showToast === 'function') showToast(def.instant ? 'חשבון הסימולציה חובר' : 'החיבור נשמר במצב "ממתין" — נדרשת הגדרת שרת', 'success');
        const holder = document.getElementById('taBrokerForm'); if (holder) { holder.innerHTML = ''; holder.dataset.open = ''; }
        await _taLoadBrokers();
    } catch (e) { if (typeof showToast === 'function') showToast('שמירת החיבור נכשלה', 'error'); }
}
async function _taConnectBroker(id) {
    const b = _taBrokers.find(x => x.id === id); if (!b) return;
    if (typeof ensureSupabaseReady === 'function' && !(await ensureSupabaseReady())) return;
    const res = await _taBrokerAdapter(b).connect();
    try {
        await supabaseClient.from('broker_connections').update({ status: res.status || (res.ok ? 'CONNECTED' : 'PENDING'), last_check: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    } catch (e) { }
    if (typeof showToast === 'function') showToast(res.message, res.ok ? 'success' : 'error');
    await _taLoadBrokers();
}
async function _taDeleteBroker(id) {
    if (typeof ensureSupabaseReady === 'function' && !(await ensureSupabaseReady())) return;
    try { await supabaseClient.from('broker_connections').delete().eq('id', id); _taBrokers = _taBrokers.filter(x => x.id !== id); _taRenderBrokers(); } catch (e) { }
}
async function _taGetBrokerConn(id) {
    if (!id) return null;
    const cached = _taBrokers.find(x => x.id === id); if (cached) return cached;
    try { const { data } = await supabaseClient.from('broker_connections').select('*').eq('id', id).single(); return data || null; } catch (e) { return null; }
}
function _taOnModeChange() {
    const mode = (document.getElementById('taMode') || {}).value;
    const pf = document.getElementById('taPortfolioPick');
    const bk = document.getElementById('taBrokerPick');
    if (pf) pf.style.display = mode === 'PAPER' ? 'inline-flex' : 'none';
    if (bk) bk.style.display = mode === 'LIVE' ? 'inline-flex' : 'none';
}

// ══ DRY-RUN EVALUATION ENGINE — checks ACTIVE strategies against REAL live data ══
function _taRSI(closes, period) {
    period = period || 14;
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    let ag = gain / period, al = loss / period;
    for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period; al = (al * (period - 1) + (d < 0 ? -d : 0)) / period; }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
}
async function _taRsiValue(sym, tf) {
    tf = (tf || 'daily').toLowerCase();
    let interval = '1d', range = '3mo', group = 1;
    const mh = tf.match(/^(\d+)\s*h/);
    if (mh) { interval = '1h'; range = '1mo'; group = Math.max(1, parseInt(mh[1], 10) || 1); }
    else if (tf === 'weekly' || tf === '1w' || tf === '1wk') { interval = '1wk'; range = '2y'; }
    try {
        const r = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}&interval=${interval}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        let closes = ((j && j.points) || []).map(p => p.close).filter(x => x != null && isFinite(x));
        if (group > 1) { const g = []; for (let i = group - 1; i < closes.length; i += group) g.push(closes[i]); closes = g; }
        return _taRSI(closes, 14);
    } catch (e) { return null; }
}
// Entity → tradeable Yahoo symbol (mirrors the server _STRAT_TICKERS so the client can monitor the
// SAME real series the parser resolved: "ביטקוין"→BTC-USD, "נפט"→USO, …).
const _TA_TICKERS = {
    bitcoin: 'BTC-USD', 'ביטקוין': 'BTC-USD', btc: 'BTC-USD', ethereum: 'ETH-USD', 'אתריום': 'ETH-USD', 'את׳ריום': 'ETH-USD', eth: 'ETH-USD',
    gold: 'GLD', 'זהב': 'GLD', oil: 'USO', 'נפט': 'USO', crude: 'USO', silver: 'SLV', 'כסף': 'SLV',
    nasdaq: 'QQQ', 'נאסדק': 'QQQ', 'sp500': 'SPY', 'ספ500': 'SPY', dow: 'DIA', 'דאו': 'DIA', vix: '^VIX',
};
function _taResolveTicker(s) {
    if (s == null) return null;
    const k = String(s).trim().toLowerCase().replace(/["״׳'`\s]/g, '');
    if (_TA_TICKERS[k]) return _TA_TICKERS[k];
    const up = String(s).trim().toUpperCase();
    if (/^[A-Z]{1,6}(-USD|\.TA)?$/.test(up) || /^\^[A-Z]+$/.test(up)) return up;
    return null;
}
// Fetch a plain closes[] array for a symbol at an interval/range.
async function _taCloses(sym, interval, range) {
    try {
        const r = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}&interval=${interval}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        return ((j && j.points) || []).map(p => p.close).filter(x => x != null && isFinite(x));
    } catch (e) { return null; }
}
// Simple moving average over the LAST `period` closes.
function _taSma(closes, period) {
    if (!Array.isArray(closes) || closes.length < period || period < 1) return null;
    let sum = 0; for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
    return sum / period;
}
// Pick a Yahoo interval+range that yields at least `period` REAL bars. NOTE: range='max' with a
// weekly interval is DOWNSAMPLED by Yahoo (~163 coarse points even for a 40-year stock), so prefer
// the explicit '10y' tier (≈520 true weekly bars) before ever falling back to 'max'.
function _taMaParams(tf, period) {
    if (tf === 'weekly' || tf === '1wk' || tf === '1w') {
        const w = period + 10;
        const range = w <= 52 ? '1y' : w <= 104 ? '2y' : w <= 260 ? '5y' : w <= 520 ? '10y' : 'max';
        return { interval: '1wk', range };
    }
    const d = period + 20;
    const range = d <= 130 ? '6mo' : d <= 260 ? '1y' : d <= 520 ? '2y' : d <= 1300 ? '5y' : 'max';
    return { interval: '1d', range };
}
// The platform's precomputed technical scan (price, rsiD/rsiW, ma.{d200,d300,w200,w300} + *dist).
// Cached ~60s so an MA + RSI condition on the same symbol share one fetch.
const _taScanCache = {};
async function _taScan(sym) {
    const key = String(sym || '').toUpperCase();
    const c = _taScanCache[key];
    if (c && (Date.now() - c.t) < 60000) return c.v;
    try {
        const r = await fetch(`/api/technicals?mode=scan&symbols=${encodeURIComponent(key)}&v=2`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        const v = (j && j.results && j.results[key]) || null;
        _taScanCache[key] = { t: Date.now(), v };
        return v;
    } catch (e) { return null; }
}
// Evaluate ONE condition → { met:boolean, value:string } (value for the log). Real data only.
async function _taEvalCondition(c, rule) {
    // Resolve the MONITORED symbol from the condition subject (may differ from target_asset — e.g.
    // monitor BTC-USD, trade MSTR). Fall back to target_asset when the subject isn't a symbol.
    const sym = (_taResolveTicker(c.subject) || String(rule.target_asset || '').toUpperCase());
    const cmp = (v, th) => {
        const op = c.operator;
        if (op === 'ABOVE' || op === 'GTE' || op === 'CROSSES_ABOVE') return v >= th;
        if (op === 'BELOW' || op === 'LTE' || op === 'CROSSES_BELOW') return v <= th;
        if (op === 'EQUALS') return Math.abs(v - th) < 1e-6;
        return false;
    };
    try {
        if (c.factor === 'price' && sym && c.threshold != null) {
            const r = await fetch(`/api/quote?symbols=${encodeURIComponent(sym)}`, { headers: { Accept: 'application/json' } });
            const j = await r.json(); const q = (j && (j[sym] || (j.quotes && j.quotes[sym]))) || {};
            const price = q.price != null ? q.price : q.regularMarketPrice;
            if (price == null) return { met: false, value: 'אין מחיר' };
            return { met: cmp(price, +c.threshold), value: `מחיר ${sym} $${(+price).toFixed(2)}` };
        }
        if (c.factor === 'rsi' && sym && c.threshold != null) {
            const tf = (c.timeframe || 'daily').toLowerCase();
            const weekly = tf === 'weekly' || tf === '1wk' || tf === '1w';
            const intraday = /^\d+\s*h/.test(tf);
            let rsi = null;
            // Standard daily/weekly RSI → use the platform's precomputed scan (reliable). Intraday → history.
            if (!intraday) { const scan = await _taScan(sym); if (scan) { const v = weekly ? scan.rsiW : scan.rsiD; if (v != null) rsi = +v; } }
            if (rsi == null) rsi = await _taRsiValue(sym, c.timeframe);
            if (rsi == null) return { met: false, value: `אין RSI ל-${sym}` };
            return { met: cmp(rsi, +c.threshold), value: `RSI ${sym} ${rsi.toFixed(1)}${c.timeframe ? ' (' + c.timeframe + ')' : ''}` };
        }
        if (c.factor === 'ma' && sym) {
            // The MA "level" is the moving average itself. Prefer the platform's precomputed technical
            // scan (w200/w300/d200/d300) — reliable, no history-length gaps; fall back to a real SMA
            // from /api/history for non-standard periods (or symbols the scan doesn't cover, e.g. crypto).
            const period = c.period || (typeof c.threshold === 'number' ? Math.round(c.threshold) : 200);
            const tf = (c.timeframe || 'daily').toLowerCase();
            const weekly = tf === 'weekly' || tf === '1wk' || tf === '1w';
            let ma = null, price = null, distPct = null;
            if (period === 200 || period === 300) {
                const scan = await _taScan(sym); const m = scan && scan.ma; const k = (weekly ? 'w' : 'd') + period;
                if (m && m[k] != null && m[k + 'dist'] != null) { ma = +m[k]; distPct = +m[k + 'dist']; price = scan.price != null ? +scan.price : null; }
            }
            if (ma == null) {
                const { interval, range } = _taMaParams(tf, period);
                const closes = await _taCloses(sym, interval, range);
                if (closes && closes.length >= period + 1) { ma = _taSma(closes, period); price = closes[closes.length - 1]; if (ma) distPct = ((price - ma) / ma) * 100; }
            }
            if (ma == null || distPct == null) return { met: false, value: `אין נתוני ממוצע ${period} ל-${sym}` };
            if (price == null) price = ma * (1 + distPct / 100);
            const unit = weekly ? ' שבועות' : ' ימים';
            const met = c.operator === 'EQUALS' ? Math.abs(distPct) <= 2.5 : cmp(price, ma);
            const near = c.operator === 'EQUALS' ? (met ? ' — נוגע' : ' — לא נוגע') : '';
            return { met, value: `${sym} $${(+price).toFixed(2)} מול ממוצע ${period}${unit} $${(+ma).toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(1)}%)${near}` };
        }
        if (c.factor === 'eps_surprise' && c.threshold != null) {
            const t = sym || rule.target_asset; if (!t) return { met: false, value: 'נדרש טיקר לדוח' };
            const r = await fetch(`/api/technicals?mode=earnings&symbols=${encodeURIComponent(t)}`, { headers: { Accept: 'application/json' } });
            const j = await r.json(); const info = (j.results || {})[String(t).toUpperCase()] || {};
            if (info.surprisePct == null) return { met: false, value: 'טרם פורסם דוח' };
            const recent = info.reportedDate && ((Date.now() - new Date(info.reportedDate)) / 86400e3 <= 5);
            return { met: recent && cmp(info.surprisePct, +c.threshold), value: `הפתעת EPS ${info.surprisePct >= 0 ? '+' : ''}${info.surprisePct}%${recent ? '' : ' (לא טרי)'}` };
        }
        if (c.factor === 'news' || c.factor === 'macro') {
            const kws = String(c.keyword || c.subject || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            if (!kws.length) return { met: false, value: 'אין מילות מפתח' };
            const r = await fetch('/api/news?macro=1', { headers: { Accept: 'application/json' } });
            const j = await r.json(); const items = (j.macro || []);
            const hit = items.find(n => { const blob = ((n.he || '') + ' ' + (n.en || '')).toLowerCase(); return kws.some(k => blob.includes(k)); });
            return { met: !!hit, value: hit ? `נמצא בחדשות: "${(hit.he || hit.en || '').slice(0, 50)}"` : 'אין אזכור בחדשות' };
        }
    } catch (e) { }
    return { met: false, value: 'לא ניתן להעריך' };
}
// Reflect a portfolio change into the app's global `clients` cache + re-render the dashboard.
function _taSyncClient(id, updated) {
    try {
        if (typeof clients !== 'undefined' && Array.isArray(clients)) { const i = clients.findIndex(c => c.id === id); if (i !== -1 && updated) clients[i] = updated; }
        if (typeof refreshDashboard === 'function') refreshDashboard();
    } catch (e) { }
}
// Execute a fired BUY/SELL FOR REAL against a linked in-platform (paper) portfolio, via the existing
// buy/sell engine. Returns { ok, message }. Fails safe: on any guard/failure it does NOT trade.
// Is the market for this ticker currently open (INCLUDING pre-market + after-hours)?
//   US  → Mon–Fri 04:00–20:00 ET  (pre-market 04:00, regular 09:30-16:00, after-hours →20:00)
//   TASE→ Sun–Thu ~09:00–17:40 Israel time (pre-open + continuous + closing auction)
// (Holidays are not modeled — day/hour only.) Orders never execute outside these windows.
function _taIsIsraeli(ticker) { const t = String(ticker || '').toUpperCase(); return /\.TA$|\.TASE$/.test(t) || /^\d{6,9}$/.test(t); }
function _taMarketOpen(ticker) {
    const il = _taIsIsraeli(ticker);
    const tz = il ? 'Asia/Jerusalem' : 'America/New_York';
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
        const get = (k) => (parts.find(p => p.type === k) || {}).value;
        const wd = get('weekday'); let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0; const mins = hh * 60 + parseInt(get('minute'), 10);
        if (il) { if (wd === 'Fri' || wd === 'Sat') return false; return mins >= 9 * 60 && mins <= 17 * 60 + 40; }
        if (wd === 'Sat' || wd === 'Sun') return false; return mins >= 4 * 60 && mins <= 20 * 60;
    } catch (e) { return true; } // if TZ math fails, don't block
}
function _taMarketClosedMsg(ticker) { return `מחוץ לשעות המסחר של ${_taIsIsraeli(ticker) ? 'הבורסה בת"א' : 'שוק ארה"ב'} — ההזמנה ממתינה לפתיחת המסחר`; }

async function _taExecutePaperTrade(portfolioId, rule, px) {
    if (typeof portfolioBuyAsset !== 'function' || typeof portfolioSellAsset !== 'function') return { ok: false, message: 'מנוע התיקים אינו זמין' };
    const sym = String(rule.target_asset || '').toUpperCase();
    if (!sym) return { ok: false, message: 'אין נכס יעד לפעולה' };
    // Orders execute ONLY during market hours (incl. pre/after-hours). Outside → defer (order queued).
    if (!_taMarketOpen(sym)) return { ok: false, deferred: true, message: _taMarketClosedMsg(sym) };
    if (px == null || !(+px > 0)) return { ok: false, message: `אין מחיר שוק זמין ל-${sym}` };
    const client = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients.find(c => c.id === portfolioId) : null;
    const pname = client ? client.name : ('#' + portfolioId);
    const amt = rule.amount || { type: 'CASH_USD', value: 0 };
    try {
        if (rule.action === 'BUY') {
            let qty;
            if (amt.type === 'SHARES') qty = Math.floor(amt.value);
            else if (amt.type === 'PORTFOLIO_PCT') { const cashUsd = client ? ((client.cash && client.cash.usd) || 0) : 0; qty = Math.floor((cashUsd * (amt.value / 100)) / px); }
            else qty = Math.floor(amt.value / px); // CASH_USD
            if (!qty || qty < 1) return { ok: false, message: `הסכום אינו מספיק ליחידה אחת של ${sym} (~$${(+px).toFixed(2)})` };
            const updated = await portfolioBuyAsset(portfolioId, { type: 'stock', ticker: sym, stockName: sym, price: +px, quantity: qty, currency: 'USD' });
            if (!updated || updated.error) return { ok: false, message: (updated && updated.error === 'insufficient_cash') ? `אין מספיק מזומן בתיק «${pname}»` : `הקנייה נכשלה (${(updated && updated.error) || 'שגיאה'})` };
            _taSyncClient(portfolioId, updated);
            return { ok: true, message: `בוצעה קנייה בתיק «${pname}»: ${qty} מניות ${sym} @ ~$${(+px).toFixed(2)}` };
        } else { // SELL
            if (!client) return { ok: false, message: `התיק «${pname}» לא נמצא במטמון` };
            const h = (client.holdings || []).find(x => String(x.ticker || '').toUpperCase() === sym);
            if (!h) return { ok: false, message: `אין אחזקה ב-${sym} בתיק «${pname}» למכירה` };
            let qty;
            if (amt.type === 'SHARES') qty = Math.min(Math.floor(amt.value), h.shares);
            else if (amt.type === 'PORTFOLIO_PCT') qty = Math.floor(h.shares * (amt.value / 100));
            else qty = Math.min(Math.floor(amt.value / px), h.shares); // CASH_USD → shares worth that cash
            if (!qty || qty < 1) return { ok: false, message: `כמות המכירה שחושבה קטנה מדי ב-${sym}` };
            const res = await portfolioSellAsset(portfolioId, h.id, qty);
            if (!res) return { ok: false, message: `המכירה נכשלה ב-${sym}` };
            if (typeof supaFetchClient === 'function') { const fresh = await supaFetchClient(portfolioId); if (fresh) _taSyncClient(portfolioId, fresh); }
            return { ok: true, message: `בוצעה מכירה בתיק «${pname}»: ${qty} מניות ${sym} @ ~$${(+px).toFixed(2)}` };
        }
    } catch (e) { return { ok: false, message: 'שגיאה בביצוע בתיק' }; }
}
// Run a SCREENER strategy: scan the index, buy each NEW matching stock for the per-stock amount,
// up to the total budget (tracked in screener_state). Stays ACTIVE (continuous, not fire-once).
async function _taRunScreener(s) {
    const rule = s.parsed_rule || {}; const sc = rule.screener; if (!sc) return;
    const state = s.screener_state || { spent: 0, bought: [] };
    const bought = Array.isArray(state.bought) ? state.bought : [];
    const budget = +sc.total_budget_usd || 0;
    const logs = Array.isArray(s.execution_logs) ? s.execution_logs.slice(-40) : [];
    const { tickers, results } = await _taScreenUniverse(sc.universe);
    const matches = tickers.filter(t => _taScrMatchStock(results[t], rule));
    // Fixed mode: a set $ per stock. Equal mode: the total budget split across the current matches.
    const per = sc.split_mode === 'equal'
        ? (matches.length > 0 && budget > 0 ? Math.floor(budget / matches.length) : 0)
        : (+sc.per_stock_usd || 0);
    const held = new Set();
    if (s.portfolio_id && typeof clients !== 'undefined') { const c = clients.find(x => x.id === s.portfolio_id); if (c) (c.holdings || []).forEach(h => held.add(String(h.ticker || '').toUpperCase())); }
    // Index stocks (NDX/SP500) trade on US hours; if the market is closed, defer the buys.
    const marketOpen = _taMarketOpen('SPY');
    let boughtNow = 0, pendingCount = 0;
    for (const t of matches) {
        if (bought.includes(t) || held.has(String(t).toUpperCase())) continue;
        if (budget > 0 && state.spent + per > budget + 0.01) break; // budget exhausted
        if (s.mode === 'PAPER' && s.portfolio_id && !marketOpen) { pendingCount++; continue; } // wait for market hours
        if (s.mode === 'PAPER' && s.portfolio_id) {
            let px = null; try { const r = await fetch(`/api/quote?symbols=${encodeURIComponent(t)}`); const jj = await r.json(); const q = jj[t] || (jj.quotes && jj.quotes[t]) || {}; px = q.price != null ? q.price : q.regularMarketPrice; } catch (e) { }
            const exec = await _taExecutePaperTrade(s.portfolio_id, { action: 'BUY', target_asset: t, amount: { type: 'CASH_USD', value: per } }, px);
            if (exec.ok) { bought.push(t); state.spent += per; boughtNow++; logs.push({ ts: new Date().toISOString(), kind: 'triggered', message: `[סורק] ${exec.message}` }); }
            else logs.push({ ts: new Date().toISOString(), kind: 'check', message: `[סורק] דילוג ${t} — ${exec.message}` });
        } else {
            bought.push(t); boughtNow++;
            logs.push({ ts: new Date().toISOString(), kind: 'triggered', message: `[סורק] ${t} עונה על התנאי (התראה בלבד)` });
        }
    }
    state.bought = bought;
    const budgetDone = budget > 0 && state.spent + per > budget + 0.01;
    if (pendingCount > 0) logs.push({ ts: new Date().toISOString(), kind: 'pending', message: `[סורק] ${pendingCount} מניות תואמות ${_taMarketClosedMsg('SPY')}` });
    else if (!boughtNow) logs.push({ ts: new Date().toISOString(), kind: 'check', message: `נסרקו ${tickers.length} מניות · ${matches.length} תואמות · ${bought.length} כבר נקנו${budgetDone ? ' · התקציב מוצה' : ''}` });
    try { await supabaseClient.from('automated_strategies').update({ status: 'ACTIVE', last_checked: new Date().toISOString(), execution_logs: logs.slice(-40), screener_state: state, updated_at: new Date().toISOString() }).eq('id', s.id); } catch (e) { }
    if (boughtNow && typeof showToast === 'function') showToast(`הסורק קנה ${boughtNow} מניות`, 'success');
}
// Evaluate all ACTIVE strategies; on a fire, log + execute (paper-portfolio / broker) / notify.
async function _taCheckStrategies(force) {
    if (_taChecking) return;
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) return;
    _taChecking = true;
    try {
        const { data } = await supabaseClient.from('automated_strategies').select('*').eq('status', 'ACTIVE');
        const rows = data || [];
        for (const s of rows) {
            const rule = s.parsed_rule || {}; const conds = rule.conditions || [];
            if (rule.screener) { try { await _taRunScreener(s); } catch (e) { } continue; }
            if (!conds.length) continue;
            const results = [];
            for (const c of conds) results.push(await _taEvalCondition(c, rule));
            const fired = rule.logic === 'ALL' ? results.every(r => r.met) : results.some(r => r.met);
            const logs = Array.isArray(s.execution_logs) ? s.execution_logs.slice(-40) : [];
            if (fired) {
                const detail = results.filter(r => r.met).map(r => r.value).join(' · ') || results.map(r => r.value).join(' · ');
                let msg; let deferred = false;
                if (rule.action === 'ALERT_ONLY' || s.mode === 'ALERT') {
                    msg = `טריגר התקיים — ${detail}`;
                } else {
                    // Get the current price of the traded asset for the (simulated or routed) fill.
                    let px = null;
                    try { if (rule.target_asset) { const r = await fetch(`/api/quote?symbols=${encodeURIComponent(rule.target_asset)}`); const jj = await r.json(); const q = jj[rule.target_asset] || (jj.quotes && jj.quotes[rule.target_asset]) || {}; px = q.price != null ? q.price : q.regularMarketPrice; } } catch (e) { }
                    const actHe = rule.action === 'BUY' ? 'קנייה' : 'מכירה';
                    const amtHe = rule.amount.type === 'SHARES' ? `${_taFmtNum(rule.amount.value)} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? `${rule.amount.value}% מהאחזקה` : `$${_taFmtNum(rule.amount.value)}`;
                    if (!_taMarketOpen(rule.target_asset)) {
                        // Order is "sent" (trigger met) but execution waits for market hours — stay ACTIVE.
                        deferred = true;
                        msg = `הטריגר התקיים — ${_taMarketClosedMsg(rule.target_asset)} · ${detail}`;
                    } else if (s.mode === 'LIVE') {
                        // Route the order through the broker adapter. Real brokers fail safe (no live order).
                        const conn = await _taGetBrokerConn(s.broker_connection_id);
                        const order = { side: rule.action === 'BUY' ? 'BUY' : 'SELL', symbol: rule.target_asset || '', qtyLabel: amtHe, price: px };
                        const res = await _taBrokerAdapter(conn).placeOrder(order);
                        msg = res.ok ? `${res.real ? 'בוצעה פקודת אמת' : ''} ${res.message} — ${detail}`.trim() : `מצב Live נחסם — ${res.message} · ${detail}`;
                    } else if (s.mode === 'PAPER' && s.portfolio_id) {
                        // Execute the trade FOR REAL in the linked paper portfolio (deduct cash / add-remove position).
                        const exec = await _taExecutePaperTrade(s.portfolio_id, rule, px);
                        if (exec.deferred) { deferred = true; msg = `${exec.message} · ${detail}`; }
                        else msg = exec.ok ? `${exec.message} — ${detail}` : `לא בוצע בתיק — ${exec.message} · ${detail}`;
                    } else {
                        // Legacy PAPER without a linked portfolio → simulate + log only.
                        msg = `סימולציה: בוצעה ${actHe} של ${amtHe} ${rule.target_asset || ''}${px != null ? ` במחיר ~$${(+px).toFixed(2)}` : ''} — ${detail}`;
                    }
                }
                logs.push({ ts: new Date().toISOString(), kind: deferred ? 'pending' : 'triggered', message: msg });
                try {
                    if (deferred) {
                        // Keep monitoring — it will execute on the next check inside market hours.
                        await supabaseClient.from('automated_strategies').update({ last_checked: new Date().toISOString(), execution_logs: logs.slice(-40), updated_at: new Date().toISOString() }).eq('id', s.id);
                    } else {
                        await supabaseClient.from('automated_strategies').update({ status: 'TRIGGERED', triggered_at: new Date().toISOString(), last_checked: new Date().toISOString(), execution_logs: logs, updated_at: new Date().toISOString() }).eq('id', s.id);
                    }
                } catch (e) { }
                if (!deferred && typeof showToast === 'function') showToast(`אסטרטגיה "${s.name}" הופעלה`, 'success');
                if (!deferred && typeof window !== 'undefined' && typeof window.checkStockAlerts === 'function') { const dot = document.getElementById('bellDot'); if (dot) dot.style.display = 'block'; }
            } else {
                logs.push({ ts: new Date().toISOString(), kind: 'check', message: `נבדק — התנאים לא התקיימו (${results.map(r => r.value).join(' · ').slice(0, 120)})` });
                try { await supabaseClient.from('automated_strategies').update({ last_checked: new Date().toISOString(), execution_logs: logs.slice(-40) }).eq('id', s.id); } catch (e) { }
            }
        }
        if (document.getElementById('taList')) _taLoadStrategies();
    } catch (e) { }
    window._taLastRun = Date.now();
    _taUpdateMonitorBar();
    _taChecking = false;
}
// Show the user that monitoring is live: "נבדק לאחרונה HH:MM · בדיקה הבאה בעוד ~N דק".
function _taUpdateMonitorBar() {
    const el = document.getElementById('taMonLast');
    if (!el) return;
    const last = window._taLastRun;
    if (!last) { el.textContent = ''; return; }
    const hhmm = new Date(last).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    el.textContent = `· בדיקת דפדפן אחרונה ${hhmm}`;
}

// ── Init: monitor strategies while the app is open (every 5 min) ──
function _taInit() { _taCheckStrategies(); if (!window._taTimer) window._taTimer = setInterval(_taCheckStrategies, 5 * 60 * 1000); }
if (typeof window !== 'undefined') {
    window.openTradingAgentPage = openTradingAgentPage; window.closeTradingAgentPage = closeTradingAgentPage;
    window._taParse = _taParse; window._taEnable = _taEnable; window._taToggle = _taToggle; window._taDelete = _taDelete;
    window._taCancelCard = () => { const b = document.getElementById('taCard'); if (b) b.innerHTML = ''; _taPendingRule = null; _taEditingId = null; };
    window._taOnModeChange = _taOnModeChange; window._taFmtAmtInput = _taFmtAmtInput; window._taUpdateActPreview = _taUpdateActPreview; window._taRunScreenerPreview = _taRunScreenerPreview; window._taScrModeChange = _taScrModeChange; window._taScrUniverseChange = _taScrUniverseChange;
    window._taEditStrategy = _taEditStrategy; window._taToggleStructure = _taToggleStructure;
    window._taAdviceCardHtml = _taAdviceCardHtml; window._taIdeaToStrategy = _taIdeaToStrategy; window._taUseSuggestion = _taUseSuggestion;
    window._taOpenBrokerForm = _taOpenBrokerForm; window._taBrokerFormNote = _taBrokerFormNote; window._taSaveBroker = _taSaveBroker;
    window._taConnectBroker = _taConnectBroker; window._taDeleteBroker = _taDeleteBroker;
    window._taCheckStrategies = _taCheckStrategies; window._taPendingRule = _taPendingRule;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_taInit, 6000));
    else setTimeout(_taInit, 6000);
}
