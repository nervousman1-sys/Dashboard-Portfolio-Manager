// ========== Vercel Serverless Function — Portfolio News (Hebrew) ==========
//
// Returns recent, REAL financial-news headlines for the portfolio's held tickers,
// translated to Hebrew. Server-side so there are no CORS issues and the API keys
// stay off the client. Cached at the edge so headlines refresh a few times a day.
//
//   /api/news?symbols=AAPL,MSFT,NVDA
//     → { AAPL: [{ he, en, date, url, source }], MSFT: [...], ... }
//
// Source: Finnhub company-news (free, reliable). Translation: Google's public
// translate endpoint (no key); on failure the English headline is returned so the
// caller always has something.

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || 'd6ji4k9r01qkvh5q0aa0d6ji4k9r01qkvh5q0aag';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

async function translateHe(text) {
    if (!text) return '';
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=iw&dt=t&q=${encodeURIComponent(text)}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return text;
        const j = await r.json();
        if (Array.isArray(j) && Array.isArray(j[0])) return j[0].map(seg => (seg && seg[0]) ? seg[0] : '').join('');
        return text;
    } catch (e) { return text; }
}

// Deterministic safety net for the worst literal machine-translation artifacts — applied
// to EVERY Hebrew headline (Gemini or Google fallback) so a stray idiom never ships.
function cleanHe(s) {
    if (!s) return s;
    let o = String(s);
    o = o.replace(/כאילו\s+אין\s+מחר/g, 'בקצב מואץ');
    o = o.replace(/אין\s+מוח\b/g, 'מתבקש');                 // "no-brainer" mis-rendered
    o = o.replace(/לקנות\s+את\s+הטבילה|לקנות\s+את\s+הירידה/g, 'לנצל את הירידה לקנייה'); // "buy the dip"
    // "missing the boat" → literal "מתגעגע/מפספס לסירה/אוטובוס" → idiomatic
    o = o.replace(/(מתגעגע|מפספס|מפספסים|מתגעגעים)(\s+ל?)(סירה|אוטובוס|הסירה|האוטובוס)/g, 'מפספס את ההזדמנות');
    o = o.replace(/בעיקבות/g, 'בעקבות');
    o = o.replace(/משביח(ה|ים|ות|)(\s+את)/g, (m, suf, t) => ({ '': 'משדרג', 'ה': 'משדרגת', 'ים': 'משדרגים', 'ות': 'משדרגות' }[suf] || 'משדרג') + t);
    o = o.replace(/הונפק(ה|ו|)\s+((?:\S+\s+){0,3}?)לפי\s+שווי/g, 'גייסה הון $2לפי שווי');
    o = o.replace(/\s{2,}/g, ' ').trim();
    return o;
}

function ymd(d) { return new Date(d).toISOString().slice(0, 10); }

// Primary: Finnhub company-news (rich, per-company).
async function finnhubNewsFor(symbol, perSymbol) {
    const to = Date.now();
    const from = to - 12 * 86400000; // last ~12 days
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
        `&from=${ymd(from)}&to=${ymd(to)}&token=${FINNHUB_KEY}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return [];
    arr.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
    return arr.filter(n => n && n.headline).slice(0, perSymbol)
        .map(n => ({ en: n.headline, date: ymd((n.datetime || 0) * 1000), url: n.url || '', source: n.source || '' }));
}

// Fallback: Yahoo Finance search news (no key, very reliable) — covers ETFs and any
// symbol Finnhub has nothing for, so a held asset is never left without updates.
async function yahooNewsFor(symbol, perSymbol) {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}` +
        `&newsCount=${perSymbol + 2}&quotesCount=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    const arr = (j && j.news) || [];
    return arr.filter(n => n && n.title).slice(0, perSymbol)
        .map(n => ({
            en: n.title,
            date: n.providerPublishTime ? ymd(n.providerPublishTime * 1000) : '',
            url: n.link || '', source: n.publisher || 'Yahoo',
        }));
}

// Batch-translate all headlines in ONE Gemini call → natural, CLEAR financial
// Hebrew (not a literal word-for-word machine translation). Tickers/names stay in
// English. Returns an array aligned to the input, or null to fall back to Google.
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// English headline → high-quality Hebrew (Gemini). Persists within a warm function
// instance so a repeated headline never re-spends the scarce free-tier quota.
const _heCache = new Map();
async function translateBatchGemini(texts) {
    if (!GEMINI_KEY || !texts.length) return null;
    const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt =
        'אתה עורך חדשות כלכלי בכיר בעיתון כלכלי ישראלי מוביל (גלובס/כלכליסט/דה-מרקר). לפניך כותרות חדשות כלכליות באנגלית. נסח כל אחת מחדש ככותרת עברית מקצועית, חדה וברורה שהקורא הישראלי מבין מיד — זו עריכה ולא תרגום, ובוודאי לא תרגום מכונה מילולי.\n' +
        'כללים מחייבים:\n' +
        '1) נסח מחדש בעברית עיתונאית-כלכלית טבעית וזורמת, לא העתקה מילה-במילה.\n' +
        '2) אל תתרגם ניבים אנגליים מילולית — העבר את המשמעות: "like there\'s no tomorrow"→"בקצב מואץ" (או השמט), "buy the dip"→"לנצל את הירידה לקנייה", "no-brainer"→"השקעה מתבקשת", "skyrocket"→"מרקיע שחקים", "in the red/green"→"בירידות/בעליות", "bag holder"→"מחזיק שנתקע", "moonshot"→"הימור גבוה-סיכון".\n' +
        '3) מונחים פיננסיים מדויקים: mixed→"מגמה מעורבת", rally/surge/jump→"זינוק/מזנק", slip/drop/fall→"ירידה/נחלש", edge higher/lower→"עולה/יורד קלות", earnings→"דוחות כספיים", guidance→"תחזית", valuation→"שווי/הערכת שווי", "raises at a valuation"→"גייסה הון לפי שווי" (לא "הנפקה" — רק ב-IPO), "upgrades its models"→"משדרגת את המודלים" (לא "משביחה").\n' +
        '4) שמות חברות, מותגים, מוצרים, טיקרים ושמות של אנשים — השאר באנגלית במקור ובאיות המלא והמדויק (למשל Mark Cuban, Jerome Powell, BlackRock), במקומם הטבעי במשפט. אל תתעתק שמות לעברית — תעתיק שגוי או חלקי (אות חסרה) הוא טעות חמורה. רק אם קיים תעתיק עברי מקובל לחלוטין ושגור (למשל "וול סטריט", "הפד") מותר להשתמש בו.\n' +
        '5) דקדוק תקין, תחביר טבעי, התאמת מין/מספר, ללא שגיאות כתיב ואף לא אות אחת חסרה. שמור על העובדות, המספרים והשמות בדיוק.\n' +
        '6) קצר וענייני ככותרת — לא משפט מסורבל.\n' +
        'החזר אך ורק רשימה ממוספרת 1 עד ' + texts.length + ', שורה אחת לכל כותרת, באותו סדר בדיוק, ללא שום טקסט נוסף.\n\n' + numbered;
    // One model attempt → an array aligned to the input by each line's LEADING NUMBER
    // (robust to preamble, reordering or a missing line — far better than requiring an
    // exact line count, which used to fail the whole batch and drop us to Google).
    const callModel = async (model) => {
        const genCfg = { temperature: 0.3, maxOutputTokens: 6000 };
        if (/2\.5/.test(model)) genCfg.thinkingConfig = { thinkingBudget: 0 }; // 2.0 has no thinking
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: genCfg,
            }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        const text = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('\n').trim() || '';
        if (!text) return null;
        const out = new Array(texts.length).fill(null);
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*(\d+)[.)\]]\s*(.+\S)\s*$/);
            if (m) { const idx = parseInt(m[1], 10) - 1; if (idx >= 0 && idx < texts.length && !out[idx]) out[idx] = m[2].trim(); }
        }
        return out;
    };
    const filled = (a) => a ? a.filter(Boolean).length : 0;
    let out = null;
    try { out = await callModel('gemini-2.5-flash'); } catch { out = null; }
    // Retry on a different model if the first failed or under-translated.
    if (filled(out) < texts.length) {
        try {
            const alt = await callModel('gemini-2.0-flash');
            if (filled(alt) > filled(out)) out = alt;
        } catch { /* keep first */ }
    }
    if (!out || filled(out) === 0) return null;       // total failure → caller's last resort
    // Any gap stays as the English original — a readable headline beats a garbled
    // literal Google translation. (Gaps are rare with number-aligned parsing + retry.)
    return out.map((he, i) => he || texts[i]);
}

// ── Geopolitical + macro-economy updates (material only) ──
// Pulls Finnhub's general + forex news and keeps ONLY items that materially move the economy —
// monetary policy, inflation/growth, geopolitics, energy, broad markets — scored by keyword groups
// so single-stock fluff is filtered out. Returns the strongest, most recent ~12, each tagged.
const _MACRO_GROUPS = [
    { tag: 'מוניטרי', w: 3, re: /\b(federal reserve|the fed|fed['s]?\b|fomc|interest rate|rate (cut|hike|decision|path)|rate-(cut|hike)|powell|e\.?c\.?b\.?|lagarde|bank of (england|japan)|boj\b|central bank|monetary policy|quantitative (easing|tightening)|basis points?|bps\b)/i },
    { tag: 'אינפלציה/צמיחה', w: 3, re: /\b(inflation|cpi\b|ppi\b|pce\b|core (inflation|cpi)|gdp\b|recession|jobs report|payrolls?|unemployment|jobless|consumer (price|spending|confidence|sentiment)|retail sales|economic growth|stagflation|soft landing)/i },
    { tag: 'גיאופוליטיקה', w: 3, re: /\b(war|conflict|military|missile|strike|sanction|tariff|trade war|geopolit|coup|ceasefire|invasion|nuclear|israel|iran|gaza|hezbollah|hamas|houthi|russia|ukraine|china|taiwan|north korea|middle east|red sea|election results?)/i },
    { tag: 'אנרגיה', w: 2, re: /\b(opec\+?|crude|oil price|brent|wti|natural gas|energy (crisis|prices?)|per barrel|gas prices?)/i },
    { tag: 'שווקים', w: 2, re: /\b(treasury (yield|note|bond)|10-?year yield|bond yields?|debt ceiling|sovereign|credit downgrade|default risk|the dollar|dxy|safe[- ]haven|gold (price|hits)|yield curve)/i },
];
function _decodeXml(s) {
    return String(s == null ? '' : s)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}
// Google News RSS — real headlines, no key, reliably reachable from datacenter IPs (unlike
// Finnhub's general feed). `path` is a search or topic feed.
async function googleNewsRss(path) {
    try {
        const r = await fetch(`https://news.google.com/rss/${path}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
        });
        if (!r.ok) return [];
        const xml = await r.text();
        const out = [];
        const itemRe = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRe.exec(xml)) !== null) {
            const blk = m[1];
            const rawTitle = (blk.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
            const link = (blk.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
            const pub = (blk.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
            const src = (blk.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
            let title = _decodeXml(rawTitle).replace(/\s+-\s+[^-]{2,40}$/, '').trim(); // strip " - Source"
            if (!title) continue;
            const t = pub ? new Date(pub).getTime() : 0;
            out.push({ headline: title, url: _decodeXml(link), datetime: isFinite(t) && t > 0 ? Math.floor(t / 1000) : 0, summary: '', source: _decodeXml(src) || 'Google News' });
        }
        return out;
    } catch (e) { return []; }
}
async function macroNews() {
    let arr = [];
    // Primary: Google News (works from Vercel). A focused query for material macro/geopolitical
    // topics, plus the WORLD topic for breaking geopolitics.
    const q = encodeURIComponent('(Federal Reserve OR interest rates OR inflation OR recession OR GDP OR jobs report OR geopolitics OR war OR sanctions OR tariffs OR OPEC OR oil prices OR Treasury yields OR central bank) when:7d');
    const feeds = await Promise.all([
        googleNewsRss(`search?q=${q}&hl=en-US&gl=US&ceid=US:en`),
        googleNewsRss(`headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en`),
    ]);
    for (const f of feeds) arr = arr.concat(f);
    // Secondary: Finnhub general+forex (works when not IP-limited) for extra breadth.
    for (const c of ['general', 'forex']) {
        try {
            const r = await fetch(`https://finnhub.io/api/v1/news?category=${c}&token=${FINNHUB_KEY}`, { headers: { Accept: 'application/json' } });
            if (r.ok) { const j = await r.json(); if (Array.isArray(j)) arr = arr.concat(j); }
        } catch (e) { /* try next */ }
    }
    const seen = new Set();
    const scored = [];
    for (const n of arr) {
        if (!n || !n.headline) continue;
        const key = String(n.headline).toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const blob = n.headline + ' ' + (n.summary || '');
        let score = 0, tag = null, best = 0;
        for (const g of _MACRO_GROUPS) {
            if (g.re.test(blob)) { score += g.w; if (g.w > best) { best = g.w; tag = g.tag; } }
        }
        if (score < 2) continue; // material only — needs a strong macro/geopolitical hit
        scored.push({ en: n.headline, date: ymd((n.datetime || 0) * 1000), url: n.url || '', source: n.source || '', tag, _rank: score * 1e11 + (n.datetime || 0) });
    }
    scored.sort((a, b) => b._rank - a._rank);
    return scored.slice(0, 12).map(({ _rank, ...x }) => x);
}

// Translate a list of {en} items to Hebrew in-place (Gemini batch → Google fallback), using the
// warm-instance cache. Shared by the symbol-news and macro-news paths.
async function translateItemsHe(items) {
    if (!items.length) return;
    const todo = [];
    for (const it of items) { const c = _heCache.get(it.en); if (c) it.he = c; else todo.push(it); }
    if (!todo.length) return;
    const heBatch = await translateBatchGemini(todo.map(it => it.en));
    if (heBatch) {
        todo.forEach((it, i) => { it.he = cleanHe(heBatch[i] || it.en); if (it.he && it.he !== it.en) _heCache.set(it.en, it.he); });
    } else {
        await Promise.all(todo.map(async (it) => { it.he = cleanHe(await translateHe(it.en)); }));
    }
}

async function newsFor(symbol, perSymbol) {
    let items = [];
    try { items = await finnhubNewsFor(symbol, perSymbol); } catch (e) { items = []; }
    if (!items.length) {
        try { items = await yahooNewsFor(symbol, perSymbol); } catch (e) { items = []; }
    }
    // Translation happens in ONE batch back in the handler (better quality + fewer calls)
    return items.map(n => ({ he: '', en: n.en, date: n.date, url: n.url, source: n.source }));
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        // ── Geopolitical + macro-economy updates (material only) ──
        if (req.query.macro) {
            const items = await macroNews();
            try { await translateItemsHe(items); } catch (e) { /* English headline is the fallback */ }
            res.setHeader('Cache-Control', items.length
                ? 's-maxage=3600, stale-while-revalidate=10800'   // refresh ~hourly
                : 's-maxage=120');
            res.status(200).json({ macro: items });
            return;
        }

        const perSymbol = Math.min(parseInt(req.query.perSymbol, 10) || 1, 2);
        const syms = String(req.query.symbols || '')
            .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
            .filter(s => !s.endsWith('.TA'))   // Finnhub company-news doesn't cover TASE reliably
            .slice(0, 12);
        if (!syms.length) { res.status(200).json({}); return; }

        const entries = await Promise.all(syms.map(async (s) => {
            try { return [s, await newsFor(s, perSymbol)]; } catch (e) { return [s, []]; }
        }));
        const out = {};
        for (const [s, v] of entries) if (v && v.length) out[s] = v;

        // ── Translate ALL headlines together: one high-quality Gemini batch (clear
        //    financial Hebrew); fall back to Google Translate per-headline if needed.
        const allItems = [];
        for (const s of Object.keys(out)) for (const it of out[s]) allItems.push(it);
        if (allItems.length) {
            // Reuse any headline we've ALREADY translated well (Gemini) — a warm function
            // instance keeps _heCache, so a repeated headline costs zero Gemini quota. Only
            // the genuinely-new headlines are sent to Gemini, cutting calls drastically
            // (the free tier is 20 req/min, shared with vision).
            const todo = [];
            for (const it of allItems) {
                const c = _heCache.get(it.en);
                if (c) it.he = c; else todo.push(it);
            }
            if (todo.length) {
                const heBatch = await translateBatchGemini(todo.map(it => it.en));
                if (heBatch) {
                    todo.forEach((it, i) => { it.he = cleanHe(heBatch[i] || it.en); if (it.he && it.he !== it.en) _heCache.set(it.en, it.he); });
                } else {
                    // Gemini quota-blocked → Google as last resort (scrubbed). NOT cached, so
                    // the next attempt re-tries Gemini once quota frees up.
                    await Promise.all(todo.map(async (it) => { it.he = cleanHe(await translateHe(it.en)); }));
                }
            }
        }
        // Cache a populated result for ~2h (continuous through-the-day scanning);
        // if we got nothing (a transient upstream hiccup), cache only briefly so
        // it isn't stuck empty.
        const hasData = Object.keys(out).length > 0;
        res.setHeader('Cache-Control', hasData
            ? 's-maxage=7200, stale-while-revalidate=21600'
            : 's-maxage=60');
        res.status(200).json(out);
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'news_failed', message: e.message });
    }
};
