// ========== FX SERVICE - Live Exchange Rate Singleton ==========
// Fetches and caches USD/ILS exchange rate for multi-currency portfolio valuation.
// Architecture: memory cache → localStorage cache → Twelve Data → FMP → hardcoded fallback.
// All portfolio totals are converted to USD (display currency) using these rates.

let _fxRates = { USDILS: null, ILSUSD: null };
let _fxTimestamp = 0;
const FX_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — FX rates are slow-moving intraday
const FX_HARDCODED_USDILS = 3.7;     // Approximate fallback if all APIs fail — MUST match window.USD_ILS_RATE's fallback (init.js) so every ILS conversion agrees pre-live-rate

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
        const _fmpFxOk = !rate && typeof FMP_API_KEY !== 'undefined' && FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY'
            && !(typeof isFmpRateLimited === 'function' && isFmpRateLimited());
        if (_fmpFxOk) {
            try {
                const res = await fetchWithTimeout(
                    `https://financialmodelingprep.com/stable/fx/USDILS?apikey=${FMP_API_KEY}`
                );
                if (res.status === 429) { if (typeof setFmpRateLimited === 'function') setFmpRateLimited(); }
                else if (res.ok) {
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

// ========== PER-CLIENT FX CONVERSION BASIS ==========
// When the user deposits USD that came from converting SHEKELS, we record the
// actual conversion rate. The FX-adjusted return then measures against the REAL
// average ILS price the dollars were bought at — not a hardcoded reference.
// Stored per client in localStorage: { ils: total ₪ paid, usd: total $ acquired }.

const _FX_BASIS_PREFIX = 'fx_basis_v1_';

function getClientFxBasis(clientId) {
    try {
        const raw = localStorage.getItem(_FX_BASIS_PREFIX + clientId);
        if (!raw) return null;
        const b = JSON.parse(raw);
        return (b && b.usd > 0 && b.ils > 0) ? b : null;
    } catch (e) { return null; }
}

// Record a conversion: `usdAmount` dollars acquired at `rate` ₪ per $.
function addClientFxBasis(clientId, usdAmount, rate) {
    if (!(usdAmount > 0) || !(rate > 0)) return;
    const cur = getClientFxBasis(clientId) || { ils: 0, usd: 0 };
    cur.usd += usdAmount;
    cur.ils += usdAmount * rate;
    try { localStorage.setItem(_FX_BASIS_PREFIX + clientId, JSON.stringify(cur)); } catch (e) { /* full */ }
}

// The client's effective ILS→USD acquisition rate (weighted average), or null.
function getClientFxRefRate(clientId) {
    const b = getClientFxBasis(clientId);
    return b ? (b.ils / b.usd) : null;
}

// ── Per-portfolio average USD purchase rate (שער דולר ממוצע בתיק) ──
// The rate the portfolio's dollars were effectively bought at — the basis for the FX-adjusted
// return. ONLY a REAL recorded basis qualifies: the weighted average of actual ILS→USD conversions
// captured on broker import or on a USD deposit entered with its rate (see addClientFxBasis).
// If no conversion history exists we return { rate: null, real: false } and DO NOT fabricate a
// rate — callers then apply no FX adjustment / hide the FX P&L, so every figure shown is real.
// ── USD/ILS daily history — gives a REAL reference rate per portfolio even with no recorded
// conversion: the value-weighted USD/ILS at each USD holding's buy date. Fetched once (same-origin
// Yahoo proxy, "ILS=X" = USD/ILS), cached 24h. Lets the FX-adjusted return + ₪ FX P&L work for
// EVERY portfolio without ever fabricating a rate. ──
let _usdIlsHist = null; // [{ d:'YYYY-MM-DD', c:rate }] chronological
async function ensureUsdIlsHistory() {
    if (_usdIlsHist) return _usdIlsHist;
    try {
        const c = JSON.parse(localStorage.getItem('fx_usdils_hist_v1') || 'null');
        if (c && c.ts && (Date.now() - c.ts < 86400000) && Array.isArray(c.data) && c.data.length) { _usdIlsHist = c.data; return _usdIlsHist; }
    } catch (e) { }
    try {
        const r = await fetch('/api/history?symbol=' + encodeURIComponent('ILS=X') + '&range=10y');
        const j = await r.json();
        const pts = (j && Array.isArray(j.points)) ? j.points : [];
        _usdIlsHist = pts.filter(p => p && p.close > 0).map(p => ({ d: p.date, c: p.close }));
        if (_usdIlsHist.length) localStorage.setItem('fx_usdils_hist_v1', JSON.stringify({ ts: Date.now(), data: _usdIlsHist }));
    } catch (e) { _usdIlsHist = _usdIlsHist || []; }
    return _usdIlsHist;
}
function getUsdIlsAtDate(dateISO) {
    if (!dateISO || !_usdIlsHist || !_usdIlsHist.length) return null;
    let best = null;
    for (const p of _usdIlsHist) { if (p.d <= dateISO) best = p; else break; }
    if (!best) best = _usdIlsHist[0];
    return best ? best.c : null;
}
function _fxResolveClient(arg) {
    if (arg && typeof arg === 'object') return arg;
    const list = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients
        : (typeof window !== 'undefined' && Array.isArray(window.clients) ? window.clients : []);
    return list.find(c => c && c.id === arg) || null;
}
// Real reference USD/ILS rate for a portfolio: recorded conversions first, else value-weighted
// historical USD/ILS at each USD holding's buy date (or the portfolio open date). Never fabricated.
function getPortfolioUsdRef(arg) {
    const client = _fxResolveClient(arg);
    const recorded = client ? getClientFxRefRate(client.id) : null;
    if (recorded && recorded > 0) return { rate: recorded, real: true, src: 'conversions' };
    if (client && Array.isArray(client.holdings) && _usdIlsHist && _usdIlsHist.length) {
        let w = 0, rw = 0;
        for (const h of client.holdings) {
            if ((h.currency || 'USD').toUpperCase() !== 'USD') continue;
            const v = h.value || 0; if (!(v > 0)) continue;
            const d = h.buyDate || client.openDate || client.createdAt || null;
            const r = d ? getUsdIlsAtDate(d) : null;
            if (r > 0) { w += v; rw += v * r; }
        }
        if (w > 0) return { rate: rw / w, real: true, src: 'history' };
    }
    return { rate: null, real: false };
}
// Currency (FX) profit/loss in ₪ on the portfolio's USD exposure: Σ value$ × (rate_now − rate_at_buy).
// Positive = the dollar strengthened vs ₪ since purchase (gain for an ILS investor holding USD).
function calcFxPnlIls(arg) {
    const client = _fxResolveClient(arg);
    if (!client || !Array.isArray(client.holdings)) return null;
    const rNow = (typeof _fxRates !== 'undefined' && _fxRates.USDILS > 0) ? _fxRates.USDILS : FX_HARDCODED_USDILS;
    const recorded = client ? getClientFxRefRate(client.id) : null;
    let ils = 0, usdValue = 0, refW = 0, refSum = 0, any = false;
    for (const h of client.holdings) {
        if ((h.currency || 'USD').toUpperCase() !== 'USD') continue;
        const v = h.value || 0; if (!(v > 0)) continue;
        const d = h.buyDate || client.openDate || client.createdAt || null;
        // Recorded conversions (when present) take priority — same basis as getPortfolioUsdRef.
        const rBuy = (recorded && recorded > 0) ? recorded : (d ? getUsdIlsAtDate(d) : null);
        if (rBuy > 0) { ils += v * (rNow - rBuy); usdValue += v; refW += v; refSum += v * rBuy; any = true; }
    }
    return any ? { ils, usdValue, rateNow: rNow, avgBuyRate: refW > 0 ? refSum / refW : null } : null;
}

// Returns { rate, real, src }. Accepts a client object OR a client id (back-compat).
function getPortfolioAvgUsdRate(arg) {
    return getPortfolioUsdRef(arg);
}

if (typeof window !== 'undefined') {
    window.getPortfolioAvgUsdRate = getPortfolioAvgUsdRate;
    window.getPortfolioUsdRef = getPortfolioUsdRef;
    window.calcFxPnlIls = calcFxPnlIls;
    window.ensureUsdIlsHistory = ensureUsdIlsHistory;
    window.getUsdIlsAtDate = getUsdIlsAtDate;
}

// ========== FX RATE ACCESSORS ==========

// Get the conversion rate between two currencies.
// Returns 1 if same currency. Uses live rate or hardcoded fallback.
function getFxRate(fromCurrency, toCurrency) {
    // Normalize ILA (Israeli Agorot) → ILS before any lookup
    if (fromCurrency === 'ILA') fromCurrency = 'ILS';
    if (toCurrency === 'ILA') toCurrency = 'ILS';

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
