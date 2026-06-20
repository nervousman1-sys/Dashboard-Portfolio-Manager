// ========== Shared lib — Report SWOT + strategy (Hebrew) via Gemini ==========
//
// Lives OUTSIDE api/ so it does NOT count as a Vercel serverless function. Imported
// by api/vision.js (?mode=swot) — which already holds the Gemini KEY + model list.
//
// generateSwot(data, KEY, MODELS) → { swot:{strengths,weaknesses,opportunities,threats},
//                                     strategy:{vision,progressToward,keyPartnerships,outlook} }

const HEB_QUALITY = ' כתוב עברית עסקית-פיננסית תקנית, ברורה וזורמת — לא תרגום מילולי. הקפד על דקדוק, מונחים פיננסיים מדויקים והתאמת מין/מספר. בסס כל אבחנה על הנתונים שסופקו ועל ידע ציבורי על החברה; אל תמציא מספרים, שותפויות או עובדות שאינך בטוח בהן.';

function buildPrompt(d) {
    const ctx = d.context || {};
    const lines = Object.entries(ctx)
        .filter(([k]) => k !== 'flags')
        .map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const flags = Array.isArray(ctx.flags) && ctx.flags.length ? ('\nדגלי סיכון שזוהו:\n' + ctx.flags.map(f => '- ' + f).join('\n')) : '';
    const declines = Array.isArray(ctx.declines) && ctx.declines.length ? ('\nירידות חדות שזוהו בדו"ח (יש להסביר כל אחת):\n' + ctx.declines.map(d => '- ' + d).join('\n')) : '';
    return `אתה אנליסט אקוויטי בכיר שכותב תזת-השקעה למשקיע שמחליט אם להיכנס לעסקה בחברה "${d.company || d.symbol}" (טיקר ${d.symbol}${d.sector ? ', סקטור ' + d.sector : ''}). הניתוח שלך צריך להיות חד, ספציפי וניתן-לפעולה.
להלן נתונים פונדמנטליים מהדו"חות (כולל טבלת רבעונים גרנולרית — השתמש בה כדי לבסס כל קביעה כמותית):
${lines || '(אין נתונים מספריים זמינים — הסתמך על ידע ציבורי על החברה)'}${flags}${declines}

חוקי דיוק מחייבים (המשתמש מקבל החלטת השקעה על סמך זה — דיוק קריטי):
1. בסס כל קביעה כמותית על המספרים שב-quartersTable: צטט אחוזים/סכומים/רבעונים קונקרטיים. דוגמה רעה: "ירידה ברווחיות עקב לחץ תחרותי". דוגמה טובה: "השולי התפעולי ירד מ-22.1% ל-18.4% בין הרבעונים, וה-FCF התכווץ מ-$1.2B ל-$0.7B בעקבות קפיצת ה-CapEx ל-$0.9B — כלומר ההשקעה ההונית, לא שחיקת מרווח, היא שלחצה על התזרים".
2. אסורים ניסוחים גנריים/תבניתיים ("לחץ תחרותי", "עליית מחירי חומרי גלם", "היחלשות מגמתית", "אתגרי שוק") אלא אם יש להם בסיס מפורש בנתונים או בידע ציבורי ספציפי — ואז נקוב בבסיס.
3. נקוב בשמות אמיתיים: לקוחות, ספקים, שותפים, מוצרים, חטיבות, עסקאות (למשל "Apple", "TSMC", "פלטפורמת Blackwell") — לא תיאורים כלליים.
4. אם פרט באמת אינו ידוע — אמור זאת בקצרה ("לא פורסם נתון ספציפי") ואל תמציא. עדיף קצר ומדויק על-פני ארוך ומעורפל.

חשוב מאוד לגבי השדות האיכותיים (שותפויות, לקוחות, חוזים/עסקאות, מיקוד מו"פ, ענפי צמיחה): מידע זה כמעט אף פעם לא מופיע בדו"ח הכספי עצמו — לכן הסתמך על הידע הציבורי שלך על החברה (זו חברה ציבורית נסחרת ומוכרת) ומלא אותם תמיד עם שמות ועובדות קונקרטיים. אל תכתוב "לא מסופק בדו\\"ח" או "אין מידע" עבור חברה מוכרת — תמיד יש מידע ציבורי על השותפויות, הלקוחות והעסקאות של חברות גדולות. "אין מידע" מותר אך ורק עבור חברה קטנה/אנונימית שבאמת אינך מכיר.

החזר אך ורק אובייקט JSON תקין (ללא טקסט נוסף, ללא markdown, ללא \`\`\`) במבנה המדויק הבא:
{
  "summary": {
    "activitySector": "סקטור הפעילות ותחום העיסוק העיקרי — משפט קצר וקונקרטי (אילו מוצרים/שירותים).",
    "growthDivision": "הענף / קו-המוצר / הסגמנט הצומח ביותר בחברה כיום — נקוב בשמו ובמספר שתומך (למשל גידול הכנסות הסגמנט, או חלקו ההולך וגדל מסך ההכנסות). אם ידוע מ-quartersTable שההכנסות צומחות, קשר זאת לסגמנט המוביל.",
    "hurtDivision": "הענף / הסגמנט שנפגע — נקוב בשמו ובמספר שתומך (ירידת הכנסות/מרווח של אותו סגמנט). אם שום סגמנט מהותי לא נפגע — כתוב במפורש 'לא נפגע סגמנט מהותי' ותמך זאת בכך שההכנסות/המרווחים יציבים או צומחים.",
    "declineReasons": "מסקנה מבוססת-נתונים ומדויקת לגבי כל ירידה בתזרים/רווחיות: הצבע על המנגנון המספרי המדויק מתוך quartersTable (למשל קפיצת CapEx, צניחת תזרים תפעולי, שחיקת שולי-גולמי בכך-וכך נק', גידול בחוב). חשוב — בדוק עונתיות: אם הירידה היא רק לעומת הרבעון הקודם (QoQ) בעוד שלעומת הרבעון המקביל אשתקד (YoY) יש צמיחה או יציבות, אזי זו עונתיות ולא הידרדרות — ציין זאת במפורש וקבע שההשוואה הרלוונטית היא השנתית (YoY). דווח על הידרדרות אמיתית רק כשגם ה-YoY חלש. אם אין ירידה — ציין שהרווחיות/התזרים יציבים/צומחים עם המספרים. בלי השערות גנריות.",
    "investments": "ההשקעות המרכזיות באופן ספציפי: אם CapEx גבוה/עולה (ראה quartersTable) — לאן הוא הולך (מפעלים, קיבולת ייצור, ציוד, מרכזי-נתונים)? אם יש מו\\"פ — צטט את הסכום (rdExpenseTTM). תאר קונקרטית במה משקיעים (טכנולוגיה/מכשירים/קווי-מוצר חדשים) ומה זה אמור להשיג.",
    "rdFocus": "במה בדיוק החברה מפתחת במו\\"פ ולאיזו חטיבה הוא מופנה: נקוב בקווי-המוצר/הטכנולוגיות הקונקרטיים שמפתחים שם (ארכיטקטורות, דורות-מוצר, פלטפורמות), מה הם מנסים להשיג/לפצח, ואיזו חטיבה זוללת את רוב התקציב — על בסיס ידע ציבורי. לא ניסוח גנרי.",
    "partnerships": "שותפויות אסטרטגיות ספציפיות בשמן (ספקים, לקוחות-ענק, מיזמים משותפים, שותפי טכנולוגיה/הפצה/ייצור) — מהידע הציבורי שלך על החברה (זה לא מופיע בדו\\"ח, חובה למלא מהיכרות עם החברה). למשל עבור NVIDIA: TSMC כיצרן, ספקיות ענן (Microsoft, Amazon, Google) כלקוחות. תמיד ספק שמות לחברה מוכרת.",
    "keyCustomers": "שמות הלקוחות/הלקוחות-הגדולים הספציפיים שעושים עסקים עם החברה (למשל 'Apple, NVIDIA, ספקיות ענן'), ריכוזיות לקוחות אם ידועה, והשווקים הגאוגרפיים המרכזיים — מהידע הציבורי שלך. שמות אמיתיים, לא תיאורים. תמיד מלא לחברה מוכרת.",
    "recentDeals": "עסקאות/חוזים/הזמנות/רכישות/שותפויות גדולות ספציפיות מהשנה-שנתיים האחרונות (שם, צד שני, היקף) — מהידע הציבורי שלך על החברה. נקוב בשמות וסכומים. זה לא בדו\\"ח הכספי — חובה למלא מההיכרות עם אירועי החברה. רק לחברה אנונימית שבאמת אינך מכיר — ציין שאין מידע.",
    "insiderActivity": "אם סופקו נתוני עסקאות בעלי עניין (recentInsiderTrades) — סכם בקצרה בעברית בדגש על קניות מהותיות (מי, מתי, היקף משוער) וציין אם המגמה קנייה או מכירה. אם לא סופקו אך ידועה פעילות מהותית מהידע הציבורי — ציין בזהירות. רק אם אין מידע — ציין זאת."
  },
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
  },
  "risks": {
    "supplierDependency": "1-2 משפטים על תלות בספקים, ביצרנים או בלקוחות מהותיים וריכוזיות שרשרת האספקה של החברה הזו ספציפית (למשל תלות ב-TSMC, בספק יחיד, או בלקוח גדול). אם אין תלות מהותית ידועה — ציין זאת במפורש.",
    "geopolitical": "1-2 משפטים על חשיפת החברה הזו לסיכונים גיאופוליטיים רלוונטיים — מתח סין/טייוואן, מכסים ורגולציית סחר, סנקציות, חשיפה מטבעית, או תלות בשווקים/אזורים ספציפיים. אם החשיפה נמוכה — ציין זאת."
  },
  "declineExplanations": [
    "לכל ירידה חדה שצוינה למעלה — משפט קצר, חכם וספציפי שמסביר את הסיבה הסבירה לה על בסיס מה שידוע על החברה ועל הסקטור (למשל: השקעות הוניות מוגברות שלחצו על ה-FCF, עלייה בהון חוזר, לחץ תמחור, הוצאה חד-פעמית, האטה בביקושים בשוק מסוים). אם ההערה כבר מציינת שמדובר בעונתיות (ירידה רק לעומת הרבעון הקודם בעוד שלעומת אשתקד יש צמיחה/יציבות) — אמת זאת והסבר את דפוס העונתיות הספציפי של החברה/הענף (איזה רבעון חלש עונתית ומדוע), ואל תמציא סיבת-הידרדרות מגמתית. נסח כל הסבר אחרת — לא משפטי-תבנית גנריים כמו 'היחלשות מגמתית'. החזר פריט אחד לכל ירידה, באותו סדר."
  ]
}
כל הטקסט בעברית.${HEB_QUALITY}`;
}

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

async function generateSwot(data, KEY, MODELS) {
    const payload = JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(data) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' },
    });
    let parsed = null, lastErr = '';
    // LEAN fallback: ONE attempt per model, in order. Tight retry loops only burn the
    // free-tier rate limit and trigger MORE 429s — durable caching (client + edge) is what
    // keeps this reliable, not hammering. Each model is a separate rate bucket, so simply
    // trying the next model on failure already gives us a second/third chance.
    for (const model of MODELS) {
        let gr;
        try {
            gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
            });
        } catch (e) { lastErr = `gemini(${model}) fetch ${e.message}`; continue; }
        if (!gr.ok) { lastErr = `gemini(${model}) ${gr.status}`; continue; }
        const gj = await gr.json();
        const text = (((gj.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('\n').trim() || '';
        parsed = extractJson(text);
        if (parsed && parsed.swot) break;
        lastErr = `unparseable result from ${model}`;
    }
    if (!parsed || !parsed.swot) throw new Error(lastErr || 'empty ai result');
    return { symbol: String(data.symbol || '').toUpperCase(), summary: parsed.summary || {}, swot: parsed.swot, strategy: parsed.strategy || {}, risks: parsed.risks || {}, declineExplanations: Array.isArray(parsed.declineExplanations) ? parsed.declineExplanations : [] };
}

module.exports = { generateSwot, buildPrompt, extractJson };
