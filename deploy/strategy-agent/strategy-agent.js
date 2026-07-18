// ============================================================================
// Finextium — Strategy Agent (24/7 automated-trading evaluator)
// ----------------------------------------------------------------------------
// Sibling of reports-agent.js / lhe-agent.js. Runs on the Hostinger VPS under PM2
// and evaluates EVERY user's ACTIVE automated_strategies against REAL market data —
// even when nobody has the website open — then executes the action:
//   • PAPER + portfolio_id → executes the trade FOR REAL in the paper portfolio
//     (deduct cash, add/remove the position, log the transaction, recalc totals)
//   • LIVE  + broker       → routes through the broker adapter (real brokers fail
//     safe: no live order until a proper server-side gateway is wired)
//   • ALERT / ALERT_ONLY   → logs a notification only
//
// It mirrors the browser engine in js/trading-agent.js (same /api data sources,
// same MA/RSI math, same "touch"=±2.5% band) so results never drift between the
// client's in-app checks and this daemon. To avoid double-firing when the app is
// ALSO open, it CLAIMS a strategy atomically (ACTIVE→TRIGGERED, only if still
// ACTIVE) before executing.
//
// Run:  node strategy-agent.js          (daemon, every STRATEGY_INTERVAL_MIN)
//       node strategy-agent.js --once   (single evaluation pass, then exit)
//
// Requires (VPS env / .env):
//   SUPABASE_URL                = https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   = <service role key>   (bypasses RLS → acts for ALL users; VPS-only secret)
//   SITE_URL                    = https://www.finextium.com   (optional; data API base)
//   STRATEGY_INTERVAL_MIN       = 5                    (optional; minutes between passes)
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;   // MUST be the service role key (RLS bypass)
const SITE = (process.env.SITE_URL || 'https://www.finextium.com').replace(/\/+$/, '');
const INTERVAL_MIN = parseFloat(process.env.STRATEGY_INTERVAL_MIN || '5');
const RUN_ONCE = process.argv.includes('--once');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const fail = (m) => { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (!SUPABASE_URL) fail('Missing SUPABASE_URL');
// The service-role key is REQUIRED to act across users. If it isn't set yet, the container stays up
// and IDLE (so it still shows "running" in Docker Manager) — add the key to .env and restart to activate.
const supabase = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

// ── Entity → tradeable Yahoo symbol (mirrors client _TA_TICKERS / server _STRAT_TICKERS) ──
const TICKERS = {
    bitcoin: 'BTC-USD', 'ביטקוין': 'BTC-USD', btc: 'BTC-USD', ethereum: 'ETH-USD', 'אתריום': 'ETH-USD', 'את׳ריום': 'ETH-USD', eth: 'ETH-USD',
    gold: 'GLD', 'זהב': 'GLD', oil: 'USO', 'נפט': 'USO', crude: 'USO', silver: 'SLV', 'כסף': 'SLV',
    nasdaq: 'QQQ', 'נאסדק': 'QQQ', 'sp500': 'SPY', 'ספ500': 'SPY', dow: 'DIA', 'דאו': 'DIA', vix: '^VIX',
};
function resolveTicker(s) {
    if (s == null) return null;
    const k = String(s).trim().toLowerCase().replace(/["״׳'`\s]/g, '');
    if (TICKERS[k]) return TICKERS[k];
    const up = String(s).trim().toUpperCase();
    if (/^[A-Z]{1,6}(-USD|\.TA)?$/.test(up) || /^\^[A-Z]+$/.test(up)) return up;
    return null;
}

// ── Data via the app's public API (identical to what the UI reads) ──
async function apiJson(pathQ) {
    try { const r = await fetch(`${SITE}${pathQ}`, { headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
async function getCloses(sym, interval, range) {
    const j = await apiJson(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}&interval=${interval}`);
    return ((j && j.points) || []).map(p => p.close).filter(x => x != null && isFinite(x));
}
async function getQuote(sym) {
    const j = await apiJson(`/api/quote?symbols=${encodeURIComponent(sym)}`);
    const q = (j && (j[sym] || (j.quotes && j.quotes[sym]))) || {};
    const p = q.price != null ? q.price : q.regularMarketPrice;
    return (p != null && isFinite(p)) ? +p : null;
}
function sma(cl, period) { if (!Array.isArray(cl) || cl.length < period || period < 1) return null; let s = 0; for (let i = cl.length - period; i < cl.length; i++) s += cl[i]; return s / period; }
function maParams(tf, period) {
    if (tf === 'weekly' || tf === '1wk' || tf === '1w') { const w = period + 10; return { interval: '1wk', range: w <= 52 ? '1y' : w <= 104 ? '2y' : w <= 260 ? '5y' : 'max' }; }
    const d = period + 20; return { interval: '1d', range: d <= 130 ? '6mo' : d <= 260 ? '1y' : d <= 520 ? '2y' : d <= 1300 ? '5y' : 'max' };
}
function rsiCalc(closes, period) {
    period = period || 14;
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    let ag = gain / period, al = loss / period;
    for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period; al = (al * (period - 1) + (d < 0 ? -d : 0)) / period; }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
}
async function rsiValue(sym, tf) {
    tf = (tf || 'daily').toLowerCase();
    let interval = '1d', range = '3mo', group = 1;
    const mh = tf.match(/^(\d+)\s*h/);
    if (mh) { interval = '1h'; range = '1mo'; group = Math.max(1, parseInt(mh[1], 10) || 1); }
    else if (tf === 'weekly' || tf === '1w' || tf === '1wk') { interval = '1wk'; range = '2y'; }
    let closes = await getCloses(sym, interval, range);
    if (group > 1) { const g = []; for (let i = group - 1; i < closes.length; i += group) g.push(closes[i]); closes = g; }
    return rsiCalc(closes, 14);
}

// ── Evaluate ONE condition against real data → { met, value } (mirrors _taEvalCondition) ──
async function evalCondition(c, rule) {
    const sym = (resolveTicker(c.subject) || String(rule.target_asset || '').toUpperCase());
    const cmp = (v, th) => {
        const op = c.operator;
        if (op === 'ABOVE' || op === 'GTE' || op === 'CROSSES_ABOVE') return v >= th;
        if (op === 'BELOW' || op === 'LTE' || op === 'CROSSES_BELOW') return v <= th;
        if (op === 'EQUALS') return Math.abs(v - th) < 1e-6;
        return false;
    };
    try {
        if (c.factor === 'price' && sym && c.threshold != null) {
            const price = await getQuote(sym);
            if (price == null) return { met: false, value: 'אין מחיר' };
            return { met: cmp(price, +c.threshold), value: `מחיר ${sym} $${price.toFixed(2)}` };
        }
        if (c.factor === 'rsi' && sym && c.threshold != null) {
            const rsi = await rsiValue(sym, c.timeframe);
            if (rsi == null) return { met: false, value: 'אין RSI' };
            return { met: cmp(rsi, +c.threshold), value: `RSI ${sym} ${rsi.toFixed(1)}${c.timeframe ? ' (' + c.timeframe + ')' : ''}` };
        }
        if (c.factor === 'ma' && sym) {
            const period = c.period || (typeof c.threshold === 'number' ? Math.round(c.threshold) : 200);
            const tf = (c.timeframe || 'daily').toLowerCase();
            const { interval, range } = maParams(tf, period);
            const closes = await getCloses(sym, interval, range);
            if (!closes || closes.length < period + 1) return { met: false, value: `אין מספיק היסטוריה ל-${sym}` };
            const ma = sma(closes, period), price = closes[closes.length - 1];
            if (ma == null || price == null) return { met: false, value: 'אין ממוצע' };
            const distPct = ((price - ma) / ma) * 100;
            const unit = tf === 'weekly' ? ' שבועות' : tf === 'daily' ? ' ימים' : '';
            const met = c.operator === 'EQUALS' ? Math.abs(distPct) <= 2.5 : cmp(price, ma);
            const near = c.operator === 'EQUALS' ? (met ? ' — נוגע' : ' — לא נוגע') : '';
            return { met, value: `${sym} $${price.toFixed(2)} מול ממוצע ${period}${unit} $${ma.toFixed(2)} (${distPct >= 0 ? '+' : ''}${distPct.toFixed(1)}%)${near}` };
        }
        if (c.factor === 'eps_surprise' && c.threshold != null) {
            const t = sym || rule.target_asset; if (!t) return { met: false, value: 'נדרש טיקר לדוח' };
            const j = await apiJson(`/api/technicals?mode=earnings&symbols=${encodeURIComponent(t)}`);
            const info = (j && j.results && j.results[String(t).toUpperCase()]) || {};
            if (info.surprisePct == null) return { met: false, value: 'טרם פורסם דוח' };
            const recent = info.reportedDate && ((Date.now() - new Date(info.reportedDate)) / 86400e3 <= 5);
            return { met: recent && cmp(info.surprisePct, +c.threshold), value: `הפתעת EPS ${info.surprisePct >= 0 ? '+' : ''}${info.surprisePct}%${recent ? '' : ' (לא טרי)'}` };
        }
        if (c.factor === 'news' || c.factor === 'macro') {
            const kws = String(c.keyword || c.subject || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            if (!kws.length) return { met: false, value: 'אין מילות מפתח' };
            const j = await apiJson('/api/news?macro=1');
            const items = (j && j.macro) || [];
            const hit = items.find(n => { const blob = ((n.he || '') + ' ' + (n.en || '')).toLowerCase(); return kws.some(k => blob.includes(k)); });
            return { met: !!hit, value: hit ? `נמצא בחדשות: "${(hit.he || hit.en || '').slice(0, 50)}"` : 'אין אזכור בחדשות' };
        }
    } catch (e) { }
    return { met: false, value: 'לא ניתן להעריך' };
}

// ── FX: ILS → USD (for recalc of mixed portfolios) ──
async function getFxIls() { const r = await getQuote('ILS=X'); return (r && r > 0) ? 1 / r : 0.27; }

// ── Faithful recalc of a portfolio (mirrors supaRecalcClient, USD display) ──
async function recalc(portfolioId, fxIls) {
    const [{ data: holdings }, { data: pf }] = await Promise.all([
        supabase.from('holdings').select('*').eq('portfolio_id', portfolioId),
        supabase.from('portfolios').select('cash_usd, cash_ils').eq('id', portfolioId).single(),
    ]);
    if (!holdings) return;
    const fx = (c) => (c === 'ILS' ? fxIls : 1);
    const cashUsd = +(pf && pf.cash_usd) || 0, cashIls = +(pf && pf.cash_ils) || 0;
    let holdingsValue = 0;
    holdings.forEach(h => { holdingsValue += (h.shares * h.price) * fx(h.currency || 'USD'); });
    const totalCash = cashUsd + cashIls * fxIls;
    const totalValue = holdingsValue + totalCash;
    await Promise.all(holdings.map(h => {
        const nativeValue = h.shares * h.price;
        const alloc = totalValue > 0 ? (nativeValue * fx(h.currency || 'USD')) / totalValue * 100 : 0;
        return supabase.from('holdings').update({ value: nativeValue, allocation_pct: alloc }).eq('id', h.id);
    }));
    let stockPct = 0, bondPct = 0;
    if (totalValue > 0) holdings.forEach(h => { const pct = (h.shares * h.price * fx(h.currency || 'USD')) / totalValue * 100; if (h.type === 'stock') stockPct += pct; else bondPct += pct; });
    const initialInvestment = holdings.reduce((s, h) => s + (h.cost_basis || 0) * fx(h.currency || 'USD'), 0) + totalCash;
    const risk = stockPct > 70 ? 'high' : stockPct >= 40 ? 'medium' : 'low';
    const riskLabel = stockPct > 70 ? 'גבוה' : stockPct >= 40 ? 'בינוני' : 'נמוך';
    await supabase.from('portfolios').update({ portfolio_value: totalValue, initial_investment: initialInvestment, cash_balance: cashUsd + cashIls, stock_pct: stockPct, bond_pct: bondPct, risk, risk_label: riskLabel }).eq('id', portfolioId);
}

// ── Execute a fired BUY/SELL FOR REAL in the linked paper portfolio ──
async function execPaperTrade(portfolioId, rule, px, fxIls) {
    const sym = String(rule.target_asset || '').toUpperCase();
    if (!sym) return { ok: false, message: 'אין נכס יעד' };
    if (!(px > 0)) return { ok: false, message: `אין מחיר שוק ל-${sym}` };
    const { data: pf } = await supabase.from('portfolios').select('id, name, cash_usd, cash_ils').eq('id', portfolioId).single();
    if (!pf) return { ok: false, message: `תיק #${portfolioId} לא נמצא` };
    const pname = pf.name || ('#' + portfolioId);
    const amt = rule.amount || { type: 'CASH_USD', value: 0 };
    const { data: holdings } = await supabase.from('holdings').select('*').eq('portfolio_id', portfolioId);
    if (rule.action === 'BUY') {
        let qty;
        if (amt.type === 'SHARES') qty = Math.floor(amt.value);
        else if (amt.type === 'PORTFOLIO_PCT') qty = Math.floor(((+pf.cash_usd || 0) * (amt.value / 100)) / px);
        else qty = Math.floor(amt.value / px);
        if (!qty || qty < 1) return { ok: false, message: `הסכום אינו מספיק ליחידה אחת של ${sym} (~$${px.toFixed(2)})` };
        const cost = qty * px;
        if (cost > (+pf.cash_usd || 0)) return { ok: false, message: `אין מספיק מזומן בתיק «${pname}»` };
        const ex = (holdings || []).find(h => String(h.ticker || '').toUpperCase() === sym && (h.currency || 'USD') !== 'ILS');
        if (ex) await supabase.from('holdings').update({ shares: ex.shares + qty, cost_basis: (ex.cost_basis || 0) + cost, price: px, value: (ex.shares + qty) * px }).eq('id', ex.id);
        else await supabase.from('holdings').insert({ portfolio_id: portfolioId, ticker: sym, name: sym, type: 'stock', type_label: 'מניה', shares: qty, price: px, cost_basis: cost, value: qty * px, currency: 'USD', asset_class: 'stock', buy_date: new Date().toISOString().slice(0, 10) });
        await supabase.from('portfolios').update({ cash_usd: (+pf.cash_usd || 0) - cost }).eq('id', portfolioId);
        await supabase.from('transactions').insert({ portfolio_id: portfolioId, type: 'buy', ticker: sym, name: sym, asset_type: 'stock', currency: 'USD', shares: qty, price: px, total: cost, description: 'עסקת סוכן AI (Paper)' });
        await recalc(portfolioId, fxIls);
        return { ok: true, message: `בוצעה קנייה בתיק «${pname}»: ${qty} מניות ${sym} @ ~$${px.toFixed(2)}` };
    }
    // SELL
    const h = (holdings || []).find(x => String(x.ticker || '').toUpperCase() === sym);
    if (!h) return { ok: false, message: `אין אחזקה ב-${sym} בתיק «${pname}» למכירה` };
    let qty;
    if (amt.type === 'SHARES') qty = Math.min(Math.floor(amt.value), h.shares);
    else if (amt.type === 'PORTFOLIO_PCT') qty = Math.floor(h.shares * (amt.value / 100));
    else qty = Math.min(Math.floor(amt.value / px), h.shares);
    if (!qty || qty < 1) return { ok: false, message: `כמות המכירה שחושבה קטנה מדי ב-${sym}` };
    const cur = h.currency || 'USD';
    const avgCost = h.shares > 0 ? (h.cost_basis || 0) / h.shares : 0;
    const proceeds = qty * px, realized = (px - avgCost) * qty;
    if (qty >= h.shares) await supabase.from('holdings').delete().eq('id', h.id);
    else await supabase.from('holdings').update({ shares: h.shares - qty, cost_basis: (h.cost_basis || 0) - avgCost * qty, value: (h.shares - qty) * h.price }).eq('id', h.id);
    const bucket = cur === 'ILS' ? 'cash_ils' : 'cash_usd';
    await supabase.from('portfolios').update({ [bucket]: (+pf[bucket] || 0) + proceeds }).eq('id', portfolioId);
    await supabase.from('transactions').insert({ portfolio_id: portfolioId, type: 'sell', ticker: sym, name: h.name || sym, asset_type: h.type || 'stock', currency: cur, shares: qty, price: px, total: proceeds, realized_pnl: realized, description: 'עסקת סוכן AI (Paper)' });
    await recalc(portfolioId, fxIls);
    return { ok: true, message: `בוצעה מכירה בתיק «${pname}»: ${qty} מניות ${sym} @ ~$${px.toFixed(2)}` };
}

// ── Broker adapter (LIVE) — real brokers FAIL SAFE (no live order) until a gateway is wired ──
function brokerPlaceOrder(conn, order) {
    const broker = (conn && conn.broker) || 'PAPER';
    if (broker === 'PAPER') return { ok: true, real: false, message: `סימולציה דרך הברוקר: ${order.side} ${order.qtyLabel} ${order.symbol}` };
    return { ok: false, real: false, message: `${broker}: ה-Gateway אינו מוגדר — לא נשלחה פקודת אמת (${order.side} ${order.symbol})` };
}

// ── Evaluate + act on one strategy ──
async function processStrategy(s, fxIls) {
    const rule = s.parsed_rule || {}; const conds = rule.conditions || [];
    if (!conds.length) return;
    const results = [];
    for (const c of conds) results.push(await evalCondition(c, rule));
    const fired = rule.logic === 'ALL' ? results.every(r => r.met) : results.some(r => r.met);
    const logs = Array.isArray(s.execution_logs) ? s.execution_logs.slice(-40) : [];
    if (!fired) { await supabase.from('automated_strategies').update({ last_checked: new Date().toISOString() }).eq('id', s.id); return false; }

    // CLAIM the strategy atomically so the browser engine can't also fire it (ACTIVE→TRIGGERED once).
    const { data: claimed } = await supabase.from('automated_strategies')
        .update({ status: 'TRIGGERED', triggered_at: new Date().toISOString(), last_checked: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', s.id).eq('status', 'ACTIVE').select();
    if (!claimed || !claimed.length) return false; // someone else already claimed it

    const detail = results.filter(r => r.met).map(r => r.value).join(' · ') || results.map(r => r.value).join(' · ');
    let msg;
    if (rule.action === 'ALERT_ONLY' || s.mode === 'ALERT') {
        msg = `טריגר התקיים — ${detail}`;
    } else {
        let px = rule.target_asset ? await getQuote(rule.target_asset) : null;
        if (s.mode === 'LIVE') {
            let conn = null;
            if (s.broker_connection_id) { const { data } = await supabase.from('broker_connections').select('*').eq('id', s.broker_connection_id).single(); conn = data; }
            const res = brokerPlaceOrder(conn, { side: rule.action, symbol: rule.target_asset || '', qtyLabel: '', price: px });
            msg = res.ok ? `${res.real ? 'בוצעה פקודת אמת' : ''} ${res.message} — ${detail}`.trim() : `מצב Live נחסם — ${res.message} · ${detail}`;
        } else if (s.mode === 'PAPER' && s.portfolio_id) {
            const exec = await execPaperTrade(s.portfolio_id, rule, px, fxIls);
            msg = exec.ok ? `${exec.message} — ${detail}` : `לא בוצע בתיק — ${exec.message} · ${detail}`;
        } else {
            msg = `סימולציה: טריגר התקיים (ללא תיק מקושר) — ${detail}`;
        }
    }
    logs.push({ ts: new Date().toISOString(), kind: 'triggered', message: `[סוכן שרת] ${msg}` });
    await supabase.from('automated_strategies').update({ execution_logs: logs, updated_at: new Date().toISOString() }).eq('id', s.id);
    log(`fired #${s.id} "${s.name}" → ${msg}`);
    return true;
}

// Write a heartbeat to the shared agent_status table (same convention as reports/scanner/press/lhe)
// so the platform can CONFIRM the server agent is alive 24/7.
let _cycleCount = null;
async function heartbeat(activeCount, firedCount) {
    try {
        if (_cycleCount == null) { const { data } = await supabase.from('agent_status').select('cycles').eq('agent', 'strategy').maybeSingle(); _cycleCount = (data && data.cycles) || 0; }
        _cycleCount++;
        const now = new Date();
        const next = new Date(now.getTime() + Math.max(1, INTERVAL_MIN) * 60000);
        const result = activeCount < 0 ? 'שגיאה בקריאת אסטרטגיות'
            : activeCount === 0 ? 'אין אסטרטגיות פעילות'
            : `הוערכו ${activeCount} אסטרטגיות · ${firedCount} הופעלו`;
        await supabase.from('agent_status').upsert({ agent: 'strategy', last_run: now.toISOString(), next_run: next.toISOString(), cycles: _cycleCount, last_result: result, updated_at: now.toISOString() }, { onConflict: 'agent' });
    } catch (e) { log('heartbeat failed:', e.message); }
}

async function runOnce() {
    const { data, error } = await supabase.from('automated_strategies').select('*').eq('status', 'ACTIVE');
    if (error) { log('fetch strategies failed:', error.message); await heartbeat(-1, 0); return; }
    const rows = data || [];
    let fired = 0;
    if (rows.length) {
        const fxIls = await getFxIls();
        log(`evaluating ${rows.length} active strategies (USD/ILS fx=${fxIls.toFixed(4)})`);
        for (const s of rows) {
            try { if (await processStrategy(s, fxIls)) fired++; } catch (e) { log(`strategy #${s.id} error:`, e.message); }
        }
    } else { log('no active strategies'); }
    await heartbeat(rows.length, fired);
    log(`pass complete (fired ${fired})`);
}

(async () => {
    log(`Strategy Agent starting — site=${SITE} interval=${INTERVAL_MIN}m once=${RUN_ONCE}`);
    if (!supabase) {
        log('IDLE: SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env and restart the container to activate execution.');
        if (RUN_ONCE) process.exit(0);
        // Stay alive (container remains "running") until the key is added + the container restarted.
        while (true) { await sleep(60 * 1000); }
    }
    if (RUN_ONCE) { await runOnce(); process.exit(0); }
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try { await runOnce(); } catch (e) { log('pass error:', e.message); }
        await sleep(Math.max(1, INTERVAL_MIN) * 60 * 1000);
    }
})();
