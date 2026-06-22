// ============================================================================
// Finextium — Agent Scanner (24/7 Early-Alpha intelligence daemon)
// ----------------------------------------------------------------------------
// A long-running process that, on a fixed cadence, asks the core intelligence
// model (Gemini, with live Google Search grounding so the signals are REAL and
// current — not hallucinated) to surface ONE highest-conviction Early-Alpha
// sub-sector, then writes the structured insight into Supabase `catalyst_cards`.
//
// Designed to be kept alive by PM2 / systemd: it self-schedules with an internal
// timer and never throws out of the loop, so the supervisor only has to restart
// it if the whole process dies.
//
// Run:   node scanner.js            (daemon — scans on the interval, forever)
//        node scanner.js --once     (single scan then exit — for cron/testing)
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
// Node < 22 has no global WebSocket; supabase-js v2 requires one at client creation even though this
// agent only uses the REST/RPC API. Provide the `ws` polyfill so it constructs cleanly.
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { /* ws optional */ }

// ── Config (from .env) ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;          // optional (direct insert)
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;          // used with the anon-key RPC path
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'd6ji4k9r01qkvh5q0aa0d6ji4k9r01qkvh5q0aag';
const MIN_MARKET_CAP_B = parseFloat(process.env.MIN_MARKET_CAP_B || '1');   // every target ≥ $1B
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SCAN_INTERVAL_HOURS = parseFloat(process.env.SCAN_INTERVAL_HOURS || '4');
const DEDUP_DAYS = parseInt(process.env.DEDUP_DAYS || '14', 10);
const RUN_ONCE = process.argv.includes('--once');

// Two supported write paths:
//   • service_role key  → direct insert (RLS bypassed).
//   • anon key + secret → the secure insert_catalyst_card() RPC (no service_role needed).
const USE_RPC = !SERVICE_KEY;
const SUPABASE_KEY = SERVICE_KEY || SUPABASE_ANON_KEY;

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(msg) { console.error(`[${new Date().toISOString()}] FATAL:`, msg); process.exit(1); }

if (!SUPABASE_URL || !SUPABASE_KEY) fail('Missing SUPABASE_URL / SUPABASE key (service_role or anon) in .env');
if (USE_RPC && !AGENT_WRITE_SECRET) fail('Anon-key mode needs AGENT_WRITE_SECRET in .env');
if (!GEMINI_API_KEY) fail('Missing GEMINI_API_KEY in .env');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// ── The core system prompt (Hebrew) that drives the analysis ──
const SYSTEM_PROMPT = `אתה מנוע המודיעין הליבתי של "Finextium" – פלטפורמה פיננסית מתקדמת לניתוח שווקים. המשימה הבלעדית שלך היא לאתר סקטורים חמים ותתי-תעשיות בשלבים המוקדמים ביותר שלהם (שלב ה-Early Alpha), רגע לפני שהם מגיעים למדיה המרכזית או חווים פריצות מחיר חדות (Breakouts).

אתה מבצע זאת באמצעות הצלבה חיה (Cross-Referencing) וזיהוי נקודות מפגש (Convergence) בין 4 שכבות מידע שונות:
1. קטליסט טכנולוגי ומדעי: סריקת רישומי פטנטים חדשים (למשל USPTO) ומאמרים אקדמיים (כמו arXiv).
2. שרשרת אספקה וביקושים: תמלולי שיחות אנליסטים (Earnings Calls) של חברות B2B, איתור חוסרים בחומרי גלם או עיכובי ייצור.
3. תנועת כוח אדם (Talent Migration): אנומליות וזינוקים בגיוס עובדים למשרות הנדסיות/מדעיות ספציפיות בלוחות דרושים.
4. הון סיכון שקט: מגמות השקעה בשלבים מוקדמים (Series A/B) של קרנות הון סיכון מובילות בסקטורים אנונימיים.

חומת הגנה קריטית (מסנן אנטי-FOMO):
אם סקטור, תמה או תעשייה כבר חוו זינוק מחירים מסיבי, רוויה תקשורתית (סיקור נרחב באתרים כלכליים גדולים), או מחזורי מסחר קיצוניים – אתה מחויב לסמן אותו כ-"שלב מאוחר / רווי" (Late Stage) ולהתעלם ממנו.
דוגמאות לנושאים רווים שיש להימנע מהם כעת: זכרונות מחשב (HBM), שבבי AI גנריים (NVIDIA/AMD), או תרופות הרזיה פופולריות. התמקדות אך ורק בפרדיגמה הבאה שעוד לא התפוצצה.

חוק קריטי לגבי stealth_targets (אכיפה מוחלטת): כל מטרה חייבת להיות חברה ציבורית הנסחרת בבורסה מרכזית (NYSE / NASDAQ או בורסה מוכרת אחרת) עם טיקר תקין ושווי שוק של לפחות מיליארד דולר (1B$+). אסור בהחלט לכלול חברות פרטיות, סטארט-אפים לפני הנפקה, או טיקר "N/A". המשקיע צריך להיות מסוגל לקנות את המניה כבר עכשיו. ספק 3–5 חברות ציבוריות כאלה בעלות החשיפה הישירה והפחות-מתומחרת ביותר לנישה. אם אין מספיק חברות ציבוריות מעל מיליארד דולר עם חשיפה אמיתית לנישה — בחר נישה אחרת שכן עומדת בתנאי.

דרישות הפלט (Output) - מבנה קבוע שיוחזר כ-JSON נקי כדי שיוצג ב-UI של Finextium:
{
  "sector_name": "שם תת-הסקטור",
  "thesis": "הסבר קצר וממוקד עד 2 משפטים על פריצת הדרך",
  "tech_layer": "פירוט פטנטים או תגליות מדעיות",
  "supply_layer": "ציטוט או עדות ישירה לחוסר בהיצע או זינוק בביקוש",
  "talent_layer": "אילו משרות חוות כרגע גל גיוסים אגרסיבי בנישה",
  "stage_score": "Early Alpha (0-15%)",
  "media_saturation": "Low / Near-Zero",
  "stealth_targets": [
    {"company": "שם החברה א", "ticker": "TICKER1", "why": "סיבה קצרה"},
    {"company": "שם החברה ב", "ticker": "TICKER2", "why": "סיבה קצרה"}
  ]
}
טון וסגנון כתיבה: ניהולי, אנליטי, קר ומבוסס דאטה בלבד.`;

// ── Gemini call with Google Search grounding (real, current signals) ──
async function callGemini(avoidSectors) {
    const userTask =
        'בצע כעת סבב סריקה חי. השתמש בחיפוש כדי לאמת את 4 שכבות המידע על נתונים עדכניים אמיתיים (פטנטים/arXiv, שיחות אנליסטים, לוחות דרושים, סבבי גיוס Series A/B). ' +
        'החזר אך ורק אובייקט JSON יחיד ותקין במבנה המדויק שהוגדר — עבור תת-הסקטור היחיד בעל הביטחון הגבוה ביותר שנמצא כרגע בשלב Early Alpha. ' +
        'אל תכלול טקסט נוסף, הסברים או סימוני קוד — רק ה-JSON.' +
        (avoidSectors && avoidSectors.length
            ? ` הימנע מהסקטורים הבאים שכבר דווחו לאחרונה ובחר נישה שונה לחלוטין: ${avoidSectors.join(' | ')}.`
            : '');

    const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userTask }] }],
        tools: [{ google_search: {} }],                 // live grounding → REAL data
        // thinkingBudget 0: Gemini 2.5's "thinking" tokens otherwise consume the output budget and
        // the call returns finishReason=MAX_TOKENS with EMPTY text. Disable thinking + give ample
        // output room so the JSON card always comes back. Grounding still works.
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    let r;
    // Gemini returns transient 503 ("model overloaded") / 429 (rate) under load — retry with backoff.
    for (let attempt = 0; attempt < 4; attempt++) {
        r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok) break;
        if ((r.status === 503 || r.status === 429) && attempt < 3) { log(`Gemini ${r.status} — retry ${attempt + 1}/3`); await sleep(5000 * (attempt + 1)); continue; }
        throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 250)}`);
    }
    if (!r || !r.ok) throw new Error('Gemini unavailable after retries');
    const j = await r.json();
    const cand = (j.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('\n').trim();
    // Real source URLs from the grounding metadata (so each card is auditable).
    const sources = (((cand.groundingMetadata || {}).groundingChunks) || [])
        .map(c => c.web && { title: c.web.title, uri: c.web.uri }).filter(Boolean).slice(0, 8);
    return { text, sources };
}

// Extract the first valid JSON object from a model response (strips ``` fences / prose).
function parseCard(text) {
    if (!text) return null;
    let s = text.replace(/```json/gi, '```').replace(/```/g, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function valid(card) {
    return card && typeof card.sector_name === 'string' && card.sector_name.trim().length > 1 && card.thesis;
}

// HARD GATE: keep only stealth targets that are REAL, exchange-listed stocks with market cap ≥ $1B.
// Verified live via Finnhub profile2 (market cap in millions). Enriches each with the real market
// cap + exchange. The model is told to obey this, but we enforce it here so nothing slips through.
async function validateTargets(targets) {
    if (!Array.isArray(targets) || !targets.length) return [];
    const out = [];
    await Promise.all(targets.map(async (t) => {
        const tk = String(t.ticker || '').toUpperCase().replace(/[^A-Z.]/g, '').trim();
        if (!tk || /^N\.?A$/.test(tk)) return;
        try {
            const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(tk)}&token=${FINNHUB_API_KEY}`);
            if (!r.ok) return;
            const p = await r.json();
            const mcapM = p && p.marketCapitalization;            // millions of USD
            if (!mcapM || !p.exchange || mcapM < MIN_MARKET_CAP_B * 1000) return; // not listed / < $1B
            out.push({
                company: p.name || t.company || tk,
                ticker: tk,
                why: t.why || '',
                market_cap_b: Math.round(mcapM / 1000 * 10) / 10,
                exchange: p.exchange,
            });
        } catch (e) { /* drop unverifiable */ }
    }));
    const seen = new Set();
    return out.filter(x => { if (seen.has(x.ticker)) return false; seen.add(x.ticker); return true; });
}

// Skip if we already produced a card for the same sub-sector recently.
async function isDuplicate(sectorName) {
    const cutoff = new Date(Date.now() - DEDUP_DAYS * 86400000).toISOString();
    const { data, error } = await supabase
        .from('catalyst_cards').select('sector_name').gte('created_at', cutoff).limit(200);
    if (error) { log('dedup query warn:', error.message); return false; }
    const norm = (x) => String(x || '').toLowerCase().replace(/[^\w֐-׿]+/g, ' ').trim();
    const incoming = norm(sectorName);
    return (data || []).some(r => {
        const ex = norm(r.sector_name);
        return ex && (ex === incoming || ex.includes(incoming) || incoming.includes(ex));
    });
}

async function recentSectors() {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data } = await supabase
        .from('catalyst_cards').select('sector_name').gte('created_at', cutoff).order('created_at', { ascending: false }).limit(25);
    return (data || []).map(r => r.sector_name).filter(Boolean);
}

async function runCycle() {
    log('Scan cycle starting…');
    const avoid = await recentSectors();
    const { text, sources } = await callGemini(avoid);
    const card = parseCard(text);
    if (!valid(card)) { log('No valid card this cycle (model returned non-JSON / empty). Skipping.'); return; }

    if (await isDuplicate(card.sector_name)) {
        log(`Duplicate sector "${card.sector_name}" within ${DEDUP_DAYS}d — skipping insert.`);
        return;
    }

    // Enforce: only real, exchange-listed targets ≥ $1B. No valid ones → the card isn't actionable.
    const targets = await validateTargets(card.stealth_targets);
    if (!targets.length) {
        log(`"${card.sector_name}": no exchange-listed ≥$${MIN_MARKET_CAP_B}B targets — skipping.`);
        return;
    }
    card.stealth_targets = targets;

    const payload = {
        sector_name: String(card.sector_name).slice(0, 200),
        thesis: card.thesis || null,
        tech_layer: card.tech_layer || null,
        supply_layer: card.supply_layer || null,
        talent_layer: card.talent_layer || null,
        stage_score: card.stage_score || null,
        media_saturation: card.media_saturation || null,
        stealth_targets: Array.isArray(card.stealth_targets) ? card.stealth_targets : [],
        sources,
    };
    if (USE_RPC) {
        const { error } = await supabase.rpc('insert_catalyst_card', { p_secret: AGENT_WRITE_SECRET, p_card: payload });
        if (error) throw new Error(`RPC insert failed: ${error.message}`);
    } else {
        const { error } = await supabase.from('catalyst_cards').insert({ ...payload, raw: card, status: 'active' });
        if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    }
    log(`✓ Inserted catalyst card: "${payload.sector_name}" (${payload.stage_score || '—'}, sources: ${sources.length})`);
}

async function safeCycle() {
    try { await runCycle(); }
    catch (e) { log('Cycle error (will retry next interval):', e.message); }
}

(async () => {
    log(`Finextium Agent Scanner online · model=${GEMINI_MODEL} · interval=${SCAN_INTERVAL_HOURS}h · dedup=${DEDUP_DAYS}d`);
    await safeCycle();                       // run immediately on boot
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    const ms = Math.max(0.25, SCAN_INTERVAL_HOURS) * 3600 * 1000;
    setInterval(safeCycle, ms);              // self-schedule; PM2/systemd keeps the process alive
})();

// Keep the supervisor's logs clean — never let an unhandled rejection kill the daemon.
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
