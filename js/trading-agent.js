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
let _taChecking = false;
const _taEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const _TA_EXAMPLES = [
    'אם הנפט יורד מתחת ל-$70 או שיש אזכור של איראן/טראמפ בחדשות, תקנה USO ב-500 דולר',
    'כשחברה מפרסמת דוח עם הפתעת EPS מעל 10%, בצע קניית שוק של 5 מניות',
    'מכור 50% מהאחזקה ב-NVDA אם ה-RSI עולה מעל 80',
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
        <div class="macro-page-header"><h1 class="macro-main-title">🤖 סוכן מסחר AI</h1></div>
        <div class="macro-content">
            <div class="ta-safety">🛡️ <b>מצב סימולציה בלבד</b> — הסוכן מנטר את התנאים על נתונים אמיתיים ומבצע עסקאות <b>מדומות (Paper)</b> או שולח <b>התראה</b>. אין חיבור לברוקר ולא מבוצעות עסקאות כסף אמיתי. תיאור האסטרטגיה אינו ייעוץ השקעות.</div>
            <div class="risk-table-card glass-card" style="padding:18px">
                <div class="ta-chat-title">תאר אסטרטגיה בשפה חופשית — הסוכן יתרגם אותה לחוקים ויציג לך כרטיס לאישור</div>
                <div class="ta-chat-row">
                    <textarea id="taInput" class="ta-input" rows="2" placeholder="למשל: אם ה-RSI של NVDA עולה מעל 80 — מכור 50% מהאחזקה…" onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){_taParse();}"></textarea>
                    <button class="corr-run-btn corr-run-primary" id="taParseBtn" onclick="_taParse()">⚡ בצע אסטרטגיה</button>
                </div>
                <div class="ta-examples">${_TA_EXAMPLES.map(e => `<button class="ta-example" onclick="document.getElementById('taInput').value=this.textContent;_taParse()">${_taEsc(e)}</button>`).join('')}</div>
                <div id="taCard"></div>
            </div>
            <div class="ta-list-head">🔗 חיבור לברוקר <span class="ta-broker-sub">תשתית להרצה אמיתית</span> <button class="ta-broker-add" onclick="_taOpenBrokerForm()">+ הוסף חיבור</button></div>
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
        if (!r.ok || j.error || !j.rule) { box.innerHTML = `<div class="ta-card-err">${_taEsc(j.message || 'לא הצלחתי לפענח את ההוראה. נסה לנסח בצורה ברורה יותר (טריגר, פעולה, נכס וסכום).')}</div>`; return; }
        _taPendingRule = j.rule;
        box.innerHTML = _taStrategyCardHtml(j.rule, j.summary_he, j.source);
    } catch (e) {
        box.innerHTML = '<div class="ta-card-err">מנוע ה-AI עמוס כרגע. נסה שוב בעוד רגע.</div>';
    }
}

// ── The visual "Strategy Card": trigger → action → risk, with Enable/Disable ──
function _taStrategyCardHtml(rule, summaryHe, source) {
    const connBrokers = (_taBrokers || []).filter(b => b.status === 'CONNECTED');
    const trigHe = { NEWS_SENTIMENT: '📰 חדשות/סנטימנט', MACRO_EVENT: '🌍 אירוע מאקרו', PRICE_LEVEL: '💲 רמת מחיר', EARNINGS_BEAT: '📊 הפתעת דוחות', TECHNICAL_INDICATOR: '📈 אינדיקטור טכני' };
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
            body = `מחיר${subj} ${opHe[c.operator] || c.operator} ממוצע נע <b>${_taEsc(c.period || 200)}${unit}</b>`;
        } else {
            body = `${facHe[c.factor] || c.factor}${subj} ${opHe[c.operator] || c.operator} <b>${_taEsc(c.threshold != null ? c.threshold + (c.factor === 'eps_surprise' ? '%' : '') : '')}</b>${c.timeframe ? ` <span class="ta-tf">[${_taEsc(tfHe[c.timeframe] || c.timeframe)}]</span>` : ''}`;
        }
        return `<li class="ta-cond">${body}</li>`;
    }).join('');
    const actCls = rule.action === 'BUY' ? 'ta-buy' : rule.action === 'SELL' ? 'ta-sell' : 'ta-alert';
    const actHe = rule.action === 'BUY' ? '🟢 קנייה' : rule.action === 'SELL' ? '🔴 מכירה' : '🔔 התראה בלבד';
    const amtHe = rule.action === 'ALERT_ONLY' ? '' : (rule.amount.type === 'SHARES' ? `${rule.amount.value} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? `${rule.amount.value}% מהאחזקה` : `$${rule.amount.value}`);
    const rl = rule.risk_limits || {};
    const riskBits = [rl.stop_loss_pct != null ? `Stop-Loss ${rl.stop_loss_pct}%` : '', rl.max_slippage_pct != null ? `סליפג׳ מקס ${rl.max_slippage_pct}%` : '', rl.max_portfolio_pct != null ? `עד ${rl.max_portfolio_pct}% מהתיק` : ''].filter(Boolean);
    return `<div class="ta-card">
        <div class="ta-card-top"><span class="ta-card-name">${_taEsc(rule.name)}</span><span class="ta-trig">${trigHe[rule.trigger_type] || rule.trigger_type}</span>${source === 'fallback' ? '<span class="ta-draft" title="פוענח היוריסטית — בדוק שהחוקים נכונים">טיוטה</span>' : ''}</div>
        <div class="ta-flow">
            <div class="ta-flow-col"><span class="ta-flow-lbl">🎯 טריגר (${rule.logic === 'ALL' ? 'כל התנאים' : 'לפחות תנאי אחד'})</span><ul class="ta-conds">${conds}</ul></div>
            <div class="ta-flow-arrow">←</div>
            <div class="ta-flow-col"><span class="ta-flow-lbl">⚡ פעולה</span><div class="ta-act ${actCls}">${actHe}${amtHe ? ' · ' + _taEsc(amtHe) : ''}${rule.target_asset ? ' · <b>' + _taEsc(rule.target_asset) + '</b>' : ''}</div></div>
            <div class="ta-flow-arrow">←</div>
            <div class="ta-flow-col"><span class="ta-flow-lbl">🛡️ ניהול סיכון</span><div class="ta-risk">${riskBits.length ? riskBits.map(b => `<span class="ta-risk-chip">${_taEsc(b)}</span>`).join('') : '<span class="ta-risk-none">לא הוגדרו מגבלות</span>'}</div></div>
        </div>
        <div class="ta-card-actions">
            <label class="ta-mode-lbl">אופן הפעלה:
                <select id="taMode" class="st-pf-select" onchange="_taOnModeChange()"><option value="PAPER">מסחר מדומה (Paper)</option><option value="ALERT">התראה בלבד</option>${connBrokers.length ? '<option value="LIVE">מסחר אמיתי (Live)</option>' : '<option value="LIVE" disabled>מסחר אמיתי (Live) — דרוש חיבור ברוקר</option>'}</select>
            </label>
            <span class="ta-mode-lbl" id="taBrokerPick" style="display:none">דרך:
                <select id="taBrokerSel" class="st-pf-select">${connBrokers.map(b => `<option value="${b.id}">${_taEsc(b.label || b.broker)}</option>`).join('')}</select>
            </span>
            <button class="corr-run-btn corr-run-primary" onclick="_taEnable()">▶ הפעל אסטרטגיה</button>
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
    let brokerId = null;
    if (mode === 'LIVE') {
        brokerId = +(((document.getElementById('taBrokerSel') || {}).value) || 0) || null;
        if (!brokerId) { if (typeof showToast === 'function') showToast('בחר חיבור ברוקר פעיל למצב אמיתי', 'error'); return; }
    }
    const modeHe = mode === 'PAPER' ? 'סימולציה' : mode === 'LIVE' ? 'אמיתי (Live)' : 'התראה';
    try {
        const { data, error } = await supabaseClient.from('automated_strategies')
            .insert({ name: _taPendingRule.name || 'אסטרטגיה', status: 'ACTIVE', mode, broker_connection_id: brokerId, parsed_rule: _taPendingRule, execution_logs: [{ ts: new Date().toISOString(), kind: 'created', message: `האסטרטגיה נוצרה והופעלה במצב ${modeHe}` }] })
            .select().single();
        if (error) throw error;
        if (typeof showToast === 'function') showToast('✅ האסטרטגיה הופעלה — הסוכן מנטר את התנאים', 'success');
        const box = document.getElementById('taCard'); if (box) box.innerHTML = '';
        const inp = document.getElementById('taInput'); if (inp) inp.value = '';
        _taPendingRule = null;
        await _taLoadStrategies();
        if (data) _taCheckStrategies(true); // evaluate right away
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
    const statusHe = { ACTIVE: ['פעילה', 'ta-st-active'], PAUSED: ['מושהית', 'ta-st-paused'], TRIGGERED: ['הופעלה ✓', 'ta-st-trig'], EXPIRED: ['הסתיימה', 'ta-st-exp'] };
    el.innerHTML = _taStrategies.map(s => {
        const st = statusHe[s.status] || [s.status, ''];
        const summary = _taEsc((typeof _taRuleSummary === 'function') ? _taRuleSummary(s.parsed_rule) : (s.parsed_rule && s.parsed_rule.name) || '');
        const logs = Array.isArray(s.execution_logs) ? s.execution_logs : [];
        const last = logs.length ? logs[logs.length - 1] : null;
        const modeHe = s.mode === 'ALERT' ? '🔔 התראה' : s.mode === 'LIVE' ? '🟢 אמיתי' : '🧪 סימולציה';
        return `<div class="ta-strat" data-ta-id="${s.id}">
            <div class="ta-strat-main">
                <div class="ta-strat-id"><span class="ta-strat-name">${_taEsc(s.name)}</span><span class="ta-strat-sum">${summary}</span></div>
                <span class="ta-st-badge ${st[1]}">${st[0]}</span>
                <span class="ta-mode-badge">${modeHe}</span>
                <button class="ta-mini ${s.status === 'ACTIVE' ? '' : 'ta-mini-on'}" onclick="_taToggle(${s.id})">${s.status === 'ACTIVE' ? '⏸ השהה' : '▶ הפעל'}</button>
                <button class="ta-mini ta-mini-del" onclick="_taDelete(${s.id})" title="מחק">🗑</button>
            </div>
            ${last ? `<div class="ta-strat-log"><span class="ta-log-time">${_taWhen(last.ts)}</span> · ${_taEsc(last.message)}</div>` : ''}
        </div>`;
    }).join('');
}
function _taRuleSummary(rule) {
    if (!rule) return '';
    // Mirror the server _strategySummaryHe for the list (kept in sync).
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל-', CROSSES_ABOVE: 'חוצה מעלה', CROSSES_BELOW: 'חוצה מטה', GTE: '≥', LTE: '≤', EQUALS: '=', CONTAINS: 'מזכיר' };
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'מאקרו' };
    const conds = (rule.conditions || []).map(c => {
        if (c.factor === 'news') return `אזכור "${c.keyword || c.subject}"`;
        if (c.factor === 'ma') { const unit = c.timeframe === 'weekly' ? ' שבועות' : c.timeframe === 'daily' ? ' ימים' : ''; return `מחיר${c.subject ? ' ' + c.subject : ''} ${opHe[c.operator] || ''} ממוצע ${c.period || 200}${unit}`.trim(); }
        return `${facHe[c.factor] || c.factor}${c.subject ? ' ' + c.subject : ''} ${opHe[c.operator] || ''} ${c.threshold != null ? c.threshold + (c.factor === 'eps_surprise' ? '%' : '') : ''}`.trim();
    });
    const act = rule.action === 'BUY' ? 'קנייה' : rule.action === 'SELL' ? 'מכירה' : 'התראה';
    const amt = rule.action === 'ALERT_ONLY' ? '' : (rule.amount.type === 'SHARES' ? ` ${rule.amount.value} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? ` ${rule.amount.value}%` : ` $${rule.amount.value}`);
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
    PAPER: { label: 'סימולטור (Paper)', icon: '🧪', instant: true, real: false, note: 'חשבון מסחר מדומה מובנה — אין כסף אמיתי, מתחבר מיידית.' },
    IBKR: { label: 'Interactive Brokers', icon: '🟥', instant: false, real: true, note: 'דורש OAuth + IB Gateway מתארח בצד השרת. הסודות לעולם אינם נשמרים בצד הלקוח.' },
    ALPACA: { label: 'Alpaca', icon: '🦙', instant: false, real: true, note: 'דורש מפתחות API בצד השרת (proxy מאובטח). הסודות לעולם אינם נשמרים בצד הלקוח.' },
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
        async placeOrder(o) { return { ok: false, real: false, message: `❌ ${broker}: ה-Gateway אינו מוגדר — לא נשלחה פקודת אמת (${o.side} ${o.qtyLabel} ${o.symbol}).` }; },
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
        const def = _TA_BROKER_DEFS[b.broker] || { label: b.broker, icon: '🏦' };
        const st = stHe[b.status] || [b.status, ''];
        const modeHe = b.account_mode === 'LIVE' ? 'אמיתי' : 'מדומה';
        const cfg = b.config || {};
        const meta = [cfg.account_id ? `חשבון ${_taEsc(cfg.account_id)}` : '', cfg.gateway_url ? _taEsc(cfg.gateway_url) : ''].filter(Boolean).join(' · ');
        return `<div class="ta-bk-row">
            <span class="ta-bk-ic">${def.icon}</span>
            <div class="ta-bk-id"><span class="ta-bk-name">${_taEsc(b.label || def.label)}</span><span class="ta-bk-meta">${_taEsc(def.label)}${meta ? ' · ' + meta : ''} · ${modeHe}</span></div>
            <span class="ta-bk-badge ${st[1]}">${st[0]}</span>
            ${b.status !== 'CONNECTED' ? `<button class="ta-mini ta-mini-on" onclick="_taConnectBroker(${b.id})">🔌 חבר</button>` : `<button class="ta-mini" onclick="_taConnectBroker(${b.id})">בדוק</button>`}
            <button class="ta-mini ta-mini-del" onclick="_taDeleteBroker(${b.id})" title="מחק">🗑</button>
        </div>`;
    }).join('');
    el.innerHTML = `<div id="taBrokerForm"></div>${_taBrokers.length ? rows : '<div class="wl-empty">אין חיבורי ברוקר. הוסף חיבור כדי לאפשר מצב הרצה אמיתי (Live). מצב סימולציה והתראה עובדים גם בלי חיבור.</div>'}`;
}
function _taOpenBrokerForm() {
    const holder = document.getElementById('taBrokerForm');
    if (!holder) return;
    if (holder.dataset.open === '1') { holder.innerHTML = ''; holder.dataset.open = ''; return; }
    holder.dataset.open = '1';
    const opts = Object.keys(_TA_BROKER_DEFS).map(k => `<option value="${k}">${_TA_BROKER_DEFS[k].icon} ${_taEsc(_TA_BROKER_DEFS[k].label)}</option>`).join('');
    holder.innerHTML = `<div class="ta-bk-form">
        <div class="ta-bk-form-grid">
            <label>ברוקר<select id="taBkType" onchange="_taBrokerFormNote()">${opts}</select></label>
            <label>כינוי<input id="taBkLabel" placeholder="למשל: חשבון ראשי"></label>
            <label>מצב חשבון<select id="taBkMode"><option value="PAPER">מדומה (Paper)</option><option value="LIVE">אמיתי (Live)</option></select></label>
            <label>מזהה חשבון<input id="taBkAccount" placeholder="לא סודי — למשל U1234567"></label>
            <label>כתובת Gateway<input id="taBkGateway" placeholder="https://… (אופציונלי)"></label>
        </div>
        <div class="ta-bk-note" id="taBkNote">${_taEsc(_TA_BROKER_DEFS.PAPER.note)}</div>
        <div class="ta-bk-secnote">🔒 סיסמאות ומפתחות API לעולם אינם נשמרים כאן. חיבור אמיתי מתבצע דרך שרת proxy מאובטח בלבד.</div>
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
        if (typeof showToast === 'function') showToast(def.instant ? '✅ חשבון הסימולציה חובר' : '📎 החיבור נשמר במצב "ממתין" — נדרשת הגדרת שרת', 'success');
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
    const pick = document.getElementById('taBrokerPick');
    if (pick) pick.style.display = mode === 'LIVE' ? 'inline-flex' : 'none';
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
            return { met: cmp(price, ma), value: `${sym} $${(+price).toFixed(2)} מול ממוצע ${period}${unit} $${(+ma).toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(1)}%)` };
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
// Evaluate all ACTIVE strategies; on a fire, log + PAPER-execute (simulate) / ALERT (notify).
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
                    msg = `🔔 טריגר התקיים — ${detail}`;
                } else {
                    // Get the current price of the traded asset for the (simulated or routed) fill.
                    let px = null;
                    try { if (rule.target_asset) { const r = await fetch(`/api/quote?symbols=${encodeURIComponent(rule.target_asset)}`); const jj = await r.json(); const q = jj[rule.target_asset] || (jj.quotes && jj.quotes[rule.target_asset]) || {}; px = q.price != null ? q.price : q.regularMarketPrice; } } catch (e) { }
                    const actHe = rule.action === 'BUY' ? 'קנייה' : 'מכירה';
                    const amtHe = rule.amount.type === 'SHARES' ? `${rule.amount.value} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? `${rule.amount.value}% מהאחזקה` : `$${rule.amount.value}`;
                    if (s.mode === 'LIVE') {
                        // Route the order through the broker adapter. Real brokers fail safe (no live order).
                        const conn = await _taGetBrokerConn(s.broker_connection_id);
                        const order = { side: rule.action === 'BUY' ? 'BUY' : 'SELL', symbol: rule.target_asset || '', qtyLabel: amtHe, price: px };
                        const res = await _taBrokerAdapter(conn).placeOrder(order);
                        msg = res.ok ? `${res.real ? '✅ בוצעה פקודת אמת' : '🧪'} ${res.message} — ${detail}` : `⚠️ מצב Live נחסם — ${res.message} · ${detail}`;
                    } else {
                        // PAPER: simulate the fill at the current price.
                        msg = `🧪 סימולציה: בוצעה ${actHe} של ${amtHe} ${rule.target_asset || ''}${px != null ? ` במחיר ~$${(+px).toFixed(2)}` : ''} — ${detail}`;
                    }
                }
                logs.push({ ts: new Date().toISOString(), kind: 'triggered', message: msg });
                try {
                    await supabaseClient.from('automated_strategies').update({ status: 'TRIGGERED', triggered_at: new Date().toISOString(), last_checked: new Date().toISOString(), execution_logs: logs, updated_at: new Date().toISOString() }).eq('id', s.id);
                } catch (e) { }
                if (typeof showToast === 'function') showToast(`⚡ אסטרטגיה "${s.name}" הופעלה`, 'success');
                if (typeof window !== 'undefined' && typeof window.checkStockAlerts === 'function') { const dot = document.getElementById('bellDot'); if (dot) dot.style.display = 'block'; }
            } else {
                logs.push({ ts: new Date().toISOString(), kind: 'check', message: `נבדק — התנאים לא התקיימו (${results.map(r => r.value).join(' · ').slice(0, 120)})` });
                try { await supabaseClient.from('automated_strategies').update({ last_checked: new Date().toISOString(), execution_logs: logs.slice(-40) }).eq('id', s.id); } catch (e) { }
            }
        }
        if (document.getElementById('taList')) _taLoadStrategies();
    } catch (e) { }
    _taChecking = false;
}

// ── Init: monitor strategies while the app is open (every 5 min) ──
function _taInit() { _taCheckStrategies(); if (!window._taTimer) window._taTimer = setInterval(_taCheckStrategies, 5 * 60 * 1000); }
if (typeof window !== 'undefined') {
    window.openTradingAgentPage = openTradingAgentPage; window.closeTradingAgentPage = closeTradingAgentPage;
    window._taParse = _taParse; window._taEnable = _taEnable; window._taToggle = _taToggle; window._taDelete = _taDelete;
    window._taCancelCard = () => { const b = document.getElementById('taCard'); if (b) b.innerHTML = ''; _taPendingRule = null; };
    window._taOnModeChange = _taOnModeChange;
    window._taOpenBrokerForm = _taOpenBrokerForm; window._taBrokerFormNote = _taBrokerFormNote; window._taSaveBroker = _taSaveBroker;
    window._taConnectBroker = _taConnectBroker; window._taDeleteBroker = _taDeleteBroker;
    window._taCheckStrategies = _taCheckStrategies; window._taPendingRule = _taPendingRule;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_taInit, 6000));
    else setTimeout(_taInit, 6000);
}
