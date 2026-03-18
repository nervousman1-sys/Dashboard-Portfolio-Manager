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
//   Day 0:  ((V₀ − V₀) / V₀) × 100 = 0.00%   (always starts at zero)
//   Day i:  ((Vᵢ − V₀) / V₀) × 100 = cumulative % change from inception
//
// This is the standard "rebase to 0%" method used by Bloomberg, Yahoo Finance,
// and every institutional performance tool. It allows apples-to-apples comparison
// with market indices that are also rebased to 0% on the same start date.
//
// Example:
//   Portfolio starts at $10,000, ends at $11,200  →  +12.00%
//   S&P 500 starts at 5,000, ends at 5,450       →  +9.00%
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

// ========== CACHE ==========

const _syntheticCache = {};
const SYNTHETIC_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ========== HISTORICAL TIME SERIES FETCH (per ticker) ==========
// Returns: [{date: 'YYYY-MM-DD', close: number}] in chronological order, or null.

async function _fetchTickerTimeSeries(ticker, currency, outputSize) {
    const sym = (currency === 'ILS') ? `${ticker}:TASE` : ticker;

    // ── Primary: Twelve Data time_series ──
    if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`;
            const res = await fetch(url);
            if (res.ok && res.status !== 429) {
                const json = await res.json();
                if (json.values && json.values.length > 0) {
                    // Twelve Data returns newest-first — reverse to chronological
                    const values = json.values;
                    const result = new Array(values.length);
                    for (let i = values.length - 1, j = 0; i >= 0; i--, j++) {
                        result[j] = {
                            date: values[i].datetime.split(' ')[0],
                            close: parseFloat(values[i].close)
                        };
                    }
                    return result;
                }
            }
        } catch (e) {
            console.warn(`[SyntheticHistory] Twelve Data failed for ${ticker}:`, e.message);
        }
    }

    // ── Fallback: FMP historical-price-full ──
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
                    return result;
                }
            }
        } catch (e) {
            console.warn(`[SyntheticHistory] FMP failed for ${ticker}:`, e.message);
        }
    }

    // ── Fallback: Finnhub candle ──
    if (FINNHUB_API_KEY && FINNHUB_API_KEY !== 'YOUR_FINNHUB_API_KEY') {
        try {
            const now = Math.floor(Date.now() / 1000);
            const from = now - outputSize * 24 * 60 * 60;
            const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;
            const res = await fetch(url);
            if (res.ok) {
                const json = await res.json();
                if (json.s === 'ok' && json.c && json.c.length > 0) {
                    const result = new Array(json.c.length);
                    for (let i = 0; i < json.c.length; i++) {
                        result[i] = {
                            date: new Date(json.t[i] * 1000).toISOString().split('T')[0],
                            close: json.c[i]
                        };
                    }
                    return result;
                }
            }
        } catch (e) {
            console.warn(`[SyntheticHistory] Finnhub failed for ${ticker}:`, e.message);
        }
    }

    return null;
}

// ========== MAIN: BUILD SYNTHETIC HISTORY ==========
//
// Input:  client object (with holdings[] and cashBalance)
// Output: [{date: 'YYYY-MM-DD', value: number, returnPct: number}]
//         where returnPct is normalized to 0% on first data point.
//
// Algorithm:
//   1. Filter to stock holdings with shares > 0
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

    // Step 1: Filter eligible holdings
    const stockHoldings = client.holdings.filter(
        h => h.type === 'stock' && h.shares > 0 && h.ticker
    );
    if (stockHoldings.length === 0) return null;

    const outputSize = _rangeToOutputSize(range); // Reuse existing charts.js helper
    console.log(`[SyntheticHistory] Fetching ${outputSize} days for ${stockHoldings.length} tickers: ${stockHoldings.map(h => h.ticker).join(', ')}`);

    // Step 2: Fetch historical data — batched with rate limiting
    //         3 concurrent fetches balances speed vs API rate limits
    const tickerSeries = {};
    const BATCH_SIZE = 3;

    for (let i = 0; i < stockHoldings.length; i += BATCH_SIZE) {
        const batch = stockHoldings.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(h => _fetchTickerTimeSeries(h.ticker, h.currency, outputSize))
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled' && results[j].value) {
                tickerSeries[batch[j].ticker] = results[j].value;
            }
        }

        // Rate-limit delay between batches (Twelve Data allows 8 calls/min on free tier)
        if (i + BATCH_SIZE < stockHoldings.length) {
            await new Promise(r => setTimeout(r, 1200));
        }
    }

    const fetchedTickers = Object.keys(tickerSeries);
    if (fetchedTickers.length === 0) {
        console.warn('[SyntheticHistory] No historical data fetched for any ticker');
        return null;
    }
    console.log(`[SyntheticHistory] Got data for ${fetchedTickers.length}/${stockHoldings.length} tickers`);

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
    const n = backbone.length;
    const history = new Array(n);
    const lastKnown = {};    // Forward-fill buffer: ticker → last known close
    const cashBalance = client.cashBalance || 0;

    for (let i = 0; i < n; i++) {
        const date = backbone[i].date;
        let totalValue = cashBalance; // Cash is constant throughout synthetic history

        for (let j = 0; j < stockHoldings.length; j++) {
            const h = stockHoldings[j];
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
                // Ticker fetch failed entirely — hold at cost basis
                totalValue += h.costBasis || 0;
            }
        }

        history[i] = { date, value: totalValue };
    }

    // Step 6: Normalize to percentage return from first data point
    //
    //   returnPct_i = ((Vᵢ − V₀) / V₀) × 100
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
