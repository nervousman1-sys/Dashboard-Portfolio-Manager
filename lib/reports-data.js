// ========== Shared lib — Financial report normalization (US FMP + IL Yahoo) ==========
//
// Lives OUTSIDE api/ so it does NOT count as a Vercel serverless function (the project
// is at the Hobby-plan 12-function cap). Imported by api/technicals.js (?mode=report).
//
// fetchReport(symbol, market) → normalized 8-quarter financials + profile:
//   { symbol, market, source, companyName, sector, currency, price, marketCap, beta,
//     asOf, quarters: [ { date, period, fiscalYear, revenue, grossProfit,
//     operatingIncome, netIncome, eps, totalEquity, totalLiabilities, currentAssets,
//     currentLiabilities, totalDebt, cash, operatingCashFlow, capex, sharesOut } ] }
//
// US  → Financial Modeling Prep /stable (income+balance+cashflow quarter + profile).
// IL (.TA) → Yahoo fundamentals-timeseries (FMP blocks IL fundamentals on free tier).

const FMP_KEY = process.env.FMP_API_KEY || 'PNbEHsY2AO0v9ZkYh69P7nTvyUUckcpp';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' };

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

    if (!Array.isArray(inc)) {
        const msg = (inc && (inc['Error Message'] || inc['Premium Query Parameter'])) || 'no data';
        const e = new Error(msg);
        e.kind = /limit/i.test(String(msg)) ? 'limit' : 'nodata';
        throw e;
    }
    const balArr = Array.isArray(bal) ? bal : [], cfArr = Array.isArray(cf) ? cf : [];
    const profile = (Array.isArray(prof) && prof[0]) ? prof[0] : {};
    const balByDate = {}; balArr.forEach(b => { balByDate[b.date] = b; });
    const cfByDate = {}; cfArr.forEach(c => { cfByDate[c.date] = c; });

    const quarters = inc.slice(0, 8).map(i => {
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
        currency: profile.currency || inc[0]?.reportedCurrency || 'USD',
        price: num(profile.price),
        marketCap: num(profile.marketCap),
        beta: num(profile.beta),
        asOf: inc[0]?.filingDate || inc[0]?.date || null,
        quarters,
    };
}

// ────────────────────────── IL (Yahoo) ──────────────────────────
const YH_TYPES = {
    revenue: 'TotalRevenue', grossProfit: 'GrossProfit', operatingIncome: 'OperatingIncome',
    netIncome: 'NetIncome', totalEquity: 'StockholdersEquity',
    totalLiabilities: 'TotalLiabilitiesNetMinorityInterest', currentAssets: 'CurrentAssets',
    currentLiabilities: 'CurrentLiabilities', totalDebt: 'TotalDebt', cash: 'CashAndCashEquivalents',
    operatingCashFlow: 'OperatingCashFlow', capex: 'CapitalExpenditure', eps: 'DilutedEPS',
    sharesOut: 'ShareIssued',
};

function yhSeriesUrl(symbol, prefix) {
    const types = Object.values(YH_TYPES).map(t => prefix + t).join(',');
    const p1 = Math.floor(Date.now() / 1000) - 3 * 365 * 24 * 3600 - 200 * 24 * 3600;
    const p2 = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    return `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
        `?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${p1}&period2=${p2}&merge=false`;
}

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
            if (r && r.asOfDate && r.reportedValue && r.reportedValue.raw !== undefined) byType[key][r.asOfDate] = Number(r.reportedValue.raw);
        });
    });
    return byType;
}

async function fetchYahooReport(symbol) {
    let prefix = 'quarterly';
    let r = await fetch(yhSeriesUrl(symbol, prefix), { headers: UA });
    let j = await r.json();
    let byType = indexYhResults(j?.timeseries?.result, prefix);
    let dates = new Set();
    Object.values(byType).forEach(m => Object.keys(m).forEach(d => dates.add(d)));
    if (dates.size === 0) {
        prefix = 'annual';
        r = await fetch(yhSeriesUrl(symbol, prefix), { headers: UA });
        j = await r.json();
        byType = indexYhResults(j?.timeseries?.result, prefix);
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
        date, period: prefix === 'annual' ? 'FY' : null, fiscalYear: date.slice(0, 4),
        revenue: at('revenue', date), grossProfit: at('grossProfit', date),
        operatingIncome: at('operatingIncome', date), netIncome: at('netIncome', date),
        eps: at('eps', date), totalEquity: at('totalEquity', date),
        totalLiabilities: at('totalLiabilities', date), currentAssets: at('currentAssets', date),
        currentLiabilities: at('currentLiabilities', date), totalDebt: at('totalDebt', date),
        cash: at('cash', date), operatingCashFlow: at('operatingCashFlow', date),
        capex: at('capex', date), sharesOut: at('sharesOut', date),
    }));

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
    const latestShares = quarters.find(q => q.sharesOut)?.sharesOut || null;
    const marketCap = (price != null && latestShares) ? price * latestShares : null;

    return {
        source: 'yahoo', companyName, sector: null, industry: null, currency,
        price, marketCap, beta: null, asOf: sortedDates[0] || null, quarters,
    };
}

// market: 'il' → Yahoo; anything else → FMP. Throws Error with .kind ('limit'|'nodata').
async function fetchReport(symbol, market) {
    const sym = String(symbol || '').trim().toUpperCase();
    const mkt = market || (sym.endsWith('.TA') ? 'il' : 'us');
    const data = mkt === 'il' ? await fetchYahooReport(sym) : await fetchFmpReport(sym);
    return { symbol: sym, market: mkt, ...data };
}

module.exports = { fetchReport, FMP_KEY };
