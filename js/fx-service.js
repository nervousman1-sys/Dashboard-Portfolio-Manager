// ========== FX SERVICE - Live Exchange Rate Singleton ==========
// Fetches and caches USD/ILS exchange rate for multi-currency portfolio valuation.
// Architecture: memory cache → localStorage cache → Twelve Data → FMP → hardcoded fallback.
// All portfolio totals are converted to USD (display currency) using these rates.

let _fxRates = { USDILS: null, ILSUSD: null };
let _fxTimestamp = 0;
const FX_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — FX rates are slow-moving intraday
const FX_HARDCODED_USDILS = 3.6;     // Approximate fallback if all APIs fail

// ========== FETCH FX RATES ==========
// Called on app init and manual refresh. Non-blocking — always returns (has fallback).
// Cascade: memory → localStorage → Twelve Data → FMP → hardcoded.

async function fetchFxRates() {
    try {
        // 1. Memory cache — instant
        if (_fxRates.USDILS && (Date.now() - _fxTimestamp < FX_CACHE_TTL)) {
            return _fxRates;
        }

        // 2. localStorage cache
        try {
            const cached = localStorage.getItem('fx_usdils');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed.rate > 0 && Date.now() - parsed.ts < FX_CACHE_TTL) {
                    _fxRates = { USDILS: parsed.rate, ILSUSD: 1 / parsed.rate };
                    _fxTimestamp = parsed.ts;
                    console.log(`[FX] Loaded from cache: 1 USD = ${parsed.rate.toFixed(4)} ILS`);
                    return _fxRates;
                }
            }
        } catch (e) { /* ignore corrupt cache */ }

        // 3. Live API fetch with 5s timeout — NEVER block the app
        let rate = null;

        const fetchWithTimeout = (url, ms = 5000) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), ms);
            return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
        };

        // Primary: Twelve Data forex exchange rate
        if (!rate && typeof TWELVE_DATA_API_KEY !== 'undefined' && TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
            try {
                const res = await fetchWithTimeout(
                    `https://api.twelvedata.com/exchange_rate?symbol=USD/ILS&apikey=${TWELVE_DATA_API_KEY}`
                );
                if (res.ok) {
                    const json = await res.json();
                    if (json.rate && parseFloat(json.rate) > 0) {
                        rate = parseFloat(json.rate);
                        console.log(`[FX] Twelve Data: 1 USD = ${rate.toFixed(4)} ILS`);
                    }
                } else if (res.status === 429) {
                    console.warn('[FX] Twelve Data rate-limited (429)');
                }
            } catch (e) {
                console.warn('[FX] Twelve Data fetch failed:', e.message);
            }
        }

        // Fallback: FMP forex endpoint
        if (!rate && typeof FMP_API_KEY !== 'undefined' && FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
            try {
                const res = await fetchWithTimeout(
                    `https://financialmodelingprep.com/stable/fx/USDILS?apikey=${FMP_API_KEY}`
                );
                if (res.ok) {
                    const json = await res.json();
                    // FMP returns array: [{ ticker: "USD/ILS", bid, ask, open, low, high, ... }]
                    const entry = Array.isArray(json) ? json[0] : json;
                    const bid = parseFloat(entry?.bid || entry?.price || 0);
                    if (bid > 0) {
                        rate = bid;
                        console.log(`[FX] FMP: 1 USD = ${rate.toFixed(4)} ILS`);
                    }
                }
            } catch (e) {
                console.warn('[FX] FMP fetch failed:', e.message);
            }
        }

        // Hardcoded fallback
        if (!rate) {
            rate = FX_HARDCODED_USDILS;
            console.warn(`[FX] All APIs failed — using hardcoded fallback: 1 USD = ${rate} ILS`);
        }

        // Store
        _fxRates = { USDILS: rate, ILSUSD: 1 / rate };
        _fxTimestamp = Date.now();

        try {
            localStorage.setItem('fx_usdils', JSON.stringify({ rate, ts: _fxTimestamp }));
        } catch (e) { /* localStorage full */ }

        return _fxRates;
    } catch (e) {
        // ABSOLUTE SAFETY NET — if anything goes wrong, use hardcoded rate.
        // This function must NEVER throw or block the app.
        console.error('[FX] Unexpected error in fetchFxRates — using hardcoded fallback:', e.message);
        _fxRates = { USDILS: FX_HARDCODED_USDILS, ILSUSD: 1 / FX_HARDCODED_USDILS };
        _fxTimestamp = Date.now();
        return _fxRates;
    }
}

// ========== FX RATE ACCESSORS ==========

// Get the conversion rate between two currencies.
// Returns 1 if same currency. Uses live rate or hardcoded fallback.
function getFxRate(fromCurrency, toCurrency) {
    if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return 1;
    if (fromCurrency === 'USD' && toCurrency === 'ILS') return _fxRates.USDILS || FX_HARDCODED_USDILS;
    if (fromCurrency === 'ILS' && toCurrency === 'USD') return _fxRates.ILSUSD || (1 / FX_HARDCODED_USDILS);
    return 1; // Unknown pair — no conversion
}

// Convert a monetary value from one currency to another.
function convertToDisplayCurrency(value, fromCurrency, displayCurrency = 'USD') {
    if (!value || value === 0) return 0;
    return value * getFxRate(fromCurrency, displayCurrency);
}

// Get a holding's value converted to the display currency.
// Formula: Price × Quantity × FX_Rate = Value_In_Display_Currency
function getHoldingValueInDisplayCurrency(holding, displayCurrency = 'USD') {
    const nativeValue = (holding.shares || 0) * (holding.price || 0);
    const holdingCurrency = holding.currency || 'USD';
    return nativeValue * getFxRate(holdingCurrency, displayCurrency);
}
