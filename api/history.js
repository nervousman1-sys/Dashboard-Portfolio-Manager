// ========== Vercel Serverless Function — Daily Price History Proxy ==========
//
// The browser cannot reliably fetch Yahoo Finance: Yahoo sends no CORS headers, and
// the public CORS proxies (corsproxy.io / allorigins) are flaky. When history
// fetching fails, the risk model gets no real price series → variance/beta collapse
// to ~0 → the CML/SML charts show a meaningless vertical line.
//
// This same-origin function fetches Yahoo server-side (no CORS, no rate limit) and
// returns clean chronological [{date, close}]. Single or batched:
//
//   /api/history?symbol=SPY&range=1y
//       → { symbol, points: [ {date:'YYYY-MM-DD', close: 123.4}, ... ] }
//
//   /api/history?symbols=SPY,AAPL,NVDA&range=1y
//       → { SPY: [...], AAPL: [...], NVDA: [...] }   (one round-trip)

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
}

async function fetchYahoo(symbol, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?range=${encodeURIComponent(range || '1y')}&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
    const j = await r.json();
    const result = j && j.chart && j.chart.result && j.chart.result[0];
    const ts = result && result.timestamp;
    const closes = result && result.indicators && result.indicators.quote && result.indicators.quote[0]
        && result.indicators.quote[0].close;
    if (!ts || !closes) return [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c != null && isFinite(c) && c > 0) {
            out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
        }
    }
    return out;
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    try {
        const q = req.query || {};
        const range = q.range || '1y';

        if (q.symbols) {
            const syms = String(q.symbols).split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
            const entries = await Promise.all(syms.map(async (s) => {
                try { return [s, await fetchYahoo(s, range)]; } catch (e) { return [s, null]; }
            }));
            const out = {};
            for (const [s, v] of entries) out[s] = v;
            res.status(200).json(out);
            return;
        }

        const symbol = q.symbol;
        if (!symbol) { res.status(400).json({ error: 'missing symbol or symbols' }); return; }
        const points = await fetchYahoo(symbol, range);
        res.status(200).json({ symbol, points });
    } catch (e) {
        res.status(502).json({ error: 'history_proxy_failed', message: e.message });
    }
};
