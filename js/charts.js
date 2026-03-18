// ========== CHARTS - Chart.js Rendering (Fullscreen, Benchmark, Sector) ==========

// ========== CHART LIFECYCLE UTILITIES ==========

// Safely destroy a chart by its key in the charts{} map
function _safeDestroyChart(key) {
    if (!charts[key]) return;
    try { charts[key].destroy(); } catch (e) { /* canvas may already be orphaned */ }
    delete charts[key];
}

// Destroy any Chart.js instance attached to a canvas element (by canvas ref, not key)
// Uses Chart.getChart() — the only reliable way to detect orphaned instances
function _destroyChartOnCanvas(canvasEl) {
    if (!canvasEl) return;
    try {
        const existing = Chart.getChart(canvasEl);
        if (existing) existing.destroy();
    } catch (e) { /* ignore — canvas might be detached */ }
}

// Clear a canvas's 2D context to prevent frozen frames between destroy/create
function _clearCanvas(canvasEl) {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (ctx2d) ctx2d.clearRect(0, 0, canvasEl.width, canvasEl.height);
}

// Benchmark configuration — all major indices available
const BENCHMARK_SYMBOLS = {
    'SPY': 'S&P 500',
    'QQQ': 'Nasdaq 100',
    'DIA': 'Dow Jones',
    'IWM': 'Russell 2000',
    'TA125.TA': 'TA-125',
    'TA35.TA': 'TA-35'
};

const BENCHMARK_COLORS = {
    'SPY': '#eab308',
    'QQQ': '#06b6d4',
    'DIA': '#f43f5e',
    'IWM': '#a855f7',
    'TA125.TA': '#f97316',
    'TA35.TA': '#8b5cf6'
};

// Cache for benchmark data: key = "symbol_range", value = { data, timestamp }
const _benchmarkCache = {};
const BENCHMARK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — prevents API burnout

// Active state for modal performance chart
let _modalPerfRange = '1y';
let _modalPerfBenchmarks = [];
let _modalPerfChartInstance = null;

// Display mode toggle: 'percent' (default) or 'value'
let _chartDisplayMode = 'percent';

// ========== FETCH BENCHMARK DATA FROM API ==========

function _rangeToDays(range) {
    const map = { '1d': 1, '5d': 5, '1m': 30, '3m': 90, '6m': 180, 'ytd': 0, '1y': 365, '5y': 1825, 'max': 3650, 'all': 3650 };
    if (range === 'ytd') {
        const now = new Date();
        return Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (24 * 60 * 60 * 1000));
    }
    return map[range] || 365;
}

function _rangeToInterval(range) {
    if (range === '1d') return '5min';   // 5-minute candles for 1D — enough granularity
    if (range === '5d') return '1h';     // Hourly candles for 5D
    return '1day';
}

function _rangeToOutputSize(range) {
    if (range === '1d') return 200;   // ~200 five-minute candles (covers 2+ trading days)
    if (range === '5d') return 50;    // ~50 hourly candles
    const days = _rangeToDays(range);
    if (days <= 30) return 30;
    if (days <= 90) return 90;
    if (days <= 180) return 180;
    if (days <= 365) return 365;
    return 1825;
}

// One-time diagnostic: log API key status on first benchmark fetch
let _benchmarkDiagDone = false;
function _logBenchmarkDiag() {
    if (_benchmarkDiagDone) return;
    _benchmarkDiagDone = true;
    const fmpOk = FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY' && FMP_API_KEY !== '';
    const tdOk = TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY' && TWELVE_DATA_API_KEY !== '';
    console.log(`[Benchmark] API Key Status — FMP: ${fmpOk ? '✓ configured' : '✗ MISSING'}, Twelve Data: ${tdOk ? '✓ configured' : '✗ MISSING'}`);
    if (!fmpOk && !tdOk) {
        console.error('[Benchmark] ⚠ NO API KEYS CONFIGURED — benchmarks will use static fallback only (SPY). Configure FMP_API_KEY and/or TWELVE_DATA_API_KEY in env-config.js or build process.');
    } else if (!fmpOk) {
        console.warn('[Benchmark] FMP key missing — all benchmarks depend on Twelve Data (8 req/min rate limit). Some benchmarks may fail.');
    }
}

async function fetchBenchmarkData(symbol, range) {
    _logBenchmarkDiag();
    const cacheKey = `${symbol}_${range}`;
    const isIntraday = (range === '1d' || range === '5d');

    // Intraday benchmark data is time-sensitive — 5 min cache only.
    // Daily data can use the full 24h TTL.
    const effectiveTTL = isIntraday ? INTRADAY_CACHE_TTL : BENCHMARK_CACHE_TTL;

    // Check memory cache
    if (_benchmarkCache[cacheKey] && (Date.now() - _benchmarkCache[cacheKey].timestamp < effectiveTTL)) {
        return _benchmarkCache[cacheKey].data;
    }

    // Check localStorage cache — only use if data is valid (non-empty array)
    try {
        const stored = localStorage.getItem('benchmark_' + cacheKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Date.now() - parsed.timestamp < effectiveTTL && Array.isArray(parsed.data) && parsed.data.length > 0) {
                _benchmarkCache[cacheKey] = parsed;
                return parsed.data;
            } else {
                localStorage.removeItem('benchmark_' + cacheKey);
            }
        }
    } catch (e) { /* ignore */ }

    console.log(`[Benchmark] Fetching ${symbol} (range=${range}) — no cache, calling APIs...`);

    // ── Strategy: FMP FIRST (more reliable for US ETFs, no strict rate limit),
    //    then Twelve Data as fallback (rate-limited to 8 req/min on free plan).
    //    This order prevents the "only SPY works" bug caused by Twelve Data rate limits
    //    exhausting the quota on the first benchmark, leaving the rest dead.

    const fmpData = await _fetchFMPBenchmark(symbol, range);
    if (fmpData && fmpData.length > 0) {
        console.log(`[Benchmark] FMP success for ${symbol}: ${fmpData.length} points`);
        const cacheEntry = { data: fmpData, timestamp: Date.now() };
        _benchmarkCache[cacheKey] = cacheEntry;
        try { localStorage.setItem('benchmark_' + cacheKey, JSON.stringify(cacheEntry)); } catch (e) { /* quota */ }
        return fmpData;
    }
    console.warn(`[Benchmark] FMP failed for ${symbol} — trying Twelve Data...`);

    const data = await _fetchTwelveDataBenchmark(symbol, range);
    if (data && data.length > 0) {
        console.log(`[Benchmark] Twelve Data success for ${symbol}: ${data.length} points`);
        const cacheEntry = { data, timestamp: Date.now() };
        _benchmarkCache[cacheKey] = cacheEntry;
        try { localStorage.setItem('benchmark_' + cacheKey, JSON.stringify(cacheEntry)); } catch (e) { /* quota */ }
        return data;
    }

    // Static fallback for S&P 500: if all APIs fail, use approximate historical data
    if (symbol === 'SPY') {
        const staticData = _getStaticSPYFallback(range);
        if (staticData && staticData.length > 0) {
            console.log(`[Benchmark] Using static S&P 500 fallback (range=${range})`);
            const cacheEntry = { data: staticData, timestamp: Date.now() };
            _benchmarkCache[cacheKey] = cacheEntry;
            return staticData;
        }
    }

    console.error(`[Benchmark] ALL APIs FAILED for ${symbol} (range=${range}). Check: 1) API keys configured? 2) Rate limits exceeded? 3) Symbol valid?`);
    return null;
}

// Twelve Data sometimes needs the INDEX symbol instead of the ETF ticker.
// Try the ETF first, then the index alias. Twelve Data uses symbols WITHOUT ^ prefix.
const _TWELVE_DATA_ALIASES = {
    'SPY': ['SPY', 'GSPC'],   // S&P 500 ETF → ^GSPC index (without ^)
    'QQQ': ['QQQ', 'IXIC'],   // Nasdaq 100 ETF → ^IXIC (Nasdaq Composite)
    'DIA': ['DIA', 'DJI'],    // Dow Jones ETF → ^DJI index
    'IWM': ['IWM', 'RUT']     // Russell 2000 ETF → ^RUT index
};

// ── Twelve Data Rate-Limit Queue ──
// Free plan: 8 requests/minute. When multiple benchmarks are fetched in parallel
// (via Promise.allSettled), they ALL fall to Twelve Data simultaneously if FMP fails,
// exhausting the rate limit. Only the first benchmark succeeds — the rest get 429.
// Solution: serialize Twelve Data calls with a minimum interval between them.
let _lastTwelveDataCallTime = 0;
const _TWELVE_DATA_MIN_INTERVAL_MS = 850; // ~7 req/min — comfortably under the 8/min limit
let _twelveDataQueue = Promise.resolve(); // serialization chain

function _twelveDataSerialized(fn) {
    // Chain onto the queue — each call waits for the previous to finish + rate delay
    _twelveDataQueue = _twelveDataQueue.then(async () => {
        const elapsed = Date.now() - _lastTwelveDataCallTime;
        if (elapsed < _TWELVE_DATA_MIN_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, _TWELVE_DATA_MIN_INTERVAL_MS - elapsed));
        }
        _lastTwelveDataCallTime = Date.now();
        return fn();
    }).catch(() => null); // prevent queue breakage
    return _twelveDataQueue;
}

async function _fetchTwelveDataBenchmark(symbol, range) {
    if (!TWELVE_DATA_API_KEY || TWELVE_DATA_API_KEY === 'YOUR_TWELVE_DATA_API_KEY') return null;

    const interval = _rangeToInterval(range);
    const outputSize = _rangeToOutputSize(range);

    // Try ETF ticker first, then index alias if available
    const symbolsToTry = _TWELVE_DATA_ALIASES[symbol] || [symbol];

    for (const sym of symbolsToTry) {
        try {
            // Serialize through rate-limit queue — prevents parallel calls from
            // exhausting the 8 req/min limit when multiple benchmarks fall to Twelve Data.
            const result = await _twelveDataSerialized(async () => {
                const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${interval}&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`;
                const res = await fetch(url);
                if (!res.ok || res.status === 429) {
                    console.warn(`[Benchmark] Twelve Data ${res.status} for ${sym} (alias of ${symbol})`);
                    return { skip: true };
                }
                return res.json();
            });

            if (!result || result.skip) continue;
            const json = result;

            // Handle JSON-body rate limit (Twelve Data returns 200 with error in body)
            if (json.code === 429 || (json.status === 'error' && json.message && json.message.includes('limit'))) {
                console.warn(`[Benchmark] Twelve Data rate-limited for ${sym}: ${json.message}`);
                return null; // Rate-limited — don't retry alias, it will also fail
            }

            if (json.status === 'error' || !json.values || json.values.length === 0) {
                console.warn(`[Benchmark] Twelve Data no data for ${sym}:`, json.message || 'empty');
                continue; // Try next alias
            }

            // Twelve Data returns newest first — reverse to chronological order
            let values = json.values.reverse();

            // For 1D: filter to only the last trading day's data
            if (range === '1d' && values.length > 0) {
                const lastDateStr = values[values.length - 1].datetime.split(' ')[0];
                const dayOnly = values.filter(v => v.datetime.startsWith(lastDateStr));
                if (dayOnly.length >= 2) values = dayOnly;
            }

            const firstClose = parseFloat(values[0].close);

            console.log(`[Benchmark] Twelve Data success for ${symbol} (via ${sym}): ${values.length} points, interval=${interval}`);
            return values.map(v => ({
                // Keep full datetime for intraday intervals (1h/5min) so chart X-axis works
                date: (interval === '1h' || interval === '5min') ? v.datetime : v.datetime.split(' ')[0],
                close: parseFloat(v.close),
                returnPct: ((parseFloat(v.close) - firstClose) / firstClose) * 100
            }));
        } catch (e) {
            console.warn(`[Benchmark] Twelve Data fetch error for ${sym}:`, e.message);
        }
    }
    return null;
}

// FMP symbol aliases: if the primary ETF ticker fails, try the index symbol.
// FMP supports both ETF tickers and index symbols for major US indices.
const _FMP_SYMBOL_ALIASES = {
    'SPY': ['SPY', '%5EGSPC'],       // S&P 500 ETF → ^GSPC index
    'QQQ': ['QQQ', '%5ENDX'],        // Nasdaq 100 ETF → ^NDX index
    'DIA': ['DIA', '%5EDJI'],        // Dow Jones ETF → ^DJI index
    'IWM': ['IWM', '%5ERUT']         // Russell 2000 ETF → ^RUT index
};

async function _fetchFMPBenchmark(symbol, range) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') {
        console.warn(`[Benchmark] FMP API key not configured — skipping ${symbol}`);
        return null;
    }

    // FMP doesn't support Israeli indices (.TA suffix) — skip immediately
    if (symbol.includes('.TA')) {
        console.log(`[Benchmark] FMP skipping Israeli index ${symbol}`);
        return null;
    }

    const isIntraday = (range === '1d' || range === '5d');
    const symbolsToTry = _FMP_SYMBOL_ALIASES[symbol] || [symbol];

    // ── Intraday: use FMP historical-chart endpoint (5min / 1hour candles) ──
    // Try both /api/v3/ and /stable/ — free plans may only support one.
    if (isIntraday) {
        const fmpInterval = (range === '1d') ? '5min' : '1hour';
        for (const sym of symbolsToTry) {
            const intradayUrls = [
                `https://financialmodelingprep.com/api/v3/historical-chart/${fmpInterval}/${sym}?apikey=${FMP_API_KEY}`,
                `https://financialmodelingprep.com/stable/historical-chart/${fmpInterval}/${sym}?apikey=${FMP_API_KEY}`
            ];
            for (const url of intradayUrls) {
                try {
                    const res = await fetch(url);
                    if (!res.ok) {
                        console.warn(`[Benchmark] FMP intraday ${res.status} for ${sym} at ${url.split('?')[0]}`);
                        continue;
                    }
                    const json = await res.json();
                    if (!Array.isArray(json) || json.length === 0) continue;

                    // FMP returns newest-first — take relevant slice and reverse
                    const limit = (range === '1d') ? 200 : 50;
                    const sliced = json.length > limit ? json.slice(0, limit) : json;
                    const reversed = sliced.reverse();

                    // For 1D: filter to only the last trading day
                    let points = reversed;
                    if (range === '1d' && reversed.length > 0) {
                        const lastDate = reversed[reversed.length - 1].date.split(' ')[0];
                        const dayOnly = reversed.filter(p => p.date.startsWith(lastDate));
                        if (dayOnly.length >= 2) points = dayOnly;
                    }

                    const firstClose = points[0].close;
                    if (firstClose > 0) {
                        console.log(`[Benchmark] FMP intraday success for ${symbol} (via ${sym}): ${points.length} ${fmpInterval} points`);
                        return points.map(p => ({
                            date: p.date,  // Full datetime string e.g. "2026-03-19 10:30:00"
                            close: p.close,
                            returnPct: ((p.close - firstClose) / firstClose) * 100
                        }));
                    }
                } catch (e) {
                    console.warn(`[Benchmark] FMP intraday error for ${sym}:`, e.message);
                }
            }
        }
        // Fall through to daily if intraday fails for all aliases
    }

    // ── Daily: historical-price-full (for ranges > 5D) ──
    const outputSize = _rangeToOutputSize(range);

    // Try each symbol alias against both FMP endpoints (/api/v3/ first — wider coverage)
    for (const sym of symbolsToTry) {
        const urls = [
            `https://financialmodelingprep.com/api/v3/historical-price-full/${sym}?apikey=${FMP_API_KEY}`,
            `https://financialmodelingprep.com/stable/historical-price-full/${sym}?apikey=${FMP_API_KEY}`
        ];

        for (const url of urls) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    console.warn(`[Benchmark] FMP ${res.status} for ${sym} at ${url.split('?')[0]}`);
                    continue;
                }
                const json = await res.json();
                const hist = json.historical || (Array.isArray(json) ? json : null);
                if (!hist || hist.length === 0) continue;

                // FMP returns newest-first — take outputSize, then reverse to chronological
                const sliced = hist.length > outputSize ? hist.slice(0, outputSize) : hist;
                const reversed = sliced.reverse();
                const firstClose = reversed[0].close;

                console.log(`[Benchmark] FMP daily success for ${symbol} (via ${sym}): ${reversed.length} points`);
                return reversed.map(p => ({
                    date: p.date,
                    close: p.close,
                    returnPct: ((p.close - firstClose) / firstClose) * 100
                }));
            } catch (e) {
                console.warn(`[Benchmark] FMP fetch error for ${sym}:`, e.message);
            }
        }
    }
    return null;
}

// ========== STATIC S&P 500 FALLBACK ==========
// Approximate monthly S&P 500 close prices (SPY ETF) for the last ~2 years.
// Used only when ALL live APIs fail — ensures the user sees a benchmark line.
// Source: approximate SPY monthly closes, rounded.

const _STATIC_SPY_MONTHLY = [
    { date: '2024-03-28', close: 524 }, { date: '2024-04-30', close: 501 },
    { date: '2024-05-31', close: 528 }, { date: '2024-06-28', close: 545 },
    { date: '2024-07-31', close: 547 }, { date: '2024-08-30', close: 564 },
    { date: '2024-09-30', close: 572 }, { date: '2024-10-31', close: 570 },
    { date: '2024-11-29', close: 602 }, { date: '2024-12-31', close: 590 },
    { date: '2025-01-31', close: 603 }, { date: '2025-02-28', close: 596 },
    { date: '2025-03-31', close: 570 }, { date: '2025-04-30', close: 556 },
    { date: '2025-05-30', close: 589 }, { date: '2025-06-30', close: 603 },
    { date: '2025-07-31', close: 610 }, { date: '2025-08-29', close: 598 },
    { date: '2025-09-30', close: 582 }, { date: '2025-10-31', close: 595 },
    { date: '2025-11-28', close: 608 }, { date: '2025-12-31', close: 600 },
    { date: '2026-01-30', close: 612 }, { date: '2026-02-27', close: 605 },
    { date: '2026-03-17', close: 598 }
];

function _getStaticSPYFallback(range) {
    const days = _rangeToDays(range);
    const cutoff = new Date(Date.now() - days * 86400000);

    const filtered = _STATIC_SPY_MONTHLY.filter(p => new Date(p.date) >= cutoff);
    if (filtered.length < 2) return null;

    const firstClose = filtered[0].close;
    return filtered.map(p => ({
        date: p.date,
        close: p.close,
        returnPct: ((p.close - firstClose) / firstClose) * 100
    }));
}

// ========== MASTER TIMELINE ALIGNMENT ==========
// Maps benchmark data to the portfolio's exact timestamps using forward-fill.
// If a benchmark has no price for a given portfolio date, the previous available
// close is used ("hold last known price"). This guarantees:
//   1. Benchmark and portfolio share identical X coordinates (no stray dots)
//   2. No missing points create visual gaps
//   3. All lines start at the same timestamp (perfect normalization anchor)

function _alignBenchmarkToTimeline(benchData, portfolioPoints) {
    if (!benchData || benchData.length === 0 || !portfolioPoints || portfolioPoints.length === 0) return [];

    // Pre-convert benchmark dates to timestamps for binary-style search
    const benchTimestamps = benchData.map(b => new Date(b.date).getTime());
    const aligned = [];
    let benchIdx = 0;

    for (const pp of portfolioPoints) {
        const t = pp.x;

        // Advance benchmark pointer to the last point <= portfolio timestamp
        while (benchIdx < benchTimestamps.length - 1 && benchTimestamps[benchIdx + 1] <= t) {
            benchIdx++;
        }

        // Forward-fill: use the most recent benchmark close at or before this timestamp
        aligned.push({ x: t, close: benchData[benchIdx].close });
    }

    return aligned;
}

// ========== UNIFIED PERFORMANCE CHART RENDERER ==========

// Parse a he-IL date string (DD.MM.YYYY) into a Date object
// Also handles ISO dates (YYYY-MM-DD) as passthrough
function _parseHistDate(dateStr) {
    if (!dateStr) return new Date();
    // ISO format: YYYY-MM-DD
    if (dateStr.includes('-') && dateStr.length >= 10) return new Date(dateStr);
    // he-IL format: DD.MM.YYYY
    const parts = dateStr.split('.');
    if (parts.length === 3) {
        return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    }
    return new Date(dateStr);
}

// ========== INTRADAY DATA (1D/5D views) ==========
// Fetches intraday time_series for the portfolio's top holdings using FMP (primary)
// or Twelve Data (fallback), then computes weighted portfolio return at each timestamp.

const _intradayCache = {}; // key: "clientId_range" → { data, timestamp }
const INTRADAY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch a single ticker's intraday data — FMP primary, Twelve Data fallback
async function _fetchTickerIntraday(ticker, currency, interval, outputSize) {
    const sym = (currency === 'ILS') ? `${ticker}:TASE` : ticker;

    // ── Primary: FMP historical-chart (5min/1hour) ──
    // Try both /api/v3/ and /stable/ — free plans may only support one.
    if (FMP_API_KEY && FMP_API_KEY !== 'YOUR_FMP_API_KEY') {
        const fmpInterval = interval === '5min' ? '5min' : '1hour';
        const fmpUrls = [
            `https://financialmodelingprep.com/api/v3/historical-chart/${fmpInterval}/${ticker}?apikey=${FMP_API_KEY}`,
            `https://financialmodelingprep.com/stable/historical-chart/${fmpInterval}/${ticker}?apikey=${FMP_API_KEY}`
        ];
        for (const url of fmpUrls) {
            try {
                const res = await fetch(url);
                if (!res.ok) continue;
                const json = await res.json();
                if (Array.isArray(json) && json.length > 0) {
                    // FMP returns newest-first — reverse and take last outputSize
                    const sliced = json.length > outputSize ? json.slice(0, outputSize) : json;
                    const reversed = sliced.reverse();
                    return reversed.map(p => ({
                        datetime: p.date,
                        close: p.close
                    }));
                }
            } catch (e) {
                console.warn(`[Intraday] FMP failed for ${ticker} at ${url.split('?')[0]}:`, e.message);
            }
        }
    }

    // ── Fallback: Twelve Data time_series (serialized to respect rate limit) ──
    if (TWELVE_DATA_API_KEY && TWELVE_DATA_API_KEY !== 'YOUR_TWELVE_DATA_API_KEY') {
        try {
            const json = await _twelveDataSerialized(async () => {
                const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${interval}&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`;
                const res = await fetch(url);
                if (!res.ok) return null;
                return res.json();
            });
            if (json) {
                if (json.code === 429 || (json.status === 'error' && json.message && json.message.includes('limit'))) {
                    console.warn(`[Intraday] Twelve Data rate-limited for ${ticker}`);
                    return null;
                }
                if (json.values && json.values.length > 0) {
                    return json.values.reverse().map(v => ({
                        datetime: v.datetime,
                        close: parseFloat(v.close)
                    }));
                }
            }
        } catch (e) {
            console.warn(`[Intraday] Twelve Data failed for ${ticker}:`, e.message);
        }
    }

    return null;
}

async function _fetchIntradayPortfolioData(client, range) {
    const cacheKey = `${client.id}_${range}`;
    if (_intradayCache[cacheKey] && (Date.now() - _intradayCache[cacheKey].timestamp < INTRADAY_CACHE_TTL)) {
        return _intradayCache[cacheKey].data;
    }

    // Get stock holdings with known prices
    const stocks = client.holdings.filter(h => h.type === 'stock' && h.shares > 0 && h.ticker);
    if (stocks.length === 0) {
        console.warn(`[Intraday] No stock holdings for ${client.name}`);
        return null;
    }

    // Top 5 holdings by value — enough for weighted representation
    const topStocks = [...stocks].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 5);
    const totalPortfolioValue = client.portfolioValue || 1;

    // 1D: 5min candles — request 200 points (covers ~2.5 trading days) to handle
    //     weekends/holidays where today has no data yet.
    // 5D: 1h candles — request 50 points (covers ~7 days including weekends).
    const interval = (range === '1d') ? '5min' : '1h';
    const outputSize = (range === '1d') ? 200 : 50;

    console.log(`[Intraday] Fetching ${interval} data for ${topStocks.map(h => h.ticker).join(', ')} (outputSize=${outputSize})`);

    // Fetch all top holdings in parallel
    const fetchResults = await Promise.allSettled(
        topStocks.map(h => _fetchTickerIntraday(h.ticker, h.currency, interval, outputSize))
    );

    const series = [];
    for (let i = 0; i < fetchResults.length; i++) {
        const r = fetchResults[i];
        if (r.status === 'fulfilled' && r.value && r.value.length >= 2) {
            series.push({
                ticker: topStocks[i].ticker,
                weight: (topStocks[i].value || 0) / totalPortfolioValue,
                values: r.value
            });
        } else {
            console.warn(`[Intraday] No data for ${topStocks[i].ticker}: ${r.status === 'rejected' ? r.reason : 'empty'}`);
        }
    }

    if (series.length === 0) {
        console.warn(`[Intraday] No data for any holding (${range})`);
        return null;
    }

    // Use the longest series as the time backbone
    let backbone = series[0];
    for (const s of series) {
        if (s.values.length > backbone.values.length) backbone = s;
    }

    // For 1D: filter to only the most recent trading day's data
    // This handles weekends/after-hours: we have ~200 points spanning 2-3 days,
    // extract only the latest calendar day that has data
    let filteredBackbone = backbone.values;
    let filteredSeries = series;

    if (range === '1d' && backbone.values.length > 0) {
        // Find the most recent trading date in the data
        const lastDatetime = new Date(backbone.values[backbone.values.length - 1].datetime);
        const lastDateStr = lastDatetime.toISOString().split('T')[0]; // YYYY-MM-DD

        // Filter each series to only include points from the last trading day
        filteredSeries = series.map(s => {
            const dayValues = s.values.filter(v => {
                const vDate = new Date(v.datetime).toISOString().split('T')[0];
                return vDate === lastDateStr;
            });
            return { ...s, values: dayValues.length >= 2 ? dayValues : s.values };
        });

        // Update backbone to the filtered version
        let longestFiltered = filteredSeries[0];
        for (const s of filteredSeries) {
            if (s.values.length > longestFiltered.values.length) longestFiltered = s;
        }
        filteredBackbone = longestFiltered.values;

        console.log(`[Intraday] 1D filter: ${backbone.values.length} raw points → ${filteredBackbone.length} points for ${lastDateStr}`);
    }

    const points = filteredBackbone.map((v, i) => {
        const date = new Date(v.datetime);

        // Weighted return from each holding at this time point
        let weightedReturn = 0;
        for (const s of filteredSeries) {
            if (s.values[i]) {
                const firstClose = s.values[0].close;
                const thisClose = s.values[i].close;
                if (firstClose > 0) {
                    weightedReturn += ((thisClose - firstClose) / firstClose) * 100 * s.weight;
                }
            }
        }

        const portfolioValueAtPoint = totalPortfolioValue * (1 + weightedReturn / 100);

        return {
            date: date.toLocaleDateString('he-IL'),
            _dateObj: date,
            value: parseFloat(portfolioValueAtPoint.toFixed(2)),
            returnPct: parseFloat(weightedReturn.toFixed(2))
        };
    });

    if (points.length >= 2) {
        _intradayCache[cacheKey] = { data: points, timestamp: Date.now() };
        console.log(`[Intraday] Built ${points.length}-point ${range} data for ${client.name}`);
    }
    return points.length >= 2 ? points : null;
}

// ========== Y-AXIS AUTO-SCALE ==========
// Recalculates Y min/max based on currently visible X range.
// Called by manual button only — NOT on every zoom/pan (prevents snap-back).
function _autoScaleY(chart) {
    const xScale = chart.scales.x;
    const xMin = xScale.min;
    const xMax = xScale.max;

    let yMin = Infinity, yMax = -Infinity;
    for (const ds of chart.data.datasets) {
        for (const pt of ds.data) {
            if (pt.x >= xMin && pt.x <= xMax) {
                if (pt.y < yMin) yMin = pt.y;
                if (pt.y > yMax) yMax = pt.y;
            }
        }
    }

    if (yMin === Infinity || yMax === -Infinity) return;

    const yRange = yMax - yMin || 1;
    chart.options.scales.y.min = yMin - yRange * 0.1;
    chart.options.scales.y.max = yMax + yRange * 0.1;
    chart.update('none');
}

// ========== TRADINGVIEW-STYLE Y-AXIS DRAG PLUGIN ==========
// Architecture:
//   1. _manualYScale{} — persistent state keyed by canvas ID, survives chart.update()
//   2. beforeUpdate hook — re-applies manual min/max on EVERY update cycle so the
//      Chart.js layout engine can never override our values
//   3. Chart.getChart(canvas) — always references the CURRENT chart instance, not a
//      stale closure. Prevents the "listeners bound to destroyed chart" bug.
//   4. Listener cleanup — old handlers removed before new ones added on re-creation.

const _manualYScale = {};  // { canvasId: { active, min, max } }

const _yAxisDragPlugin = {
    id: 'yAxisDrag',

    beforeInit(chart) {
        chart._yDrag = { active: false, startY: 0, startMin: 0, startMax: 0 };
    },

    // CRITICAL: Re-apply manual scale on EVERY update cycle.
    // Without this, Chart.js's layout engine recalculates the Y domain from data+grace,
    // overriding our explicit min/max and causing the "snap-back" glitch.
    beforeUpdate(chart) {
        const canvasId = chart.canvas?.id;
        if (!canvasId) return;
        const manual = _manualYScale[canvasId];
        if (manual && manual.active) {
            chart.options.scales.y.min = manual.min;
            chart.options.scales.y.max = manual.max;
            chart.options.scales.y.grace = 0;
        }
    },

    afterInit(chart) {
        const canvas = chart.canvas;
        if (!canvas) return;

        // Tear down old handlers if chart was re-created on the same canvas
        if (canvas._yDragCleanup) {
            canvas._yDragCleanup();
        }

        // Always resolve the CURRENT chart — never use the closure's `chart` for state
        function _getChart() {
            try { return Chart.getChart(canvas); } catch (e) { return null; }
        }

        function _isInYAxis(e) {
            const c = _getChart();
            if (!c) return false;
            const yScale = c.scales.y;
            if (!yScale) return false;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            return x >= yScale.left && x <= rect.width;
        }

        // ── Mousedown: capture initial Y-axis range ──
        function _onMouseDown(e) {
            if (!_isInYAxis(e)) return;
            const c = _getChart();
            if (!c) return;
            const yScale = c.scales.y;
            if (!yScale) return;

            c._yDrag = c._yDrag || {};
            c._yDrag.active = true;
            c._yDrag.startY = e.clientY;
            c._yDrag.startMin = yScale.min;
            c._yDrag.startMax = yScale.max;
            canvas.style.cursor = 'ns-resize';
            e.preventDefault();
            e.stopPropagation();
        }

        // ── Mousemove: compute new Y range from INITIAL mousedown values ──
        function _onMouseMove(e) {
            const c = _getChart();
            if (!c || !c._yDrag) return;

            // Cursor feedback when hovering Y-axis area
            if (_isInYAxis(e) && !c._yDrag.active) {
                canvas.style.cursor = 'ns-resize';
            } else if (!c._yDrag.active) {
                canvas.style.cursor = '';
            }

            if (!c._yDrag.active) return;

            const dy = e.clientY - c._yDrag.startY;
            const yScale = c.scales.y;
            const chartHeight = yScale.bottom - yScale.top;
            if (chartHeight <= 0) return;

            // Scale factor: drag up → zoom out (expand range), drag down → zoom in
            const sensitivity = 2.0;
            const scaleFactor = 1 + (dy / chartHeight) * sensitivity;
            if (scaleFactor <= 0.05 || scaleFactor > 20) return;

            // IMPORTANT: Always compute from the INITIAL mousedown range, not the
            // current (moving) one. This prevents compounding drift.
            const origRange = c._yDrag.startMax - c._yDrag.startMin;
            const origMid = (c._yDrag.startMax + c._yDrag.startMin) / 2;
            const newRange = origRange * scaleFactor;
            const newMin = origMid - newRange / 2;
            const newMax = origMid + newRange / 2;

            // Persist in global state — beforeUpdate hook will re-apply on every cycle
            if (canvas.id) {
                _manualYScale[canvas.id] = { active: true, min: newMin, max: newMax };
            }

            c.options.scales.y.grace = 0;
            c.options.scales.y.min = newMin;
            c.options.scales.y.max = newMax;
            c.stop();            // Kill running animations that fight the drag
            c.update('none');    // Instant, animation-free redraw

            e.preventDefault();
            e.stopPropagation();
        }

        // ── Mouseup / mouseleave: end drag ──
        function _onMouseUp() {
            const c = _getChart();
            if (c && c._yDrag && c._yDrag.active) {
                c._yDrag.active = false;
                canvas.style.cursor = '';
            }
        }

        // ── Double-click: reset to auto-scale ──
        function _onDblClick(e) {
            if (!_isInYAxis(e)) return;
            const c = _getChart();
            if (!c) return;

            // Clear persistent manual scale
            if (canvas.id) delete _manualYScale[canvas.id];

            delete c.options.scales.y.min;
            delete c.options.scales.y.max;
            c.options.scales.y.grace = '10%';
            c.stop();
            c.update();
            e.preventDefault();
            e.stopPropagation();
        }

        canvas.addEventListener('mousedown', _onMouseDown);
        canvas.addEventListener('mousemove', _onMouseMove);
        canvas.addEventListener('mouseup', _onMouseUp);
        canvas.addEventListener('mouseleave', _onMouseUp);
        canvas.addEventListener('dblclick', _onDblClick);

        // Store cleanup function — called when chart is re-created on the same canvas
        canvas._yDragCleanup = function () {
            canvas.removeEventListener('mousedown', _onMouseDown);
            canvas.removeEventListener('mousemove', _onMouseMove);
            canvas.removeEventListener('mouseup', _onMouseUp);
            canvas.removeEventListener('mouseleave', _onMouseUp);
            canvas.removeEventListener('dblclick', _onDblClick);
        };
    },

    // Clear manual scale when chart is destroyed — fresh auto-scale for next instance
    beforeDestroy(chart) {
        const canvasId = chart.canvas?.id;
        if (canvasId) delete _manualYScale[canvasId];
    }
};

// ========== MAIN PERFORMANCE CHART RENDERER ==========
// Production-ready financial chart: real Supabase data mapped to {x: timestamp, y: value}.
// Data-fitted visible range, 20-year zoom limits, grace-based containment, dynamic granularity.

async function renderPerformanceChart(canvasId, clientId, range, benchmarks, chartKey) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return null;

    // ── 1. Canvas & loading overlay ──
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const container = canvas.parentElement;
    _showChartLoading(container);

    // ── 2. Acquire data: real history → synthetic fallback ──
    let hist = null;
    let isSynthetic = false;
    const isIntraday = (range === '1d' || range === '5d');

    // 2a. Intraday: live hourly data from Twelve Data
    if (isIntraday) {
        hist = await _fetchIntradayPortfolioData(client, range);
    }

    // 2b. Longer ranges: Supabase performance_history (recorded daily snapshots)
    if (!hist) {
        // If history is empty, try to seed an initial snapshot
        if (!client.performanceHistory || client.performanceHistory.length === 0) {
            if (typeof supabaseConnected !== 'undefined' && supabaseConnected && client.portfolioValue > 0) {
                await supaRecordPerformanceSnapshot(client.id);
                const updated = await supaFetchClient(client.id);
                if (updated && updated.performanceHistory) {
                    client.performanceHistory = updated.performanceHistory;
                    const idx = clients.findIndex(c => c.id === clientId);
                    if (idx !== -1) clients[idx].performanceHistory = updated.performanceHistory;
                }
            }
        }
        hist = filterHistoryByRange(client.performanceHistory || [], range);
    }

    // 2c. Synthetic fallback: if real history is insufficient for the selected range,
    //     reconstruct historical performance from daily closing prices.
    //     This enables meaningful charts for new/recent portfolios.
    //
    //     Threshold: real history must have enough points relative to the range.
    //     A portfolio created 3 days ago shouldn't show a 3-point "1Y" chart —
    //     synthetic history with ~250 points is far more useful.
    //
    //     For 1D/5D: intraday APIs are the primary source. If they fail, we accept
    //     even 2 performance_history points (better than "No Data"). Synthetic daily
    //     history is also attempted as a last resort for 5D.
    const _minPointsForRange = { '1d': 2, '5d': 3, '1m': 10, '3m': 25, '6m': 50, 'ytd': 30, '1y': 60, '5y': 200, 'max': 60, 'all': 10 };
    const minPoints = _minPointsForRange[range] || 10;
    const histTooSparse = !hist || hist.length < minPoints;

    // Synthetic fallback: available for all ranges except 1D (too granular for daily data).
    // 5D can use synthetic daily data as a meaningful fallback.
    if (histTooSparse && range !== '1d') {
        const hasEligibleHoldings = client.holdings && client.holdings.some(
            h => (h.type === 'stock' || h.type === 'fund') && h.shares > 0
        );
        if (hasEligibleHoldings && typeof fetchSyntheticHistory === 'function') {
            const synth = await fetchSyntheticHistory(client, range);
            if (synth && synth.length >= 2) {
                hist = synth;
                isSynthetic = true;
                console.log(`[PerfChart] Using synthetic history for ${client.name} (${synth.length} points, range=${range})`);
            }
        }
    }

    // ── 3. Empty/insufficient data → "No Data" overlay, abort ──
    _hideChartLoading(container);

    if (!hist || hist.length < 2) {
        _showNoChartData(canvas, container, isIntraday);
        return null;
    }

    // ── 4. Destroy any previous Chart.js instance on this canvas (prevent memory leaks) ──
    if (chartKey) _safeDestroyChart(chartKey);
    _destroyChartOnCanvas(canvas);
    _clearCanvas(canvas);

    canvas.style.display = '';
    const staleMsg = container?.querySelector('.no-chart-data');
    if (staleMsg) staleMsg.remove();

    // ── 5. Pre-fetch ALL benchmark data in parallel ──
    // Parallel fetch prevents sequential rate-limit stacking — if one API is slow
    // the others don't wait. All benchmarks resolve together.
    const benchmarkResults = [];
    if (benchmarks && benchmarks.length > 0) {
        console.log(`[PerfChart] Fetching ${benchmarks.length} benchmarks: ${benchmarks.join(', ')} (range=${range})`);
        const benchPromises = benchmarks.map(symbol =>
            fetchBenchmarkData(symbol, range).then(data => ({ symbol, data }))
        );
        const settled = await Promise.allSettled(benchPromises);
        for (const r of settled) {
            if (r.status === 'fulfilled' && r.value.data && r.value.data.length > 0) {
                benchmarkResults.push(r.value);
            } else {
                const sym = r.status === 'fulfilled' ? r.value.symbol : 'unknown';
                const reason = r.status === 'rejected' ? r.reason : 'empty data';
                console.warn(`[PerfChart] Benchmark ${sym} excluded: ${reason}`);
            }
        }
        console.log(`[PerfChart] ${benchmarkResults.length}/${benchmarks.length} benchmarks loaded successfully`);
    }

    // ── 6. Determine display mode ──
    // Two modes:
    //   Percentage (%): Y = cumulative return from day 0 — DEFAULT.
    //                   Both portfolio and benchmarks normalized to the same 0% origin.
    //   Absolute ($): Y = portfolio value. Activated by user toggle.
    //
    // The global _chartDisplayMode ('percent' | 'value') is controlled by the UI toggle.
    // When benchmarks are active, % mode is forced (comparison requires same scale).
    const hasBenchmarks = benchmarkResults.length > 0;
    const usePercentMode = hasBenchmarks || _chartDisplayMode === 'percent';

    // ── 7. Map history → Chart.js points ──
    //
    // NORMALIZATION (% mode):
    //   returnPct = ((Vᵢ − V₀) / V₀) × 100
    //
    //   CRITICAL: Always compute from the first VISIBLE data point's VALUE,
    //   never from the stored returnPct. The stored returnPct in Supabase snapshots
    //   is relative to initialInvestment — a different baseline than the first
    //   visible point. Using it would make the portfolio start at +15% while
    //   the benchmark starts at 0%, destroying the apples-to-apples comparison.
    const firstValue = hist[0].value || 1; // Denominator for normalization

    const portfolioPoints = hist.map(p => {
        const x = (p._dateObj || _parseHistDate(p.date)).getTime();
        if (usePercentMode) {
            // Always compute from values — never use stored returnPct for comparisons
            const returnPct = firstValue > 0
                ? ((p.value - firstValue) / firstValue) * 100
                : 0;
            return { x, y: returnPct };
        }
        return { x, y: p.value };
    });

    const firstVal = usePercentMode ? 0 : (portfolioPoints[0].y || 1);
    const lastVal = portfolioPoints[portfolioPoints.length - 1].y || 0;
    const isPositive = lastVal >= firstVal;
    const mainColor = isPositive ? COLORS.profit : COLORS.loss;
    const fillColor = isPositive ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)';

    // ── 8. Build datasets ──
    const datasets = [{
        label: isSynthetic ? 'תשואה משוחזרת' : (usePercentMode ? 'תשואת תיק' : 'שווי תיק'),
        data: portfolioPoints,
        borderColor: mainColor,
        backgroundColor: fillColor,
        borderWidth: 3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: mainColor,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        tension: 0.3,
        clip: true
    }];

    // Benchmark datasets — MASTER TIMELINE ALIGNMENT.
    //
    // Every benchmark is mapped onto the portfolio's exact timestamps using
    // forward-fill interpolation (_alignBenchmarkToTimeline). This guarantees:
    //   1. All lines share identical X coordinates — no stray dots or gaps
    //   2. The benchmark's first Y value is the price at the portfolio's first date
    //   3. Normalization to 0% uses that first aligned price as the base
    //
    // Formula: benchmarkReturn = ((close - baseClose) / baseClose) * 100

    for (const { symbol, data: benchData } of benchmarkResults) {
        // Align to portfolio timeline — forward-fill missing dates
        const aligned = _alignBenchmarkToTimeline(benchData, portfolioPoints);
        if (aligned.length < 2) continue;

        // Base price = benchmark close at portfolio's first visible date
        const benchBaseClose = aligned[0].close;
        if (!benchBaseClose || benchBaseClose <= 0) continue;

        datasets.push({
            label: BENCHMARK_SYMBOLS[symbol] || symbol,
            data: aligned.map(p => {
                const pctFromBase = ((p.close - benchBaseClose) / benchBaseClose) * 100;
                return {
                    x: p.x,
                    y: usePercentMode
                        ? pctFromBase
                        : firstValue * (1 + pctFromBase / 100)
                };
            }),
            borderColor: BENCHMARK_COLORS[symbol] || '#94a3b8',
            borderWidth: 2,
            borderDash: [6, 3],
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.3,
            clip: true
        });
    }

    // ── 9. Timeline configuration ──
    const now = new Date();
    const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

    // Zoom limits: user can scroll/zoom across a full 20-year window
    const zoomMin = now.getTime() - TEN_YEARS_MS;
    const zoomMax = now.getTime() + TEN_YEARS_MS;

    // Visible axis: fit to actual data (NOT the full 20 years — that would compress data to a sliver)
    const dataMinTime = portfolioPoints[0].x;
    const dataMaxTime = portfolioPoints[portfolioPoints.length - 1].x;

    // Add 3% padding on each side so the line doesn't touch the axis edges
    const xPadMs = Math.max((dataMaxTime - dataMinTime) * 0.03, 3600000);
    const viewMin = dataMinTime - xPadMs;
    const viewMax = dataMaxTime + xPadMs;

    // Dynamic time unit: granularity matches the visible data span
    const dataSpanDays = Math.max(1, (dataMaxTime - dataMinTime) / 86400000);
    let timeUnit;
    if (dataSpanDays <= 2) timeUnit = 'hour';        // 1D view → show hours
    else if (dataSpanDays <= 30) timeUnit = 'day';    // 1M view → show days
    else if (dataSpanDays <= 180) timeUnit = 'week';  // 6M view → show weeks
    else if (dataSpanDays <= 730) timeUnit = 'month';  // 1-2Y  → show months
    else if (dataSpanDays <= 3650) timeUnit = 'quarter'; // 2-10Y → show quarters
    else timeUnit = 'year';                            // 10Y+  → show years

    // ── 10. Construct Chart.js instance — complete options object ──
    const chartInstance = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,

            // Layout padding — safety buffer so line never touches container walls
            layout: {
                padding: { top: 30, bottom: 30, left: 15, right: 30 }
            },

            interaction: {
                intersect: false,
                mode: 'index',
                axis: 'x'
            },

            scales: {
                x: {
                    type: 'time',         // chartjs-adapter-date-fns required (already in index.html)
                    min: viewMin,          // Fit to data for initial view
                    max: viewMax,
                    time: {
                        unit: timeUnit,
                        displayFormats: {
                            hour: 'HH:mm',
                            day: 'dd MMM yy',
                            week: 'dd MMM yy',
                            month: 'MMM yyyy',
                            quarter: 'QQQ yyyy',
                            year: 'yyyy'
                        },
                        tooltipFormat: isIntraday ? 'dd/MM/yyyy HH:mm' : 'dd MMM yyyy'
                    },
                    ticks: {
                        source: isIntraday ? 'data' : 'auto', // 'data' for intraday removes overnight gaps
                        autoSkip: true,
                        maxTicksLimit: 10,
                        maxRotation: 0,
                        color: '#94a3b8',
                        font: { size: 10 }
                    },
                    grid: {
                        color: 'rgba(148,163,184,0.07)',
                        drawTicks: false
                    },
                    border: { display: true, color: 'rgba(148,163,184,0.15)' }
                },

                y: {
                    position: 'right',
                    // Never use beginAtZero — it clips lines out of view when returns are
                    // entirely positive or negative. Let Chart.js auto-fit the Y domain.
                    grace: '10%',
                    ticks: {
                        color: '#94a3b8',
                        font: { size: 10 },
                        callback: usePercentMode
                            ? function(v) {
                                // Percentage Y-axis: "+12.5%", "-3.2%", "0.0%"
                                const sign = v > 0 ? '+' : '';
                                return sign + v.toFixed(1) + '%';
                            }
                            : function(v) {
                                if (Math.abs(v) >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M';
                                if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(0) + 'K';
                                return '$' + v.toFixed(0);
                            },
                        maxTicksLimit: 6,
                        padding: 8,
                        precision: 2
                    },
                    grid: {
                        color: 'rgba(148,163,184,0.07)',
                        drawTicks: false
                    },
                    border: { display: false }
                }
            },

            plugins: {
                legend: {
                    display: datasets.length > 1,
                    position: 'top',
                    rtl: true,
                    labels: {
                        color: '#94a3b8',
                        font: { size: 10 },
                        usePointStyle: true,
                        pointStyleWidth: 6,
                        padding: 10,
                        boxWidth: 6
                    }
                },

                tooltip: {
                    rtl: true,
                    backgroundColor: 'rgba(15,23,42,0.92)',
                    borderColor: 'rgba(148,163,184,0.2)',
                    borderWidth: 1,
                    titleFont: { size: 11, weight: '600' },
                    bodyFont: { size: 11 },
                    padding: 10,
                    cornerRadius: 6,
                    displayColors: true,
                    boxWidth: 8,
                    boxHeight: 8,
                    boxPadding: 4,
                    callbacks: {
                        label: usePercentMode
                            ? function(ctx) {
                                // Percentage mode: value IS the return %
                                const pct = ctx.parsed.y;
                                const sign = pct >= 0 ? '+' : '';
                                return ` ${ctx.dataset.label}: ${sign}${pct.toFixed(2)}%`;
                            }
                            : function(ctx) {
                                // Absolute mode: show $ value + derived %
                                const val = ctx.parsed.y;
                                const pct = firstVal > 0 ? ((val - firstVal) / firstVal * 100) : 0;
                                const sign = pct >= 0 ? '+' : '';
                                return ` ${ctx.dataset.label}: ${formatCurrency(val)} (${sign}${pct.toFixed(2)}%)`;
                            }
                    }
                },

                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',      // X-only — Y-axis is handled by custom _yAxisDragPlugin
                        threshold: 0
                    },
                    zoom: {
                        wheel: { enabled: true, speed: 0.1 },
                        pinch: { enabled: true },
                        mode: 'x'       // X-only — vertical scaling via Y-axis drag
                    },
                    limits: {
                        x: {
                            min: zoomMin,
                            max: zoomMax,
                            minRange: 3600000
                        }
                    }
                }
            }
        },

        // Inline plugins: crosshair + TradingView-style Y-axis drag
        plugins: [
            {
                id: 'crosshairLine',
                afterDraw: function(chart) {
                    const tooltip = chart.tooltip;
                    if (!tooltip || tooltip.opacity === 0 || !tooltip.caretX) return;
                    const ctx = chart.ctx;
                    const x = tooltip.caretX;
                    const yScale = chart.scales.y;
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x, yScale.top);
                    ctx.lineTo(x, yScale.bottom);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
                    ctx.setLineDash([4, 3]);
                    ctx.stroke();
                    ctx.restore();
                }
            },
            _yAxisDragPlugin
        ]
    });

    // Force a resize after first paint — fixes first-load rendering when modal is still
    // animating or canvas has not yet received final layout dimensions from CSS flex.
    requestAnimationFrame(() => {
        if (chartInstance && !chartInstance._destroyed) {
            chartInstance.resize();
        }
    });

    if (chartKey) charts[chartKey] = chartInstance;
    return chartInstance;
}

// ========== NO-DATA OVERLAY ==========
// Shown when portfolio_history is empty or has insufficient points for the selected range.

function _showNoChartData(canvas, container, isIntraday) {
    if (!canvas || !container) return;
    const oldMsg = container.querySelector('.no-chart-data');
    if (oldMsg) oldMsg.remove();

    const msg = document.createElement('div');
    msg.className = 'no-chart-data';
    msg.innerHTML = `
        <div class="no-chart-data-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.35">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
            </svg>
        </div>
        <div class="no-chart-data-title">${isIntraday ? 'אין נתונים זמינים לטווח זה' : 'אין נתונים זמינים לטווח זה'}</div>
        <div class="no-chart-data-sub">${isIntraday
            ? 'נתוני יום המסחר יופיעו בשעות הפעילות'
            : 'נתוני ביצועים נאספים אוטומטית — הגרף יופיע לאחר עדכון המחירים הבא'
        }</div>`;
    msg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;text-align:center;padding:24px;gap:6px;';
    canvas.style.display = 'none';
    container.appendChild(msg);
}

// ========== LOADING OVERLAY HELPERS ==========

function _showChartLoading(container) {
    if (!container) return;
    _hideChartLoading(container); // remove any existing
    const overlay = document.createElement('div');
    overlay.className = 'chart-loading-overlay';
    overlay.innerHTML = '<div class="chart-loading-spinner"></div><span>טוען נתונים...</span>';
    container.style.position = 'relative';
    container.appendChild(overlay);
}

function _hideChartLoading(container) {
    if (!container) return;
    const existing = container.querySelector('.chart-loading-overlay');
    if (existing) existing.remove();
}

// ========== MODAL PERFORMANCE CHART CONTROLS ==========

// ========== DISPLAY MODE TOGGLE ($ / %) ==========

function toggleChartDisplayMode(btn) {
    _chartDisplayMode = (_chartDisplayMode === 'percent') ? 'value' : 'percent';
    const isPercent = _chartDisplayMode === 'percent';

    // Update all toggle buttons across modal and fullscreen
    document.querySelectorAll('.display-mode-btn').forEach(b => {
        b.textContent = isPercent ? '%' : '$';
        b.classList.toggle('active-percent', isPercent);
        b.classList.toggle('active-value', !isPercent);
        b.title = isPercent ? 'מצב: אחוזים — לחץ למעבר לדולרים' : 'מצב: דולרים — לחץ למעבר לאחוזים';
    });

    // Refresh whichever chart is currently active
    if (document.getElementById('fullscreenOverlay')?.classList.contains('active')) {
        _renderFullscreenChart(currentModalClientId);
    } else {
        _refreshModalPerfChart();
    }
}

function toggleBenchmarkPanel(btn) {
    const options = btn.parentElement.querySelector('.benchmark-options');
    if (!options) return;
    const isVisible = options.style.display !== 'none';
    options.style.display = isVisible ? 'none' : 'flex';
    btn.classList.toggle('active', !isVisible);
}

function setModalPerfRange(range, btn) {
    _modalPerfRange = range;
    // Update button states
    const container = btn.closest('.perf-time-range');
    if (container) container.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _refreshModalPerfChart();
}

function toggleModalBenchmark(symbol, btn) {
    const idx = _modalPerfBenchmarks.indexOf(symbol);
    if (idx >= 0) {
        _modalPerfBenchmarks.splice(idx, 1);
        btn.classList.remove('active');
        btn.style.color = '';
    } else {
        _modalPerfBenchmarks.push(symbol);
        btn.classList.add('active');
        btn.style.color = BENCHMARK_COLORS[symbol] || '';
    }
    _refreshModalPerfChart();
}

async function _refreshModalPerfChart() {
    if (!currentModalClientId) return;
    if (_modalPerfChartInstance) {
        _modalPerfChartInstance.destroy();
        _modalPerfChartInstance = null;
    }
    _modalPerfChartInstance = await renderPerformanceChart(
        'modal-perf-chart',
        currentModalClientId,
        _modalPerfRange,
        _modalPerfBenchmarks,
        null // don't store in charts{} — we track separately
    );
}

// ========== SECTOR CHART ==========

function renderModalSectorChart(client) {
    const ctx = document.getElementById('modal-sector-chart');
    if (!ctx) return;
    _safeDestroyChart('modal-sector');
    _destroyChartOnCanvas(ctx);
    _clearCanvas(ctx);
    const sectorData = {};
    client.holdings.filter(h => h.type === 'stock').forEach(h => {
        const s = h.sector || SECTOR_MAP[h.ticker] || 'Other';
        sectorData[s] = (sectorData[s] || 0) + h.value;
    });
    const sorted = Object.entries(sectorData).sort((a, b) => b[1] - a[1]);
    const totalSectorValue = sorted.reduce((s, e) => s + e[1], 0);

    // Empty-state: no sector data or all values are 0
    if (sorted.length === 0 || totalSectorValue <= 0) {
        const container = ctx.parentElement;
        if (container) {
            ctx.style.display = 'none';
            const existing = container.querySelector('.chart-empty-state');
            if (!existing) {
                const placeholder = document.createElement('div');
                placeholder.className = 'chart-empty-state';
                placeholder.innerHTML = '<div class="chart-empty-circle"></div><span>אין נתוני סקטורים</span>';
                placeholder.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;gap:8px;';
                container.appendChild(placeholder);
            }
        }
        return;
    }
    ctx.style.display = '';

    charts['modal-sector'] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: sorted.map(s => s[0]),
            datasets: [{ data: sorted.map(s => s[1]), backgroundColor: sorted.map(s => SECTOR_COLORS[s[0]] || '#64748b'), borderWidth: 2, borderColor: '#1e293b' }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '40%',
            plugins: {
                legend: { position: 'right', rtl: true, labels: { color: '#94a3b8', font: { size: 11 }, padding: 8, usePointStyle: true } },
                tooltip: { rtl: true, callbacks: { label: (ctx) => ` ${ctx.label}: ${formatCurrency(ctx.parsed)}` } }
            }
        }
    });
}

// ========== FULLSCREEN CHART ==========

// State for fullscreen
let _fullscreenRange = '1y';
let _fullscreenBenchmarks = [];

function openFullscreenChart(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;
    // Don't block on empty performanceHistory — synthetic history will handle it

    // Reset state
    _fullscreenRange = _modalPerfRange || '1y';
    _fullscreenBenchmarks = [..._modalPerfBenchmarks];

    document.getElementById('fullscreenOverlay').classList.add('active');

    // Build header with controls
    const headerEl = document.querySelector('.fullscreen-chart-header');
    if (headerEl) {
        headerEl.innerHTML = `
            <div>
                <h3 id="fullscreenTitle">מעקב תשואה - ${client.name}</h3>
                <div class="perf-time-range" style="margin-top:8px">
                    ${['1d','5d','1m','6m','ytd','1y','5y','max'].map(r =>
                        `<button class="time-btn ${r === _fullscreenRange ? 'active' : ''}" onclick="setFullscreenRange('${r}', this)">${r.toUpperCase()}</button>`
                    ).join('')}
                </div>
                <div class="perf-benchmarks" style="margin-top:6px">
                    <button class="benchmark-toggle-btn ${_fullscreenBenchmarks.length > 0 ? 'active' : ''}" onclick="toggleBenchmarkPanel(this)">השוואה למדד</button>
                    <div class="benchmark-options" style="display:${_fullscreenBenchmarks.length > 0 ? 'flex' : 'none'}">
                    ${Object.entries(BENCHMARK_SYMBOLS).map(([sym, name]) =>
                        `<button class="benchmark-btn ${_fullscreenBenchmarks.includes(sym) ? 'active' : ''}" style="${_fullscreenBenchmarks.includes(sym) ? 'color:' + BENCHMARK_COLORS[sym] : ''}" onclick="toggleFullscreenBenchmark('${sym}', this)">${name}</button>`
                    ).join('')}
                    </div>
                    <button class="display-mode-btn ${_chartDisplayMode === 'percent' ? 'active-percent' : 'active-value'}" onclick="toggleChartDisplayMode(this)" title="% / $">${_chartDisplayMode === 'percent' ? '%' : '$'}</button>
                </div>
            </div>
            <div class="fullscreen-chart-controls">
                <button class="zoom-btn" onclick="fullscreenZoom('in')" title="זום אין">+</button>
                <button class="zoom-btn" onclick="fullscreenZoom('out')" title="זום אאוט">-</button>
                <button class="zoom-btn" onclick="fullscreenAutoScale()" title="התאמה אוטומטית">⇕</button>
                <button class="zoom-btn reset" onclick="fullscreenZoom('reset')" title="איפוס זום">איפוס</button>
                <button class="modal-close" onclick="closeFullscreen()" title="סגור">&times;</button>
            </div>
        `;
    }

    // Destroy previous instance
    if (fullscreenChartInstance) {
        fullscreenChartInstance.destroy();
        fullscreenChartInstance = null;
    }

    _renderFullscreenChart(clientId);
}

async function _renderFullscreenChart(clientId) {
    if (fullscreenChartInstance) {
        fullscreenChartInstance.destroy();
        fullscreenChartInstance = null;
    }

    // Wait for CSS transition to finish and canvas to have real dimensions.
    const canvas = document.getElementById('fullscreen-chart');
    await new Promise(resolve => {
        let tries = 0;
        const check = () => {
            tries++;
            if ((canvas && canvas.offsetWidth > 0 && canvas.offsetHeight > 0) || tries > 20) {
                resolve();
            } else {
                requestAnimationFrame(check);
            }
        };
        requestAnimationFrame(check);
    });

    fullscreenChartInstance = await renderPerformanceChart(
        'fullscreen-chart',
        clientId,
        _fullscreenRange,
        _fullscreenBenchmarks,
        null
    );

    // Force resize after chart is created — catches any remaining layout drift
    if (fullscreenChartInstance && !fullscreenChartInstance._destroyed) {
        requestAnimationFrame(() => fullscreenChartInstance.resize());
    }
}

function setFullscreenRange(range, btn) {
    _fullscreenRange = range;
    const container = btn.closest('.perf-time-range');
    if (container) container.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _renderFullscreenChart(currentModalClientId);
}

function toggleFullscreenBenchmark(symbol, btn) {
    const idx = _fullscreenBenchmarks.indexOf(symbol);
    if (idx >= 0) {
        _fullscreenBenchmarks.splice(idx, 1);
        btn.classList.remove('active');
        btn.style.color = '';
    } else {
        _fullscreenBenchmarks.push(symbol);
        btn.classList.add('active');
        btn.style.color = BENCHMARK_COLORS[symbol] || '';
    }
    _renderFullscreenChart(currentModalClientId);
}

function fullscreenZoom(action) {
    if (!fullscreenChartInstance) return;
    if (action === 'in') {
        fullscreenChartInstance.zoom(1.3);
    } else if (action === 'out') {
        fullscreenChartInstance.zoom(0.7);
    } else if (action === 'reset') {
        fullscreenChartInstance.resetZoom();
    }
}

// Auto-scale Y-axis: recalculate min/max based on currently visible data
function fullscreenAutoScale() {
    if (!fullscreenChartInstance) return;
    const chart = fullscreenChartInstance;
    const xScale = chart.scales.x;
    const xMin = xScale.min;
    const xMax = xScale.max;

    // Find Y min/max across all datasets for the visible X range
    let yMin = Infinity, yMax = -Infinity;
    for (const ds of chart.data.datasets) {
        for (const pt of ds.data) {
            if (pt.x >= xMin && pt.x <= xMax) {
                if (pt.y < yMin) yMin = pt.y;
                if (pt.y > yMax) yMax = pt.y;
            }
        }
    }

    if (yMin === Infinity || yMax === -Infinity) return;

    // Add 10% grace
    const yRange = yMax - yMin || 1;
    chart.options.scales.y.min = yMin - yRange * 0.1;
    chart.options.scales.y.max = yMax + yRange * 0.1;
    chart.update('none');
}

function closeFullscreen(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('fullscreenOverlay').classList.remove('active');
    if (fullscreenChartInstance) {
        fullscreenChartInstance.destroy();
        fullscreenChartInstance = null;
    }
}
