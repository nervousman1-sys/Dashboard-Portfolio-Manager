// ========== MACRO - Live Economic Indicators (US + Israel) & Macro News ==========
//
// HEADLINE INDICATORS — dedicated API calls for key metrics:
//   US:  CPI, Core CPI, Fed Interest Rate, GDP, Unemployment — via FMP /api/v4/economic
//   IL:  BOI Interest Rate — via Bank of Israel SDMX API (CORS-safe)
//        IL CPI, IL GDP — via FMP economic calendar (country=IL)
//
// CALENDAR EVENTS — FMP Economic Calendar (60 day lookback, US + IL)
// NEWS — Finnhub general news, split 5 US + 5 Israel
//
// Zero simulated data. "נתונים לא זמינים" per-widget on failure.

// ── Cache & Config ──
const _MACRO_CACHE = {
    US_HEAD:  'macro_us_headline_v2',
    IL_HEAD:  'macro_il_headline_v2',
    US_CAL:   'macro_us_calendar_v2',
    IL_CAL:   'macro_il_calendar_v2',
    US_NEWS:  'macro_us_news',
    IL_NEWS:  'macro_il_news',
    LAST_TS:  'macro_lastSeenTimestamp'
};
const _MACRO_TTL_IND  = 2 * 60 * 60 * 1000;  // 2 hours (these update monthly/quarterly)
const _MACRO_TTL_NEWS = 30 * 60 * 1000;       // 30 minutes

let _macroActiveTab = 'indicators';
let _macroApiStatus = { fmpUS: null, fmpIL: null, boiIL: null, finnhub: null };

// ========== UTILITIES ==========

function _macroEscape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _macroFetch(url, ms = 12000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

function _cacheGet(key, ttl) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (Date.now() - obj.ts > ttl) return null;
        if (Array.isArray(obj.d) && obj.d[0]?.source === 'Simulated') { localStorage.removeItem(key); return null; }
        return obj.d;
    } catch { return null; }
}
function _cacheSet(key, data) { try { localStorage.setItem(key, JSON.stringify({ d: data, ts: Date.now() })); } catch {} }
function _cacheTime(key) { try { return new Date(JSON.parse(localStorage.getItem(key)).ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); } catch { return null; } }

// Format number cleanly: 4.5 → "4.50%", 267000 → "267,000"
function _fmtPct(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    return n.toFixed(2) + '%';
}
function _fmtNum(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
    return n.toFixed(2);
}

// ========== CATEGORY MATCHING ==========
function _matchCategory(eventName) {
    if (!eventName) return 'כלכלה';
    const sortedKeys = Object.keys(MACRO_CATEGORY_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) { if (eventName.includes(key)) return MACRO_CATEGORY_MAP[key]; }
    const l = eventName.toLowerCase();
    if (l.includes('cpi') || l.includes('inflation') || l.includes('pce') || l.includes('ppi') || l.includes('producer price')) return 'אינפלציה';
    if (l.includes('gdp') || l.includes('growth')) return 'צמיחה';
    if (l.includes('payroll') || l.includes('employment') || l.includes('jobless') || l.includes('unemployment')) return 'תעסוקה';
    if (l.includes('interest rate') || l.includes('fed') || l.includes('fomc') || l.includes('ריבית')) return 'מדיניות מוניטרית';
    if (l.includes('pmi') || l.includes('manufacturing') || l.includes('industrial') || l.includes('durable')) return 'ייצור';
    if (l.includes('retail') || l.includes('spending') || l.includes('personal income')) return 'צריכה';
    if (l.includes('housing') || l.includes('building') || l.includes('home sale')) return 'נדל"ן';
    if (l.includes('confidence') || l.includes('sentiment')) return 'סנטימנט';
    if (l.includes('trade balance') || l.includes('export') || l.includes('import')) return 'סחר';
    return 'כלכלה';
}

// ========== 1. US HEADLINE INDICATORS (FMP /api/v4/economic) ==========
// FMP endpoint: /api/v4/economic?name=CPI&apikey=...
// Returns array: [{date, value}, ...] sorted newest-first.

const _US_INDICATORS = [
    { key: 'cpi',           fmpName: 'CPI',                        label: 'מדד המחירים לצרכן (CPI)',        unit: '%' },
    { key: 'core_cpi',      fmpName: 'Core CPI',                   label: 'אינפלציית ליבה (Core CPI)',       unit: '%' },
    { key: 'fed_rate',      fmpName: 'Fed Interest Rate Decision',  label: 'ריבית הפד',                      unit: '%' },
    { key: 'gdp',           fmpName: 'GDP Growth Rate',             label: 'צמיחת תוצר (GDP)',               unit: '%' },
    { key: 'unemployment',  fmpName: 'Unemployment Rate',           label: 'שיעור אבטלה',                    unit: '%' },
];

async function _fetchUSHeadlines(forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fmpUS = true; return cached; }
    }
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') {
        _macroApiStatus.fmpUS = 'API key missing'; return null;
    }

    const results = {};
    // Fetch all indicators in parallel
    const promises = _US_INDICATORS.map(async (ind) => {
        try {
            const res = await _macroFetch(
                `https://financialmodelingprep.com/api/v4/economic?name=${encodeURIComponent(ind.fmpName)}&apikey=${FMP_API_KEY}`
            );
            if (!res.ok) return;
            const data = await res.json();
            if (!Array.isArray(data) || data.length === 0) return;

            // data is [{date, value}, ...] — pick the latest
            const latest = data[0];
            const prev = data.length > 1 ? data[1] : null;
            const val = parseFloat(latest.value);
            const prevVal = prev ? parseFloat(prev.value) : null;
            if (isNaN(val)) return;

            let trend = 'flat';
            if (prevVal !== null && !isNaN(prevVal)) {
                if (val > prevVal) trend = 'up';
                else if (val < prevVal) trend = 'down';
            }

            results[ind.key] = {
                value: val,
                previous: prevVal,
                trend,
                date: latest.date,
                prevDate: prev ? prev.date : null,
                label: ind.label,
                unit: ind.unit
            };
        } catch (e) {
            console.warn(`[Macro] US ${ind.key} failed:`, e.message);
        }
    });

    await Promise.all(promises);
    const count = Object.keys(results).length;
    _macroApiStatus.fmpUS = count > 0 ? true : 'No data returned';
    console.log(`[Macro] ✓ US headlines: ${count}/${_US_INDICATORS.length} indicators`);

    if (count > 0) _cacheSet(_MACRO_CACHE.US_HEAD, results);
    return count > 0 ? results : null;
}

// ========== 2. ISRAEL HEADLINE INDICATORS ==========
// BOI Interest Rate: Bank of Israel SDMX REST API (public, CORS-safe)
//   https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STAT/ERI_RES_130/1.0?startperiod=YYYY-MM&format=csv
// IL CPI / GDP: FMP economic calendar filtered by country=IL

async function _fetchILHeadlines(forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.IL_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fmpIL = true; _macroApiStatus.boiIL = true; return cached; }
    }

    const results = {};

    // ── BOI Interest Rate ──
    try {
        const now = new Date();
        const startMonth = new Date(now); startMonth.setMonth(startMonth.getMonth() - 6);
        const startStr = `${startMonth.getFullYear()}-${String(startMonth.getMonth() + 1).padStart(2, '0')}`;

        const boiUrl = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STAT/ERI_RES_130/1.0?startperiod=${startStr}&format=csv`;
        console.log(`[Macro] Fetching BOI interest rate: ${boiUrl}`);
        const res = await _macroFetch(boiUrl);

        if (res.ok) {
            const csv = await res.text();
            // CSV format: header row, then data rows. Last column is typically the rate value.
            // Parse: find the last row with a numeric value.
            const lines = csv.trim().split('\n').filter(l => l.trim());
            if (lines.length > 1) {
                // Find header indices
                const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
                const obsValueIdx = header.findIndex(h => h === 'OBS_VALUE' || h === 'value' || h.toLowerCase().includes('obs_value'));
                const timePeriodIdx = header.findIndex(h => h === 'TIME_PERIOD' || h.toLowerCase().includes('time_period'));

                // Parse all data rows and find the most recent
                let latest = null;
                let prevEntry = null;
                for (let i = lines.length - 1; i >= 1; i--) {
                    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
                    const val = parseFloat(cols[obsValueIdx >= 0 ? obsValueIdx : cols.length - 1]);
                    const period = cols[timePeriodIdx >= 0 ? timePeriodIdx : 0] || '';
                    if (!isNaN(val)) {
                        if (!latest) {
                            latest = { value: val, date: period };
                        } else if (!prevEntry) {
                            prevEntry = { value: val, date: period };
                            break;
                        }
                    }
                }

                if (latest) {
                    let trend = 'flat';
                    if (prevEntry && latest.value > prevEntry.value) trend = 'up';
                    else if (prevEntry && latest.value < prevEntry.value) trend = 'down';

                    results.boi_rate = {
                        value: latest.value,
                        previous: prevEntry ? prevEntry.value : null,
                        trend,
                        date: latest.date,
                        prevDate: prevEntry ? prevEntry.date : null,
                        label: 'ריבית בנק ישראל',
                        unit: '%'
                    };
                    _macroApiStatus.boiIL = true;
                    console.log(`[Macro] ✓ BOI rate: ${latest.value}% (${latest.date})`);
                }
            }
        } else {
            _macroApiStatus.boiIL = `HTTP ${res.status}`;
        }
    } catch (e) {
        console.warn('[Macro] BOI rate failed:', e.message);
        _macroApiStatus.boiIL = e.message;
    }

    // ── IL CPI + GDP via FMP Economic Calendar ──
    if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
        try {
            const now = new Date();
            const from = new Date(now); from.setDate(from.getDate() - 90); // 90 days for quarterly data
            const toStr = now.toISOString().split('T')[0];
            const fromStr = from.toISOString().split('T')[0];

            const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromStr}&to=${toStr}&apikey=${FMP_API_KEY}`;
            const res = await _macroFetch(url);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    // Sort by date desc
                    const ilEvents = data
                        .filter(i => i.country === 'IL' && i.actual !== null && i.actual !== '' && i.event)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));

                    // Find CPI
                    const cpiEvent = ilEvents.find(e =>
                        e.event.toLowerCase().includes('cpi') ||
                        e.event.toLowerCase().includes('inflation') ||
                        e.event.toLowerCase().includes('consumer price')
                    );
                    if (cpiEvent) {
                        const val = parseFloat(cpiEvent.actual);
                        const prev = cpiEvent.previous !== null ? parseFloat(cpiEvent.previous) : null;
                        if (!isNaN(val)) {
                            results.il_cpi = {
                                value: val,
                                previous: (prev !== null && !isNaN(prev)) ? prev : null,
                                trend: (prev !== null && !isNaN(prev)) ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat',
                                date: cpiEvent.date,
                                label: 'מדד המחירים לצרכן',
                                unit: '%'
                            };
                        }
                    }

                    // Find GDP
                    const gdpEvent = ilEvents.find(e =>
                        e.event.toLowerCase().includes('gdp')
                    );
                    if (gdpEvent) {
                        const val = parseFloat(gdpEvent.actual);
                        const prev = gdpEvent.previous !== null ? parseFloat(gdpEvent.previous) : null;
                        if (!isNaN(val)) {
                            results.il_gdp = {
                                value: val,
                                previous: (prev !== null && !isNaN(prev)) ? prev : null,
                                trend: (prev !== null && !isNaN(prev)) ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat',
                                date: gdpEvent.date,
                                label: 'צמיחת תוצר (GDP)',
                                unit: '%'
                            };
                        }
                    }

                    // Find Interest Rate (fallback if BOI failed)
                    if (!results.boi_rate) {
                        const rateEvent = ilEvents.find(e =>
                            e.event.toLowerCase().includes('interest rate')
                        );
                        if (rateEvent) {
                            const val = parseFloat(rateEvent.actual);
                            const prev = rateEvent.previous !== null ? parseFloat(rateEvent.previous) : null;
                            if (!isNaN(val)) {
                                results.boi_rate = {
                                    value: val,
                                    previous: (prev !== null && !isNaN(prev)) ? prev : null,
                                    trend: (prev !== null && !isNaN(prev)) ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat',
                                    date: rateEvent.date,
                                    label: 'ריבית בנק ישראל',
                                    unit: '%'
                                };
                            }
                        }
                    }

                    _macroApiStatus.fmpIL = true;
                }
            }
        } catch (e) {
            console.warn('[Macro] IL FMP indicators failed:', e.message);
            _macroApiStatus.fmpIL = e.message;
        }
    }

    const count = Object.keys(results).length;
    console.log(`[Macro] ✓ IL headlines: ${count} indicators`);
    if (count > 0) _cacheSet(_MACRO_CACHE.IL_HEAD, results);
    return count > 0 ? results : null;
}

// ========== 3. FMP CALENDAR EVENTS (supplementary cards) ==========

async function _fetchCalendarEvents(country, cacheKey, forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(cacheKey, _MACRO_TTL_IND);
        if (cached && cached.length > 0) return cached;
    }
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') return null;

    try {
        const now = new Date();
        const from = new Date(now); from.setDate(from.getDate() - 60); // 60 days
        const toStr = now.toISOString().split('T')[0];
        const fromStr = from.toISOString().split('T')[0];

        const res = await _macroFetch(
            `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromStr}&to=${toStr}&apikey=${FMP_API_KEY}`
        );
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data)) return null;

        const items = data
            .filter(i => i.country === country && i.actual !== null && i.actual !== '' && i.event)
            .map(i => {
                const d = new Date(i.date);
                const actual = i.actual != null ? String(i.actual) : 'N/A';
                const estimate = i.estimate != null && i.estimate !== '' ? String(i.estimate) : 'N/A';
                const previous = i.previous != null && i.previous !== '' ? String(i.previous) : 'N/A';
                let sentiment = 'neutral';
                if (actual !== 'N/A' && estimate !== 'N/A') {
                    const a = parseFloat(actual), e = parseFloat(estimate);
                    if (!isNaN(a) && !isNaN(e)) sentiment = a > e ? 'beat' : (a < e ? 'miss' : 'neutral');
                }
                return {
                    id: `fmp-${country}-${i.event}-${i.date}`,
                    title: i.event, category: _matchCategory(i.event),
                    actual, estimate, previous, sentiment,
                    date: d.toLocaleDateString('he-IL'),
                    time: d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    rawDate: d.toISOString(), country, isRead: false
                };
            })
            .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate))
            .slice(0, 30);

        if (items.length > 0) _cacheSet(cacheKey, items);
        return items;
    } catch { return null; }
}

// ========== 4. MACRO NEWS — Finnhub ==========

const _IL_KEYWORDS = /israel|israeli|tel.?aviv|shekel|ils|bank of israel|boi|tase|הבנק|ישראל|תל.?אביב|שקל/i;

async function _fetchMacroNews(forceRefresh) {
    if (!forceRefresh) {
        const cachedUS = _cacheGet(_MACRO_CACHE.US_NEWS, _MACRO_TTL_NEWS);
        const cachedIL = _cacheGet(_MACRO_CACHE.IL_NEWS, _MACRO_TTL_NEWS);
        if (cachedUS && cachedIL) { _macroApiStatus.finnhub = true; return { us: cachedUS, il: cachedIL }; }
    }
    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY' || FINNHUB_API_KEY === '') {
        _macroApiStatus.finnhub = 'API key missing'; return { us: null, il: null };
    }
    try {
        const res = await _macroFetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
        if (!res.ok) { _macroApiStatus.finnhub = `HTTP ${res.status}`; throw new Error(''); }
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('');

        const map = (item, region) => {
            const dt = new Date(item.datetime * 1000);
            return {
                id: `news-${region}-${item.id}`, headline: item.headline || '', summary: item.summary || '',
                source: item.source || '', region,
                date: dt.toLocaleDateString('he-IL'),
                time: dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                rawDate: dt.toISOString(), isRead: false
            };
        };
        const il = [], us = [];
        for (const item of data) {
            if (!item.headline) continue;
            if (_IL_KEYWORDS.test(item.headline) || _IL_KEYWORDS.test(item.summary || '')) {
                if (il.length < 5) il.push(map(item, 'IL'));
            } else {
                if (us.length < 5) us.push(map(item, 'US'));
            }
            if (us.length >= 5 && il.length >= 5) break;
        }
        if (us.length < 5) {
            for (const item of data) {
                if (!item.headline) continue;
                if (us.some(n => n.id === `news-US-${item.id}`) || il.some(n => n.id === `news-IL-${item.id}`)) continue;
                us.push(map(item, 'US'));
                if (us.length >= 5) break;
            }
        }
        _cacheSet(_MACRO_CACHE.US_NEWS, us); _cacheSet(_MACRO_CACHE.IL_NEWS, il);
        _macroApiStatus.finnhub = true;
        return { us, il };
    } catch (e) {
        if (!_macroApiStatus.finnhub) _macroApiStatus.finnhub = e.message || 'Failed';
        return { us: null, il: null };
    }
}

// ========== ALERT LOGIC ==========

function _getLastSeenTs() { try { return localStorage.getItem(_MACRO_CACHE.LAST_TS) || null; } catch { return null; } }
function _setLastSeenTs(s) { try { localStorage.setItem(_MACRO_CACHE.LAST_TS, s); } catch {} }

function _resolveReadState(items) {
    if (!items || items.length === 0) return;
    const last = _getLastSeenTs();
    const lastMs = last ? new Date(last).getTime() : 0;
    items.forEach(item => {
        if (readAlertIds.includes(item.id)) { item.isRead = true; return; }
        if (lastMs > 0 && new Date(item.rawDate).getTime() <= lastMs) { item.isRead = true; return; }
        item.isRead = false;
    });
}

function _advanceLastSeen() {
    const all = [...alerts, ...(window._macroNewsUS || []), ...(window._macroNewsIL || [])];
    if (all.length === 0) return;
    let newest = all[0].rawDate;
    for (const item of all) { if (item.rawDate > newest) newest = item.rawDate; }
    _setLastSeenTs(newest);
}

// ========== MAIN DATA LOADER ==========

async function checkAlerts(forceRefresh = false) {
    const [usHead, ilHead, usCal, ilCal, newsResult] = await Promise.all([
        _fetchUSHeadlines(forceRefresh),
        _fetchILHeadlines(forceRefresh),
        _fetchCalendarEvents('US', _MACRO_CACHE.US_CAL, forceRefresh),
        _fetchCalendarEvents('IL', _MACRO_CACHE.IL_CAL, forceRefresh),
        _fetchMacroNews(forceRefresh)
    ]);

    window._macroHeadUS = usHead;
    window._macroHeadIL = ilHead;
    window._macroCalUS = usCal || [];
    window._macroCalIL = ilCal || [];
    window._macroNewsUS = newsResult.us || [];
    window._macroNewsIL = newsResult.il || [];

    // alerts = calendar events (for badge count + markAlertRead)
    alerts = [...window._macroCalUS, ...window._macroCalIL];
    _resolveReadState(alerts);
    _resolveReadState(window._macroNewsUS);
    _resolveReadState(window._macroNewsIL);

    const mp = document.getElementById('macroPage');
    if (mp && mp.classList.contains('active')) _renderMacroPage();
}

// ========== RENDERING ==========

function renderAlerts() {
    const el = document.getElementById('alertCount');
    if (!el) return;
    const all = [...alerts, ...(window._macroNewsUS || []), ...(window._macroNewsIL || [])];
    const unread = all.filter(a => !a.isRead).length;
    el.textContent = unread;
    el.style.display = unread > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    const all = [...alerts, ...(window._macroNewsUS || []), ...(window._macroNewsIL || [])];
    const item = all.find(a => a.id === alertId);
    if (item && !item.isRead) {
        item.isRead = true;
        if (!readAlertIds.includes(alertId)) { readAlertIds.push(alertId); localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds)); }
        const el = document.querySelector(`[data-alert-id="${CSS.escape(alertId)}"]`);
        if (el) { el.classList.remove('macro-unread'); el.classList.add('macro-read'); }
        renderAlerts();
    }
}

function toggleAlerts() {
    document.querySelector('.header').style.display = 'none';
    document.querySelector('.summary-bar').style.display = 'none';
    document.querySelector('.filters').style.display = 'none';
    const rs = document.getElementById('riskMiniSummary'); if (rs) rs.style.display = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display = 'none';
    _advanceLastSeen();
    _resolveReadState(alerts); _resolveReadState(window._macroNewsUS || []); _resolveReadState(window._macroNewsIL || []);
    renderAlerts();
    _renderMacroPage();
    document.getElementById('macroPage').classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'macro' });
}

function _renderApiStatus() {
    const s = _macroApiStatus;
    const dot = (v) => `<span class="macro-api-dot ${v === true ? 'ok' : 'err'}"></span>`;
    const msg = (v) => v === true ? 'מחובר' : _macroEscape(String(v || 'ממתין'));
    return `<div class="macro-api-status">
        ${dot(s.fmpUS)} FMP US: ${msg(s.fmpUS)}
        <span class="macro-api-sep">|</span>
        ${dot(s.boiIL)} BOI IL: ${msg(s.boiIL)}
        <span class="macro-api-sep">|</span>
        ${dot(s.fmpIL)} FMP IL: ${msg(s.fmpIL)}
        <span class="macro-api-sep">|</span>
        ${dot(s.finnhub)} Finnhub: ${msg(s.finnhub)}
    </div>`;
}

function _renderMacroPage() {
    const mp = document.getElementById('macroPage');
    const usCalLen = (window._macroCalUS || []).length;
    const ilCalLen = (window._macroCalIL || []).length;
    const usNewsLen = (window._macroNewsUS || []).length;
    const ilNewsLen = (window._macroNewsIL || []).length;
    const indTime = _cacheTime(_MACRO_CACHE.US_HEAD);
    const newsTime = _cacheTime(_MACRO_CACHE.US_NEWS);

    mp.innerHTML = `
        <div class="macro-page-header">
            <h1>מאקרו כלכלה — ארה"ב וישראל</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="macro-back-btn" onclick="_refreshMacroData()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                    רענן נתונים
                </button>
                <button class="macro-back-btn" onclick="markAllRead()">סמן הכל כנקרא</button>
                <button class="macro-back-btn" onclick="closeMacroPage()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">
            ${_renderApiStatus()}
            <div class="macro-tabs">
                <button class="macro-tab ${_macroActiveTab === 'indicators' ? 'active' : ''}" onclick="_switchMacroTab('indicators')">
                    אינדיקטורים כלכליים <span class="macro-tab-count">${usCalLen + ilCalLen}</span>
                </button>
                <button class="macro-tab ${_macroActiveTab === 'news' ? 'active' : ''}" onclick="_switchMacroTab('news')">
                    חדשות מאקרו <span class="macro-tab-count">${usNewsLen + ilNewsLen}</span>
                </button>
            </div>
            <div class="macro-source-info">
                ${_macroActiveTab === 'indicators'
                    ? `מקורות: FMP, Bank of Israel — נתונים עדכניים${indTime ? ` | עדכון: ${indTime}` : ''}`
                    : `מקור: Finnhub — חדשות מאקרו יומיות${newsTime ? ` | עדכון: ${newsTime}` : ''}`}
            </div>
            <div id="macroTabContent">
                ${_macroActiveTab === 'indicators' ? _renderIndicatorsTab() : _renderNewsTab()}
            </div>
        </div>
    `;
}

function _switchMacroTab(tab) { _macroActiveTab = tab; _renderMacroPage(); }

// ── HEADLINE WIDGET ──
function _renderHeadlineWidget(data, label, unit) {
    if (!data) {
        return `<div class="macro-headline-widget macro-headline-unavail">
            <div class="macro-hw-label">${_macroEscape(label)}</div>
            <div class="macro-hw-value">נתון לא זמין</div>
        </div>`;
    }
    const val = unit === '%' ? _fmtPct(data.value) : _fmtNum(data.value);
    const prevVal = data.previous !== null ? (unit === '%' ? _fmtPct(data.previous) : _fmtNum(data.previous)) : null;
    const arrow = data.trend === 'up' ? '▲' : data.trend === 'down' ? '▼' : '●';
    const trendClass = data.trend === 'up' ? 'trend-up' : data.trend === 'down' ? 'trend-down' : 'trend-flat';
    const dateStr = data.date ? new Date(data.date).toLocaleDateString('he-IL') : '';

    return `<div class="macro-headline-widget">
        <div class="macro-hw-label">${_macroEscape(data.label || label)}</div>
        <div class="macro-hw-value">${_macroEscape(val)}</div>
        <div class="macro-hw-trend ${trendClass}">
            <span class="macro-hw-arrow">${arrow}</span>
            ${prevVal ? `<span>קודם: ${_macroEscape(prevVal)}</span>` : ''}
        </div>
        <div class="macro-hw-date">עודכן לאחרונה: ${_macroEscape(dateStr)}</div>
    </div>`;
}

// ── Indicators Tab ──
function _renderIndicatorsTab() {
    const usHead = window._macroHeadUS || {};
    const ilHead = window._macroHeadIL || {};
    const usCal = window._macroCalUS || [];
    const ilCal = window._macroCalIL || [];
    let html = '';

    // ── US Section ──
    html += `<div class="macro-country-section">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇺🇸</span> אינדיקטורים כלכליים ארה"ב</h2>
        <div class="macro-headline-row">
            ${_renderHeadlineWidget(usHead.cpi, 'CPI', '%')}
            ${_renderHeadlineWidget(usHead.core_cpi, 'Core CPI', '%')}
            ${_renderHeadlineWidget(usHead.fed_rate, 'ריבית הפד', '%')}
            ${_renderHeadlineWidget(usHead.gdp, 'GDP', '%')}
            ${_renderHeadlineWidget(usHead.unemployment, 'אבטלה', '%')}
        </div>`;
    if (usCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-grid">';
        usCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    // ── Israel Section ──
    html += `<div class="macro-country-section">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇮🇱</span> אינדיקטורים כלכליים ישראל</h2>
        <div class="macro-headline-row">
            ${_renderHeadlineWidget(ilHead.boi_rate, 'ריבית בנק ישראל', '%')}
            ${_renderHeadlineWidget(ilHead.il_cpi, 'מדד המחירים לצרכן', '%')}
            ${_renderHeadlineWidget(ilHead.il_gdp, 'צמיחת תוצר', '%')}
        </div>`;
    if (ilCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-grid">';
        ilCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    return html;
}

function _renderCalendarCard(a) {
    const readClass = a.isRead ? 'macro-read' : 'macro-unread';
    const newBadge = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';
    let sentimentHTML = '';
    if (a.sentiment === 'beat') sentimentHTML = '<span class="macro-sentiment macro-beat">עלה על התחזית</span>';
    else if (a.sentiment === 'miss') sentimentHTML = '<span class="macro-sentiment macro-miss">מתחת לתחזית</span>';
    let actualColor = 'var(--text-primary)';
    if (a.sentiment === 'beat') actualColor = '#22c55e';
    else if (a.sentiment === 'miss') actualColor = '#ef4444';

    return `
        <div class="macro-card ${readClass}" data-alert-id="${_macroEscape(a.id)}" onclick="markAlertRead('${_macroEscape(a.id)}')">
            <div class="macro-card-header">
                <div class="macro-card-title">${_macroEscape(a.title)} ${newBadge}</div>
                <div class="macro-card-category">${_macroEscape(a.category)}</div>
            </div>
            ${sentimentHTML}
            <div class="macro-card-data">
                <div class="macro-data-item"><div class="data-label">בפועל</div><div class="data-value" style="color:${actualColor}">${_macroEscape(a.actual)}</div></div>
                <div class="macro-data-item"><div class="data-label">תחזית</div><div class="data-value" style="color:var(--accent-blue)">${_macroEscape(a.estimate)}</div></div>
                <div class="macro-data-item"><div class="data-label">קודם</div><div class="data-value" style="color:var(--text-muted)">${_macroEscape(a.previous)}</div></div>
            </div>
            <div class="macro-card-time"><span class="macro-live-badge">LIVE</span> ${a.date} | ${a.time}</div>
        </div>`;
}

// ── News Tab ──
function _renderNewsTab() {
    const usNews = window._macroNewsUS || [];
    const ilNews = window._macroNewsIL || [];
    let html = '';

    html += `<div class="macro-country-section">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇺🇸</span> חדשות מאקרו — ארה"ב</h2>`;
    if (usNews.length === 0) { html += _renderEmpty('חדשות לא זמינות — ארה"ב'); }
    else { html += '<div class="macro-news-list">'; usNews.forEach(n => { html += _renderNewsCard(n); }); html += '</div>'; }
    html += '</div>';

    html += `<div class="macro-country-section">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇮🇱</span> חדשות מאקרו — ישראל</h2>`;
    if (ilNews.length === 0) { html += _renderEmpty('חדשות לא זמינות — ישראל'); }
    else { html += '<div class="macro-news-list">'; ilNews.forEach(n => { html += _renderNewsCard(n); }); html += '</div>'; }
    html += '</div>';

    return html;
}

function _renderNewsCard(n) {
    const readClass = n.isRead ? 'macro-read' : 'macro-unread';
    const summary = n.summary ? (n.summary.length > 600 ? n.summary.substring(0, 600) + '...' : n.summary) : '';
    return `
        <div class="macro-card macro-news-card-full ${readClass}" data-alert-id="${_macroEscape(n.id)}" onclick="markAlertRead('${_macroEscape(n.id)}')">
            <div class="macro-news-headline">${_macroEscape(n.headline)}</div>
            ${summary ? `<div class="macro-news-summary-full">${_macroEscape(summary)}</div>` : ''}
            <div class="macro-news-meta"><span class="macro-live-badge">LIVE</span> <span>${_macroEscape(n.source)}</span> <span>${n.date} | ${n.time}</span></div>
        </div>`;
}

function _renderEmpty(text) {
    return `<div class="macro-empty-state" style="padding:30px 20px">
        <div class="macro-empty-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div class="macro-empty-text">${_macroEscape(text)}</div>
        <div class="macro-empty-sub">לחץ "רענן נתונים" לנסות שוב</div>
    </div>`;
}

// ========== REFRESH / MARK ALL / CLOSE ==========

async function _refreshMacroData() {
    const content = document.getElementById('macroTabContent');
    if (content) content.innerHTML = '<div class="macro-loading"><div class="spinner" style="width:32px;height:32px;margin:40px auto"></div><div style="text-align:center;color:var(--text-muted);margin-top:12px">טוען נתונים עדכניים...</div></div>';
    _macroApiStatus = { fmpUS: null, fmpIL: null, boiIL: null, finnhub: null };
    await checkAlerts(true);
    renderAlerts();
    const mp = document.getElementById('macroPage');
    if (mp && mp.classList.contains('active')) _renderMacroPage();
}

function markAllRead() {
    const all = [...alerts, ...(window._macroNewsUS || []), ...(window._macroNewsIL || [])];
    all.forEach(a => { if (!a.isRead) { a.isRead = true; if (!readAlertIds.includes(a.id)) readAlertIds.push(a.id); } });
    localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
    _advanceLastSeen(); renderAlerts();
    if (document.getElementById('macroPage')?.classList.contains('active')) _renderMacroPage();
}

function closeMacroPage() {
    _advanceLastSeen();
    document.getElementById('macroPage').classList.remove('active');
    document.getElementById('macroPage').innerHTML = '';
    document.querySelector('.header').style.display = '';
    document.querySelector('.summary-bar').style.display = '';
    document.querySelector('.filters').style.display = '';
    const rs = document.getElementById('riskMiniSummary'); if (rs) rs.style.display = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
}
