// ========== Vercel Serverless Function — Report SWOT + Strategy (Hebrew, Gemini) ==========
//
//   POST /api/report-ai
//     body: { symbol, company, sector, context: { ...compact financial figures... } }
//   GET  /api/report-ai?symbol=AAPL&company=Apple&...   (figures as query params)
//     → { swot: { strengths[], weaknesses[], opportunities[], threats[] },
//         strategy: { vision, progressToward, keyPartnerships[], outlook } }   // all Hebrew
//
// Reuses the Gemini Flash setup from api/vision.js (free tier, GEMINI_API_KEY).
// The qualitative analysis changes slowly, so results are memoized in-process and
// cached hard at the edge per company.

const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

const _memo = new Map();

const HEB_QUALITY = ' כתוב עברית עסקית-פיננסית תקנית, ברורה וזורמת — לא תרגום מילולי. הקפד על דקדוק, מונחים פיננסיים מדויקים והתאמת מין/מספר. בסס כל אבחנה על הנתונים שסופקו ועל ידע ציבורי על החברה; אל תמציא מספרים, שותפויות או עובדות שאינך בטוח בהן.';

function buildPrompt(d) {
    const ctx = d.context || {};
    const lines = Object.entries(ctx)
        .filter(([k]) => k !== 'flags')
        .map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const flags = Array.isArray(ctx.flags) && ctx.flags.length ? ('\nדגלי סיכון שזוהו:\n' + ctx.flags.map(f => '- ' + f).join('\n')) : '';
    return `אתה אנליסט מאקרו ופונדמנטלי בכיר. נתח את החברה "${d.company || d.symbol}" (טיקר ${d.symbol}${d.sector ? ', סקטור ' + d.sector : ''}).
להלן נתונים פונדמנטליים מהדו"ח הכספי האחרון:
${lines || '(אין נתונים מספריים זמינים — הסתמך על ידע ציבורי על החברה)'}${flags}

החזר אך ורק אובייקט JSON תקין (ללא טקסט נוסף, ללא markdown, ללא \`\`\`) במבנה המדויק הבא:
{
  "swot": {
    "strengths": ["2-4 חוזקות, כל אחת משפט קצר ומבוסס"],
    "weaknesses": ["2-4 חולשות"],
    "opportunities": ["2-4 הזדמנויות עתידיות"],
    "threats": ["2-4 איומים/סיכונים"]
  },
  "strategy": {
    "vision": "משפט-שניים על הויז'ן ארוך-הטווח של החברה",
    "progressToward": "היכן החברה עומדת בהשגת הויז'ן — התקדמות מול יעדים, על בסיס הנתונים",
    "keyPartnerships": ["שותפויות אסטרטגיות מהותיות ידועות, אם קיימות"],
    "outlook": "סיכום אסטרטגי קדימה — לאן החברה הולכת ומה המפתח להצלחתה"
  }
}
כל הטקסט בעברית.${HEB_QUALITY}`;
}

// Pull the first balanced {...} JSON object out of the model text (handles stray prose / fences).
function extractJson(text) {
    if (!text) return null;
    let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
    }
    return null;
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    // Accept POST body or GET query (context may be a JSON string in the query).
    let d = {};
    if (req.method === 'POST') {
        d = (typeof req.body === 'object' && req.body) ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
    } else {
        d = { symbol: req.query.symbol, company: req.query.company, sector: req.query.sector };
        if (req.query.context) { try { d.context = JSON.parse(req.query.context); } catch (e) { d.context = {}; } }
    }
    const symbol = String(d.symbol || '').trim().toUpperCase();
    if (!symbol) { res.status(400).json({ error: 'symbol required' }); return; }

    if (!KEY) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(200).json({ error: 'not_configured', message: 'GEMINI_API_KEY is not set' });
        return;
    }

    const memoKey = symbol;
    if (_memo.has(memoKey)) {
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
        res.status(200).json({ ..._memo.get(memoKey), cached: true });
        return;
    }

    try {
        const payload = JSON.stringify({
            contents: [{ parts: [{ text: buildPrompt(d) }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' },
        });

        let parsed = null, lastErr = '';
        for (const model of MODELS) {
            const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
            });
            if (!gr.ok) { lastErr = `gemini(${model}) ${gr.status}`; continue; }
            const gj = await gr.json();
            const text = (((gj.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('\n').trim() || '';
            parsed = extractJson(text);
            if (parsed && parsed.swot) break;
            lastErr = `unparseable result from ${model}`;
        }
        if (!parsed || !parsed.swot) throw new Error(lastErr || 'empty ai result');

        const result = { symbol, swot: parsed.swot, strategy: parsed.strategy || {} };
        _memo.set(memoKey, result);
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
        res.status(200).json(result);
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'ai_failed', message: e.message });
    }
};
