// ========== Vercel Serverless Function — Financial Reports (דוחות כספיים) ==========
//
//   /api/reports?mode=report&symbol=AAPL&market=us
//   /api/reports?mode=report&symbol=POLI.TA&market=il
//     → normalized 8-quarter financials + company profile, source-agnostic:
//       { symbol, market, source, companyName, sector, currency, price, marketCap,
//         beta, asOf, quarters: [ { date, period, fiscalYear, revenue, grossProfit,
//         operatingIncome, netIncome, eps, totalEquity, totalLiabilities,
//         currentAssets, currentLiabilities, totalDebt, cash, operatingCashFlow,
//         capex, sharesOut } ... ]  // newest first
//       }
//
// US  → Financial Modeling Prep /stable income+balance+cashflow (period=quarter) + profile.
//       Key stays server-side. FMP free tier is ~250 calls/day, so the client fetches a
//       report ONLY when a company is opened, and the edge cache below makes repeat /
//       popular views free (shared across users).
// IL (.TA) → FMP blocks Israeli fundamentals (Premium), so we use Yahoo's public
//       fundamentals-timeseries endpoint (no auth) + Yahoo chart meta for price.
//       Coverage varies per ticker; missing fields come back null ("לא זמין" in the UI).

const FMP_KEY = process.env.FMP_API_KEY || 'PNbEHsY2AO0v9ZkYh69P7nTvyUUckcpp';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' };

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

// First non-null/finite value among several candidate keys (handles FMP schema variants).
function pick(obj, ...keys) {
    for (const k of keys) {
        const v = obj && obj[k];
        if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) return v;
    }
    return null;
}
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);

// ────────────────────────── US (FMP) ──────────────────────────
async function fetchFmpReport(symbol) {
    const base = 'https://financialmodelingprep.com/stable';
    const q = `symbol=${encodeURIComponent(symbol)}&period=quarter&limit=8&apikey=${FMP_KEY}`;
    const [incR, balR, cfR, profR] = await Promise.all([
        fetch(`${base}/income-statement?${q}`, { headers: UA }),
        fetch(`${base}/balance-sheet-statement?${q}`, { headers: UA }),
        fetch(`${base}/cash-flow-statement?${q}`, { headers: UA }),
        fetch(`${base}/profile?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`, { headers: UA }),
    ]);
    const [inc, bal, cf, prof] = await Promise.all([incR.json(), balR.json(), cfR.json(), profR.json()]);

    // FMP signals limit / premium / errors as a non-array object — surface a clean error.
    const bad = (x) => !Array.isArray(x);
    if (bad(inc)) {
        const msg = (inc && (inc['Error Message'] || inc['Premium Query Parameter'])) || 'no data';
        const e = new Error(msg);
        e.kind = /limit/i.test(String(msg)) ? 'limit' : 'nodata';
        throw e;
    }
    const incArr = inc, balArr = Array.isArray(bal) ? bal : [], cfArr = Array.isArray(cf) ? cf : [];
    const profile = (Array.isArray(prof) && prof[0]) ? prof[0] : {};

    // Index balance/cashflow by report date so quarters line up even if counts differ.
    const balByDate = {}; balArr.forEach(b => { balByDate[b.date] = b; });
    const cfByDate = {}; cfArr.forEach(c => { cfByDate[c.date] = c; });

    const quarters = incArr.slice(0, 8).map(i => {
        const b = balByDate[i.date] || {};
        const c = cfByDate[i.date] || {};
        return {
            date: i.date,
            period: i.period || null,
            fiscalYear: i.fiscalYear || null,
            revenue: num(pick(i, 'revenue')),
            grossProfit: num(pick(i, 'grossProfit')),
            operatingIncome: num(pick(i, 'operatingIncome', 'operatingProfit')),
            netIncome: num(pick(i, 'netIncome', 'bottomLineNetIncome')),
            eps: num(pick(i, 'epsDiluted', 'eps')),
            totalEquity: num(pick(b, 'totalStockholdersEquity', 'totalEquity')),
            totalLiabilities: num(pick(b, 'totalLiabilities')),
            currentAssets: num(pick(b, 'totalCurrentAssets')),
            currentLiabilities: num(pick(b, 'totalCurrentLiabilities')),
            totalDebt: num(pick(b, 'totalDebt')),
            cash: num(pick(b, 'cashAndCashEquivalents', 'cashAndShortTermInvestments')),
            operatingCashFlow: num(pick(c, 'operatingCashFlow', 'netCashProvidedByOperatingActivities')),
            capex: num(pick(c, 'capitalExpenditure')),
            sharesOut: num(pick(i, 'weightedAverageShsOutDil', 'weightedAverageShsOut')),
        };
    });

    return {
        source: 'fmp',
        companyName: profile.companyName || symbol,
        sector: profile.sector || null,
        industry: profile.industry || null,
        currency: profile.currency || incArr[0]?.reportedCurrency || 'USD',
        price: num(profile.price),
        marketCap: num(profile.marketCap),
        beta: num(profile.beta),
        asOf: incArr[0]?.filingDate || incArr[0]?.date || null,
        quarters,
    };
}

// ────────────────────────── IL (Yahoo) ──────────────────────────
const YH_TYPES = {
    revenue: 'TotalRevenue',
    grossProfit: 'GrossProfit',
    operatingIncome: 'OperatingIncome',
    netIncome: 'NetIncome',
    totalEquity: 'StockholdersEquity',
    totalLiabilities: 'TotalLiabilitiesNetMinorityInterest',
    currentAssets: 'CurrentAssets',
    currentLiabilities: 'CurrentLiabilities',
    totalDebt: 'TotalDebt',
    cash: 'CashAndCashEquivalents',
    operatingCashFlow: 'OperatingCashFlow',
    capex: 'CapitalExpenditure',
    eps: 'DilutedEPS',
    sharesOut: 'ShareIssued',
};

function yhSeriesUrl(symbol, prefix) {
    const types = Object.values(YH_TYPES).map(t => prefix + t).join(',');
    const p1 = Math.floor(Date.now() / 1000) - 3 * 365 * 24 * 3600 - 200 * 24 * 3600; // ~3.5y back
    const p2 = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    return `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
        `?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${p1}&period2=${p2}&merge=false`;
}

// Yahoo returns one result block per type; flatten into { type: { asOfDate: raw } }.
function indexYhResults(result, prefix) {
    const byType = {};
    (result || []).forEach(block => {
        const t = block?.meta?.type?.[0];
        if (!t) return;
        const key = t.replace(prefix, '');
        const rows = block[t];
        if (!Array.isArray(rows)) return;
        byType[key] = byType[key] || {};
        rows.forEach(r => {
            if (r && r.asOfDate && r.reportedValue && r.reportedValue.raw !== undefined) {
                byType[key][r.asOfDate] = Number(r.reportedValue.raw);
            }
        });
    });
    return byType;
}

async function fetchYahooReport(symbol) {
    // Quarterly first; fall back to annual when a ticker has no quarterly coverage.
    let prefix = 'quarterly';
    let r = await fetch(yhSeriesUrl(symbol, prefix), { headers: UA });
    let j = await r.json();
    let result = j?.timeseries?.result;
    let byType = indexYhResults(result, prefix);
    let dates = new Set();
    Object.values(byType).forEach(m => Object.keys(m).forEach(d => dates.add(d)));
    if (dates.size === 0) {
        prefix = 'annual';
        r = await fetch(yhSeriesUrl(symbol, prefix), { headers: UA });
        j = await r.json();
        result = j?.timeseries?.result;
        byType = indexYhResults(result, prefix);
        dates = new Set();
        Object.values(byType).forEach(m => Object.keys(m).forEach(d => dates.add(d)));
    }
    if (dates.size === 0) { const e = new Error('no yahoo fundamentals'); e.kind = 'nodata'; throw e; }

    const sortedDates = [...dates].sort((a, b) => b.localeCompare(a)).slice(0, 8);
    const at = (field, date) => {
        const m = byType[YH_TYPES[field]];
        return (m && m[date] !== undefined) ? m[date] : null;
    };
    const quarters = sortedDates.map(date => ({
        date,
        period: prefix === 'annual' ? 'FY' : null,
        fiscalYear: date.slice(0, 4),
        revenue: at('revenue', date),
        grossProfit: at('grossProfit', date),
        operatingIncome: at('operatingIncome', date),
        netIncome: at('netIncome', date),
        eps: at('eps', date),
        totalEquity: at('totalEquity', date),
        totalLiabilities: at('totalLiabilities', date),
        currentAssets: at('currentAssets', date),
        currentLiabilities: at('currentLiabilities', date),
        totalDebt: at('totalDebt', date),
        cash: at('cash', date),
        operatingCashFlow: at('operatingCashFlow', date),
        capex: at('capex', date),
        sharesOut: at('sharesOut', date),
    }));

    // Price + market cap from Yahoo chart meta (same source as api/technicals).
    let price = null, currency = 'ILS', companyName = symbol.replace(/\.TA$/, '');
    try {
        const cr = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, { headers: UA });
        const cj = await cr.json();
        const meta = cj?.chart?.result?.[0]?.meta;
        if (meta) {
            price = num(meta.regularMarketPrice);
            currency = meta.currency || currency;
            if (meta.shortName || meta.longName) companyName = meta.longName || meta.shortName;
        }
    } catch (e) { /* price optional */ }
    // Israeli equity prices are quoted in agorot on Yahoo for many tickers; market cap
    // = price × shares is approximate and only used for P/B context, never headline.
    const latestShares = quarters.find(q => q.sharesOut)?.sharesOut || null;
    const marketCap = (price != null && latestShares) ? price * latestShares : null;

    return {
        source: 'yahoo',
        companyName,
        sector: null,
        industry: null,
        currency,
        price,
        marketCap,
        beta: null,
        asOf: sortedDates[0] || null,
        quarters,
    };
}

module.exports = async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const mode = (req.query.mode || 'report').toString();
    if (mode !== 'report') { res.status(400).json({ error: 'unknown mode' }); return; }

    const symbol = (req.query.symbol || '').toString().trim().toUpperCase();
    const market = (req.query.market || (symbol.endsWith('.TA') ? 'il' : 'us')).toString();
    if (!symbol) { res.status(400).json({ error: 'symbol required' }); return; }

    try {
        const data = market === 'il' ? await fetchYahooReport(symbol) : await fetchFmpReport(symbol);
        if (!data.quarters || !data.quarters.length) { res.status(404).json({ error: 'no data', symbol }); return; }
        // Edge-cache so the latest filed report is auto-served and repeat views cost no API calls.
        res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
        res.status(200).json({ symbol, market, ...data });
    } catch (e) {
        const kind = e.kind || 'error';
        const status = kind === 'limit' ? 429 : kind === 'nodata' ? 404 : 502;
        res.status(status).json({ error: kind, message: String(e.message || e), symbol, market });
    }
};
