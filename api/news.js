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
async function translateBatchGemini(texts) {
    if (!GEMINI_KEY || !texts.length) return null;
    const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt =
        'תרגם את כותרות החדשות הכלכליות הבאות לעברית עיתונאית-כלכלית ברורה, טבעית וזורמת שמובנת מיד לקורא ישראלי — לא תרגום מילולי ולא "תרגום מכונה". נסח כל כותרת כפי שהיה כותב עיתונאי כלכלי ישראלי. ' +
        'בטא את המשמעות הפיננסית האמיתית בבירור: ' +
        '"mixed" → "נסחרות במגמה מעורבת", "rally/surge/jump" → "מזנקות/מזנק", "slip/drop/fall" → "נחלשות/יורד", "edge higher/lower" → "עולה/יורד קלות", ' +
        '"late afternoon trading" → "במסחר של אחר הצהריים", "raises ... at a valuation" → "גייסה הון לפי שווי" (לא "הונפקה"; "הנפקה" רק ל-IPO), "upgrades/improves its models" → "משדרגת את המודלים" (לא "משביחה"). ' +
        'השאר שמות חברות וטיקרים באנגלית במקומם. הקפד על דקדוק, תחביר טבעי והתאמת מין/מספר, וללא שגיאות כתיב. שמור על העובדות, המספרים והשמות בדיוק. ' +
        'החזר אך ורק רשימה ממוספרת באותו הסדר, שורה אחת לכל כותרת, ללא הקדמות ותוספות.\n\n' + numbered;
    try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
            }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        const text = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('\n').trim() || '';
        if (!text) return null;
        const lines = text.split('\n').map(l => l.replace(/^\s*\d+[.)\]]\s*/, '').trim()).filter(Boolean);
        return lines.length >= texts.length ? lines.slice(0, texts.length) : null;
    } catch (e) { return null; }
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
            const heBatch = await translateBatchGemini(allItems.map(it => it.en));
            if (heBatch) {
                allItems.forEach((it, i) => { it.he = heBatch[i] || it.en; });
            } else {
                await Promise.all(allItems.map(async (it) => { it.he = await translateHe(it.en); }));
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
