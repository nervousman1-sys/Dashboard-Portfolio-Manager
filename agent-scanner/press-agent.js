// ============================================================================
// Finextium — Live MATERIAL Press-Release / Material-News Agent (24/7)
// ----------------------------------------------------------------------------
// 1. Pulls the set of tickers users actually hold (held_tickers RPC, secret-gated).
// 2. Fetches each ticker's latest company news / press releases (Finnhub free API).
// 3. AI MATERIALITY FILTER: asks the LLM, per item — is this MATERIAL? which category?
//    sentiment (-100..100)? one-line Hebrew TL;DR + a short Hebrew fundamental analysis.
//    Only MATERIAL items pass (buyback, CEO change, guidance change, lawsuit, M&A, …).
// 4. ROUTING: route_portfolio_alert() fans each material alert out to every portfolio that
//    holds the ticker, writing one row to public.portfolio_alerts (Realtime-enabled) per
//    portfolio. The UI receives those INSERTs live, with no page refresh.
//
// Run:  node press-agent.js [--once] [--mock]
//   --once : single cycle then exit (for testing / cron)
//   --mock : skip Finnhub+LLM and emit a few canned material alerts (smoke-test the pipeline)
//
// Deploy (VPS, like the other agents — see the vps-agent-deploy memory):
//   scp press-agent.js root@<vps>:/opt/finextium/agent-scanner/
//   pm2 start press-agent.js --name finextium-press-agent --node-args=... && pm2 save
//   NOTE: this agent calls Gemini; the shared free Gemini quota is already strained
//   (see gemini-quota-scanner) — give it a low frequency or its own key.
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
const INTERVAL_MIN = parseFloat(process.env.PRESS_INTERVAL_MIN || '15');
const NEWS_LOOKBACK_HRS = parseFloat(process.env.PRESS_LOOKBACK_HRS || '6');
const MAX_TICKERS = parseInt(process.env.PRESS_MAX_TICKERS || '40', 10);
const RUN_ONCE = process.argv.includes('--once');
const MOCK = process.argv.includes('--mock');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clampSent = (n) => Math.max(-100, Math.min(100, Math.round(Number(n) || 0)));

// Valid categories the UI knows how to render.
const CATEGORIES = ['buyback', 'ceo_change', 'guidance_up', 'guidance_down', 'lawsuit', 'ma', 'dividend', 'offering', 'other'];

// ── 1. Which tickers do users hold? (secret-gated RPC, bypasses RLS) ──────────
async function heldTickers() {
    const { data, error } = await supabase.rpc('held_tickers', { p_secret: AGENT_WRITE_SECRET });
    if (error) { log('held_tickers error:', error.message); return []; }
    return (data || []).map(r => String(r.ticker || '').toUpperCase()).filter(Boolean).slice(0, MAX_TICKERS);
}

// ── 2. Source: latest company news per ticker (Finnhub free `company-news`) ───
async function fetchNews(ticker) {
    if (!FINNHUB_API_KEY) return [];
    const to = new Date();
    const from = new Date(to.getTime() - NEWS_LOOKBACK_HRS * 3600 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_API_KEY}`;
    try {
        const r = await fetch(url);
        if (!r.ok) return [];
        const arr = await r.json();
        if (!Array.isArray(arr)) return [];
        // newest first, keep a few headlines per ticker
        return arr
            .filter(n => n && n.headline)
            .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
            .slice(0, 4)
            .map(n => ({
                ticker,
                headline_en: String(n.headline).trim(),
                body_en: String(n.summary || n.headline).trim(),
                source: n.source || 'Finnhub',
                source_url: n.url || null,
                published_at: n.datetime ? new Date(n.datetime * 1000).toISOString() : new Date().toISOString(),
            }));
    } catch (e) { return []; }
}

// ── 3. AI MATERIALITY FILTER (Gemini): material? category? sentiment? HE TL;DR + analysis ──
async function geminiJSON(prompt) {
    if (!GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(txt);
}

async function classifyMateriality(item) {
    const prompt = [
        'אתה אנליסט אירועים בכיר. נתח את הדיווח הבא של חברה נסחרת והחזר JSON בלבד.',
        `טיקר: ${item.ticker}`,
        `כותרת (אנגלית): ${item.headline_en}`,
        `תקציר (אנגלית): ${item.body_en}`,
        '',
        'החזר אובייקט JSON עם השדות:',
        '{',
        '  "material": boolean,           // האם זה אירוע מהותי באמת (לא רעש/חזרות אנליסטים)',
        `  "category": one of ${JSON.stringify(CATEGORIES)},`,
        '  "company": "שם החברה המלא באנגלית",',
        '  "sentiment": number,           // -100 (שלילי מאוד) עד +100 (חיובי מאוד) להשפעה על המניה',
        '  "summary_he": "תקציר שורה אחת בעברית פשוטה (TL;DR)",',
        '  "analysis_he": "2-3 משפטים של ניתוח פונדמנטלי בעברית: מדוע זה מהותי וההשלכה הצפויה"',
        '}',
        'דרישות: רק הודעות מהותיות (Buyback, החלפת מנכ"ל/CFO, שינוי תחזית, תביעת ענק, מיזוג/רכישה, דיבידנד, הנפקה). אם לא מהותי — material=false.',
    ].join('\n');
    const out = await geminiJSON(prompt);
    if (!out || typeof out !== 'object') return null;
    if (!out.material) return null;
    const category = CATEGORIES.includes(out.category) ? out.category : 'other';
    return {
        ticker: item.ticker,
        company: out.company || item.ticker,
        category,
        sentiment: clampSent(out.sentiment),
        materiality: true,
        summary_he: String(out.summary_he || '').trim(),
        headline_en: item.headline_en,
        body_en: item.body_en,
        analysis_he: String(out.analysis_he || '').trim(),
        source: item.source,
        source_url: item.source_url,
        published_at: item.published_at,
    };
}

// ── 4. ROUTING: fan the alert out to every portfolio that holds the ticker ────
async function routeAlert(alert) {
    const { data, error } = await supabase.rpc('route_portfolio_alert', { p_secret: AGENT_WRITE_SECRET, p_alert: alert });
    if (error) { log('route error', alert.ticker, error.message); return 0; }
    return Number(data) || 0;
}

// ── Mock material alerts (for --mock smoke tests, no Finnhub/Gemini needed) ────
const MOCK_ALERTS = [
    { ticker: 'AAPL', company: 'Apple Inc.', category: 'buyback', sentiment: 74, summary_he: 'אפל אישרה רכישה עצמית שיא של 110 מיליארד דולר.', headline_en: 'Apple authorizes record $110B share buyback', body_en: 'Apple’s board authorized an additional $110B for repurchases.', analysis_he: 'אות לעודף מזומנים ואמון הנהלה; מצמצם מניות ותומך ב-EPS.', source: 'PR Newswire' },
    { ticker: 'NVDA', company: 'NVIDIA Corp.', category: 'guidance_up', sentiment: 80, summary_he: 'אנבידיה העלתה תחזית הכנסות לרבעון על רקע ביקושי-שיא ל-GPU.', headline_en: 'NVIDIA raises Q3 revenue guidance on record data-center demand', body_en: 'NVIDIA raised Q3 revenue outlook well above prior guidance.', analysis_he: 'העלאת תחזית מקדימה את הקונצנזוס; ביקוש שמקדים היצע — חיובי חזק.', source: 'NVIDIA IR' },
    { ticker: 'TSLA', company: 'Tesla Inc.', category: 'ceo_change', sentiment: -34, summary_he: 'סמנכ"ל הכספים של טסלה פורש; מונה ממלא-מקום.', headline_en: 'Tesla CFO to step down; interim successor named', body_en: 'Tesla’s CFO will step down at quarter-end.', analysis_he: 'אי-ודאות ניהולית בחברה עתירת-הון; לחץ סנטימנט בטווח הקצר.', source: 'CNBC' },
];

async function runCycle() {
    log(`Press-agent cycle starting…${MOCK ? ' (MOCK)' : ''}`);
    let materialAlerts = [];

    if (MOCK) {
        materialAlerts = MOCK_ALERTS.map(a => Object.assign({}, a, { materiality: true, published_at: new Date().toISOString() }));
    } else {
        const tickers = await heldTickers();
        if (!tickers.length) { log('No held tickers to scan.'); return; }
        log(`Scanning ${tickers.length} held tickers for material news…`);
        for (const tk of tickers) {
            const news = await fetchNews(tk);
            for (const item of news) {
                try {
                    const alert = await classifyMateriality(item);
                    if (alert && alert.summary_he) materialAlerts.push(alert);
                } catch (e) {
                    log(`classify ${tk} soft-fail:`, e.message);
                    if (/HTTP 429/.test(e.message)) { await sleep(8000); }   // back off on quota
                }
                await sleep(400);
            }
            await sleep(300);
        }
    }

    let routed = 0, fired = 0;
    for (const alert of materialAlerts) {
        const n = await routeAlert(alert);
        if (n > 0) { fired++; routed += n; log(`✓ ${alert.ticker} [${alert.category}] → ${n} portfolios · ${alert.summary_he}`); }
        await sleep(200);
    }
    log(`Cycle done · ${materialAlerts.length} material · ${fired} new · ${routed} portfolio rows written.`);
}

async function safeCycle() { try { await runCycle(); } catch (e) { log('Cycle error (retry next interval):', e.message); } }

(async () => {
    log(`Finextium Press-Agent online · interval=${INTERVAL_MIN}min · finnhub=${FINNHUB_API_KEY ? 'on' : 'off'} · gemini=${GEMINI_API_KEY ? 'on' : 'off'}${MOCK ? ' · MOCK' : ''}`);
    await safeCycle();
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    setInterval(safeCycle, Math.max(5, INTERVAL_MIN) * 60 * 1000);
})();
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
