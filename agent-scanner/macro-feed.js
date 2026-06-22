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

async function safeCycle() { try { await runCycle(); } catch (e) { log('Cycle error (retry next interval):', e.message); } }

(async () => {
    log(`Finextium Macro-Feed online · model=${GEMINI_MODEL} · interval=${MACRO_INTERVAL_MIN}min · perCycle=${MACRO_PER_CYCLE}`);
    await safeCycle();
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    setInterval(safeCycle, Math.max(5, MACRO_INTERVAL_MIN) * 60 * 1000);
})();
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
