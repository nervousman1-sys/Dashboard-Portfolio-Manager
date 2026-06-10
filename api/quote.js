// ========== Vercel Serverless Function — Live Quote Proxy (batch) ==========
//
// The browser cannot call Yahoo Finance directly (no CORS), so live prices went
// through flaky public proxies (corsproxy.io / allorigins) — slow, rate-limited,
// and the reason TA-35 often showed nothing. This same-origin function fetches
// Yahoo server-side (no CORS, fast) and supports BATCHING, so the quick-watch bar
// resolves all its tickers in ONE round-trip.
//
//   /api/quote?symbols=SPY,QQQ,EWG,TA35.TA
//     → { "SPY": { price, prevClose, currency }, "TA35.TA": {...}, ... }
//
// Prices are returned RAW (no agurot division) along with the Yahoo currency —
// the client keeps its existing TASE agurot/points logic.

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    // Quotes are near-real-time: cache briefly at the edge to absorb bursts
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
}

async function fetchQuote(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!m || !(m.regularMarketPrice > 0)) return null;
    return {
        price: m.regularMarketPrice,
        prevClose: m.chartPreviousClose || m.previousClose || m.regularMarketPrice,
        currency: m.currency || 'USD',
    };
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const syms = String(req.query.symbols || req.query.symbol || '')
            .split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
        if (!syms.length) { res.status(400).json({ error: 'missing symbols' }); return; }
        const entries = await Promise.all(syms.map(async (s) => {
            try { return [s, await fetchQuote(s)]; } catch (e) { return [s, null]; }
        }));
        const out = {};
        for (const [s, v] of entries) if (v) out[s] = v;
        res.status(200).json(out);
    } catch (e) {
        res.status(502).json({ error: 'quote_failed', message: e.message });
    }
};
