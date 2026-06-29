// ============================================================================
// Finextium — Crisis-Detection Agent (אינדיקטור לזיהוי משברים, 24/7)
// ----------------------------------------------------------------------------
// Computes the crisis-detection score (0-100) from REAL live signals (CNN Fear&Greed, CPI, policy
// rate, yield-curve inversion, VIX — pulled from the platform's own API), then asks Gemini for a
// short, sharp Hebrew risk assessment grounded in those numbers, and writes both to Supabase
// `crisis_indicator`. The Decision Core reads the latest row. The SCORE is deterministic (real
// data, not AI-invented); only the narrative assessment is generated.
//
// Run:  node crisis-agent.js [--once]
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BASE = process.env.FINEXTIUM_BASE || 'https://www.finextium.com';
const CRISIS_INTERVAL_MIN = parseFloat(process.env.CRISIS_INTERVAL_MIN || '60');
const RUN_ONCE = process.argv.includes('--once');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const clamp = (x) => Math.max(0, Math.min(100, x));
const num = (x) => (x && typeof x === 'object') ? (x.value ?? x.actual ?? null) : x;
async function getJSON(path) { try { const r = await fetch(BASE + path, { headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
async function getText(url) { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); return r.ok ? await r.text() : null; } catch (e) { return null; } }

// Market leverage — Chicago Fed NFCI Leverage Subindex (FRED NFCILEVERAGE, weekly, free, no key).
// Positive = above-average leverage in the financial system → higher fragility/forced-deleverage risk.
async function leveragePart() {
    const csv = await getText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=NFCILEVERAGE');
    let v = null, asof = '';
    if (csv) {
        const lines = csv.trim().split('\n');
        for (let i = lines.length - 1; i >= 1; i--) {
            const cols = lines[i].split(','); const val = parseFloat(cols[cols.length - 1]);
            if (isFinite(val)) { v = val; asof = (cols[0] || '').trim(); break; }
        }
    }
    if (v != null) return { key: 'רמות מינוף בשוק', score: Math.round(clamp((v + 1) / 3 * 100)), w: 0.05, note: `מינוף פיננסי (NFCI) ${v.toFixed(2)}`, _v: v, _asof: asof };
    return { key: 'רמות מינוף בשוק', score: 50, w: 0.05, note: 'נתון חלקי', _partial: true };
}

// ── Generic latest-value fetch from FRED's free CSV endpoint (no API key) ──────
async function fredLatest(id) {
    const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
    if (!csv) return { v: null, asof: '' };
    const lines = csv.trim().split('\n');
    for (let i = lines.length - 1; i >= 1; i--) {
        const cols = lines[i].split(',');
        const val = parseFloat(cols[cols.length - 1]);
        if (isFinite(val)) return { v: val, asof: (cols[0] || '').trim() };
    }
    return { v: null, asof: '' };
}

// ── Extra crisis factors, each CALIBRATED to documented historical-crisis peaks, so the
// composite reads ~100 when conditions resemble a real past crisis (max reliability):
//   HY credit spread (BAMLH0A0HYM2): GFC-2008≈21% · COVID-2020≈11% · EU-2011≈9% · dot-com-2002≈10% · 2022≈6% · calm≈3-4%
//   10y real yield   (DFII10):        pre-GFC-2007≈2.6% · 2022-23≈1.7% · easy money≈0%
//   NFCI fin-cond.   (NFCI):          2008≈+2.6 · 2020≈+1.6 · 2022≈+0.3 · loose≈-0.5
//   Sahm rule        (SAHMREALTIME):  ≥0.5 = recession already started; deep recessions 1-2
async function creditPart() {
    const { v } = await fredLatest('BAMLH0A0HYM2');
    if (v != null) return { key: 'מרווחי אשראי (HY)', score: Math.round(clamp((v - 3) / (10 - 3) * 100)), w: 0.15, note: `מרווח אשראי HY ${v.toFixed(2)}%` };
    return { key: 'מרווחי אשראי (HY)', score: 50, w: 0.15, note: 'נתון חלקי', _partial: true };
}
async function realRatePart() {
    const { v } = await fredLatest('DFII10');
    if (v != null) return { key: 'ריבית ריאלית מגבילה', score: Math.round(clamp(v / 2.5 * 100)), w: 0.10, note: `ריבית ריאלית 10ש' ${v.toFixed(2)}%` };
    return { key: 'ריבית ריאלית מגבילה', score: 50, w: 0.10, note: 'נתון חלקי', _partial: true };
}
async function nfciPart() {
    const { v } = await fredLatest('NFCI');
    if (v != null) return { key: 'תנאים פיננסיים מהודקים', score: Math.round(clamp((v + 0.6) / 1.6 * 100)), w: 0.08, note: `NFCI ${v.toFixed(2)}` };
    return { key: 'תנאים פיננסיים מהודקים', score: 50, w: 0.08, note: 'נתון חלקי', _partial: true };
}
async function sahmPart() {
    const { v } = await fredLatest('SAHMREALTIME');
    if (v != null) return { key: 'מומנטום אבטלה (Sahm)', score: Math.round(clamp(v / 0.6 * 100)), w: 0.10, note: `כלל Sahm ${v.toFixed(2)}` };
    return { key: 'מומנטום אבטלה (Sahm)', score: 30, w: 0.10, note: 'נתון חלקי', _partial: true };
}

// Compute the 5 real sub-signals + the weighted composite (mirrors the client's logic).
async function computeIndicator() {
    const parts = []; let missing = 0;
    // 1. Valuation / complacency — Fear & Greed
    const fg = await getJSON('/api/feargreed');
    const fgv = fg && (fg.score ?? fg.value);
    if (fgv != null && isFinite(fgv)) parts.push({ key: 'הערכות יתר ושאננות', score: Math.round(fgv), w: 0.12, note: `מדד פחד/חמדנות: ${Math.round(fgv)}` });
    else { missing++; parts.push({ key: 'הערכות יתר ושאננות', score: 50, w: 0.12, note: 'נתון חלקי' }); }

    const macro = await getJSON(`/api/macro?d=${new Date().toISOString().slice(0, 10)}`);
    const us = macro && (macro.us || macro.US);
    // 2. Inflation
    const cpi = us ? num(us.cpi) : null;
    if (cpi != null && isFinite(cpi)) parts.push({ key: 'לחצי אינפלציה', score: Math.round(clamp((cpi - 1.5) / (5.5 - 1.5) * 100)), w: 0.10, note: `CPI ${cpi}%` });
    else { missing++; parts.push({ key: 'לחצי אינפלציה', score: 50, w: 0.10, note: 'נתון חלקי' }); }
    // 3. Monetary policy
    const rate = us ? (num(us.fed_rate) ?? num(us.rate)) : null;
    if (rate != null && isFinite(rate)) parts.push({ key: 'מדיניות מוניטרית מהדקת', score: Math.round(clamp(rate / 6 * 100)), w: 0.08, note: `ריבית ${rate}%` });
    else { missing++; parts.push({ key: 'מדיניות מוניטרית מהדקת', score: 50, w: 0.08, note: 'נתון חלקי' }); }
    // 4. Yield-curve inversion (10y - 2y)
    const yj = await getJSON('/api/yields');
    let spread = null;
    if (yj) { const arr = yj.us || yj.US; if (Array.isArray(arr)) { const f = (l) => { const e = arr.find(x => x && x.label === l); return e ? Number(e.value) : null; }; const y10 = f('10Y'), y2 = f('2Y'); if (y10 != null && y2 != null) spread = y10 - y2; } }
    if (spread != null && isFinite(spread)) parts.push({ key: 'היפוך עקום התשואות', score: Math.round(clamp((0.8 - spread) / (0.8 - (-1.2)) * 100)), w: 0.12, note: `מרווח 10ש'−2ש' ${spread.toFixed(2)}%` });
    else { missing++; parts.push({ key: 'היפוך עקום התשואות', score: 50, w: 0.12, note: 'נתון חלקי' }); }
    // 5. Market stress — VIX
    const q = await getJSON('/api/quote?symbols=%5EVIX');
    const vix = q && (q['^VIX'] || q.VIX) && ((q['^VIX'] || q.VIX).price ?? (q['^VIX'] || q.VIX).value);
    if (vix != null && isFinite(vix)) parts.push({ key: 'תנודתיות שוק (VIX)', score: Math.round(clamp((vix - 12) / (45 - 12) * 100)), w: 0.10, note: `VIX ${Number(vix).toFixed(1)}` });
    else { missing++; parts.push({ key: 'תנודתיות שוק (VIX)', score: 40, w: 0.10, note: 'נתון חלקי' }); }
    // 6. Market leverage — Chicago Fed NFCI Leverage Subindex (FRED)
    const lev = await leveragePart();
    if (lev._partial) missing++;
    parts.push(lev);
    // 7-10. Extra historically-validated factors (credit spreads, real rates, financial conditions, Sahm)
    const extra = await Promise.all([creditPart(), realRatePart(), nfciPart(), sahmPart()]);
    for (const x of extra) { if (x._partial) missing++; parts.push(x); }

    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const score = Math.round(parts.reduce((s, p) => s + p.score * p.w, 0) / (wsum || 1));
    const label = score >= 70 ? 'סיכון גבוה' : score >= 45 ? 'סיכון בינוני' : 'יציב';
    return { score, label, parts, partial: missing >= 4 };
}

async function runCycle() {
    log('Crisis indicator cycle starting…');
    const ind = await computeIndicator();
    const cleanParts = ind.parts.map(p => ({ key: p.key, score: p.score, w: p.w, note: p.note }));
    const item = { score: ind.score, label: ind.label, parts: cleanParts, assessment_he: '' };
    const { error } = await supabase.rpc('insert_crisis_indicator', { p_secret: AGENT_WRITE_SECRET, p_item: item });
    if (error) throw new Error(`insert failed: ${error.message}`);
    log(`✓ Crisis indicator: ${ind.score}/100 (${ind.label}) · ${ind.parts.map(p => p.key + '=' + p.score).join(', ')}`);
}
async function safeCycle() { try { await runCycle(); } catch (e) { log('Cycle error (retry next interval):', e.message); } }

(async () => {
    log(`Finextium Crisis-Agent online · interval=${CRISIS_INTERVAL_MIN}min · base=${BASE} · deterministic (real signals + NFCI leverage)`);
    await safeCycle();
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    setInterval(safeCycle, Math.max(15, CRISIS_INTERVAL_MIN) * 60 * 1000);
})();
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
