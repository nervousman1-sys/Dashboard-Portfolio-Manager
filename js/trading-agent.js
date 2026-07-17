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
                    <button class="corr-run-btn corr-run-primary" id="taParseBtn" onclick="_taParse()">✨ פענח אסטרטגיה</button>
                </div>
                <div class="ta-examples">${_TA_EXAMPLES.map(e => `<button class="ta-example" onclick="document.getElementById('taInput').value=this.textContent;_taParse()">${_taEsc(e)}</button>`).join('')}</div>
                <div id="taCard"></div>
            </div>
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
    const trigHe = { NEWS_SENTIMENT: '📰 חדשות/סנטימנט', MACRO_EVENT: '🌍 אירוע מאקרו', PRICE_LEVEL: '💲 רמת מחיר', EARNINGS_BEAT: '📊 הפתעת דוחות', TECHNICAL_INDICATOR: '📈 אינדיקטור טכני' };
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע נע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'מאקרו' };
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל-', CROSSES_ABOVE: 'חוצה מעלה', CROSSES_BELOW: 'חוצה מטה', GTE: '≥', LTE: '≤', EQUALS: '=', CONTAINS: 'מזכיר' };
    const conds = (rule.conditions || []).map(c => {
        const subj = c.subject ? ` <b>${_taEsc(c.subject)}</b>` : '';
        const body = c.factor === 'news'
            ? `אזכור בחדשות: <b>${_taEsc(c.keyword || c.subject || '')}</b>`
            : `${facHe[c.factor] || c.factor}${subj} ${opHe[c.operator] || c.operator} <b>${_taEsc(c.threshold != null ? c.threshold + (c.factor === 'eps_surprise' ? '%' : '') : '')}</b>${c.timeframe ? ` <span class="ta-tf">[${_taEsc(c.timeframe)}]</span>` : ''}`;
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
                <select id="taMode" class="st-pf-select"><option value="PAPER">מסחר מדומה (Paper)</option><option value="ALERT">התראה בלבד</option></select>
            </label>
            <button class="corr-run-btn corr-run-primary" onclick="_taEnable()">▶ הפעל אסטרטגיה</button>
            <button class="wl-close-btn" onclick="_taCancelCard()">בטל</button>
        </div>
    </div>`;
}

// ── Save + enable the pending strategy (status ACTIVE). Immediately evaluates it once. ──
async function _taEnable() {
    if (!_taPendingRule) return;
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    const mode = (document.getElementById('taMode') || {}).value === 'ALERT' ? 'ALERT' : 'PAPER';
    try {
        const { data, error } = await supabaseClient.from('automated_strategies')
            .insert({ name: _taPendingRule.name || 'אסטרטגיה', status: 'ACTIVE', mode, parsed_rule: _taPendingRule, execution_logs: [{ ts: new Date().toISOString(), kind: 'created', message: `האסטרטגיה נוצרה והופעלה במצב ${mode === 'PAPER' ? 'סימולציה' : 'התראה'}` }] })
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
        const modeHe = s.mode === 'ALERT' ? '🔔 התראה' : '🧪 סימולציה';
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
    const conds = (rule.conditions || []).map(c => c.factor === 'news' ? `אזכור "${c.keyword || c.subject}"` : `${facHe[c.factor] || c.factor}${c.subject ? ' ' + c.subject : ''} ${opHe[c.operator] || ''} ${c.threshold != null ? c.threshold + (c.factor === 'eps_surprise' ? '%' : '') : ''}`.trim());
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
// Evaluate ONE condition → { met:boolean, value:string } (value for the log). Real data only.
async function _taEvalCondition(c, rule) {
    const sym = (c.subject && /^[A-Za-z.\-]{1,6}$/.test(c.subject) ? c.subject : rule.target_asset || '').toUpperCase();
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
        if (c.factor === 'ma' && sym && c.threshold != null) {
            const r = await fetch(`/api/technicals?mode=scan&symbols=${encodeURIComponent(sym)}&v=2`, { headers: { Accept: 'application/json' } });
            const j = await r.json(); const t = (j.results || {})[sym] || {};
            const dist = t.ma && t.ma.d200dist; if (dist == null) return { met: false, value: 'אין ממוצע' };
            return { met: cmp(t.price, +c.threshold), value: `מחיר מול ממוצע 200: ${dist}%` };
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
                    // PAPER: simulate the fill at the current price.
                    let px = null;
                    try { if (rule.target_asset) { const r = await fetch(`/api/quote?symbols=${encodeURIComponent(rule.target_asset)}`); const jj = await r.json(); const q = jj[rule.target_asset] || (jj.quotes && jj.quotes[rule.target_asset]) || {}; px = q.price != null ? q.price : q.regularMarketPrice; } } catch (e) { }
                    const actHe = rule.action === 'BUY' ? 'קנייה' : 'מכירה';
                    const amtHe = rule.amount.type === 'SHARES' ? `${rule.amount.value} מניות` : rule.amount.type === 'PORTFOLIO_PCT' ? `${rule.amount.value}% מהאחזקה` : `$${rule.amount.value}`;
                    msg = `🧪 סימולציה: בוצעה ${actHe} של ${amtHe} ${rule.target_asset || ''}${px != null ? ` במחיר ~$${(+px).toFixed(2)}` : ''} — ${detail}`;
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
    window._taCheckStrategies = _taCheckStrategies; window._taPendingRule = _taPendingRule;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_taInit, 6000));
    else setTimeout(_taInit, 6000);
}
