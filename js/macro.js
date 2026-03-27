// ========== MACRO - Live Economic Indicators (US + Israel) & Macro News ==========
//
// US INDICATORS — FRED API (primary), FMP /api/v4/economic (fallback)
//   Series: CPIAUCSL (CPI), CPILFESL (Core CPI), FEDFUNDS (Fed Rate),
//           A191RL1Q225SBEA (GDP Growth), UNRATE (Unemployment)
//
// IL INDICATORS — Bank of Israel SDMX API (BOI rate) + FMP economic calendar (CPI, GDP)
//
// NEWS — RSS feeds via allorigins CORS proxy (primary), Finnhub (fallback)
//   US: Reuters business/world RSS
//   IL: Globes, Calcalist RSS
//   Accordion: click headline → expands 5-8 line Hebrew summary (auto-translated via MyMemory)
//
// Zero simulated data. "נתונים לא זמינים" per-widget on failure.

// ── Cache Keys & TTLs ──
const _MACRO_CACHE = {
    US_HEAD:  'macro_us_headline_v3',
    IL_HEAD:  'macro_il_headline_v3',
    US_CAL:   'macro_us_calendar_v2',
    IL_CAL:   'macro_il_calendar_v2',
    US_NEWS:  'macro_us_news_v2',
    IL_NEWS:  'macro_il_news_v2',
    LAST_TS:  'macro_lastSeenTimestamp'
};
const _MACRO_TTL_IND  = 2 * 60 * 60 * 1000;  // 2 hours
const _MACRO_TTL_NEWS = 30 * 60 * 1000;       // 30 minutes

let _macroActiveTab = 'indicators';
let _macroApiStatus = { fred: null, fmpUS: null, fmpIL: null, boiIL: null, news: null };

// In-memory translation cache (session only)
const _translationsCache = {};

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
// Free API from the St. Louis Federal Reserve. Register at fred.stlouisfed.org/docs/api/api_key.html
// units=pc1 → percent change from year ago (for CPI/Core CPI)
// units=lin → levels (for fed rate, unemployment, GDP growth already in %)

const _FRED_SERIES = [
    { key: 'cpi',          id: 'CPIAUCSL',           units: 'pc1', label: 'מדד המחירים לצרכן (CPI)',   unit: '%' },
    { key: 'core_cpi',     id: 'CPILFESL',           units: 'pc1', label: 'אינפלציית ליבה (Core CPI)', unit: '%' },
    { key: 'fed_rate',     id: 'FEDFUNDS',            units: 'lin', label: 'ריבית הפד',                 unit: '%' },
    { key: 'gdp',          id: 'A191RL1Q225SBEA',     units: 'lin', label: 'צמיחת תוצר (GDP)',          unit: '%' },
    { key: 'unemployment', id: 'UNRATE',              units: 'lin', label: 'שיעור אבטלה',               unit: '%' },
];

async function _fetchFREDIndicators(forceRefresh) {
    const key = (typeof FRED_API_KEY !== 'undefined') ? FRED_API_KEY : '';
    if (!key || key === '') { _macroApiStatus.fred = 'No FRED key'; return null; }

    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fred = true; return cached; }
    }

    const results = {};
    await Promise.all(_FRED_SERIES.map(async (s) => {
        try {
            const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${key}&file_type=json&sort_order=desc&limit=2&units=${s.units}`;
            const res = await _macroFetch(url);
            if (!res.ok) { console.warn(`[FRED] ${s.key} HTTP ${res.status}`); return; }
            const data = await res.json();
            const obs = (data?.observations || []).filter(o => o.value !== '.' && o.value !== '');
            if (obs.length === 0) return;

            const latest = obs[0];
            const prev   = obs.length > 1 ? obs[1] : null;
            const val    = parseFloat(latest.value);
            const prevVal = prev ? parseFloat(prev.value) : null;
            if (isNaN(val)) return;

            let trend = 'flat';
            if (prevVal !== null && !isNaN(prevVal)) trend = val > prevVal ? 'up' : val < prevVal ? 'down' : 'flat';

            results[s.key] = { value: val, previous: prevVal, trend, date: latest.date, prevDate: prev?.date || null, label: s.label, unit: s.unit };
        } catch (e) { console.warn(`[FRED] ${s.key} failed:`, e.message); }
    }));

    const count = Object.keys(results).length;
    _macroApiStatus.fred = count > 0 ? true : 'No data';
    console.log(`[Macro] ✓ FRED US: ${count}/${_FRED_SERIES.length} indicators`);
    if (count > 0) _cacheSet(_MACRO_CACHE.US_HEAD, results);
    return count > 0 ? results : null;
}

// ========== 2. FMP US Indicators (fallback if no FRED key) ==========

const _US_INDICATORS = [
    { key: 'cpi',           fmpName: 'CPI',                        label: 'מדד המחירים לצרכן (CPI)',        unit: '%' },
    { key: 'core_cpi',      fmpName: 'Core CPI',                   label: 'אינפלציית ליבה (Core CPI)',       unit: '%' },
    { key: 'fed_rate',      fmpName: 'Fed Interest Rate Decision',  label: 'ריבית הפד',                      unit: '%' },
    { key: 'gdp',           fmpName: 'GDP Growth Rate',             label: 'צמיחת תוצר (GDP)',               unit: '%' },
    { key: 'unemployment',  fmpName: 'Unemployment Rate',           label: 'שיעור אבטלה',                    unit: '%' },
];

async function _fetchFMPUSIndicators(forceRefresh) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') {
        _macroApiStatus.fmpUS = 'No key'; return null;
    }

    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.US_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fmpUS = true; return cached; }
    }

    const results = {};
    await Promise.all(_US_INDICATORS.map(async (ind) => {
        try {
            const res = await _macroFetch(
                `https://financialmodelingprep.com/api/v4/economic?name=${encodeURIComponent(ind.fmpName)}&apikey=${FMP_API_KEY}`
            );
            if (!res.ok) return;
            const data = await res.json();
            if (!Array.isArray(data) || data.length === 0) return;
            const latest = data[0];
            const prev   = data.length > 1 ? data[1] : null;
            const val    = parseFloat(latest.value);
            const prevVal = prev ? parseFloat(prev.value) : null;
            if (isNaN(val)) return;
            let trend = 'flat';
            if (prevVal !== null && !isNaN(prevVal)) trend = val > prevVal ? 'up' : val < prevVal ? 'down' : 'flat';
            results[ind.key] = { value: val, previous: prevVal, trend, date: latest.date, prevDate: prev?.date || null, label: ind.label, unit: ind.unit };
        } catch (e) { console.warn(`[FMP] US ${ind.key}:`, e.message); }
    }));

    const count = Object.keys(results).length;
    _macroApiStatus.fmpUS = count > 0 ? true : 'No data';
    if (count > 0) _cacheSet(_MACRO_CACHE.US_HEAD, results);
    return count > 0 ? results : null;
}

// Master US headline loader — FRED first, FMP fallback
async function _fetchUSHeadlines(forceRefresh) {
    const fredResult = await _fetchFREDIndicators(forceRefresh);
    if (fredResult) return fredResult;
    console.log('[Macro] FRED unavailable, falling back to FMP for US indicators');
    return _fetchFMPUSIndicators(forceRefresh);
}

// ========== 3. ISRAEL HEADLINE INDICATORS ==========

async function _fetchILHeadlines(forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(_MACRO_CACHE.IL_HEAD, _MACRO_TTL_IND);
        if (cached) { _macroApiStatus.fmpIL = true; _macroApiStatus.boiIL = true; return cached; }
    }

    const results = {};

    // ── BOI Interest Rate (Bank of Israel SDMX API — public, no key) ──
    try {
        const now = new Date();
        const startMonth = new Date(now); startMonth.setMonth(startMonth.getMonth() - 6);
        const startStr = `${startMonth.getFullYear()}-${String(startMonth.getMonth() + 1).padStart(2, '0')}`;
        const boiUrl = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STAT/ERI_RES_130/1.0?startperiod=${startStr}&format=csv`;
        const res = await _macroFetch(boiUrl);

        if (res.ok) {
            const csv = await res.text();
            const lines = csv.trim().split('\n').filter(l => l.trim());
            if (lines.length > 1) {
                const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
                const obsIdx  = header.findIndex(h => h === 'OBS_VALUE' || h.toLowerCase().includes('obs_value'));
                const timeIdx = header.findIndex(h => h === 'TIME_PERIOD' || h.toLowerCase().includes('time_period'));

                let latest = null, prevEntry = null;
                for (let i = lines.length - 1; i >= 1; i--) {
                    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
                    const val  = parseFloat(cols[obsIdx >= 0 ? obsIdx : cols.length - 1]);
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
                    results.boi_rate = { value: latest.value, previous: prevEntry?.value || null, trend, date: latest.date, prevDate: prevEntry?.date || null, label: 'ריבית בנק ישראל', unit: '%' };
                    _macroApiStatus.boiIL = true;
                    console.log(`[Macro] ✓ BOI rate: ${latest.value}% (${latest.date})`);
                }
            }
        } else { _macroApiStatus.boiIL = `HTTP ${res.status}`; }
    } catch (e) { console.warn('[Macro] BOI rate failed:', e.message); _macroApiStatus.boiIL = e.message; }

    // ── IL CPI + GDP via FMP Economic Calendar ──
    if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
        try {
            const now  = new Date();
            const from = new Date(now); from.setDate(from.getDate() - 90);
            const url  = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}&apikey=${FMP_API_KEY}`;
            const res  = await _macroFetch(url);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    const ilEvents = data
                        .filter(i => i.country === 'IL' && i.actual !== null && i.actual !== '' && i.event)
                        .sort((a, b) => new Date(b.date) - new Date(a.date));

                    const cpiEv = ilEvents.find(e => e.event.toLowerCase().includes('cpi') || e.event.toLowerCase().includes('inflation') || e.event.toLowerCase().includes('consumer price'));
                    if (cpiEv) {
                        const val = parseFloat(cpiEv.actual), prev = cpiEv.previous !== null ? parseFloat(cpiEv.previous) : null;
                        if (!isNaN(val)) results.il_cpi = { value: val, previous: (prev !== null && !isNaN(prev)) ? prev : null, trend: (prev !== null && !isNaN(prev)) ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat', date: cpiEv.date, label: 'מדד המחירים לצרכן', unit: '%' };
                    }

                    const gdpEv = ilEvents.find(e => e.event.toLowerCase().includes('gdp'));
                    if (gdpEv) {
                        const val = parseFloat(gdpEv.actual), prev = gdpEv.previous !== null ? parseFloat(gdpEv.previous) : null;
                        if (!isNaN(val)) results.il_gdp = { value: val, previous: (prev !== null && !isNaN(prev)) ? prev : null, trend: (prev !== null && !isNaN(prev)) ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat', date: gdpEv.date, label: 'צמיחת תוצר (GDP)', unit: '%' };
                    }

                    if (!results.boi_rate) {
                        const rateEv = ilEvents.find(e => e.event.toLowerCase().includes('interest rate'));
                        if (rateEv) {
                            const val = parseFloat(rateEv.actual), prev = rateEv.previous !== null ? parseFloat(rateEv.previous) : null;
                            if (!isNaN(val)) results.boi_rate = { value: val, previous: (prev !== null && !isNaN(prev)) ? prev : null, trend: (prev !== null && !isNaN(prev)) ? (val > prev ? 'up' : val < prev ? 'down' : 'flat') : 'flat', date: rateEv.date, label: 'ריבית בנק ישראל', unit: '%' };
                        }
                    }
                    _macroApiStatus.fmpIL = true;
                }
            }
        } catch (e) { console.warn('[Macro] IL FMP failed:', e.message); _macroApiStatus.fmpIL = e.message; }
    }

    const count = Object.keys(results).length;
    console.log(`[Macro] ✓ IL headlines: ${count} indicators`);
    if (count > 0) _cacheSet(_MACRO_CACHE.IL_HEAD, results);
    return count > 0 ? results : null;
}

// ========== 4. FMP CALENDAR EVENTS ==========

async function _fetchCalendarEvents(country, cacheKey, forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(cacheKey, _MACRO_TTL_IND);
        if (cached && cached.length > 0) return cached;
    }
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') return null;
    try {
        const now  = new Date();
        const from = new Date(now); from.setDate(from.getDate() - 60);
        const res  = await _macroFetch(`https://financialmodelingprep.com/api/v3/economic_calendar?from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}&apikey=${FMP_API_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data)) return null;

        const items = data
            .filter(i => i.country === country && i.actual !== null && i.actual !== '' && i.event)
            .map(i => {
                const d = new Date(i.date);
                const actual   = i.actual   != null ? String(i.actual)   : 'N/A';
                const estimate = i.estimate != null && i.estimate !== '' ? String(i.estimate) : 'N/A';
                const previous = i.previous != null && i.previous !== '' ? String(i.previous) : 'N/A';
                let sentiment = 'neutral';
                if (actual !== 'N/A' && estimate !== 'N/A') {
                    const a = parseFloat(actual), e = parseFloat(estimate);
                    if (!isNaN(a) && !isNaN(e)) sentiment = a > e ? 'beat' : (a < e ? 'miss' : 'neutral');
                }
                return { id: `fmp-${country}-${i.event}-${i.date}`, title: i.event, category: _matchCategory(i.event), actual, estimate, previous, sentiment, date: d.toLocaleDateString('he-IL'), time: d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }), rawDate: d.toISOString(), country, isRead: false };
            })
            .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate))
            .slice(0, 30);

        if (items.length > 0) _cacheSet(cacheKey, items);
        return items;
    } catch { return null; }
}

// ========== 5. RSS NEWS (via allorigins CORS proxy) ==========

const _RSS_FEEDS = {
    us: [
        'https://feeds.reuters.com/reuters/businessNews',
        'https://feeds.reuters.com/Reuters/worldNews',
    ],
    il: [
        'https://www.globes.co.il/webservice/rss/rssfeeder.aspx?iID=585',
        'https://www.calcalist.co.il/rss/AAAiHHubHOBIE,0.xml',
    ]
};

async function _fetchRSSFeeds(region, forceRefresh) {
    const cacheKey = region === 'us' ? _MACRO_CACHE.US_NEWS : _MACRO_CACHE.IL_NEWS;
    if (!forceRefresh) {
        const cached = _cacheGet(cacheKey, _MACRO_TTL_NEWS);
        if (cached && cached.length > 0) return cached;
    }

    const feeds = _RSS_FEEDS[region] || [];
    const allItems = [];
    const parser  = new DOMParser();

    for (const feedUrl of feeds) {
        if (allItems.length >= 5) break;
        try {
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(feedUrl)}`;
            const res = await _macroFetch(proxyUrl, 12000);
            if (!res.ok) continue;
            const json = await res.json();
            const xml  = json?.contents;
            if (!xml) continue;

            const doc   = parser.parseFromString(xml, 'text/xml');
            const items = doc.querySelectorAll('item');

            items.forEach((item, idx) => {
                if (allItems.length >= 5) return;
                const title       = item.querySelector('title')?.textContent?.trim() || '';
                const description = item.querySelector('description')?.textContent?.replace(/<[^>]*>/g, '').trim() || '';
                const pubDate     = item.querySelector('pubDate')?.textContent || '';
                if (!title || title.length < 5) return;

                const dt         = pubDate ? new Date(pubDate) : new Date();
                const isHebrew   = /[\u0590-\u05FF]/.test(title);
                const sourceName = feedUrl.includes('reuters') ? 'Reuters' : feedUrl.includes('globes') ? 'Globes' : 'Calcalist';

                allItems.push({
                    id: `rss-${region}-${idx}-${title.substring(0, 20).replace(/\s/g, '')}`,
                    headline:   title,
                    summary:    description.substring(0, 800),
                    source:     sourceName,
                    region:     region.toUpperCase(),
                    date:       isNaN(dt) ? '' : dt.toLocaleDateString('he-IL'),
                    time:       isNaN(dt) ? '' : dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    rawDate:    isNaN(dt) ? new Date().toISOString() : dt.toISOString(),
                    isRead:     false,
                    sourceLang: isHebrew ? 'he' : 'en'
                });
            });
        } catch (e) { console.warn(`[Macro] RSS ${feedUrl} failed:`, e.message); }
    }

    if (allItems.length > 0) {
        _cacheSet(cacheKey, allItems);
        console.log(`[Macro] ✓ RSS ${region.toUpperCase()}: ${allItems.length} articles`);
    }
    return allItems.length > 0 ? allItems : null;
}

// ========== 6. FINNHUB NEWS (fallback) ==========

const _IL_KEYWORDS = /israel|israeli|tel.?aviv|shekel|ils|bank of israel|boi|tase|הבנק|ישראל|תל.?אביב|שקל/i;

async function _fetchFinnhubNews() {
    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY' || FINNHUB_API_KEY === '') return { us: [], il: [] };
    try {
        const res = await _macroFetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
        if (!res.ok) return { us: [], il: [] };
        const data = await res.json();
        if (!Array.isArray(data)) return { us: [], il: [] };

        const map = (item, region) => {
            const dt = new Date(item.datetime * 1000);
            return {
                id: `news-${region}-${item.id}`, headline: item.headline || '', summary: item.summary || '',
                source: item.source || '', region,
                date: dt.toLocaleDateString('he-IL'),
                time: dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                rawDate: dt.toISOString(), isRead: false, sourceLang: 'en'
            };
        };
        const il = [], us = [];
        for (const item of data) {
            if (!item.headline) continue;
            if (_IL_KEYWORDS.test(item.headline) || _IL_KEYWORDS.test(item.summary || '')) { if (il.length < 5) il.push(map(item, 'IL')); }
            else { if (us.length < 5) us.push(map(item, 'US')); }
            if (us.length >= 5 && il.length >= 5) break;
        }
        return { us, il };
    } catch { return { us: [], il: [] }; }
}

// Master news loader — RSS primary, Finnhub supplement
async function _fetchMacroNews(forceRefresh) {
    if (!forceRefresh) {
        const cachedUS = _cacheGet(_MACRO_CACHE.US_NEWS, _MACRO_TTL_NEWS);
        const cachedIL = _cacheGet(_MACRO_CACHE.IL_NEWS, _MACRO_TTL_NEWS);
        if (cachedUS && cachedIL) { _macroApiStatus.news = true; return { us: cachedUS, il: cachedIL }; }
    }

    // Fetch RSS feeds in parallel
    const [rssUS, rssIL] = await Promise.all([
        _fetchRSSFeeds('us', forceRefresh),
        _fetchRSSFeeds('il', forceRefresh)
    ]);

    let us = rssUS || [];
    let il = rssIL || [];

    // Supplement with Finnhub if we don't have enough
    if (us.length < 5 || il.length < 5) {
        const fh = await _fetchFinnhubNews();
        if (us.length < 5 && fh.us.length > 0) us = [...us, ...fh.us].slice(0, 5);
        if (il.length < 5 && fh.il.length > 0) il = [...il, ...fh.il].slice(0, 5);
    }

    _macroApiStatus.news = (us.length > 0 || il.length > 0) ? true : 'No data';
    if (us.length > 0) _cacheSet(_MACRO_CACHE.US_NEWS, us);
    if (il.length > 0) _cacheSet(_MACRO_CACHE.IL_NEWS, il);
    console.log(`[Macro] ✓ News: US=${us.length} IL=${il.length}`);
    return { us: us.length > 0 ? us : null, il: il.length > 0 ? il : null };
}

// ========== 7. HEBREW TRANSLATION (MyMemory API — free, no key) ==========

async function _translateToHebrew(text) {
    if (!text || text.trim().length === 0) return text;
    // Already Hebrew?
    if (/[\u0590-\u05FF]/.test(text.substring(0, 60))) return text;
    try {
        const truncated = text.substring(0, 500);
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=en|he`;
        const res = await _macroFetch(url, 10000);
        if (!res.ok) return text;
        const data = await res.json();
        const translated = data?.responseData?.translatedText;
        if (translated && translated.length > 10 && translated !== truncated) return translated;
    } catch {}
    return text;
}

// ========== 8. ACCORDION LOGIC ==========

function _toggleNewsAccordion(cardEl) {
    const alertId = cardEl.dataset.alertId;
    const body    = cardEl.querySelector('.macro-accordion-body');
    const toggle  = cardEl.querySelector('.macro-accordion-toggle');
    const isOpen  = cardEl.classList.contains('macro-accordion-open');

    if (isOpen) {
        cardEl.classList.remove('macro-accordion-open');
        if (body)   body.style.display = 'none';
        if (toggle) toggle.textContent = '▼';
    } else {
        cardEl.classList.add('macro-accordion-open');
        if (body)   body.style.display = 'block';
        if (toggle) toggle.textContent = '▲';
        if (body && !body.dataset.loaded) _loadNewsAccordionContent(cardEl, body);
    }

    if (alertId) markAlertRead(alertId);
}

async function _loadNewsAccordionContent(cardEl, bodyEl) {
    bodyEl.dataset.loaded = 'loading';
    const summary    = cardEl.dataset.summary || '';
    const sourceLang = cardEl.dataset.sourceLang || 'en';
    const alertId    = cardEl.dataset.alertId || '';

    if (!summary) {
        bodyEl.innerHTML = '<div class="macro-accordion-empty">אין סיכום זמין למאמר זה</div>';
        bodyEl.dataset.loaded = 'done';
        return;
    }

    // Hebrew source — show directly
    if (sourceLang === 'he' || /[\u0590-\u05FF]/.test(summary.substring(0, 50))) {
        bodyEl.innerHTML = `<div class="macro-accordion-summary">${_macroEscape(summary)}</div>`;
        bodyEl.dataset.loaded = 'done';
        return;
    }

    // English source — translate
    if (_translationsCache[alertId]) {
        bodyEl.innerHTML = `<div class="macro-accordion-summary">${_macroEscape(_translationsCache[alertId])}</div>`;
        bodyEl.dataset.loaded = 'done';
        return;
    }

    bodyEl.innerHTML = '<div class="macro-accordion-loading"><span class="macro-acc-spinner"></span> מתרגם לעברית...</div>';

    const translated = await _translateToHebrew(summary);
    if (alertId) _translationsCache[alertId] = translated;

    // Only update if card is still open
    if (cardEl.classList.contains('macro-accordion-open') && bodyEl.style.display !== 'none') {
        bodyEl.innerHTML = `<div class="macro-accordion-summary">${_macroEscape(translated)}</div>`;
    }
    bodyEl.dataset.loaded = 'done';
}

// ========== ALERT LOGIC ==========

function _getLastSeenTs() { try { return localStorage.getItem(_MACRO_CACHE.LAST_TS) || null; } catch { return null; } }
function _setLastSeenTs(s) { try { localStorage.setItem(_MACRO_CACHE.LAST_TS, s); } catch {} }

function _resolveReadState(items) {
    if (!items || items.length === 0) return;
    const last   = _getLastSeenTs();
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

    window._macroHeadUS  = usHead;
    window._macroHeadIL  = ilHead;
    window._macroCalUS   = usCal  || [];
    window._macroCalIL   = ilCal  || [];
    window._macroNewsUS  = newsResult.us  || [];
    window._macroNewsIL  = newsResult.il  || [];

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
    const all    = [...alerts, ...(window._macroNewsUS || []), ...(window._macroNewsIL || [])];
    const unread = all.filter(a => !a.isRead).length;
    el.textContent    = unread;
    el.style.display  = unread > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    const all  = [...alerts, ...(window._macroNewsUS || []), ...(window._macroNewsIL || [])];
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
    const s   = _macroApiStatus;
    const dot = (v) => `<span class="macro-api-dot ${v === true ? 'ok' : 'err'}"></span>`;
    const msg = (v) => v === true ? 'מחובר' : _macroEscape(String(v || 'ממתין'));

    const fredKey = (typeof FRED_API_KEY !== 'undefined') ? FRED_API_KEY : '';
    const fredBlock = fredKey
        ? `${dot(s.fred)} FRED US: ${msg(s.fred)} <span class="macro-api-sep">|</span> `
        : `${dot(s.fmpUS)} FMP US: ${msg(s.fmpUS)} <span class="macro-api-sep">|</span> `;

    return `<div class="macro-api-status">
        ${fredBlock}
        ${dot(s.boiIL)} BOI IL: ${msg(s.boiIL)}
        <span class="macro-api-sep">|</span>
        ${dot(s.fmpIL)} FMP IL: ${msg(s.fmpIL)}
        <span class="macro-api-sep">|</span>
        ${dot(s.news)} חדשות: ${msg(s.news)}
    </div>`;
}

function _renderMacroPage() {
    const mp       = document.getElementById('macroPage');
    const usCalLen = (window._macroCalUS  || []).length;
    const ilCalLen = (window._macroCalIL  || []).length;
    const usNewsLen = (window._macroNewsUS || []).length;
    const ilNewsLen = (window._macroNewsIL || []).length;
    const indTime  = _cacheTime(_MACRO_CACHE.US_HEAD);
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
                    ? `מקורות: FRED (Federal Reserve), FMP, Bank of Israel — נתונים עדכניים${indTime ? ` | עדכון: ${indTime}` : ''}`
                    : `מקורות: Reuters, Globes, Calcalist — חדשות מאקרו יומיות${newsTime ? ` | עדכון: ${newsTime}` : ''} | לחץ על כותרת להרחבת הסיכום`}
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
    const val     = unit === '%' ? _fmtPct(data.value) : _fmtNum(data.value);
    const prevVal = data.previous !== null ? (unit === '%' ? _fmtPct(data.previous) : _fmtNum(data.previous)) : null;
    const arrow   = data.trend === 'up' ? '▲' : data.trend === 'down' ? '▼' : '●';
    const trendClass = data.trend === 'up' ? 'trend-up' : data.trend === 'down' ? 'trend-down' : 'trend-flat';
    const dateStr = data.date ? new Date(data.date).toLocaleDateString('he-IL') : '';
    const change  = (prevVal && data.previous !== null) ? (() => {
        const delta = data.value - data.previous;
        const sign  = delta >= 0 ? '+' : '';
        return `${sign}${delta.toFixed(2)}${unit}`;
    })() : null;

    return `<div class="macro-headline-widget">
        <div class="macro-hw-label">${_macroEscape(data.label || label)}</div>
        <div class="macro-hw-value">${_macroEscape(val)}</div>
        <div class="macro-hw-trend ${trendClass}">
            <span class="macro-hw-arrow">${arrow}</span>
            ${change ? `<span class="macro-hw-change">${_macroEscape(change)}</span>` : ''}
            ${prevVal ? `<span class="macro-hw-prev">קודם: ${_macroEscape(prevVal)}</span>` : ''}
        </div>
        <div class="macro-hw-date">עודכן: ${_macroEscape(dateStr)}</div>
    </div>`;
}

// ── Indicators Tab ──
function _renderIndicatorsTab() {
    const usHead = window._macroHeadUS || {};
    const ilHead = window._macroHeadIL || {};
    const usCal  = window._macroCalUS  || [];
    const ilCal  = window._macroCalIL  || [];
    let html = '';

    html += `<div class="macro-country-section macro-section-us">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇺🇸</span> אינדיקטורים כלכליים ארה"ב</h2>
        <div class="macro-headline-row">
            ${_renderHeadlineWidget(usHead.cpi,          'CPI',      '%')}
            ${_renderHeadlineWidget(usHead.core_cpi,     'Core CPI', '%')}
            ${_renderHeadlineWidget(usHead.fed_rate,     'ריבית הפד','%')}
            ${_renderHeadlineWidget(usHead.gdp,          'GDP',      '%')}
            ${_renderHeadlineWidget(usHead.unemployment, 'אבטלה',    '%')}
        </div>`;
    if (usCal.length > 0) {
        html += '<h3 class="macro-sub-header">לוח שנה כלכלי — אירועים אחרונים</h3><div class="macro-grid">';
        usCal.forEach(a => { html += _renderCalendarCard(a); });
        html += '</div>';
    }
    html += '</div>';

    html += `<div class="macro-country-section macro-section-il">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇮🇱</span> אינדיקטורים כלכליים ישראל</h2>
        <div class="macro-headline-row">
            ${_renderHeadlineWidget(ilHead.boi_rate, 'ריבית בנק ישראל', '%')}
            ${_renderHeadlineWidget(ilHead.il_cpi,   'מדד המחירים לצרכן', '%')}
            ${_renderHeadlineWidget(ilHead.il_gdp,   'צמיחת תוצר', '%')}
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
    const newBadge  = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';
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

    html += `<div class="macro-country-section macro-section-us">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇺🇸</span> חדשות מאקרו — ארה"ב</h2>`;
    if (usNews.length === 0) { html += _renderEmpty('חדשות לא זמינות — ארה"ב'); }
    else { html += '<div class="macro-news-list">'; usNews.forEach(n => { html += _renderNewsCard(n); }); html += '</div>'; }
    html += '</div>';

    html += `<div class="macro-country-section macro-section-il">
        <h2 class="macro-country-header"><span class="macro-country-flag">🇮🇱</span> חדשות מאקרו — ישראל</h2>`;
    if (ilNews.length === 0) { html += _renderEmpty('חדשות לא זמינות — ישראל'); }
    else { html += '<div class="macro-news-list">'; ilNews.forEach(n => { html += _renderNewsCard(n); }); html += '</div>'; }
    html += '</div>';

    return html;
}

// ── News Card with Accordion ──
function _renderNewsCard(n) {
    const readClass  = n.isRead ? 'macro-read' : 'macro-unread';
    const summaryEnc = _macroEscape(n.summary || '');
    const sourceLang = n.sourceLang || ((/[\u0590-\u05FF]/.test(n.headline)) ? 'he' : 'en');
    const safeId     = _macroEscape(n.id);

    return `
        <div class="macro-news-card-full macro-accordion-card ${readClass}"
             data-alert-id="${safeId}"
             data-summary="${summaryEnc}"
             data-source-lang="${sourceLang}"
             onclick="_toggleNewsAccordion(this)">
            <div class="macro-news-headline-row">
                <div class="macro-news-headline">${_macroEscape(n.headline)}</div>
                ${n.summary ? '<span class="macro-accordion-toggle">▼</span>' : ''}
            </div>
            ${n.summary ? '<div class="macro-accordion-body" style="display:none"></div>' : ''}
            <div class="macro-news-meta">
                <span class="macro-live-badge">LIVE</span>
                <span>${_macroEscape(n.source)}</span>
                <span>${n.date}${n.time ? ' | ' + n.time : ''}</span>
            </div>
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
    _macroApiStatus = { fred: null, fmpUS: null, fmpIL: null, boiIL: null, news: null };
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
