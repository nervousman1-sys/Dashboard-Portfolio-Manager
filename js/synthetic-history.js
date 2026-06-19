// ========== SYNTHETIC HISTORY - Backfill Historical Portfolio Performance ==========
//
// Problem: Newly created portfolios have no recorded performance_history snapshots.
// Solution: Fetch 1Y (or any range) of daily closing prices for the portfolio's
// current holdings and compute what the portfolio WOULD have been worth each day.
//
// ── NORMALIZATION MATH ──
//
// Given daily synthetic values V₀, V₁, V₂, ... Vₙ:
//
//   returnPct_i = ((Vᵢ − V₀) / V₀) × 100
//
// Equivalently (the formula used in the code):
//
//   returnPct_i = ((Vᵢ / V₀) − 1) × 100
//
// Both are algebraically identical. The second form avoids computing (Vᵢ − V₀)
// separately; we use the first form in the implementation for clarity.
//
//   Day 0:  ((V₀ − V₀) / V₀) × 100 = 0.00%   (always starts at zero)
//   Day i:  ((Vᵢ − V₀) / V₀) × 100 = cumulative % change from inception
//
// This is the standard "rebase to 0%" method used by Bloomberg, Yahoo Finance,
// and every institutional performance tool. It allows apples-to-apples comparison
// with market indices that are also rebased to 0% on the same start date.
//
// Example:
//   Portfolio starts at $10,000, ends at $11,200
//     → ((11200 − 10000) / 10000) × 100 = +12.00%
//   S&P 500 starts at 5,000, ends at 5,450
//     → ((5450 − 5000) / 5000) × 100 = +9.00%
//   → Portfolio outperformed by 3 percentage points
//
// ── MEMORY EFFICIENCY ──
//
// 1. Pre-allocated output array (`new Array(n)`) — avoids GC pressure from push()
// 2. Map-based O(1) price lookups per date — no nested scans
// 3. Forward-fill handles missing dates (holidays, different exchange calendars)
//    without interpolation or extra arrays
// 4. Single-pass computation — each date visited exactly once
// 5. Batch API calls (3 concurrent) with rate-limit delays
// 6. Reciprocal multiplication in normalization loop — 1 division total, not N

// ========== CACHE ==========

const _syntheticCache = {};
const SYNTHETIC_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ========== LOCAL STORAGE TICKER CACHE (24-hour, per-ticker) ==========
// Prevents API burnout: never fetch the same ticker twice per session or within 24h.
// v2 prefix invalidates any history cached before the serverless-proxy fix
// (old entries could be sparse/flat fallbacks that collapsed variance & beta to ~0).
const TICKER_LS_PREFIX = 'ticker_hist_v3_';
const TICKER_LS_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Session-level dedup: track tickers already fetched this session
const _sessionTickerCache = {};

function _getTickerFromLS(ticker, outputSize) {
    try {
        const raw = localStorage.getItem(TICKER_LS_PREFIX + ticker);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (Date.now() - entry.ts > TICKER_LS_TTL) {
            localStorage.removeItem(TICKER_LS_PREFIX + ticker);
            return null;
        }
        // Only use if the stored series is long enough for the requested range. The
        // risk model asks for a full trading year (~260) — accepting a short 30-point
        // cache here would silently compute β/σ/correlation on far too few days.
        // Long ranges (5Y/MAX) need a genuinely deep series, not last year's cache.
        const needed = outputSize > 600 ? Math.min(outputSize, 1000) : Math.min(outputSize, 200);
        if (entry.data && entry.data.length >= needed) {
            return entry.data;
        }
        return null;
    } catch (e) { return null; }
}

function _saveTickerToLS(ticker, data) {
    try {
        localStorage.setItem(TICKER_LS_PREFIX + ticker, JSON.stringify({
            data: data,
            ts: Date.now()
        }));
    } catch (e) { /* localStorage full — silent */ }
}

// Invalidate cached synthetic history for a specific client.
// Call this after any holding change (buy, sell, add, remove) so the next
// chart render fetches fresh data reflecting the new positions.
function invalidateSyntheticCache(clientId) {
    if (!clientId) return;
    const prefix = `${clientId}_`;
    for (const key of Object.keys(_syntheticCache)) {
        if (key.startsWith(prefix)) {
            delete _syntheticCache[key];
        }
    }
}

// ========== HISTORICAL TIME SERIES FETCH (per ticker) ==========
// Returns: [{date: 'YYYY-MM-DD', close: number}] in chronological order, or null.
// Uses localStorage cache (24h TTL) to avoid API burnout — never fetches same ticker twice.

// ── Yahoo Finance daily history (free, no key, no strict rate limit) ──
// This is the most reliable free source and is tried FIRST: FMP/Twelve Data free
// tiers frequently 429 / exhaust, which previously left the risk model with NO
// data → every portfolio fell back to the same "no equity exposure" verdict and
// the CML/SML charts had no curve. Yahoo via a browser-friendly CORS proxy fixes
// that. Returns chronological [{date, close}] or null.
const _SYNTH_YAHOO_PROXIES = [
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];
// Map requested depth to a Yahoo range — long ranges (5Y/MAX, backdated portfolios)
// need real multi-year series, not a 2y cap.
function _synthRangeFor(outputSize) {
    if (outputSize > 1825) return '10y';
    if (outputSize > 600) return '5y';
    if (outputSize > 300) return '2y';
    return '1y';
}

// fetch() with a hard timeout — a stalled history request must never hang the risk-model
// build (which awaits these). On timeout the caller falls back / proceeds without it.
async function _synthFetch(url, opts, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms || 12000);
    try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
    finally { clearTimeout(timer); }
}

// Israeli index ETFs / KTFs that aren't on Yahoo → fetch the UNDERLYING index they track
// as a return proxy (β/σ/α come out accurate). Currency-hedged trackers map to the index in
// its native currency, since the hedge removes the FX leg.
const _TICKER_PROXY = {
    '5122957': 'SPY',  // קסם S&P 500 KTF מנוטרלת מט"ח (currency-hedged S&P 500)
};
function _proxySymbolFor(ticker) {
    const base = String(ticker || '').replace(/\.TA$/i, '').replace(/:TASE$/i, '');
    return _TICKER_PROXY[base] || null;
}

async function _fetchYahooHistory(ticker, currency, outputSize) {
    let sym = ticker;
    const proxy = _proxySymbolFor(ticker);
    if (proxy) sym = proxy;  // underlying-index proxy (USD); skip the .TA suffixing below
    else if (currency === 'ILS' && !/\.TA$/i.test(sym)) sym = sym.replace(/:TASE$/i, '') + '.TA';
    const range = _synthRangeFor(outputSize);

    // PRIMARY: same-origin serverless proxy (server-side Yahoo fetch — 100% reliable,
    // no CORS, no flaky public proxy). This is what makes the deployed risk model
    // actually receive real price history (and thus non-zero variance/beta).
    try {
        const res = await _synthFetch(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}`, { headers: { Accept: 'application/json' } }, 10000);
        if (res.ok) {
            const j = await res.json();
            if (j && Array.isArray(j.points) && j.points.length > 20) return j.points;
        }
    } catch { /* fall through to public proxies (local dev without the function) */ }

    // FALLBACK: public CORS proxies (used only when the serverless function isn't available)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
    for (const wrap of _SYNTH_YAHOO_PROXIES) {
        try {
            const res = await fetch(wrap(url));
            if (!res.ok) continue;
            const j = await res.json();
            const r = j?.chart?.result?.[0];
            const ts = r?.timestamp;
            const closes = r?.indicators?.quote?.[0]?.close;
            if (!ts || !closes) continue;
            const out = [];
            for (let i = 0; i < ts.length; i++) {
                const c = closes[i];
                if (c != null && isFinite(c) && c > 0) {
                    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
                }
            }
            if (out.length > 20) return out;
        } catch { /* try next proxy */ }
    }
    return null;
}

// ── BATCH PREFETCH ──
// Resolve a whole list of tickers' 1-year histories in a handful of same-origin
// /api/history?symbols= round-trips (40 symbols each) instead of one request per
// ticker. Seeds the session + localStorage caches, so subsequent per-ticker
// _fetchTickerTimeSeries calls are instant. This is what makes the CML/SML model
// build fast (~70 tickers → 2 requests).
async function prefetchTickerHistories(specs, outputSize) {
    const todo = [];
    for (const s of (specs || [])) {
        if (!s || !s.ticker) continue;
        if (_sessionTickerCache[s.ticker]) continue;
        if (_getTickerFromLS(s.ticker, outputSize)) continue; // warm LS → per-ticker path will hit it
        let sym = s.ticker;
        const proxy = _proxySymbolFor(s.ticker);
        if (proxy) sym = proxy;  // index-tracker proxy (e.g. 5122957 → SPY)
        else if (s.currency === 'ILS' && !/\.TA$/i.test(sym)) sym = sym.replace(/:TASE$/i, '') + '.TA';
        todo.push({ ticker: s.ticker, sym });
    }
    if (!todo.length) return 0;
    const range = _synthRangeFor(outputSize);
    let seeded = 0;
    // Fire all 40-symbol batches IN PARALLEL (they were sequential) — with a ~150-ticker
    // universe that turns a 4-round-trip wait into a single one, so the first CML/SML
    // build is markedly faster.
    const chunks = [];
    for (let i = 0; i < todo.length; i += 40) chunks.push(todo.slice(i, i + 40));
    await Promise.all(chunks.map(async (chunk) => {
        try {
            const res = await _synthFetch(`/api/history?symbols=${encodeURIComponent(chunk.map(c => c.sym).join(','))}&range=${range}`,
                { headers: { Accept: 'application/json' } }, 14000);
            if (!res.ok) return;
            const data = await res.json();
            for (const c of chunk) {
                const pts = data[c.sym];
                if (Array.isArray(pts) && pts.length > 20) {
                    _sessionTickerCache[c.ticker] = pts;
                    _saveTickerToLS(c.ticker, pts);
                    seeded++;
                }
            }
        } catch { /* per-ticker path will cover the misses */ }
    }));
    console.log(`[SyntheticHistory] Batch-prefetched ${seeded}/${todo.length} ticker histories`);
    return seeded;
}

async function _fetchTickerTimeSeries(ticker, currency, outputSize) {
    // ── Check session cache (instant — no parse overhead) ──
    if (_sessionTickerCache[ticker]) {
        return _sessionTickerCache[ticker];
    }

    // ── Check localStorage cache (24h TTL) ──
    const lsCached = _getTickerFromLS(ticker, outputSize);
    if (lsCached) {
        _sessionTickerCache[ticker] = lsCached;
        console.log(`[SyntheticHistory] Cache hit for ${ticker} (${lsCached.length} points)`);
        return lsCached;
    }

    const sym = (currency === 'ILS') ? `${ticker}:TASE` : ticker;

    // ── PRIMARY: Yahoo Finance (free, reliable, no rate limit) ──
    try {
        const yh = await _fetchYahooHistory(ticker, currency, outputSize);
        if (yh && yh.length > 20) {
            // Cache the FULL fetched series (a whole trading year), not a short slice —
            // so the risk model always computes β/σ/correlation on every trading day of
            // the year, regardless of which consumer fetched it first.
            _sessionTickerCache[ticker] = yh;
            _saveTickerToLS(ticker, yh);
            return yh.length > outputSize ? yh.slice(yh.length - outputSize) : yh;
        }
    } catch (e) { /* fall through to FMP/Twelve Data */ }

    // ── Secondary: FMP historical-price-full ──
    // FMP is primary for bulk fetches: 250 calls/day, no per-minute limit,
    // which works much better for large portfolios (20+ holdings).
    const _fmpOk = FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY'
        && !(typeof isFmpRateLimited === 'function' && isFmpRateLimited());
    if (_fmpOk) {
        try {
            const url = `https://financialmodelingprep.com/stable/historical-price-full/${ticker}?apikey=${FMP_API_KEY}`;
            const res = await fetch(url);
            if (res.ok) {
                const json = await res.json();
                const hist = json.historical || (Array.isArray(json) ? json : null);
                if (hist && hist.length > 0) {
                    const sliced = hist.length > outputSize ? hist.slice(0, outputSize) : hist;
                    const result = new Array(sliced.length);
                    for (let i = sliced.length - 1, j = 0; i >= 0; i--, j++) {
                        result[j] = { date: sliced[i].date, close: sliced[i].close };
                    }
                    _sessionTickerCache[ticker] = result;
                    _saveTickerToLS(ticker, result);
                    return result;
                }
            } else if (res.status === 429) {
                if (typeof setFmpRateLimited === 'function') setFmpRateLimited();
                console.warn(`[SyntheticHistory] FMP rate-limited (429) for ${ticker}`);
            }
        } catch (e) {
            console.warn(`[SyntheticHistory] FMP failed for ${ticker}:`, e.message);
        }
    }

    // ── Fallback: Twelve Data time_series ──
    // Secondary because Twelve Data free tier only allows 8 calls/min,
    // which chokes on portfolios with >8 holdings.
    if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY'
        && !(typeof isTwelveDataExhausted === 'function' && isTwelveDataExhausted())) {
        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`;
            const res = await fetch(url);
            if (res.status === 401 || res.status === 429) {
                console.warn(`[SyntheticHistory] Twelve Data ${res.status} for ${ticker} — marking exhausted`);
                if (typeof setTwelveDataExhausted === 'function') setTwelveDataExhausted();
            } else if (res.ok) {
                const json = await res.json();

                // Handle JSON-body rate limit / credits exhausted
                if (json.code === 429 || json.code === 401
                    || (json.status === 'error' && json.message && (json.message.includes('limit') || json.message.includes('exhausted') || json.message.includes('credits')))) {
                    console.warn(`[SyntheticHistory] Twelve Data exhausted for ${ticker}: ${json.message}`);
                    if (typeof setTwelveDataExhausted === 'function') setTwelveDataExhausted();
                } else if (json.values && json.values.length > 0) {
                    // Twelve Data returns newest-first — reverse to chronological
                    const values = json.values;
                    const result = new Array(values.length);
                    for (let i = values.length - 1, j = 0; i >= 0; i--, j++) {
                        result[j] = {
                            date: values[i].datetime.split(' ')[0],
                            close: parseFloat(values[i].close)
                        };
                    }
                    // Save to both caches
                    _sessionTickerCache[ticker] = result;
                    _saveTickerToLS(ticker, result);
                    return result;
                }
            }
        } catch (e) {
            console.warn(`[SyntheticHistory] Twelve Data failed for ${ticker}:`, e.message);
        }
    }

    // Finnhub removed — was returning 403s and adding log noise.
    // FMP + Twelve Data cover all needed tickers.

    return null;
}

// ========== CORE: BUILD SYNTHETIC HISTORY ==========
//
// Input:  client object (with holdings[] and cashBalance)
// Output: [{date: 'YYYY-MM-DD', value: number, returnPct: number}]
//         where returnPct is normalized to 0% on first data point.
//
// Algorithm:
//   1. Filter to stock AND fund holdings with shares > 0 (both have tickers with history)
//   2. Fetch daily time_series for each ticker (3 concurrent, with 1.2s rate-limit gaps)
//   3. Build the "date backbone" from the longest series
//   4. Create Map<date, close> per ticker for O(1) lookups
//   5. Single pass over dates: for each date, sum (shares × close) + cash
//      Forward-fill any missing prices from last known close
//   6. Normalize all values to returnPct from first data point

async function fetchSyntheticHistory(client, range) {
    if (!client || !client.holdings) return null;

    const cacheKey = `${client.id}_${range}`;
    const cached = _syntheticCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp < SYNTHETIC_CACHE_TTL)) {
        return cached.data;
    }

    // ── Opened-today guard ──────────────────────────────────────────────────
    // A portfolio created today (everything bought today at market) has NO real
    // return history — fabricating a year-long line is misleading. Detect it via the
    // earliest buy date / the portfolio's creation date and return a flat 0% line
    // (today only) so the chart honestly shows "no movement yet".
    const _todayIso = new Date().toISOString().slice(0, 10);
    const _buyDates = (client.holdings || []).map(h => h.buyDate).filter(Boolean).sort();
    const _createdIso = client.createdAt ? new Date(client.createdAt).toISOString().slice(0, 10) : null;
    const _openIso = _buyDates.length ? _buyDates[0] : _createdIso;
    if (_openIso && _openIso >= _todayIso) {
        const totalCost = (client.holdings || []).reduce((s, h) => s + (h.costBasis || 0), 0) + (client.cashBalance || 0);
        const curVal = (client.holdings || []).reduce((s, h) => s + (h.value || h.costBasis || 0), 0) + (client.cashBalance || 0);
        const ret = totalCost > 0 ? ((curVal - totalCost) / totalCost) * 100 : 0;
        const flat = [
            { date: _todayIso, value: parseFloat(totalCost.toFixed(2)), returnPct: 0 },
            { date: _todayIso, value: parseFloat(curVal.toFixed(2)), returnPct: parseFloat(ret.toFixed(2)) },
        ];
        _syntheticCache[cacheKey] = { data: flat, timestamp: Date.now() };
        return flat;
    }

    // Step 1: Filter eligible holdings — stocks AND funds (ETFs) have ticker-based history
    let eligibleHoldings = client.holdings.filter(
        h => (h.type === 'stock' || h.type === 'fund') && h.shares > 0 && h.ticker
    );
    if (eligibleHoldings.length === 0) return null;

    // Cap to top 12 holdings by value — covers 90%+ of portfolio for most clients.
    // This prevents API exhaustion for large portfolios (20+ holdings).
    // Remaining holdings are approximated via costBasis (forward-fill at constant value).
    const MAX_TICKERS = 12;
    if (eligibleHoldings.length > MAX_TICKERS) {
        eligibleHoldings.sort((a, b) => (b.value || 0) - (a.value || 0));
        console.log(`[SyntheticHistory] Capping from ${eligibleHoldings.length} to top ${MAX_TICKERS} holdings by value`);
        eligibleHoldings = eligibleHoldings.slice(0, MAX_TICKERS);
    }

    const outputSize = _rangeToOutputSize(range); // Reuse existing charts.js helper
    console.log(`[SyntheticHistory] Fetching ${outputSize} days for ${eligibleHoldings.length} tickers: ${eligibleHoldings.map(h => h.ticker).join(', ')}`);

    // Step 2: Fetch historical data — batched
    //         FMP is now primary (250 calls/day, no per-minute limit),
    //         so we can use larger batch sizes with shorter delays.
    const tickerSeries = {};
    const BATCH_SIZE = 5;

    for (let i = 0; i < eligibleHoldings.length; i += BATCH_SIZE) {
        const batch = eligibleHoldings.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(h => _fetchTickerTimeSeries(h.ticker, h.currency, outputSize))
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled' && results[j].value) {
                tickerSeries[batch[j].ticker] = results[j].value;
            }
        }

        // Short delay between batches — FMP has generous limits, but be polite
        if (i + BATCH_SIZE < eligibleHoldings.length) {
            await new Promise(r => setTimeout(r, 300));
        }
    }

    const fetchedTickers = Object.keys(tickerSeries);
    if (fetchedTickers.length === 0) {
        // FALLBACK: ALL APIs failed — generate a costBasis straight-line so the UI never breaks.
        // Two-point line from "purchase date" to "today" using total costBasis → current value.
        console.warn('[SyntheticHistory] No historical data fetched — using costBasis fallback');
        return _buildCostBasisFallback(client, range);
    }
    console.log(`[SyntheticHistory] Got data for ${fetchedTickers.length}/${eligibleHoldings.length} tickers`);

    // Step 3: Build date backbone from the longest time series
    //         This ensures we have a date for every trading day
    let backbone = [];
    for (const series of Object.values(tickerSeries)) {
        if (series.length > backbone.length) {
            backbone = series; // Reuse reference — we'll only read .date from it
        }
    }

    if (backbone.length < 2) return null;

    // Real opening date: portfolios created with purchase dates start their
    // history at the FIRST buy — no flat pre-history before the portfolio existed.
    const _knownBuyDates = client.holdings.map(h => h.buyDate).filter(Boolean).sort();
    if (_knownBuyDates.length) {
        const openIso = _knownBuyDates[0];
        const startIdx = backbone.findIndex(p => p.date >= openIso);
        if (startIdx > 0) backbone = backbone.slice(startIdx);
        if (backbone.length < 2) return null;
    }

    // Step 4: Create O(1) date→close lookup Maps
    //         Map is more memory-efficient than plain object for many keys
    const priceLookup = new Map();
    for (const [ticker, series] of Object.entries(tickerSeries)) {
        const dateMap = new Map();
        for (let i = 0; i < series.length; i++) {
            dateMap.set(series[i].date, series[i].close);
        }
        priceLookup.set(ticker, dateMap);
    }

    // Step 5: Single-pass portfolio value computation
    //         Pre-allocate output array for zero GC pressure
    //
    //         Iterate ALL stock/fund holdings (not just the top N that were fetched).
    //         Holdings without fetched data are held at constant costBasis.
    const allStockFundHoldings = client.holdings.filter(
        h => (h.type === 'stock' || h.type === 'fund') && h.shares > 0 && h.ticker
    );
    const n = backbone.length;
    const history = new Array(n);
    const cashBalance = client.cashBalance || 0;

    // ── RETURN-FROM-COST reconstruction via UNIT-FREE price ratios ──
    //
    // Earlier versions anchored each leg to a PRICE expressed in costBasis units
    // (window-start price, then purchase price). That silently assumed costBasis and
    // the fetched close series share a currency AND scale — false for Israeli holdings,
    // where brokers quote agorot but Yahoo returns shekels (a 100× mismatch). One such
    // leg exploded the line to hundreds of % mid-series (the bogus 276% YTD), and the
    // endpoint rigid-shift only fixed the last point, leaving the fake spike visible.
    //
    // Robust fix: value each leg by close(t) / currentClose — a RATIO of two prices
    // from the SAME series, so all units cancel and a currency/scale mismatch is
    // impossible. Scale that ratio by the leg's REAL current value (h.value × fx),
    // which the app already holds in correct units. So:
    //   • the SHAPE is the holding's genuine price movement (unit-free, never inflated),
    //   • before its buyDate the capital sits flat at cost (0 return contribution),
    //   • at t = today every leg equals its true value → portfolio endpoint is the real
    //     value, so returnPct arrives at the card's return ORGANICALLY — no cliff, in
    //     every resolution,
    //   • a per-leg ratio clamp [0.1, 10] neutralises any single sparse/bad close so it
    //     can never blow the whole line to triple digits.
    //
    // returnPct(t) = (Σ legValue(t) − totalCost) / totalCost × 100 — the same profit ÷
    // cost definition the portfolio card uses.
    const fxOf = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    const windowStart = backbone[0].date;
    const legs = [];          // { ticker, dateMap, currentClose, costUsd, valueUsd, entryIdx, flat }
    let totalCostUsd = 0;
    for (const h of allStockFundHoldings) {
        const f = fxOf(h.currency);
        const costUsd = ((h.costBasis > 0 ? h.costBasis : h.shares * (h.price || 0)) || 0) * f;
        const valueUsd = ((h.value > 0 ? h.value : (h.costBasis > 0 ? h.costBasis : 0)) || 0) * f;
        if (costUsd <= 0) continue;
        totalCostUsd += costUsd;
        const dateMap = priceLookup.get(h.ticker);
        // currentClose = most recent close in the series — the ratio denominator. Both
        // it and close(t) come from the same series, so close(t)/currentClose is unit-free.
        let currentClose = 0;
        if (dateMap) { for (let i = n - 1; i >= 0; i--) { const c = dateMap.get(backbone[i].date); if (c > 0) { currentClose = c; break; } } }
        if (!dateMap || !(currentClose > 0) || !(valueUsd > 0)) { legs.push({ ticker: h.ticker, flat: true, costUsd, valueUsd: valueUsd > 0 ? valueUsd : costUsd }); continue; }
        // Track price from the actual buy date (if it falls inside the window); before
        // that the capital is held flat at cost. Bought-before-window legs track from day 0.
        const buyIso = (h.buyDate && h.buyDate > windowStart) ? h.buyDate : windowStart;
        let entryIdx = 0;
        for (let i = 0; i < n; i++) { if (backbone[i].date >= buyIso) { entryIdx = i; break; } entryIdx = n - 1; }
        legs.push({ ticker: h.ticker, dateMap, currentClose, costUsd, valueUsd, entryIdx });
    }
    if (!legs.length || totalCostUsd <= 0) return _buildCostBasisFallback(client, range);

    const invCB = 100 / totalCostUsd;
    const lastClose = {}; // forward-fill buffer
    for (let i = 0; i < n; i++) {
        const date = backbone[i].date;
        let mv = 0; // holdings market value (USD), via unit-free ratio of real value
        for (const leg of legs) {
            if (leg.flat) { mv += leg.valueUsd; continue; }           // no usable price → hold at value
            if (i < leg.entryIdx) { mv += leg.costUsd; continue; }    // before buy → its capital (0 contribution)
            let close = leg.dateMap.get(date);
            if (!(close > 0)) close = lastClose[leg.ticker];
            if (!(close > 0)) close = leg.currentClose;
            lastClose[leg.ticker] = close;
            let ratio = close / leg.currentClose;                     // unit-free
            if (!(ratio > 0) || !isFinite(ratio)) ratio = 1;
            else if (ratio > 10) ratio = 10; else if (ratio < 0.1) ratio = 0.1; // bad-data guard
            mv += leg.valueUsd * ratio;                               // anchored to REAL current value
        }
        history[i] = { date, value: mv + cashBalance, returnPct: (mv - totalCostUsd) * invCB };
    }

    // ── Land the endpoint EXACTLY on the card's displayed return ──
    // The reconstructed shape already ends a hair away from the card's number (the card
    // is FX-adjusted and uses the live quote, the shape uses the last daily close). We
    // close that small gap with a RIGID vertical shift of the whole series — NOT by
    // overwriting the last point (that was the cliff). A rigid shift preserves the real
    // movement shape exactly and only translates it by a fraction of a percent so the
    // endpoint equals the card to the decimal, identically across every resolution.
    let cardReturn = null;
    try {
        if (typeof _calcReturn === 'function') {
            const r = _calcReturn(client);
            if (r && isFinite(r.returnPct)) cardReturn = r.returnPct;
        }
    } catch { /* _calcReturn unavailable (e.g. backfill pseudo-client) — use base return */ }
    if (cardReturn == null) {
        const mvNowUsd = client.holdings.reduce((s, h) => s + (h.value || 0) * fxOf(h.currency), 0);
        if (mvNowUsd > 0) cardReturn = (mvNowUsd - totalCostUsd) * invCB;
    }
    if (cardReturn != null && isFinite(cardReturn)) {
        const shift = cardReturn - history[n - 1].returnPct;
        if (Math.abs(shift) > 0.001) for (let i = 0; i < n; i++) history[i].returnPct += shift;
        history[n - 1].returnPct = cardReturn; // exact to the decimal
        const mvNowUsd = client.holdings.reduce((s, h) => s + (h.value || 0) * fxOf(h.currency), 0);
        if (mvNowUsd > 0) history[n - 1].value = mvNowUsd + cashBalance;
    }

    // Cache result
    _syntheticCache[cacheKey] = { data: history, timestamp: Date.now() };
    console.log(`[SyntheticHistory] Built ${n}-point return-from-cost history (${history[0].date} → ${history[n - 1].date}), return: ${history[n - 1].returnPct.toFixed(2)}%`);
    return history;
}

// ========== COST BASIS FALLBACK ==========
// When ALL API calls fail (rate-limited, network down, etc.), generate a simple
// 2-point history from total costBasis → current portfolio value.
// This ensures the UI NEVER shows an empty chart (especially for Shai Meidan).

function _buildCostBasisFallback(client, range) {
    const allHoldings = client.holdings.filter(
        h => (h.type === 'stock' || h.type === 'fund') && h.shares > 0
    );
    if (allHoldings.length === 0) return null;

    const totalCostBasis = allHoldings.reduce((sum, h) => sum + (h.costBasis || 0), 0);
    const currentValue = allHoldings.reduce((sum, h) => sum + (h.value || h.costBasis || 0), 0)
        + (client.cashBalance || 0);

    if (totalCostBasis <= 0 && currentValue <= 0) return null;

    const startValue = totalCostBasis + (client.cashBalance || 0);

    // Generate daily points from range start → today.
    // Cap at 5Y (1825 days) — our static benchmark data only goes back 5Y,
    // so generating portfolio history beyond that creates an empty gap on the chart.
    const rawDays = _rangeToOutputSize(range);
    const days = Math.min(rawDays, 1825);
    const today = new Date();
    const startDate = new Date(today.getTime() - days * 86400000);

    // Linear interpolation between costBasis and current value
    // For 5Y/MAX: sample monthly (every ~21 trading days) to keep points manageable.
    // For shorter ranges: daily points (capped at 500).
    const n = days > 500 ? Math.min(Math.ceil(days / 21), 260) : Math.min(days, 500);
    const history = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1); // 0 → 1
        const date = new Date(startDate.getTime() + t * (today.getTime() - startDate.getTime()));
        const value = startValue + t * (currentValue - startValue);
        const returnPct = startValue > 0 ? ((value - startValue) / startValue) * 100 : 0;
        history[i] = {
            date: date.toISOString().split('T')[0],
            value: parseFloat(value.toFixed(2)),
            returnPct: parseFloat(returnPct.toFixed(2))
        };
    }

    // Cache it
    const cacheKey = `${client.id}_${range}`;
    _syntheticCache[cacheKey] = { data: history, timestamp: Date.now() };
    console.log(`[SyntheticHistory] CostBasis fallback: ${n} points, ${history[0].date} → ${history[n-1].date}, return: ${history[n-1].returnPct.toFixed(2)}%`);
    return history;
}

// ========== PUBLIC API: generateBackfilledData(holdings, period) ==========
//
// Clean public interface that takes a holdings array and period string,
// returns Chart.js-ready [{x: timestamp_ms, y: totalValue}] or null.
//
// Usage:
//   const points = await generateBackfilledData(client.holdings, '1y');
//   if (points) chart.data.datasets[0].data = points;
//
// This is a convenience wrapper around fetchSyntheticHistory.

async function generateBackfilledData(holdings, period, cashBalance) {
    if (!holdings || holdings.length === 0) return null;

    // Build a minimal client-like object for fetchSyntheticHistory
    const pseudoClient = {
        id: '_backfill_' + holdings.map(h => h.ticker).sort().join('_'),
        holdings: holdings,
        cashBalance: cashBalance || 0
    };

    const history = await fetchSyntheticHistory(pseudoClient, period || '1y');
    if (!history || history.length < 2) return null;

    // Convert to Chart.js {x, y} format — x is ms timestamp, y is portfolio value
    const points = new Array(history.length);
    for (let i = 0; i < history.length; i++) {
        points[i] = {
            x: new Date(history[i].date).getTime(),
            y: history[i].value
        };
    }
    return points;
}
