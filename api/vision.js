// ========== Vercel Serverless Function — Image → Hebrew Text (Vision) ==========
//
// The Discord agents post their daily updates as RENDERED IMAGES (Hebrew headlines
// burned into a PNG). Classic OCR mangles Hebrew, so this uses Gemini Flash (free
// API key tier) to transcribe/summarize the image into clean Hebrew text.
//
//   /api/vision?img=<url>&mode=transcribe  → the text written in the image, verbatim
//   /api/vision?img=<url>&mode=summary     → short per-item summary of the content
//
// Requires GEMINI_API_KEY (free at aistudio.google.com/apikey). Results are
// memoized per image (in-memory) + edge-cached hard: an image's text never changes.

const KEY = process.env.GEMINI_API_KEY || '';
// Primary + fallback — both verified to have free-tier quota on the user's key
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// Appended to every prompt: enforce clean, correct Hebrew so transcription slips
// (e.g. a surging index mis-written as "מונפק" instead of "מזנק") don't reach the UI.
const HEB_QUALITY = ' חשוב מאוד: כתוב עברית תקנית ונכונה לחלוטין — ללא שגיאות כתיב, ללא מילים שגויות וללא מונחים לא קיימים. השתמש במונחים פיננסיים מדויקים (לדוגמה: מדד/מניה "מזנק/מזנקת" כשעולה בחדות, ולא "מונפק"; "מונפק" שמור רק להנפקה ראשונית של חברה). הקפד על דקדוק והתאמת מין/מספר.';

const PROMPTS = {
    transcribe: 'התמונה מכילה עדכון חדשות כלכלי בעברית. תמלל את כל הטקסט שכתוב בתמונה, בעברית, נאמן למקור, מאורגן בשורות עם כותרות המשנה. אל תוסיף הערות משלך — רק את התוכן שבתמונה.' + HEB_QUALITY,
    summary: 'התמונה מכילה טבלה/דוח פיננסי. סכם בעברית בקצרה את התוכן: כל פריט/עדכון בשורה נפרדת עם הנתונים המספריים החשובים (שמות, סכומים, כיוונים). בלי הקדמות ובלי הערות — רק השורות.' + HEB_QUALITY,
    // News: HEADLINES ONLY — no market indices / commodity prices block
    headlines: 'התמונה מכילה עדכון חדשות כלכלי בעברית. תמלל אך ורק את כותרות החדשות עצמן — אל תכלול את סיכום השווקים, מדדי מניות, סחורות, קריפטו או מחירים. אם יש חלוקה לקטגוריות (ישראל / עולם) — כתוב שורת כותרת "ישראל:" או "עולם:" לפני הכותרות של אותה קטגוריה. כל כותרת חדשות בשורה נפרדת, ללא מספור וללא תוספות שלך.' + HEB_QUALITY,
    // Capital flows: STRUCTURED so the client can render direction bars + a conclusion + analysis
    flows: 'התמונה מציגה תנועות הון / זרימות כספים מוסדיות, ייתכן בכמה טבלאות/רשימות (למשל: סקטורים באחוזים וגם תעודות סל בדולרים). סרוק את התמונה כולה מלמעלה עד למטה והחזר אך ורק שורות בפורמט המדויק הבא, בלי שום טקסט אחר:\nסקטור: <שם הסקטור או הנכס> | כיוון: <כניסה או יציאה> | היקף: <הסכום או הערך כפי שמופיע>\nחובה לכלול את כל השורות מכל הטבלאות ללא יוצא מן הכלל — גם כניסות וגם יציאות. שורה אחת לכל סקטור/נכס. ' +
        'אם מופיעים בתמונה שמות של גופים מוסדיים, קרנות, מנהלי נכסים או ETFs ספציפיים שמזיזים את הכסף — הוסף שורה לכל אחד בפורמט: "מוסדי: <שם הגוף> | <כניסה/יציאה> | <היקף אם מצוין>". אל תמציא שמות שלא מופיעים בתמונה. ' +
        'ובסוף שורת מסקנה אחת:\nמסקנה: <משפט קצר בעברית — לאן זורם הכסף ומאילו סקטורים הוא יוצא>\n' +
        'ולאחריה 2 עד 4 שורות ניתוח, כל אחת מתחילה ב"ניתוח:" — הסבר קצר, ענייני ומבוסס מדוע סביר שהכסף זורם כך לפי הנתונים בתמונה: רוטציה סקטוריאלית, מצב מאקרו (ריבית/אינפלציה/צמיחה), העדפת סקטורים דפנסיביים מול מחזוריים, מומנטום, או עונתיות. בסס אך ורק על מה שנראה בתמונה ועל הקשר כלכלי הגיוני — אל תמציא נתונים מספריים שלא מופיעים. כתוב עברית תקנית; טיקרים באנגלית (כמו XLE, SPY) השאר באנגלית במקומם הטבעי במשפט.' + HEB_QUALITY,
};

// Deterministic safety net: fixes known Hebrew financial transcription slips after
// the model returns, so even if the model errs the UI never shows the wrong word.
// Rules are anchored to context to avoid mangling legitimate words.
function fixHebrew(text) {
    if (!text) return text;
    let out = text;
    // A market/index/stock that is SURGING is "מזנק", never "מונפק" (IPO term).
    // Anchored to a market subject so a real IPO ("החברה מונפקת בבורסה") is untouched.
    out = out.replace(
        /(וול\s*סטריט|נאסד["״'’]?ק|נאסדק|דאו(?:\s*ג['’]?ונס)?|S&P\s*500|הבורסה|הבורסות|המסחר|מדד\S*|המדד\S*|מניות\S*|המניות\S*)(\s+(?:\S+\s+){0,2}?)מונפק(ת|ים|ות|)/g,
        '$1$2מזנק$3'
    );
    out = out.replace(/\bבעיקבות\b/g, 'בעקבות');
    return out;
}

const _memo = new Map();

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    if (!KEY) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(200).json({ error: 'not_configured', message: 'GEMINI_API_KEY is not set' });
        return;
    }

    try {
        const img = String(req.query.img || '');
        const mode = PROMPTS[req.query.mode] ? req.query.mode : 'transcribe';
        if (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net|hcti\.io)\//.test(img)) {
            res.status(400).json({ error: 'bad_image_host' });
            return;
        }

        const memoKey = `${mode}:${img.split('?')[0]}`;
        if (_memo.has(memoKey)) {
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
            res.status(200).json({ text: _memo.get(memoKey), cached: true });
            return;
        }

        // Fetch the image server-side and inline it as base64
        const ir = await fetch(img, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!ir.ok) throw new Error(`image fetch ${ir.status}`);
        const buf = Buffer.from(await ir.arrayBuffer());
        if (buf.length > 6 * 1024 * 1024) throw new Error('image too large');
        const mime = ir.headers.get('content-type') || 'image/png';

        const payload = JSON.stringify({
            contents: [{
                parts: [
                    { text: PROMPTS[mode] },
                    { inline_data: { mime_type: mime, data: buf.toString('base64') } },
                ],
            }],
            // thinkingBudget 0: Gemini 2.5 spends "thinking" tokens INSIDE
            // maxOutputTokens — with thinking on, long tables came back truncated
            // mid-sentence (the conclusion line was cut). Transcription needs no
            // reasoning, so give every token to the actual output.
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
        });

        let text = '', lastErr = '';
        for (const model of MODELS) {
            const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
            });
            if (!gr.ok) {
                lastErr = `gemini(${model}) ${gr.status}`;
                continue; // quota/transient → try the fallback model
            }
            const gj = await gr.json();
            text = (((gj.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('\n').trim() || '';
            if (text) break;
            lastErr = `empty result from ${model}`;
        }
        if (!text) throw new Error(lastErr || 'empty vision result');
        text = fixHebrew(text); // deterministic Hebrew correction safety net

        _memo.set(memoKey, text);
        // The image never changes → cache hard at the edge
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
        res.status(200).json({ text });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'vision_failed', message: e.message });
    }
};
