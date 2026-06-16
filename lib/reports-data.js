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

// Some env vars were saved with the var name accidentally prefixed into the value
// (e.g. "FMP_API_KEY=abc123"). build.js cleans this for the client bundle, but this
// server-side lib reads process.env directly — so strip the prefix here too, else
// FMP rejects the key with "Invalid API KEY".
function cleanKey(v) {
    if (!v) return '';
    let s = String(v).trim();
    if (s.startsWith('FMP_API_KEY=')) s = s.slice('FMP_API_KEY='.length).trim();
    return s;
}
const FMP_KEY = cleanKey(process.env.FMP_API_KEY) || 'PNbEHsY2AO0v9ZkYh69P7nTvyUUckcpp';
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
            costOfRevenue: num(pick(i, 'costOfRevenue')),
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
            dna: num(pick(c, 'depreciationAndAmortization', 'depreciationAndAmortizationCashFlow')),
            ebitda: num(pick(i, 'ebitda')),
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
// Each metric maps to an ORDERED list of Yahoo timeseries types; the first that
// has a value for a quarter wins. Multiple candidates close gaps where a company
// reports under an alternate line item (e.g. BasicEPS instead of DilutedEPS).
const YH_TYPES = {
    revenue: ['TotalRevenue', 'OperatingRevenue'],
    grossProfit: ['GrossProfit'],
    operatingIncome: ['OperatingIncome', 'TotalOperatingIncomeAsReported'],
    netIncome: ['NetIncome', 'NetIncomeCommonStockholders', 'NetIncomeContinuousOperations'],
    totalEquity: ['StockholdersEquity', 'TotalEquityGrossMinorityInterest'],
    totalLiabilities: ['TotalLiabilitiesNetMinorityInterest'],
    currentAssets: ['CurrentAssets'],
    currentLiabilities: ['CurrentLiabilities'],
    totalDebt: ['TotalDebt', 'NetDebt'],
    cash: ['CashAndCashEquivalents', 'CashCashEquivalentsAndShortTermInvestments'],
    operatingCashFlow: ['OperatingCashFlow', 'CashFlowFromContinuingOperatingActivities'],
    capex: ['CapitalExpenditure'],
    eps: ['DilutedEPS', 'BasicEPS'],
    sharesOut: ['DilutedAverageShares', 'BasicAverageShares', 'ShareIssued', 'OrdinarySharesNumber'],
    ebitda: ['EBITDA', 'NormalizedEBITDA'],
    dna: ['ReconciledDepreciation', 'DepreciationAmortizationDepletion', 'DepreciationAndAmortizationInIncomeStatement'],
    costOfRevenue: ['CostOfRevenue', 'ReconciledCostOfRevenue'],
};
const YH_ALL_TYPES = [...new Set(Object.values(YH_TYPES).flat())];

function yhSeriesUrl(symbol, prefix) {
    const types = YH_ALL_TYPES.map(t => prefix + t).join(',');
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
        for (const type of YH_TYPES[field]) {
            const m = byType[type];
            if (m && m[date] !== undefined && m[date] !== null) return m[date];
        }
        return null;
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
        ebitda: at('ebitda', date), dna: at('dna', date), costOfRevenue: at('costOfRevenue', date),
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

// market: 'il' → Yahoo. US → FMP first (richer profile: sector/beta/P-E), then fall
// back to Yahoo (free + unlimited) on quota/invalid-key/no-data, so US reports keep
// working even when the FMP free-tier daily cap (~250 calls) is exhausted.
// Throws Error with .kind ('limit'|'nodata') only if BOTH sources fail.
async function fetchReport(symbol, market, opts) {
    const sym = String(symbol || '').trim().toUpperCase();
    const mkt = market || (sym.endsWith('.TA') ? 'il' : 'us');
    if (mkt === 'il') {
        const data = await fetchYahooReport(sym);
        return { symbol: sym, market: mkt, ...data };
    }
    // Fast path (bulk board scoring): Yahoo first (free, no FMP quota), FMP as backup.
    if (opts && opts.yahooFirst) {
        try {
            const data = await fetchYahooReport(sym);
            if (data.quarters && data.quarters.length) return { symbol: sym, market: mkt, ...data };
        } catch (e) { /* fall through to FMP */ }
    }
    let fmpErr = null;
    try {
        const data = await fetchFmpReport(sym);
        if (data.quarters && data.quarters.length) return { symbol: sym, market: mkt, ...data };
        fmpErr = Object.assign(new Error('no fmp quarters'), { kind: 'nodata' });
    } catch (e) {
        fmpErr = e;
    }
    // FMP unavailable → Yahoo fallback (works for US tickers too).
    try {
        const data = await fetchYahooReport(sym);
        if (data.quarters && data.quarters.length) return { symbol: sym, market: mkt, ...data };
    } catch (e2) { /* both failed — surface the FMP error below */ }
    throw fmpErr || Object.assign(new Error('no data'), { kind: 'nodata' });
}

module.exports = { fetchReport, FMP_KEY };
