// ========== MACRO - Economic Indicators (US + Israel) ==========
//
// DATA FLOW (layered reliability):
//   1. VERIFIED BASELINE — hardcoded actuals from BLS/FRED/CBS/BOI (always available)
//   2. SUPABASE          — persisted macro_data table (survives cache clears)
//   3. LOCALSTORAGE      — 6-hour TTL browser cache
//   4. LIVE API OVERLAY  — FMP (primary) / FRED (fallback) / BOI SDMX
//
// Baseline guarantees widgets never show "נתון לא זמין" for tracked indicators.
// Live API data overlays on top when available (newer date wins).

// ── VERIFIED MACRO BASELINE ──
// Source: BLS, FRED, CBS Israel, Bank of Israel — April 2026 Decision Core sweep
// These serve as the authoritative floor. Live API data overlays on top when available.
const MACRO_VERIFIED_BASELINE = {
    us: {
        cpi:          { value: 4.2,   previous: 3.8,   forecast: 4.0,  label: 'אינפלציה שנתית (CPI YoY)',    unit: '%', date: '2026-06-10', refLabel: 'May 2026' },
        core_cpi:     { value: 2.9,   previous: 2.8,   forecast: 2.9,  label: 'אינפלציה ליבה (Core CPI)',     unit: '%', date: '2026-06-10', refLabel: 'May 2026' },
        ppi:          { value: 1.4,   previous: 0.9,   forecast: 0.5,  label: 'מדד מחירי יצרן (PPI MoM)',     unit: '%', date: '2026-05-15', refLabel: 'Apr 2026' },
        core_ppi:     { value: 0.5,   previous: 0.8,   forecast: 0.3,  label: 'מדד יצרן ליבה (Core PPI)',     unit: '%', date: '2026-05-15', refLabel: 'Apr 2026' },
        fed_rate:     { value: 3.625, previous: 3.625, forecast: 3.625, label: 'ריבית הפד (Fed Rate)',         unit: '%', date: '2026-04-29', refLabel: '3.50%-3.75%' },
        unemployment: { value: 4.3,   previous: 4.3,   forecast: 4.3,  label: 'שיעור אבטלה (Unemployment)',    unit: '%', date: '2026-06-06', refLabel: 'May 2026' },
        nfp:          { value: 172,   previous: 126,   forecast: 150,  label: 'משרות חדשות (NFP)',             unit: 'K', date: '2026-06-06', refLabel: 'May 2026' },
        gdp:          { value: 1.6,   previous: 0.7,   forecast: 1.4,  label: 'צמיחת תמ״ג (GDP QoQ)',         unit: '%', date: '2026-04-30', refLabel: 'Q1 2026' },
        real_rate:    { value: 2.21,  previous: 2.05,  forecast: null, label: 'ריבית ריאלית (Real Rate)',      unit: '%', date: '2026-06-08', refLabel: 'Jun 2026' },
    },
    il: {
        il_cpi:          { value: 1.9,    previous: 1.9,   forecast: 1.8,  label: 'אינפלציה שנתית (CPI YoY)',  unit: '%',   date: '2026-05-15', refLabel: 'Apr 2026' },
        il_core_cpi:     { value: 2.1,    previous: 2.0,   forecast: 2.1,  label: 'אינפלציה ליבה (Core CPI)',   unit: '%',   date: '2026-05-15', refLabel: 'Apr 2026' },
        boi_rate:        { value: 3.75,   previous: 4.0,   forecast: 3.75, label: 'ריבית בנק ישראל (BOI Rate)', unit: '%',   date: '2026-05-25', refLabel: '25 May 2026' },
        il_unemployment: { value: 3.2,    previous: 3.1,   forecast: 3.3,  label: 'שיעור אבטלה (Unemployment)', unit: '%',   date: '2026-04-30', refLabel: 'Mar 2026' },
        il_ppi:          { value: 118.0,  previous: 117.7, forecast: 118.2, label: 'מדד מחירי יצרן (PPI)',     unit: 'idx', date: '2026-02-20', refLabel: 'Feb 2026' },
        il_gdp:          { value: 4.0,    previous: 12.7,  forecast: 3.8,  label: 'צמיחת תמ״ג (GDP QoQ)',      unit: '%',   date: '2026-02-16', refLabel: 'Q4 2025' },
        il_real_rate:    { value: 2.0,    previous: 2.45,  forecast: null, label: 'ריבית ריאלית (Real Rate)',   unit: '%',   date: '2026-03-15', refLabel: 'Feb 2026' },
        il_trade_bal:    { value: -4.4,   previous: -3.14, forecast: -3.5, label: 'מאזן סחר (Trade Balance)',   unit: 'B$',  date: '2026-03-20', refLabel: 'Feb 2026' },
        il_consumer_conf:{ value: -17,    previous: -16,   forecast: -15,  label: 'אמון צרכנים (CCI)',          unit: '%',   date: '2026-03-18', refLabel: 'Feb 2026' },
    },
    _meta: { updatedAt: '2026-04-01', source: 'BLS/FRED/CBS/BOI — Finextium Decision Core' }
};

// ── Market Sentiment Color Logic (Equity Impact) ──
// Determines whether Actual vs Previous is bullish or bearish for risk assets.
//   Inflation (CPI/PPI): lower = bullish (green), higher = bearish (red)
//   Growth/Labor (GDP/NFP): higher = bullish (green), lower = bearish (red)
//   Unemployment: lower = bullish (green), higher = bearish (red)
//   Rates: lower = bullish (green), higher = bearish (red)
const _INVERSE_INDICATORS = new Set([
    'cpi', 'core_cpi', 'ppi', 'core_ppi',
    'il_cpi', 'il_core_cpi', 'il_ppi',
    'unemployment', 'il_unemployment',
    'fed_rate', 'boi_rate', 'real_rate', 'il_real_rate',
    'il_trade_bal', 'il_consumer_conf',
]);

function _sentimentColor(key, actual, previous) {
    if (actual === null || actual === undefined || previous === null || previous === undefined) return '';
    if (actual === previous) return '';
    const isInverse = _INVERSE_INDICATORS.has(key);
    // For inverse indicators: actual < previous = good (green)
    // For normal indicators: actual > previous = good (green)
    const isBullish = isInverse ? (actual < previous) : (actual > previous);
    return isBullish ? 'macro-hw-bullish' : 'macro-hw-bearish';
}

// ── Cache Keys & TTLs ──
const _MACRO_CACHE = {
    US_HEAD: 'macro_us_headline_v5',
    IL_HEAD: 'macro_il_headline_v5',
    US_CAL:  'macro_us_calendar_v4',
    IL_CAL:  'macro_il_calendar_v4',
    LAST_TS: 'macro_lastSeenTimestamp'
};
const _MACRO_TTL_IND = 2 * 60 * 60 * 1000; // 2 hours — keep macro fresh (FRED via proxy/CORS is cheap)

let _macroApiStatus = { fred: null, fmpUS: null, fmpIL: null, boiIL: null };

// ========== UTILITIES ==========

function _macroEscape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function _macroFetch(url, ms = 12000, retries = 2) {
    // Block if FMP is rate-limited and this is an FMP URL
    if (url.includes('financialmodelingprep.com') && typeof isFmpRateLimited === 'function' && isFmpRateLimited()) {
        console.log('[Macro] FMP rate-limited — skipping:', url.split('?')[0]);
        return new Response(JSON.stringify([]), { status: 429, statusText: 'Rate Limited (local guard)' });
    }

    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, { signal: c.signal });
            clearTimeout(t);

            // On 429: set global rate-limit flag and return immediately (no retries)
            if (response.status === 429) {
                if (url.includes('financialmodelingprep.com') && typeof setFmpRateLimited === 'function') {
                    setFmpRateLimited();
                }
                return response;
            }

            return response;
        } catch (error) {
            if (attempt === retries) {
                clearTimeout(t);
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        }
    }
}

function _cacheGet(key, ttl) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (Date.now() - obj.ts > ttl) return null;
        // Block simulated/synthetic data from being served
        if (Array.isArray(obj.d) && obj.d[0]?.source === 'Simulated') {
            localStorage.removeItem(key);
            return null;
        }
        return obj.d;
    } catch { return null; }
}

function _cacheSet(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ d: data, ts: Date.now() })); } catch {}
}

function _cacheTime(key) {
    try {
        return new Date(JSON.parse(localStorage.getItem(key)).ts)
            .toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    } catch { return null; }
}

function _fmtPct(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    return n.toFixed(2) + '%';
}

function _fmtNum(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (Math.abs(n) >= 1e12) return '$' + (n / 1e12).toFixed(1) + 'T';
    if (Math.abs(n) >= 1e9)  return '$' + (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
    return n.toFixed(2);
}

// ========== CATEGORY MATCHING ==========

function _matchCategory(eventName) {
    if (!eventName) return 'כלכלה';
    const sortedKeys = Object.keys(MACRO_CATEGORY_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        if (eventName.includes(key)) return MACRO_CATEGORY_MAP[key];
    }
    const l = eventName.toLowerCase();
    if (l.includes('cpi') || l.includes('inflation') || l.includes('pce') || l.includes('ppi')) return 'אינפלציה';
    if (l.includes('gdp') || l.includes('growth')) return 'צמיחה';
    if (l.includes('payroll') || l.includes('employment') || l.includes('jobless') || l.includes('unemployment')) return 'תעסוקה';
    if (l.includes('interest rate') || l.includes('fed') || l.includes('fomc')) return 'מדיניות מוניטרית';
    if (l.includes('pmi') || l.includes('manufacturing') || l.includes('industrial')) return 'ייצור';
    if (l.includes('retail') || l.includes('spending')) return 'צריכה';
    if (l.includes('housing') || l.includes('building')) return 'נדל"ן';
    if (l.includes('confidence') || l.includes('sentiment')) return 'סנטימנט';
    if (l.includes('trade balance') || l.includes('export') || l.includes('import')) return 'סחר';
    return 'כלכלה';
}

// ========== 1. FRED API — US Indicators ==========
// Free API from the St. Louis Federal Reserve.
// Register at: https://fred.stlouisfed.org/docs/api/api_key.html
// Set FRED_API_KEY in js/env-config.js
// units=pc1  → percent change from year ago (CPI, Core CPI)
// units=lin  → level values (Fed Rate, GDP growth %, Unemployment)

const _FRED_SERIES = [
    { key: 'cpi',          id: 'CPIAUCSL',       units: 'pc1', label: 'מדד המחירים לצרכן (CPI)',   unit: '%' },
    { key: 'core_cpi',     id: 'CPILFESL',        units: 'pc1', label: 'אינפלציית ליבה (Core CPI)', unit: '%' },
    { key: 'ppi',          id: 'PPIFIS',          units: 'pch', label: 'מדד מחירי יצרן (PPI MoM)',  unit: '%' },
    { key: 'core_ppi',     id: 'PPIFES',          units: 'pch', label: 'מדד יצרן ליבה (Core PPI)',  unit: '%' },
    { key: 'fed_rate',     id: 'FEDFUNDS',        units: 'lin', label: 'ריבית הפד',                 unit: '%' },
    { key: 'unemployment', id: 'UNRATE',          units: 'lin', label: 'שיעור אבטלה',               unit: '%' },
    { key: 'nfp',          id: 'PAYEMS',          units: 'chg', label: 'משרות חדשות (NFP)',          unit: 'K' },
    { key: 'gdp',          id: 'A191RL1Q225SBEA', units: 'lin', label: 'צמיחת תוצר (GDP)',          unit: '%' },
    { key: 'real_rate',    id: 'DFII10',          units: 'lin', label: 'ריבית ריאלית (Real Rate)',   unit: '%' },
];

// Public CORS proxies — let the browser read FRED directly when the same-origin
// /api/fred serverless function isn't available (local dev, or before deploy).
const _FRED_CORS_WRAPPERS = [
    // corsproxy.io is browser-oriented (validates Origin) and most reliable from a
    // real browser; allorigins is the secondary fallback.
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];

// Path 1: same-origin serverless proxy (one batched round-trip). Vercel only.
async function _fredFetchViaProxy() {
    try {
        const batch = _FRED_SERIES.map(s => `${s.id}:${s.units}`).join(',');
        const res = await _macroFetch(`/api/fred?batch=${encodeURIComponent(batch)}&limit=2`, 9000, 0);
        if (!res || !res.ok) return null;
        const data = await res.json();
        // Must look like a keyed FRED object, not the SPA index.html fallback
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const hasAny = _FRED_SERIES.some(s => data[s.id] && data[s.id].value != null);
        return hasAny ? data : null;
    } catch { return null; }
}

// Path 2: direct FRED through a public CORS proxy (per series, parallel).
async function _fredFetchViaCors() {
    const key = (typeof FRED_API_KEY !== 'undefined') ? FRED_API_KEY : '';
    if (!key) return null;
    const out = {};
    await Promise.all(_FRED_SERIES.map(async (s) => {
        const fredUrl = `https://api.stlouisfed.org/fred/series/observations` +
            `?series_id=${s.id}&api_key=${key}&file_type=json&sort_order=desc&limit=2&units=${s.units}`;
        for (const wrap of _FRED_CORS_WRAPPERS) {
            try {
                const res = await fetch(wrap(fredUrl));
                if (!res.ok) continue;
                const data = await res.json();
                const obs = (data?.observations || []).filter(o => o.value !== '.' && o.value !== '');
                if (obs.length) {
                    out[s.id] = {
                        value: parseFloat(obs[0].value),
                        previous: obs[1] ? parseFloat(obs[1].value) : null,
                        date: obs[0].date,
                        prevDate: obs[1] ? obs[1].date : null,
                    };
                    return; // got this series — stop trying proxies
                }
            } catch { /* try next proxy */ }
        }
    }));
    return Object.keys(out).length ? out : null;
}

// PRIMARY macro source: the same-origin /api/macro aggregator (FRED for US + Israeli
// rates/unemployment/yields, CBS for Israeli CPI) — all server-side, so no flaky
// public CORS proxies. Returns { us, il } or null. Cached in memory for the TTL.
let _macroApiCache = null;
async function _fetchMacroAPI(forceRefresh) {
    if (!forceRefresh && _macroApiCache && (Date.now() - _macroApiCache.ts) < _MACRO_TTL_IND) {
        return _macroApiCache.data;
    }
    try {
        const day = new Date().toISOString().slice(0, 10);
        const res = await _macroFetch(`/api/macro?d=${day}`, 12000, 1);
        if (!res || !res.ok) return _macroApiCache ? _macroApiCache.data : null;
        const data = await res.json();
        if (!data || typeof data !== 'object' || (!data.us && !data.il)) {
            return _macroApiCache ? _macroApiCache.data : null;
        }
        _macroApiCache = { ts: Date.now(), data };
        return data;
    } catch { return _macroApiCache ? _macroApiCache.data : null; }
}

// Fetches all US indicators live from FRED — serverless proxy first, public CORS
// proxy as fallback so data is current EVERYWHERE (local + production), not the
// stale hardcoded baseline. Returns null (→ caller tries FMP) if both paths fail.
async function _fetchFREDIndicators(forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) {
            console.log('[FRED] Using cached data');
            _macroApiStatus.fred = true;
            return cached;
        }
    }

    let data = await _fredFetchViaProxy();
    let via = 'proxy';
    if (!data) { data = await _fredFetchViaCors(); via = 'cors'; }
    if (!data) {
        _macroApiStatus.fred = 'unreachable';
        console.warn('[FRED] both proxy and CORS fallback failed');
        return null;
    }

    const results = {};
    for (const s of _FRED_SERIES) {
        const entry = data[s.id];
        if (!entry || entry.value === null || entry.value === undefined || isNaN(entry.value)) continue;
        const val = parseFloat(entry.value);
        const prevVal = (entry.previous !== null && entry.previous !== undefined) ? parseFloat(entry.previous) : null;
        const trend = (prevVal !== null && !isNaN(prevVal))
            ? (val > prevVal ? 'up' : val < prevVal ? 'down' : 'flat')
            : 'flat';
        results[s.key] = {
            value: val, previous: prevVal, trend,
            date: entry.date, prevDate: entry.prevDate || null,
            label: s.label, unit: s.unit
        };
    }

    const count = Object.keys(results).length;
    _macroApiStatus.fred = count > 0 ? true : 'No data';
    console.log(`[Macro] FRED US (${via}): ${count}/${_FRED_SERIES.length} indicators`);
    if (count > 0) { _cacheSet(_MACRO_CACHE.US_HEAD, results); return results; }
    return null;
}

// ========== 2. FMP US Indicators (primary — no CORS issues) ==========
// API: https://financialmodelingprep.com/api/v4/economic?name=<indicator>&apikey=<key>
// Set FMP_API_KEY in js/env-config.js

const _US_INDICATORS = [
    { key: 'cpi',          fmpName: 'CPI',                       label: 'מדד המחירים לצרכן (CPI)',  unit: '%' },
    { key: 'core_cpi',     fmpName: 'Core CPI',                  label: 'אינפלציית ליבה (Core CPI)', unit: '%' },
    { key: 'fed_rate',     fmpName: 'Fed Interest Rate Decision', label: 'ריבית הפד',                unit: '%' },
    { key: 'gdp',          fmpName: 'GDP Growth Rate',            label: 'צמיחת תוצר (GDP)',         unit: '%' },
    { key: 'unemployment', fmpName: 'Unemployment Rate',          label: 'שיעור אבטלה',              unit: '%' },
];

// Session flag: set to true when FMP economic_calendar returns 403 (free-tier restriction).
// Prevents repeated 403 requests in the same session.
let _fmpCalendarBlocked = false;

async function _fetchFMPUSIndicators(forceRefresh) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') {
        _macroApiStatus.fmpUS = 'No key';
        return null;
    }

    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fmpUS = true; return cached; }
    }

    // Skip if FMP is globally rate-limited
    if (typeof isFmpRateLimited === 'function' && isFmpRateLimited()) {
        _macroApiStatus.fmpUS = '429 cooldown';
        return null;
    }

    const results = {};
    await Promise.all(_US_INDICATORS.map(async (ind) => {
        try {
            const res = await _macroFetch(
                `https://financialmodelingprep.com/api/v4/economic` +
                `?name=${encodeURIComponent(ind.fmpName)}&apikey=${FMP_API_KEY}`
            );
            if (!res.ok) return;
            const data = await res.json();
            if (!Array.isArray(data) || data.length === 0) return;

            const latest  = data[0];
            const prev    = data.length > 1 ? data[1] : null;
            const val     = parseFloat(latest.value);
            const prevVal = prev ? parseFloat(prev.value) : null;
            if (isNaN(val)) return;

            const trend = (prevVal !== null && !isNaN(prevVal))
                ? (val > prevVal ? 'up' : val < prevVal ? 'down' : 'flat')
                : 'flat';

            results[ind.key] = {
                value: val, previous: prevVal, trend,
                date: latest.date, prevDate: prev?.date || null,
                label: ind.label, unit: ind.unit
            };
        } catch (e) { console.warn(`[FMP] US ${ind.key}:`, e.message); }
    }));

    const count = Object.keys(results).length;
    _macroApiStatus.fmpUS = count > 0 ? true : 'No data';
    if (count > 0) _cacheSet(_MACRO_CACHE.US_HEAD, results);
    return count > 0 ? results : null;
}

// Master US headline loader — Verified Baseline + Live API overlay
async function _fetchUSHeadlines(forceRefresh) {
    // Layer 1: Verified baseline (always available)
    const baseline = {};
    for (const [key, val] of Object.entries(MACRO_VERIFIED_BASELINE.us)) {
        if (val.value !== null) baseline[key] = { ...val };
    }

    // Layer 2: Try live API overlay (FRED proxy → FMP fallback).
    // FRED via the serverless proxy is the reliable primary; FMP's v4 /economic
    // endpoint is restricted on the free tier and frequently fails, so it's the
    // fallback only.
    let liveData = null;
    // Primary: the /api/macro aggregator (most reliable, current)
    try {
        const agg = await _fetchMacroAPI(forceRefresh);
        if (agg && agg.us && Object.keys(agg.us).length) {
            liveData = agg.us;
            console.log('[Macro] ✓ US live overlay via /api/macro');
        }
    } catch (e) { console.warn('[Macro] /api/macro US failed:', e.message); }
    // Fallbacks: direct FRED proxy/CORS, then FMP
    if (!liveData) {
        try {
            liveData = await _fetchFREDIndicators(forceRefresh);
            if (liveData) console.log('[Macro] ✓ US live overlay via FRED (proxy)');
        } catch (e) { console.warn('[Macro] FRED overlay failed:', e.message); }
    }
    if (!liveData) {
        try {
            liveData = await _fetchFMPUSIndicators(forceRefresh);
            if (liveData) console.log('[Macro] ✓ US live overlay via FMP');
        } catch (e) { console.warn('[Macro] FMP overlay failed:', e.message); }
    }

    // Merge: live data ALWAYS overrides the hardcoded baseline where present.
    // (Do NOT gate on a date comparison: FRED's observation date is the reference
    // PERIOD, e.g. Feb 2026, while the baseline date is the PUBLISH date, e.g. Mar
    // 2026 — comparing them wrongly rejected fresh live data and showed stale values.)
    const merged = { ...baseline };
    if (liveData) {
        for (const [key, val] of Object.entries(liveData)) {
            if (val && val.value !== null && val.value !== undefined && !isNaN(val.value)) {
                merged[key] = val;
            }
        }
    }

    _macroApiStatus.fmpUS = liveData ? true : 'בסיס מאומת';
    console.log(`[Macro] US merged: ${Object.keys(merged).length} indicators (baseline + ${liveData ? 'live' : 'none'})`);
    _cacheSet(_MACRO_CACHE.US_HEAD, merged);
    _supaSaveMacroData('us', merged);
    return merged;
}

// ========== 3. ISRAEL HEADLINE INDICATORS ==========
// BOI Rate: Bank of Israel SDMX API (public, no key required)
//   Endpoint: https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STAT/ERI_RES_130/1.0
//   If CORS blocks the direct call, falls back to allorigins proxy.
// IL CPI & GDP: FMP Economic Calendar filtered for country='IL'
//   Fallback endpoint (requires subscription): https://api.tradingeconomics.com — replace placeholder below.

async function _fetchILHeadlines(forceRefresh) {
    // Layer 1: Verified baseline (always available)
    const baseline = {};
    for (const [key, val] of Object.entries(MACRO_VERIFIED_BASELINE.il)) {
        if (val.value !== null) baseline[key] = { ...val };
    }

    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.IL_HEAD, _MACRO_TTL_IND);
        if (cached) {
            console.log('[IL] Using cached data (merged with baseline)');
            const merged = { ...baseline, ...cached };
            _macroApiStatus.fmpIL = true;
            _macroApiStatus.boiIL = true;
            return merged;
        }
    }

    console.log('[IL] Fetching Israel economic indicators...');
    const results = {};

    // ── BOI Interest Rate (Bank of Israel SDMX API — public, no key) ──
    try {
        const now        = new Date();
        const startMonth = new Date(now);
        startMonth.setMonth(startMonth.getMonth() - 12);
        const startStr = `${startMonth.getFullYear()}-${String(startMonth.getMonth() + 1).padStart(2, '0')}`;
        const boiUrl   = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STAT/ERI_RES_130/1.0?startperiod=${startStr}&format=csv`;

        console.log('[BOI] Fetching interest rate...');

        // Try direct fetch; fall back to allorigins CORS proxy if blocked
        let res;
        try {
            res = await _macroFetch(boiUrl, 8000, 1);
        } catch (directError) {
            console.log('[BOI] Direct fetch failed, trying CORS proxy...');
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(boiUrl)}`;
            res = await _macroFetch(proxyUrl, 10000, 1);
        }

        if (res && res.ok) {
            const csv    = await res.text();
            const lines  = csv.trim().split('\n').filter(l => l.trim());
            if (lines.length > 1) {
                const header  = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
                const obsIdx  = header.findIndex(h => h === 'OBS_VALUE'   || h.toLowerCase().includes('obs_value'));
                const timeIdx = header.findIndex(h => h === 'TIME_PERIOD' || h.toLowerCase().includes('time_period'));

                let latest = null, prevEntry = null;
                for (let i = lines.length - 1; i >= 1; i--) {
                    const cols   = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
                    const val    = parseFloat(cols[obsIdx  >= 0 ? obsIdx  : cols.length - 1]);
                    const period = cols[timeIdx >= 0 ? timeIdx : 0] || '';
                    if (!isNaN(val)) {
                        if (!latest)         { latest    = { value: val, date: period }; }
                        else if (!prevEntry) { prevEntry = { value: val, date: period }; break; }
                    }
                }

                if (latest) {
                    let trend = 'flat';
                    if (prevEntry && latest.value > prevEntry.value) trend = 'up';
                    else if (prevEntry && latest.value < prevEntry.value) trend = 'down';
                    results.boi_rate = {
                        value: latest.value, previous: prevEntry?.value || null, trend,
                        date: latest.date, prevDate: prevEntry?.date || null,
                        label: 'ריבית בנק ישראל', unit: '%'
                    };
                    _macroApiStatus.boiIL = true;
                    console.log(`[BOI] ✓ Interest rate: ${latest.value}% (${latest.date})`);
                } else {
                    console.warn('[BOI] No valid data found in CSV');
                    _macroApiStatus.boiIL = 'No data';
                }
            }
        } else {
            console.warn(`[BOI] HTTP ${res ? res.status : 'failed'}`);
            _macroApiStatus.boiIL = res ? `HTTP ${res.status}` : 'Failed';
        }
    } catch (e) {
        console.warn('[BOI] Rate fetch failed (all methods):', e.message);
        _macroApiStatus.boiIL = e.message;
    }

    // ── IL CPI + GDP via FMP Economic Calendar ──
    // TODO: If FMP lacks IL data, replace this block with:
    //   https://api.tradingeconomics.com/country/indicators?c=<API_KEY>&country=israel
    //   (requires TradingEconomics subscription — set TRADING_ECONOMICS_KEY in env-config.js)
    const _fmpAvailable = FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY' && !_fmpCalendarBlocked
        && !(typeof isFmpRateLimited === 'function' && isFmpRateLimited());
    if (_fmpAvailable) {
        try {
            const now  = new Date();
            const from = new Date(now);
            from.setDate(from.getDate() - 90);
            const url = `https://financialmodelingprep.com/api/v3/economic_calendar` +
                `?from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}` +
                `&apikey=${FMP_API_KEY}`;
            const res = await _macroFetch(url);
            if (res.status === 429) {
                console.warn('[Macro] FMP economic_calendar: 429 Rate Limited');
            } else if (res.status === 403) {
                _fmpCalendarBlocked = true;
                console.warn('[Macro] FMP economic_calendar: 403 Forbidden — endpoint not available on current plan. Using verified baseline data.');
            } else if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    const ilEvents = data
                        .filter(i => i.country === 'IL' && i.actual !== null && i.actual !== '' && i.event)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));

                    const cpiEv = ilEvents.find(e =>
                        e.event.toLowerCase().includes('cpi') ||
                        e.event.toLowerCase().includes('inflation') ||
                        e.event.toLowerCase().includes('consumer price')
                    );
                    if (cpiEv) {
                        const val  = parseFloat(cpiEv.actual);
                        const prev = cpiEv.previous !== null ? parseFloat(cpiEv.previous) : null;
                        if (!isNaN(val)) {
                            results.il_cpi = {
                                value: val,
                                previous: (prev !== null && !isNaN(prev)) ? prev : null,
                                trend: (prev !== null && !isNaN(prev))
                                    ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat',
                                date: cpiEv.date,
                                label: 'מדד המחירים לצרכן', unit: '%'
                            };
                        }
                    }

                    const gdpEv = ilEvents.find(e => e.event.toLowerCase().includes('gdp'));
                    if (gdpEv) {
                        const val  = parseFloat(gdpEv.actual);
                        const prev = gdpEv.previous !== null ? parseFloat(gdpEv.previous) : null;
                        if (!isNaN(val)) {
                            results.il_gdp = {
                                value: val,
                                previous: (prev !== null && !isNaN(prev)) ? prev : null,
                                trend: (prev !== null && !isNaN(prev))
                                    ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat',
                                date: gdpEv.date,
                                label: 'צמיחת תוצר (GDP)', unit: '%'
                            };
                        }
                    }

                    // BOI rate fallback from FMP calendar (if SDMX fetch above failed)
                    if (!results.boi_rate) {
                        const rateEv = ilEvents.find(e => e.event.toLowerCase().includes('interest rate'));
                        if (rateEv) {
                            const val  = parseFloat(rateEv.actual);
                            const prev = rateEv.previous !== null ? parseFloat(rateEv.previous) : null;
                            if (!isNaN(val)) {
                                results.boi_rate = {
                                    value: val,
                                    previous: (prev !== null && !isNaN(prev)) ? prev : null,
                                    trend: (prev !== null && !isNaN(prev))
                                        ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat',
                                    date: rateEv.date,
                                    label: 'ריבית בנק ישראל', unit: '%'
                                };
                            }
                        }
                    }
                    _macroApiStatus.fmpIL = true;
                }
            }
        } catch (e) {
            console.warn('[Macro] IL FMP failed:', e.message);
            _macroApiStatus.fmpIL = e.message;
        }
    }

    // Primary overlay: the /api/macro Israel block (FRED rates/unemployment/yield +
    // CBS CPI) — most reliable & current, so it wins over BOI/FMP and the baseline.
    try {
        const agg = await _fetchMacroAPI(forceRefresh);
        if (agg && agg.il) {
            for (const [k, v] of Object.entries(agg.il)) {
                if (v && v.value != null && !isNaN(v.value)) results[k] = v;
            }
            if (Object.keys(agg.il).length) { _macroApiStatus.boiIL = true; _macroApiStatus.fmpIL = true; }
        }
    } catch (e) { /* keep BOI/FMP results */ }

    // Merge: live API results override baseline
    const merged = { ...baseline, ...results };
    const count = Object.keys(merged).length;
    console.log(`[Macro] IL merged: ${count} indicators (baseline + ${Object.keys(results).length} live)`);
    _cacheSet(_MACRO_CACHE.IL_HEAD, merged);
    _supaSaveMacroData('il', merged);
    return merged;
}

// ========== 4. FMP CALENDAR EVENTS ==========
// Fetches the last 60 days of economic calendar events for a given country code (US / IL).
// Set FMP_API_KEY in js/env-config.js

async function _fetchCalendarEvents(country, cacheKey, forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(cacheKey, _MACRO_TTL_IND);
        if (cached && cached.length > 0) return cached;
    }
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') return null;
    if (_fmpCalendarBlocked) return null;
    if (typeof isFmpRateLimited === 'function' && isFmpRateLimited()) return null;

    try {
        const now  = new Date();
        const from = new Date(now);
        from.setDate(from.getDate() - 60);
        const url = `https://financialmodelingprep.com/api/v3/economic_calendar` +
            `?from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}` +
            `&apikey=${FMP_API_KEY}`;
        const res = await _macroFetch(url);
        if (res.status === 429) {
            console.warn('[Macro] Calendar 429 — using cached/baseline data');
            return null;
        }
        if (res.status === 403) {
            _fmpCalendarBlocked = true;
            console.warn('[Macro] FMP economic_calendar: 403 Forbidden — skipping calendar endpoint for this session.');
            return null;
        }
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data)) return null;

        const items = data
            .filter(i => i.country === country && i.actual !== null && i.actual !== '' && i.event)
            .map(i => {
                const d        = new Date(i.date);
                const actual   = i.actual   != null ? String(i.actual)   : 'N/A';
                const estimate = i.estimate != null && i.estimate !== '' ? String(i.estimate) : 'N/A';
                const previous = i.previous != null && i.previous !== '' ? String(i.previous) : 'N/A';
                let sentiment  = 'neutral';
                if (actual !== 'N/A' && estimate !== 'N/A') {
                    const a = parseFloat(actual), e = parseFloat(estimate);
                    if (!isNaN(a) && !isNaN(e)) sentiment = a > e ? 'beat' : (a < e ? 'miss' : 'neutral');
                }
                return {
                    id: `fmp-${country}-${i.event}-${i.date}`,
                    title: i.event,
                    category: _matchCategory(i.event),
                    actual, estimate, previous, sentiment,
                    date: d.toLocaleDateString('he-IL'),
                    time: d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    rawDate: d.toISOString(),
                    country,
                    isRead: false
                };
            })
            .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate))
            .slice(0, 30);

        if (items.length > 0) _cacheSet(cacheKey, items);
        return items;
    } catch { return null; }
}

// ========== ALERT / READ STATE ==========

function _getLastSeenTs() { try { return localStorage.getItem(_MACRO_CACHE.LAST_TS) || null; } catch { return null; } }
function _setLastSeenTs(s) { try { localStorage.setItem(_MACRO_CACHE.LAST_TS, s); } catch {} }

function _resolveReadState(items) {
    if (!items || items.length === 0) return;
    const last   = _getLastSeenTs();
    const lastMs = last ? new Date(last).getTime() : 0;
    items.forEach(item => {
        if (readAlertIds.includes(item.id))                                   { item.isRead = true; return; }
        if (lastMs > 0 && new Date(item.rawDate).getTime() <= lastMs)         { item.isRead = true; return; }
        item.isRead = false;
    });
}

function _advanceLastSeen() {
    if (!alerts || alerts.length === 0) return;
    let newest = alerts[0].rawDate;
    for (const item of alerts) { if (item.rawDate > newest) newest = item.rawDate; }
    _setLastSeenTs(newest);
}

// ========== SUPABASE MACRO PERSISTENCE ==========
// Reads/writes verified macro data to Supabase `macro_data` table.
// Schema: id (int8, PK), country (text, UNIQUE), indicators (jsonb), updated_at (timestamptz)

async function _supaLoadMacroData() {
    if (!supabaseConnected || !supabaseClient) return null;
    try {
        const { data, error } = await supabaseClient
            .from('macro_data')
            .select('country, indicators, updated_at')
            .order('updated_at', { ascending: false });
        if (error || !data || data.length === 0) return null;
        const result = {};
        for (const row of data) {
            result[row.country] = row.indicators;
        }
        console.log('[Macro] Loaded from Supabase:', Object.keys(result));
        return result;
    } catch (e) {
        console.warn('[Macro] Supabase load failed:', e.message);
        return null;
    }
}

async function _supaSaveMacroData(country, indicators) {
    if (!supabaseConnected || !supabaseClient) return;
    try {
        const { error } = await supabaseClient
            .from('macro_data')
            .upsert({
                country,
                indicators,
                updated_at: new Date().toISOString()
            }, { onConflict: 'country' });
        if (error) console.warn('[Macro] Supabase save failed:', error.message);
        else console.log(`[Macro] Saved ${country} indicators to Supabase`);
    } catch (e) {
        console.warn('[Macro] Supabase save error:', e.message);
    }
}

// ========== MAIN DATA LOADER ==========

async function checkAlerts(forceRefresh = false) {
    // DAILY SCAN: the first macro load of each calendar day bypasses every cache
    // layer, so US + Israel indicators are re-scanned from the live sources daily.
    try {
        const today = new Date().toISOString().slice(0, 10);
        if (localStorage.getItem('macro_last_scan_day') !== today) {
            forceRefresh = true;
            localStorage.setItem('macro_last_scan_day', today);
            console.log('[Macro] First load today — forcing a fresh daily scan');
            // Daily scan also re-pulls the yield curves (market-close data) so the
            // curves + macro analysis are pre-warmed and instant when the page opens
            if (typeof _fetchYieldsCached === 'function') {
                try { _fetchYieldsCached(() => { }); } catch (e) { /* background warm only */ }
            }
        }
    } catch (e) { /* ignore */ }

    window._macroUsingCache = { us: false, il: false };

    // Pre-seed globals from verified baseline so first render always shows real data.
    // Live API data will overwrite these values once async calls resolve.
    if (!window._macroHeadUS) {
        const baseUS = {};
        for (const [key, val] of Object.entries(MACRO_VERIFIED_BASELINE.us)) {
            if (val.value !== null) baseUS[key] = { ...val };
        }
        window._macroHeadUS = baseUS;
    }
    if (!window._macroHeadIL) {
        const baseIL = {};
        for (const [key, val] of Object.entries(MACRO_VERIFIED_BASELINE.il)) {
            if (val.value !== null) baseIL[key] = { ...val };
        }
        window._macroHeadIL = baseIL;
    }

    // Layer 0: Seed localStorage cache from Supabase (persisted verified data)
    if (!forceRefresh) {
        try {
            const supaData = await _supaLoadMacroData();
            if (supaData) {
                if (supaData.us && !_cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND)) {
                    _cacheSet(_MACRO_CACHE.US_HEAD, supaData.us);
                    console.log('[Macro] Seeded US cache from Supabase');
                }
                if (supaData.il && !_cacheGet(_MACRO_CACHE.IL_HEAD, _MACRO_TTL_IND)) {
                    _cacheSet(_MACRO_CACHE.IL_HEAD, supaData.il);
                    console.log('[Macro] Seeded IL cache from Supabase');
                }
            }
        } catch (e) {
            console.warn('[Macro] Supabase seed failed:', e.message);
        }
    }

    // Fetch all indicator data concurrently
    const [usHead, ilHead, usCal, ilCal] = await Promise.all([
        _fetchUSHeadlines(forceRefresh),
        _fetchILHeadlines(forceRefresh),
        _fetchCalendarEvents('US', _MACRO_CACHE.US_CAL, forceRefresh),
        _fetchCalendarEvents('IL', _MACRO_CACHE.IL_CAL, forceRefresh),
    ]);

    // US: if fresh fetch failed, serve stale cache (better than nothing)
    if (!usHead && !forceRefresh) {
        const staleUS = _cacheGet(_MACRO_CACHE.US_HEAD, Infinity);
        if (staleUS) {
            console.log('[Macro] ⚠ Serving stale US cache (all API calls failed)');
            window._macroHeadUS    = staleUS;
            window._macroUsingCache.us = true;
        } else {
            window._macroHeadUS = null;
        }
    } else {
        window._macroHeadUS = usHead;
    }

    // IL: same stale-cache fallback
    if (!ilHead && !forceRefresh) {
        const staleIL = _cacheGet(_MACRO_CACHE.IL_HEAD, Infinity);
        if (staleIL) {
            console.log('[Macro] ⚠ Serving stale IL cache (all API calls failed)');
            window._macroHeadIL    = staleIL;
            window._macroUsingCache.il = true;
        } else {
            window._macroHeadIL = null;
        }
    } else {
        window._macroHeadIL = ilHead;
    }

    window._macroCalUS = usCal || [];
    window._macroCalIL = ilCal || [];

    alerts = [...window._macroCalUS, ...window._macroCalIL];
    _resolveReadState(alerts);

    // Update header timestamp
    const lastUpdateEl = document.getElementById('lastUpdate');
    if (lastUpdateEl) {
        const now       = new Date();
        const timeStr   = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        const cacheNote = (window._macroUsingCache.us || window._macroUsingCache.il) ? ' (מטמון)' : '';
        lastUpdateEl.textContent = `עודכן: ${timeStr}${cacheNote}`;
    }

    const mp = document.getElementById('macroPage');
    if (mp && mp.classList.contains('active')) _renderMacroPage();
}

// ========== RENDERING ==========

function renderAlerts() {
    const el = document.getElementById('alertCount');
    if (!el) return;
    const unread = alerts.filter(a => !a.isRead).length;
    el.textContent   = unread;
    el.style.display = unread > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    const item = alerts.find(a => a.id === alertId);
    if (item && !item.isRead) {
        item.isRead = true;
        if (!readAlertIds.includes(alertId)) {
            readAlertIds.push(alertId);
            localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
        }
        const el = document.querySelector(`[data-alert-id="${CSS.escape(alertId)}"]`);
        if (el) { el.classList.remove('macro-unread'); el.classList.add('macro-read'); }
        renderAlerts();
    }
}

function toggleAlerts() {
    document.querySelector('.header').style.display         = 'none';
    // Hide all hero-above-fold children EXCEPT macroPage itself
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) {
        Array.from(heroFold.children).forEach(child => {
            if (child.id !== 'macroPage') child.style.display = 'none';
        });
    }
    document.getElementById('clientsGrid').style.display   = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display                              = 'none';

    _advanceLastSeen();
    _resolveReadState(alerts);
    renderAlerts();
    _renderMacroPage();
    document.getElementById('macroPage').classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'macro' });

    // Always pull the freshest macro data in the background when the page opens,
    // then re-render in place — so the user never stares at stale cached values.
    checkAlerts(true).then(() => {
        if (document.getElementById('macroPage')?.classList.contains('active')) {
            _renderMacroPage();
            renderAlerts();
        }
    }).catch(() => { /* keep cached render */ });
}

// ── API Status Bar ──
function _renderApiStatus() {
    const s   = _macroApiStatus;
    const dot = (v) => `<span class="macro-api-dot ${v === true ? 'ok' : 'err'}"></span>`;
    const msg = (v) => v === true ? 'מחובר' : _macroEscape(String(v || 'ממתין'));

    const fredKey   = (typeof FRED_API_KEY !== 'undefined') ? FRED_API_KEY : '';
    const fredBlock = fredKey
        ? `${dot(s.fred)} FRED US: ${msg(s.fred)} <span class="macro-api-sep">|</span> `
        : `${dot(s.fmpUS)} FMP US: ${msg(s.fmpUS)} <span class="macro-api-sep">|</span> `;

    return `<div class="macro-api-status">
        ${fredBlock}
        ${dot(s.boiIL)} BOI ישראל: ${msg(s.boiIL)}
        <span class="macro-api-sep">|</span>
        ${dot(s.fmpIL)} FMP ישראל: ${msg(s.fmpIL)}
    </div>`;
}

// ── Indicator → Category mapping (for card tags) ──
const _INDICATOR_CATEGORY = {
    cpi: 'אינפלציה', core_cpi: 'אינפלציה', ppi: 'אינפלציה', core_ppi: 'אינפלציה',
    fed_rate: 'מדיניות מוניטרית', boi_rate: 'מדיניות מוניטרית',
    unemployment: 'תעסוקה', nfp: 'תעסוקה',
    gdp: 'צמיחה', real_rate: 'מדיניות מוניטרית',
    il_cpi: 'אינפלציה', il_core_cpi: 'אינפלציה', il_ppi: 'אינפלציה',
    il_unemployment: 'תעסוקה', il_gdp: 'צמיחה', il_real_rate: 'מדיניות מוניטרית',
    il_trade_bal: 'סחר', il_consumer_conf: 'סנטימנט',
};

// ── Main Page Renderer ──
function _renderMacroPage() {
    const mp = document.getElementById('macroPage');

    mp.innerHTML = `
        <div class="macro-page-header">
            <h1 class="macro-main-title">אינדיקטורים כלכליים</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="macro-back-btn" onclick="_refreshMacroData()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    רענן נתונים
                </button>
                <button class="macro-back-btn" onclick="markAllRead()">סמן הכל כנקרא</button>
                <button class="macro-back-btn" onclick="closeMacroPage()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">
            <div id="geoMacroSection" class="geo-macro-section"></div>
            <div id="econCalSection" class="econ-cal-section"></div>
            <div id="macroTabContent">
                ${_renderIndicatorsTab()}
            </div>
        </div>
    `;

    // Charts need the canvases in the DOM; analysis needs the curve data
    setTimeout(() => { try { _renderYieldCurves(); } catch (e) { /* ignore */ } }, 60);
    // Geopolitical + macro-economy updates (loaded async — material items only)
    _loadGeoMacroNews();
    // Economic calendar (CPI/PPI/jobs/rate decisions — US real dates + IL schedule)
    _loadEconCalendar();
    // Keep it live: while the page is open, refresh the news every 5 min and the calendar +
    // indicators hourly so values update right after each scheduled release.
    _startMacroAutoRefresh();
}

// ── Live auto-refresh while the macro page is open ──
let _macroNewsTimer = null, _macroDataTimer = null;
function _startMacroAutoRefresh() {
    _stopMacroAutoRefresh();
    _macroNewsTimer = setInterval(() => {
        if (!document.getElementById('macroPage')?.classList.contains('active')) return;
        _loadGeoMacroNews(true);
    }, 5 * 60 * 1000); // news every 5 min
    _macroDataTimer = setInterval(() => {
        if (!document.getElementById('macroPage')?.classList.contains('active')) return;
        _loadEconCalendar(true);
        if (typeof _refreshMacroData === 'function') _refreshMacroData();   // indicators re-pull (post-release values)
    }, 60 * 60 * 1000); // calendar + indicators hourly
}
function _stopMacroAutoRefresh() {
    if (_macroNewsTimer) { clearInterval(_macroNewsTimer); _macroNewsTimer = null; }
    if (_macroDataTimer) { clearInterval(_macroDataTimer); _macroDataTimer = null; }
}
if (typeof window !== 'undefined') window._stopMacroAutoRefresh = _stopMacroAutoRefresh;

// ── Economic calendar (יומן כלכלי) ──
// US: REAL upcoming release dates from FRED (/api/fred?cal=1). Israel: the CBS/Bank-of-Israel
// recurring schedule (CPI is published ~mid-month by the למ"ס) — clearly labeled as the regular
// publication calendar. Shows this month forward, grouped by month, high-impact flagged.
function _ilCalendarEvents() {
    // Israeli CPI — CBS publishes around the 15th of each month (for the prior month).
    const out = [];
    const now = new Date();
    for (let i = 0; i < 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 15);
        if (d >= new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
            out.push({ date: d.toISOString().slice(0, 10), he: 'מדד המחירים לצרכן (ישראל)', imp: 'high', country: 'IL', approx: true });
        }
    }
    return out;
}
let _ecTab = 'US';          // active calendar tab: 'US' | 'IL'
let _ecCollapsed = false;    // section folded?
let _ecData = null;          // { US:[…], IL:[…] }
let _ecSig = '';             // last-rendered signature (skip needless refresh re-renders)

async function _loadEconCalendar(forceRefresh) {
    const el = document.getElementById('econCalSection');
    if (!el) return;
    const CACHE_KEY = 'econ_cal_v1';
    let us = forceRefresh ? null : _cacheGet(CACHE_KEY, 6 * 60 * 60 * 1000); // 6h
    if (!us) {
        if (!_ecData) el.innerHTML = `<div class="ec-head"><span class="ec-title">🗓️ יומן כלכלי — פרסומים קרובים</span></div>
            <div class="macro-loading" style="padding:16px">טוען יומן…</div>`;
        try {
            const r = await _macroFetch(`/api/fred?cal=1`, 11000, 1);
            const j = await r.json();
            us = (j && Array.isArray(j.events)) ? j.events : [];
            if (us.length) _cacheSet(CACHE_KEY, us);
        } catch (e) { us = []; }
    }
    _ecData = { US: (us || []).filter(e => e.country === 'US' || !e.country), IL: _ilCalendarEvents() };
    // Avoid needless re-render on the hourly auto-refresh (prevents page jumps); tab/collapse below
    // always call _ecRender directly.
    const sig = JSON.stringify(_ecData.US.map(e => [e.date, e.he])) + '|' + (document.getElementById('ecBody') ? '1' : '0');
    if (forceRefresh && sig === _ecSig && document.querySelector('.ec-table')) return;
    _ecSig = sig;
    _ecRender();
}
function setEcTab(tab) { _ecTab = tab; _ecRender(); }
function toggleEcCollapse() { _ecCollapsed = !_ecCollapsed; _ecRender(); }
if (typeof window !== 'undefined') {
    window._loadEconCalendar = _loadEconCalendar; window.setEcTab = setEcTab; window.toggleEcCollapse = toggleEcCollapse;
}

// Render the calendar as a collapsible TABLE, filtered by the active country tab.
function _ecRender() {
    const el = document.getElementById('econCalSection');
    if (!el || !_ecData) return;
    const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
    const events = (_ecData[_ecTab] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const todayStr = new Date().toISOString().slice(0, 10);
    const soonStr = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    let rows = '';
    if (!events.length) {
        rows = `<tr><td colspan="3" class="ec-empty-td">אין פרסומים קרובים זמינים עבור ${_ecTab === 'IL' ? 'ישראל' : 'ארה״ב'}.</td></tr>`;
    } else {
        const groups = {};
        for (const e of events) { const k = e.date.slice(0, 7); (groups[k] = groups[k] || []).push(e); }
        for (const k of Object.keys(groups).sort()) {
            const [y, m] = k.split('-');
            rows += `<tr class="ec-tr-month"><td colspan="3">${HE_MONTHS[parseInt(m, 10) - 1]} ${y} · ${groups[k].length} פרסומים</td></tr>`;
            for (const e of groups[k]) {
                const d = new Date(e.date); const dd = d.getDate(), mo = d.getMonth() + 1;
                const high = e.imp === 'high'; const soon = e.date <= soonStr;
                rows += `<tr class="ec-tr ${high ? 'ec-high' : 'ec-med'} ${e.date === todayStr ? 'ec-today' : ''}">
                    <td class="ec-td-date"><span class="ec-d">${dd}.${mo}</span>${soon ? ' <span class="ec-soon">בקרוב</span>' : ''}</td>
                    <td class="ec-td-name">${_macroEscape(e.he)}${e.approx ? ' <small>(מועד משוער · לוח הלמ״ס)</small>' : ''}</td>
                    <td class="ec-td-imp"><span class="ec-dot ${high ? 'ec-imp-high' : 'ec-imp-med'}"></span> ${high ? 'גבוהה' : 'בינונית'}</td>
                </tr>`;
            }
        }
    }
    const tab = (t, he) => `<button class="ec-tab ${_ecTab === t ? 'active' : ''}" onclick="setEcTab('${t}')">${he}</button>`;
    const ilNote = _ecTab === 'IL'
        ? `<div class="ec-il-note">מוצג מדד המחירים לצרכן לפי לוח הפרסומים הקבוע של הלמ״ס (~אמצע החודש). מועדי החלטות הריבית של בנק ישראל מתפרסמים בלוח הרשמי שלו.</div>` : '';
    el.innerHTML = `
        <div class="ec-head">
            <button class="ec-collapse" onclick="toggleEcCollapse()" title="קפל / פתח">${_ecCollapsed ? '▸' : '▾'}</button>
            <span class="ec-title">🗓️ יומן כלכלי — פרסומים קרובים</span>
            <button class="gm-refresh" onclick="_loadEconCalendar(true)" title="רענן יומן">⟳</button>
        </div>
        <div class="ec-body ${_ecCollapsed ? 'ec-hidden' : ''}" id="ecBody">
            <div class="ec-tabs">${tab('US', 'ארה״ב')}${tab('IL', 'ישראל')}</div>
            ${ilNote}
            <table class="ec-table">
                <thead><tr><th class="ec-th-date">תאריך</th><th>אירוע</th><th class="ec-th-imp">השפעה</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// ── Geopolitical + macro-economy updates ──────────────────────────────────
// PRIMARY source: the 24/7 macro-feed agent's curated table `macro_updates` (excellent Hebrew,
// material-only, persistent). FALLBACK: the on-demand /api/news?macro=1 endpoint if the agent
// hasn't populated yet. Both yield {he, en, tag, source, date, url}.
const _GEO_MACRO_TAG_CLS = {
    'מוניטרי': 'gm-tag-mon', 'אינפלציה/צמיחה': 'gm-tag-infl',
    'גיאופוליטיקה': 'gm-tag-geo', 'אנרגיה': 'gm-tag-energy', 'שווקים': 'gm-tag-mkt',
};
let _geoMacroSig = '';
async function _loadGeoMacroNews(forceRefresh) {
    const el = document.getElementById('geoMacroSection');
    if (!el) return;
    if (!el.querySelector('.gm-list')) {
        el.innerHTML = `<div class="gm-head"><span class="gm-title">🌍 גיאופוליטיקה ומאקרו — עדכונים מהותיים</span></div>
            <div class="macro-loading" style="padding:18px">טוען עדכונים…</div>`;
    }
    let items = null;
    // 1) Agent-curated feed (Supabase) — preferred.
    try {
        if (typeof supabaseClient !== 'undefined' && supabaseClient) {
            const { data, error } = await supabaseClient
                .from('macro_updates').select('headline_he,headline_en,tag,source,url,published_at,created_at')
                .eq('status', 'active').order('created_at', { ascending: false }).limit(40);
            if (!error && data && data.length) {
                items = data.map(r => ({ he: r.headline_he, en: r.headline_en, tag: r.tag, source: r.source, url: r.url, date: r.published_at || String(r.created_at || '').slice(0, 10) }));
            }
        }
    } catch (e) { /* fall through to endpoint */ }
    // 2) Fallback: on-demand endpoint (until the agent fills the table).
    if (!items || !items.length) {
        try {
            const r = await _macroFetch(`/api/news?macro=1`, 12000, 1);
            const j = await r.json();
            items = (j && Array.isArray(j.macro)) ? j.macro : [];
        } catch (e) { items = items || []; }
    }
    if (!items || !items.length) {
        if (!el.querySelector('.gm-list')) el.innerHTML = `<div class="gm-head"><span class="gm-title">🌍 גיאופוליטיקה ומאקרו — עדכונים מהותיים</span></div>
            <div class="gm-empty">אין כרגע עדכונים מהותיים זמינים. נסה לרענן בעוד מספר דקות.</div>`;
        _geoMacroSig = '';
        return;
    }
    // Skip the DOM rebuild when nothing changed — prevents the periodic auto-refresh from reflowing
    // the page (the "jumps"). Only re-render when the items actually differ.
    const sig = items.map(n => (n.he || n.en || '') + '|' + (n.date || '')).join('§');
    if (sig === _geoMacroSig && el.querySelector('.gm-list')) return;
    _geoMacroSig = sig;
    const rows = items.map(n => {
        const tagCls = _GEO_MACRO_TAG_CLS[n.tag] || 'gm-tag-mkt';
        const he = _macroEscape(n.he || n.en || '');
        const src = _macroEscape(n.source || '');
        const date = n.date ? _macroEscape(String(n.date).split('-').reverse().join('.')) : '';
        const link = n.url ? `href="${_macroEscape(n.url)}" target="_blank" rel="noopener"` : '';
        return `<a class="gm-item" ${link}>
            <span class="gm-tag ${tagCls}">${_macroEscape(n.tag || 'מאקרו')}</span>
            <span class="gm-text">${he}</span>
            <span class="gm-meta">${src}${src && date ? ' · ' : ''}${date}</span>
        </a>`;
    }).join('');
    el.innerHTML = `<div class="gm-head">
            <span class="gm-title">🌍 גיאופוליטיקה ומאקרו — עדכונים מהותיים</span>
            <button class="gm-refresh" onclick="_loadGeoMacroNews(true)" title="רענן עדכונים">⟳</button>
        </div>
        <div class="gm-list">${rows}</div>`;
}
if (typeof window !== 'undefined') window._loadGeoMacroNews = _loadGeoMacroNews;

// ── Format helper for widget values ──
function _fmtUnit(v, u) {
    if (u === '%') return _fmtPct(v);
    if (u === 'K') return (v >= 0 ? '+' : '') + v + 'K';
    if (u === 'idx') return parseFloat(v).toFixed(1);
    if (u === 'B$') return (v >= 0 ? '+' : '') + parseFloat(v).toFixed(1) + 'B$';
    return _fmtNum(v);
}

// ── Headline Widget (Cyber-Noir Card) ──
// Pixel-matched to the executive glassmorphism card grid.
// Layout: tag (top-left) | title (top-right) | columns: קודם / תחזית / עכשיו | footer date.
function _renderHeadlineWidget(key, data, label, unit) {
    const category = _INDICATOR_CATEGORY[key] || 'כלכלה';

    if (!data || data.value === null || data.value === undefined) {
        return `<div class="macro-hw-card macro-hw-unavail">
            <div class="macro-hw-card-header">
                <span class="macro-hw-tag">${_macroEscape(category)}</span>
                <span class="macro-hw-title">${_macroEscape(label)}</span>
            </div>
            <div class="macro-hw-card-body">
                <div class="macro-hw-col">
                    <span class="macro-hw-col-label">עכשיו</span>
                    <span class="macro-hw-col-value macro-hw-val-muted">—</span>
                </div>
            </div>
            <div class="macro-hw-card-footer">נתון לא זמין</div>
        </div>`;
    }

    const actualVal   = _fmtUnit(data.value, unit);
    const prevVal     = (data.previous !== null && data.previous !== undefined) ? _fmtUnit(data.previous, unit) : null;
    const forecastVal = (data.forecast !== null && data.forecast !== undefined) ? _fmtUnit(data.forecast, unit) : null;

    // Sentiment color class for the actual value (equity-impact logic)
    const sentimentCls = _sentimentColor(key, data.value, data.previous);

    // Footer: actual publication date — "D.M.YYYY | refLabel"
    let tsStr = '';
    if (data.date) {
        const d = new Date(data.date);
        if (!isNaN(d.getTime())) {
            const dd = d.getDate();
            const mo = d.getMonth() + 1;
            const yr = d.getFullYear();
            tsStr = `${dd}.${mo}.${yr}`;
            if (data.refLabel) tsStr += ` | ${_macroEscape(data.refLabel)}`;
        }
    } else if (data.refLabel) {
        tsStr = _macroEscape(data.refLabel);
    }

    return `<div class="macro-hw-card">
        <div class="macro-hw-card-header">
            <span class="macro-hw-tag">${_macroEscape(category)}</span>
            <span class="macro-hw-title">${_macroEscape(data.label || label)}</span>
        </div>
        <div class="macro-hw-card-body">
            ${prevVal !== null ? `<div class="macro-hw-col">
                <span class="macro-hw-col-label">קודם</span>
                <span class="macro-hw-col-value">${_macroEscape(prevVal)}</span>
            </div>` : ''}
            ${forecastVal !== null ? `<div class="macro-hw-col">
                <span class="macro-hw-col-label">תחזית</span>
                <span class="macro-hw-col-value macro-hw-val-forecast">${_macroEscape(forecastVal)}</span>
            </div>` : ''}
            <div class="macro-hw-col">
                <span class="macro-hw-col-label">עכשיו</span>
                <span class="macro-hw-col-value macro-hw-val-actual ${sentimentCls}">${_macroEscape(actualVal)}</span>
            </div>
        </div>
        <div class="macro-hw-card-footer">${tsStr}</div>
    </div>`;
}

// ── Indicators Section ──
function _renderIndicatorsTab() {
    const usHead   = window._macroHeadUS || {};
    const ilHead   = window._macroHeadIL || {};
    const usCal    = window._macroCalUS  || [];
    const ilCal    = window._macroCalIL  || [];
    let html = '';

    // ── US Section ──
    html += `<div class="macro-country-section macro-section-us">
        <h2 class="macro-country-header">US Indicators</h2>
        <div class="macro-indicator-grid">
            ${_renderHeadlineWidget('cpi',          usHead.cpi,          'אינפלציה שנתית (CPI YoY)',    '%')}
            ${_renderHeadlineWidget('core_cpi',     usHead.core_cpi,     'אינפלציה ליבה (Core CPI)',    '%')}
            ${_renderHeadlineWidget('ppi',          usHead.ppi,          'מדד מחירי יצרן (PPI MoM)',    '%')}
            ${_renderHeadlineWidget('core_ppi',     usHead.core_ppi,     'מדד יצרן ליבה (Core PPI)',    '%')}
            ${_renderHeadlineWidget('unemployment', usHead.unemployment, 'שיעור אבטלה (Unemployment)',  '%')}
            ${_renderHeadlineWidget('nfp',          usHead.nfp,          'משרות חדשות (NFP)',            'K')}
            ${_renderHeadlineWidget('fed_rate',     usHead.fed_rate,     'ריבית הפד (Fed Rate)',         '%')}
            ${_renderHeadlineWidget('gdp',          usHead.gdp,          'צמיחת תמ״ג (GDP QoQ)',        '%')}
            ${_renderHeadlineWidget('real_rate',    usHead.real_rate,    'ריבית ריאלית (Real Rate)',     '%')}
        </div>`;

    if (usCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-indicator-grid">';
        usCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    // ── Israel Section ──
    html += `<div class="macro-country-section macro-section-il">
        <h2 class="macro-country-header">IL Indicators</h2>
        <div class="macro-indicator-grid">
            ${_renderHeadlineWidget('il_cpi',           ilHead.il_cpi,           'אינפלציה שנתית (CPI YoY)',  '%')}
            ${_renderHeadlineWidget('il_core_cpi',      ilHead.il_core_cpi,      'אינפלציה ליבה (Core CPI)',  '%')}
            ${_renderHeadlineWidget('boi_rate',         ilHead.boi_rate,         'ריבית בנק ישראל (BOI Rate)','%')}
            ${_renderHeadlineWidget('il_unemployment',  ilHead.il_unemployment,  'שיעור אבטלה (Unemployment)','%')}
            ${_renderHeadlineWidget('il_ppi',           ilHead.il_ppi,           'מדד מחירי יצרן (PPI)',     'idx')}
            ${_renderHeadlineWidget('il_gdp',           ilHead.il_gdp,           'צמיחת תמ״ג (GDP QoQ)',     '%')}
            ${_renderHeadlineWidget('il_real_rate',     ilHead.il_real_rate,     'ריבית ריאלית (Real Rate)',  '%')}
            ${_renderHeadlineWidget('il_trade_bal',     ilHead.il_trade_bal,     'מאזן סחר (Trade Balance)',  'B$')}
            ${_renderHeadlineWidget('il_consumer_conf', ilHead.il_consumer_conf, 'אמון צרכנים (CCI)',         '%')}
        </div>`;

    if (ilCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-indicator-grid">';
        ilCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    // ── Yield curves (US + Israel) — charts filled async by _renderYieldCurves ──
    html += `
    <div class="macro-country-section">
        <h2 class="macro-country-header">עקומות תשואה</h2>
        <div class="macro-yield-grid">
            <div class="macro-yield-card glass-card">
                <h3 class="macro-yield-title">עקומת התשואה — ארה"ב (אג"ח ממשלתי)</h3>
                <div class="macro-yield-canvas"><canvas id="usYieldCurve"></canvas></div>
                <div class="macro-yield-note" id="usYieldNote">טוען נתונים…</div>
            </div>
            <div class="macro-yield-card glass-card">
                <h3 class="macro-yield-title">עקומת התשואה — ישראל</h3>
                <div class="macro-yield-canvas"><canvas id="ilYieldCurve"></canvas></div>
                <div class="macro-yield-note" id="ilYieldNote">טוען נתונים…</div>
            </div>
        </div>
    </div>

    <div class="macro-country-section">
        <h2 class="macro-country-header">ניתוח מאקרו-כלכלי</h2>
        <div class="macro-yield-grid">
            <div class="macro-yield-card macro-analysis-host glass-card">
                <h3 class="macro-yield-title">ארה"ב</h3>
                <div class="macro-analysis" id="macroAnalysisUS">מחשב ניתוח…</div>
            </div>
            <div class="macro-yield-card macro-analysis-host glass-card">
                <h3 class="macro-yield-title">ישראל</h3>
                <div class="macro-analysis" id="macroAnalysisIL">מחשב ניתוח…</div>
            </div>
        </div>
    </div>`;

    return html;
}

// ── Yield curves + macro analysis (async fill after the page renders) ──
let _yieldCharts = { us: null, il: null };

const _YIELDS_LS_KEY = 'yields_cache_v1';

// Fetch yields with an instant-from-cache strategy: render yesterday's cached curve
// IMMEDIATELY (zero wait), then refresh from the network in the background and
// re-render only if the data changed. The daily scan warms this cache too.
async function _fetchYieldsCached(onData) {
    let served = false;
    try {
        const raw = localStorage.getItem(_YIELDS_LS_KEY);
        if (raw) {
            const c = JSON.parse(raw);
            if (c && c.data && Array.isArray(c.data.us) && c.data.us.length >= 3) {
                onData(c.data);            // instant paint
                served = true;
                // Same calendar day → cache IS today's scan; skip the network entirely
                if (c.day === new Date().toISOString().slice(0, 10)) return;
            }
        }
    } catch (e) { /* ignore */ }
    try {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if (ctrl) setTimeout(() => ctrl.abort(), 10000); // never hang the section
        const res = await fetch(`/api/yields?d=${new Date().toISOString().slice(0, 10)}`,
            { headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined });
        if (!res.ok) { if (!served) onData(null); return; }
        const data = await res.json();
        if (data && Array.isArray(data.us) && data.us.length >= 3) {
            try { localStorage.setItem(_YIELDS_LS_KEY, JSON.stringify({ day: new Date().toISOString().slice(0, 10), data })); } catch (e) {}
            onData(data);
        } else if (!served) onData(null);
    } catch (e) { if (!served) onData(null); }
}

// Warm the yields cache in the background shortly after app boot, so by the time
// the user opens the macro page the curves render INSTANTLY from localStorage.
if (typeof window !== 'undefined') {
    setTimeout(() => { try { _fetchYieldsCached(() => { }); } catch (e) { /* ignore */ } }, 3500);
}

async function _renderYieldCurves(attempt = 0) {
    const usEl = document.getElementById('usYieldCurve');
    const ilEl = document.getElementById('ilYieldCurve');
    if (!usEl || !ilEl) return;
    // Chart.js is a deferred CDN script — if it isn't ready yet, RETRY instead of
    // silently giving up (this was the endless 'טוען נתונים…' hang).
    if (typeof Chart === 'undefined') {
        if (attempt < 40) setTimeout(() => _renderYieldCurves(attempt + 1), 250);
        return;
    }
    window._yieldData = null; // force repaint (canvases were just re-created)
    _fetchYieldsCached((data) => _paintYieldCurves(data));
}

function _paintYieldCurves(data) {
    const usEl = document.getElementById('usYieldCurve');
    const ilEl = document.getElementById('ilYieldCurve');
    if (!usEl || !ilEl || typeof Chart === 'undefined') return;
    if (!data || !Array.isArray(data.us) || data.us.length < 3) {
        const n1 = document.getElementById('usYieldNote'), n2 = document.getElementById('ilYieldNote');
        if (n1) n1.textContent = 'לא ניתן לטעון את העקומה כרגע.';
        if (n2) n2.textContent = 'לא ניתן לטעון את העקומה כרגע.';
        _renderMacroAnalysis(null);
        return;
    }
    // Skip repaint when nothing changed (cache → identical network response)
    if (window._yieldData && JSON.stringify(window._yieldData) === JSON.stringify(data)) return;
    window._yieldData = data;

    // Theme-aware inks: day mode → black numbers on light; night → light on dark
    const _day = document.documentElement.classList.contains('day-mode');
    const tickColor = _day ? '#0f172a' : '#fff';
    const gridColor = _day ? 'rgba(15,23,42,0.1)' : 'rgba(255,255,255,0.06)';
    const mkCurve = (canvas, pts, color) => new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: pts.map(p => p.label),
            datasets: [{
                data: pts.map(p => p.value), borderColor: color, borderWidth: 2.5,
                pointRadius: 4, pointBackgroundColor: color, pointBorderColor: _day ? '#0f172a' : '#fff', pointBorderWidth: 1,
                fill: false, tension: 0.35,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(2)}%` } } },
            scales: {
                x: { ticks: { color: tickColor, font: { size: 11, weight: '700' } }, grid: { color: gridColor } },
                y: { ticks: { color: tickColor, font: { size: 11 }, callback: (v) => v + '%' }, grid: { color: gridColor } },
            },
        },
    });

    if (_yieldCharts.us) { try { _yieldCharts.us.destroy(); } catch (e) {} }
    if (_yieldCharts.il) { try { _yieldCharts.il.destroy(); } catch (e) {} }
    _yieldCharts.us = mkCurve(usEl, data.us, '#00e5ff');
    _yieldCharts.il = mkCurve(ilEl, data.il, '#4ade80');

    // Short-vs-long emphasis + data provenance (as-of date, daily after each close)
    const usMap = {}, usDates = {};
    data.us.forEach(p => { usMap[p.label] = p.value; usDates[p.label] = p.date; });
    const usNote = document.getElementById('usYieldNote');
    if (usNote && usMap['10Y'] != null) {
        const short = usMap['3M'], long = usMap['10Y'], two = usMap['2Y'];
        const sp = long - short;
        const sp210 = (two != null) ? (long - two) : null;
        const asOf = usDates['10Y'] ? new Date(usDates['10Y']).toLocaleDateString('he-IL') : '';
        usNote.innerHTML = `
            <div class="yield-sl-row"><span>אג"ח קצר (3M): <b>${short.toFixed(2)}%</b></span><span>אג"ח ארוך (10Y): <b>${long.toFixed(2)}%</b></span>
                <span>מרווח קצר-ארוך: <b>${sp >= 0 ? '+' : ''}${sp.toFixed(2)}%</b></span>${sp210 != null ? `<span>2Y/10Y: <b>${sp210 >= 0 ? '+' : ''}${sp210.toFixed(2)}%</b></span>` : ''}</div>
            <div>${sp < 0 ? 'עקומה הפוכה — סיגנל האטה היסטורי' : 'עקומה נורמלית — ציפיות צמיחה חיוביות'} · נתוני משרד האוצר האמריקאי (H.15), נכון ל-${asOf}, מתעדכן יומית לאחר סגירת המסחר</div>`;
    }
    const ilMap = {}, ilDates = {};
    (data.il || []).forEach(p => { ilMap[p.label] = p.value; ilDates[p.label] = p.date; });
    const boi = ilMap['ריבית בנק ישראל'], il10 = ilMap['10 שנים (אג"ח ממשלתי)'];
    const ilNote = document.getElementById('ilYieldNote');
    if (ilNote && boi != null && il10 != null) {
        const sp = il10 - boi;
        const d10 = ilDates['10 שנים (אג"ח ממשלתי)'] ? new Date(ilDates['10 שנים (אג"ח ממשלתי)']).toLocaleDateString('he-IL') : '';
        ilNote.innerHTML = `
            <div class="yield-sl-row"><span>קצר (ריבית בנק ישראל): <b>${boi.toFixed(2)}%</b></span><span>ארוך (אג"ח 10 שנים): <b>${il10.toFixed(2)}%</b></span>
                <span>מרווח קצר-ארוך: <b>${sp >= 0 ? '+' : ''}${sp.toFixed(2)}%</b></span></div>
            <div>${sp >= 0 ? 'תלילות חיובית — השוק מתמחר צמיחה עם ריבית יורדת' : 'עקומה הפוכה'} · ריבית בנק ישראל רשמית ועדכנית (3.75%, מ-25.5); תשואות האג"ח — הפרסום החודשי הרשמי האחרון של ה-OECD (${d10}; מתפרסם בפיגור של כחודשיים)</div>`;
    }

    _renderMacroAnalysis(data);
}

// Rule-based Hebrew macro analysis built from the CURRENT indicator data.
function _renderMacroAnalysis(curve) {
    const us = window._macroHeadUS || {};
    const il = window._macroHeadIL || {};
    const v = (o) => (o && o.value != null) ? o.value : null;
    const f1 = (x) => x != null ? parseFloat(x).toFixed(1) : '—';

    // ── US ──
    const usEl = document.getElementById('macroAnalysisUS');
    if (usEl) {
        const cpi = v(us.cpi), core = v(us.core_cpi), fed = v(us.fed_rate),
            unemp = v(us.unemployment), nfp = v(us.nfp), gdp = v(us.gdp), rr = v(us.real_rate);
        const p = [];
        if (cpi != null) {
            const accel = us.cpi.previous != null && cpi > us.cpi.previous;
            p.push(`<b>אינפלציה:</b> ה-CPI השנתי עומד על <b>${f1(cpi)}%</b>${accel ? ' ובמגמת האצה' : ''}${core != null ? `, בעוד הליבה (${f1(core)}%) ${core < cpi ? 'מתונה ממנו — עיקר הלחץ מאנרגיה/סחורות' : 'גבוהה — לחץ מחירים רחב'}` : ''}. ${cpi > 3 ? 'מעל יעד הפד (2%) — מגביל את מרחב ההורדות.' : 'בסביבת היעד.'}`);
        }
        if (fed != null) {
            p.push(`<b>מדיניות:</b> ריבית הפד ${f1(fed)}%${rr != null ? `, ריבית ריאלית ${f1(rr)}%` : ''} — ${cpi != null && cpi > 3.5 ? 'הפד צפוי להישאר זהיר כל עוד האינפלציה מואצת' : 'מרחב להקלה אם האינפלציה תתמתן'}.`);
        }
        if (unemp != null || nfp != null) {
            p.push(`<b>תעסוקה:</b> אבטלה ${f1(unemp)}%${nfp != null ? `, תוספת משרות ${nfp > 0 ? '+' : ''}${Math.round(nfp)}K` : ''} — ${unemp != null && unemp <= 4.5 ? 'שוק עבודה יציב התומך בצריכה' : 'סימני התקררות בשוק העבודה'}.`);
        }
        if (gdp != null) p.push(`<b>צמיחה:</b> תמ"ג ${f1(gdp)}% (קצב רבעוני) — ${gdp >= 1.5 ? 'התרחבות מתונה' : gdp >= 0 ? 'צמיחה איטית' : 'התכווצות'}.`);
        if (curve) {
            const m = {}; curve.us.forEach(x => { m[x.label] = x.value; });
            if (m['10Y'] != null && m['3M'] != null) {
                const sp = m['10Y'] - m['3M'];
                p.push(`<b>עקומת התשואה:</b> ${sp < 0 ? `הפוכה (${sp.toFixed(2)}%) — השוק מתמחר האטה/הורדות ריבית` : `נורמלית (+${sp.toFixed(2)}%) — ציפיות צמיחה חיוביות`}.`);
            }
        }
        const fg = window._marketSentiment;
        const bottomUS = (cpi != null && cpi > 3.5)
            ? 'שורה תחתונה: סביבה מאתגרת לנכסי סיכון — אינפלציה מואצת מגבילה את הפד; עדיפות לסלקטיביות ולנכסים דפנסיביים.'
            : 'שורה תחתונה: סביבה תומכת יחסית בנכסי סיכון, בכפוף להמשך התמתנות האינפלציה.';
        p.push(`${bottomUS}${fg && fg.compositeScore != null ? ` סנטימנט (CNN F&G): ${fg.compositeScore} — ${fg.labelHe || ''}.` : ''}`);
        usEl.innerHTML = p.map(x => `<p>${x}</p>`).join('');
    }

    // ── Israel ──
    const ilEl = document.getElementById('macroAnalysisIL');
    if (ilEl) {
        const cpi = v(il.il_cpi), boi = v(il.boi_rate), unemp = v(il.il_unemployment), gdp = v(il.il_gdp);
        const p = [];
        if (cpi != null) p.push(`<b>אינפלציה:</b> ${f1(cpi)}% שנתי — ${cpi >= 1 && cpi <= 3 ? 'בתוך יעד בנק ישראל (1%–3%), יציבות מחירים טובה' : cpi > 3 ? 'מעל היעד' : 'מתחת ליעד'}.`);
        if (boi != null) p.push(`<b>מדיניות:</b> ריבית בנק ישראל ${f1(boi)}% לאחר הורדה (25.5) — מחזור הקלה מונטרית${cpi != null && cpi <= 2 ? ', הנתמך באינפלציה מרוסנת ובשקל חזק' : ''}. הורדות נוספות תלויות בסביבה הגיאופוליטית.`);
        if (unemp != null) p.push(`<b>תעסוקה:</b> אבטלה ${f1(unemp)}% — שוק עבודה הדוק מאוד ברמה היסטורית.`);
        if (gdp != null) p.push(`<b>צמיחה:</b> תמ"ג ${f1(gdp)}% — ${gdp >= 3 ? 'צמיחה חזקה ביחס למדינות מפותחות' : 'צמיחה מתונה'}.`);
        if (curve) {
            const m = {}; (curve.il || []).forEach(x => { m[x.label] = x.value; });
            const b = m['ריבית בנק ישראל'], y10 = m['10 שנים (אג"ח ממשלתי)'];
            if (b != null && y10 != null) {
                const sp = y10 - b;
                p.push(`<b>עקומת התשואה:</b> אג"ח 10 שנים ב-${f1(y10)}% מול ריבית ${f1(b)}% (${sp >= 0 ? '+' : ''}${sp.toFixed(2)}%) — ${sp >= 0 ? 'תלילות חיובית; השוק מתמחר המשך צמיחה עם ריבית יורדת' : 'עקומה הפוכה'}.`);
            }
        }
        p.push('שורה תחתונה: תמונת מאקרו ישראלית חיובית — אינפלציה ביעד, ריבית יורדת ושוק עבודה הדוק; הסיכון המרכזי נותר גיאופוליטי.');
        ilEl.innerHTML = p.map(x => `<p>${x}</p>`).join('');
    }
}

// ── Calendar Event Card (unified Cyber-Noir style) ──
function _renderCalendarCard(a) {
    const readClass = a.isRead ? 'macro-read' : 'macro-unread';
    const newBadge  = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';

    return `
        <div class="macro-hw-card ${readClass}" data-alert-id="${_macroEscape(a.id)}"
             onclick="markAlertRead('${_macroEscape(a.id)}')" style="cursor:pointer">
            <div class="macro-hw-card-header">
                <span class="macro-hw-tag">${_macroEscape(a.category)}</span>
                <span class="macro-hw-title">${_macroEscape(a.title)} ${newBadge}</span>
            </div>
            <div class="macro-hw-card-body">
                <div class="macro-hw-col">
                    <span class="macro-hw-col-label">קודם</span>
                    <span class="macro-hw-col-value">${_macroEscape(a.previous)}</span>
                </div>
                <div class="macro-hw-col">
                    <span class="macro-hw-col-label">תחזית</span>
                    <span class="macro-hw-col-value macro-hw-val-forecast">${_macroEscape(a.estimate)}</span>
                </div>
                <div class="macro-hw-col">
                    <span class="macro-hw-col-label">עכשיו</span>
                    <span class="macro-hw-col-value macro-hw-val-actual">${_macroEscape(a.actual)}</span>
                </div>
            </div>
            <div class="macro-hw-card-footer">${a.date} | ${a.time}</div>
        </div>`;
}

// ── Empty State ──
function _renderEmpty(text) {
    return `<div class="macro-empty-state" style="padding:30px 20px">
        <div class="macro-empty-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
                 stroke="var(--text-muted)" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
        </div>
        <div class="macro-empty-text">${_macroEscape(text)}</div>
        <div class="macro-empty-sub">לחץ "רענן נתונים" לנסות שוב</div>
    </div>`;
}

// ========== REFRESH / MARK ALL / CLOSE ==========

async function _refreshMacroData() {
    const content = document.getElementById('macroTabContent');
    if (content) {
        content.innerHTML = `<div class="macro-loading">
            <div class="spinner" style="width:32px;height:32px;margin:40px auto"></div>
            <div style="text-align:center;color:var(--text-muted);margin-top:12px">טוען נתונים עדכניים...</div>
        </div>`;
    }
    _macroApiStatus = { fred: null, fmpUS: null, fmpIL: null, boiIL: null };
    await checkAlerts(true);
    renderAlerts();
    const mp = document.getElementById('macroPage');
    if (mp && mp.classList.contains('active')) _renderMacroPage();
}

function markAllRead() {
    alerts.forEach(a => {
        if (!a.isRead) {
            a.isRead = true;
            if (!readAlertIds.includes(a.id)) readAlertIds.push(a.id);
        }
    });
    localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
    _advanceLastSeen();
    renderAlerts();
    if (document.getElementById('macroPage')?.classList.contains('active')) _renderMacroPage();
}

function closeMacroPage() {
    _advanceLastSeen();
    if (typeof _stopMacroAutoRefresh === 'function') _stopMacroAutoRefresh();
    const mp = document.getElementById('macroPage');
    mp.classList.remove('active');
    mp.innerHTML = '';
    document.querySelector('.header').style.display          = '';
    // Restore all hero-above-fold children
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) {
        Array.from(heroFold.children).forEach(child => {
            child.style.display = '';
        });
    }
    document.getElementById('clientsGrid').style.display     = '';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display                               = '';
    if (typeof clearURLState === 'function') clearURLState();
}
