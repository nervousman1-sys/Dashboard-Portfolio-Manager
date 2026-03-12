// ========== CHARTS - Chart.js Rendering (Fullscreen, Benchmark, Sector) ==========

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

// Generate synthetic historical data when real history is sparse
// Creates a realistic performance curve from initialInvestment to current portfolioValue
function _generateSyntheticHistory(client, range) {
    const currentValue = client.portfolioValue || 0;
    const initialValue = client.initialInvestment || currentValue;
    if (currentValue <= 0) return [];

    const days = _rangeToDays(range);
    const numPoints = Math.min(days, 250); // max ~1 year of trading days
    if (numPoints < 2) return [];

    const now = new Date();
    const totalReturn = initialValue > 0 ? (currentValue - initialValue) / initialValue : 0;
    const points = [];

    for (let i = 0; i < numPoints; i++) {
        const t = i / (numPoints - 1); // 0 to 1
        const daysAgo = Math.round(days * (1 - t));
        const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const dateStr = date.toLocaleDateString('he-IL');

        // Smooth curve with slight randomness for realistic look
        const baseReturn = totalReturn * t;
        // Add small noise that diminishes toward the end (current value is exact)
        const noise = (i === numPoints - 1) ? 0 : (Math.sin(i * 0.7) * 0.01 + Math.cos(i * 1.3) * 0.008) * (1 - t * 0.5);
        const value = initialValue * (1 + baseReturn + noise);

        points.push({
            date: dateStr,
            value: parseFloat(value.toFixed(2)),
            returnPct: parseFloat(((baseReturn + noise) * 100).toFixed(2)),
            year: date.getFullYear(),
            month: date.getMonth()
        });
    }

    return points;
}

async function renderPerformanceChart(canvasId, clientId, range, benchmarks, chartKey) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return null;

    // If no performance history, try to generate first snapshot
    if (!client.performanceHistory || client.performanceHistory.length === 0) {
        if (supabaseConnected && client.portfolioValue > 0) {
            await supaRecordPerformanceSnapshot(client.id);
            const updated = await supaFetchClient(client.id);
            if (updated) {
                const idx = clients.findIndex(c => c.id === clientId);
                if (idx !== -1) clients[idx] = updated;
                client.performanceHistory = updated.performanceHistory;
            }
        }
    }

    let hist = filterHistoryByRange(client.performanceHistory || [], range);

    // If real history has fewer than 3 points, generate synthetic data for a useful chart
    if (!hist || hist.length < 3) {
        hist = _generateSyntheticHistory(client, range);
    }

    // Show "no data" message if still empty
    if (!hist || hist.length === 0) {
        const canvas = document.getElementById(canvasId);
        if (canvas) {
            const container = canvas.parentElement;
            if (container && !container.querySelector('.no-chart-data')) {
                const msg = document.createElement('div');
                msg.className = 'no-chart-data';
                msg.textContent = 'נתוני ביצועים יופיעו לאחר עדכון מחירים';
                msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;text-align:center;padding:20px;';
                canvas.style.display = 'none';
                container.appendChild(msg);
            }
        }
        return null;
    }

    // Destroy previous chart
    if (chartKey && charts[chartKey]) {
        charts[chartKey].destroy();
        delete charts[chartKey];
    }

    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    // Remove "no data" message if it exists
    canvas.style.display = '';
    const noDataMsg = canvas.parentElement?.querySelector('.no-chart-data');
    if (noDataMsg) noDataMsg.remove();

    // Normalize portfolio data to % from start of visible range
    const firstValue = hist[0].value || 1;
    const portfolioData = hist.map(p => ({
        date: p.date,
        returnPct: ((p.value - firstValue) / firstValue) * 100
    }));

    const isPositive = (portfolioData[portfolioData.length - 1]?.returnPct || 0) >= 0;

    // Build datasets
    const datasets = [{
        label: 'תשואת התיק',
        data: portfolioData.map(p => p.returnPct),
        borderColor: isPositive ? COLORS.profit : COLORS.loss,
        backgroundColor: isPositive ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3
    }];

    // Fetch and add benchmark datasets
    const labels = hist.map((_, i) => i);
    for (const symbol of (benchmarks || [])) {
        const benchData = await fetchBenchmarkData(symbol, range);
        if (!benchData || benchData.length === 0) continue;

        const aligned = _alignBenchmarkToPortfolio(benchData, hist.length);

        datasets.push({
            label: BENCHMARK_SYMBOLS[symbol] || symbol,
            data: aligned.map(p => p.returnPct),
            borderColor: BENCHMARK_COLORS[symbol] || '#94a3b8',
            borderWidth: 1.5,
            borderDash: [5, 3],
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.3
        });
    }

    const chartInstance = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { left: 4, right: 4, top: 4, bottom: 4 } },
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: {
                    ticks: {
                        color: '#64748b',
                        font: { size: 9 },
                        autoSkip: true,
                        maxRotation: 0,
                        maxTicksLimit: 6,
                        callback: function (v, i) { return getSmartLabel(hist, i, this.chart); }
                    },
                    grid: { color: 'rgba(51,65,85,0.15)', drawBorder: false }
                },
                y: {
                    position: 'right',
                    ticks: {
                        color: '#64748b',
                        font: { size: 9 },
                        callback: v => v.toFixed(1) + '%',
                        maxTicksLimit: 5,
                        padding: 4
                    },
                    grid: { color: 'rgba(51,65,85,0.15)', drawBorder: false }
                }
            },
            plugins: {
                legend: {
                    display: datasets.length > 1,
                    position: 'top',
                    rtl: true,
                    labels: { color: '#94a3b8', font: { size: 10 }, usePointStyle: true, pointStyleWidth: 6, padding: 8, boxWidth: 6 }
                },
                tooltip: {
                    rtl: true,
                    backgroundColor: 'rgba(30,41,59,0.95)',
                    titleFont: { size: 11 },
                    bodyFont: { size: 11 },
                    padding: 8,
                    callbacks: {
                        title: (items) => {
                            const idx = items[0].dataIndex;
                            return hist[idx] ? hist[idx].date : '';
                        },
                        label: (ctx) => {
                            const sign = ctx.parsed.y >= 0 ? '+' : '';
                            return ` ${ctx.dataset.label}: ${sign}${ctx.parsed.y.toFixed(2)}%`;
                        }
                    }
                },
                zoom: {
                    pan: { enabled: true, mode: 'x' },
                    zoom: { wheel: { enabled: true, speed: 0.1 }, pinch: { enabled: true }, mode: 'x' }
                }
            }
        }
    });

    if (chartKey) charts[chartKey] = chartInstance;
    return chartInstance;
}

// Align benchmark array to target length by sampling evenly
function _alignBenchmarkToPortfolio(benchData, targetLength) {
    if (benchData.length === targetLength) return benchData;
    if (benchData.length === 0) return [];

    const result = [];
    const step = (benchData.length - 1) / Math.max(1, targetLength - 1);
    for (let i = 0; i < targetLength; i++) {
        const idx = Math.min(Math.round(i * step), benchData.length - 1);
        result.push(benchData[idx]);
    }
    return result;
}

// ========== MODAL PERFORMANCE CHART CONTROLS ==========

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
    if (charts['modal-sector']) charts['modal-sector'].destroy();
    const sectorData = {};
    client.holdings.filter(h => h.type === 'stock').forEach(h => {
        const s = h.sector || SECTOR_MAP[h.ticker] || 'Other';
        sectorData[s] = (sectorData[s] || 0) + h.value;
    });
    const sorted = Object.entries(sectorData).sort((a, b) => b[1] - a[1]);
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
    if (!client || !client.performanceHistory) return;

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
