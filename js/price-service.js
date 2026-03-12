// ========== PRICE SERVICE - Real-time Market Data via Twelve Data API ==========

// Cache timestamp — avoid hitting API more than once per 5 minutes
let priceCacheTimestamp = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ========== FETCH REAL PRICES FROM TWELVE DATA ==========

async function fetchTwelveDataPrices(tickers, holdingsMap) {
    if (!TWELVE_DATA_API_KEY || TWELVE_DATA_API_KEY === 'YOUR_TWELVE_DATA_API_KEY') {
        console.warn('[PriceService] Twelve Data API key not configured');
        return null;
    }

    const results = {};

    // Build symbol list — append :TASE for Israeli stocks (ILS currency)
    const symbols = tickers.map(t => {
        const h = holdingsMap[t];
        return (h && h.currency === 'ILS') ? `${t}:TASE` : t;
    });

    console.log(`[PriceService] Twelve Data: requesting ${symbols.length} symbols...`);

    // Chunk into groups of 8 (free tier rate limit: 8 credits/minute)
    let rateLimited = false;
    for (let i = 0; i < symbols.length; i += 8) {
        // If we got rate limited, skip remaining chunks
        if (rateLimited) break;

        const chunk = symbols.slice(i, i + 8);
        const originalTickers = tickers.slice(i, i + 8);

        // Delay between chunks to respect rate limit
        if (i > 0) await new Promise(r => setTimeout(r, 1000));

        try {
            const symbolStr = chunk.join(',');
            const res = await fetch(
                `https://api.twelvedata.com/quote?symbol=${symbolStr}&apikey=${TWELVE_DATA_API_KEY}`
            );

            if (res.status === 429) {
                console.warn('[PriceService] Twelve Data: 429 rate limit reached — skipping all remaining chunks');
                rateLimited = true;
                break;
            }

            if (!res.ok) {
                console.warn(`[PriceService] Twelve Data API error: ${res.status} ${res.statusText}`);
                continue;
            }

            const data = await res.json();

            // Check for API-level error (daily limit exceeded returns 200 with error in body)
            if (data.code === 429 || (data.status === 'error' && data.message && data.message.includes('limit'))) {
                console.warn(`[PriceService] Twelve Data: API limit reached — ${data.message}`);
                rateLimited = true;
                break;
            }

            // Single symbol → response is the quote object directly
            // Multiple symbols → response is keyed by symbol
            if (chunk.length === 1) {
                const ticker = originalTickers[0];
                if (data.status === 'error') {
                    console.warn(`[PriceService] Twelve Data: no data for ${ticker}: ${data.message}`);
                    continue;
                }
                results[ticker] = {
                    price: parseFloat(data.close),
                    previousClose: parseFloat(data.previous_close),
                    change: parseFloat(data.change),
                    changePct: parseFloat(data.percent_change),
                    currency: data.currency || 'USD'
                };
                console.log(`[PriceService] Twelve Data: ${ticker} = $${data.close}`);
            } else {
                chunk.forEach((sym, idx) => {
                    const ticker = originalTickers[idx];
                    const q = data[sym];
                    if (!q || q.status === 'error') {
                        console.warn(`[PriceService] Twelve Data: no data for ${ticker}`);
                        return;
                    }
                    results[ticker] = {
                        price: parseFloat(q.close),
                        previousClose: parseFloat(q.previous_close),
                        change: parseFloat(q.change),
                        changePct: parseFloat(q.percent_change),
                        currency: q.currency || 'USD'
                    };
                    console.log(`[PriceService] Twelve Data: ${ticker} = $${q.close}`);
                });
            }
        } catch (err) {
            console.warn('[PriceService] Twelve Data fetch failed:', err.message);
        }
    }

    console.log(`[PriceService] Twelve Data: got ${Object.keys(results).length}/${tickers.length} prices`);
    return Object.keys(results).length > 0 ? results : null;
}

// ========== SYMBOL SEARCH (for smart ticker input) ==========

let tickerSearchTimeout = null;

async function searchTwelveDataSymbols(query) {
    if (!TWELVE_DATA_API_KEY || TWELVE_DATA_API_KEY === 'YOUR_TWELVE_DATA_API_KEY') {
        console.warn('Twelve Data API key not configured');
        return [];
    }

    if (!query || query.length < 1) return [];

    try {
        const res = await fetch(
            `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(query)}&apikey=${TWELVE_DATA_API_KEY}`
        );

        if (!res.ok) {
            console.warn('Twelve Data symbol search error:', res.status);
            return [];
        }

        const data = await res.json();

        if (!data.data || !Array.isArray(data.data)) return [];

        // Only show US exchanges (NASDAQ, NYSE, OTC) and Israeli (TASE), deduplicate by symbol
        const US_EXCHANGES = ['NASDAQ', 'NYSE', 'OTC'];
        const ALLOWED_EXCHANGES = [...US_EXCHANGES, 'TASE'];
        const seen = new Set();

        const queryUpper = query.toUpperCase().trim();

        let filtered = data.data
            .filter(item => ['Common Stock', 'ETF', 'American Depositary Receipt', 'Mutual Fund'].includes(item.instrument_type))
            .filter(item => ALLOWED_EXCHANGES.includes(item.exchange))
            .filter(item => {
                // For US exchanges — deduplicate by symbol (keep first, usually NASDAQ/NYSE)
                // For TASE — always allow (even if same symbol exists in US)
                if (item.exchange === 'TASE') {
                    const key = `${item.symbol}:TASE`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                }
                if (seen.has(item.symbol)) return false;
                seen.add(item.symbol);
                return true;
            });

        // Exact match — if query matches a symbol exactly, show only that result
        const exactMatches = filtered.filter(item => item.symbol.toUpperCase() === queryUpper);
        if (exactMatches.length > 0) {
            filtered = exactMatches;
        }

        return filtered
            .slice(0, 10)
            .map(item => ({
                symbol: item.symbol,
                name: item.instrument_name,
                exchange: item.exchange,
                currency: item.currency === 'ILA' ? 'ILS' : item.currency,
                country: item.country,
                type: item.instrument_type
            }));
    } catch (err) {
        console.warn('Twelve Data symbol search failed:', err.message);
        return [];
    }
}

// ========== FMP API FALLBACK (Financial Modeling Prep) ==========

async function fetchFMPPrices(tickers) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') return null;

    const results = {};
    console.log(`[PriceService] FMP: requesting ${tickers.length} tickers...`);

    // Use stable endpoint one by one (v3 batch is blocked on free plan)
    for (const ticker of tickers) {
        try {
            const res = await fetch(
                `https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${FMP_API_KEY}`
            );
            if (res.status === 402 || res.status === 403) {
                console.warn(`[PriceService] FMP: ${ticker} requires premium (${res.status})`);
                continue;
            }
            if (!res.ok) continue;

            const data = await res.json();
            if (Array.isArray(data) && data.length > 0 && data[0].price) {
                const q = data[0];
                results[ticker] = {
                    price: q.price,
                    previousClose: q.previousClose || q.price,
                    change: q.change || 0,
                    changePct: q.changePercentage || 0,
                    currency: 'USD'
                };
                console.log(`[PriceService] FMP: ${ticker} = $${q.price}`);
            }
        } catch (err) {
            // Silent — try next ticker
        }
    }

    console.log(`[PriceService] FMP: got ${Object.keys(results).length}/${tickers.length} prices`);
    return Object.keys(results).length > 0 ? results : null;
}

// ========== FINNHUB API FALLBACK (free: 60 calls/min, all US stocks) ==========

async function fetchFinnhubPrices(tickers) {
    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY') {
        console.warn('[PriceService] Finnhub API key not configured — get a free key at https://finnhub.io/register');
        return null;
    }

    const results = {};
    console.log(`[PriceService] Finnhub: requesting ${tickers.length} tickers...`);

    for (const ticker of tickers) {
        try {
            const res = await fetch(
                `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`
            );

            if (res.status === 429) {
                console.warn('[PriceService] Finnhub: rate limit reached, stopping');
                break;
            }
            if (!res.ok) continue;

            const q = await res.json();
            // Finnhub returns: c=current, pc=previousClose, d=change, dp=changePct
            // c=0 means no data for this symbol
            if (q && q.c && q.c > 0) {
                results[ticker] = {
                    price: q.c,
                    previousClose: q.pc || q.c,
                    change: q.d || 0,
                    changePct: q.dp || 0,
                    currency: 'USD'
                };
                console.log(`[PriceService] Finnhub: ${ticker} = $${q.c}`);
            }
        } catch (err) {
            console.warn(`[PriceService] Finnhub: failed for ${ticker}:`, err.message);
        }
    }

    console.log(`[PriceService] Finnhub: got ${Object.keys(results).length}/${tickers.length} prices`);
    return Object.keys(results).length > 0 ? results : null;
}

// ========== SIMULATE BOND PRICES ==========

function simulateBondPrice(holding) {
    // Small daily variation for bonds (±0.3%)
    const variation = (Math.random() - 0.5) * 0.006;
    const newPrice = holding.price * (1 + variation);
    const previousClose = holding.price;
    return { price: Math.round(newPrice * 100) / 100, previousClose };
}

// ========== MAIN: UPDATE PRICES FOR ALL CLIENTS ==========

async function updatePricesFromAPI() {
    const now = Date.now();

    // Skip if cache is fresh
    if (now - priceCacheTimestamp < PRICE_CACHE_TTL) {
        console.log('[PriceService] Cache still fresh, skipping API call.');
        return;
    }

    if (!clients || clients.length === 0) {
        console.log('[PriceService] No clients loaded, skipping price update.');
        return;
    }

    // 1. Collect unique stock tickers and build holdings map (for currency detection)
    const stockTickers = new Set();
    const holdingsMap = {};

    clients.forEach(client => {
        client.holdings.forEach(h => {
            if (h.type === 'stock') {
                stockTickers.add(h.ticker);
                if (!holdingsMap[h.ticker]) holdingsMap[h.ticker] = h;
            }
        });
    });

    const tickerArray = [...stockTickers];
    if (tickerArray.length === 0) {
        console.log('[PriceService] No stock holdings found, skipping price update.');
        return;
    }

    console.log(`[PriceService] === Starting price update for ${tickerArray.length} tickers: ${tickerArray.join(', ')} ===`);

    // 2. Try Twelve Data first (primary source)
    let apiPrices = await fetchTwelveDataPrices(tickerArray, holdingsMap);
    let sources = [];
    if (apiPrices) sources.push('Twelve Data');

    // 3. Find tickers that Twelve Data missed
    let missingTickers = tickerArray.filter(t => !apiPrices || !apiPrices[t]);

    // 4. Try FMP for missing tickers (fallback #1)
    if (missingTickers.length > 0) {
        console.log(`[PriceService] Missing ${missingTickers.length} tickers after Twelve Data, trying FMP...`);
        const fmpPrices = await fetchFMPPrices(missingTickers);
        if (fmpPrices) {
            if (!apiPrices) apiPrices = {};
            Object.assign(apiPrices, fmpPrices);
            sources.push('FMP');
        }
    }

    // 5. Try Finnhub for still-missing tickers (fallback #2)
    missingTickers = tickerArray.filter(t => !apiPrices || !apiPrices[t]);
    if (missingTickers.length > 0) {
        console.log(`[PriceService] Missing ${missingTickers.length} tickers after FMP, trying Finnhub...`);
        const finnhubPrices = await fetchFinnhubPrices(missingTickers);
        if (finnhubPrices) {
            if (!apiPrices) apiPrices = {};
            Object.assign(apiPrices, finnhubPrices);
            sources.push('Finnhub');
        }
    }

    const source = sources.length > 0 ? sources.join(' + ') : 'none';

    // 5. Build price map — ONLY use real API data, never simulated
    const priceMap = {};
    tickerArray.forEach(ticker => {
        if (apiPrices && apiPrices[ticker]) {
            priceMap[ticker] = apiPrices[ticker];
        }
    });

    const fetchedCount = Object.keys(priceMap).length;
    const skippedCount = tickerArray.length - fetchedCount;

    // Update global cache (only with real data)
    Object.assign(priceCache, priceMap);

    // CRITICAL FIX: Only set cache timestamp if we actually got prices
    // Otherwise allow immediate retry on next call
    if (fetchedCount > 0) {
        priceCacheTimestamp = now;
        console.log(`[PriceService] ✓ Updated ${fetchedCount} real prices from ${source}.`);
    } else {
        console.warn('[PriceService] ✗ No prices fetched from any API — cache NOT set, will retry next call.');
    }

    if (skippedCount > 0) {
        const skippedTickers = tickerArray.filter(t => !priceMap[t]);
        console.log(`[PriceService] ${skippedCount} tickers kept existing prices: ${skippedTickers.join(', ')}`);
    }

    // 6. Update holdings in Supabase
    if (!supabaseConnected) {
        console.log('[PriceService] Supabase not connected, skipping DB update.');
        return;
    }

    const affectedPortfolios = new Set();
    let updatedHoldings = 0;

    for (const client of clients) {
        for (const h of client.holdings) {
            let newPrice, newPreviousClose;

            if (h.type === 'stock' && priceMap[h.ticker]) {
                newPrice = priceMap[h.ticker].price;
                newPreviousClose = priceMap[h.ticker].previousClose;
            } else if (h.type === 'bond') {
                const bondSim = simulateBondPrice(h);
                newPrice = bondSim.price;
                newPreviousClose = bondSim.previousClose;
            } else {
                continue;
            }

            // Only update if price actually changed
            if (Math.abs(newPrice - h.price) < 0.001) continue;

            const newValue = h.shares * newPrice;

            const { error } = await supabaseClient
                .from('holdings')
                .update({
                    price: newPrice,
                    previous_close: newPreviousClose,
                    value: newValue
                })
                .eq('id', h.id);

            if (error) {
                console.error(`[PriceService] Failed to update ${h.ticker} in Supabase:`, error.message);
            } else {
                updatedHoldings++;
                console.log(`[PriceService] DB updated: ${h.ticker} $${h.price} → $${newPrice}`);
            }

            affectedPortfolios.add(client.id);
        }
    }

    console.log(`[PriceService] Updated ${updatedHoldings} holdings in Supabase across ${affectedPortfolios.size} portfolios.`);

    // 7. Recalculate affected portfolios
    for (const portfolioId of affectedPortfolios) {
        await supaRecalcClient(portfolioId);
    }

    // 8. Record performance snapshots for all portfolios (1 per day)
    for (const client of clients) {
        await supaRecordPerformanceSnapshot(client.id);
    }

    // 9. Re-fetch all clients with updated data
    clients = await supaFetchClients();
    console.log('[PriceService] === Price update complete ===');
}
