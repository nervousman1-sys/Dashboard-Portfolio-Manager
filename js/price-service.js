// ========== PRICE SERVICE - Real-time Market Data ==========
// Architecture: resolve fast with first-batch data, stream remaining in background.

let priceCacheTimestamp = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ========== TWELVE DATA: single chunk fetch (up to 8 symbols batched in one HTTP call) ==========

async function _fetchTwelveDataChunk(chunk, originalTickers, holdingsMap) {
    const symbols = chunk.map((_sym, i) => {
        const h = holdingsMap[originalTickers[i]];
        return (h && h.currency === 'ILS') ? `${originalTickers[i]}:TASE` : chunk[i];
    });

    const symbolStr = symbols.join(',');
    const res = await fetch(
        `https://api.twelvedata.com/quote?symbol=${symbolStr}&apikey=${TWELVE_DATA_API_KEY}`
    );

    if (res.status === 429) {
        console.warn('[PriceService] Twelve Data: 429 rate limit');
        return { results: {}, rateLimited: true };
    }
    if (!res.ok) {
        console.warn(`[PriceService] Twelve Data: ${res.status} ${res.statusText}`);
        return { results: {}, rateLimited: false };
    }

    const data = await res.json();

    if (data.code === 429 || (data.status === 'error' && data.message && data.message.includes('limit'))) {
        console.warn(`[PriceService] Twelve Data: API limit — ${data.message}`);
        return { results: {}, rateLimited: true };
    }

    const results = {};

    if (symbols.length === 1) {
        const ticker = originalTickers[0];
        if (data.status !== 'error' && data.close) {
            results[ticker] = {
                price: parseFloat(data.close),
                previousClose: parseFloat(data.previous_close),
                change: parseFloat(data.change),
                changePct: parseFloat(data.percent_change),
                currency: data.currency || 'USD'
            };
        }
    } else {
        symbols.forEach((sym, idx) => {
            const ticker = originalTickers[idx];
            const q = data[sym];
            if (!q || q.status === 'error') return;
            results[ticker] = {
                price: parseFloat(q.close),
                previousClose: parseFloat(q.previous_close),
                change: parseFloat(q.change),
                changePct: parseFloat(q.percent_change),
                currency: q.currency || 'USD'
            };
        });
    }

    return { results, rateLimited: false };
}

// ========== SYMBOL SEARCH (for smart ticker input — unchanged) ==========

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

        const US_EXCHANGES = ['NASDAQ', 'NYSE', 'OTC'];
        const ALLOWED_EXCHANGES = [...US_EXCHANGES, 'TASE'];
        const seen = new Set();
        const queryUpper = query.toUpperCase().trim();

        let filtered = data.data
            .filter(item => ['Common Stock', 'ETF', 'American Depositary Receipt', 'Mutual Fund'].includes(item.instrument_type))
            .filter(item => ALLOWED_EXCHANGES.includes(item.exchange))
            .filter(item => {
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

// ========== SINGLE-TICKER LIVE PRICE FETCH ==========
// Used by supaAddHolding when priceCache is empty (e.g. brand-new user).
// Tries Twelve Data → FMP → Finnhub in sequence. Returns {price, previousClose} or null.

async function fetchSingleTickerPrice(ticker, currency = null, basePrice = null) {
    if (!ticker) return null;
    const sym = ticker.toUpperCase().trim();

    // --- Israeli asset detection ---
    const isIsraeli = currency === 'ILS' || currency === 'ILA'
        || sym.endsWith('.TA') || sym.endsWith('.TASE');
    const isBond = /^\d{7,9}$/.test(sym);

    // Bonds (7-9 digit numeric): no API can fetch these, use simulation
    if (isBond) {
        const bp = basePrice || 100;
        const variation = (Math.random() - 0.5) * 0.006;
        const price = Math.round(bp * (1 + variation) * 100) / 100;
        const result = { price, previousClose: bp, change: +(price - bp).toFixed(2), changePct: +((price - bp) / bp * 100).toFixed(2), currency: 'ILS' };
        if (typeof priceCache !== 'undefined') priceCache[sym] = result;
        return result;
    }

    // Build Twelve Data symbol: strip .TA suffix and append :TASE for Israeli assets
    let tdSymbol = sym;
    if (isIsraeli) {
        tdSymbol = sym.replace('.TA', '').replace('.TASE', '') + ':TASE';
    }

    // Helper: bail immediately on 429 rate-limit (don't cascade to next provider)
    function _parseResult(res, data, provider) {
        if (!res.ok) {
            if (res.status === 429) console.warn(`[fetchSingleTickerPrice] ${provider} rate-limited (429) for ${sym}`);
            return null;
        }
        return data;
    }

    // Try Twelve Data first (with correct :TASE format for Israeli assets)
    try {
        if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
            const res = await fetch(`https://api.twelvedata.com/quote?symbol=${tdSymbol}&apikey=${TWELVE_DATA_API_KEY}`);
            const data = _parseResult(res, res.ok ? await res.json() : null, 'TwelveData');
            if (data && data.status !== 'error' && data.close) {
                let price = parseFloat(data.close);
                let prevClose = parseFloat(data.previous_close);
                // TASE prices sometimes returned in Agurot (×100) — detect & convert
                if (isIsraeli && price > 10000 && basePrice && basePrice < 1000) {
                    price /= 100;
                    prevClose /= 100;
                }
                const result = {
                    price,
                    previousClose: prevClose,
                    change: parseFloat(data.change) || +(price - prevClose).toFixed(2),
                    changePct: parseFloat(data.percent_change) || +((price - prevClose) / prevClose * 100).toFixed(2),
                    currency: data.currency === 'ILA' ? 'ILS' : (data.currency || (isIsraeli ? 'ILS' : 'USD'))
                };
                if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                return result;
            }
        }
    } catch (e) { console.warn('[fetchSingleTickerPrice] Twelve Data failed for', tdSymbol, e.message); }

    // --- FMP fallback ---
    // FMP supports both US tickers and TASE with .TA suffix (e.g. LUMI.TA)
    try {
        if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
            // For Israeli assets, FMP uses .TA suffix format
            const fmpSymbol = isIsraeli
                ? sym.replace('.TASE', '.TA').replace(/:TASE$/i, '.TA') + (sym.includes('.TA') ? '' : '.TA')
                : sym;
            // Dedupe: avoid "LUMI.TA.TA"
            const fmpClean = fmpSymbol.replace(/\.TA\.TA/g, '.TA');
            const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${fmpClean}&apikey=${FMP_API_KEY}`);
            const data = _parseResult(res, res.ok ? await res.json() : null, 'FMP');
            if (Array.isArray(data) && data.length > 0 && data[0].price) {
                const q = data[0];
                let fmpPrice = q.price;
                let fmpPrev = q.previousClose || q.price;
                // Agurot detection: Israeli stock prices > 10000 with known low base → divide by 100
                if (isIsraeli && fmpPrice > 10000 && basePrice && basePrice < 1000) {
                    fmpPrice /= 100;
                    fmpPrev /= 100;
                }
                const result = {
                    price: fmpPrice,
                    previousClose: fmpPrev,
                    change: q.change || +(fmpPrice - fmpPrev).toFixed(2),
                    changePct: q.changePercentage || +((fmpPrice - fmpPrev) / fmpPrev * 100).toFixed(2),
                    currency: isIsraeli ? 'ILS' : 'USD'
                };
                if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                return result;
            }
        }
    } catch (e) { console.warn('[fetchSingleTickerPrice] FMP failed for', sym, e.message); }

    // --- Yahoo Finance fallback (Israeli assets use .TA suffix natively) ---
    if (isIsraeli) {
        try {
            const yahooSym = sym.replace('.TASE', '.TA').replace(/:TASE$/i, '.TA') + (sym.includes('.TA') ? '' : '.TA');
            const yahooClean = yahooSym.replace(/\.TA\.TA/g, '.TA');
            const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooClean}?range=1d&interval=1d`);
            if (res.ok) {
                const data = await res.json();
                const meta = data?.chart?.result?.[0]?.meta;
                if (meta && meta.regularMarketPrice > 0) {
                    let yPrice = meta.regularMarketPrice;
                    let yPrev = meta.chartPreviousClose || meta.previousClose || yPrice;
                    // Agurot detection
                    if (yPrice > 10000 && basePrice && basePrice < 1000) {
                        yPrice /= 100;
                        yPrev /= 100;
                    }
                    const result = {
                        price: yPrice,
                        previousClose: yPrev,
                        change: +(yPrice - yPrev).toFixed(2),
                        changePct: +((yPrice - yPrev) / yPrev * 100).toFixed(2),
                        currency: meta.currency === 'ILA' ? 'ILS' : (meta.currency || 'ILS')
                    };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] Yahoo Finance failed for', sym, e.message); }
    }

    // --- Finnhub fallback (US assets only — Finnhub doesn't support TASE) ---
    if (!isIsraeli) {
        try {
            if (FINNHUB_API_KEY && FINNHUB_API_KEY !== 'YOUR_FINNHUB_API_KEY') {
                const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
                const data = _parseResult(res, res.ok ? await res.json() : null, 'Finnhub');
                if (data && data.c && data.c > 0) {
                    const result = {
                        price: data.c,
                        previousClose: data.pc || data.c,
                        change: data.d || 0,
                        changePct: data.dp || 0,
                        currency: 'USD'
                    };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] Finnhub failed for', sym, e.message); }
    }

    return null;
}

// ========== FMP FALLBACK (all tickers in parallel) ==========

async function fetchFMPPrices(tickers) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') return null;

    console.log(`[PriceService] FMP: ${tickers.length} tickers in parallel...`);

    const settled = await Promise.allSettled(tickers.map(ticker =>
        fetch(`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${FMP_API_KEY}`)
            .then(res => {
                if (res.status === 402 || res.status === 403 || !res.ok) return null;
                return res.json();
            })
            .then(data => {
                if (Array.isArray(data) && data.length > 0 && data[0].price) {
                    const q = data[0];
                    return { ticker, price: q.price, previousClose: q.previousClose || q.price, change: q.change || 0, changePct: q.changePercentage || 0, currency: 'USD' };
                }
                return null;
            })
            .catch(() => null)
    ));

    const results = {};
    settled.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
            const v = r.value;
            results[v.ticker] = { price: v.price, previousClose: v.previousClose, change: v.change, changePct: v.changePct, currency: v.currency };
        }
    });

    console.log(`[PriceService] FMP: got ${Object.keys(results).length}/${tickers.length}`);
    return Object.keys(results).length > 0 ? results : null;
}

// ========== FINNHUB FALLBACK (all tickers in parallel) ==========

async function fetchFinnhubPrices(tickers) {
    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY') return null;

    console.log(`[PriceService] Finnhub: ${tickers.length} tickers in parallel...`);

    const settled = await Promise.allSettled(tickers.map(ticker =>
        fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`)
            .then(res => {
                if (res.status === 429 || !res.ok) return null;
                return res.json();
            })
            .then(q => {
                if (q && q.c && q.c > 0) {
                    return { ticker, price: q.c, previousClose: q.pc || q.c, change: q.d || 0, changePct: q.dp || 0, currency: 'USD' };
                }
                return null;
            })
            .catch(() => null)
    ));

    const results = {};
    settled.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
            const v = r.value;
            results[v.ticker] = { price: v.price, previousClose: v.previousClose, change: v.change, changePct: v.changePct, currency: v.currency };
        }
    });

    console.log(`[PriceService] Finnhub: got ${Object.keys(results).length}/${tickers.length}`);
    return Object.keys(results).length > 0 ? results : null;
}

// ========== BOND SIMULATION ==========

function simulateBondPrice(holding) {
    const variation = (Math.random() - 0.5) * 0.006;
    const newPrice = holding.price * (1 + variation);
    return { price: Math.round(newPrice * 100) / 100, previousClose: holding.price };
}

// ========== FX-AWARE PORTFOLIO RECALCULATION ==========
// Recomputes portfolio totals with currency conversion.
// Each holding's native-currency value (h.value) is preserved for per-holding display.
// The portfolio total converts everything to USD (display currency) using live FX rates.
// Uses getFxRate() and convertToDisplayCurrency() from fx-service.js.

function _recalcPortfolioWithFx(client) {
    const displayCurrency = 'USD';
    let holdingsValueConverted = 0;

    client.holdings.forEach(h => {
        // h.value stays in native currency (used for per-holding display in modals)
        // _valueInDisplayCurrency is the FX-converted value for portfolio totals
        h._valueInDisplayCurrency = getHoldingValueInDisplayCurrency(h, displayCurrency);
        holdingsValueConverted += h._valueInDisplayCurrency;
    });

    // Convert cash buckets to display currency
    // Legacy fallback: if client.cash doesn't exist, use cashBalance as USD
    let cashUsd = client.cash?.usd || 0;
    let cashIls = client.cash?.ils || 0;
    if (cashUsd === 0 && cashIls === 0 && (client.cashBalance || 0) > 0) {
        cashUsd = client.cashBalance;
    }
    const cashConverted = convertToDisplayCurrency(cashUsd, 'USD', displayCurrency)
                        + convertToDisplayCurrency(cashIls, 'ILS', displayCurrency);

    client.portfolioValue = holdingsValueConverted + cashConverted;

    // Allocation % based on FX-converted values (apples-to-apples comparison)
    const totalValue = client.portfolioValue;
    let stockPct = 0, bondPct = 0;

    client.holdings.forEach(h => {
        h.allocationPct = totalValue > 0 ? (h._valueInDisplayCurrency / totalValue * 100) : 0;
        const pct = h.allocationPct;
        if (h.type === 'stock') stockPct += pct;
        else bondPct += pct;
    });

    client.stockPct = stockPct;
    client.bondPct = bondPct;

    if (stockPct > 70) { client.risk = 'high'; client.riskLabel = 'גבוה'; }
    else if (stockPct >= 40) { client.risk = 'medium'; client.riskLabel = 'בינוני'; }
    else { client.risk = 'low'; client.riskLabel = 'נמוך'; }
}

// ========== IN-MEMORY PRICE APPLICATION ==========
// Updates the global `clients` array with new prices, recalculates per-portfolio metrics.
// Returns true if anything changed.

function _applyPricesToClientsInMemory(priceMap) {
    if (!priceMap || !clients || clients.length === 0) return false;

    let anyChanged = false;

    clients.forEach(client => {
        let clientChanged = false;

        client.holdings.forEach(h => {
            if (h.type === 'stock' && priceMap[h.ticker]) {
                const newPrice = priceMap[h.ticker].price;
                const newPrevClose = priceMap[h.ticker].previousClose;

                // Always apply live API prices — no locks, no conditions.
                // The API is the source of truth for current market prices.
                if (newPrice > 0) {
                    h.previousClose = newPrevClose;
                    h.price = newPrice;
                    h.value = h.shares * newPrice; // Native currency value (for per-holding display)
                    h._livePriceResolved = true;
                    clientChanged = true;
                }
            }
        });

        if (clientChanged) {
            anyChanged = true;
            _recalcPortfolioWithFx(client);
        }
    });

    return anyChanged;
}

// ========================================================================
// MAIN ENTRY POINT: updatePricesFromAPI(onUpdate)
//
// Contract:
//   - Resolves its Promise after the FIRST batch of live prices (~1-2s).
//   - Calls onUpdate() each time new price data is applied to the UI.
//   - Remaining API chunks, fallbacks, and Supabase persistence continue
//     as a detached background task that never blocks the caller.
// ========================================================================

async function updatePricesFromAPI(onUpdate) {
    const now = Date.now();

    if (now - priceCacheTimestamp < PRICE_CACHE_TTL) {
        console.log('[PriceService] Cache fresh, skipping.');
        return;
    }
    if (!clients || clients.length === 0) {
        console.log('[PriceService] No clients, skipping.');
        return;
    }

    // 1. Collect unique stock tickers + holdings map
    const stockTickers = new Set();
    const holdingsMap = {};
    clients.forEach(c => {
        c.holdings.forEach(h => {
            if (h.type === 'stock') {
                stockTickers.add(h.ticker);
                if (!holdingsMap[h.ticker]) holdingsMap[h.ticker] = h;
            }
        });
    });

    const allTickers = [...stockTickers];
    if (allTickers.length === 0) {
        console.log('[PriceService] No stock holdings, skipping.');
        return;
    }

    console.log(`[PriceService] === Price update: ${allTickers.length} tickers: ${allTickers.join(', ')} ===`);

    // Build Twelve Data symbol list (with :TASE suffix for ILS)
    const allSymbols = allTickers.map(t => {
        const h = holdingsMap[t];
        return (h && h.currency === 'ILS') ? `${t}:TASE` : t;
    });

    // 2. FAST PATH: Fetch only the first chunk (up to 8 symbols, one HTTP call, ~1s)
    //    This is the ONLY await before we return control to the caller.
    const firstChunkSymbols = allSymbols.slice(0, 8);
    const firstChunkTickers = allTickers.slice(0, 8);
    let collectedPrices = {};

    if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
        try {
            const first = await _fetchTwelveDataChunk(firstChunkSymbols, firstChunkTickers, holdingsMap);
            if (first.results && Object.keys(first.results).length > 0) {
                Object.assign(collectedPrices, first.results);
                Object.assign(priceCache, first.results);

                // Apply to in-memory clients + notify UI
                if (_applyPricesToClientsInMemory(first.results) && onUpdate) {
                    onUpdate();
                }

                console.log(`[PriceService] First batch: ${Object.keys(first.results).length} prices delivered`);
            }
        } catch (e) {
            console.warn('[PriceService] First chunk failed:', e.message);
        }
    }

    // ── RETURN POINT ──
    // The Promise resolves HERE. Caller gets control back.
    // Everything below runs as a detached fire-and-forget background task.

    _backgroundPriceCompletion(allTickers, allSymbols, holdingsMap, collectedPrices, onUpdate);
}

// ========== BACKGROUND COMPLETION (detached — never blocks caller) ==========

async function _backgroundPriceCompletion(allTickers, allSymbols, holdingsMap, collectedPrices, onUpdate) {
    try {
        const sources = Object.keys(collectedPrices).length > 0 ? ['Twelve Data'] : [];

        // 3. Remaining Twelve Data chunks (if >8 tickers)
        if (allSymbols.length > 8 && TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
            for (let i = 8; i < allSymbols.length; i += 8) {
                // Respect rate limit: 1s delay between chunks
                await new Promise(r => setTimeout(r, 1200));

                const chunkSymbols = allSymbols.slice(i, i + 8);
                const chunkTickers = allTickers.slice(i, i + 8);

                try {
                    const result = await _fetchTwelveDataChunk(chunkSymbols, chunkTickers, holdingsMap);
                    if (result.rateLimited) break;

                    if (result.results && Object.keys(result.results).length > 0) {
                        Object.assign(collectedPrices, result.results);
                        Object.assign(priceCache, result.results);

                        // Incremental UI update per chunk
                        if (_applyPricesToClientsInMemory(result.results) && onUpdate) {
                            onUpdate();
                        }
                    }
                } catch (e) {
                    console.warn('[PriceService] Chunk failed:', e.message);
                }
            }
            if (!sources.includes('Twelve Data') && Object.keys(collectedPrices).length > 0) {
                sources.push('Twelve Data');
            }
        }

        // 4. Find tickers still missing after Twelve Data
        const missingTickers = allTickers.filter(t => !collectedPrices[t]);

        if (missingTickers.length > 0) {
            console.log(`[PriceService] ${missingTickers.length} tickers missing, trying FMP + Finnhub in parallel...`);

            // Fire BOTH fallback APIs simultaneously
            const [fmpResult, finnhubResult] = await Promise.allSettled([
                fetchFMPPrices(missingTickers),
                fetchFinnhubPrices(missingTickers)
            ]);

            const fmpPrices = fmpResult.status === 'fulfilled' ? fmpResult.value : null;
            const finnhubPrices = finnhubResult.status === 'fulfilled' ? finnhubResult.value : null;

            const fallbackPrices = {};

            if (fmpPrices) {
                Object.assign(fallbackPrices, fmpPrices);
                sources.push('FMP');
            }
            if (finnhubPrices) {
                // Finnhub fills gaps FMP didn't cover
                Object.keys(finnhubPrices).forEach(t => {
                    if (!fallbackPrices[t]) fallbackPrices[t] = finnhubPrices[t];
                });
                if (Object.keys(finnhubPrices).some(t => !fmpPrices || !fmpPrices[t])) {
                    sources.push('Finnhub');
                }
            }

            if (Object.keys(fallbackPrices).length > 0) {
                Object.assign(collectedPrices, fallbackPrices);
                Object.assign(priceCache, fallbackPrices);

                // Incremental UI update with fallback data
                if (_applyPricesToClientsInMemory(fallbackPrices) && onUpdate) {
                    onUpdate();
                }
            }
        }

        // 5. Finalize
        const fetchedCount = Object.keys(collectedPrices).length;
        if (fetchedCount > 0) {
            priceCacheTimestamp = Date.now();
            console.log(`[PriceService] ${fetchedCount}/${allTickers.length} prices from ${sources.join(' + ')}`);
        } else {
            console.warn('[PriceService] No prices fetched from any API.');
        }

        const skippedCount = allTickers.length - fetchedCount;
        if (skippedCount > 0) {
            console.log(`[PriceService] ${skippedCount} tickers kept existing DB prices`);
        }

        // 6. Persist to Supabase (fire-and-forget — never blocks UI)
        if (supabaseConnected && fetchedCount > 0) {
            _persistPricesToSupabase(collectedPrices, onUpdate);
        }

    } catch (e) {
        console.warn('[PriceService] Background completion error:', e.message);
    }
}

// ========== SUPABASE PERSISTENCE (fire-and-forget) ==========

async function _persistPricesToSupabase(priceMap, onUpdate) {
    try {
        const affectedPortfolios = new Set();
        const updatePromises = [];

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

                // Always persist live API prices to DB — no locks.
                // If the API returned this price, it IS the current market price.
                const newValue = h.shares * newPrice;
                affectedPortfolios.add(client.id);

                updatePromises.push(
                    supabaseClient
                        .from('holdings')
                        .update({ price: newPrice, previous_close: newPreviousClose, value: newValue })
                        .eq('id', h.id)
                        .then(({ error }) => {
                            if (error) console.error(`[PriceService] DB update ${h.ticker}:`, error.message);
                            return !error;
                        })
                );
            }
        }

        // All holding writes in parallel
        const results = await Promise.allSettled(updatePromises);
        const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
        console.log(`[PriceService] Persisted ${ok} holdings across ${affectedPortfolios.size} portfolios`);

        // Recalculate + snapshot in parallel
        await Promise.allSettled(
            [...affectedPortfolios].map(id => supaRecalcClient(id))
        );

        await Promise.allSettled(
            clients.map(c => supaRecordPerformanceSnapshot(c.id))
        );

        // Re-assert live prices in memory (guard against supaRecalcClient reading stale DB).
        // DO NOT re-fetch clients from Supabase here — the in-memory state with API prices
        // is the source of truth. A full re-fetch would overwrite live prices with potentially
        // stale DB values if the writes above failed (RLS, network, timing).
        _applyPricesToClientsInMemory(priceMap);
        saveClientsToCache(clients);

        if (onUpdate) onUpdate();

        console.log('[PriceService] === Background persistence complete ===');
    } catch (e) {
        console.warn('[PriceService] Supabase persist error:', e.message);
    }
}
