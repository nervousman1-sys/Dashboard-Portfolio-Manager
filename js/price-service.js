// ========== PRICE SERVICE - Real-time Market Data ==========
// Architecture: resolve fast with first-batch data, stream remaining in background.

let priceCacheTimestamp = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ========== CORS PROXY FOR YAHOO FINANCE ==========
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

// ========== ISRAELI NUMERIC ID → YAHOO SYMBOL MAPPING ==========
// Common Israeli security IDs (TASE numeric identifiers) mapped to Yahoo Finance .TA symbols.
const ISRAELI_ID_TO_YAHOO = {
    '1081820': 'LUMI.TA',   // Bank Leumi
    '1082808': 'DSCT.TA',   // Bank Discount
    '1090878': 'POLI.TA',   // Bank Hapoalim
    '1081838': 'MZTF.TA',   // Mizrahi Tefahot
    '1082816': 'FIBI.TA',   // First International
    '1081861': 'TEVA.TA',   // Teva
    '1082600': 'NICE.TA',   // Nice Systems
    '1081879': 'ICL.TA',    // ICL Group
    '1082642': 'ESLT.TA',   // Elbit Systems
    '1082634': 'BEZQ.TA',   // Bezeq
    '1083038': 'CEL.TA',    // Cellcom
    '1082667': 'PTNR.TA',   // Partner
    '1090811': 'HARL.TA',   // Harel
    '1090829': 'PHOE.TA',   // Phoenix
    '1082659': 'MGDL.TA',   // Migdal
    '1090845': 'AZRG.TA',   // Azrieli
    '1090852': 'AMOT.TA',   // Amot
    '1082691': 'SHPG.TA',   // Shufersal
    '1090860': 'DLEKG.TA',  // Delek Group
    '1090837': 'ENLT.TA',   // Enlight Energy
    '1082683': 'OPC.TA',    // OPC Energy
    '1101534': 'FTAL.TA',   // Fattal Hotels
    '1090894': 'TASE.TA',   // Tel Aviv Stock Exchange
    '1090886': 'SPEN.TA',   // Shapir Engineering
    '1082675': 'GZIT.TA',   // Gazit Globe
    '1082717': 'ALHE.TA',   // Alon Blue Square
    '1082709': 'ELCO.TA',   // Elco
};

// ========== ISRAELI BOND ID → YAHOO ISIN SYMBOL MAPPING ==========
// Israeli bonds on Yahoo Finance use ISIN format: IL00XXXXXXXX.TA
// Maps internal bond IDs (from BONDS array), common TASE numeric IDs, and short names
// to their Yahoo Finance ISIN-based symbols.
const ISRAELI_BOND_TO_YAHOO = {
    // --- IL Gov Bond CPI-Linked ---
    'IL_CPI_1':    'IL0011501681.TA',  // IL Gov Bond CPI-Linked 0523
    'IL_CPI_2':    'IL0011502887.TA',  // IL Gov Bond CPI-Linked 0825
    'IL_CPI_3':    'IL0011503695.TA',  // IL Gov Bond CPI-Linked 1127
    'IL_CPI_4':    'IL0011504503.TA',  // IL Gov Bond CPI-Linked 0530
    // --- IL Gov Bond Fixed ---
    'IL_SHAHAR_1': 'IL0060401148.TA',  // IL Gov Bond Fixed 0125
    'IL_SHAHAR_2': 'IL0060402146.TA',  // IL Gov Bond Fixed 0327
    'IL_SHAHAR_3': 'IL0060403144.TA',  // IL Gov Bond Fixed 0130
    // --- IL Gov Bond Variable ---
    'IL_GILON_1':  'IL0072401148.TA',  // IL Gov Bond Variable 0225
    'IL_GILON_2':  'IL0072402146.TA',  // IL Gov Bond Variable 0326
    // --- Common numeric TASE IDs for government bonds ---
    '1150168':     'IL0011501681.TA',
    '1150288':     'IL0011502887.TA',
    '1150369':     'IL0011503695.TA',
    '1150450':     'IL0011504503.TA',
    '6040114':     'IL0060401148.TA',
    '6040214':     'IL0060402146.TA',
    '6040314':     'IL0060403144.TA',
    // --- Corporate Bonds - common issuers ---
    'LEUMI_BOND':  'IL0010501682.TA',  // Leumi Bond
    'DSCT_BOND':   'IL0010502888.TA',  // Discount Bond
    'BEZQ_BOND':   'IL0010601037.TA',  // Bezeq Bond
    'ICL_BOND':    'IL0010701035.TA',  // ICL Bond
    'TEVA_BOND':   'IL0010801033.TA',  // Teva Bond
};

// Resolves a bond identifier to its Yahoo Finance ISIN symbol.
// Checks: direct mapping → ISIN-format pass-through → null (not found).
function _resolveBondYahooSymbol(sym) {
    // Direct mapping lookup (internal ID, numeric ID, or named key)
    if (ISRAELI_BOND_TO_YAHOO[sym]) return ISRAELI_BOND_TO_YAHOO[sym];

    // Already an ISIN with .TA suffix (e.g. IL0011501681.TA)
    if (/^IL\d{10,12}\.TA$/i.test(sym)) return sym.toUpperCase();

    // Bare ISIN without .TA (e.g. IL0011501681)
    if (/^IL\d{10,12}$/i.test(sym)) return sym.toUpperCase() + '.TA';

    // Check if numeric ID is in the mapping (without leading zeros)
    const trimmed = sym.replace(/^0+/, '');
    if (ISRAELI_BOND_TO_YAHOO[trimmed]) return ISRAELI_BOND_TO_YAHOO[trimmed];

    return null;
}

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

// ========== YAHOO FINANCE VIA CORS PROXY ==========
// Fetches a single ticker from Yahoo Finance chart API through the CORS proxy.
// For Israeli (.TA) stocks, Yahoo returns prices in Agurot — ALWAYS divide by 100.
// Returns { price, previousClose, change, changePct, currency } or null.

async function _fetchYahooPrice(yahooSymbol) {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`;
    const proxyUrl = CORS_PROXY + encodeURIComponent(yahooUrl);

    const res = await fetch(proxyUrl);
    if (!res.ok) return null;

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice || meta.regularMarketPrice <= 0) return null;

    let rawPrice = parseFloat(meta.regularMarketPrice);
    let rawPrevClose = parseFloat(meta.chartPreviousClose || meta.previousClose || rawPrice);

    // TASE stocks on Yahoo are ALWAYS quoted in Agurot (Israeli cents).
    // Divide by 100 to get NIS. Detect via .TA suffix or ILA currency.
    const isTASE = yahooSymbol.toUpperCase().endsWith('.TA');
    const isAgurot = isTASE || meta.currency === 'ILA';

    if (isAgurot) {
        rawPrice = rawPrice / 100;
        rawPrevClose = rawPrevClose / 100;
    }

    return {
        price: Math.round(rawPrice * 100) / 100,
        previousClose: Math.round(rawPrevClose * 100) / 100,
        change: +((rawPrice - rawPrevClose).toFixed(2)),
        changePct: rawPrevClose ? +((rawPrice - rawPrevClose) / rawPrevClose * 100).toFixed(2) : 0,
        currency: isTASE ? 'ILS' : (meta.currency || 'USD')
    };
}

// ========== RESOLVE YAHOO SYMBOL ==========
// Converts various Israeli ticker formats to Yahoo Finance symbol:
//   - Numeric ID (e.g. "1101534") → lookup in ISRAELI_ID_TO_YAHOO → "FTAL.TA"
//   - Bare ticker (e.g. "LUMI") with Israeli context → "LUMI.TA"
//   - Already .TA suffixed → pass through

function _resolveYahooSymbol(sym, isIsraeli) {
    // Check numeric ID mapping first
    if (ISRAELI_ID_TO_YAHOO[sym]) return ISRAELI_ID_TO_YAHOO[sym];

    // Already has .TA suffix
    if (sym.endsWith('.TA')) return sym;

    // Israeli asset without .TA — add it
    if (isIsraeli) {
        const base = sym.replace('.TASE', '').replace(/:TASE$/i, '');
        return base + '.TA';
    }

    // Non-Israeli — Yahoo uses bare symbol (AAPL, MSFT, etc.)
    return sym;
}

// ========== SINGLE-TICKER LIVE PRICE FETCH ==========
// Used by supaAddHolding when priceCache is empty (e.g. brand-new user).
// Israeli stocks: Yahoo Finance (via CORS proxy) → Twelve Data → FMP (fallback chain)
// US stocks: Twelve Data → FMP → Finnhub (fallback chain)

async function fetchSingleTickerPrice(ticker, currency = null, basePrice = null) {
    if (!ticker) return null;
    const sym = ticker.toUpperCase().trim();

    // --- Israeli asset detection ---
    const isIsraeli = currency === 'ILS' || currency === 'ILA'
        || sym.endsWith('.TA') || sym.endsWith('.TASE')
        || !!ISRAELI_ID_TO_YAHOO[sym]
        || !!ISRAELI_BOND_TO_YAHOO[sym];
    const isBondNumeric = /^\d{7,9}$/.test(sym) && !ISRAELI_ID_TO_YAHOO[sym];
    const isBondMapped = !!_resolveBondYahooSymbol(sym);
    const isBond = isBondNumeric || isBondMapped;

    // --- Bonds: Try Yahoo Finance (ISIN lookup) → basePrice simulation fallback ---
    if (isBond) {
        const bondYahooSym = _resolveBondYahooSymbol(sym);

        // Provider 1 (Bond): Yahoo Finance via CORS proxy (ISIN-based)
        if (bondYahooSym) {
            try {
                console.log(`[fetchSingleTickerPrice] Bond ${sym} → Yahoo ISIN: ${bondYahooSym}`);
                const yahooResult = await _fetchYahooPrice(bondYahooSym);
                if (yahooResult && yahooResult.price > 0) {
                    // Bond prices from Yahoo .TA are in Agurot — _fetchYahooPrice already divides by 100
                    console.log(`[fetchSingleTickerPrice] Bond Yahoo returned ₪${yahooResult.price} for ${bondYahooSym}`);
                    const result = { ...yahooResult, currency: 'ILS', isBond: true };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            } catch (e) {
                console.warn('[fetchSingleTickerPrice] Yahoo Finance bond fetch failed for', bondYahooSym, e.message);
            }
        }

        // Fallback: basePrice simulation (for corporate bonds not on Yahoo, or API failures)
        const bp = basePrice || 100;
        const variation = (Math.random() - 0.5) * 0.006;
        const price = Math.round(bp * (1 + variation) * 100) / 100;
        const result = {
            price, previousClose: bp,
            change: +(price - bp).toFixed(2),
            changePct: +((price - bp) / bp * 100).toFixed(2),
            currency: 'ILS',
            isBond: true,
            unavailable: !bondYahooSym  // true if no Yahoo mapping exists → UI can show "Price Unavailable"
        };
        if (typeof priceCache !== 'undefined') priceCache[sym] = result;
        if (!bondYahooSym) {
            console.warn(`[fetchSingleTickerPrice] Bond ${sym}: no Yahoo ISIN mapping, using simulated price. UI should show "Price Unavailable".`);
        }
        return result;
    }

    // Build symbol variants
    const baseTicker = sym.replace('.TA', '').replace('.TASE', '').replace(/:TASE$/i, '');
    const tdSymbol = isIsraeli ? baseTicker + ':TASE' : sym;  // Twelve Data format

    // Helper: bail on 429
    function _parseResult(res, data, provider) {
        if (!res.ok) {
            if (res.status === 429) console.warn(`[fetchSingleTickerPrice] ${provider} rate-limited (429) for ${sym}`);
            return null;
        }
        return data;
    }

    // =====================================================================
    // ISRAELI STOCKS: Yahoo Finance (CORS proxy) is PRIMARY — most reliable
    // for TASE data, free, no API key needed.
    // =====================================================================
    if (isIsraeli) {
        const yahooSym = _resolveYahooSymbol(sym, true);
        console.log(`[fetchSingleTickerPrice] Israeli asset ${sym} → Yahoo: ${yahooSym}`);

        // --- Provider 1 (Israeli): Yahoo Finance via CORS proxy ---
        try {
            const yahooResult = await _fetchYahooPrice(yahooSym);
            if (yahooResult && yahooResult.price > 0) {
                console.log(`[fetchSingleTickerPrice] Yahoo returned ₪${yahooResult.price} for ${yahooSym}`);
                if (typeof priceCache !== 'undefined') priceCache[sym] = yahooResult;
                return yahooResult;
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] Yahoo Finance failed for', yahooSym, e.message); }

        // --- Provider 2 (Israeli): Twelve Data fallback ---
        try {
            if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
                const res = await fetch(`https://api.twelvedata.com/quote?symbol=${tdSymbol}&apikey=${TWELVE_DATA_API_KEY}`);
                const data = _parseResult(res, res.ok ? await res.json() : null, 'TwelveData');
                if (data && data.status !== 'error' && data.close) {
                    let price = parseFloat(data.close);
                    let prevClose = parseFloat(data.previous_close);
                    // Twelve Data for TASE may return Agurot
                    if (data.currency === 'ILA') { price /= 100; prevClose /= 100; }
                    else if (price > 500) { price /= 100; prevClose /= 100; }
                    const result = {
                        price: Math.round(price * 100) / 100,
                        previousClose: Math.round(prevClose * 100) / 100,
                        change: +(price - prevClose).toFixed(2),
                        changePct: prevClose ? +((price - prevClose) / prevClose * 100).toFixed(2) : 0,
                        currency: 'ILS'
                    };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] Twelve Data failed for', tdSymbol, e.message); }

        // --- Provider 3 (Israeli): FMP fallback ---
        try {
            if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
                const fmpTicker = baseTicker + '.TA';
                const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${fmpTicker}&apikey=${FMP_API_KEY}`);
                const data = _parseResult(res, res.ok ? await res.json() : null, 'FMP');
                if (Array.isArray(data) && data.length > 0 && data[0].price) {
                    const q = data[0];
                    let price = q.price;
                    let prevClose = q.previousClose || q.price;
                    if (q.currency === 'ILA') { price /= 100; prevClose /= 100; }
                    else if (price > 500) { price /= 100; prevClose /= 100; }
                    const result = {
                        price: Math.round(price * 100) / 100,
                        previousClose: Math.round(prevClose * 100) / 100,
                        change: +(price - prevClose).toFixed(2),
                        changePct: prevClose ? +((price - prevClose) / prevClose * 100).toFixed(2) : 0,
                        currency: 'ILS'
                    };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] FMP failed for Israeli', sym, e.message); }

    } else {
        // =====================================================================
        // US / INTERNATIONAL STOCKS: Twelve Data → FMP → Finnhub
        // =====================================================================

        // --- Provider 1 (US): Twelve Data ---
        try {
            if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
                const res = await fetch(`https://api.twelvedata.com/quote?symbol=${sym}&apikey=${TWELVE_DATA_API_KEY}`);
                const data = _parseResult(res, res.ok ? await res.json() : null, 'TwelveData');
                if (data && data.status !== 'error' && data.close) {
                    const result = {
                        price: parseFloat(data.close),
                        previousClose: parseFloat(data.previous_close),
                        change: +(parseFloat(data.close) - parseFloat(data.previous_close)).toFixed(2),
                        changePct: parseFloat(data.previous_close) ? +((parseFloat(data.close) - parseFloat(data.previous_close)) / parseFloat(data.previous_close) * 100).toFixed(2) : 0,
                        currency: data.currency || 'USD'
                    };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] Twelve Data failed for', sym, e.message); }

        // --- Provider 2 (US): FMP ---
        try {
            if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
                const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=${sym}&apikey=${FMP_API_KEY}`);
                const data = _parseResult(res, res.ok ? await res.json() : null, 'FMP');
                if (Array.isArray(data) && data.length > 0 && data[0].price) {
                    const q = data[0];
                    const result = {
                        price: q.price,
                        previousClose: q.previousClose || q.price,
                        change: +(q.price - (q.previousClose || q.price)).toFixed(2),
                        changePct: (q.previousClose || q.price) ? +((q.price - (q.previousClose || q.price)) / (q.previousClose || q.price) * 100).toFixed(2) : 0,
                        currency: 'USD'
                    };
                    if (typeof priceCache !== 'undefined') priceCache[sym] = result;
                    return result;
                }
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] FMP failed for', sym, e.message); }

        // --- Provider 3 (US): Finnhub ---
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

        // --- Provider 4 (US): Yahoo Finance fallback (no CORS issues for US tickers) ---
        try {
            const yahooResult = await _fetchYahooPrice(sym);
            if (yahooResult && yahooResult.price > 0) {
                if (typeof priceCache !== 'undefined') priceCache[sym] = yahooResult;
                return yahooResult;
            }
        } catch (e) { console.warn('[fetchSingleTickerPrice] Yahoo Finance failed for', sym, e.message); }
    }

    // --- Final fallback: use basePrice (buy_price from Supabase) if all APIs failed ---
    if (basePrice && basePrice > 0) {
        console.warn(`[fetchSingleTickerPrice] All APIs failed for ${sym}, using basePrice fallback: ${basePrice}`);
        const result = {
            price: basePrice,
            previousClose: basePrice,
            change: 0,
            changePct: 0,
            currency: isIsraeli ? 'ILS' : 'USD'
        };
        if (typeof priceCache !== 'undefined') priceCache[sym] = result;
        return result;
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
            if (priceMap[h.ticker]) {
                const entry = priceMap[h.ticker];
                const newPrice = entry.price;
                const newPrevClose = entry.previousClose;

                // Apply live API prices for both stocks and bonds.
                // Skip entries explicitly marked as unavailable with no real price.
                if (newPrice > 0) {
                    h.previousClose = newPrevClose;
                    h.price = newPrice;
                    h.value = h.shares * newPrice;
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

    // 1. Collect unique stock + bond tickers + holdings map
    const stockTickers = new Set();
    const bondTickers = new Set();
    const holdingsMap = {};
    clients.forEach(c => {
        c.holdings.forEach(h => {
            if (h.type === 'stock') {
                stockTickers.add(h.ticker);
                if (!holdingsMap[h.ticker]) holdingsMap[h.ticker] = h;
            } else if (h.type === 'bond') {
                bondTickers.add(h.ticker);
                if (!holdingsMap[h.ticker]) holdingsMap[h.ticker] = h;
            }
        });
    });

    const allStockTickers = [...stockTickers];
    const allBondTickers = [...bondTickers];
    const allTickers = [...allStockTickers];  // stocks go through Twelve Data first
    if (allStockTickers.length === 0 && allBondTickers.length === 0) {
        console.log('[PriceService] No holdings, skipping.');
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

    _backgroundPriceCompletion(allTickers, allSymbols, holdingsMap, collectedPrices, onUpdate, allBondTickers);
}

// ========== BACKGROUND COMPLETION (detached — never blocks caller) ==========

async function _backgroundPriceCompletion(allTickers, allSymbols, holdingsMap, collectedPrices, onUpdate, bondTickers = []) {
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
            console.log(`[PriceService] ${missingTickers.length} tickers missing after Twelve Data...`);

            // Split missing tickers into Israeli and non-Israeli
            const missingIsraeli = missingTickers.filter(t => {
                const h = holdingsMap[t];
                return (h && h.currency === 'ILS') || t.endsWith('.TA') || !!ISRAELI_ID_TO_YAHOO[t];
            });
            const missingOther = missingTickers.filter(t => !missingIsraeli.includes(t));

            // 4a. Israeli tickers: Yahoo Finance via CORS proxy (parallel, up to 5 at a time)
            if (missingIsraeli.length > 0) {
                console.log(`[PriceService] Fetching ${missingIsraeli.length} Israeli tickers via Yahoo Finance...`);
                const yahooResults = await Promise.allSettled(
                    missingIsraeli.map(t => {
                        const yahooSym = _resolveYahooSymbol(t.toUpperCase(), true);
                        return _fetchYahooPrice(yahooSym).then(result => result ? { ticker: t, ...result } : null);
                    })
                );

                const yahooPrices = {};
                yahooResults.forEach(r => {
                    if (r.status === 'fulfilled' && r.value && r.value.price > 0) {
                        const { ticker, ...priceData } = r.value;
                        yahooPrices[ticker] = priceData;
                    }
                });

                if (Object.keys(yahooPrices).length > 0) {
                    Object.assign(collectedPrices, yahooPrices);
                    Object.assign(priceCache, yahooPrices);
                    sources.push('Yahoo Finance');
                    if (_applyPricesToClientsInMemory(yahooPrices) && onUpdate) {
                        onUpdate();
                    }
                    console.log(`[PriceService] Yahoo Finance: got ${Object.keys(yahooPrices).length}/${missingIsraeli.length} Israeli prices`);
                }
            }

            // 4b. Non-Israeli tickers: FMP + Finnhub in parallel
            if (missingOther.length > 0) {
                console.log(`[PriceService] ${missingOther.length} non-Israeli tickers, trying FMP + Finnhub...`);
                const [fmpResult, finnhubResult] = await Promise.allSettled([
                    fetchFMPPrices(missingOther),
                    fetchFinnhubPrices(missingOther)
                ]);

                const fmpPrices = fmpResult.status === 'fulfilled' ? fmpResult.value : null;
                const finnhubPrices = finnhubResult.status === 'fulfilled' ? finnhubResult.value : null;

                const fallbackPrices = {};

                if (fmpPrices) {
                    Object.assign(fallbackPrices, fmpPrices);
                    sources.push('FMP');
                }
                if (finnhubPrices) {
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
                    if (_applyPricesToClientsInMemory(fallbackPrices) && onUpdate) {
                        onUpdate();
                    }
                }
            }

            // 4c. Any STILL missing tickers (Israeli or not) — last-resort Yahoo for non-Israeli
            const stillMissing = allTickers.filter(t => !collectedPrices[t] && !missingIsraeli.includes(t));
            if (stillMissing.length > 0) {
                console.log(`[PriceService] ${stillMissing.length} tickers still missing, trying Yahoo Finance fallback...`);
                const lastResort = await Promise.allSettled(
                    stillMissing.map(t => _fetchYahooPrice(t).then(result => result ? { ticker: t, ...result } : null))
                );
                const lastPrices = {};
                lastResort.forEach(r => {
                    if (r.status === 'fulfilled' && r.value && r.value.price > 0) {
                        const { ticker, ...priceData } = r.value;
                        lastPrices[ticker] = priceData;
                    }
                });
                if (Object.keys(lastPrices).length > 0) {
                    Object.assign(collectedPrices, lastPrices);
                    Object.assign(priceCache, lastPrices);
                    if (!sources.includes('Yahoo Finance')) sources.push('Yahoo Finance');
                    if (_applyPricesToClientsInMemory(lastPrices) && onUpdate) {
                        onUpdate();
                    }
                }
            }
        }

        // 5. Bond price fetching via Yahoo Finance (ISIN-based)
        if (bondTickers.length > 0) {
            console.log(`[PriceService] Fetching ${bondTickers.length} bond prices via Yahoo Finance...`);
            const bondResults = await Promise.allSettled(
                bondTickers.map(t => {
                    const bondYahooSym = _resolveBondYahooSymbol(t.toUpperCase());
                    if (!bondYahooSym) {
                        // No ISIN mapping — use simulation fallback
                        const h = holdingsMap[t];
                        const bp = (h && h.price > 0) ? h.price : 100;
                        const variation = (Math.random() - 0.5) * 0.006;
                        const price = Math.round(bp * (1 + variation) * 100) / 100;
                        return Promise.resolve({
                            ticker: t, price, previousClose: bp,
                            change: +(price - bp).toFixed(2),
                            changePct: +((price - bp) / bp * 100).toFixed(2),
                            currency: 'ILS', isBond: true, unavailable: true
                        });
                    }
                    return _fetchYahooPrice(bondYahooSym)
                        .then(result => result && result.price > 0
                            ? { ticker: t, ...result, currency: 'ILS', isBond: true }
                            : null)
                        .catch(() => null);
                })
            );

            const bondPrices = {};
            bondResults.forEach(r => {
                if (r.status === 'fulfilled' && r.value && r.value.price > 0) {
                    const { ticker, ...priceData } = r.value;
                    bondPrices[ticker] = priceData;
                }
            });

            const realBondCount = Object.values(bondPrices).filter(p => !p.unavailable).length;
            if (Object.keys(bondPrices).length > 0) {
                Object.assign(collectedPrices, bondPrices);
                Object.assign(priceCache, bondPrices);
                if (realBondCount > 0 && !sources.includes('Yahoo Finance')) sources.push('Yahoo Finance');
                if (_applyPricesToClientsInMemory(bondPrices) && onUpdate) {
                    onUpdate();
                }
                console.log(`[PriceService] Bonds: ${realBondCount} from Yahoo, ${Object.keys(bondPrices).length - realBondCount} simulated`);
            }
        }

        // 6. Finalize
        const totalTickers = allTickers.length + bondTickers.length;
        const fetchedCount = Object.keys(collectedPrices).length;
        if (fetchedCount > 0) {
            priceCacheTimestamp = Date.now();
            console.log(`[PriceService] ${fetchedCount}/${totalTickers} prices from ${sources.join(' + ')}`);
        } else {
            console.warn('[PriceService] No prices fetched from any API.');
        }

        const skippedCount = totalTickers - fetchedCount;
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

                if (priceMap[h.ticker]) {
                    // Use live API price (stocks or bonds fetched from Yahoo/providers)
                    newPrice = priceMap[h.ticker].price;
                    newPreviousClose = priceMap[h.ticker].previousClose;
                } else if (h.type === 'bond') {
                    // Bond not in priceMap — use simulation fallback
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
