// ========== Vercel Serverless Function — Google Finance Smart Redirect ==========
//
// Google Finance moved to a /beta UI whose exchange mapping no longer matches a
// static map (e.g. its own resolver sends WMT to WMT:NASDAQ). A wrong venue shows
// "לא מצאנו תוצאות". This endpoint resolves the RIGHT page server-side and 302s:
//
//   /api/gf?t=WMT  →  302 https://www.google.com/finance/beta/quote/WMT:NASDAQ
//
// Resolution order:
//   1. Google's own ?q= resolver (authoritative — follow its redirect), 2 attempts
//   2. Curated exchange map (direct quote URL)
//   3. Google search "TICKER stock" (always shows the finance panel)

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/',
};

const EXCHANGE_MAP = {
    AAPL: 'NASDAQ', MSFT: 'NASDAQ', NVDA: 'NASDAQ', GOOGL: 'NASDAQ', AMZN: 'NASDAQ', META: 'NASDAQ',
    AVGO: 'NASDAQ', NFLX: 'NASDAQ', AMD: 'NASDAQ', COST: 'NASDAQ', TSLA: 'NASDAQ', PEP: 'NASDAQ',
    SBUX: 'NASDAQ', CSCO: 'NASDAQ', QCOM: 'NASDAQ', TXN: 'NASDAQ', INTC: 'NASDAQ', ADBE: 'NASDAQ',
    AMGN: 'NASDAQ', HON: 'NASDAQ', QQQ: 'NASDAQ', TLT: 'NASDAQ', IEF: 'NASDAQ',
    CRM: 'NYSE', ORCL: 'NYSE', T: 'NYSE', VZ: 'NYSE', JPM: 'NYSE', V: 'NYSE', MA: 'NYSE',
    BAC: 'NYSE', WFC: 'NYSE', GS: 'NYSE', MS: 'NYSE', AXP: 'NYSE', SCHW: 'NYSE', BLK: 'NYSE',
    UNH: 'NYSE', JNJ: 'NYSE', LLY: 'NYSE', ABBV: 'NYSE', MRK: 'NYSE', PFE: 'NYSE', TMO: 'NYSE',
    ABT: 'NYSE', DHR: 'NYSE', XOM: 'NYSE', CVX: 'NYSE', COP: 'NYSE', SLB: 'NYSE', EOG: 'NYSE',
    PG: 'NYSE', KO: 'NYSE', WMT: 'NYSE', HD: 'NYSE', MCD: 'NYSE', NKE: 'NYSE', DIS: 'NYSE', LOW: 'NYSE',
    CAT: 'NYSE', BA: 'NYSE', GE: 'NYSE', UPS: 'NYSE', RTX: 'NYSE',
    SPY: 'NYSEARCA', VOO: 'NYSEARCA', DIA: 'NYSEARCA', IWM: 'NYSEARCA', GLD: 'NYSEARCA',
    SCHD: 'NYSEARCA', LQD: 'NYSEARCA',
    XLF: 'NYSEARCA', XLV: 'NYSEARCA', XLE: 'NYSEARCA', XLK: 'NYSEARCA', XLI: 'NYSEARCA', XLP: 'NYSEARCA',
};

// Warm-instance memo so repeat clicks resolve instantly
const _resolved = new Map();

async function resolveViaGoogle(query) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await fetch(`https://www.google.com/finance?q=${encodeURIComponent(query)}`,
                { headers: HEADERS, redirect: 'follow' });
            if (r.ok && r.url && r.url.includes('/quote/')) return r.url;
        } catch (e) { /* retry */ }
    }
    return null;
}

module.exports = async (req, res) => {
    const raw = String(req.query.t || '').toUpperCase().trim();
    if (!raw) { res.statusCode = 302; res.setHeader('Location', 'https://www.google.com/finance'); res.end(); return; }

    const isTase = /\.TA$/.test(raw);
    const base = isTase ? raw.replace(/\.TA$/, '') : raw;
    const query = isTase ? `${base}:TLV` : base;

    let dest = _resolved.get(raw) || null;

    // 1. Google's own resolver
    if (!dest) dest = await resolveViaGoogle(query);

    // 2. Curated map → direct quote page
    if (!dest) {
        if (isTase) dest = `https://www.google.com/finance/quote/${encodeURIComponent(base)}:TLV`;
        else if (EXCHANGE_MAP[base]) dest = `https://www.google.com/finance/quote/${encodeURIComponent(base)}:${EXCHANGE_MAP[base]}`;
    }

    // 3. Google search — always lands on the finance panel
    if (!dest) dest = `https://www.google.com/search?q=${encodeURIComponent(base + ' stock')}`;

    _resolved.set(raw, dest);
    // Cache the redirect at the edge for a day — listings don't move daily
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.statusCode = 302;
    res.setHeader('Location', dest);
    res.end();
};
