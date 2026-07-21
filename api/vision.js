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
// Entity → tradeable Yahoo symbol, so "Bitcoin"/"נפט"/"זהב" resolve to real series the engine can read.
const _STRAT_TICKERS = {
    bitcoin: 'BTC-USD', 'ביטקוין': 'BTC-USD', btc: 'BTC-USD', ethereum: 'ETH-USD', 'אתריום': 'ETH-USD', 'את׳ריום': 'ETH-USD', eth: 'ETH-USD',
    gold: 'GLD', 'זהב': 'GLD', oil: 'USO', 'נפט': 'USO', crude: 'USO', 'ברנט': 'BNO', silver: 'SLV', 'כסף': 'SLV',
    nasdaq: 'QQQ', 'נאסדק': 'QQQ', 'נאסדק100': 'QQQ', 'sp500': 'SPY', 'ספ500': 'SPY', 'sandp': 'SPY', dow: 'DIA', 'דאו': 'DIA', vix: '^VIX', 'תנודתיות': '^VIX',
};
function _resolveTicker(s) {
    if (s == null) return s;
    const k = String(s).trim().toLowerCase().replace(/["״׳'`\s]/g, '');
    if (_STRAT_TICKERS[k]) return _STRAT_TICKERS[k];
    const up = String(s).trim().toUpperCase();
    if (/^[A-Z]{1,6}(-USD|\.TA)?$/.test(up) || /^\^[A-Z]+$/.test(up)) return up;
    return s; // leave as-is (e.g. a news entity like "Iran")
}
const _STRAT_ACTIONS = ['BUY', 'SELL', 'ALERT_ONLY'];
const _STRAT_OPS = ['ABOVE', 'BELOW', 'CROSSES_ABOVE', 'CROSSES_BELOW', 'GTE', 'LTE', 'EQUALS', 'CONTAINS'];
const _STRAT_AMT = ['SHARES', 'CASH_USD', 'PORTFOLIO_PCT'];

// Turn the client's compact platform snapshot into a short Hebrew context block for the LLM, so the
// agent's chat reasons with the SAME real data the user sees (reports, sectors, catalysts, tweets,
// liquidity engine, macro, technicals, and the user's own portfolios). Everything is size-capped.
function _ctxBlockHe(context) {
    if (!context || typeof context !== 'object') return '';
    const L = [];
    const arr = (x) => Array.isArray(x) ? x : [];
    try {
        if (arr(context.portfolios).length) L.push('התיקים של המשתמש: ' + context.portfolios.map(p => `«${p.name}» (${arr(p.holdings).join(', ') || 'ריק'})`).join(' · '));
        if (arr(context.holdings_reports).length) L.push('ציוני דוחות לאחזקות: ' + context.holdings_reports.map(r => `${r.t} ${r.score}${r.up ? '↑' : ''}`).join(', '));
        if (arr(context.technicals).length) L.push('טכני חי לאחזקות (RSI יומי/שבועי, מחיר): ' + context.technicals.map(t => `${t.t} ${t.rsiD ?? '—'}/${t.rsiW ?? '—'} $${t.px ?? '—'}`).join(' · '));
        if (arr(context.top_reports).length) L.push('חברות מובילות לפי דוח (score): ' + context.top_reports.map(r => `${r.t} ${r.score}${r.up ? '↑' : ''}`).join(', '));
        if (arr(context.sectors).length) L.push('חוזק סקטורים (ממוצע score): ' + context.sectors.map(s => `${s.sector} ${s.avg}`).join(' · '));
        if (arr(context.liquidity).length) L.push('מנוע נזילות (LHE) — הטיה/משטר/קונפלואנס: ' + context.liquidity.map(r => `${r.t} ${r.bias}/${r.regime}/${r.conf}`).join(' · '));
        if (arr(context.catalysts).length) L.push('קטליסטים (Early-Alpha): ' + context.catalysts.map(c => `[${c.sector}${c.tickers && c.tickers.length ? ' · ' + c.tickers.join(',') : ''}] ${c.thesis}`).join(' | '));
        if (arr(context.macro).length) L.push('אינדיקטורים מאקרו (ארה"ב): ' + context.macro.map(m => `${m.k}=${m.v}`).join(', '));
        if (arr(context.macro_news).length) L.push('כותרות מאקרו/גאופוליטיקה:\n- ' + context.macro_news.map(h => String(h).slice(0, 140)).join('\n- '));
        if (arr(context.tweets).length) L.push('ציוצים אחרונים ממעקב טוויטר: ' + context.tweets.map(t => `@${t.u}: ${t.txt}`).join(' | '));
    } catch (e) { }
    if (!L.length) return '';
    let block = L.join('\n');
    if (block.length > 5000) block = block.slice(0, 5000);
    return '\n\n== נתוני הפלטפורמה (אמת, עדכני — השתמש בהם כשהם רלוונטיים לבקשה; אל תמציא נתונים שאינם כאן) ==\n' + block + '\n== סוף נתוני הפלטפורמה ==\n';
}

function _strategyPrompt(text, ctxBlock) {
    return [
        'אתה מנוע פענוח אסטרטגיות מסחר. קבל הוראת מסחר בשפה טבעית (עברית או אנגלית) והחזר אך ורק אובייקט JSON תקין (ללא ``` וללא טקסט נוסף) לפי הסכמה הבאה:',
        '{',
        '  "name": "שם קצר בעברית לאסטרטגיה",',
        '  "trigger_type": "אחד מ: NEWS_SENTIMENT | MACRO_EVENT | PRICE_LEVEL | EARNINGS_BEAT | TECHNICAL_INDICATOR (הסוג הדומיננטי)",',
        '  "logic": "ANY אם מספיק שתנאי אחד יתקיים (או/OR), ALL אם צריך שכולם יתקיימו (וגם/AND)",',
        '  "conditions": [ { "factor": "price|rsi|ma|eps_surprise|news|macro", "subject": "הטיקר לניטור. המר ישות לטיקר Yahoo: ביטקוין/Bitcoin→BTC-USD, את׳ריום→ETH-USD, נפט→USO, זהב→GLD, כסף→SLV, נאסדק→QQQ, S&P→SPY. עבור factor=news השאר את שם הישות (Iran, Trump).", "keyword": "מילות מפתח לחדשות מופרדות בפסיק, או null", "operator": "ABOVE|BELOW|CROSSES_ABOVE|CROSSES_BELOW|GTE|LTE|EQUALS|CONTAINS", "threshold": "ערך יעד מספרי (מחיר/RSI/אחוז הפתעה). עבור factor=ma השאר null — הרמה היא הממוצע עצמו.", "period": "רק ל-factor=ma: אורך הממוצע הנע (למשל 200), אחרת null", "timeframe": "4h|daily|weekly או null" } ],',
        '  "action": "BUY | SELL | ALERT_ONLY",',
        '  "target_asset": "הטיקר שעליו מבצעים את הפעולה, למשל USO או NVDA או MSTR",',
        '  "amount": { "type": "SHARES | CASH_USD | PORTFOLIO_PCT", "value": מספר },',
        '  "risk_limits": { "stop_loss_pct": מספר או null, "max_slippage_pct": מספר או null, "max_portfolio_pct": מספר או null }',
        '}',
        'כללים: (1) המר סכום דולרי ל-CASH_USD, מספר מניות ל-SHARES, ואחוז ל-PORTFOLIO_PCT. (2) "מתחת ל-$70" → operator BELOW, threshold 70. (3) "RSI מעל 80" → factor rsi, operator ABOVE, threshold 80. (4) "הפתעת EPS מעל 10%" → factor eps_surprise, operator ABOVE, threshold 10. (5) אמירה של דמות/מדינה בחדשות → factor news, subject הישות, keyword המילים, operator CONTAINS. (6) חשוב מאוד: subject של תנאי הוא הנכס שאותו מנטרים, target_asset הוא הנכס שעליו פועלים — הם יכולים להיות שונים (למשל: מנטרים BTC-USD, קונים MSTR). (7) "ממוצע 200 שבועות" → factor ma, period 200, timeframe weekly, threshold null. (8) חשוב: כשהמחיר "נוגע"/"על"/"touches"/"at" הממוצע (לא מעל ולא מתחת) → operator EQUALS. "חוצה מעלה" → CROSSES_ABOVE, "חוצה מטה" → CROSSES_BELOW. (9) "RSI שבועי" → timeframe weekly; "יומי" → daily; "4 שעות" → 4h. (10) קלוט את כל התנאים המבוקשים — אל תשמיט אף תנאי. logic=ALL כשצריך שכל התנאים יתקיימו ("וגם"/"and"/"כש...ו-"); logic=ANY רק כשכתוב במפורש "או"/"or". (11) ברירת מחדל ל-action כשלא מצוין: ALERT_ONLY. (12) חשוב: אם הקלט אינו חוק אוטומטי קונקרטי אלא שאלה פתוחה, בקשת רעיונות/המלצות למניות, או ניתוח שוק כללי (למשל "אילו מניות מתאימות לתקופה?") — החזר בדיוק {"advice": true} וכלום מלבד זה. (13) סורק מדד (SCREENER): אם המשתמש רוצה שהמערכת תסרוק את *כל המניות* (למשל "כל מניה בנאסד\'ק שעוברת תנאי", או אפילו סתם "כל מניה שעוברת RSI 30" בלי לציין מדד) ותקנה כל אחת שעונה — ולא נכס בודד ולא תעודת סל (QQQ) — הוסף שדה "screener":{"universe":"NDX" לנאסד\'ק או "SP500" ל-S&P — וברירת המחדל היא "NDX" כשלא צוין מדד,"per_stock_usd":הסכום לכל מניה,"total_budget_usd":התקציב הכולל,"split_mode":"fixed" (סכום קבוע לכל מניה — כשצוין סכום למניה) או "equal" (חלוקה שווה של התקציב בין כל המניות התואמות — כשהמשתמש אומר "חלק/מחולק שווה" בלי סכום קבוע למניה)}, קבע trigger_type "SCREENER", target_asset null, action "BUY" (סורק תמיד קונה, אף פעם לא ALERT_ONLY), ו-conditions כתנאי הסינון (למשל rsi weekly below 30). "קונה"/"קונה לי"/"תקנה"/"רכישה" = BUY. "10 אלף דולר"=10000, "50 אלף"=50000. חשוב: כל אמירת "כל מניה ש..." עם תנאי טכני היא SCREENER — לעולם לא TECHNICAL_INDICATOR של נכס בודד.',
        'דוגמאות:',
        'קלט: "אילו מניות רלוונטיות לתקופה הקרובה לפי מאקרו, מצב עולמי ופריצות טכנולוגיות?" → {"advice": true}',
        'קלט: "צור אסטרטגיה שכל מניה בנאסד\'ק שה-RSI השבועי שלה יורד מתחת ל-30 — תקנה אותה ב-10 אלף דולר, עד תקציב כולל של 50 אלף דולר" → {"name":"סורק נאסד\'ק RSI שבועי","trigger_type":"SCREENER","logic":"ALL","conditions":[{"factor":"rsi","subject":null,"keyword":null,"operator":"BELOW","threshold":30,"period":null,"timeframe":"weekly"}],"action":"BUY","target_asset":null,"screener":{"universe":"NDX","per_stock_usd":10000,"total_budget_usd":50000,"split_mode":"fixed"},"amount":{"type":"CASH_USD","value":10000},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "אני רוצה אסטרטגיה שבה אתה קונה לי כל מניה שעוברת את RSI 30 בטיים פריים שבועי, התקציב 50 אלף דולר ו-10 אלף לכל מניה" (בלי לציין מדד) → {"name":"סורק RSI שבועי","trigger_type":"SCREENER","logic":"ALL","conditions":[{"factor":"rsi","subject":null,"keyword":null,"operator":"BELOW","threshold":30,"period":null,"timeframe":"weekly"}],"action":"BUY","target_asset":null,"screener":{"universe":"NDX","per_stock_usd":10000,"total_budget_usd":50000,"split_mode":"fixed"},"amount":{"type":"CASH_USD","value":10000},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "קנה לי את מניית ORCL כשה-RSI השבועי מתחת ל-30 וגם מחיר המניה נוגע בממוצע 300 השבועות" → {"name":"קניית ORCL על RSI וממוצע","trigger_type":"TECHNICAL_INDICATOR","logic":"ALL","conditions":[{"factor":"rsi","subject":"ORCL","keyword":null,"operator":"BELOW","threshold":30,"period":null,"timeframe":"weekly"},{"factor":"ma","subject":"ORCL","keyword":null,"operator":"EQUALS","threshold":null,"period":300,"timeframe":"weekly"}],"action":"BUY","target_asset":"ORCL","amount":{"type":"CASH_USD","value":0},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "אם טראמפ או גורם רשמי מפרסם אמירה על איראן, או אם הנפט יורד מתחת ל-70 דולר, תקנה USO ב-500 דולר" → {"name":"נפט על מתיחות/מחיר","trigger_type":"NEWS_SENTIMENT","logic":"ANY","conditions":[{"factor":"news","subject":"Iran","keyword":"Iran,Trump,איראן,טראמפ","operator":"CONTAINS","threshold":null,"timeframe":null},{"factor":"price","subject":"USO","operator":"BELOW","threshold":70,"timeframe":null,"keyword":null}],"action":"BUY","target_asset":"USO","amount":{"type":"CASH_USD","value":500},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "ברגע שחברה מפרסמת דוח עם הפתעת EPS מעל 10%, תבצע קניית שוק של 5 מניות" → {"name":"קנייה על הפתעת רווח","trigger_type":"EARNINGS_BEAT","logic":"ALL","conditions":[{"factor":"eps_surprise","subject":null,"keyword":null,"operator":"ABOVE","threshold":10,"timeframe":null}],"action":"BUY","target_asset":null,"amount":{"type":"SHARES","value":5},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "מכור 50% מהאחזקה שלי ב-NVDA אם ה-RSI עולה מעל 80 בגרף 4 שעות" → {"name":"מימוש NVDA על RSI","trigger_type":"TECHNICAL_INDICATOR","logic":"ALL","conditions":[{"factor":"rsi","subject":"NVDA","operator":"ABOVE","threshold":80,"period":null,"timeframe":"4h","keyword":null}],"action":"SELL","target_asset":"NVDA","amount":{"type":"PORTFOLIO_PCT","value":50},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        'קלט: "קנה 200 מניות MSTR אם הביטקוין חוצה מעלה את ממוצע 200 השבועות" → {"name":"MSTR על ממוצע 200 שבועות של ביטקוין","trigger_type":"TECHNICAL_INDICATOR","logic":"ALL","conditions":[{"factor":"ma","subject":"BTC-USD","keyword":null,"operator":"CROSSES_ABOVE","threshold":null,"period":200,"timeframe":"weekly"}],"action":"BUY","target_asset":"MSTR","amount":{"type":"SHARES","value":200},"risk_limits":{"stop_loss_pct":null,"max_slippage_pct":null,"max_portfolio_pct":null}}',
        '(14) כשהמשתמש מתייחס לנתוני הפלטפורמה — "האחזקה הכי חלשה שלי", "המניה עם הדוח הכי טוב", "לפי מנוע הנזילות", "הסקטור החזק ביותר" — היעזר בבלוק "נתוני הפלטפורמה" שבהמשך כדי לזהות את הטיקר/הערך המדויק, ובנה את האסטרטגיה עליו.',
        ctxBlock || '',
        '',
        `ההוראה לפענוח: "${text}"`,
    ].join('\n');
}

function _normalizeStrategy(r) {
    if (!r || typeof r !== 'object') return null;
    const up = (s) => String(s || '').trim().toUpperCase();
    const trigger = _STRAT_TRIGGERS.includes(up(r.trigger_type)) ? up(r.trigger_type) : null;
    let conditions = Array.isArray(r.conditions) ? r.conditions : [];
    conditions = conditions.map(c => {
        if (!c || typeof c !== 'object') return null;
        const factor = String(c.factor || '').toLowerCase().trim() || 'price';
        // News/macro keep the raw entity (e.g. "Iran"); price/rsi/ma/eps resolve to a tradeable ticker.
        const rawSubj = c.subject != null ? String(c.subject).trim() : null;
        const subject = (factor === 'news' || factor === 'macro') ? rawSubj : (rawSubj ? _resolveTicker(rawSubj) : null);
        let threshold = (c.threshold != null && c.threshold !== '' && isFinite(+c.threshold)) ? +c.threshold : (c.threshold != null && c.threshold !== '' ? String(c.threshold) : null);
        let period = (c.period != null && c.period !== '' && isFinite(+c.period)) ? Math.round(+c.period) : null;
        // For a moving-average condition the number is the MA length, not a price. If the model put it
        // in threshold (legacy shape), move it to period so the engine computes the real SMA.
        if (factor === 'ma') {
            if (period == null && typeof threshold === 'number') { period = Math.round(threshold); threshold = null; }
            if (period == null) period = 200;
        }
        return {
            factor,
            subject,
            keyword: c.keyword != null && c.keyword !== '' ? String(c.keyword).trim() : null,
            operator: _STRAT_OPS.includes(up(c.operator)) ? up(c.operator) : (c.keyword ? 'CONTAINS' : 'BELOW'),
            threshold,
            period,
            timeframe: c.timeframe ? String(c.timeframe).toLowerCase().trim() : null,
        };
    }).filter(Boolean);
    if (!conditions.length) return null;
    const action = _STRAT_ACTIONS.includes(up(r.action)) ? up(r.action) : 'ALERT_ONLY';
    const amt = (r.amount && typeof r.amount === 'object') ? r.amount : {};
    const amount = { type: _STRAT_AMT.includes(up(amt.type)) ? up(amt.type) : 'CASH_USD', value: isFinite(+amt.value) ? +amt.value : 0 };
    const rl = (r.risk_limits && typeof r.risk_limits === 'object') ? r.risk_limits : {};
    const num = (v) => (v != null && v !== '' && isFinite(+v)) ? +v : null;
    // target_asset: explicit, else the first condition subject that looks like a ticker
    let target = r.target_asset ? up(r.target_asset).replace(/[^A-Z0-9.\-]/g, '') : '';
    if (!target) { const t = conditions.find(c => c.subject && /^[A-Za-z.\-]{1,6}$/.test(c.subject)); if (t) target = up(t.subject); }
    // Screener: scan an ENTIRE index and buy each stock that meets the condition (not the ETF).
    // { universe (NDX=Nasdaq-100 / SP500), per_stock_usd, total_budget_usd }.
    let screener = null;
    if (r.screener && typeof r.screener === 'object') {
        const uni = String(r.screener.universe || '').toUpperCase();
        const universe = /NDX|NASDAQ|נאסד/.test(uni) ? 'NDX' : /SPX|S&P|SP500|SPY|ספ|S&P500/.test(uni) ? 'SP500' : (uni || 'NDX');
        const perStock = num(r.screener.per_stock_usd) || num(r.screener.per_stock && r.screener.per_stock.value) || (amount.type === 'CASH_USD' ? amount.value : 0) || 0;
        const totalBudget = num(r.screener.total_budget_usd) || 0;
        // Division mode: 'fixed' = a set $ per stock (up to the budget); 'equal' = split the total
        // budget equally across all matching stocks. Explicit split_mode wins; else infer from inputs.
        const sm = String(r.screener.split_mode || '').toLowerCase();
        const splitMode = (sm === 'equal' || sm === 'split') ? 'equal' : (sm === 'fixed' || sm === 'per_stock') ? 'fixed' : (perStock > 0 ? 'fixed' : (totalBudget > 0 ? 'equal' : 'fixed'));
        // Keep the screener whenever a real universe is named — even with no budget yet — so the card can
        // render its (editable) allocation fields. Drops only a truly empty {} with no universe/budget.
        const hasUni = /NDX|NASDAQ|נאסד|SPX|S&P|SP500|SPY|ספ/.test(uni);
        if (perStock > 0 || totalBudget > 0 || hasUni) screener = { universe, per_stock_usd: perStock, total_budget_usd: totalBudget, split_mode: splitMode };
    }
    return {
        name: (r.name ? String(r.name).trim() : '') || 'אסטרטגיה',
        trigger_type: screener ? 'SCREENER' : (trigger || (conditions.some(c => c.factor === 'rsi' || c.factor === 'ma') ? 'TECHNICAL_INDICATOR' : conditions.some(c => c.factor === 'eps_surprise') ? 'EARNINGS_BEAT' : conditions.some(c => c.factor === 'news') ? 'NEWS_SENTIMENT' : 'PRICE_LEVEL')),
        logic: up(r.logic) === 'ALL' ? 'ALL' : 'ANY',
        conditions, action, target_asset: screener ? null : (target || null), amount, screener,
        risk_limits: { stop_loss_pct: num(rl.stop_loss_pct), max_slippage_pct: num(rl.max_slippage_pct), max_portfolio_pct: num(rl.max_portfolio_pct) },
    };
}

// Deterministic heuristic parser — used when Gemini is unavailable (429). Best-effort; the rule
// is flagged needs_review so the user can confirm/adjust in the Strategy Card.
function _strategyFallback(text) {
    const raw = String(text || '');
    const t = ' ' + raw + ' ';
    const low = t.toLowerCase();
    // ── Ticker extraction: named entities (ביטקוין→BTC-USD) + a known list + ANY standalone
    //    uppercase 2-5 letter token that isn't a reserved word (so ORCL/INTC/etc. are caught too).
    const RESERVED = new Set(['RSI', 'EPS', 'MA', 'SMA', 'EMA', 'USD', 'ILS', 'AI', 'ETF', 'CEO', 'IPO', 'GDP', 'CPI', 'FED', 'ECB', 'BOJ', 'OPEC', 'ALL', 'ANY', 'AND', 'OR', 'BUY', 'SELL', 'USA', 'UK', 'EU', 'PE', 'PM', 'ATH', 'YOY', 'QOQ']);
    const known = (t.match(/\b(USO|NVDA|SPY|QQQ|DIA|GLD|SLV|TLT|IEF|AAPL|MSFT|AMD|META|TSLA|AMZN|GOOGL|GOOG|NFLX|MSTR|COIN|ORCL|INTC|CRM|ADBE|PYPL|BABA|BA|LMT|XOM|CVX|JPM|V|MA)\b/g) || []);
    const generic = (raw.match(/\b[A-Z]{2,5}\b/g) || []).filter(s => !RESERVED.has(s));
    let entityTicker = null;
    for (const k of Object.keys(_STRAT_TICKERS)) { if (low.includes(k)) { entityTicker = _STRAT_TICKERS[k]; break; } }
    const tickers = [...new Set([...known, ...generic])];
    // subject of a MONITORED condition prefers a named entity (ביטקוין→BTC-USD); the TRADED
    // target prefers the explicit stock ticker — so "monitor BTC-USD, trade MSTR" stays correct.
    const primary = entityTicker || tickers[0] || null;
    const target = tickers[0] || entityTicker || null;
    // Local text window around the first match of `re` (so an operator belongs to ITS OWN condition,
    // not another clause — fixes "RSI מתחת" leaking into the MA operator).
    const around = (re, span = 24) => { const m = t.match(re); if (!m) return ''; const i = m.index; return t.slice(Math.max(0, i - span), i + m[0].length + span); };
    const rsiOp = (w) => /(?:מעל|above|over|גדול)/i.test(w) ? 'ABOVE' : 'BELOW';
    const maOp = (w) => /(?:נוג[עת]|נגע|touch|tests?|בדיוק על|על הממוצע|at the)/i.test(w) ? 'EQUALS'
        : /(?:חוצה\s*מעלה|crosses?\s*above|breaks?\s*above|פורץ)/i.test(w) ? 'CROSSES_ABOVE'
        : /(?:חוצה\s*מטה|crosses?\s*below|breaks?\s*below|שובר)/i.test(w) ? 'CROSSES_BELOW'
        : /(?:מעל|above|over)/i.test(w) ? 'ABOVE' : /(?:מתחת|below|under)/i.test(w) ? 'BELOW' : 'EQUALS';
    const tfOf = (w) => /(?:שבוע|weekly|1w)/i.test(w) ? 'weekly' : (w.match(/(\d+)\s*(?:h|hour|שע)/i) ? (w.match(/(\d+)\s*(?:h|hour|שע)/i)[1] + 'h') : (/(?:יומי|daily|1d)/i.test(w) ? 'daily' : null));
    const conditions = [];
    // RSI (operator + timeframe from its LOCAL window; timeframe also checked over the WHOLE text so
    // "שבועי"/"weekly" is captured even when it sits a few words away from "RSI").
    // Prefer the number AFTER "rsi" ("RSI … מתחת ל-35"). Only fall back to a number BEFORE "rsi" when
    // it's a STANDALONE value (not digits pulled out of a bigger number like the "1000" amount — that
    // bug read "1000 … RSI" as threshold 0 from the trailing "000").
    let mRsi = t.match(/rsi[^\d]{0,30}(\d{1,3})/i);
    if (!mRsi) { const m2 = t.match(/(?<!\d)(\d{1,3})(?!\d)[^\d]{0,10}rsi/i); if (m2) mRsi = [m2[0], m2[1]]; }
    if (mRsi) { const w = around(/rsi/i, 28); conditions.push({ factor: 'rsi', subject: primary, keyword: null, operator: rsiOp(w), threshold: +mRsi[1], timeframe: tfOf(w) || tfOf(t) }); }
    // Moving average ("ממוצע 300", "300 שבועות", "MA200"…) — operator (incl. "touch"→EQUALS) from its window
    const mMa = t.match(/(?:ממוצע(?:\s*נע)?|moving\s*average|\bma\b|\bsma\b)[^\d]{0,10}(\d{1,4})/i) || t.match(/(\d{1,4})\s*(?:שבוע|week|יום|day)/i);
    if (mMa) { const w = around(/ממוצע|moving\s*average|\bma\b|\bsma\b/i, 28) || t; const weekly = /שבוע|week/i.test(w) || (!/יום|day/i.test(w) && /שבוע|week/i.test(t)); conditions.push({ factor: 'ma', subject: primary, keyword: null, operator: maOp(w), threshold: null, period: +mMa[1], timeframe: weekly ? 'weekly' : 'daily' }); }
    const mEps = t.match(/(?:eps|רווח|הפתעה)[^\d]{0,20}(\d{1,3})\s*%|(\d{1,3})\s*%[^\d]{0,14}(?:eps|רווח|הפתעה)/i);
    if (mEps) conditions.push({ factor: 'eps_surprise', subject: null, keyword: null, operator: 'ABOVE', threshold: +(mEps[1] || mEps[2]), timeframe: null });
    // Price level (only when no rsi/ma/eps condition already covers the number)
    const mBelow = t.match(/(?:מתחת|below|under|קטן)[^\d$]{0,12}\$?\s*(\d+(?:\.\d+)?)/i);
    const mAbove = t.match(/(?:מעל|above|over|גדול)[^\d$]{0,12}\$?\s*(\d+(?:\.\d+)?)/i);
    const mDollar = t.match(/\$\s*(\d+(?:\.\d+)?)/);
    if (!mRsi && !mMa && !mEps && (mBelow || mAbove || mDollar)) conditions.push({ factor: 'price', subject: primary, keyword: null, operator: mAbove ? 'ABOVE' : 'BELOW', threshold: +((mAbove || mBelow || mDollar)[1]), timeframe: null });
    // \b doesn't work around Hebrew — match the words directly (Hebrew has no ASCII word boundary).
    const kw = (t.match(/(Iran|Trump|Israel|Fed|Powell|OPEC|איראן|טראמפ|ישראל|הפד|אופ"ק|נפט|ריבית)/gi) || []);
    if (kw.length) conditions.push({ factor: 'news', subject: kw[0], keyword: [...new Set(kw.map(k => k.trim()))].join(','), operator: 'CONTAINS', threshold: null, timeframe: null });
    if (!conditions.length) return null;
    // Buy/sell intent — cover present tense ("קונה"/"מוכר"), nouns ("קנייה"/"מכירה") and "רכישה",
    // not just imperative/infinitive, so "אתה קונה לי כל מניה…" is a BUY (not a fallthrough ALERT).
    let action = /(sell|מכור|מוכר|למכור|מכיר[הת])/i.test(t) ? 'SELL'
        : /(buy|תקנה|תקנו|לקנות|קנה|קונ[היםות]|קניי?[הת]|קניה|לרכוש|רכוש|רוכש|רכיש[הת])/i.test(t) ? 'BUY'
        : 'ALERT_ONLY';
    // Logic: explicit "או/or" → ANY; otherwise multiple conditions are treated as ALL (compound "and").
    const logic = (/\sאו\s/.test(t) || /[^א-ת\w]or[^א-ת\w]/i.test(t)) ? 'ANY' : (conditions.length > 1 ? 'ALL' : 'ANY');
    let amount = { type: 'CASH_USD', value: 0 };
    const mCash = t.match(/\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:דולר|usd|\$)/i);
    const mShares = t.match(/(\d+(?:,\d{3})*)\s*(?:מניות|מניה|shares?)/i);
    const mPct = t.match(/(\d{1,3})\s*%/);
    if (mShares) amount = { type: 'SHARES', value: +mShares[1].replace(/,/g, '') };
    else if (mPct && action === 'SELL') amount = { type: 'PORTFOLIO_PCT', value: +mPct[1] };
    else if (mCash) amount = { type: 'CASH_USD', value: +mCash[1].replace(/,/g, '') };
    // ── Index SCREENER: "every stock in Nasdaq that crosses weekly RSI 30 → buy $X each, $Y total" ──
    let screener = null; let target2 = target;
    // A SCREENER = "scan the market and buy EACH stock passing a filter". It fires on an "every stock"
    // phrase + a technical/price filter — EVEN when no index is named (the user often writes just
    // "כל מניה שעוברת RSI 30"). The universe defaults to NDX (editable in the card) unless an index is
    // named. Excluded when the scope is the user's own portfolio ("כל מניה בתיק…").
    const everyStock = /(כל\s+מני[הות]|לכל\s+מני[הת]|every\s+stock|all\s+stocks|each\s+stock)/i.test(t);
    const hasScreenCond = conditions.some(c => c.factor === 'rsi' || c.factor === 'ma' || c.factor === 'price');
    const portfolioScoped = /(בתיק|בתיקים|התיק\s+שלי|בפורטפ|in\s+(?:my\s+)?portfolio|from\s+my\s+portfolio)/i.test(t);
    const namedIdx = /(נאסד|nasdaq|ndx)/i.test(t) ? 'NDX' : /(s&p|sp\s*500|sp500|ס["׳]?פ\s*500|ספ\s*500)/i.test(t) ? 'SP500' : null;
    const isScreener = everyStock && hasScreenCond && !portfolioScoped;
    if (isScreener) {
        const universe = namedIdx || 'NDX';
        // Only accept amounts that carry a MONEY marker (אלף/k/דולר/usd/$) or are ≥1000 — so an RSI
        // threshold like "30" is never mistaken for an allocation.
        const amtNear = (re) => {
            const m = t.match(re); if (!m) return 0;
            let v = parseFloat(String(m[1]).replace(/,/g, ''));
            const hasK = /אלף|k|thousand/i.test(m[2] || ''); if (hasK) v *= 1000;
            const hasMoney = hasK || /דולר|usd|\$|₪/i.test(m[0]);
            return (!hasMoney && v < 1000) ? 0 : v;
        };
        const perRe = /(?:לכל\s+מני[הת]|כל\s+מני[הת]|per\s*stock|each|לכל\s+אחת)[^\d$]{0,25}\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(אלף|k|thousand)?\s*(?:דולר|usd|\$|₪)?/i;
        const totRe = /(?:כולל|סה["׳]?כ|total|תקציב)[^\d$]{0,25}\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(אלף|k|thousand)?\s*(?:דולר|usd|\$|₪)?/i;
        let per = amtNear(perRe), tot = amtNear(totRe);
        // All money amounts: "N אלף/k" (thousand → ×1000) OR "$N" / "N דולר/usd". A bare RSI number
        // like "30" (no thousand/currency marker) is excluded. "10 אלף לכל מניה" IS captured (via אלף).
        const money = [];
        for (const m of t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:אלף|k|thousand)/gi)) money.push(parseFloat(String(m[1]).replace(/,/g, '')) * 1000);
        for (const m of t.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:דולר|usd)/gi)) { const raw = m[1] || m[2]; if (raw) money.push(parseFloat(String(raw).replace(/,/g, ''))); }
        const uniq = [...new Set(money.filter(v => v >= 100))].sort((a, b) => a - b);
        const equalSplit = /(חלוק[הת]\s*שוו|חלק\s*שוו|מחולק\s*שוו|בחלוקה\s*שוו|שווה\s*בין|split\s*equal|equal\s*split|divide\s*equally)/i.test(t);
        if (equalSplit && !per) {           // equal split: the amount is the TOTAL budget, no per-stock
            if (!tot) tot = uniq.length ? uniq[uniq.length - 1] : 0;
            per = 0;
        } else {                            // fixed: smaller amount = per-stock, larger = total budget
            if (!per && uniq.length) per = uniq[0];
            if (!tot && uniq.length >= 2) tot = uniq[uniq.length - 1];
        }
        if (per > 0 || tot > 0) {
            const splitMode = (equalSplit && !per) ? 'equal' : (per > 0 ? 'fixed' : 'equal');
            screener = { universe, per_stock_usd: per, total_budget_usd: tot, split_mode: splitMode };
            conditions.forEach(c => { c.subject = null; }); // the condition applies to EACH stock, not a single ticker
            target2 = null;
            if (per > 0) amount = { type: 'CASH_USD', value: per };
            if (action === 'ALERT_ONLY') action = 'BUY'; // a budgeted screener buys the matches; never a bare alert
        }
        // Even with no explicit budget yet, a clear "buy every stock that…" is a screener — carry it so
        // the card shows the (editable) budget/division fields rather than collapsing to a plain alert.
        if (!screener) {
            screener = { universe, per_stock_usd: 0, total_budget_usd: 0, split_mode: equalSplit ? 'equal' : 'fixed' };
            conditions.forEach(c => { c.subject = null; });
            target2 = null;
            if (action === 'ALERT_ONLY') action = 'BUY';
        }
    }
    // A real, clean name (no "(טיוטה)") — the draft state is conveyed by the card chip, not the name.
    const actNameHe = action === 'BUY' ? 'קנייה' : action === 'SELL' ? 'מכירה' : 'התראה';
    const nameSubj = target2 || (conditions.find(c => c.subject) || {}).subject || null;
    const autoName = screener ? 'סורק מדד' : (nameSubj ? `${actNameHe} ${nameSubj}` : `${actNameHe} — אסטרטגיה`);
    const r = _normalizeStrategy({ name: autoName, trigger_type: null, logic, conditions, action, target_asset: target2, amount, screener, risk_limits: {} });
    if (r) r._src = 'fallback';
    return r;
}

function _strategySummaryHe(r) {
    if (!r) return '';
    const opHe = { ABOVE: 'מעל', BELOW: 'מתחת ל', CROSSES_ABOVE: 'חוצה מעלה את', CROSSES_BELOW: 'חוצה מטה את', GTE: '≥', LTE: '≤', EQUALS: 'שווה ל', CONTAINS: 'מזכיר' };
    const facHe = { price: 'מחיר', rsi: 'RSI', ma: 'ממוצע נע', eps_surprise: 'הפתעת EPS', news: 'חדשות', macro: 'אירוע מאקרו' };
    const tfHe = { weekly: 'שבועי', daily: 'יומי', '4h': '4 שעות', '1h': 'שעתי' };
    const conds = (r.conditions || []).map(c => {
        const subj = c.subject ? ` (${c.subject})` : '';
        if (c.factor === 'news') return `אזכור בחדשות של "${c.keyword || c.subject}"`;
        if (c.factor === 'ma') {
            const per = c.period || 200;
            const unit = c.timeframe === 'weekly' ? ' שבועות' : c.timeframe === 'daily' ? ' ימים' : '';
            if (c.operator === 'EQUALS') return `מחיר${subj} נוגע בממוצע ${per}${unit}`;
            return `מחיר${subj} ${opHe[c.operator] || c.operator} ממוצע ${per}${unit}`;
        }
        const th = c.threshold != null ? ` ${opHe[c.operator] || c.operator} ${c.threshold}${c.factor === 'eps_surprise' ? '%' : ''}` : '';
        const tf = c.timeframe ? ` [${tfHe[c.timeframe] || c.timeframe}]` : '';
        return `${facHe[c.factor] || c.factor}${subj}${th}${tf}`;
    });
    const join = conds.join(r.logic === 'ALL' ? ' וגם ' : ' או ');
    const nf = (n) => Number(n || 0).toLocaleString('en-US');
    if (r.screener) {
        const uniHe = r.screener.universe === 'SP500' ? 'S&P 500' : 'נאסד"ק 100';
        return `סורק ${uniHe} — כל מניה: ${join} → קנייה $${nf(r.screener.per_stock_usd)} למניה (תקציב $${nf(r.screener.total_budget_usd)})`;
    }
    const actHe = r.action === 'BUY' ? 'קנייה' : r.action === 'SELL' ? 'מכירה' : 'התראה בלבד';
    const amtHe = r.action === 'ALERT_ONLY' ? '' : (r.amount.type === 'SHARES' ? `${r.amount.value} מניות` : r.amount.type === 'PORTFOLIO_PCT' ? `${r.amount.value}% מהאחזקה` : `$${r.amount.value}`);
    const tgt = r.target_asset ? ` ${r.target_asset}` : '';
    return `אם ${join} → ${actHe}${amtHe ? ' ' + amtHe : ''}${tgt}`;
}

// ── Market-advisor path — for OPEN-ENDED requests that aren't a concrete rule
// ("bring me relevant stocks for the coming period based on macro/geo/tech"). Returns a
// written analysis + real tickers as ideas. Framed as AI opinion, never fabricated data.
function _advicePrompt(text, headlines, ctxBlock) {
    const ctx = (Array.isArray(headlines) && headlines.length)
        ? '\nכותרות שוק עדכניות מהפלטפורמה:\n- ' + headlines.slice(0, 8).map(h => String(h).slice(0, 140)).join('\n- ')
        : '';
    return [
        'אתה אנליסט פיננסי מומחה וסוכן AI מתקדם לניתוח מאקרו, סקטורים ונכסים פיננסיים בפלטפורמת Finextium. מטרתך: לספק תובנות שוק מדויקות, מצולבות ומקושרות לנתוני אמת. אל תסתמך אך ורק על ידע סטטי/קודם עבור שאלות הדורשות נתונים עדכניים.',
        'יש לך גישה חיה לשני מקורות: (א) חיפוש אינטרנט (Google Search) — השתמש בו למשיכת מחירים חיים, נתוני מאקרו עדכניים, רוטציית סקטורים, דוחות אחרונים וכותרות; (ב) "נתוני הפלטפורמה" למטה (דוחות פונדמנטליים+score, חוזק סקטורים, קטליסטים, מנוע נזילות LHE, אינדיקטורים מאקרו, טכני חי, והתיקים של המשתמש).',
        'שרשרת ההיגיון (חובה — אל תנתח מדד במבודד): קשר מאקרו→סקטור→חברה. הצלב מאקרו/נזילות עם הפונדמנטלס (score הדוח) והטכני (RSI/מבנה). כל תמחור/מגמה חייבים לשקף שווי שוק חי ואמיתי (Live), לא עלויות כניסה היסטוריות.',
        'חוקי ברזל: (1) עדיפות מוחלטת לנתון החי המאומת על פני הידע הפנימי אם יש סתירה. (2) איסור הזיות — אם מחיר/נתון אינו זמין בחיפוש/בנתונים, ציין זאת במפורש ("לא נמצא נתון חי ל-X"); אל תנחש, אל תמציא מספרים, אל תבצע אקסטרפולציה. (3) סיווג נכסים מדויק — הבחן במפורש בין מניה של חברה ספציפית לבין תעודת סל מבוזרת.',
        'דיוק נושאי (קריטי): כשמבקשים חברות בתחום מסוים, החזר PURE-PLAYS — חברות שהעיסוק המרכזי/הליבה שלהן הוא בדיוק אותו תחום, ולא חברות שקשורות אליו בעקיפין או רק "מאפשרות" אותו. דוגמה: לשאלה על "רובוטיקה" החזר יצרניות רובוטים ומערכות רובוטיות ממשיות (למשל Intuitive Surgical=רובוטים כירורגיים, ABB/Teradyne(Universal Robots)=רובוטים תעשייתיים/שיתופיים, Symbotic=רובוטיקת מחסנים, iRobot=רובוטים צרכניים) — ולא יצרנית שבבים כללית (NVIDIA) או תוכנת RPA (UiPath), שהן תשתית/מאפשרות בלבד. אם אתה כולל חברה מאפשרת, סמן זאת מפורשות ב-why ("תשתית/מאפשרת, לא pure-play") והצב אותה אחרי ה-pure-plays. בשדה why חובה לציין את הקשר הישיר והספציפי לתחום (מה בדיוק החברה עושה בתחום), לא ניסוח כללי.',
        'החזר אך ורק JSON תקין (ללא ``` וללא טקסט נוסף) במבנה הבא:',
        '{',
        '  "title": "כותרת קצרה בעברית",',
        '  "executive_he": "תובנה מנהלתית — תשובה ישירה, ממוקדת ומגובה בנתונים לשאלת המשתמש (1-2 פסקאות).",',
        '  "logic_he": "הקשר והיגיון מחובר — שרשרת מפורשת: גורם מאקרו X ← לוחץ/תומך בסקטור Y ← מייצר הזדמנות/סיכון במניה Z. הראה את החיבור בין השכבות.",',
        '  "live_data": [ "נתון/מחיר/כותרת מדויקים שמשכת ברגע זה ותומכים במסקנה (עם מקור/הקשר). רק נתונים מאומתים — אם אין, השאר ריק." ],',
        '  "ideas": [ { "ticker": "SYMBOL", "name": "שם החברה", "why": "משפט קצר — מדוע רלוונטי, מקושר לשרשרת ההיגיון" } ],',
        '  "suggested_strategy_he": "משפט אחד המתאר אסטרטגיה אוטומטית קונקרטית שאפשר להפעיל (טריגר→פעולה→נכס), או null"',
        '}',
        'כללים: (1) עד 6 רעיונות, טיקרים אמיתיים בלבד; העדף מניות שעולות מנתוני הפלטפורמה (דוח חזק, סקטור חזק, סיגנל נזילות חיובי, קטליסט) ומאומתות בחיפוש. (2) עברית מקצועית וברורה; ציין מפורשות את המקור ("לפי מנוע הנזילות", "לפי החיפוש: מחיר NVDA…", "score הדוח"). (3) live_data חייב להכיל נתונים אמיתיים בלבד שנמשכו עכשיו — לא המצאות. (4) הישאר ממוקד ורלוונטי לשאלה בלבד — אל תוסיף מידע לא קשור.',
        ctx,
        ctxBlock || '',
        '',
        'בקשת המשתמש: ' + JSON.stringify(String(text || '').slice(0, 600)),
    ].join('\n');
}
function _normalizeAdvice(r) {
    if (!r || typeof r !== 'object') return null;
    // New structured mandate: executive insight + connected logic + verified live data. Falls back to
    // the older single answer_he if the model returned that shape.
    const executive = r.executive_he || r.answer_he || r.answer || '';
    const logic = r.logic_he || r.connected_logic_he || '';
    const liveData = (Array.isArray(r.live_data) ? r.live_data : (Array.isArray(r.verified_live_data) ? r.verified_live_data : []))
        .map(x => String(x || '').trim()).filter(Boolean).slice(0, 8).map(x => x.slice(0, 220));
    const ideas = (Array.isArray(r.ideas) ? r.ideas : []).slice(0, 6).map(i => ({
        ticker: String((i && (i.ticker || i.symbol)) || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 8),
        name: i && i.name ? String(i.name).slice(0, 60) : '',
        why: i && i.why ? String(i.why).slice(0, 240) : '',
    })).filter(i => i.ticker);
    if (!executive && !logic && !ideas.length && !liveData.length) return null;
    return {
        title: r.title ? String(r.title).slice(0, 80) : 'ניתוח והמלצות',
        executive_he: String(executive).slice(0, 2000),
        logic_he: String(logic).slice(0, 1200),
        live_data: liveData,
        answer_he: String(executive).slice(0, 2000), // back-compat for any older renderer
        ideas,
        suggested_strategy_he: (r.suggested_strategy_he && r.suggested_strategy_he !== 'null') ? String(r.suggested_strategy_he).slice(0, 200) : null,
    };
}

// Curated theme → REAL, well-known public companies (no invented tickers). Used by the deterministic
// advisory fallback so the agent still answers thematic questions when the LLM is unavailable.
const _ADVICE_THEMES = [
    { keys: ['רובוט', 'robot', 'אוטומצי', 'אוטומט', 'automation'], he: 'רובוטיקה ואוטומציה', picks: [['ISRG', 'Intuitive Surgical', 'רובוטים כירורגיים (da Vinci) — pure-play מוביל'], ['ABB', 'ABB Ltd', 'רובוטים תעשייתיים — יצרן ליבה'], ['TER', 'Teradyne', 'רובוטים שיתופיים (Universal Robots / MiR)'], ['SYM', 'Symbotic', 'רובוטיקת מחסנים ולוגיסטיקה — pure-play'], ['IRBT', 'iRobot', 'רובוטים צרכניים (Roomba)'], ['SERV', 'Serve Robotics', 'רובוטי משלוחים אוטונומיים'], ['ROK', 'Rockwell Automation', 'אוטומציה ובקרה תעשייתית']] },
    { keys: ['בינה מלאכות', 'בינה', ' ai ', 'artificial intel'], he: 'בינה מלאכותית (AI)', picks: [['NVDA', 'NVIDIA', 'שבבי AI מובילים'], ['MSFT', 'Microsoft', 'AI + ענן (Copilot/Azure)'], ['GOOGL', 'Alphabet', 'מודלים ותשתיות AI'], ['AVGO', 'Broadcom', 'שבבי רשת ל-AI'], ['AMD', 'AMD', 'מאיצי AI'], ['PLTR', 'Palantir', 'תוכנת AI לארגונים']] },
    { keys: ['שבב', 'מוליכ', 'semi', 'chip'], he: 'מוליכים למחצה (שבבים)', picks: [['NVDA', 'NVIDIA', 'GPU/AI'], ['AVGO', 'Broadcom', 'שבבי רשת'], ['AMD', 'AMD', 'מעבדים ומאיצים'], ['ASML', 'ASML', 'ליתוגרפיה EUV'], ['TSM', 'TSMC', 'ייצור שבבים'], ['MU', 'Micron', 'זיכרון']] },
    { keys: ['ביטחון', 'בטחון', 'נשק', 'defense', 'military'], he: 'ביטחון וחלל', picks: [['LMT', 'Lockheed Martin', 'מערכות נשק'], ['RTX', 'RTX (Raytheon)', 'טילים והגנה אווירית'], ['NOC', 'Northrop Grumman', 'חלל וביטחון'], ['GD', 'General Dynamics', 'יבשה וימית'], ['LHX', 'L3Harris', 'תקשורת ביטחונית']] },
    { keys: ['אנרגי', 'נפט', 'energy', 'oil'], he: 'אנרגיה', picks: [['XOM', 'ExxonMobil', 'נפט וגז משולב'], ['CVX', 'Chevron', 'נפט וגז'], ['COP', 'ConocoPhillips', 'הפקה'], ['SLB', 'Schlumberger', 'שירותי נפט']] },
    { keys: ['בנק', 'פיננס', 'bank', 'financ'], he: 'בנקאות ופיננסים', picks: [['JPM', 'JPMorgan', 'בנק מוביל'], ['BAC', 'Bank of America', 'בנקאות קמעונאית'], ['GS', 'Goldman Sachs', 'בנקאות השקעות'], ['V', 'Visa', 'תשלומים']] },
    { keys: ['תרופ', 'ביוטק', 'biotech', 'pharma', 'בריאות', 'health'], he: 'בריאות וביוטק', picks: [['LLY', 'Eli Lilly', 'תרופות השמנה/סוכרת'], ['NVO', 'Novo Nordisk', 'GLP-1'], ['MRK', 'Merck', 'אונקולוגיה'], ['ISRG', 'Intuitive Surgical', 'רובוטיקה רפואית'], ['UNH', 'UnitedHealth', 'ביטוח בריאות']] },
    { keys: ['ענן', 'תוכנ', 'cloud', 'saas', 'software'], he: 'ענן ותוכנה', picks: [['MSFT', 'Microsoft', 'Azure'], ['AMZN', 'Amazon', 'AWS'], ['CRM', 'Salesforce', 'CRM ענן'], ['NOW', 'ServiceNow', 'זרימות עבודה'], ['SNOW', 'Snowflake', 'נתונים בענן']] },
    { keys: ['סייבר', 'cyber', 'security'], he: 'סייבר', picks: [['CRWD', 'CrowdStrike', 'הגנת קצה'], ['PANW', 'Palo Alto', 'חומות אש'], ['ZS', 'Zscaler', 'Zero-Trust'], ['FTNT', 'Fortinet', 'רשת ואבטחה']] },
    { keys: ['רכב חשמל', 'טסלה', 'electric veh', ' ev '], he: 'רכב חשמלי', picks: [['TSLA', 'Tesla', 'מוביל EV'], ['GM', 'General Motors', 'מעבר ל-EV'], ['RIVN', 'Rivian', 'טנדרים חשמליים']] },
];

// Deterministic advisory answer from REAL platform data (context) + the theme map above — so the
// agent responds even when the LLM (Gemini/AI-Gateway) is down. Never invents prices/numbers.
function _adviceFallback(text, context) {
    const t = ' ' + String(text || '').toLowerCase() + ' ';
    const ctx = (context && typeof context === 'object') ? context : {};
    const arr = (x) => Array.isArray(x) ? x : [];
    const reports = [...arr(ctx.top_reports), ...arr(ctx.holdings_reports)];
    const scoreOf = (tk) => { const r = reports.find(x => String(x.t).toUpperCase() === tk); return r ? r.score : null; };
    // Real data points from the context (never fabricated).
    const live = [];
    if (arr(ctx.macro).length) live.push('מאקרו (ארה"ב): ' + ctx.macro.slice(0, 4).map(m => `${m.k}=${m.v}`).join(', '));
    if (arr(ctx.sectors).length) live.push('חוזק סקטורים (score ממוצע): ' + ctx.sectors.slice(0, 4).map(s => `${s.sector} ${s.avg}`).join(' · '));
    if (arr(ctx.liquidity).length) live.push('מנוע נזילות: ' + ctx.liquidity.slice(0, 3).map(l => `${l.t} ${l.bias}/${l.regime}`).join(' · '));
    if (arr(ctx.macro_news).length) live.push('כותרת מאקרו: ' + ctx.macro_news[0]);

    let title = '', executive = '', logic = '', ideas = [];
    const theme = _ADVICE_THEMES.find(th => th.keys.some(k => t.includes(k)));
    // Catalysts (Early-Alpha) that mention the theme/query text — real, from the scanner.
    const catHit = arr(ctx.catalysts).filter(c => {
        const blob = ((c.sector || '') + ' ' + (c.thesis || '')).toLowerCase();
        return (theme && theme.keys.some(k => blob.includes(k))) || false;
    });

    if (theme) {
        title = `חברות בתחום ${theme.he}`;
        ideas = theme.picks.slice(0, 6).map(([tk, n, why]) => { const sc = scoreOf(tk); return { ticker: tk, name: n, why: why + (sc != null ? ` · score דוח ${sc}` : '') }; });
        // Merge in any catalyst stealth tickers for this theme.
        catHit.forEach(c => arr(c.tickers).forEach(tk => { if (ideas.length < 8 && !ideas.some(i => i.ticker === tk)) ideas.push({ ticker: tk, name: '', why: `זוהתה בסורק הקטליסטים — ${String(c.thesis || '').slice(0, 80)}` }); }));
        const graded = ideas.filter(i => scoreOf(i.ticker) != null);
        executive = `להלן חברות בולטות ואמיתיות הנסחרות בבורסה בתחום ${theme.he}.` + (graded.length ? ` חלקן מדורגות במערכת הדוחות של הפלטפורמה (מוצג ה-score ליד כל אחת).` : '') + (catHit.length ? ` הסורק (Early-Alpha) זיהה קטליסטים רלוונטיים בתחום.` : '');
        logic = arr(ctx.sectors).length ? `הקשר: התחום מושפע ממצב הסקטורים והנזילות בשוק — ראה "נתוני אמת" למטה. לכל מניה, הצלב את ה-score הפונדמנטלי עם הטכני לפני כניסה.` : '';
    } else if (/(רלוונט|כדאי|מומלצ|מעניינ|הזדמנות|לתקופה|עכשיו|היום|opportunit|relevant)/.test(t) && (reports.length || arr(ctx.catalysts).length)) {
        // "what's relevant now" — surface the platform's own top-scored companies + catalysts.
        title = 'הכי רלוונטי עכשיו — לפי נתוני הפלטפורמה';
        const tops = arr(ctx.top_reports).slice(0, 6);
        ideas = tops.map(r => ({ ticker: r.t, name: r.n || '', why: `score דוח ${r.score}${r.up ? ' ↑' : ''}${r.sector ? ' · ' + r.sector : ''}` }));
        arr(ctx.catalysts).forEach(c => arr(c.tickers).forEach(tk => { if (ideas.length < 8 && !ideas.some(i => i.ticker === tk)) ideas.push({ ticker: tk, name: '', why: `קטליסט: ${String(c.thesis || '').slice(0, 80)}` }); }));
        executive = 'לפי בסיס הנתונים של הפלטפורמה, אלה החברות עם ציוני הדוחות הגבוהים ביותר כרגע, בתוספת קטליסטים פעילים שזוהו בסורק. הצלב אותן עם חוזק הסקטור והנזילות (למטה).';
        logic = 'הקשר: score דוח גבוה = פונדמנטלס חזק; קטליסט = זרז חדשותי/מבני. שילוב עם סקטור חזק ונזילות חיובית מחזק את הרלוונטיות.';
    }
    if (!ideas.length && !executive) return null;
    return {
        title: title || 'ניתוח מבוסס-נתונים',
        executive_he: executive + '\n\n(תשובה מבוססת על נתוני הפלטפורמה בזמן אמת. לניתוח AI מלא עם חיפוש-אינטרנט ומחירים חיים — נדרש מנוע ה-AI, ראה ההערה למעלה.)',
        logic_he: logic,
        live_data: live,
        answer_he: executive,
        ideas: ideas.slice(0, 8).map(i => ({ ticker: String(i.ticker).toUpperCase().slice(0, 8), name: (i.name || '').slice(0, 60), why: (i.why || '').slice(0, 200) })).filter(i => i.ticker),
        suggested_strategy_he: null,
        _src: 'data-fallback',
    };
}

// Optional RELIABLE-LLM fallback via Vercel AI Gateway (OpenAI-compatible). Used when the free-tier
// Gemini key is exhausted (429). No-op unless AI_GATEWAY_API_KEY is set — then complex parsing AND
// open-ended advice work reliably (default model configurable via AI_GATEWAY_MODEL).
async function _aiGatewayJson(prompt, temperature, maxTokens) {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) return null;
    const model = process.env.AI_GATEWAY_MODEL || 'anthropic/claude-sonnet-5';
    try {
        const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, temperature: temperature == null ? 0.2 : temperature, max_tokens: maxTokens || 1200, messages: [{ role: 'user', content: prompt + '\n\nהחזר אך ורק אובייקט JSON תקין, ללא טקסט נוסף.' }] }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        let txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!txt) return null;
        txt = String(txt).replace(/```json|```/g, '').trim();
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
        return JSON.parse(txt);
    } catch (err) { return null; }
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
            // Real-data platform context from the client (portfolios, reports, sectors, catalysts,
            // tweets, LHE, macro, technicals) → a compact Hebrew block grounding the LLM.
            const ctxBlock = _ctxBlockHe(d.context);
            const headlines = (d.context && Array.isArray(d.context.macro_news)) ? d.context.macro_news : [];
            // The memo is shared across warm invocations (⇒ across users). A context-grounded answer is
            // PERSONAL (it embeds the user's portfolio/holdings), so key it on a hash of the context to
            // prevent serving one user's grounded answer to another. Grounded answers cache short.
            let _h = 5381; for (let i = 0; i < ctxBlock.length; i++) _h = ((_h << 5) + _h + ctxBlock.charCodeAt(i)) | 0;
            const memoKey = `strategy:${ctxBlock ? 'c' + (_h >>> 0).toString(36) + ':' : 'c0:'}${text.slice(0, 180)}`;
            if (_memo.has(memoKey)) { res.setHeader('Cache-Control', ctxBlock ? 's-maxage=120, private' : 's-maxage=600'); res.status(200).json({ ..._memo.get(memoKey), cached: true }); return; }
            let rule = null, wantAdvice = false;
            // The model classifies: a concrete rule → JSON rule; an open-ended question → {"advice":true}.
            try { const g = await _geminiGroundedJson(_strategyPrompt(text, ctxBlock), KEY, MODELS, false, 0.1, 1200); if (g && g.advice === true) wantAdvice = true; else rule = _normalizeStrategy(g); } catch (e) { rule = null; }
            if (!rule && !wantAdvice) { try { const g2 = await _aiGatewayJson(_strategyPrompt(text, ctxBlock), 0.1, 1300); if (g2 && g2.advice === true) wantAdvice = true; else rule = _normalizeStrategy(g2); } catch (e) { rule = null; } }
            let source = 'ai';
            if (!rule && !wantAdvice) { rule = _strategyFallback(text); source = rule ? 'fallback' : 'none'; }
            if (rule && rule._src) { source = rule._src; delete rule._src; }
            if (!rule) {
                // Not a concrete rule → treat as an open-ended market question and answer as an advisor,
                // grounded in the platform context.
                let advice = null;
                // grounded:true → Gemini pulls LIVE data via Google Search (prices/macro/headlines).
                try { advice = _normalizeAdvice(await _geminiGroundedJson(_advicePrompt(text, headlines, ctxBlock), KEY, MODELS, true, 0.5, 1900)); } catch (e) { advice = null; }
                if (!advice) { try { advice = _normalizeAdvice(await _aiGatewayJson(_advicePrompt(text, headlines, ctxBlock), 0.55, 1600)); } catch (e) { advice = null; } }
                // LLM down (Gemini 429 + AI Gateway unfunded)? Answer deterministically from REAL
                // platform data + the curated theme map, so the agent still helps (thematic queries,
                // "what's relevant now"). Only falls through to the error if even that can't help.
                let adviceSrc = 'ai';
                if (!advice) { const fb = _adviceFallback(text, d.context); if (fb) { adviceSrc = 'data'; delete fb._src; advice = fb; } }
                if (advice) {
                    const aResult = { advice, source: adviceSrc };
                    _memo.set(memoKey, aResult);
                    res.setHeader('Cache-Control', ctxBlock ? 's-maxage=120, private' : 's-maxage=600');
                    res.status(200).json(aResult); return;
                }
                res.setHeader('Cache-Control', 's-maxage=60');
                res.status(200).json({ error: 'unparsed', message: 'לא הצלחתי להבין את הבקשה כרגע. נסה לנסח מחדש — למשל "חברות בתחום רובוטיקה", "מניות עם דוח חזק", או תאר אסטרטגיה (טריגר → פעולה → נכס).' });
                return;
            }
            const result = { rule, summary_he: _strategySummaryHe(rule), source };
            _memo.set(memoKey, result);
            res.setHeader('Cache-Control', ctxBlock ? 's-maxage=120, private' : 's-maxage=3600, stale-while-revalidate=86400');
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
