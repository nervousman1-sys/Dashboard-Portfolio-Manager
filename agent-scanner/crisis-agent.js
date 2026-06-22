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
if (!GEMINI_API_KEY) fail('Missing GEMINI_API_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const clamp = (x) => Math.max(0, Math.min(100, x));
const num = (x) => (x && typeof x === 'object') ? (x.value ?? x.actual ?? null) : x;
async function getJSON(path) { try { const r = await fetch(BASE + path, { headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch (e) { return null; } }

// Compute the 5 real sub-signals + the weighted composite (mirrors the client's logic).
async function computeIndicator() {
    const parts = []; let missing = 0;
    // 1. Valuation / complacency — Fear & Greed
    const fg = await getJSON('/api/feargreed');
    const fgv = fg && (fg.score ?? fg.value);
    if (fgv != null && isFinite(fgv)) parts.push({ key: 'הערכות יתר ושאננות', score: Math.round(fgv), w: 0.25, note: `מדד פחד/חמדנות: ${Math.round(fgv)}` });
    else { missing++; parts.push({ key: 'הערכות יתר ושאננות', score: 50, w: 0.25, note: 'נתון חלקי' }); }

    const macro = await getJSON(`/api/macro?d=${new Date().toISOString().slice(0, 10)}`);
    const us = macro && (macro.us || macro.US);
    // 2. Inflation
    const cpi = us ? num(us.cpi) : null;
    if (cpi != null && isFinite(cpi)) parts.push({ key: 'לחצי אינפלציה', score: Math.round(clamp((cpi - 1.5) / (5.5 - 1.5) * 100)), w: 0.2, note: `CPI ${cpi}%` });
    else { missing++; parts.push({ key: 'לחצי אינפלציה', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    // 3. Monetary policy
    const rate = us ? (num(us.fed_rate) ?? num(us.rate)) : null;
    if (rate != null && isFinite(rate)) parts.push({ key: 'מדיניות מוניטרית מהדקת', score: Math.round(clamp(rate / 6 * 100)), w: 0.2, note: `ריבית ${rate}%` });
    else { missing++; parts.push({ key: 'מדיניות מוניטרית מהדקת', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    // 4. Yield-curve inversion (10y - 2y)
    const yj = await getJSON('/api/yields');
    let spread = null;
    if (yj) { const arr = yj.us || yj.US; if (Array.isArray(arr)) { const f = (l) => { const e = arr.find(x => x && x.label === l); return e ? Number(e.value) : null; }; const y10 = f('10Y'), y2 = f('2Y'); if (y10 != null && y2 != null) spread = y10 - y2; } }
    if (spread != null && isFinite(spread)) parts.push({ key: 'היפוך עקום התשואות', score: Math.round(clamp((0.8 - spread) / (0.8 - (-1.2)) * 100)), w: 0.2, note: `מרווח 10ש'−2ש' ${spread.toFixed(2)}%` });
    else { missing++; parts.push({ key: 'היפוך עקום התשואות', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    // 5. Market stress — VIX
    const q = await getJSON('/api/quote?symbols=%5EVIX');
    const vix = q && (q['^VIX'] || q.VIX) && ((q['^VIX'] || q.VIX).price ?? (q['^VIX'] || q.VIX).value);
    if (vix != null && isFinite(vix)) parts.push({ key: 'תנודתיות שוק (VIX)', score: Math.round(clamp((vix - 12) / (45 - 12) * 100)), w: 0.15, note: `VIX ${Number(vix).toFixed(1)}` });
    else { missing++; parts.push({ key: 'תנודתיות שוק (VIX)', score: 40, w: 0.15, note: 'נתון חלקי' }); }

    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const score = Math.round(parts.reduce((s, p) => s + p.score * p.w, 0) / (wsum || 1));
    const label = score >= 70 ? 'סיכון גבוה' : score >= 45 ? 'סיכון בינוני' : 'יציב';
    return { score, label, parts, partial: missing >= 3 };
}

// Short, sharp Hebrew risk assessment grounded in the numbers (Gemini; best-effort).
async function assess(ind) {
    const facts = ind.parts.map(p => `${p.key}: ${p.note} (תת-ציון ${p.score}/100)`).join(' · ');
    const sys = 'אתה אנליסט מאקרו בכיר בפלטפורמת Finextium. כתוב הערכת-סיכון קצרה (2–4 משפטים) בעברית כלכלית רהוטה, חדה ומקצועית, מבוססת אך ורק על הנתונים שיינתנו לך. ציין את רמת הסיכון הכוללת, מהם הגורמים המובילים (הגבוהים) ומה המשמעות המעשית למשקיע. קר, אנליטי, מבוסס דאטה. אל תמציא נתונים. החזר טקסט בלבד, ללא כותרות וללא סימוני קוד.';
    const user = `ציון לזיהוי משברים: ${ind.score}/100 (${ind.label}). האותות: ${facts}.`;
    const body = {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        let r;
        for (let a = 0; a < 3; a++) {
            r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r.ok) break;
            if ((r.status === 503 || r.status === 429) && a < 2) { await sleep(5000 * (a + 1)); continue; }
            return null;
        }
        if (!r || !r.ok) return null;
        const j = await r.json();
        return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join(' ').trim() || null;
    } catch (e) { return null; }
}

async function runCycle() {
    log('Crisis indicator cycle starting…');
    const ind = await computeIndicator();
    const assessment_he = await assess(ind);
    const item = { score: ind.score, label: ind.label, parts: ind.parts, assessment_he: assessment_he || '' };
    const { error } = await supabase.rpc('insert_crisis_indicator', { p_secret: AGENT_WRITE_SECRET, p_item: item });
    if (error) throw new Error(`insert failed: ${error.message}`);
    log(`✓ Crisis indicator: ${ind.score}/100 (${ind.label})${assessment_he ? ' + assessment' : ' (no assessment — quota)'}`);
}
async function safeCycle() { try { await runCycle(); } catch (e) { log('Cycle error (retry next interval):', e.message); } }

(async () => {
    log(`Finextium Crisis-Agent online · model=${GEMINI_MODEL} · interval=${CRISIS_INTERVAL_MIN}min · base=${BASE}`);
    await safeCycle();
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    setInterval(safeCycle, Math.max(15, CRISIS_INTERVAL_MIN) * 60 * 1000);
})();
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
