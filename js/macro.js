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
        cpi:          { value: 2.4,   label: 'מדד המחירים לצרכן (CPI)',   unit: '%', date: '2026-02-01', previous: 2.4,  trend: 'flat' },
        core_cpi:     { value: 2.5,   label: 'אינפלציית ליבה (Core CPI)', unit: '%', date: '2026-02-01', previous: 2.6,  trend: 'down' },
        ppi:          { value: 3.4,   label: 'מדד המחירים ליצרן (PPI)',   unit: '%', date: '2026-02-01', previous: 3.0,  trend: 'up' },
        core_ppi:     { value: 3.9,   label: 'PPI ליבה (Core PPI)',       unit: '%', date: '2026-02-01', previous: 3.6,  trend: 'up' },
        fed_rate:     { value: 3.625, label: 'ריבית הפד',                 unit: '%', date: '2026-03-19', previous: 3.625, trend: 'flat' },
        unemployment: { value: 4.4,   label: 'שיעור אבטלה',               unit: '%', date: '2026-02-01', previous: 4.3,  trend: 'up' },
        nfp:          { value: -92,   label: 'משרות חדשות (NFP)',          unit: 'K', date: '2026-02-01', previous: 126,  trend: 'down' },
        gdp:          { value: 3.2,   label: 'צמיחת תוצר (GDP)',          unit: '%', date: '2025-12-31', previous: 4.9,  trend: 'down' },
        real_rate:    { value: 1.23,  label: 'ריבית ריאלית',               unit: '%', date: '2026-02-01', previous: null, trend: 'flat' },
    },
    il: {
        il_cpi:          { value: 2.0,   label: 'מדד המחירים לצרכן',         unit: '%',   date: '2026-02-01', previous: 1.8,   trend: 'up' },
        il_core_cpi:     { value: 2.27,  label: 'אינפלציית ליבה',             unit: '%',   date: '2026-02-01', previous: 1.97,  trend: 'up' },
        boi_rate:        { value: 4.0,   label: 'ריבית בנק ישראל',           unit: '%',   date: '2026-01-05', previous: 4.25,  trend: 'down' },
        il_unemployment: { value: 3.12,  label: 'שיעור אבטלה',               unit: '%',   date: '2026-01-01', previous: 3.07,  trend: 'up' },
        il_ppi:          { value: 118.0, label: 'מדד מחירי תפוקה (PPI)',     unit: 'idx', date: '2026-02-01', previous: 117.7, trend: 'up' },
        il_gdp:          { value: 2.0,   label: 'צמיחת תוצר (GDP)',          unit: '%',   date: '2025-12-31', previous: -0.4,  trend: 'up' },
        il_real_rate:    { value: 2.0,   label: 'ריבית ריאלית',               unit: '%',   date: '2026-02-01', previous: null,  trend: 'flat' },
    },
    _meta: { updatedAt: '2026-04-01', source: 'BLS/FRED/CBS/BOI — Finextium Decision Core' }
};

// ── Cache Keys & TTLs ──
const _MACRO_CACHE = {
    US_HEAD: 'macro_us_headline_v5',
    IL_HEAD: 'macro_il_headline_v5',
    US_CAL:  'macro_us_calendar_v4',
    IL_CAL:  'macro_il_calendar_v4',
    LAST_TS: 'macro_lastSeenTimestamp'
};
const _MACRO_TTL_IND = 6 * 60 * 60 * 1000; // 6 hours (aggressive caching to avoid rate limits)

let _macroApiStatus = { fred: null, fmpUS: null, fmpIL: null, boiIL: null };

// ========== UTILITIES ==========

function _macroEscape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function _macroFetch(url, ms = 12000, retries = 2) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, { signal: c.signal });
            clearTimeout(t);
            return response;
        } catch (error) {
            if (attempt === retries) {
                clearTimeout(t);
                throw error;
            }
            // Exponential backoff: 500ms, 1000ms, ...
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
    { key: 'fed_rate',     id: 'FEDFUNDS',        units: 'lin', label: 'ריבית הפד',                 unit: '%' },
    { key: 'gdp',          id: 'A191RL1Q225SBEA', units: 'lin', label: 'צמיחת תוצר (GDP)',          unit: '%' },
    { key: 'unemployment', id: 'UNRATE',          units: 'lin', label: 'שיעור אבטלה',               unit: '%' },
];

async function _fetchFREDIndicators(forceRefresh) {
    const key = (typeof FRED_API_KEY !== 'undefined') ? FRED_API_KEY : '';
    if (!key || key === '') {
        console.warn('[FRED] No API key — set FRED_API_KEY in env-config.js');
        _macroApiStatus.fred = 'No FRED key';
        return null;
    }

    console.log('[FRED] API key present, fetching indicators...');

    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) {
            console.log('[FRED] Using cached data');
            _macroApiStatus.fred = true;
            return cached;
        }
    }

    const results = {};
    await Promise.all(_FRED_SERIES.map(async (s) => {
        try {
            const url = `https://api.stlouisfed.org/fred/series/observations` +
                `?series_id=${s.id}&api_key=${key}&file_type=json` +
                `&sort_order=desc&limit=2&units=${s.units}`;
            const res = await _macroFetch(url);
            if (!res.ok) { console.warn(`[FRED] ${s.key} HTTP ${res.status}`); return; }

            const data = await res.json();
            const obs  = (data?.observations || []).filter(o => o.value !== '.' && o.value !== '');
            if (obs.length === 0) { console.warn(`[FRED] ${s.key} — no valid observations`); return; }

            const latest  = obs[0];
            const prev    = obs.length > 1 ? obs[1] : null;
            const val     = parseFloat(latest.value);
            const prevVal = prev ? parseFloat(prev.value) : null;
            if (isNaN(val)) { console.warn(`[FRED] ${s.key} — bad value: ${latest.value}`); return; }

            const trend = (prevVal !== null && !isNaN(prevVal))
                ? (val > prevVal ? 'up' : val < prevVal ? 'down' : 'flat')
                : 'flat';

            results[s.key] = {
                value: val, previous: prevVal, trend,
                date: latest.date, prevDate: prev?.date || null,
                label: s.label, unit: s.unit
            };
            console.log(`[FRED] ✓ ${s.key}: ${val}${s.unit} (${latest.date})`);
        } catch (e) { console.warn(`[FRED] ${s.key} failed:`, e.message); }
    }));

    const count = Object.keys(results).length;
    _macroApiStatus.fred = count > 0 ? true : 'No data';
    console.log(`[Macro] FRED US: ${count}/${_FRED_SERIES.length} indicators`);
    if (count > 0) _cacheSet(_MACRO_CACHE.US_HEAD, results);
    return count > 0 ? results : null;
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

async function _fetchFMPUSIndicators(forceRefresh) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') {
        _macroApiStatus.fmpUS = 'No key';
        return null;
    }

    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fmpUS = true; return cached; }
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

    // Layer 2: Try live API overlay (FMP → FRED)
    let liveData = null;
    try {
        liveData = await _fetchFMPUSIndicators(forceRefresh);
        if (liveData) console.log('[Macro] ✓ US live overlay via FMP');
    } catch (e) { console.warn('[Macro] FMP overlay failed:', e.message); }

    if (!liveData) {
        try {
            liveData = await _fetchFREDIndicators(forceRefresh);
            if (liveData) console.log('[Macro] ✓ US live overlay via FRED');
        } catch (e) { console.warn('[Macro] FRED overlay failed:', e.message); }
    }

    // Merge: live data overrides baseline where available and newer
    const merged = { ...baseline };
    if (liveData) {
        for (const [key, val] of Object.entries(liveData)) {
            if (val && val.value !== null && val.value !== undefined) {
                // Only override if live data is same date or newer
                const baseDate = baseline[key]?.date ? new Date(baseline[key].date) : new Date(0);
                const liveDate = val.date ? new Date(val.date) : new Date(0);
                if (liveDate >= baseDate) {
                    merged[key] = val;
                }
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
    if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
        try {
            const now  = new Date();
            const from = new Date(now);
            from.setDate(from.getDate() - 90);
            const url = `https://financialmodelingprep.com/api/v3/economic_calendar` +
                `?from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}` +
                `&apikey=${FMP_API_KEY}`;
            const res = await _macroFetch(url);
            if (res.ok) {
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

    try {
        const now  = new Date();
        const from = new Date(now);
        from.setDate(from.getDate() - 60);
        const url = `https://financialmodelingprep.com/api/v3/economic_calendar` +
            `?from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}` +
            `&apikey=${FMP_API_KEY}`;
        const res = await _macroFetch(url);
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
    window._macroUsingCache = { us: false, il: false };

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
    document.querySelector('.summary-bar').style.display    = 'none';
    document.querySelector('.filters').style.display        = 'none';
    const rs = document.getElementById('riskMiniSummary');
    if (rs) rs.style.display                                = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display   = 'none';

    _advanceLastSeen();
    _resolveReadState(alerts);
    renderAlerts();
    _renderMacroPage();
    document.getElementById('macroPage').classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'macro' });
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
};

// ── Main Page Renderer ──
function _renderMacroPage() {
    const mp = document.getElementById('macroPage');

    mp.innerHTML = `
        <div class="macro-page-header">
            <h1>מאקרו כלכלה — ארה"ב וישראל</h1>
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
            <div id="macroTabContent">
                ${_renderIndicatorsTab()}
            </div>
        </div>
    `;
}

// ── Format helper for widget values ──
function _fmtUnit(v, u) {
    if (u === '%') return _fmtPct(v);
    if (u === 'K') return (v >= 0 ? '+' : '') + v + 'K';
    if (u === 'idx') return parseFloat(v).toFixed(1);
    return _fmtNum(v);
}

// ── Headline Widget (Cyber-Noir Card) ──
// Matches the executive dark glassmorphism card design.
// Layout: category tag top-left, title top-right, columns for Previous/Actual, timestamp footer.
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
                    <span class="macro-hw-col-label">בפועל</span>
                    <span class="macro-hw-col-value" style="color:var(--text-muted)">—</span>
                </div>
            </div>
            <div class="macro-hw-card-footer">נתון לא זמין</div>
        </div>`;
    }

    const actualVal = _fmtUnit(data.value, unit);
    const prevVal   = (data.previous !== null && data.previous !== undefined) ? _fmtUnit(data.previous, unit) : null;

    // Determine color for actual value based on trend
    const actualColor = data.trend === 'up' ? '#22c55e' : data.trend === 'down' ? '#ef4444' : 'var(--text-primary)';

    // Timestamp
    let tsStr = '';
    if (data.date) {
        const d = new Date(data.date);
        if (!isNaN(d.getTime())) {
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            const yr = d.getFullYear();
            tsStr = `${hh}:${mm} | ${dd}.${mo}.${yr}`;
        }
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
            <div class="macro-hw-col macro-hw-col-actual">
                <span class="macro-hw-col-label">בפועל</span>
                <span class="macro-hw-col-value" style="color:${actualColor}">${_macroEscape(actualVal)}</span>
            </div>
        </div>
        ${tsStr ? `<div class="macro-hw-card-footer">${tsStr}</div>` : ''}
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
        <h2 class="macro-country-header"><span class="macro-country-flag">🇺🇸</span> אינדיקטורים כלכליים ארה"ב</h2>
        <div class="macro-indicator-grid">
            ${_renderHeadlineWidget('cpi',          usHead.cpi,          'CPI',           '%')}
            ${_renderHeadlineWidget('core_cpi',     usHead.core_cpi,     'Core CPI',     '%')}
            ${_renderHeadlineWidget('ppi',          usHead.ppi,          'PPI',           '%')}
            ${_renderHeadlineWidget('core_ppi',     usHead.core_ppi,     'Core PPI',     '%')}
            ${_renderHeadlineWidget('unemployment', usHead.unemployment, 'Unemployment Rate',   '%')}
            ${_renderHeadlineWidget('nfp',          usHead.nfp,          'Non Farm Payrolls',   'K')}
            ${_renderHeadlineWidget('fed_rate',     usHead.fed_rate,     'Fed Interest Rate',   '%')}
            ${_renderHeadlineWidget('gdp',          usHead.gdp,          'GDP Growth Rate QoQ', '%')}
            ${_renderHeadlineWidget('real_rate',    usHead.real_rate,    'Real Interest Rate',  '%')}
        </div>`;

    if (usCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-grid">';
        usCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    // ── Israel Section ──
    html += `<div class="macro-country-section macro-section-il">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇮🇱</span> אינדיקטורים כלכליים ישראל</h2>
        <div class="macro-indicator-grid">
            ${_renderHeadlineWidget('il_cpi',          ilHead.il_cpi,          'Inflation Rate YoY',   '%')}
            ${_renderHeadlineWidget('il_core_cpi',     ilHead.il_core_cpi,     'Core CPI YoY',         '%')}
            ${_renderHeadlineWidget('boi_rate',        ilHead.boi_rate,        'BOI Interest Rate',    '%')}
            ${_renderHeadlineWidget('il_unemployment', ilHead.il_unemployment, 'Unemployment Rate',    '%')}
            ${_renderHeadlineWidget('il_ppi',          ilHead.il_ppi,          'Producer Prices',      'idx')}
            ${_renderHeadlineWidget('il_gdp',          ilHead.il_gdp,          'GDP Growth Rate QoQ',  '%')}
            ${_renderHeadlineWidget('il_real_rate',    ilHead.il_real_rate,    'Real Interest Rate',   '%')}
        </div>`;

    if (ilCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-grid">';
        ilCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    return html;
}

// ── Calendar Event Card ──
function _renderCalendarCard(a) {
    const readClass = a.isRead ? 'macro-read' : 'macro-unread';
    const newBadge  = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';
    let sentimentHTML = '';
    if (a.sentiment === 'beat') sentimentHTML = '<span class="macro-sentiment macro-beat">עלה על התחזית</span>';
    else if (a.sentiment === 'miss') sentimentHTML = '<span class="macro-sentiment macro-miss">מתחת לתחזית</span>';
    const actualColor = a.sentiment === 'beat' ? '#22c55e' : a.sentiment === 'miss' ? '#ef4444' : 'var(--text-primary)';

    return `
        <div class="macro-card ${readClass}" data-alert-id="${_macroEscape(a.id)}"
             onclick="markAlertRead('${_macroEscape(a.id)}')">
            <div class="macro-card-header">
                <div class="macro-card-title">${_macroEscape(a.title)} ${newBadge}</div>
                <div class="macro-card-category">${_macroEscape(a.category)}</div>
            </div>
            ${sentimentHTML}
            <div class="macro-card-data">
                <div class="macro-data-item">
                    <div class="data-label">בפועל</div>
                    <div class="data-value" style="color:${actualColor}">${_macroEscape(a.actual)}</div>
                </div>
                <div class="macro-data-item">
                    <div class="data-label">תחזית</div>
                    <div class="data-value" style="color:var(--accent-blue)">${_macroEscape(a.estimate)}</div>
                </div>
                <div class="macro-data-item">
                    <div class="data-label">קודם</div>
                    <div class="data-value" style="color:var(--text-muted)">${_macroEscape(a.previous)}</div>
                </div>
            </div>
            <div class="macro-card-time">
                <span class="macro-live-badge">LIVE</span> ${a.date} | ${a.time}
            </div>
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
    const mp = document.getElementById('macroPage');
    mp.classList.remove('active');
    mp.innerHTML = '';
    document.querySelector('.header').style.display          = '';
    document.querySelector('.summary-bar').style.display     = '';
    document.querySelector('.filters').style.display         = '';
    const rs = document.getElementById('riskMiniSummary');
    if (rs) rs.style.display                                 = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display     = '';
    if (typeof clearURLState === 'function') clearURLState();
}
