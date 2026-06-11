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
const MODEL = 'gemini-2.0-flash';

const PROMPTS = {
    transcribe: 'התמונה מכילה עדכון חדשות כלכלי בעברית. תמלל את כל הטקסט שכתוב בתמונה, בעברית, נאמן למקור, מאורגן בשורות עם כותרות המשנה. אל תוסיף הערות משלך — רק את התוכן שבתמונה.',
    summary: 'התמונה מכילה טבלה/דוח פיננסי. סכם בעברית בקצרה את התוכן: כל פריט/עדכון בשורה נפרדת עם הנתונים המספריים החשובים (שמות, סכומים, כיוונים). בלי הקדמות ובלי הערות — רק השורות.',
};

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
        const mode = req.query.mode === 'summary' ? 'summary' : 'transcribe';
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

        const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: PROMPTS[mode] },
                        { inline_data: { mime_type: mime, data: buf.toString('base64') } },
                    ],
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
            }),
        });
        if (!gr.ok) {
            const body = await gr.text().catch(() => '');
            throw new Error(`gemini ${gr.status}: ${body.slice(0, 140)}`);
        }
        const gj = await gr.json();
        const text = (((gj.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join('\n').trim() || '';
        if (!text) throw new Error('empty vision result');

        _memo.set(memoKey, text);
        // The image never changes → cache hard at the edge
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
        res.status(200).json({ text });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'vision_failed', message: e.message });
    }
};
