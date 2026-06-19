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
    return `אתה אנליסט מאקרו ופונדמנטלי בכיר. נתח את החברה "${d.company || d.symbol}" (טיקר ${d.symbol}${d.sector ? ', סקטור ' + d.sector : ''}).
להלן נתונים פונדמנטליים מהדו"ח הכספי האחרון:
${lines || '(אין נתונים מספריים זמינים — הסתמך על ידע ציבורי על החברה)'}${flags}${declines}

החזר אך ורק אובייקט JSON תקין (ללא טקסט נוסף, ללא markdown, ללא \`\`\`) במבנה המדויק הבא:
{
  "summary": {
    "activitySector": "סקטור הפעילות של החברה ותחום העיסוק העיקרי שלה — משפט קצר וברור.",
    "mainGrowthDivision": "הענף / קו-המוצר / הסגמנט שהוא מנוע הצמיחה העיקרי של החברה כיום, ומדוע.",
    "hurtDivision": "אם ענף/סגמנט מסוים נפגע (ירידה בהכנסות או ברווחיות) — ציין איזה ומדוע, על בסיס הנתונים והידע על החברה. אם לא נפגע ענף מהותי — ציין זאת במפורש.",
    "declineReasons": "אם יש ירידה בתזרים או ברווחיות — הסבר את הסיבות העיקריות לכך (למשל השקעות הוניות מוגברות, לחץ תמחור, עלייה בעלויות, חולשה עונתית). אם אין ירידה — ציין יציבות/צמיחה והסבר בקצרה.",
    "investments": "ההשקעות המרכזיות של החברה. אם סופק נתון הוצאות מו\\"פ (rdExpenseTTM) — ציין אותו. כלול גם CapEx/רכישות/הרחבות מהותיות אם רלוונטי.",
    "rdFocus": "ניתוח חכם וספציפי של מאמץ המו\\"פ: לאיזו חטיבה / קו-מוצר / סגמנט עסקי בחברה מופנה עיקר המחקר והפיתוח, ומה בדיוק מפתחים שם (טכנולוגיות, ארכיטקטורות או מוצרים קונקרטיים), על בסיס ידע ציבורי על החברה — לא ניסוח גנרי. אם לחברה כמה חטיבות, ציין איזו מהן זוללת את רוב תקציב המו\\"פ ומדוע.",
    "partnerships": "שותפויות אסטרטגיות מהותיות וספציפיות של החברה (ספקים, לקוחות-ענק, מיזמים משותפים, שותפי טכנולוגיה/הפצה) — ציין שמות. אם אין שותפויות מהותיות ידועות — ציין זאת בקצרה.",
    "keyCustomers": "הלקוחות, הסגמנטים או השווקים הגאוגרפיים המרכזיים של החברה — שמות ספציפיים כשידועים.",
    "recentDeals": "חוזים, הזמנות או עסקאות גדולות וספציפיות שהחברה סגרה לאחרונה (על בסיס ידע ציבורי) — ציין שמות ומהות. אל תכתוב 'לא ידוע' אם קיים מידע ציבורי רלוונטי; רק אם באמת אין — ציין זאת בקצרה.",
    "insiderActivity": "אם סופקו נתוני עסקאות בעלי עניין (recentInsiderTrades) — סכם אותם בקצרה בעברית, בדגש על קניות מהותיות של מנהלים/דירקטורים (מי, מתי, היקף משוער), וציין אם המגמה היא קנייה או מכירה. אם לא סופקו נתונים אך ידועה לך פעילות בעלי עניין מהותית מהידע הציבורי — ציין אותה בזהירות. רק אם באמת אין מידע — ציין שאין מידע זמין."
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
    "לכל ירידה חדה שצוינה למעלה — משפט קצר, חכם וספציפי שמסביר את הסיבה הסבירה לה על בסיס מה שידוע על החברה ועל הסקטור (למשל: השקעות הוניות מוגברות שלחצו על ה-FCF, עלייה בהון חוזר, חולשה עונתית מוכרת ברבעון זה, לחץ תחרותי/תמחור, הוצאה חד-פעמית, האטה בביקושים בשוק מסוים). נסח כל הסבר אחרת — לא משפטי-תבנית גנריים כמו 'היחלשות מגמתית'. אם באמת אין סיבה ידועה ספציפית, כתוב הסבר אנליטי קצר ולא רובוטי. החזר פריט אחד לכל ירידה, באותו סדר."
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
    for (const model of MODELS) {
        const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
        });
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
