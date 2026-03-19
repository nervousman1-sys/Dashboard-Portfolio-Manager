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
const TICKER_LS_PREFIX = 'ticker_hist_';
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
        // Only use if stored data has enough points for the requested range
        if (entry.data && entry.data.length >= Math.min(outputSize, 30)) {
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

    // ── Primary: FMP historical-price-full ──
    // FMP is primary for bulk fetches: 250 calls/day, no per-minute limit,
    // which works much better for large portfolios (20+ holdings).
    if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
        try {
            const url = `https://financialmodelingprep.com/stable/historical-price-full/${ticker}?apikey=${FMP_API_KEY}`;
            const res = await fetch(url);
            if (res.ok) {
                const json = await res.json();
                const hist = json.historical || (Array.isArray(json) ? json : null);
                if (hist && hist.length > 0) {
                    // FMP returns newest-first — take outputSize, then reverse
                    const sliced = hist.length > outputSize ? hist.slice(0, outputSize) : hist;
                    const result = new Array(sliced.length);
                    for (let i = sliced.length - 1, j = 0; i >= 0; i--, j++) {
                        result[j] = { date: sliced[i].date, close: sliced[i].close };
                    }
                    // Save to both caches
                    _sessionTickerCache[ticker] = result;
                    _saveTickerToLS(ticker, result);
                    return result;
                }
            } else if (res.status === 429) {
                console.warn(`[SyntheticHistory] FMP rate-limited (429) for ${ticker}`);
            }
        } catch (e) {
            console.warn(`[SyntheticHistory] FMP failed for ${ticker}:`, e.message);
        }
    }

    // ── Fallback: Twelve Data time_series ──
    // Secondary because Twelve Data free tier only allows 8 calls/min,
    // which chokes on portfolios with >8 holdings.
    if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`;
            const res = await fetch(url);
            if (res.ok && res.status !== 429) {
                const json = await res.json();

                // Handle JSON-body rate limit (Twelve Data returns 200 with error in body)
                if (json.code === 429 || (json.status === 'error' && json.message && json.message.includes('limit'))) {
                    console.warn(`[SyntheticHistory] Twelve Data rate-limited for ${ticker}: ${json.message}`);
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
    const lastKnown = {};    // Forward-fill buffer: ticker → last known close
    const cashBalance = client.cashBalance || 0;

    for (let i = 0; i < n; i++) {
        const date = backbone[i].date;
        let totalValue = cashBalance; // Cash is constant throughout synthetic history

        for (let j = 0; j < allStockFundHoldings.length; j++) {
            const h = allStockFundHoldings[j];
            const dateMap = priceLookup.get(h.ticker);

            if (dateMap) {
                const close = dateMap.get(date);
                if (close !== undefined) {
                    // Normal case: we have price data for this date
                    lastKnown[h.ticker] = close;
                    totalValue += h.shares * close;
                } else if (lastKnown[h.ticker] !== undefined) {
                    // Forward-fill: market closed for this ticker (holiday, different exchange)
                    totalValue += h.shares * lastKnown[h.ticker];
                } else {
                    // No data yet (ticker starts later in the series) — use cost basis
                    totalValue += h.costBasis || 0;
                }
            } else {
                // Ticker fetch failed or was capped — hold at cost basis
                totalValue += h.costBasis || 0;
            }
        }

        history[i] = { date, value: totalValue };
    }

    // Step 6: Normalize to percentage return from first data point
    //
    //   returnPct_i = ((Vᵢ − V₀) / V₀) × 100
    //   Equivalent: ((Vᵢ / V₀) − 1) × 100
    //
    //   This is a SINGLE pass — we already have the array, just add the field.
    //   No intermediate array created; we mutate in-place for zero extra allocation.
    const V0 = history[0].value;
    if (V0 > 0) {
        // Use reciprocal multiplication instead of division in the loop (minor optimization)
        const invV0 = 100 / V0;
        for (let i = 0; i < n; i++) {
            history[i].returnPct = (history[i].value - V0) * invV0;
        }
    } else {
        for (let i = 0; i < n; i++) {
            history[i].returnPct = 0;
        }
    }

    // Cache result
    _syntheticCache[cacheKey] = { data: history, timestamp: Date.now() };
    console.log(`[SyntheticHistory] Built ${n}-point synthetic history (${history[0].date} → ${history[n - 1].date}), return: ${history[n - 1].returnPct.toFixed(2)}%`);
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

    // Generate daily points from range start → today
    const days = _rangeToOutputSize(range);
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
