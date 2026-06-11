// ========== Vercel Serverless Function — CNN Fear & Greed Proxy ==========
//
// The EXACT CNN Fear & Greed index (the one at cnn.com/markets/fear-and-greed).
// CNN blocks plain clients ("I'm a teapot") but serves the JSON to browser-like
// requests; the browser itself can't call it (CORS), so we proxy server-side.
//
//   /api/feargreed → { score: 27.2, rating: "fear", previousClose, ts }

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://www.cnn.com/markets/fear-and-greed',
                'Origin': 'https://www.cnn.com',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });
        if (!r.ok) throw new Error(`CNN HTTP ${r.status}`);
        const j = await r.json();
        const fg = j && j.fear_and_greed;
        if (!fg || !(fg.score >= 0)) throw new Error('unexpected CNN payload');
        // F&G updates intraday — cache 15 min at the edge
        res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
        res.status(200).json({
            score: Math.round(fg.score * 10) / 10,
            rating: fg.rating || '',
            previousClose: fg.previous_close != null ? Math.round(fg.previous_close * 10) / 10 : null,
            ts: fg.timestamp || null,
            source: 'CNN Fear & Greed',
        });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'feargreed_failed', message: e.message });
    }
};
