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

// Benchmark configuration
const BENCHMARK_SYMBOLS = {
    'SPY': 'S&P 500',
    'QQQ': 'Nasdaq 100',
    'TA125.TA': 'TA-125',
    'TA35.TA': 'TA-35'
};

const BENCHMARK_COLORS = {
    'SPY': '#eab308',
    'QQQ': '#06b6d4',
    'TA125.TA': '#f97316',
    'TA35.TA': '#8b5cf6'
};

// Cache for benchmark data: key = "symbol_range", value = { data, timestamp }
const _benchmarkCache = {};
const BENCHMARK_CACHE_TTL = 60 * 60 * 1000; // 1 hour

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
    if (range === '1d' || range === '5d') return '1h';
    return '1day';
}

function _rangeToOutputSize(range) {
    const days = _rangeToDays(range);
    if (days <= 5) return 40;
    if (days <= 30) return 30;
    if (days <= 90) return 90;
    if (days <= 180) return 180;
    if (days <= 365) return 365;
    return 1825;
}

async function fetchBenchmarkData(symbol, range) {
    const cacheKey = `${symbol}_${range}`;

    // Check memory cache
    if (_benchmarkCache[cacheKey] && (Date.now() - _benchmarkCache[cacheKey].timestamp < BENCHMARK_CACHE_TTL)) {
        return _benchmarkCache[cacheKey].data;
    }

    // Check localStorage cache
    try {
        const stored = localStorage.getItem('benchmark_' + cacheKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Date.now() - parsed.timestamp < BENCHMARK_CACHE_TTL) {
                _benchmarkCache[cacheKey] = parsed;
                return parsed.data;
            }
        }
    } catch (e) { /* ignore */ }

    // Fetch from Twelve Data
    const data = await _fetchTwelveDataBenchmark(symbol, range);
    if (data && data.length > 0) {
        const cacheEntry = { data, timestamp: Date.now() };
        _benchmarkCache[cacheKey] = cacheEntry;
        try { localStorage.setItem('benchmark_' + cacheKey, JSON.stringify(cacheEntry)); } catch (e) { /* quota */ }
        return data;
    }

    // Fallback: FMP historical-price-full (works for all symbols)
    const fmpData = await _fetchFMPBenchmark(symbol, range);
    if (fmpData && fmpData.length > 0) {
        const cacheEntry = { data: fmpData, timestamp: Date.now() };
        _benchmarkCache[cacheKey] = cacheEntry;
        try { localStorage.setItem('benchmark_' + cacheKey, JSON.stringify(cacheEntry)); } catch (e) { /* quota */ }
        return fmpData;
    }

    // Fallback: Finnhub (only for US ETFs, not Israeli indices)
    if (!symbol.includes('.TA')) {
        const finnData = await _fetchFinnhubBenchmark(symbol, range);
        if (finnData && finnData.length > 0) {
            const cacheEntry = { data: finnData, timestamp: Date.now() };
            _benchmarkCache[cacheKey] = cacheEntry;
            try { localStorage.setItem('benchmark_' + cacheKey, JSON.stringify(cacheEntry)); } catch (e) { /* quota */ }
            return finnData;
        }
    }

    console.warn(`[Benchmark] All APIs failed for ${symbol} (range=${range})`);
    return null;
}

async function _fetchTwelveDataBenchmark(symbol, range) {
    if (!TWELVE_DATA_API_KEY || TWELVE_DATA_API_KEY === 'YOUR_TWELVE_DATA_API_KEY') return null;

    const interval = _rangeToInterval(range);
    const outputSize = _rangeToOutputSize(range);

    try {
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok || res.status === 429) {
            console.warn(`[Benchmark] Twelve Data ${res.status} for ${symbol}`);
            return null;
        }
        const json = await res.json();

        // Handle JSON-body rate limit (Twelve Data returns 200 with error in body)
        if (json.code === 429 || (json.status === 'error' && json.message && json.message.includes('limit'))) {
            console.warn(`[Benchmark] Twelve Data rate-limited for ${symbol}: ${json.message}`);
            return null;
        }

        if (json.status === 'error' || !json.values || json.values.length === 0) {
            console.warn(`[Benchmark] Twelve Data no data for ${symbol}:`, json.message || 'empty');
            return null;
        }

        // Twelve Data returns newest first — reverse to chronological order
        const values = json.values.reverse();
        const firstClose = parseFloat(values[0].close);

        return values.map(v => ({
            date: v.datetime.split(' ')[0], // YYYY-MM-DD
            close: parseFloat(v.close),
            returnPct: ((parseFloat(v.close) - firstClose) / firstClose) * 100
        }));
    } catch (e) {
        console.warn(`[Benchmark] Twelve Data fetch error for ${symbol}:`, e.message);
        return null;
    }
}

async function _fetchFMPBenchmark(symbol, range) {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') return null;

    const outputSize = _rangeToOutputSize(range);

    // FMP doesn't support Israeli indices (.TA suffix) — skip immediately
    if (symbol.includes('.TA')) return null;

    try {
        const url = `https://financialmodelingprep.com/stable/historical-price-full/${symbol}?apikey=${FMP_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        const hist = json.historical || (Array.isArray(json) ? json : null);
        if (!hist || hist.length === 0) return null;

        // FMP returns newest-first — take outputSize, then reverse to chronological
        const sliced = hist.length > outputSize ? hist.slice(0, outputSize) : hist;
        const reversed = sliced.reverse();
        const firstClose = reversed[0].close;

        return reversed.map(p => ({
            date: p.date,
            close: p.close,
            returnPct: ((p.close - firstClose) / firstClose) * 100
        }));
    } catch (e) {
        console.warn(`[Benchmark] FMP fetch error for ${symbol}:`, e.message);
        return null;
    }
}

async function _fetchFinnhubBenchmark(symbol, range) {
    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY') return null;

    const now = Math.floor(Date.now() / 1000);
    const days = _rangeToDays(range);
    const from = now - days * 24 * 60 * 60;
    const resolution = (range === '1d' || range === '5d') ? '60' : 'D';

    try {
        const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${now}&token=${FINNHUB_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok || res.status === 429) return null;
        const json = await res.json();
        if (json.s !== 'ok' || !json.c || json.c.length === 0) return null;

        const firstClose = json.c[0];
        return json.c.map((close, i) => ({
            date: new Date(json.t[i] * 1000).toISOString().split('T')[0],
            close,
            returnPct: ((close - firstClose) / firstClose) * 100
        }));
    } catch (e) {
        console.warn(`[Benchmark] Finnhub fetch error for ${symbol}:`, e.message);
        return null;
    }
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
// Fetches hourly time_series from Twelve Data for the portfolio's top holdings,
// then computes weighted portfolio return at each timestamp.

const _intradayCache = {}; // key: "clientId_range" → { data, timestamp }
const INTRADAY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function _fetchIntradayPortfolioData(client, range) {
    const cacheKey = `${client.id}_${range}`;
    if (_intradayCache[cacheKey] && (Date.now() - _intradayCache[cacheKey].timestamp < INTRADAY_CACHE_TTL)) {
        return _intradayCache[cacheKey].data;
    }

    if (!TWELVE_DATA_API_KEY || TWELVE_DATA_API_KEY === 'YOUR_TWELVE_DATA_API_KEY') return null;

    // Get stock holdings with known prices
    const stocks = client.holdings.filter(h => h.type === 'stock' && h.shares > 0);
    if (stocks.length === 0) return null;

    // Use top holdings (by value) to stay within API limits — max 3 symbols per call
    const topStocks = stocks.sort((a, b) => b.value - a.value).slice(0, 3);
    const totalPortfolioValue = client.portfolioValue || 1;
    const interval = (range === '1d') ? '1h' : '4h';
    const outputSize = (range === '1d') ? 24 : 30;

    try {
        // Fetch time series for each top holding
        const seriesResults = await Promise.allSettled(topStocks.map(h => {
            const sym = (h.currency === 'ILS') ? `${h.ticker}:TASE` : h.ticker;
            return fetch(`https://api.twelvedata.com/time_series?symbol=${sym}&interval=${interval}&outputsize=${outputSize}&apikey=${TWELVE_DATA_API_KEY}`)
                .then(r => r.ok ? r.json() : null)
                .then(json => {
                    if (!json || json.status === 'error' || !json.values) return null;
                    return { ticker: h.ticker, weight: h.value / totalPortfolioValue, values: json.values.reverse() };
                });
        }));

        const series = seriesResults
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);

        if (series.length === 0) return null;

        // Use the first series as the time backbone
        const backbone = series[0].values;
        const points = backbone.map((v, i) => {
            const date = new Date(v.datetime);

            // Weighted return from each holding at this time point
            let weightedReturn = 0;
            series.forEach(s => {
                if (s.values[i]) {
                    const firstClose = parseFloat(s.values[0].close);
                    const thisClose = parseFloat(s.values[i].close);
                    const holdingReturn = firstClose > 0 ? ((thisClose - firstClose) / firstClose) * 100 : 0;
                    weightedReturn += holdingReturn * s.weight;
                }
            });

            // Approximate portfolio value at this point
            const portfolioValueAtPoint = totalPortfolioValue * (1 + weightedReturn / 100);

            return {
                date: date.toLocaleDateString('he-IL'),
                _dateObj: date,
                value: parseFloat(portfolioValueAtPoint.toFixed(2)),
                returnPct: parseFloat(weightedReturn.toFixed(2))
            };
        });

        if (points.length > 0) {
            _intradayCache[cacheKey] = { data: points, timestamp: Date.now() };
        }
        return points.length >= 2 ? points : null;

    } catch (e) {
        console.warn('[Charts] Intraday fetch error:', e.message);
        return null;
    }
}

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
    const _minPointsForRange = { '1m': 10, '3m': 25, '6m': 50, 'ytd': 30, '1y': 60, '5y': 200, 'max': 60, 'all': 10 };
    const minPoints = _minPointsForRange[range] || 10;
    const histTooSparse = !hist || hist.length < minPoints;

    if (histTooSparse && !isIntraday) {
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

    // ── 5. Pre-fetch benchmark data BEFORE deciding display mode ──
    // We must know whether benchmark data actually loaded before choosing
    // between % and $ axes — otherwise a failed API call puts the chart
    // in % mode with no benchmark line, confusing the user.
    const benchmarkResults = [];
    for (const symbol of (benchmarks || [])) {
        const benchData = await fetchBenchmarkData(symbol, range);
        if (benchData && benchData.length > 0) {
            benchmarkResults.push({ symbol, data: benchData });
        }
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

    // Benchmark datasets — from pre-fetched data
    for (const { symbol, data: benchData } of benchmarkResults) {
        // Rebase benchmark to 0% at its first data point
        const benchBase = benchData[0]?.returnPct || 0;
        datasets.push({
            label: BENCHMARK_SYMBOLS[symbol] || symbol,
            data: benchData.map(p => ({
                x: new Date(p.date).getTime(),
                // % mode: both portfolio and benchmark are rebased to 0% at start
                // $ mode: scale benchmark to portfolio's starting value
                y: usePercentMode
                    ? (p.returnPct - benchBase)
                    : firstValue * (1 + (p.returnPct - benchBase) / 100)
            })),
            borderColor: BENCHMARK_COLORS[symbol] || '#94a3b8',
            borderWidth: 1.5,
            borderDash: [5, 3],
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
                        // Let Chart.js auto-pick unit based on visible range, using our hint
                        unit: timeUnit,
                        displayFormats: {
                            hour: 'HH:mm',
                            day: 'dd MMM',
                            week: 'dd MMM',
                            month: 'MMM yyyy',
                            quarter: 'QQQ yyyy',
                            year: 'yyyy'
                        },
                        tooltipFormat: isIntraday ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy'
                    },
                    ticks: {
                        source: 'auto',   // Chart.js computes tick positions from the time scale
                        autoSkip: true,
                        maxTicksLimit: 12,
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
                    beginAtZero: usePercentMode,   // % mode: anchor 0% line; $ mode: fit to data
                    grace: '15%',
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
                        padding: 8
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
                    pan: { enabled: true, mode: 'x' },
                    zoom: {
                        wheel: { enabled: true, speed: 0.1 },
                        pinch: { enabled: true },
                        mode: 'x'
                    },
                    limits: {
                        x: {
                            min: zoomMin,        // 10 years back
                            max: zoomMax,        // 10 years forward
                            minRange: 3600000    // minimum 1 hour visible when zoomed in
                        }
                    }
                }
            }
        },

        // Inline plugin: vertical crosshair line on hover (Bloomberg-style)
        plugins: [{
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
        }]
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
                <div class="perf-chart-controls-row" style="margin-top:6px">
                    <div class="perf-benchmarks">
                        <button class="benchmark-toggle-btn ${_fullscreenBenchmarks.length > 0 ? 'active' : ''}" onclick="toggleBenchmarkPanel(this)">השוואה למדד</button>
                        <div class="benchmark-options" style="display:${_fullscreenBenchmarks.length > 0 ? 'flex' : 'none'}">
                        ${Object.entries(BENCHMARK_SYMBOLS).map(([sym, name]) =>
                            `<button class="benchmark-btn ${_fullscreenBenchmarks.includes(sym) ? 'active' : ''}" style="${_fullscreenBenchmarks.includes(sym) ? 'color:' + BENCHMARK_COLORS[sym] : ''}" onclick="toggleFullscreenBenchmark('${sym}', this)">${name}</button>`
                        ).join('')}
                        </div>
                    </div>
                    <button class="display-mode-btn ${_chartDisplayMode === 'percent' ? 'active-percent' : 'active-value'}" onclick="toggleChartDisplayMode(this)" title="${_chartDisplayMode === 'percent' ? 'מצב: אחוזים — לחץ למעבר לדולרים' : 'מצב: דולרים — לחץ למעבר לאחוזים'}">${_chartDisplayMode === 'percent' ? '%' : '$'}</button>
                </div>
            </div>
            <div class="fullscreen-chart-controls">
                <button class="zoom-btn" onclick="fullscreenZoom('in')" title="זום אין">+</button>
                <button class="zoom-btn" onclick="fullscreenZoom('out')" title="זום אאוט">-</button>
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

    setTimeout(async () => {
        fullscreenChartInstance = await renderPerformanceChart(
            'fullscreen-chart',
            clientId,
            _fullscreenRange,
            _fullscreenBenchmarks,
            null
        );
    }, 100);
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

function closeFullscreen(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('fullscreenOverlay').classList.remove('active');
    if (fullscreenChartInstance) {
        fullscreenChartInstance.destroy();
        fullscreenChartInstance = null;
    }
}
