// ============================================================================
// Finextium — Macro Feed Agent (24/7 geopolitical + macro-economy updates)
// ----------------------------------------------------------------------------
// Sibling of scanner.js. On a short cadence it pulls REAL macro/geopolitical news (Google News RSS
// + Finnhub), keeps only MATERIAL items (keyword-scored, anti-noise), translates each to EXCELLENT
// Hebrew via Gemini (a strict journalistic-financial editor prompt), tags it, dedupes, and writes
// it into Supabase `macro_updates` for the "גיאופוליטיקה ומאקרו" section to read.
//
// Run:  node macro-feed.js          (daemon)
//       node macro-feed.js --once   (single cycle)
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'd6ji4k9r01qkvh5q0aa0d6ji4k9r01qkvh5q0aag';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MACRO_INTERVAL_MIN = parseFloat(process.env.MACRO_INTERVAL_MIN || '30');
const MACRO_PER_CYCLE = parseInt(process.env.MACRO_PER_CYCLE || '8', 10);   // max new items per cycle
const BASE = process.env.FINEXTIUM_BASE || 'https://www.finextium.com';
const RUN_ONCE = process.argv.includes('--once');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
if (!GEMINI_API_KEY) fail('Missing GEMINI_API_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ── Material macro/geopolitical keyword groups → Hebrew tag (only items that score pass) ──
const GROUPS = [
    { tag: 'מוניטרי', w: 3, re: /\b(federal reserve|the fed|fed['s]?\b|fomc|interest rate|rate (cut|hike|decision|path)|powell|e\.?c\.?b\.?|lagarde|bank of (england|japan)|boj\b|central bank|quantitative (easing|tightening)|basis points?|bps\b)/i },
    { tag: 'אינפלציה/צמיחה', w: 3, re: /\b(inflation|cpi\b|ppi\b|pce\b|core (inflation|cpi)|gdp\b|recession|jobs report|payrolls?|unemployment|jobless|consumer (price|spending|confidence|sentiment)|retail sales|stagflation|soft landing)/i },
    { tag: 'גיאופוליטיקה', w: 3, re: /\b(war|conflict|military|missile|strike|sanction|tariff|trade war|geopolit|coup|ceasefire|invasion|nuclear|israel|iran|gaza|hezbollah|hamas|houthi|russia|ukraine|china|taiwan|north korea|middle east|red sea|election results?)/i },
    { tag: 'אנרגיה', w: 2, re: /\b(opec\+?|crude|oil price|brent|wti|natural gas|energy (crisis|prices?)|per barrel|gas prices?)/i },
    { tag: 'שווקים', w: 2, re: /\b(treasury (yield|note|bond)|10-?year yield|bond yields?|debt ceiling|sovereign|credit downgrade|default risk|the dollar|dxy|safe[- ]haven|gold (price|hits)|yield curve)/i },
];

function decodeXml(s) {
    return String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
async function googleNewsRss(path) {
    try {
        const r = await fetch(`https://news.google.com/rss/${path}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/rss+xml,application/xml,text/xml,*/*' } });
        if (!r.ok) return [];
        const xml = await r.text(); const out = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
        while ((m = re.exec(xml)) !== null) {
            const b = m[1];
            const title = decodeXml((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+-\s+[^-]{2,40}$/, '').trim();
            if (!title) continue;
            const link = decodeXml((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
            const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
            const src = decodeXml((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '') || 'Google News';
            const d = pub ? new Date(pub) : null;
            out.push({ headline: title, url: link, source: src, published_at: (d && !isNaN(d)) ? d.toISOString().slice(0, 10) : null });
        }
        return out;
    } catch (e) { return []; }
}
async function finnhubGeneral() {
    try {
        const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) return [];
        const j = await r.json();
        return (Array.isArray(j) ? j : []).filter(n => n && n.headline).map(n => ({
            headline: n.headline, url: n.url || '', source: n.source || 'Finnhub',
            published_at: n.datetime ? new Date(n.datetime * 1000).toISOString().slice(0, 10) : null,
        }));
    } catch (e) { return []; }
}

// Collect → score (material only) → dedupe → top N most material/recent.
async function gatherMaterial() {
    const q = encodeURIComponent('(Federal Reserve OR interest rates OR inflation OR recession OR GDP OR jobs report OR geopolitics OR war OR sanctions OR tariffs OR OPEC OR oil prices OR Treasury yields OR central bank) when:3d');
    const feeds = await Promise.all([
        googleNewsRss(`search?q=${q}&hl=en-US&gl=US&ceid=US:en`),
        googleNewsRss(`headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en`),
        finnhubGeneral(),
    ]);
    const all = [].concat(...feeds);
    const seen = new Set(); const scored = [];
    for (const n of all) {
        const key = n.headline.toLowerCase().trim();
        if (seen.has(key)) continue; seen.add(key);
        let score = 0, tag = null, best = 0;
        for (const g of GROUPS) { if (g.re.test(n.headline)) { score += g.w; if (g.w > best) { best = g.w; tag = g.tag; } } }
        if (score < 2) continue;
        scored.push({ ...n, tag, _rank: score * 1e11 + (n.published_at ? Date.parse(n.published_at) : 0) });
    }
    scored.sort((a, b) => b._rank - a._rank);
    return scored.map(({ _rank, ...x }) => x);
}

// Batch-translate English headlines → EXCELLENT Hebrew (one call), aligned by leading number.
async function translateHe(headlines) {
    const numbered = headlines.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const sys = 'אתה עורך חדשות כלכלי בכיר בעיתון כלכלי ישראלי מוביל (גלובס/כלכליסט/דה-מרקר). נסח כל כותרת מחדש כעברית כלכלית-עיתונאית מצוינת: רהוטה, חדה, ברורה ותקנית — עריכה, לא תרגום מילולי. כללים: (1) עברית טבעית וזורמת, דקדוק תקין, תחביר נכון, התאמת מין/מספר, ללא שגיאות וללא מילים מומצאות. (2) מונחים פיננסיים מדויקים: rally/surge→"זינוק", slip/drop→"ירידה", mixed→"מגמה מעורבת", earnings→"דוחות", yields→"תשואות". (3) מונחים טכניים — מקבילה עברית מקובלת; אם אין — השאר באנגלית. (4) שמות אנשים/חברות/מותגים/טיקרים — באנגלית במקור ובאיות מלא ומדויק (Powell, Kevin Warsh, S&P 500). (5) שמור בדיוק על מספרים, אחוזים ושמות. (6) קצר וענייני ככותרת.';
    const body = {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: 'נסח לעברית מצוינת, החזר אך ורק רשימה ממוספרת 1 עד ' + headlines.length + ' באותו סדר, שורה לכל כותרת, ללא טקסט נוסף:\n\n' + numbered }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let r;
    for (let a = 0; a < 3; a++) {
        r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok) break;
        if ((r.status === 503 || r.status === 429) && a < 2) { log(`Gemini ${r.status} — retry ${a + 1}/2`); await sleep(5000 * (a + 1)); continue; }
        throw new Error(`Gemini HTTP ${r.status}`);
    }
    if (!r || !r.ok) throw new Error('Gemini unavailable');
    const j = await r.json();
    const text = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('\n').trim() || '';
    const out = new Array(headlines.length).fill(null);
    for (const line of text.split('\n')) { const m = line.match(/^\s*(\d+)[.)\]]\s*(.+\S)\s*$/); if (m) { const i = +m[1] - 1; if (i >= 0 && i < out.length && !out[i]) out[i] = m[2].trim(); } }
    return out;
}

async function recentHeadlines() {
    const cutoff = new Date(Date.now() - 5 * 86400000).toISOString();
    const { data } = await supabase.from('macro_updates').select('headline_en').gte('created_at', cutoff).limit(400);
    return new Set((data || []).map(r => String(r.headline_en || '').toLowerCase().trim()));
}

async function runCycle() {
    log('Macro-feed cycle starting…');
    const items = await gatherMaterial();
    if (!items.length) { log('No material items this cycle.'); return; }
    const have = await recentHeadlines();
    const fresh = items.filter(n => !have.has(n.headline.toLowerCase().trim())).slice(0, MACRO_PER_CYCLE);
    if (!fresh.length) { log('Nothing new since last cycle.'); return; }
    const he = await translateHe(fresh.map(n => n.headline));
    let inserted = 0;
    for (let i = 0; i < fresh.length; i++) {
        const n = fresh[i];
        const item = { headline_he: he[i] || n.headline, headline_en: n.headline, tag: n.tag, source: n.source, url: n.url, published_at: n.published_at };
        const { error } = await supabase.rpc('insert_macro_update', { p_secret: AGENT_WRITE_SECRET, p_item: item });
        if (!error) inserted++; else log('insert warn:', error.message);
    }
    log(`✓ Macro feed: +${inserted} new updates (of ${fresh.length} fresh, ${items.length} material).`);
}

// Fetch the live yield curves (US + IL, FRED) and persist them, so the macro page reads an
// agent-backed, 24/7-fresh row instead of every client hitting FRED. Runs every cycle, independent
// of the news flow (which returns early when there's nothing new).
async function updateYields() {
    try {
        const r = await fetch(`${BASE}/api/yields?d=${new Date().toISOString().slice(0, 10)}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) { log('yields fetch HTTP', r.status); return; }
        const data = await r.json();
        if (!data || !Array.isArray(data.us) || data.us.length < 3) { log('yields payload thin — skipping'); return; }
        const { error } = await supabase.rpc('upsert_yield_curve', { p_secret: AGENT_WRITE_SECRET, p_data: data });
        if (error) log('yields upsert warn:', error.message);
        else log(`✓ Yield curves stored · US ${data.us.length} pts · IL ${(data.il || []).length} pts · asOf ${data.asOf || '—'}`);
    } catch (e) { log('yields update warn:', e.message); }
}

// Economic-calendar snapshot (release dates + released-vs-pending status + the figure each
// report published, from /api/fred?cal=1) → Supabase `econ_calendar`. The macro page reads
// this row FIRST, so on release day the "התקבל ✓ + מה יצא בדוח" flip happens 24/7 within
// minutes — no user has to be the one whose browser hits FRED at the right moment.
async function updateEconCalendar() {
    try {
        const r = await fetch(`${BASE}/api/fred?cal=1&t=${Math.floor(Date.now() / 300000)}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) { log('econ-cal fetch HTTP', r.status); return; }
        const data = await r.json();
        if (!data || !Array.isArray(data.events) || !data.events.length) { log('econ-cal payload thin — skipping'); return; }
        const { error } = await supabase.rpc('upsert_econ_calendar', { p_secret: AGENT_WRITE_SECRET, p_key: 'us', p_payload: data });
        if (error) log('econ-cal upsert warn:', error.message);
        else {
            const released = data.events.filter(e => e.released).map(e => e.key);
            log(`✓ Econ calendar stored · ${data.events.length} upcoming · released today: ${released.length ? released.join(',') : '—'}`);
        }
    } catch (e) { log('econ-cal update warn:', e.message); }
}

// ── Israeli macro indicators — LIVE, 24/7 → Supabase `il_macro` ─────────────────────
// The client used to fetch these itself (BOI SDMX — gateway-blocked; FMP calendar — 403),
// so it always fell back to a HARDCODED baseline that never changed (BOI rate stuck at
// 3.75% even after a cut). This agent pulls the REAL values server-side and stores them, so
// the macro page reads fresh, agent-backed Israeli data — updated on every actual change.
//   • BOI policy rate: boi.org.il PublicApi/GetInterest (authoritative, live)
//   • CPI YoY: CBS (הלמ"ס) api.cbs.gov.il — the official Israeli print. FRED's OECD
//     Israel CPI series (CPALTT01ILM659N) DIED at 2025-03 and froze the card at 3.34%.
//   • Unemployment / GDP: FRED official Israeli series (freshness-guarded)
const FRED_KEY = process.env.FRED_API_KEY || 'f568440cde5cb64b20cd92e80292fbac';
async function _fredLatest(id, units) {
    try {
        const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=6${units ? '&units=' + units : ''}`;
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const obs = (j.observations || []).filter(o => o.value !== '.' && o.value !== '');
        if (!obs.length) return null;
        const val = parseFloat(obs[0].value);
        const prev = obs[1] ? parseFloat(obs[1].value) : null;
        return { value: val, previous: isFinite(prev) ? prev : null, date: obs[0].date };
    } catch (e) { return null; }
}
// Drop observations that stopped updating (dead OECD series etc.) — a stale value must
// NEVER override the client's fresher sources just because the agent row wins the merge.
function _fresh(o, maxDays) {
    return (o && o.date && (Date.now() - new Date(o.date).getTime()) < maxDays * 86400e3) ? o : null;
}
// Israeli price indices straight from the CBS API (percentYear = official YoY print).
//   120010 = CPI general · 120020 = CPI ex fruits & vegetables · 170010 = industrial-output PPI
async function _cbsIndexYoY(id) {
    try {
        const r = await fetch(`https://api.cbs.gov.il/index/data/price?id=${id}&format=json&download=false&last=14`,
            { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const dates = (j.month && j.month[0] && j.month[0].date) || [];
        if (!dates.length) return null;
        const sorted = dates.slice().sort((a, b) => (b.year - a.year) || (b.month - a.month));
        const latest = sorted[0], prev = sorted[1] || null;
        if (latest.percentYear == null) return null;
        const ymd = (o) => `${o.year}-${String(o.month).padStart(2, '0')}-01`;
        return { value: latest.percentYear, previous: prev ? prev.percentYear : null, date: ymd(latest) };
    } catch (e) { return null; }
}
// Real BOI decision history — previous value per current rate, used only when the stored
// row has no previous yet (e.g. the row predates change-detection). 6-Jul-2026: 3.75 → 3.5.
const BOI_PREV_BY_RATE = { 3.5: 3.75, 3.75: 4.0 };
async function updateIsraelMacro() {
    try {
        // Read the current stored row so we can preserve the PREVIOUS policy-rate value across a change.
        let prevData = {};
        try { const { data } = await supabase.from('il_macro').select('data').eq('id', 'current').maybeSingle(); prevData = (data && data.data) || {}; } catch (e) { }
        const out = {};

        // 1) BOI policy rate — the authoritative live source.
        try {
            const r = await fetch('https://www.boi.org.il/PublicApi/GetInterest', {
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            });
            if (r.ok) {
                const j = await r.json();
                const v = parseFloat(j.currentInterest);
                if (isFinite(v)) {
                    const storedBoi = prevData.boi_rate || {};
                    // When the rate changes, the OLD stored value becomes "previous" (real change detection).
                    // First run / null history: fall back to the documented BOI decision history.
                    const previous = (storedBoi.value != null && storedBoi.value !== v) ? storedBoi.value
                        : (storedBoi.previous != null ? storedBoi.previous : (BOI_PREV_BY_RATE[v] != null ? BOI_PREV_BY_RATE[v] : null));
                    out.boi_rate = {
                        value: v, previous,
                        trend: previous == null ? 'flat' : v > previous ? 'up' : v < previous ? 'down' : 'flat',
                        date: (j.lastPublishedDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
                        nextDate: (j.nextInterestDate || '').slice(0, 10) || null,
                        label: 'ריבית בנק ישראל', unit: '%',
                    };
                }
            }
        } catch (e) { log('BOI rate warn:', e.message); }

        // 2) Prices from CBS (the official prints) + FRED for unemployment/GDP — every source
        //    freshness-guarded so a dead series silently drops out instead of freezing a card.
        const [cpiRaw, coreRaw, ppiRaw, unempRaw, gdpRaw] = await Promise.all([
            _cbsIndexYoY(120010),                  // CPI YoY % — CBS official (e.g. 1.9%)
            _cbsIndexYoY(120020),                  // CPI ex fruits & vegetables YoY %
            _cbsIndexYoY(170010),                  // Industrial-output PPI YoY %
            _fredLatest('LRHUTTTTILM156S'),        // Harmonized unemployment rate %
            _fredLatest('NAEXKP01ILQ657S'),        // Real GDP growth QoQ % — series IS a growth rate; no extra transform
        ]);
        const cpi = _fresh(cpiRaw, 75), core = _fresh(coreRaw, 75), ppiIl = _fresh(ppiRaw, 75),
            unemp = _fresh(unempRaw, 120), gdp = _fresh(gdpRaw, 220);
        if (cpi) out.il_cpi = { ...cpi, value: +cpi.value.toFixed(2), trend: cpi.previous == null ? 'flat' : cpi.value > cpi.previous ? 'up' : cpi.value < cpi.previous ? 'down' : 'flat', label: 'מדד המחירים לצרכן (CPI YoY)', unit: '%' };
        // Honest labels for the CBS definitions; forecast:null blocks inheriting the baseline
        // forecasts, which refer to DIFFERENT definitions/scales (core-CPI defn, PPI index level).
        if (core) out.il_core_cpi = { ...core, value: +core.value.toFixed(2), forecast: null, trend: core.previous == null ? 'flat' : core.value > core.previous ? 'up' : core.value < core.previous ? 'down' : 'flat', label: 'מדד ללא ירקות ופירות (YoY)', unit: '%' };
        if (ppiIl) out.il_ppi = { ...ppiIl, value: +ppiIl.value.toFixed(2), forecast: null, trend: ppiIl.previous == null ? 'flat' : ppiIl.value > ppiIl.previous ? 'up' : ppiIl.value < ppiIl.previous ? 'down' : 'flat', label: 'מדד מחירי יצרן (PPI YoY)', unit: '%' };
        // Unemployment: forecast:null — the baseline forecast is the CBS-official definition,
        // which doesn't match this harmonized series; inheriting it would mislead.
        if (unemp) out.il_unemployment = { ...unemp, value: +unemp.value.toFixed(1), forecast: null, trend: unemp.previous == null ? 'flat' : unemp.value > unemp.previous ? 'up' : unemp.value < unemp.previous ? 'down' : 'flat', label: 'שיעור אבטלה', unit: '%' };
        // GDP: baseline-forecast is on a different scale (annualized) → forecast:null blocks inheriting it.
        if (gdp) out.il_gdp = { ...gdp, value: +gdp.value.toFixed(1), forecast: null, trend: gdp.previous == null ? 'flat' : gdp.value > gdp.previous ? 'up' : gdp.value < gdp.previous ? 'down' : 'flat', label: 'צמיחת תמ״ג (רבעוני, QoQ)', unit: '%' };
        // 3) Real policy rate — BOI rate minus CPI YoY (both real prints above).
        if (out.boi_rate && cpi) {
            const rr = +(out.boi_rate.value - cpi.value).toFixed(2);
            const rrPrev = (out.boi_rate.previous != null && cpi.previous != null)
                ? +(out.boi_rate.previous - cpi.previous).toFixed(2) : null;
            out.il_real_rate = {
                value: rr, previous: rrPrev, forecast: null,
                trend: rrPrev == null ? 'flat' : rr > rrPrev ? 'up' : rr < rrPrev ? 'down' : 'flat',
                date: new Date().toISOString().slice(0, 10),
                label: 'ריבית ריאלית (Real Rate)', unit: '%',
            };
        }

        if (!out.boi_rate && !out.il_cpi) { log('IL-macro: no data this cycle — skipping'); return; }
        const { error } = await supabase.rpc('upsert_il_macro', { p_secret: AGENT_WRITE_SECRET, p_data: out });
        if (error) log('IL-macro upsert warn:', error.message);
        else log(`✓ IL macro stored · BOI ${out.boi_rate ? out.boi_rate.value + '%' : '—'} (next ${out.boi_rate?.nextDate || '—'}) · CPI ${out.il_cpi?.value ?? '—'}% · אבטלה ${out.il_unemployment?.value ?? '—'}%`);
    } catch (e) { log('IL-macro update warn:', e.message); }
}

async function safeCycle() {
    try { await updateYields(); } catch (e) { log('yields cycle error:', e.message); }
    try { await updateIsraelMacro(); } catch (e) { log('IL-macro cycle error:', e.message); }
    try { await runCycle(); } catch (e) { log('Cycle error (retry next interval):', e.message); }
}

(async () => {
    log(`Finextium Macro-Feed online · model=${GEMINI_MODEL} · interval=${MACRO_INTERVAL_MIN}min · perCycle=${MACRO_PER_CYCLE}`);
    await updateEconCalendar();
    await updateIsraelMacro();
    await safeCycle();
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    setInterval(safeCycle, Math.max(5, MACRO_INTERVAL_MIN) * 60 * 1000);
    // Calendar refresh on its own FASTER clock (10 min): a report flips to "released" within
    // minutes of the official print, independent of the heavier 30-min news cycle.
    setInterval(() => updateEconCalendar().catch(e => log('econ-cal tick warn:', e.message)), 10 * 60 * 1000);
})();
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
