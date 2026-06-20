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
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];

// Appended to every prompt: enforce clean, correct Hebrew so transcription slips
// (e.g. a surging index mis-written as "מונפק" instead of "מזנק") don't reach the UI.
const HEB_QUALITY = ' חשוב מאוד: כתוב עברית עיתונאית-כלכלית ברורה, טבעית וזורמת שמובנת מיד לקורא ישראלי — לא תרגום מילולי ולא "תרגום מכונה". נסח כל משפט מחדש בעברית תקנית כפי שכתב עיתונאי כלכלי ישראלי, גם אם המקור מגושם. ללא שגיאות כתיב, ללא מילים שגויות וללא מונחים לא קיימים. השתמש במונחים פיננסיים מדויקים: מדד/מניה ש"מזנקת/מזנק" כשעולה בחדות (לא "מונפק"); "הנפקה/הונפקה" שמור אך ורק להנפקת מניות ראשונית (IPO) — גיוס הון לפי שווי אינו "הנפקה"; "משדרגת/משפרת" מוצר או מודל (לא "משביחה"); "בעקבות" (לא "בעיקבות"). הקפד על דקדוק, תחביר טבעי והתאמת מין/מספר. שמור על העובדות, המספרים, השמות והטיקרים בדיוק כפי שהם — אל תוסיף ואל תמציא.' +
    ' בדיקת היגיון חובה לפני הפלט: קרא כל משפט שכתבת ובדוק אם הוא הגיוני מבחינה כלכלית ולשונית ואם ניתן להבין אותו. אם מילה נראית משובשת מקריאת התמונה (שגיאת תמלול/OCR) — תקן אותה למילה ההגיונית והנכונה ביותר לפי ההקשר הפיננסי: למשל "חולות נפט" (oil sands) ולא "חולות נפש"; שם מקום/חברה אמיתי ולא רצף אותיות חסר-פשר (למשל "בחיפה" ולא "בחזרה"). אם משפט יוצא חסר-משמעות, סותר את עצמו או לא ברור — נסח אותו מחדש כך שיהיה הגיוני וברור, ואם אינך מצליח לפענח קטע מסוים בוודאות — השמט אותו לגמרי במקום לכתוב ג\'יבריש. לעולם אל תפלוט משפט שאתה עצמך לא היית מבין. אסור לשנות עובדות, מספרים או שמות — רק לתקן שגיאות קריאה וניסוח.';

const PROMPTS = {
    transcribe: 'התמונה מכילה עדכון חדשות כלכלי בעברית. תמלל את כל הטקסט שכתוב בתמונה, בעברית, נאמן למקור, מאורגן בשורות עם כותרות המשנה. אל תוסיף הערות משלך — רק את התוכן שבתמונה.' + HEB_QUALITY,
    summary: 'התמונה מכילה טבלה/דוח פיננסי. סכם בעברית בקצרה את התוכן: כל פריט/עדכון בשורה נפרדת עם הנתונים המספריים החשובים (שמות, סכומים, כיוונים). בלי הקדמות ובלי הערות — רק השורות.' + HEB_QUALITY,
    // News: HEADLINES ONLY — no market indices / commodity prices block
    headlines: 'התמונה מכילה עדכון חדשות כלכלי. קרא אך ורק את כותרות החדשות עצמן (לא סיכום שווקים, מדדים, סחורות, קריפטו או מחירים) ונסח כל אחת מחדש בעברית עיתונאית-כלכלית ברורה, מדויקת וזורמת — לא תרגום מילולי. אם הניסוח במקור מגושם, שגוי או נשמע כמו תרגום מכונה — תקן אותו לעברית טבעית ונכונה תוך שמירה מוחלטת על המשמעות, העובדות, המספרים והשמות. אם יש חלוקה לקטגוריות (ישראל / עולם) — כתוב שורת כותרת "ישראל:" או "עולם:" לפני הכותרות של אותה קטגוריה. כל כותרת בשורה נפרדת, ללא מספור וללא תוספות שלך.' + HEB_QUALITY,
    // Capital flows: STRUCTURED so the client can render direction bars + a conclusion + analysis
    flows: 'התמונה מציגה תנועות הון / זרימות כספים מוסדיות, ייתכן בכמה טבלאות/רשימות (למשל: סקטורים באחוזים וגם תעודות סל בדולרים). סרוק את התמונה כולה מלמעלה עד למטה והחזר אך ורק שורות בפורמט המדויק הבא, בלי שום טקסט אחר:\nסקטור: <שם הסקטור או הנכס> | כיוון: <כניסה או יציאה> | היקף: <הסכום או הערך כפי שמופיע>\nחובה לכלול את כל השורות מכל הטבלאות ללא יוצא מן הכלל — גם כניסות וגם יציאות. שורה אחת לכל סקטור/נכס. ' +
        'אימות נתונים — חובה: לאחר החילוץ סרוק את התמונה שוב נקודה-אחר-נקודה ובדוק שכל שלשה <סקטור, כיוון, אחוז> תואמת בדיוק למה שמופיע בתמונה. כללים קשיחים: (א) אל תשייך את האחוז של סקטור אחד לסקטור אחר; (ב) אל תכפיל אותו אחוז לשני סקטורים שונים — כל סקטור מקבל את המספר שלו בלבד; (ג) ודא שהכיוון (כניסה=ירוק/חיובי, יציאה=אדום/שלילי) וסימן ה-+/- נכונים; (ד) אל תכלול שורה שאינה סקטור (כותרת, "עולה"/"יורד", סיכום, "סך הכל"); (ה) אם אינך בטוח לחלוטין במספר או בכיוון של שורה מסוימת — השמט אותה לגמרי במקום לנחש. עדיף פחות שורות אך מדויקות לחלוטין. ' +
        'אם מופיעים בתמונה שמות של גופים מוסדיים, קרנות, מנהלי נכסים או ETFs ספציפיים שמזיזים את הכסף — הוסף שורה לכל אחד בפורמט המדויק: "מוסדי: <שם הגוף> | <כניסה/יציאה> | <יעד: הסקטור/הנכס/הקרן שאליו או ממנו הכסף זז> | <היקף אם מצוין>". שדה היעד הוא קריטי וחייב להיות מדויק — ציין את הנכס הספציפי בדיוק כפי שמופיע בתמונה: אם מצוין טיקר/שם קרן (ETF) או מניה — כתוב אותם בדיוק (למשל "SOXX", "IBIT", "AI Chips ETF", "TLT"); אחרת ציין את התת-סקטור הספציפי ביותר ולא רק את הסקטור הרחב (למשל "מוליכים למחצה" ולא "טכנולוגיה"; "נפט וגז" ולא "אנרגיה"; "אג\\"ח ממשלתי ארוך"). אל תכתוב יעד כללי כשבתמונה מופיע נכס ספציפי. אם היעד לא מופיע במפורש בתמונה השאר את השדה ריק (שני קווים אנכיים רצופים), אך אל תמציא יעד. אל תמציא שמות גופים שלא מופיעים בתמונה. ' +
        'ובסוף שורת מסקנה אחת:\nמסקנה: <משפט קצר בעברית — לאן זורם הכסף ומאילו סקטורים הוא יוצא>\n' +
        'ולאחריה 3 עד 5 שורות ניתוח, כל אחת מתחילה ב"ניתוח:". כלל מחייב: כל שורת ניתוח חייבת להתבסס על נתון ספציפי שמופיע בתמונה ולצטט אותו במפורש — שם הסקטור והאחוז/הסכום המדויק שלו (למשל: "ניתוח: כניסה של 12.86% למוליכים למחצה לצד יציאה של 20.12% מהסקטור הרחב מצביעה על מיקוד ביצרני שבבים מובילים"). אסור לכתוב משפט כללי שאינו צמוד למספר קונקרטי מהתמונה. הסבר מדוע סביר שהכסף זורם כך: רוטציה סקטוריאלית, מצב מאקרו (ריבית/אינפלציה/צמיחה), דפנסיבי מול מחזורי, מומנטום או עונתיות. אם ידוע על אירוע ספציפי שתומך בתנועה (החלטת ריבית של הפד, דוח תעסוקה/אינפלציה, דוחות כספיים, אירוע גאופוליטי) — ציין זאת באחת השורות וקשר אותו לנתון. בסס אך ורק על מה שנראה בתמונה ועל קשר כלכלי הגיוני — אל תמציא מספרים שלא מופיעים. כתוב עברית תקנית; טיקרים באנגלית (כמו XLE, SPY) השאר באנגלית במקומם הטבעי במשפט.' + HEB_QUALITY,
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
    out = out.replace(/בעיקבות/g, 'בעקבות');   // (no \b — JS word boundaries don't apply to Hebrew)
    // "משביח/משביחה את X" (improving a product/model/service) is wrong → "משדרג/משפר".
    out = out.replace(/משביח(ה|ים|ות|)(\s+את)/g,
        (m, suf, tail) => ({ '': 'משדרג', 'ה': 'משדרגת', 'ים': 'משדרגים', 'ות': 'משדרגות' }[suf] || 'משדרג') + tail);
    // A funding round AT a valuation is not an IPO: "הונפקה ... לפי שווי" → "גייסה הון לפי שווי".
    out = out.replace(/הונפק(ה|ו|)\s+((?:\S+\s+){0,3}?)לפי\s+שווי/g, 'גייסה הון $2לפי שווי');
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

    // mode=swot — text-only report SWOT + strategy (Hebrew). Delegated to a shared lib
    // so the reports page reuses this Gemini function instead of needing its own (the
    // project is at the Vercel 12-function cap). Accepts POST body or ?context= JSON.
    if (req.query.mode === 'swot') {
        try {
            const { generateSwot } = require('../lib/report-ai.js');
            let d = {};
            if (req.method === 'POST') {
                d = (typeof req.body === 'object' && req.body) ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
            } else {
                d = { symbol: req.query.symbol, company: req.query.company, sector: req.query.sector };
                if (req.query.context) { try { d.context = JSON.parse(req.query.context); } catch (e) { d.context = {}; } }
            }
            const symbol = String(d.symbol || '').trim().toUpperCase();
            if (!symbol) { res.status(400).json({ error: 'symbol required' }); return; }
            const memoKey = `swot:${symbol}`;
            if (_memo.has(memoKey)) {
                res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
                res.status(200).json({ ..._memo.get(memoKey), cached: true });
                return;
            }
            const result = await generateSwot(d, KEY, MODELS);
            _memo.set(memoKey, result);
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
            res.status(200).json(result);
        } catch (e) {
            res.setHeader('Cache-Control', 's-maxage=60');
            res.status(502).json({ error: 'ai_failed', message: e.message });
        }
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
