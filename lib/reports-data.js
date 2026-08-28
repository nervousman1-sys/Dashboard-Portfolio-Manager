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
    // limit MUST be ≤5: the free/fallback FMP key rejects limit>5 outright ("Premium Query
    // Parameter … must be between 0 and 5"), which silently killed the whole FMP path → every
    // report fell back to Yahoo's fundamentals-timeseries, which LAGS a just-filed quarter by
    // days/weeks (e.g. NVDA's late-Aug report still showed as_of Apr-30). Yahoo supplies the
    // deeper history in the merge, so 5 fresh FMP quarters + Yahoo union = full depth + freshness.
    const q = `symbol=${encodeURIComponent(symbol)}&period=quarter&limit=5&apikey=${FMP_KEY}`;
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
// needCrumb=true (quoteSummary path) forces a re-acquire when the cached session has no crumb —
// timeseries works without a crumb so the cache may hold crumb:null, which would silently break
// quoteSummary (it REQUIRES a valid crumb). A null-crumb session is cached only briefly so it self-heals.
async function _getYhSession(needCrumb) {
    if (_yhSession && Date.now() - _yhSession.ts < 30 * 60 * 1000 && !(needCrumb && !_yhSession.crumb)) return _yhSession;
    try {
        // Use a PLAIN browser UA (no Accept: application/json) for the consent + crumb handshake —
        // Yahoo's fc.yahoo.com / getcrumb endpoints return an invalid crumb when Accept is JSON.
        const HS = { 'User-Agent': UA['User-Agent'] };
        const r1 = await fetch('https://fc.yahoo.com', { headers: HS });
        const sc = r1.headers.get('set-cookie');
        const cookie = sc ? sc.split(';')[0] : '';
        if (!cookie) return null;
        // The crumb endpoint is occasionally flaky — retry once before giving up.
        let crumb = '';
        for (let i = 0; i < 2 && !(crumb && crumb.length <= 40 && !/[<{]/.test(crumb)); i++) {
            const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...HS, Cookie: cookie } });
            crumb = (await r2.text()).trim();
        }
        if (!crumb || crumb.length > 40 || /[<{]/.test(crumb)) {
            // No usable crumb → cache briefly (1 min TTL) so the next call retries instead of being
            // stuck for 30 min; timeseries can still proceed cookie-only.
            _yhSession = { cookie, crumb: null, ts: Date.now() - 29 * 60 * 1000 };
            return _yhSession;
        }
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

// Yahoo quoteSummary → snapshot valuation multiples + the NEXT earnings (report) date for one
// symbol, in a SINGLE authenticated call (same cookie+crumb session as the timeseries). Used both
// to stamp a report with its next-earnings date and to build the sector peer-multiples comparison.
// Returns null on failure (best-effort everywhere it's called).
async function fetchYahooStats(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    try {
        const session = await _getYhSession(true); // quoteSummary requires a valid crumb
        if (!session || !session.crumb) return null;
        const headers = { ...UA, Cookie: session.cookie };
        const mods = 'summaryDetail,defaultKeyStatistics,financialData,price,calendarEvents,assetProfile';
        let url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}`;
        if (session && session.crumb) url += '&crumb=' + encodeURIComponent(session.crumb);
        const r = await fetch(url, { headers });
        if (!r.ok) return null;
        const j = await r.json();
        const res = (((j.quoteSummary || {}).result || [])[0]) || {};
        const sd = res.summaryDetail || {}, ks = res.defaultKeyStatistics || {}, fd = res.financialData || {}, pr = res.price || {}, ce = res.calendarEvents || {}, ap = res.assetProfile || {};
        const raw = (o) => (o && typeof o.raw === 'number' && isFinite(o.raw)) ? o.raw : null;
        const earn = ce.earnings || {};
        // Yahoo keeps the LAST report date in earningsDate when the next one isn't
        // scheduled yet (common for small caps) — a past date must never surface as
        // "מועד הדוח הבא", so keep only future dates.
        const todayStr = new Date().toISOString().slice(0, 10);
        const ed = (earn.earningsDate || []).map(d => d && d.fmt).filter(d => d && d >= todayStr).sort();
        let mcap = raw(pr.marketCap) != null ? raw(pr.marketCap) : raw(sd.marketCap);
        return {
            symbol: sym,
            name: pr.shortName || pr.longName || sym.replace(/\.TA$/, ''),
            pe: raw(sd.trailingPE),
            pb: raw(ks.priceToBook),
            ps: raw(sd.priceToSalesTrailing12Months),
            evToEbitda: raw(ks.enterpriseToEbitda),
            roe: raw(fd.returnOnEquity),
            marketCap: mcap,
            nextEarningsDate: ed[0] || null,
            earningsIsEstimate: !!earn.isEarningsDateEstimate,
            website: (typeof ap.website === 'string' && ap.website) ? ap.website : null,
        };
    } catch (e) { return null; }
}

// Yahoo quoteSummary → LIVE earnings status for one symbol: the most-recently REPORTED quarter
// (actual vs consensus EPS → beat/miss) plus the upcoming report's consensus estimate. This is the
// real-time signal that lets the platform mark "התקבל הדוח" the moment a company reports (Yahoo
// posts the actual within minutes of the release) and fire earnings alerts — independent of the
// slower 24/7 reports agent. The `reportedDate` of the newest earningsChart.quarterly entry is the
// key: when it reaches (or passes) a scheduled report date, that report is out. Best-effort → null.
async function fetchYahooEarnings(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    try {
        const session = await _getYhSession(true); // quoteSummary requires a valid crumb
        if (!session || !session.crumb) return null;
        const headers = { ...UA, Cookie: session.cookie };
        const mods = 'earnings,calendarEvents';
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}&crumb=${encodeURIComponent(session.crumb)}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return null;
        const j = await r.json();
        const res = (((j.quoteSummary || {}).result || [])[0]) || {};
        const ce = (res.calendarEvents || {}).earnings || {};
        const ec = (res.earnings || {}).earningsChart || {};
        const raw = (o) => (o && typeof o.raw === 'number' && isFinite(o.raw)) ? o.raw : null;
        const q = ec.quarterly || [];
        const last = q.length ? q[q.length - 1] : null;
        const reportedDate = last && last.reportedDate ? last.reportedDate.fmt : null;
        const epsActual = last ? raw(last.actual) : null;
        const epsEstimate = last ? raw(last.estimate) : null;
        let surprisePct = (last && last.surprisePct != null && last.surprisePct !== '') ? parseFloat(last.surprisePct) : null;
        if ((surprisePct == null || !isFinite(surprisePct)) && epsActual != null && epsEstimate) surprisePct = (epsActual - epsEstimate) / Math.abs(epsEstimate) * 100;
        const edAll = (ce.earningsDate || []).map(d => d && d.fmt).filter(Boolean).sort();
        return {
            symbol: sym,
            reportedDate,                       // fmt date of the latest REPORTED quarter
            epsActual, epsEstimate,
            surprisePct: (surprisePct != null && isFinite(surprisePct)) ? +surprisePct.toFixed(2) : null,
            scheduled: edAll.length ? edAll[edAll.length - 1] : null, // Yahoo's nearest known report date
            isEstimate: !!ce.isEarningsDateEstimate,
            nextEstimate: raw(ce.earningsAverage), // consensus EPS for the upcoming report
            fiscalQuarter: last ? (last.fiscalQuarter || null) : null,
        };
    } catch (e) { return null; }
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
    if (!primary || !Array.isArray(primary.quarters) || !primary.quarters.length) return secondary;
    const out = { ...primary };
    for (const k of ['sector', 'industry', 'beta', 'price', 'marketCap', 'companyName', 'currency']) {
        if (out[k] == null || out[k] === '') out[k] = secondary[k] != null ? secondary[k] : out[k];
    }
    // UNION the quarters by YYYY-MM (period end). Primary (FMP) is added first so its values win;
    // secondary (Yahoo) fills any missing fields AND contributes quarters primary doesn't carry —
    // that's what lets Yahoo's deeper history sit alongside a quarter only one source has filed yet.
    // Without the union, whichever source was "primary" capped the quarter set and a fresh filing
    // present in only that source (or missing from it) was dropped.
    const byMonth = {};
    const addQ = (q) => {
        if (!q || !q.date) return;
        const key = String(q.date).slice(0, 7);
        if (!byMonth[key]) { byMonth[key] = { ...q }; return; }
        const tgt = byMonth[key];
        for (const f of _REPORT_NUM_FIELDS) if (tgt[f] == null && q[f] != null) tgt[f] = q[f];
    };
    (primary.quarters || []).forEach(addQ);
    (secondary.quarters || []).forEach(addQ);
    let quarters = Object.values(byMonth).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    quarters = quarters.slice(0, 8);   // same depth cap the single-source paths use
    out.quarters = quarters;
    // asOf = the newest period end across BOTH sources (the freshly-filed quarter, wherever it is).
    out.asOf = (quarters[0] && quarters[0].date) || primary.asOf || secondary.asOf || null;
    out.source = primary.source + '+' + secondary.source;
    return out;
}

async function fetchReport(symbol, market, opts) {
    const sym = String(symbol || '').trim().toUpperCase();
    const mkt = market || (sym.endsWith('.TA') ? 'il' : 'us');
    if (mkt === 'il') {
        const [data, stats] = await Promise.all([fetchYahooReport(sym), fetchYahooStats(sym).catch(() => null)]);
        const out = { symbol: sym, market: mkt, ...data };
        if (stats) { out.nextEarningsDate = stats.nextEarningsDate || null; out.earningsIsEstimate = stats.earningsIsEstimate || false; }
        return out;
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

    // Enrich beta (Finnhub) + recent insider trades (FMP) + RPO (SEC XBRL) IN PARALLEL on the
    // detail view — they're independent, so don't await them one after another.
    if (!fast) {
        const needBeta = result.beta == null || (typeof result.beta === 'number' && isNaN(result.beta));
        const [betaR, insR, statsR, rpoR] = await Promise.allSettled([
            needBeta ? fetchFinnhubBeta(sym) : Promise.resolve(null),
            (mkt === 'us' && FMP_KEY) ? fetchFmpInsiders(sym) : Promise.resolve(null),
            fetchYahooStats(sym),   // next earnings (report) date + multiples fallback
            (mkt === 'us') ? fetchSecRpo(sym) : Promise.resolve(null),
        ]);
        if (betaR.status === 'fulfilled' && betaR.value != null) result.beta = betaR.value;
        if (insR.status === 'fulfilled' && insR.value) result.insiders = insR.value;
        if (statsR.status === 'fulfilled' && statsR.value) {
            result.nextEarningsDate = statsR.value.nextEarningsDate || null;
            result.earningsIsEstimate = statsR.value.earningsIsEstimate || false;
        }
        if (rpoR.status === 'fulfilled' && rpoR.value) {
            result.rpo = rpoR.value;
            // Attach per-quarter RPO onto the quarters so it renders as a TABLE ROW too.
            // Fiscal period-ends from FMP/Yahoo and SEC can differ by a few days (e.g. Apple's
            // 52/53-week calendar) — match to the nearest RPO end within 20 days.
            if (Array.isArray(result.quarters) && Array.isArray(result.rpo.history)) {
                const hist = result.rpo.history;
                for (const q of result.quarters) {
                    if (!q.date) continue;
                    const qt = new Date(q.date).getTime();
                    let best = null, bestGap = 21 * 864e5;
                    for (const h of hist) {
                        const gap = Math.abs(new Date(h.date).getTime() - qt);
                        if (gap < bestGap) { bestGap = gap; best = h; }
                    }
                    if (best) q.rpo = best.val;
                }
            }
        }
    }
    return result;
}

// ── RPO — Remaining Performance Obligation (ASC 606) from SEC XBRL ──────────────
// The dollar value of SIGNED contracts NOT YET recognized as revenue (backlog of
// committed future revenue). A leading indicator for subscription/contract firms
// (CRM, MSFT, ORCL, SNOW, PLTR…). Tagged in 10-K/10-Q filings as the us-gaap
// concept `RevenueRemainingPerformanceObligation`. US only (SEC filers).
let _secTickerMap = null, _secTickerTs = 0;
async function _secCik(symbol) {
    const sym = String(symbol || '').toUpperCase().replace(/\.[A-Z]+$/, '');
    if (!_secTickerMap || Date.now() - _secTickerTs > 24 * 3600 * 1000) {
        try {
            const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } });
            if (!r.ok) return null;
            const j = await r.json();
            const map = {};
            for (const k of Object.keys(j)) { const e = j[k]; if (e && e.ticker) map[e.ticker.toUpperCase()] = String(e.cik_str).padStart(10, '0'); }
            _secTickerMap = map; _secTickerTs = Date.now();
        } catch (e) { return _secTickerMap ? (_secTickerMap[sym] || null) : null; }
    }
    return _secTickerMap[sym] || null;
}
const SEC_UA = 'Finextium Research (finextium.com; contact@finextium.com)';
async function fetchSecRpo(symbol) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    try {
        const cik = await _secCik(symbol);
        if (!cik) return null;
        const r = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/RevenueRemainingPerformanceObligation.json`,
            { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' }, signal: ac.signal });
        if (!r.ok) return null;                       // 404 = company doesn't report RPO → skip
        const j = await r.json();
        const usd = (j.units && j.units.USD) || [];
        if (!usd.length) return null;
        // One value per period end; a period may appear in both a 10-Q and later 10-K — dedupe by
        // `end`, keeping the latest-filed. Then sort chronologically and take the recent points.
        const byEnd = {};
        for (const o of usd) {
            if (o.val == null || !o.end || !/10-[KQ]/.test(o.form || '')) continue;
            const prev = byEnd[o.end];
            if (!prev || String(o.filed) > String(prev.filed)) byEnd[o.end] = o;
        }
        const pts = Object.values(byEnd).sort((a, b) => a.end.localeCompare(b.end)).map(o => ({ date: o.end, val: o.val }));
        if (!pts.length) return null;
        const latest = pts[pts.length - 1];
        const prev = pts.length > 1 ? pts[pts.length - 2] : null;
        // Same quarter a year ago (≈4 periods back) for a clean YoY.
        const yoy = pts.length > 4 ? pts[pts.length - 5] : null;
        return {
            total: latest.val, date: latest.date,
            prev: prev ? prev.val : null, prevDate: prev ? prev.date : null,
            yoy: yoy ? yoy.val : null, yoyDate: yoy ? yoy.date : null,
            history: pts.slice(-6),
            currency: 'USD',
        };
    } catch (e) { return null; }
    finally { clearTimeout(timer); }
}

// ── Business segments — revenue by division/product/geography (FMP), Supabase-cached ──
// The FMP free-tier daily cap is shared with the report fallback, so a company is fetched
// from FMP at most ~once a month and served from Supabase `segment_cache` in between.
const _SB_URL = process.env.SUPABASE_URL;
const _SB_ANON = process.env.SUPABASE_ANON_KEY;
const _WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
function _segShape(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const recent = rows.slice(0, 5).reverse(); // oldest→newest
    const bySeg = {};
    for (const r of recent) {
        const date = r.date || (r.fiscalYear && r.period ? `${r.fiscalYear} ${r.period}` : null);
        const data = r.data && typeof r.data === 'object' ? r.data : r;
        for (const [name, val] of Object.entries(data)) {
            const v = typeof val === 'number' ? val : parseFloat(val);
            if (!name || name === 'symbol' || name === 'date' || name === 'period' || name === 'fiscalYear' || name === 'reportedCurrency' || !isFinite(v)) continue;
            (bySeg[name] = bySeg[name] || []).push({ date, value: v });
        }
    }
    return Object.entries(bySeg)
        .map(([name, points]) => ({ name, points, latest: points.length ? points[points.length - 1].value : 0 }))
        .sort((a, b) => b.latest - a.latest).slice(0, 8)
        .map(({ name, points }) => ({ name, points }));
}
async function _fmpSeg(kind, symbol) {
    const url = `https://financialmodelingprep.com/stable/revenue-${kind}-segmentation?symbol=${encodeURIComponent(symbol)}&period=quarter&structure=flat&apikey=${FMP_KEY}`;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 7000);
    try {
        const r = await fetch(url, { headers: UA, signal: ac.signal });
        const j = await r.json();
        return Array.isArray(j) ? _segShape(j) : null;   // error object ("Limit Reach") → unavailable
    } catch (e) { return null; } finally { clearTimeout(t); }
}
async function _segCacheRead(symbol) {
    if (!_SB_URL || !_SB_ANON) return null;
    try {
        const r = await fetch(`${_SB_URL}/rest/v1/segment_cache?symbol=eq.${encodeURIComponent(symbol)}&select=data,updated_at`,
            { headers: { apikey: _SB_ANON, Authorization: `Bearer ${_SB_ANON}`, Accept: 'application/json' } });
        if (!r.ok) return null;
        const rows = await r.json();
        return (rows && rows[0]) || null;
    } catch (e) { return null; }
}
async function _segCacheWrite(symbol, data) {
    if (!_SB_URL || !_SB_ANON || !_WRITE_SECRET) return;
    try {
        await fetch(`${_SB_URL}/rest/v1/rpc/upsert_segment_cache`, {
            method: 'POST', headers: { apikey: _SB_ANON, Authorization: `Bearer ${_SB_ANON}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_secret: _WRITE_SECRET, p_symbol: symbol, p_data: data }),
        });
    } catch (e) { /* non-fatal */ }
}
async function fetchSegments(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return { symbol: sym, product: [], geographic: [] };
    const cached = await _segCacheRead(sym);
    const fresh = cached && (Date.now() - new Date(cached.updated_at).getTime() < 30 * 864e5);
    if (fresh && cached.data && ((cached.data.product || []).length || (cached.data.geographic || []).length)) {
        return { ...cached.data, cached: true };
    }
    const [product, geographic] = await Promise.all([_fmpSeg('product', sym), _fmpSeg('geographic', sym)]);
    const payload = { symbol: sym, product: product || [], geographic: geographic || [], asOf: new Date().toISOString().slice(0, 10) };
    if (payload.product.length || payload.geographic.length) { await _segCacheWrite(sym, payload); return { ...payload, cached: false }; }
    if (cached && cached.data) return { ...cached.data, cached: true, stale: true }; // FMP capped → serve stale
    return payload;
}

module.exports = { fetchReport, fetchYahooStats, fetchYahooEarnings, fetchSegments, FMP_KEY };
