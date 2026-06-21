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
// the provider rejects the key as invalid.
function cleanKey(name, v) {
    if (!v) return '';
    let s = String(v).trim();
    if (s.startsWith(name + '=')) s = s.slice(name.length + 1).trim();
    return s;
}
const FMP_KEY = cleanKey('FMP_API_KEY', process.env.FMP_API_KEY) || 'PNbEHsY2AO0v9ZkYh69P7nTvyUUckcpp';
const FINNHUB_KEY = cleanKey('FINNHUB_API_KEY', process.env.FINNHUB_API_KEY);

// Beta isn't on the Yahoo fundamentals path; pull it from Finnhub (free) so reports
// show it even when FMP (which carries beta in its profile) is unavailable.
async function fetchFinnhubBeta(symbol) {
    if (!FINNHUB_KEY) return null;
    try {
        const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${FINNHUB_KEY}`, { headers: UA });
        if (!r.ok) return null;
        const j = await r.json();
        const b = j && j.metric && j.metric.beta;
        return (typeof b === 'number' && isFinite(b)) ? b : null;
    } catch (e) { return null; }
}
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
            pretaxIncome: num(pick(i, 'incomeBeforeTax', 'pretaxIncome')),
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
            rd: num(pick(i, 'researchAndDevelopmentExpenses', 'researchAndDevelopmentExpense')),
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
    operatingIncome: ['OperatingIncome', 'TotalOperatingIncomeAsReported', 'EBIT'],
    pretaxIncome: ['PretaxIncome'],
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
    rd: ['ResearchAndDevelopment'],
};
const YH_ALL_TYPES = [...new Set(Object.values(YH_TYPES).flat())];

function yhSeriesUrl(symbol, prefix, typeList) {
    const types = (typeList || YH_ALL_TYPES).map(t => prefix + t).join(',');
    const p1 = Math.floor(Date.now() / 1000) - 3 * 365 * 24 * 3600 - 200 * 24 * 3600;
    const p2 = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    return `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
        `?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${p1}&period2=${p2}&merge=false`;
}

// Yahoo blocks fundamentals-timeseries from datacenter IPs (Vercel) UNLESS the request carries a
// valid session cookie + crumb — the same handshake a browser performs. Acquire it once (consent
// cookie from fc.yahoo.com → crumb from /v1/test/getcrumb) and cache for 30 min. Without this the
// endpoint returns empty from the server even though it works from a residential IP.
let _yhSession = null; // { cookie, crumb, ts }
async function _getYhSession() {
    if (_yhSession && Date.now() - _yhSession.ts < 30 * 60 * 1000) return _yhSession;
    try {
        const r1 = await fetch('https://fc.yahoo.com', { headers: UA });
        const sc = r1.headers.get('set-cookie');
        const cookie = sc ? sc.split(';')[0] : '';
        if (!cookie) return null;
        const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
        const crumb = (await r2.text()).trim();
        if (!crumb || crumb.length > 40 || /[<{]/.test(crumb)) { _yhSession = { cookie, crumb: null, ts: Date.now() }; return _yhSession; }
        _yhSession = { cookie, crumb, ts: Date.now() };
        return _yhSession;
    } catch (e) { return null; }
}

// One request with ALL types (verified: Yahoo handles the full ~36-type list fine — a single call
// is also the GENTLEST on rate limits). Authenticated with the session cookie+crumb; retries once
// with a short backoff and rotates the host (query1 ↔ query2), which throttle independently.
async function _fetchYhTimeseries(symbol, prefix) {
    const session = await _getYhSession();
    const headers = (session && session.cookie) ? { ...UA, Cookie: session.cookie } : UA;
    const hosts = ['query2', 'query1'];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            let url = yhSeriesUrl(symbol, prefix).replace('query2', hosts[attempt % hosts.length]);
            if (session && session.crumb) url += '&crumb=' + encodeURIComponent(session.crumb);
            const r = await fetch(url, { headers });
            const j = await r.json();
            const res = j?.timeseries?.result || [];
            if (res.length) return res;
        } catch (e) { /* fall through to retry */ }
        if (attempt === 0) await new Promise(rs => setTimeout(rs, 450));
    }
    return [];
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
    let byType = indexYhResults(await _fetchYhTimeseries(symbol, prefix), prefix);
    let dates = new Set();
    Object.values(byType).forEach(m => Object.keys(m).forEach(d => dates.add(d)));
    if (dates.size === 0) {
        prefix = 'annual';
        byType = indexYhResults(await _fetchYhTimeseries(symbol, prefix), prefix);
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
    let quarters = sortedDates.map(date => ({
        date, period: prefix === 'annual' ? 'FY' : null, fiscalYear: date.slice(0, 4),
        revenue: at('revenue', date), grossProfit: at('grossProfit', date),
        operatingIncome: at('operatingIncome', date), pretaxIncome: at('pretaxIncome', date), netIncome: at('netIncome', date),
        eps: at('eps', date), totalEquity: at('totalEquity', date),
        totalLiabilities: at('totalLiabilities', date), currentAssets: at('currentAssets', date),
        currentLiabilities: at('currentLiabilities', date), totalDebt: at('totalDebt', date),
        cash: at('cash', date), operatingCashFlow: at('operatingCashFlow', date),
        capex: at('capex', date), sharesOut: at('sharesOut', date),
        ebitda: at('ebitda', date), dna: at('dna', date), costOfRevenue: at('costOfRevenue', date),
        rd: at('rd', date),
    }));
    // Drop phantom quarters that carry only a stray balance-sheet date with no P&L /
    // cash-flow data — they'd otherwise show as empty columns and empty chart bars.
    quarters = quarters.filter(q => q.revenue != null || q.netIncome != null || q.operatingCashFlow != null);

    let price = null, currency = 'ILS', companyName = symbol.replace(/\.TA$/, '');
    try {
        const cr = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, { headers: UA });
        const cj = await cr.json();
        const meta = cj?.chart?.result?.[0]?.meta;
        if (meta) {
            price = num(meta.regularMarketPrice);
            currency = meta.currency || currency;
            // TASE/.TA quotes come from Yahoo in AGOROT (1/100 ₪) with currency code 'ILA',
            // while the fundamentals (revenue, equity, net income, EPS) are in full SHEKELS.
            // Left unconverted, marketCap = agorot_price × shares is 100× too big → P/E, P/B and
            // EV/EBITDA all come out 100× inflated for every Israeli stock. Normalize to shekels.
            if (currency === 'ILA' && price != null) { price = price / 100; currency = 'ILS'; }
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
// Best-effort recent insider transactions (US/FMP only). Returns a compact, recent
// list focused on what matters for the report summary — mainly BUYS (P) by officers
// and directors. Never throws; the report renders fine without it.
async function fetchFmpInsiders(symbol) {
    try {
        const url = `https://financialmodelingprep.com/stable/insider-trading/search?symbol=${encodeURIComponent(symbol)}&page=0&limit=60&apikey=${FMP_KEY}`;
        const r = await fetch(url, { headers: UA });
        const arr = await r.json();
        if (!Array.isArray(arr) || !arr.length) return null;
        const rows = arr.map(t => {
            const isBuy = /P-Purchase|^P$|Purchase/i.test(t.transactionType || t.acquisitionOrDisposition || '');
            const shares = num(t.securitiesTransacted);
            const price = num(t.price);
            return {
                date: t.transactionDate || t.filingDate || null,
                name: t.reportingName || t.insiderName || null,
                role: t.typeOfOwner || null,
                type: isBuy ? 'buy' : 'sell',
                shares,
                value: (shares != null && price != null) ? Math.round(shares * price) : null,
            };
        }).filter(x => x.date && x.shares);
        if (!rows.length) return null;
        rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        // Prioritise recent BUYS, then keep the most recent few overall.
        const buys = rows.filter(x => x.type === 'buy').slice(0, 6);
        const recent = rows.slice(0, 8);
        const seen = new Set();
        const merged = [...buys, ...recent].filter(x => { const k = x.date + x.name + x.shares; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
        return merged;
    } catch (e) { return null; }
}

// Fill the gaps in `primary` from `secondary` so a single source's missing line items
// don't leave blank cells/charts. Profile fields prefer FMP (richer); per-quarter numeric
// fields are filled by matching report date. Never throws.
const _REPORT_NUM_FIELDS = ['revenue', 'grossProfit', 'costOfRevenue', 'operatingIncome', 'pretaxIncome', 'netIncome', 'eps', 'totalEquity', 'totalLiabilities', 'currentAssets', 'currentLiabilities', 'totalDebt', 'cash', 'operatingCashFlow', 'capex', 'sharesOut', 'dna', 'ebitda', 'rd'];
function mergeReports(primary, secondary) {
    if (!secondary || !Array.isArray(secondary.quarters) || !secondary.quarters.length) return primary;
    const out = { ...primary };
    for (const k of ['sector', 'industry', 'beta', 'price', 'marketCap', 'companyName', 'currency', 'asOf']) {
        if (out[k] == null || out[k] === '') out[k] = secondary[k] != null ? secondary[k] : out[k];
    }
    const secByDate = {};
    secondary.quarters.forEach(q => { if (q && q.date) secByDate[String(q.date).slice(0, 7)] = q; }); // match on YYYY-MM (period end)
    out.quarters = (primary.quarters || []).map(q => {
        const s = secByDate[String(q.date).slice(0, 7)];
        if (!s) return q;
        const merged = { ...q };
        for (const f of _REPORT_NUM_FIELDS) if (merged[f] == null && s[f] != null) merged[f] = s[f];
        return merged;
    });
    out.source = primary.source + '+' + secondary.source;
    return out;
}

async function fetchReport(symbol, market, opts) {
    const sym = String(symbol || '').trim().toUpperCase();
    const mkt = market || (sym.endsWith('.TA') ? 'il' : 'us');
    if (mkt === 'il') {
        const data = await fetchYahooReport(sym);
        return { symbol: sym, market: mkt, ...data };
    }
    const fast = !!(opts && opts.yahooFirst);
    let result = null, fmpErr = null;
    // Fast path (bulk board scoring): Yahoo only (free, no FMP quota).
    if (fast) {
        try { const d = await fetchYahooReport(sym); if (d.quarters && d.quarters.length) result = { symbol: sym, market: mkt, ...d }; } catch (e) { /* fall through */ }
    }
    // DETAIL view: fetch BOTH sources in parallel and merge, so a gap in one source
    // (a missing quarter field, R&D, sector…) is filled from the other — no blank cells.
    if (!result && !fast) {
        const [fmpR, yhR] = await Promise.allSettled([fetchFmpReport(sym), fetchYahooReport(sym)]);
        const fmp = (fmpR.status === 'fulfilled' && fmpR.value && fmpR.value.quarters && fmpR.value.quarters.length) ? fmpR.value : null;
        const yh = (yhR.status === 'fulfilled' && yhR.value && yhR.value.quarters && yhR.value.quarters.length) ? yhR.value : null;
        if (fmpR.status === 'rejected') fmpErr = fmpR.reason;
        const merged = fmp && yh ? mergeReports(fmp, yh) : (fmp || yh);
        if (merged) result = { symbol: sym, market: mkt, ...merged };
    }
    if (!result) {
        try {
            const d = await fetchFmpReport(sym);
            if (d.quarters && d.quarters.length) result = { symbol: sym, market: mkt, ...d };
            else fmpErr = Object.assign(new Error('no fmp quarters'), { kind: 'nodata' });
        } catch (e) { fmpErr = e; }
    }
    if (!result) {
        // FMP unavailable → Yahoo fallback (works for US tickers too).
        try { const d = await fetchYahooReport(sym); if (d.quarters && d.quarters.length) result = { symbol: sym, market: mkt, ...d }; } catch (e2) { /* surface FMP error */ }
    }
    if (!result) throw fmpErr || Object.assign(new Error('no data'), { kind: 'nodata' });

    // Enrich beta (Finnhub) + recent insider trades (FMP) IN PARALLEL on the detail view —
    // they're independent, so don't await them one after another.
    if (!fast) {
        const needBeta = result.beta == null || (typeof result.beta === 'number' && isNaN(result.beta));
        const [betaR, insR] = await Promise.allSettled([
            needBeta ? fetchFinnhubBeta(sym) : Promise.resolve(null),
            (mkt === 'us' && FMP_KEY) ? fetchFmpInsiders(sym) : Promise.resolve(null),
        ]);
        if (betaR.status === 'fulfilled' && betaR.value != null) result.beta = betaR.value;
        if (insR.status === 'fulfilled' && insR.value) result.insiders = insR.value;
    }
    return result;
}

module.exports = { fetchReport, FMP_KEY };
