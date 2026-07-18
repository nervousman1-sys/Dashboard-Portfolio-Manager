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
    'אילו מניות רלוונטיות לתקופה הקרובה לפי מאקרו-כלכלה, מצב עולמי ופריצות דרך טכנולוגיות?',
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
    _taLoadBrokers();
    _taLoadStrategies();
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
    if (typeof clearURLState === 'function') clearURLState();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
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
                <span class="ta-mon-dot"></span>
                <span class="ta-mon-txt" id="taMonTxt">הסוכן פעיל — מנטר את האסטרטגיות כל 5 דקות כל עוד האתר פתוח</span>
                <span class="ta-mon-last" id="taMonLast"></span>
                <button class="ta-mini ta-mini-on" onclick="_taCheckStrategies(true)">בדוק עכשיו</button>
            </div>
            <div class="risk-table-card glass-card" style="padding:18px">
                <div class="ta-chat-title">תאר אסטרטגיה בשפה חופשית — או שאל שאלת שוק פתוחה. הסוכן יבין, יארגן את הנתונים בפלטפורמה ומחוצה לה, ויחזיר כרטיס אסטרטגיה או ניתוח עם רעיונות.</div>
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

// ── Parse the NL text → StrategyRule (LLM + fallback), then show the confirmation card ──
async function _taParse() {
    const inp = document.getElementById('taInput');
    const box = document.getElementById('taCard');
    const text = inp ? inp.value.trim() : '';
    if (!text || !box) return;
    box.innerHTML = '<div class="ta-card-load"><div class="rep-spinner"></div>מפענח את האסטרטגיה…</div>';
    try {
        const r = await fetch('/api/vision?mode=strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        const j = await r.json();
        if (j && j.advice) { _taPendingRule = null; box.innerHTML = _taAdviceCardHtml(j.advice); return; }
        if (!r.ok || j.error || !j.rule) { box.innerHTML = `<div class="ta-card-err">${_taEsc(j.message || 'לא הצלחתי להבין את הבקשה. נסה לתאר אסטרטגיה (טריגר → פעולה → נכס) או לשאול שאלת שוק.')}</div>`; return; }
        _taPendingRule = j.rule;
        box.innerHTML = _taStrategyCardHtml(j.rule, j.summary_he, j.source);
    } catch (e) {
        box.innerHTML = '<div class="ta-card-err">מנוע ה-AI עמוס כרגע. נסה שוב בעוד רגע.</div>';
    }
}

// ── Advisory card — for open-ended market questions ("which stocks fit the coming period?") ──
let _taSuggestion = null;
function _taAdviceCardHtml(a) {
    _taSuggestion = a && a.suggested_strategy_he ? a.suggested_strategy_he : null;
    const paras = String(a.answer_he || '').split(/\n\s*\n/).filter(Boolean).map(p => `<p class="ta-adv-p">${_taEsc(p)}</p>`).join('');
    const ideas = (a.ideas || []).map(i => `
        <div class="ta-idea">
            <div class="ta-idea-head"><span class="ta-idea-tk">${_taEsc(i.ticker)}</span>${i.name ? `<span class="ta-idea-name">${_taEsc(i.name)}</span>` : ''}</div>
            ${i.why ? `<div class="ta-idea-why">${_taEsc(i.why)}</div>` : ''}
            <button class="ta-mini ta-mini-on" onclick="_taIdeaToStrategy('${_taEsc(i.ticker)}')">בנה אסטרטגיה</button>
        </div>`).join('');
    return `<div class="ta-advice">
        <div class="ta-card-top"><span class="ta-card-name">${_taEsc(a.title || 'ניתוח והמלצות')}</span><span class="ta-trig">אנליסט AI</span></div>
        <div class="ta-adv-body">${paras}</div>
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
                <div class="ta-strat-id"><span class="ta-strat-name">${_taEsc(s.name)}</span><span class="ta-strat-sum">${summary}</span></div>
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
        box.innerHTML = _taStrategyCardHtml(_taPendingRule, _taRuleSummary(_taPendingRule), 'edit', s);
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}
function _taRuleSummary(rule) {
    if (!rule) return '';
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
// Pick a Yahoo interval+range that yields at least `period` bars at the requested timeframe.
function _taMaParams(tf, period) {
    if (tf === 'weekly' || tf === '1wk' || tf === '1w') {
        const w = period + 10;
        const range = w <= 52 ? '1y' : w <= 104 ? '2y' : w <= 260 ? '5y' : 'max';
        return { interval: '1wk', range };
    }
    const d = period + 20;
    const range = d <= 130 ? '6mo' : d <= 260 ? '1y' : d <= 520 ? '2y' : d <= 1300 ? '5y' : 'max';
    return { interval: '1d', range };
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
            const rsi = await _taRsiValue(sym, c.timeframe);
            if (rsi == null) return { met: false, value: 'אין RSI' };
            return { met: cmp(rsi, +c.threshold), value: `RSI ${sym} ${rsi.toFixed(1)}${c.timeframe ? ' (' + c.timeframe + ')' : ''}` };
        }
        if (c.factor === 'ma' && sym) {
            // The MA "level" is the moving average itself — compute the real SMA of the monitored
            // asset over `period` bars at the requested timeframe, then compare price vs that MA.
            const period = c.period || (typeof c.threshold === 'number' ? Math.round(c.threshold) : 200);
            const tf = (c.timeframe || 'daily').toLowerCase();
            const { interval, range } = _taMaParams(tf, period);
            const closes = await _taCloses(sym, interval, range);
            if (!closes || closes.length < period + 1) return { met: false, value: `אין מספיק היסטוריה ל-${sym} (נדרש ${period} ${tf === 'weekly' ? 'שבועות' : 'ימים'})` };
            const ma = _taSma(closes, period);
            const price = closes[closes.length - 1];
            if (ma == null || price == null) return { met: false, value: 'אין ממוצע' };
            const distPct = ((price - ma) / ma) * 100;
            const unit = tf === 'weekly' ? ' שבועות' : tf === 'daily' ? ' ימים' : '';
            // "Touches" the MA (operator EQUALS): met when price is within a small band of the average.
            const met = c.operator === 'EQUALS' ? Math.abs(distPct) <= 2.5 : cmp(price, ma);
            const near = c.operator === 'EQUALS' ? (Math.abs(distPct) <= 2.5 ? ' — נוגע' : ' — לא נוגע') : '';
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
async function _taExecutePaperTrade(portfolioId, rule, px) {
    if (typeof portfolioBuyAsset !== 'function' || typeof portfolioSellAsset !== 'function') return { ok: false, message: 'מנוע התיקים אינו זמין' };
    const sym = String(rule.target_asset || '').toUpperCase();
    if (!sym) return { ok: false, message: 'אין נכס יעד לפעולה' };
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
            if (!conds.length) continue;
            const results = [];
            for (const c of conds) results.push(await _taEvalCondition(c, rule));
            const fired = rule.logic === 'ALL' ? results.every(r => r.met) : results.some(r => r.met);
            const logs = Array.isArray(s.execution_logs) ? s.execution_logs.slice(-40) : [];
            if (fired) {
                const detail = results.filter(r => r.met).map(r => r.value).join(' · ') || results.map(r => r.value).join(' · ');
                let msg;
                if (rule.action === 'ALERT_ONLY' || s.mode === 'ALERT') {
                    msg = `טריגר התקיים — ${detail}`;
                } else {
                    // Get the current price of the traded asset for the (simulated or routed) fill.
                    let px = null;
                    try { if (rule.target_asset) { const r = await fetch(`/api/quote?symbols=${encodeURIComponent(rule.target_asset)}`); const jj = await r.json(); const q = jj[rule.target_asset] || (jj.quotes && jj.quotes[rule.target_asset]) || {}; px = q.price != null ? q.price : q.regularMarketPrice; } } catch (e) { }
                    const actHe = rule.action === 'BUY' ? 'קנייה' : 'מכירה';
                    const amtHe = rule.amount.type === 'SHARES' ? `${_taFmtNum(rule.amount.value)} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? `${rule.amount.value}% מהאחזקה` : `$${_taFmtNum(rule.amount.value)}`;
                    if (s.mode === 'LIVE') {
                        // Route the order through the broker adapter. Real brokers fail safe (no live order).
                        const conn = await _taGetBrokerConn(s.broker_connection_id);
                        const order = { side: rule.action === 'BUY' ? 'BUY' : 'SELL', symbol: rule.target_asset || '', qtyLabel: amtHe, price: px };
                        const res = await _taBrokerAdapter(conn).placeOrder(order);
                        msg = res.ok ? `${res.real ? 'בוצעה פקודת אמת' : ''} ${res.message} — ${detail}`.trim() : `מצב Live נחסם — ${res.message} · ${detail}`;
                    } else if (s.mode === 'PAPER' && s.portfolio_id) {
                        // Execute the trade FOR REAL in the linked paper portfolio (deduct cash / add-remove position).
                        const exec = await _taExecutePaperTrade(s.portfolio_id, rule, px);
                        msg = exec.ok ? `${exec.message} — ${detail}` : `לא בוצע בתיק — ${exec.message} · ${detail}`;
                    } else {
                        // Legacy PAPER without a linked portfolio → simulate + log only.
                        msg = `סימולציה: בוצעה ${actHe} של ${amtHe} ${rule.target_asset || ''}${px != null ? ` במחיר ~$${(+px).toFixed(2)}` : ''} — ${detail}`;
                    }
                }
                logs.push({ ts: new Date().toISOString(), kind: 'triggered', message: msg });
                try {
                    await supabaseClient.from('automated_strategies').update({ status: 'TRIGGERED', triggered_at: new Date().toISOString(), last_checked: new Date().toISOString(), execution_logs: logs, updated_at: new Date().toISOString() }).eq('id', s.id);
                } catch (e) { }
                if (typeof showToast === 'function') showToast(`אסטרטגיה "${s.name}" הופעלה`, 'success');
                if (typeof window !== 'undefined' && typeof window.checkStockAlerts === 'function') { const dot = document.getElementById('bellDot'); if (dot) dot.style.display = 'block'; }
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
    const nextMin = Math.max(1, Math.round((5 * 60 * 1000 - (Date.now() - last)) / 60000));
    el.textContent = `· נבדק לאחרונה ${hhmm} · בדיקה הבאה בעוד ~${nextMin} דק'`;
}

// ── Init: monitor strategies while the app is open (every 5 min) ──
function _taInit() { _taCheckStrategies(); if (!window._taTimer) window._taTimer = setInterval(_taCheckStrategies, 5 * 60 * 1000); }
if (typeof window !== 'undefined') {
    window.openTradingAgentPage = openTradingAgentPage; window.closeTradingAgentPage = closeTradingAgentPage;
    window._taParse = _taParse; window._taEnable = _taEnable; window._taToggle = _taToggle; window._taDelete = _taDelete;
    window._taCancelCard = () => { const b = document.getElementById('taCard'); if (b) b.innerHTML = ''; _taPendingRule = null; _taEditingId = null; };
    window._taOnModeChange = _taOnModeChange; window._taFmtAmtInput = _taFmtAmtInput; window._taUpdateActPreview = _taUpdateActPreview;
    window._taEditStrategy = _taEditStrategy; window._taToggleStructure = _taToggleStructure;
    window._taAdviceCardHtml = _taAdviceCardHtml; window._taIdeaToStrategy = _taIdeaToStrategy; window._taUseSuggestion = _taUseSuggestion;
    window._taOpenBrokerForm = _taOpenBrokerForm; window._taBrokerFormNote = _taBrokerFormNote; window._taSaveBroker = _taSaveBroker;
    window._taConnectBroker = _taConnectBroker; window._taDeleteBroker = _taDeleteBroker;
    window._taCheckStrategies = _taCheckStrategies; window._taPendingRule = _taPendingRule;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_taInit, 6000));
    else setTimeout(_taInit, 6000);
}
