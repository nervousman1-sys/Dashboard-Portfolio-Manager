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
    headlines: 'התמונה מכילה עדכון חדשות כלכלי. קרא את הכותרות בקפידה רבה, מילה-אחר-מילה, ושחזר כל כותרת במדויק. תהליך חובה לכל כותרת: (1) קרא אות-אחר-אות את הטקסט בתמונה; (2) הסר מילים כפולות שנוצרו בטעות-קריאה (למשל "נפט ראשון נפט ראשון" → "נפט ראשון"); (3) תקן מילה משובשת למילה ההגיונית והנכונה לפי הקשר החדשות (שם מקום/חברה/מונח אמיתי — למשל "בחיפה" ולא "בחזרה"); (4) ודא שהכותרת הסופית היא משפט חדשותי שלם, תקין דקדוקית ובעל-משמעות שעיתונאי כלכלי היה מפרסם. אם קטע מסוים אינו קריא בוודאות — נסח את הכותרת מחדש כך שתהיה קוהרנטית, ואל תכלול רצף-מילים חסר-פשר. קרא אך ורק את כותרות החדשות עצמן (לא סיכום שווקים, מדדים, סחורות, קריפטו או מחירים). שמור על העובדות, המספרים והשמות בדיוק. אם יש חלוקה לקטגוריות (ישראל / עולם) — כתוב שורת כותרת "ישראל:" או "עולם:" לפני הכותרות של אותה קטגוריה. כל כותרת בשורה נפרדת, ללא מספור, ללא מירכאות וללא תוספות משלך.' + HEB_QUALITY,
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

// Shared text→JSON Gemini call with optional Google-Search grounding (for real/current facts).
// Grounding can't be combined with responseMimeType:json, so we ask for JSON in the prompt and
// extract the first {...}. Multi-model fallback dodges single-model 429s.
async function _geminiGroundedJson(prompt, key, models, grounded, temperature, maxTokens) {
    const base = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: (temperature != null ? temperature : 0.3), maxOutputTokens: (maxTokens || 1400), thinkingConfig: { thinkingBudget: 0 } },
    };
    if (grounded) base.tools = [{ google_search: {} }];
    const payload = JSON.stringify(base);
    let lastErr = '', quotaHit = false;
    for (const model of models) {
        if (quotaHit) break; // 429 = shared free-tier quota is out; more requests just waste it
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
                });
                if (!gr.ok) {
                    lastErr = `gemini(${model}) ${gr.status}`;
                    if (gr.status === 429) { quotaHit = true; break; }          // quota — stop entirely
                    if (gr.status === 503 && attempt === 0) { await new Promise(r => setTimeout(r, 700)); continue; } // transient — retry once
                    break;                                                       // other error — next model
                }
                const gj = await gr.json();
                let txt = (((gj.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('').trim() || '';
                txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
                const mm = txt.match(/\{[\s\S]*\}/);
                if (mm) { try { return JSON.parse(mm[0]); } catch (e) { lastErr = 'parse'; } }
                else lastErr = `empty ${model}`;
                break;
            } catch (e) { lastErr = e.message; break; }
        }
    }
    throw new Error(lastErr || 'no_model');
}

// Recent REAL English news headlines for a ticker (Finnhub company-news → Yahoo search fallback).
// This is the factual grounding the earnings-reaction analysis reasons over (Google-Search
// grounding isn't available on this key, so we feed the model real sources instead).
async function _recentNews(ticker, n) {
    const FH = process.env.FINNHUB_API_KEY || 'd6ji4k9r01qkvh5q0aa0d6ji4k9r01qkvh5q0aag';
    const ymd = d => new Date(d).toISOString().slice(0, 10);
    try {
        const to = Date.now(), from = to - 12 * 86400000;
        const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${ymd(from)}&to=${ymd(to)}&token=${FH}`, { headers: { Accept: 'application/json' } });
        if (r.ok) { const arr = await r.json(); if (Array.isArray(arr) && arr.length) { arr.sort((a, b) => (b.datetime || 0) - (a.datetime || 0)); const out = arr.filter(x => x && x.headline).slice(0, n).map(x => `${ymd((x.datetime || 0) * 1000)}: ${x.headline}`); if (out.length) return out; } }
    } catch (e) { }
    try {
        const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${n}&quotesCount=0`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (r.ok) { const j = await r.json(); const a = (j && j.news) || []; return a.filter(x => x && x.title).slice(0, n).map(x => `${x.providerPublishTime ? ymd(x.providerPublishTime * 1000) : ''}: ${x.title}`); }
    } catch (e) { }
    return [];
}
// The REAL price move since the report date (daily closes) — the reaction magnitude.
async function _priceMoveSince(ticker, reportDate) {
    try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        if (!res) return null;
        const ts = res.timestamp || [], cl = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
        const pts = ts.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: cl[i] })).filter(p => p.c != null);
        if (pts.length < 2) return null;
        const latest = pts[pts.length - 1];
        let base = null; const rd = String(reportDate || '').slice(0, 10);
        for (const p of pts) { if (rd && p.d <= rd) base = p; }
        if (!base) base = pts[Math.max(0, pts.length - 2)];
        if (base.c === latest.c) return null;
        const pct = (latest.c - base.c) / base.c * 100;
        return { basePrice: +base.c.toFixed(2), latestPrice: +latest.c.toFixed(2), pct: +pct.toFixed(2), baseDate: base.d, latestDate: latest.d };
    } catch (e) { return null; }
}

// Best-effort fetch of an article's readable text (og/meta description + paragraphs) so the
// "פירוט" summary is of the ARTICLE, not just the headline. Google-News links point to a heavy
// JS viewer that hides the source; we try to pull the real article URL out of it and fetch that.
// Returns '' when nothing usable is found (the caller then falls back to a headline briefing).
async function _fetchArticleText(url) {
    if (!url) return '';
    const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'en,he;q=0.8' };
    const extract = (html) => {
        if (!html) return '';
        const meta = (re) => { const m = html.match(re); return m ? m[1] : ''; };
        const og = meta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{40,})["']/i)
            || meta(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{40,})["']/i)
            || meta(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{40,})["']/i);
        const ps = [...html.matchAll(/<p[^>]*>([\s\S]{40,}?)<\/p>/gi)]
            .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim())
            .filter(t => t.length > 60 && /[A-Za-z֐-׿]/.test(t) && !/cookie|subscribe|sign in|advertisement|©|all rights reserved/i.test(t));
        return [og, ps.slice(0, 14).join('\n')].filter(Boolean).join('\n').slice(0, 4200);
    };
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 8000);
    try {
        const r = await fetch(url, { headers: UA, redirect: 'follow', signal: ac.signal });
        const html = await r.text();
        if (/news\.google\.com/.test(r.url || url)) {
            const cand = [...html.matchAll(/https?:\/\/[^"'\\ )]+/g)].map(m => m[0])
                .filter(u => !/google|gstatic|ggpht|schema\.org|w3\.org|youtube|googleapis|googleusercontent/i.test(u) && /\.[a-z]{2,6}\//.test(u) && u.length < 300);
            const real = cand.find(u => /\/(20\d\d|news|article|story|world|business|politics|market|econom|opinion)/i.test(u)) || cand[0];
            if (real) { try { const r2 = await fetch(real, { headers: UA, redirect: 'follow', signal: ac.signal }); const t2 = extract(await r2.text()); if (t2.length > 220) return t2; } catch (e) { } }
            return extract(html);
        }
        return extract(html);
    } catch (e) { return ''; } finally { clearTimeout(timer); }
}

// Deterministic reaction analysis from the REAL facts (price move + beat/miss + headlines).
// Used when Gemini is unavailable (429/503) so the panel ALWAYS shows a useful, honest analysis
// instead of an error — the user asked that the analysis always appear.
function _reactionFallback(nm, epsA, epsE, sp, move, news) {
    const hasEps = epsA != null && epsE != null;
    const dir = move ? (move.pct >= 0 ? 'עלתה' : 'ירדה') : null;
    const move_he = move
        ? `מניית ${nm} ${dir} ב-${Math.abs(move.pct).toFixed(1)}% מאז פרסום הדוח (מ-$${move.basePrice} ל-$${move.latestPrice}).`
        : 'תנועת המחיר המדויקת אינה זמינה כרגע.';
    let why_he = '';
    if (move && sp != null) {
        if (sp >= 0 && move.pct < 0) why_he = `למרות ש${nm} היכתה את תחזית הרווח${hasEps ? ` (EPS $${epsA} מול צפי $${epsE})` : ''}, המניה ירדה — סימן שהשוק הגיב לגורם מעבר לשורת הרווח, ככל הנראה התחזית קדימה (guidance) או מדדים תפעוליים בדוח ובשיחת המשקיעים.`;
        else if (sp < 0 && move.pct < 0) why_he = `${nm} פספסה את תחזית הרווח${hasEps ? ` (EPS $${epsA} מול צפי $${epsE})` : ''}, והמניה ירדה בהתאם.`;
        else if (move.pct >= 0) why_he = `${nm} ${sp >= 0 ? 'היכתה את תחזית הרווח' : 'פרסמה דוח'}, והמניה הגיבה בעלייה — השוק קיבל את התוצאות בחיוב.`;
    } else if (move) { why_he = `${nm} ${dir} לאחר פרסום הדוח.`; }
    if (news && news.length) {
        const heads = news.slice(0, 3).map(h => h.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '').trim()).filter(Boolean);
        if (heads.length) why_he += (why_he ? ' ' : '') + 'כותרות אחרונות סביב הדוח: ' + heads.join(' · ') + '.';
    }
    const sentiment_he = move
        ? (move.pct >= 0 ? 'הסנטימנט חיובי — השוק תגמל את התוצאות.' : 'הסנטימנט שלילי — המשקיעים הגיבו בירידה למרות/בעקבות הדוח.')
        : '';
    return { move_he, why_he: why_he || 'ראה את תנועת המחיר והכותרות למעלה.', sentiment_he };
}

// ── AI Trading Agent — natural-language → structured StrategyRule ─────────────────────────────
const _STRAT_TRIGGERS = ['NEWS_SENTIMENT', 'MACRO_EVENT', 'PRICE_LEVEL', 'EARNINGS_BEAT', 'TECHNICAL_INDICATOR'];
const _STRAT_ACTIONS = ['BUY', 'SELL', 'ALERT_ONLY'];
const _STRAT_OPS = ['ABOVE', 'BELOW', 'CROSSES_ABOVE', 'CROSSES_BELOW', 'GTE', 'LTE', 'EQUALS', 'CONTAINS'];
const _STRAT_AMT = ['SHARES', 'CASH_USD', 'PORTFOLIO_PCT'];

function _strategyPrompt(text) {
    return [
        'אתה מנוע פענוח אסטרטגיות מסחר. קבל הוראת מסחר בשפה טבעית (עברית או אנגלית) והחזר אך ורק אובייקט JSON תקין (ללא ``` וללא טקסט נוסף) לפי הסכמה הבאה:',
        '{',
        '  "name": "שם קצר בעברית לאסטרטגיה",',
        '  "trigger_type": "אחד מ: NEWS_SENTIMENT | MACRO_EVENT | PRICE_LEVEL | EARNINGS_BEAT | TECHNICAL_INDICATOR (הסוג הדומיננטי)",',
        '  "logic": "ANY אם מספיק שתנאי אחד יתקיים (או/OR), ALL אם צריך שכולם יתקיימו (וגם/AND)",',
        '  "conditions": [ { "factor": "price|rsi|ma|eps_surprise|news|macro", "subject": "טיקר או ישות/מדד (USO, NVDA, נפט, Iran, Trump)", "keyword": "מילות מפתח לחדשות מופרדות בפסיק, או null", "operator": "אחד מ: ABOVE|BELOW|CROSSES_ABOVE|CROSSES_BELOW|GTE|LTE|EQUALS|CONTAINS", "threshold": מספר או null, "timeframe": "4h|daily|weekly או null" } ],',
        '  "action": "BUY | SELL | ALERT_ONLY",',
        '  "target_asset": "הטיקר לפעולה, למשל USO או NVDA",',
        '  "amount": { "type": "SHARES | CASH_USD | PORTFOLIO_PCT", "value": מספר },',
        '  "risk_limits": { "stop_loss_pct": מספר או null, "max_slippage_pct": מספר או null, "max_portfolio_pct": מספר או null }',
        '}',
        'כללים: (1) המר סכום דולרי ל-CASH_USD, מספר מניות ל-SHARES, ואחוז מהתיק ל-PORTFOLIO_PCT. (2) "מתחת ל-$70" → operator BELOW, threshold 70. (3) "RSI מעל 80" → factor rsi, operator ABOVE, threshold 80. (4) "הפתעת EPS מעל 10%" → factor eps_surprise, operator ABOVE, threshold 10. (5) אמירה של דמות/מדינה בחדשות → factor news, subject הישות, keyword המילים, operator CONTAINS. (6) אם אין target_asset מפורש אך יש טיקר בתנאי — השתמש בו. (7) ברירת מחדל ל-action כשלא מצוין: ALERT_ONLY.',
        'דוגמאות:',
        'קלט: "אם טראמפ או גורם רשמי מפרסם אמירה על איראן, או אם הנפט יורד מתחת ל-70 דולר, תקנה USO ב-500 דולר" → {"name":"נפט על מתיחות/מחיר","trigger_type":"NEWS_SENTIMENT","logic":"ANY","conditions":[{"factor":"news","subject":"Iran","keyword":"Iran,Trump,איראן,טראמפ","operator":"CONTAINS","threshold":null,"timeframe":null},{"factor":"price","subject":"USO","operator":"BELOW","threshold":70,"timeframe":null,"keyword":null}],"action":"BUY","target_asset":"USO","amount":{"type":"CASH_USD","value":500},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "ברגע שחברה מפרסמת דוח עם הפתעת EPS מעל 10%, תבצע קניית שוק של 5 מניות" → {"name":"קנייה על הפתעת רווח","trigger_type":"EARNINGS_BEAT","logic":"ALL","conditions":[{"factor":"eps_surprise","subject":null,"keyword":null,"operator":"ABOVE","threshold":10,"timeframe":null}],"action":"BUY","target_asset":null,"amount":{"type":"SHARES","value":5},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "מכור 50% מהאחזקה שלי ב-NVDA אם ה-RSI עולה מעל 80 בגרף 4 שעות" → {"name":"מימוש NVDA על RSI","trigger_type":"TECHNICAL_INDICATOR","logic":"ALL","conditions":[{"factor":"rsi","subject":"NVDA","operator":"ABOVE","threshold":80,"timeframe":"4h","keyword":null}],"action":"SELL","target_asset":"NVDA","amount":{"type":"PORTFOLIO_PCT","value":50},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        '',
        `ההוראה לפענוח: "${text}"`,
    ].join('\n');
}

function _normalizeStrategy(r) {
    if (!r || typeof r !== 'object') return null;
    const up = (s) => String(s || '').trim().toUpperCase();
    const trigger = _STRAT_TRIGGERS.includes(up(r.trigger_type)) ? up(r.trigger_type) : null;
    let conditions = Array.isArray(r.conditions) ? r.conditions : [];
    conditions = conditions.map(c => c && typeof c === 'object' ? {
        factor: String(c.factor || '').toLowerCase().trim() || 'price',
        subject: c.subject != null ? String(c.subject).trim() : null,
        keyword: c.keyword != null && c.keyword !== '' ? String(c.keyword).trim() : null,
        operator: _STRAT_OPS.includes(up(c.operator)) ? up(c.operator) : (c.keyword ? 'CONTAINS' : 'BELOW'),
        threshold: (c.threshold != null && c.threshold !== '' && isFinite(+c.threshold)) ? +c.threshold : (c.threshold != null ? String(c.threshold) : null),
        timeframe: c.timeframe ? String(c.timeframe).toLowerCase().trim() : null,
    } : null).filter(Boolean);
    if (!conditions.length) return null;
    const action = _STRAT_ACTIONS.includes(up(r.action)) ? up(r.action) : 'ALERT_ONLY';
    const amt = (r.amount && typeof r.amount === 'object') ? r.amount : {};
    const amount = { type: _STRAT_AMT.includes(up(amt.type)) ? up(amt.type) : 'CASH_USD', value: isFinite(+amt.value) ? +amt.value : 0 };
    const rl = (r.risk_limits && typeof r.risk_limits === 'object') ? r.risk_limits : {};
    const num = (v) => (v != null && v !== '' && isFinite(+v)) ? +v : null;
    // target_asset: explicit, else the first condition subject that looks like a ticker
    let target = r.target_asset ? up(r.target_asset).replace(/[^A-Z0-9.\-]/g, '') : '';
    if (!target) { const t = conditions.find(c => c.subject && /^[A-Za-z.\-]{1,6}$/.test(c.subject)); if (t) target = up(t.subject); }
    return {
        name: (r.name ? String(r.name).trim() : '') || 'אסטרטגיה',
        trigger_type: trigger || (conditions.some(c => c.factor === 'rsi' || c.factor === 'ma') ? 'TECHNICAL_INDICATOR' : conditions.some(c => c.factor === 'eps_surprise') ? 'EARNINGS_BEAT' : conditions.some(c => c.factor === 'news') ? 'NEWS_SENTIMENT' : 'PRICE_LEVEL'),
        logic: up(r.logic) === 'ALL' ? 'ALL' : 'ANY',
        conditions, action, target_asset: target || null, amount,
        risk_limits: { stop_loss_pct: num(rl.stop_loss_pct), max_slippage_pct: num(rl.max_slippage_pct), max_portfolio_pct: num(rl.max_portfolio_pct) },
    };
}

// Deterministic heuristic parser — used when Gemini is unavailable (429). Best-effort; the rule
// is flagged needs_review so the user can confirm/adjust in the Strategy Card.
function _strategyFallback(text) {
    const t = ' ' + String(text || '') + ' ';
    const tickers = (t.match(/\b(USO|NVDA|SPY|QQQ|GLD|TLT|IEF|AAPL|MSFT|AMD|META|TSLA|AMZN|GOOGL|NFLX)\b/gi) || []).map(s => s.toUpperCase());
    const conditions = [];
    let mPrice = t.match(/(?:מתחת|below|under|קטן).{0,12}?\$?\s*(\d+(?:\.\d+)?)/i) || t.match(/\$\s*(\d+(?:\.\d+)?)/);
    let mAbovePrice = t.match(/(?:מעל|above|over|גדול).{0,12}?\$?\s*(\d+(?:\.\d+)?)/i);
    const mRsi = t.match(/rsi.{0,18}?(\d{1,3})|(\d{1,3}).{0,10}?rsi/i);
    const mEps = t.match(/(?:eps|רווח|הפתעה).{0,20}?(\d{1,3})\s*%|(\d{1,3})\s*%.{0,14}?(?:eps|רווח|הפתעה)/i);
    if (mRsi) conditions.push({ factor: 'rsi', subject: tickers[0] || null, keyword: null, operator: /מעל|above|over/i.test(t) ? 'ABOVE' : 'BELOW', threshold: +(mRsi[1] || mRsi[2]), timeframe: (t.match(/(\d+)\s*(?:h|hour|שע)/i) ? (t.match(/(\d+)\s*(?:h|hour|שע)/i)[1] + 'h') : null) });
    if (mEps) conditions.push({ factor: 'eps_surprise', subject: null, keyword: null, operator: 'ABOVE', threshold: +(mEps[1] || mEps[2]), timeframe: null });
    if (mPrice && !mRsi && !mEps) conditions.push({ factor: 'price', subject: tickers[0] || null, keyword: null, operator: mAbovePrice ? 'ABOVE' : 'BELOW', threshold: +(mAbovePrice ? mAbovePrice[1] : mPrice[1]), timeframe: null });
    // \b doesn't work around Hebrew — match the words directly (Hebrew has no ASCII word boundary).
    const kw = (t.match(/(Iran|Trump|Israel|Fed|Powell|OPEC|איראן|טראמפ|ישראל|הפד|אופ"ק|נפט|ריבית)/gi) || []);
    if (kw.length) conditions.push({ factor: 'news', subject: kw[0], keyword: [...new Set(kw.map(k => k.trim()))].join(','), operator: 'CONTAINS', threshold: null, timeframe: null });
    if (!conditions.length) return null;
    const action = /(sell|מכור|מכיר|למכור)/i.test(t) ? 'SELL' : /(buy|תקנה|לקנות|קנה|קניי?[הת]|קניה)/i.test(t) ? 'BUY' : 'ALERT_ONLY';
    let amount = { type: 'CASH_USD', value: 0 };
    const mCash = t.match(/\$?\s*(\d+(?:,\d{3})*)\s*(?:דולר|usd|\$)/i);
    const mShares = t.match(/(\d+)\s*(?:מניות|מניה|shares?)/i);
    const mPct = t.match(/(\d{1,3})\s*%/);
    if (mShares) amount = { type: 'SHARES', value: +mShares[1] };
    else if (mPct && action === 'SELL') amount = { type: 'PORTFOLIO_PCT', value: +mPct[1] };
    else if (mCash) amount = { type: 'CASH_USD', value: +mCash[1].replace(/,/g, '') };
    const r = _normalizeStrategy({ name: 'אסטרטגיה (טיוטה)', trigger_type: null, logic: 'ANY', conditions, action, target_asset: tickers[0] || null, amount, risk_limits: {} });
    if (r) r._src = 'fallback';
    return r;
}

function _strategySummaryHe(r) {
    if (!r) return '';
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל', CROSSES_ABOVE: 'חוצה מעלה את', CROSSES_BELOW: 'חוצה מטה את', GTE: '≥', LTE: '≤', EQUALS: 'שווה ל', CONTAINS: 'מזכיר' };
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע נע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'אירוע מאקרו' };
    const conds = (r.conditions || []).map(c => {
        const subj = c.subject ? ` (${c.subject})` : '';
        if (c.factor === 'news') return `אזכור בחדשות של "${c.keyword || c.subject}"`;
        const th = c.threshold != null ? ` ${opHe[c.operator] || c.operator} ${c.threshold}${c.factor === 'eps_surprise' ? '%' : ''}` : '';
        const tf = c.timeframe ? ` [${c.timeframe}]` : '';
        return `${facHe[c.factor] || c.factor}${subj}${th}${tf}`;
    });
    const join = conds.join(r.logic === 'ALL' ? ' וגם ' : ' או ');
    const actHe = r.action === 'BUY' ? 'קנייה' : r.action === 'SELL' ? 'מכירה' : 'התראה בלבד';
    const amtHe = r.action === 'ALERT_ONLY' ? '' : (r.amount.type === 'SHARES' ? `${r.amount.value} מניות` : r.amount.type === 'PORTFOLIO_PCT' ? `${r.amount.value}% מהאחזקה` : `$${r.amount.value}`);
    const tgt = r.target_asset ? ` ${r.target_asset}` : '';
    return `אם ${join} → ${actHe}${amtHe ? ' ' + amtHe : ''}${tgt}`;
}

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

    // mode=filing — deep Hebrew analysis of a SEC 8-K press release: the material points + the
    // implications for the investor. POST body { ticker, company, category, headline, body }.
    // Multi-model fallback dodges single-model 429s. Memoized per (ticker + headline).
    if (req.query.mode === 'filing') {
        try {
            let d = {};
            if (req.method === 'POST') d = (typeof req.body === 'object' && req.body) ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
            else { d = { ticker: req.query.ticker, company: req.query.company, category: req.query.category, headline: req.query.headline, body: req.query.body }; }
            const ticker = String(d.ticker || '').trim().toUpperCase();
            const body = String(d.body || '').slice(0, 4500);
            if (!ticker || !body) { res.status(400).json({ error: 'ticker_and_body_required' }); return; }

            const memoKey = `filing:${ticker}:${String(d.headline || '').slice(0, 70)}:${body.length}`;
            if (_memo.has(memoKey)) {
                res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
                res.status(200).json({ ..._memo.get(memoKey), cached: true });
                return;
            }

            const prompt = [
                'אתה אנליסט אקוויטי בכיר. לפניך הודעה לעיתונות / דיווח 8-K שחברה נסחרת הגישה לרשות ניירות ערך האמריקאית (SEC).',
                'קרא אותו והחזר JSON בלבד, בעברית מקצועית וברורה, ללא הקדמות.',
                `חברה: ${String(d.company || ticker)} (${ticker}) | קטגוריה: ${String(d.category || '')}`,
                `כותרת: ${String(d.headline || '')}`,
                `טקסט הדיווח: ${body}`,
                '',
                'מבנה ה-JSON:',
                '{',
                '  "summary_he": "משפט אחד שמסכם מה קרה (TL;DR)",',
                '  "points_he": ["3-5 נקודות מהותיות קצרות וקונקרטיות מתוך הדיווח — כולל מספרים/שמות/תאריכים אם קיימים"],',
                '  "implications_he": "2-4 משפטים: מה ההשלכות של הדיווח על החברה ועל המניה — חיובי/שלילי, טווח קצר מול ארוך, וסיכונים/הזדמנויות עיקריים"',
                '}',
            ].join('\n');

            const payload = JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } },
            });

            let out = null, lastErr = '';
            for (const model of MODELS) {
                const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
                });
                if (!gr.ok) { lastErr = `gemini(${model}) ${gr.status}`; continue; }
                const gj = await gr.json();
                const txt = (((gj.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('').trim() || '';
                try { out = JSON.parse(txt); } catch (e) { out = null; }
                if (out) break;
            }
            if (!out || typeof out !== 'object') throw new Error(lastErr || 'no_model_returned');

            const result = {
                summary_he: String(out.summary_he || '').trim(),
                points_he: Array.isArray(out.points_he) ? out.points_he.map(s => String(s).trim()).filter(Boolean).slice(0, 6) : [],
                implications_he: String(out.implications_he || '').trim(),
            };
            _memo.set(memoKey, result);
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
            res.status(200).json(result);
        } catch (e) {
            res.setHeader('Cache-Control', 's-maxage=60');
            res.status(502).json({ error: 'ai_failed', message: e.message });
        }
        return;
    }

    // mode=reaction — WHY a stock moved after its earnings report + investor sentiment. Uses Gemini
    // with Google-Search grounding so the "why" is REAL/current (guidance, results, call, sentiment),
    // not the model's stale training. POST { ticker, company, epsActual, epsEstimate, surprisePct, reportDate }.
    if (req.query.mode === 'reaction') {
        try {
            let d = {};
            if (req.method === 'POST') d = (typeof req.body === 'object' && req.body) ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
            else d = { ticker: req.query.ticker, company: req.query.company, epsActual: req.query.epsActual, epsEstimate: req.query.epsEstimate, surprisePct: req.query.surprisePct, reportDate: req.query.reportDate };
            const ticker = String(d.ticker || '').trim().toUpperCase();
            if (!ticker) { res.status(400).json({ error: 'ticker required' }); return; }
            const memoKey = `reaction:${ticker}:${String(d.reportDate || '')}`;
            if (_memo.has(memoKey)) { res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400'); res.status(200).json({ ..._memo.get(memoKey), cached: true }); return; }
            const epsA = d.epsActual != null && d.epsActual !== '' ? Number(d.epsActual) : null;
            const epsE = d.epsEstimate != null && d.epsEstimate !== '' ? Number(d.epsEstimate) : null;
            const sp = d.surprisePct != null && d.surprisePct !== '' ? Number(d.surprisePct) : null;
            const beatTxt = (sp != null) ? (sp >= 0 ? `היכתה את תחזית הרווח ב-${sp.toFixed(2)}%` : `פספסה את תחזית הרווח ב-${Math.abs(sp).toFixed(2)}%`) : 'פרסמה דוח';
            // Ground the analysis in REAL data: recent headlines + the actual price move since the report.
            const [news, move] = await Promise.all([
                _recentNews(ticker, 9),
                d.reportDate ? _priceMoveSince(ticker, d.reportDate) : Promise.resolve(null),
            ]);
            const facts = [
                (epsA != null && epsE != null) ? `רווח למניה (EPS) בפועל: $${epsA} מול צפי $${epsE} — ${beatTxt}.` : beatTxt + '.',
                move ? `שינוי מחיר בפועל מתאריך הדוח (${move.baseDate}) ועד היום (${move.latestDate}): ${move.pct >= 0 ? '+' : ''}${move.pct}% — מ-$${move.basePrice} ל-$${move.latestPrice}.` : '',
                news.length ? ('כותרות חדשות אמיתיות סביב הדוח (מקורות: Finnhub/Yahoo):\n' + news.map(h => '• ' + h).join('\n')) : '',
            ].filter(Boolean).join('\n');
            const prompt = [
                `אתה אנליסט אקוויטי בכיר. לפניך נתונים אמיתיים על ${String(d.company || ticker)} (${ticker}) שפרסמה דוח רבעוני${d.reportDate ? ' בתאריך ' + d.reportDate : ' לאחרונה'}:`,
                facts,
                '',
                'נתח אך ורק על סמך הנתונים והכותרות שלמעלה. ענה בעברית מקצועית וברורה והחזר JSON בלבד (ללא ``` וללא טקסט נוסף):',
                '{',
                '  "move_he": "משפט אחד: תנועת המחיר בפועל (מהנתון שלמעלה) והכיוון; אם הכותרות מזכירות מסחר מאוחר/מוקדם (after-hours/pre-market) — ציין זאת.",',
                '  "why_he": "2-4 משפטים: הסיבה לתנועה לפי הכותרות והתוצאות — תחזית קדימה (guidance), הכנסות/מרווחים/מנויים, שיחת המשקיעים או גורם אחר. צטט/הישען על הכותרות והיה ספציפי.",',
                '  "sentiment_he": "1-2 משפטים: הסנטימנט של המשקיעים והדעה הרווחת הנגזרים מהכותרות ומכיוון התנועה."',
                '}',
                'אם עקפה את הרווח אך המניה ירדה — הסבר את הפער (למשל תחזית מאכזבת). בסס אך ורק על הנתונים והכותרות שסופקו; אל תמציא מספרים או עובדות. אם חסר מידע לסעיף — כתוב זאת בקצרה.',
            ].join('\n');
            let out = null, usedFallback = false;
            try { out = await _geminiGroundedJson(prompt, KEY, MODELS, false); } catch (e) { out = null; }
            if (!out || typeof out !== 'object' || (!out.why_he && !out.move_he)) {
                out = _reactionFallback(String(d.company || ticker), epsA, epsE, sp, move, news);
                usedFallback = true;
            }
            const result = { move_he: fixHebrew(String(out.move_he || '').trim()), why_he: fixHebrew(String(out.why_he || '').trim()), sentiment_he: fixHebrew(String(out.sentiment_he || '').trim()) };
            if (!usedFallback) {
                _memo.set(memoKey, result); // cache only genuine AI results — a fallback should retry Gemini next time
                res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
            } else {
                res.setHeader('Cache-Control', 's-maxage=60'); // short → the next click can reach a recovered Gemini
            }
            res.status(200).json(result);
        } catch (e) {
            res.setHeader('Cache-Control', 's-maxage=60');
            res.status(502).json({ error: 'ai_failed', message: e.message });
        }
        return;
    }

    // mode=news-summary — take a macro/geopolitics headline and return a short Hebrew briefing:
    // what the article is about + the takeaway. Google-Search grounded so it reflects the real story.
    // POST { headline, headline_en, source, url, date }.
    if (req.query.mode === 'news-summary') {
        try {
            let d = {};
            if (req.method === 'POST') d = (typeof req.body === 'object' && req.body) ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
            else d = { headline: req.query.headline, source: req.query.source, url: req.query.url, date: req.query.date };
            const headline = String(d.headline || d.headline_en || '').trim();
            if (!headline) { res.status(400).json({ error: 'headline required' }); return; }
            const memoKey = `news2:${headline.slice(0, 90)}`;
            if (_memo.has(memoKey)) { res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800'); res.status(200).json({ ..._memo.get(memoKey), cached: true }); return; }
            // Try to read the ACTUAL article so we summarize its content, not just the headline.
            const article = await _fetchArticleText(d.url);
            const haveArticle = article && article.length > 240;
            let prompt;
            if (haveArticle) {
                prompt = [
                    'אתה עורך חדשות כלכלי-פיננסי ישראלי בכיר. לפניך תוכן/תמצית של כתבה. סכם את הכתבה בעברית עיתונאית ברורה וזורמת, ב-2 עד 4 פסקאות קצרות:',
                    'פסקה 1 — מה קרה (העיקר). פסקה 2 — הרקע וההקשר / הנתונים המרכזיים. פסקה 3 (אם יש) — התגובות/ההשלכות. הסתמך אך ורק על התוכן שסופק, אל תמציא מספרים או שמות.',
                    `כותרת: "${headline}"`,
                    d.source ? `מקור: ${String(d.source).trim()}` : '',
                    'תוכן הכתבה:',
                    article,
                    '',
                    'החזר JSON בלבד (ללא ``` וללא טקסט נוסף): { "summary_he": "2-4 פסקאות, מופרדות בשורה ריקה בין פסקה לפסקה", "conclusion_he": "משפט אחד — ההשלכה למשקיעים/לשווקים" }',
                ].filter(Boolean).join('\n');
            } else {
                // Article not reachable (Google-News link / paywall) → a fuller, clear briefing on the topic.
                prompt = [
                    'אתה עורך חדשות כלכלי-פיננסי ישראלי בכיר. הסבר בעברית ברורה ומקיפה את הידיעה שלפניך, ב-2 עד 3 פסקאות: פסקה על מה קרה לפי הכותרת, פסקה על הרקע וההקשר הכלכלי של הנושא/הגופים/המונחים, ופסקה על ההשלכות.',
                    `הכותרת (עברית): "${headline}"`,
                    d.headline_en ? `הכותרת (אנגלית, המקור): "${String(d.headline_en).trim()}"` : '',
                    d.source ? `מקור: ${String(d.source).trim()}` : '',
                    'הישאר צמוד לנושא הכותרת; אל תחליף נושא ואל תמציא מספרים/שמות שאינם בה. אם ראשי-תיבות בכותרת אינם חד-משמעיים — ציין זאת במקום לנחש.',
                    'החזר JSON בלבד (ללא ``` וללא טקסט נוסף): { "summary_he": "2-3 פסקאות, מופרדות בשורה ריקה", "conclusion_he": "משפט אחד — ההשלכה למשקיעים/לשווקים" }',
                ].filter(Boolean).join('\n');
            }
            let out = await _geminiGroundedJson(prompt, KEY, MODELS, false, haveArticle ? 0.25 : 0.12, 1900);
            if (!out || typeof out !== 'object') throw new Error('no_model_returned');
            const result = { summary_he: fixHebrew(String(out.summary_he || '').trim()), conclusion_he: fixHebrew(String(out.conclusion_he || '').trim()), fromArticle: !!haveArticle };
            _memo.set(memoKey, result);
            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
            res.status(200).json(result);
        } catch (e) {
            res.setHeader('Cache-Control', 's-maxage=60');
            res.status(502).json({ error: 'ai_failed', message: e.message });
        }
        return;
    }

    // mode=strategy — AI Trading Agent: natural-language instruction → structured StrategyRule.
    // Gemini-first with a deterministic heuristic fallback (so it works even when quota is out).
    // POST { text }. Returns { rule, summary_he, source }. NEVER executes anything — parse only.
    if (req.query.mode === 'strategy') {
        try {
            let d = {};
            if (req.method === 'POST') d = (typeof req.body === 'object' && req.body) ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
            else d = { text: req.query.text };
            const text = String(d.text || '').trim();
            if (!text) { res.status(400).json({ error: 'text_required' }); return; }
            if (text.length > 600) { res.status(400).json({ error: 'text_too_long' }); return; }
            const memoKey = `strategy:${text.slice(0, 180)}`;
            if (_memo.has(memoKey)) { res.setHeader('Cache-Control', 's-maxage=3600'); res.status(200).json({ ..._memo.get(memoKey), cached: true }); return; }
            let rule = null;
            try { rule = _normalizeStrategy(await _geminiGroundedJson(_strategyPrompt(text), KEY, MODELS, false, 0.1, 1200)); } catch (e) { rule = null; }
            let source = 'ai';
            if (!rule) { rule = _strategyFallback(text); source = rule ? 'fallback' : 'none'; }
            if (rule && rule._src) { source = rule._src; delete rule._src; }
            if (!rule) { res.setHeader('Cache-Control', 's-maxage=60'); res.status(200).json({ error: 'unparsed', message: 'לא הצלחתי לפענח את ההוראה לאסטרטגיה. נסה לנסח בצורה ברורה יותר (טריגר, פעולה, נכס וסכום).' }); return; }
            const result = { rule, summary_he: _strategySummaryHe(rule), source };
            _memo.set(memoKey, result);
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
            res.status(200).json(result);
        } catch (e) {
            res.setHeader('Cache-Control', 's-maxage=60');
            res.status(502).json({ error: 'parse_failed', message: e.message });
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
            // thinkingBudget: long-output modes (flows/transcribe) keep 0 — with thinking on, long
            // tables came back truncated. But for short outputs (news headlines / summary) a small
            // thinking budget materially improves the OCR reconstruction accuracy (careful word-by-
            // word reading) without any truncation risk.
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: (mode === 'headlines' || mode === 'summary') ? 1536 : 0 } },
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
