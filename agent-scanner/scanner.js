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
טון וסגנון כתיבה: ניהולי, אנליטי, קר ומבוסס דאטה בלבד.

איכות העברית (חובה): כל הטקסט חייב להיות בעברית עיתונאית-כלכלית רהוטה, ברורה, תקנית וקלה להבנה — לא תרגום מילולי מאנגלית. נסח מחדש בעברית טבעית וזורמת, עם דקדוק תקין, תחביר נכון והתאמת מין/מספר. הכותרת (sector_name) חייבת להיות בעברית מלאה וברורה (אפשר עם המונח הלועזי בסוגריים) — לא באנגלית בלבד. מונחים טכניים: השתמש במונח העברי המקובל והשגור (למשל quantum sensing → "חיישנים קוונטיים", לעולם לא "חישה"); אם אין מקבילה עברית טבעית — השאר את המונח באנגלית בסוגריים. אל תמציא מילים ואל תשתמש בעברית מסורבלת. שמות חברות, מותגים, אנשים וטיקרים — באנגלית במקור.`;

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
// Hebrew quality gate — a SECOND model pass that rewrites every Hebrew field of the card into
// fluent, grammatically-correct, professional Hebrew (separating "what to research" from "how it
// reads"). No grounding, no thinking — fast + cheap. Best-effort: on any failure the original card
// is kept, so the pipeline never breaks.
async function polishHebrew(card) {
    const input = {
        sector_name: card.sector_name || '',
        thesis: card.thesis || '',
        tech_layer: card.tech_layer || '',
        supply_layer: card.supply_layer || '',
        talent_layer: card.talent_layer || '',
        whys: (Array.isArray(card.stealth_targets) ? card.stealth_targets : []).map(t => t.why || ''),
    };
    const sys = 'אתה עורך הלשון הראשי של מגזין כלכלי-טכנולוגי ישראלי מוביל, ומומחה לתרגום מדע וטכנולוגיה לעברית. שכתב את שדות הטקסט לעברית מצוינת, מדויקת ובהירה שכל קורא ישראלי יבין במלואה. כתוב עברית פשוטה, יומיומית וברורה — כמו כתבה בעיתון יומי, לא שפה ספרותית/אקדמית/מסורבלת. עקרונות מחייבים: (0) אסור ניקוד בכלל — בלי שום סימן ניקוד על האותיות, כתיב מלא רגיל בלבד. אל תשתמש לעולם במילה "חישה" — אם הכוונה ל-sensing כתוב "חיישנים" או "זיהוי" לפי ההקשר. מונח טכני בלי מילה עברית פשוטה ושגורה — השאר באנגלית. (1) כל מילה חייבת להיות מילה עברית תקנית הקיימת בפועל במילון ובשימוש — אסור בתכלית להמציא מילים, אסור תרגום מילולי מאולץ, ואסור להשתמש במילה עברית שאינה ברורה או אינה שגורה. (2) הקורא חייב להבין את הכותרת והטקסט במלואם וללא ידע מוקדם — נסח כך שהמשמעות חד-משמעית ושלמה. (3) מונח מדעי/טכני: השתמש במונח העברי המקובל והשגור בתעשייה; אם אין מונח עברי שגור, ברור ומדויק — השאר את המונח באנגלית (רצוי לצד תיאור עברי קצר או בסוגריים). מונח לועזי מובן עדיף תמיד על מילה עברית מומצאת או עמומה. (4) sector_name (הכותרת): עברית מלאה וברורה, עם המונח המקצועי הלועזי בסוגריים. (5) שמור בדיוק על כל המספרים, האחוזים, שמות החברות, הטיקרים ושמות האנשים (באנגלית במקור). אל תשנה עובדות או משמעות — רק את הניסוח. (6) שמור על אורך דומה. דוגמאות לניסוח נכון: "Quantum Sensing" → "חיישנים קוונטיים" (לעולם לא "חישה"); "Organ-on-Chip" → "איבר על שבב (Organ-on-Chip)"; "Direct Air Capture" → "לכידת פחמן ישירות מהאוויר (DAC)"; "Prime Editing" → "עריכת גנים מדויקת (Prime Editing)"; "Ferroelectric Memory" → "זיכרון פֶרוֹאֶלֶקְטְרי (Ferroelectric)". החזר אך ורק אובייקט JSON תקין עם אותם מפתחות בדיוק (sector_name, thesis, tech_layer, supply_layer, talent_layer, whys[]) ותו לא.';
    const POLISH_MODEL = process.env.GEMINI_POLISH_MODEL || 'gemini-2.5-flash'; // flash + thinking = fast & good (set to pro for max quality)
    const body = {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: 'שכתב לעברית מצוינת, תקנית וברורה את ה-JSON הבא (החזר JSON באותו מבנה בדיוק):\n' + JSON.stringify(input) }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 8192 }, // thinking ON (no budget cap) → higher Hebrew quality
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${POLISH_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        let r;
        for (let attempt = 0; attempt < 6; attempt++) {
            r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r.ok) break;
            if ((r.status === 503 || r.status === 429) && attempt < 5) { await sleep(5000 * (attempt + 1)); continue; }
            return card; // give up → keep original
        }
        if (!r || !r.ok) return card;
        const j = await r.json();
        const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('\n').trim() || '';
        const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
        if (a < 0 || b <= a) return card;
        const p = JSON.parse(txt.slice(a, b + 1));
        if (p.sector_name) card.sector_name = p.sector_name;
        if (p.thesis) card.thesis = p.thesis;
        if (p.tech_layer) card.tech_layer = p.tech_layer;
        if (p.supply_layer) card.supply_layer = p.supply_layer;
        if (p.talent_layer) card.talent_layer = p.talent_layer;
        if (Array.isArray(p.whys) && Array.isArray(card.stealth_targets)) {
            card.stealth_targets.forEach((t, i) => { if (p.whys[i]) t.why = p.whys[i]; });
        }
        log('Hebrew polish applied.');
    } catch (e) { log('Hebrew polish skipped:', e.message); }
    // Deterministic guarantee (runs even if Gemini was skipped/failed): strip ALL nikud/cantillation
    // marks (the user wants none) and replace the disliked word "חישה" → "זיהוי". Idempotent.
    const clean = (s) => s == null ? s : String(s).replace(/[֑-ׇ]/g, '').replace(/חישה/g, 'זיהוי').replace(/[ \t]{2,}/g, ' ').trim();
    card.sector_name = clean(card.sector_name);
    card.thesis = clean(card.thesis);
    card.tech_layer = clean(card.tech_layer);
    card.supply_layer = clean(card.supply_layer);
    card.talent_layer = clean(card.talent_layer);
    if (Array.isArray(card.stealth_targets)) card.stealth_targets.forEach(t => { if (t && t.why) t.why = clean(t.why); });
    return card;
}

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
    if (!valid(card)) { log('No valid card this cycle (model returned non-JSON / empty). Skipping.'); return 'נסרק — אין מודיעין חדש בעל ודאות מספקת'; }

    if (await isDuplicate(card.sector_name)) {
        log(`Duplicate sector "${card.sector_name}" within ${DEDUP_DAYS}d — skipping insert.`);
        return `נסרק — הסקטור "${card.sector_name}" כבר קיים`;
    }

    // Enforce: only real, exchange-listed targets ≥ $1B. No valid ones → the card isn't actionable.
    const targets = await validateTargets(card.stealth_targets);
    if (!targets.length) {
        log(`"${card.sector_name}": no exchange-listed ≥$${MIN_MARKET_CAP_B}B targets — skipping.`);
        return `נסרק — לא נמצאו מניות נסחרות ≥$${MIN_MARKET_CAP_B}B`;
    }
    card.stealth_targets = targets;

    // Hebrew quality gate — rewrite all Hebrew fields to fluent, correct Hebrew before storing.
    await polishHebrew(card);

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
    return `נמצא מודיעין חדש: ${payload.sector_name}`;
}

// Write a heartbeat so the UI can prove the agent is alive + scanning continuously. On a soft-fail
// (ok=false) we pass null so the RPC KEEPS the last real finding (only last_run advances) — the
// status then shows the agent as active with its last result, never a quota/error message.
async function heartbeat(result, ok) {
    try {
        const next = new Date(Date.now() + Math.max(0.25, SCAN_INTERVAL_HOURS) * 3600 * 1000).toISOString();
        const p_result = ok === false ? null : (result || '').slice(0, 200);
        await supabase.rpc('upsert_agent_status', { p_secret: AGENT_WRITE_SECRET, p_agent: 'scanner', p_next_run: next, p_result });
    } catch (e) { log('heartbeat warn:', e.message); }
}

async function safeCycle() {
    let res, ok = true;
    try { res = await runCycle(); }
    catch (e) {
        ok = false;
        // Don't surface a raw error to the UI. Quota/rate limits are expected on the free tier —
        // show a calm "waiting for an API window" status; the daemon keeps retrying automatically.
        res = /429|quota|rate|exhaust/i.test(e.message || '') ? 'פעיל · ממתין לחלון API פנוי (ימשיך אוטומטית)' : 'פעיל · סורק (ניסיון חוזר בסבב הבא)';
        log('Cycle soft-fail (will retry next interval):', e.message);
    }
    await heartbeat(res, ok);
}

// One-off: re-run the Hebrew quality gate over EVERY existing active card and persist the result.
// Used to upgrade cards produced before polishHebrew existed. `node scanner.js --repolish`.
async function repolishAll() {
    const onlyId = (process.argv.find(a => a.startsWith('--id=')) || '').split('=')[1];
    let q = supabase.from('catalyst_cards').select('*').eq('status', 'active');
    if (onlyId) q = q.eq('id', Number(onlyId));
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) { log('repolish select error:', error.message); return; }
    log(`Re-polishing Hebrew for ${data.length} card(s)${onlyId ? ` (id=${onlyId})` : ''}…`);
    for (const card of data) {
        const before = card.sector_name;
        await polishHebrew(card);
        const patch = {
            sector_name: card.sector_name, thesis: card.thesis, tech_layer: card.tech_layer,
            supply_layer: card.supply_layer, talent_layer: card.talent_layer, stealth_targets: card.stealth_targets,
        };
        const { error: uerr } = await supabase.rpc('update_catalyst_card', { p_secret: AGENT_WRITE_SECRET, p_id: card.id, p_patch: patch });
        log(uerr ? `  card ${card.id} update FAILED: ${uerr.message}` : `  card ${card.id}: "${before}" → "${card.sector_name}"`);
        await new Promise(r => setTimeout(r, 1500)); // gentle on the Gemini quota
    }
    log('repolish done.');
}

(async () => {
    if (process.argv.includes('--repolish')) { await repolishAll(); process.exit(0); }
    log(`Finextium Agent Scanner online · model=${GEMINI_MODEL} · interval=${SCAN_INTERVAL_HOURS}h · dedup=${DEDUP_DAYS}d`);
    await safeCycle();                       // run immediately on boot
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    const ms = Math.max(0.25, SCAN_INTERVAL_HOURS) * 3600 * 1000;
    setInterval(safeCycle, ms);              // self-schedule; PM2/systemd keeps the process alive
})();

// Keep the supervisor's logs clean — never let an unhandled rejection kill the daemon.
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
