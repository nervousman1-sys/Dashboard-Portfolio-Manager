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

// Deterministic material-event keyword screen. Doubles as (a) a pre-filter so ONLY material-looking
// news is sent to Gemini (saves quota), and (b) a robust fallback so REAL alerts still land when
// Gemini is unavailable (429/no key). Each rule → category + a baseline sentiment + a HE one-liner.
const MATERIAL_RULES = [
    { re: /\b(buyback|repurchase|repurchases|repurchasing|repurchase program)\b/i,                 category: 'buyback',       sentiment: 62,  he: 'הכריזה על תוכנית רכישה עצמית של מניות.' },
    { re: /\b(raises?|raised|lifts?|boosts?|hikes?|increases?)\b.*\b(guidance|outlook|forecast|target|estimates?)\b/i, category: 'guidance_up',   sentiment: 58,  he: 'העלתה את התחזית הכספית.' },
    { re: /\b(cuts?|lowers?|lowered|slashes?|reduces?|warns?|warning)\b.*\b(guidance|outlook|forecast|profit|estimates?)\b/i, category: 'guidance_down', sentiment: -58, he: 'הורידה תחזית / מסרה אזהרת רווח.' },
    { re: /\b(ceo|cfo|chief executive|chief financial officer)\b.*\b(steps? down|resigns?|resigned|departs?|to leave|stepping down|ousted)\b/i, category: 'ceo_change', sentiment: -30, he: 'שינוי בהנהלה הבכירה (מנכ״ל/CFO).' },
    { re: /\b(appoints?|names?|hires?)\b.*\b(ceo|cfo|chief executive|chief financial officer|president)\b/i, category: 'ceo_change', sentiment: 8, he: 'מינוי חדש להנהלה הבכירה.' },
    { re: /\b(lawsuit|sues?|sued|antitrust|investigation|probe|fined|settlement|charged|subpoena|recall|sec charges)\b/i, category: 'lawsuit', sentiment: -42, he: 'הליך משפטי / רגולטורי מהותי.' },
    { re: /\b(to acquire|acquires?|acquisition|merger|to buy|takeover|buyout|to combine with)\b/i,  category: 'ma',            sentiment: 36,  he: 'עסקת מיזוג / רכישה.' },
    { re: /\b(dividend|special distribution|raises? dividend|initiates? dividend)\b/i,               category: 'dividend',      sentiment: 34,  he: 'הכרזה / שינוי בדיבידנד.' },
    { re: /\b(convertible notes?|secondary offering|stock offering|share offering|public offering|priced.*offering|equity raise|dilution)\b/i, category: 'offering', sentiment: -26, he: 'הנפקת מניות / אג״ח (דילול אפשרי).' },
    // Broader-but-still-material events (regulatory scrutiny, notable-investor stakes, index changes,
    // product/data incidents, splits) — these are genuinely material to a holder and surface real news.
    { re: /\b(draws scrutiny|under scrutiny|regulatory scrutiny|data (leak|breach)|security flaw|product recall|export ban|sanction)\b/i, category: 'lawsuit', sentiment: -32, he: 'סוגיה רגולטורית / חשיפת מידע מהותית.' },
    { re: /\b(michael burry|warren buffett|berkshire|activist investor|elliott management|starboard|pershing square)\b.{0,40}\b(stake|bet|bets|position|shares)\b|\b(takes?|builds?|raises?|discloses?|adds? to)\b.{0,20}\bstake\b/i, category: 'other', sentiment: 16, he: 'משקיע מוסדי/אקטיביסט בולט נכנס לפוזיציה.' },
    { re: /\b(joins the dow|added to the (dow|s&p ?500|nasdaq[- ]?100)|index inclusion|to join the (dow|nasdaq|s&p))\b/i, category: 'other', sentiment: 24, he: 'הצטרפות / שינוי במדד מרכזי.' },
    { re: /\b(stock split|forward split|reverse split|\d+-for-\d+ split)\b/i, category: 'other', sentiment: 12, he: 'פיצול מניה (Stock Split).' },
    { re: /\b(partnership with|strategic partnership|to supply|multi-?year (deal|agreement)|lands? .{0,20}contract|wins? .{0,20}contract)\b/i, category: 'ma', sentiment: 28, he: 'שותפות אסטרטגית / חוזה מהותי.' },
];

function prescreen(item) {
    const hay = `${item.headline_en} ${item.body_en}`;
    for (const r of MATERIAL_RULES) {
        if (r.re.test(hay)) {
            const catHe = { buyback: 'רכישה עצמית', ceo_change: 'החלפת מנכ״ל', guidance_up: 'העלאת תחזית', guidance_down: 'הורדת תחזית', lawsuit: 'תביעה/רגולציה', ma: 'מיזוג/רכישה', dividend: 'דיבידנד', offering: 'הנפקה' }[r.category] || 'דיווח מהותי';
            return {
                ticker: item.ticker, company: item.ticker, category: r.category, sentiment: r.sentiment, materiality: true,
                summary_he: `${item.ticker} — ${r.he}`,
                headline_en: item.headline_en, body_en: item.body_en,
                analysis_he: `אירוע מסוג "${catHe}" מסווג כמהותי: הוא משפיע ישירות על שווי החברה ועל ציפיות המשקיעים, ולכן נדחף לפיד עבור המחזיקים בנכס.`,
                source: item.source, source_url: item.source_url, published_at: item.published_at,
            };
        }
    }
    return null;   // no material keyword → not material (skipped, no Gemini call)
}

async function classifyMateriality(item) {
    const base = prescreen(item);
    if (!base) return null;                 // not material → skip (and never spend a Gemini call)
    if (!GEMINI_API_KEY) return base;       // no LLM → ship the deterministic alert

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
        '  "summary_he": "תקציר שורה אחת בעברית פשוטה (TL;DR), כולל המספרים המהותיים",',
        '  "analysis_he": "2-3 משפטים של ניתוח פונדמנטלי בעברית: מדוע זה מהותי וההשלכה הצפויה"',
        '}',
    ].join('\n');

    try {
        const out = await geminiJSON(prompt);
        if (out && out.material === false) return null;     // LLM overrules: not actually material
        if (!out || typeof out !== 'object') return base;
        return {
            ...base,
            company: out.company || base.company,
            category: CATEGORIES.includes(out.category) ? out.category : base.category,
            sentiment: (out.sentiment != null) ? clampSent(out.sentiment) : base.sentiment,
            summary_he: String(out.summary_he || base.summary_he).trim(),
            analysis_he: String(out.analysis_he || base.analysis_he).trim(),
        };
    } catch (e) {
        if (/HTTP 429/.test(e.message)) log(`Gemini 429 on ${item.ticker} — using deterministic classification`);
        else log(`Gemini error on ${item.ticker} (${e.message}) — using deterministic classification`);
        return base;   // ROBUST: a real material alert still ships even when Gemini is down
    }
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
