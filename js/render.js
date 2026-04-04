// ========== RENDER - DOM Rendering (Summary, Exposure, Client Cards) ==========

// ── Summary bar: cached async data ──
let _cachedRealizedPnl = null;
let _cachedDivYield = null;
let _realizedPnlLoading = false;

// Returns the currently filtered client list (mirrors filter logic in filters.js)
function _getFilteredClients() {
    if (typeof activeFilters === 'undefined' || typeof clients === 'undefined') return [];
    const noFilter = (!activeFilters.risk || activeFilters.risk === 'all')
        && (!activeFilters.asset || activeFilters.asset === 'all')
        && (!activeFilters.sector || activeFilters.sector === 'all')
        && (activeFilters.sizeMin === null && activeFilters.sizeMax === null)
        && (!activeFilters.search || activeFilters.search === '');
    if (noFilter) return clients;
    return clients.filter(c => {
        if (activeFilters.risk && activeFilters.risk !== 'all' && c.risk !== activeFilters.risk) return false;
        if (activeFilters.asset && activeFilters.asset !== 'all') {
            const hasType = activeFilters.asset === 'stocks'
                ? c.holdings.some(h => h.type === 'stock')
                : c.holdings.some(h => h.type === 'bond');
            if (!hasType) return false;
        }
        if (activeFilters.sector && activeFilters.sector !== 'all') {
            if (!c.holdings.some(h => h.sector === activeFilters.sector)) return false;
        }
        if (activeFilters.sizeMin !== null && c.portfolioValue < activeFilters.sizeMin) return false;
        if (activeFilters.sizeMax !== null && c.portfolioValue >= activeFilters.sizeMax) return false;
        if (activeFilters.search) {
            const q = activeFilters.search.toLowerCase();
            const nameMatch = c.name.toLowerCase().includes(q);
            const tickerMatch = c.holdings.some(h => h.ticker.toLowerCase().includes(q) || h.name.toLowerCase().includes(q));
            if (!nameMatch && !tickerMatch) return false;
        }
        return true;
    });
}

// Async loader: fetches realized P/L from all portfolio transactions
async function _loadRealizedPnlAsync() {
    if (_realizedPnlLoading || typeof supaFetchTransactions !== 'function') return;
    _realizedPnlLoading = true;
    try {
        let totalRealized = 0;
        for (const c of clients) {
            const txs = await supaFetchTransactions(c.id);
            if (txs && txs.length) {
                txs.forEach(t => {
                    if (t.realizedPnl) totalRealized += t.realizedPnl;
                });
            }
        }
        _cachedRealizedPnl = totalRealized;
        _realizedPnlLoading = false;
        // Re-render summary bar with updated data
        renderSummaryBar();
    } catch (e) {
        _realizedPnlLoading = false;
        console.warn('[renderSummaryBar] Could not load realized P/L:', e.message);
    }
}

// ── Currency toggle state ──
let _displayCurrency = 'USD';

function setCurrency(currency, btn) {
    _displayCurrency = currency;
    document.querySelectorAll('.currency-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Re-render all currency-dependent views
    renderSummaryBar();
    renderClientCards();
    renderExposureSection();
}

// ── Header date/time clock ──
function _updateHeaderDatetime() {
    const el = document.getElementById('headerDatetime');
    if (!el) return;
    const now = new Date();
    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    el.textContent = now.toLocaleDateString('en-US', opts);
}

// Start clock — update every 30 seconds
_updateHeaderDatetime();
setInterval(_updateHeaderDatetime, 30000);

// ========== QUANTITY FORMATTING ==========

// Display-only: returns an LTR span that prevents RTL digit truncation.
// Uses toLocaleString for full comma-separated display — never truncates the number.
function formatAssetQuantity(qty) {
    if (qty == null || isNaN(qty)) return '<span class="qty-display-final" title="0">0</span>';
    const num = Number(qty);
    const decimals = num % 1 !== 0 ? (num < 1 ? 6 : 2) : 0;
    const formatted = num.toLocaleString('en-US', { maximumFractionDigits: decimals, useGrouping: true });
    return `<span class="qty-display-final" title="${num}">${formatted}</span>`;
}

// Hebrew description for live input preview: "כמות: 1,500,000 → 1.5 מיליון יחידות"
function describeQuantity(qty) {
    if (!qty || isNaN(qty) || qty <= 0) return '';
    const num = Number(qty);
    const formatted = num.toLocaleString('en-US');
    if (num >= 1000000) {
        const m = num / 1000000;
        return `כמות: ${formatted} → ${m % 1 === 0 ? m.toFixed(0) : m.toFixed(2)} מיליון יחידות`;
    }
    if (num >= 1000) {
        const k = num / 1000;
        return `כמות: ${formatted} → ${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)} אלף יחידות`;
    }
    return `כמות: ${formatted} יחידות`;
}

// ========== RISK MINI-SUMMARY ==========

function updateRiskMiniSummary(filteredClients) {
    const el = document.getElementById('riskMiniSummary');
    if (!el) return;

    if (!filteredClients || filteredClients.length === 0) {
        el.innerHTML = '';
        return;
    }

    const total = filteredClients.length;
    let high = 0, medium = 0, low = 0;
    filteredClients.forEach(c => {
        if (c.risk === 'high') high++;
        else if (c.risk === 'medium') medium++;
        else if (c.risk === 'low') low++;
    });

    const pct = (n) => total > 0 ? (n / total * 100).toFixed(0) : '0';

    el.innerHTML = `
        <div class="risk-counter-card">
            <div class="risk-counter-info">
                <span class="risk-counter-label">סיכון גבוה</span>
                <span class="risk-counter-value risk-val-high">${high}</span>
            </div>
            <span class="risk-counter-pct risk-val-high">${pct(high)}%</span>
        </div>
        <div class="risk-counter-card">
            <div class="risk-counter-info">
                <span class="risk-counter-label">סיכון בינוני</span>
                <span class="risk-counter-value risk-val-medium">${medium}</span>
            </div>
            <span class="risk-counter-pct risk-val-medium">${pct(medium)}%</span>
        </div>
        <div class="risk-counter-card">
            <div class="risk-counter-info">
                <span class="risk-counter-label">סיכון נמוך</span>
                <span class="risk-counter-value risk-val-low">${low}</span>
            </div>
            <span class="risk-counter-pct risk-val-low">${pct(low)}%</span>
        </div>
    `;
}

// ========== EXPOSURE ==========

// Version counter — prevents stale setTimeout callbacks from creating orphaned charts
let _exposureRenderVersion = 0;

function calculateOverallExposure() {
    let totalStocks = 0, totalBonds = 0, totalValue = 0;
    const sectorTotals = {};
    clients.forEach(c => {
        c.holdings.forEach(h => {
            totalValue += h.value;
            if (h.type === 'stock') {
                totalStocks += h.value;
                const sector = h.sector || SECTOR_MAP[h.ticker] || 'Other';
                sectorTotals[sector] = (sectorTotals[sector] || 0) + h.value;
            } else {
                totalBonds += h.value;
            }
        });
    });
    return { totalStocks, totalBonds, totalValue, sectorTotals };
}

function renderExposureSection() {
    // Bump version — any pending setTimeout from a previous call becomes stale
    const myVersion = ++_exposureRenderVersion;

    // Destroy previous sector chart (may reference an orphaned canvas)
    _safeDestroyChart('sector-exposure');

    if (!clients || clients.length === 0) {
        document.getElementById('exposureSection').innerHTML = `
            <h2 class="section-title">סקירת חשיפה כוללת</h2>
            <div class="empty-state glass-card">
                <div class="empty-state-icon">📈</div>
                <p>נתוני חשיפה יוצגו לאחר הוספת תיקים</p>
            </div>
        `;
        return;
    }
    const exp = calculateOverallExposure();
    const stockPct = exp.totalValue > 0 ? (exp.totalStocks / exp.totalValue * 100) : 0;
    const bondPct = exp.totalValue > 0 ? (exp.totalBonds / exp.totalValue * 100) : 0;

    // Sort sectors by value
    const sortedSectors = Object.entries(exp.sectorTotals).sort((a, b) => b[1] - a[1]);

    let legendHTML = '';
    sortedSectors.forEach(([sector, value]) => {
        const pct = (value / exp.totalValue * 100).toFixed(1);
        const color = SECTOR_COLORS[sector] || SECTOR_COLORS['Other'];
        legendHTML += `<div class="exposure-legend-item"><span class="exposure-legend-dot" style="background:${color}"></span>${sector}: ${pct}% (${formatCurrency(value)})</div>`;
    });

    // Sector chart or empty-state if no sector data
    const sectorContent = sortedSectors.length > 0
        ? `<div class="sector-chart-container"><canvas id="sector-exposure-chart"></canvas></div>`
        : `<div class="chart-empty-state"><div class="chart-empty-circle"></div><span>אין נתוני סקטורים</span></div>`;

    document.getElementById('exposureSection').innerHTML = `
        <h2 class="section-title">סקירת חשיפה כוללת</h2>
        <div class="exposure-grid">
            <div class="exposure-card glass-card">
                <h3>חלוקת נכסים</h3>
                <div class="exposure-bar">
                    <div class="exposure-bar-segment" style="width:${stockPct}%;background:var(--accent-blue)">מניות ${stockPct.toFixed(1)}%</div>
                    <div class="exposure-bar-segment" style="width:${bondPct}%;background:var(--accent-purple)">אג"ח ${bondPct.toFixed(1)}%</div>
                </div>
                <div class="exposure-legend">
                    <div class="exposure-legend-item"><span class="exposure-legend-dot" style="background:var(--accent-blue)"></span>מניות: ${formatCurrency(exp.totalStocks)}</div>
                    <div class="exposure-legend-item"><span class="exposure-legend-dot" style="background:var(--accent-purple)"></span>אג"ח: ${formatCurrency(exp.totalBonds)}</div>
                </div>
            </div>
            <div class="exposure-card glass-card">
                <h3>חלוקה לפי סקטורים</h3>
                ${sectorContent}
            </div>
        </div>
    `;

    // No chart to create if sectors are empty
    if (sortedSectors.length === 0) return;

    // Sector doughnut chart — version-guarded to prevent race conditions
    setTimeout(() => {
        // Stale callback — a newer renderExposureSection() already ran
        if (myVersion !== _exposureRenderVersion) return;

        const ctx = document.getElementById('sector-exposure-chart');
        if (!ctx) return;

        // Belt-and-suspenders: destroy anything already on this canvas
        _destroyChartOnCanvas(ctx);
        _clearCanvas(ctx);

        charts['sector-exposure'] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sortedSectors.map(s => s[0]),
                datasets: [{
                    data: sortedSectors.map(s => s[1]),
                    backgroundColor: sortedSectors.map(s => SECTOR_COLORS[s[0]] || SECTOR_COLORS['Other']),
                    borderWidth: 2,
                    borderColor: '#0a0a0a'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                cutout: '40%',
                plugins: {
                    legend: { position: 'right', rtl: true, labels: { color: 'rgba(255,255,255,0.85)', font: { family: 'Assistant', size: 11, weight: '600' }, padding: 8, usePointStyle: true, pointStyleWidth: 10, boxWidth: 10 } },
                    tooltip: { rtl: true, titleFont: { size: 14 }, bodyFont: { size: 13 }, callbacks: { label: (ctx) => ` ${ctx.label}: ${(ctx.parsed / exp.totalValue * 100).toFixed(1)}% (${formatCurrency(ctx.parsed)})` } }
                }
            }
        });
    }, 50);
}

// ========== CARD SPARKLINE (async, with synthetic fallback) ==========

async function _renderCardSparkline(client, renderKey) {
    const perfCtx = document.getElementById(`perf-${client.id}`);
    if (!perfCtx) return;

    // Stale check — a newer renderClientCards() may have replaced the canvas
    if (renderKey !== _cardRenderKey) return;

    let hist = client.performanceHistory;

    // Synthetic fallback: if real history is empty/sparse and holdings exist
    if ((!hist || hist.length < 5) && typeof fetchSyntheticHistory === 'function') {
        const hasEligible = client.holdings && client.holdings.some(
            h => (h.type === 'stock' || h.type === 'fund') && h.shares > 0
        );
        if (hasEligible) {
            // Show loading indicator while fetching
            const container = perfCtx.parentElement;
            if (container && !container.querySelector('.sparkline-loading')) {
                const loader = document.createElement('div');
                loader.className = 'sparkline-loading';
                loader.textContent = 'טוען גרף...';
                container.appendChild(loader);
            }

            const synth = await fetchSyntheticHistory(client, '1y');

            // Re-check staleness after async call
            if (renderKey !== _cardRenderKey) return;

            // Remove loading indicator
            const loader = perfCtx.parentElement?.querySelector('.sparkline-loading');
            if (loader) loader.remove();

            if (synth && synth.length >= 2) {
                hist = synth;
            }
        }
    }

    if (!hist || hist.length < 2) {
        // Show empty state
        const container = perfCtx.parentElement;
        if (container && !container.querySelector('.sparkline-empty')) {
            perfCtx.style.display = 'none';
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'sparkline-empty';
            emptyMsg.textContent = 'אין נתוני ביצועים';
            container.appendChild(emptyMsg);
        }
        return;
    }

    // Anchor last point to actual current portfolio value (not stale API close)
    if (hist.length >= 2 && client.portfolioValue > 0) {
        hist[hist.length - 1].value = client.portfolioValue;
    }

    // Destroy any existing chart on this canvas
    _safeDestroyChart(`perf-${client.id}`);
    _destroyChartOnCanvas(perfCtx);
    _clearCanvas(perfCtx);
    perfCtx.style.display = '';

    // Chart color based on actual portfolio return, not history endpoints
    const isPositive = calcPortfolioReturn(client).returnPct >= 0;
    const lineColor = isPositive ? '#00ff94' : '#ff4d4d';
    const bgColor = isPositive ? 'rgba(0,255,148,0.08)' : 'rgba(255,77,77,0.08)';

    charts[`perf-${client.id}`] = new Chart(perfCtx, {
        type: 'line',
        data: {
            labels: hist.map(p => p.date),
            datasets: [{
                data: hist.map(p => p.value),
                borderColor: lineColor,
                backgroundColor: bgColor,
                borderWidth: 2,
                fill: true,
                pointRadius: 0,
                tension: 0.3,
                clip: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 4, bottom: 4 } },
            scales: {
                x: { display: false },
                y: { display: false, beginAtZero: false, grace: '15%' }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    rtl: true,
                    callbacks: {
                        title: (items) => items[0].label,
                        label: (ctx) => ` שווי: ${formatCurrency(ctx.parsed.y)}`
                    }
                }
            },
            interaction: { intersect: false, mode: 'index' }
        }
    });
}

// ========== SUMMARY BAR ==========

function renderSummaryBar() {
    // Determine which clients to summarize — respects active filters
    const filtered = _getFilteredClients();

    if (!clients || clients.length === 0) {
        document.getElementById('summaryBar').innerHTML = `
            <div class="summary-main">
                <div class="stat-card"><span class="stat-label">סך נכסים מנוהלים</span><span class="stat-value stat-val-primary">$0</span><span class="stat-sub">Total AUM</span></div>
                <div class="stat-card"><span class="stat-label">רווח / הפסד כולל</span><span class="stat-value">$0</span><span class="stat-sub">Unrealized P/L</span></div>
                <div class="stat-card"><span class="stat-label">רווח ממומש</span><span class="stat-value">—</span><span class="stat-sub">Realized P/L</span></div>
                <div class="stat-card"><span class="stat-label">תשואת דיבידנד</span><span class="stat-value">—</span><span class="stat-sub">Dividend Yield</span></div>
                <div class="stat-card"><span class="stat-label">תשואה משוקללת</span><span class="stat-value">0.00%</span><span class="stat-sub">Weighted Return</span></div>
                <div class="stat-card"><span class="stat-label">תיקים מנוהלים</span><span class="stat-value">0</span><span class="stat-sub">Managed Portfolios</span></div>
            </div>
        `;
        return;
    }

    const src = filtered.length > 0 ? filtered : clients;
    const totalAUM = src.reduce((sum, c) => sum + c.portfolioValue, 0);
    // Unified FX-aware profit/return — uses calcPortfolioReturn (clients.js)
    const allCostBasis = src.reduce((s, c) => s + calcPortfolioReturn(c).totalCost, 0);
    const allCurrentValue = src.reduce((s, c) => s + calcPortfolioReturn(c).totalValue, 0);
    const totalProfit = allCurrentValue - allCostBasis;
    const totalReturn = allCostBasis > 0 ? ((totalProfit) / allCostBasis * 100) : 0;

    // Global stale detection — if ALL stock holdings have unresolved prices
    const allStockHoldings = src.flatMap(c => c.holdings.filter(h => h.type === 'stock' && h.shares > 0 && h.costBasis > 0));
    const globalAllStale = allStockHoldings.length > 0 && allStockHoldings.every(h => !h._livePriceResolved);

    const profitClass = globalAllStale ? 'neutral' : (totalProfit >= 0 ? 'positive' : 'negative');
    const profitSign = globalAllStale ? '' : (totalProfit >= 0 ? '+' : '');

    // Weighted average return across portfolios (based on invested capital)
    const avgReturn = allCostBasis > 0 ? src.reduce((s, c) => {
        const r = calcPortfolioReturn(c);
        return s + r.returnPct * (r.totalCost / allCostBasis);
    }, 0) : 0;
    const avgClass = globalAllStale ? 'neutral' : (avgReturn >= 0 ? 'positive' : 'negative');
    const avgSign = globalAllStale ? '' : (avgReturn >= 0 ? '+' : '');

    // Realized P/L — aggregate from cached transaction data if available
    const realizedPnl = _cachedRealizedPnl || 0;
    const hasRealized = _cachedRealizedPnl !== null;
    const realizedSign = realizedPnl >= 0 ? '+' : '';

    // Dividend yield estimate — sum of annual dividends / total portfolio value
    const divYield = _cachedDivYield || 0;
    const hasDivYield = _cachedDivYield !== null;

    // Filter indicator
    const isFiltered = filtered.length > 0 && filtered.length < clients.length;
    const filterTag = isFiltered ? `<span class="stat-filter-tag">${src.length} / ${clients.length}</span>` : '';

    const highClients = src.filter(c => c.risk === 'high');
    const medClients = src.filter(c => c.risk === 'medium');
    const lowClients = src.filter(c => c.risk === 'low');

    function groupReturn(group) {
        const cb = group.reduce((s, c) => s + calcPortfolioReturn(c).totalCost, 0);
        const cv = group.reduce((s, c) => s + calcPortfolioReturn(c).totalValue, 0);
        const ret = cb > 0 ? ((cv - cb) / cb * 100) : 0;
        const cls = ret >= 0 ? 'positive' : 'negative';
        const sgn = ret >= 0 ? '+' : '';
        return `<span class="price-change ${cls}">${sgn}${ret.toFixed(2)}%</span>`;
    }

    document.getElementById('summaryBar').innerHTML = `
        <div class="summary-main">
            <div class="stat-card stat-card-highlight">
                <div class="stat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                </div>
                <span class="stat-label">סך נכסים מנוהלים</span>
                <span class="stat-value stat-val-primary">${formatCurrency(totalAUM)}</span>
                <span class="stat-sub">Total AUM ${filterTag}</span>
            </div>
            <div class="stat-card">
                <div class="stat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${profitClass === 'positive' ? 'var(--accent-green)' : profitClass === 'negative' ? 'var(--accent-red)' : 'var(--text-muted)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
                </div>
                <span class="stat-label">רווח / הפסד כולל</span>
                <span class="stat-value ${profitClass === 'positive' ? 'stat-val-green' : profitClass === 'negative' ? 'stat-val-red' : ''}">${globalAllStale ? '<span class="stat-stale">ממתין למחירים...</span>' : `${profitSign}${formatCurrency(Math.abs(totalProfit))}`}</span>
                <span class="stat-sub">${globalAllStale ? '<span class="stat-stale">—</span>' : `<span class="${profitClass === 'positive' ? 'stat-val-green' : profitClass === 'negative' ? 'stat-val-red' : ''}" style="font-weight:800">${profitSign}${totalReturn.toFixed(2)}%</span>`}</span>
            </div>
            <div class="stat-card">
                <div class="stat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                </div>
                <span class="stat-label">רווח ממומש</span>
                <span class="stat-value ${hasRealized ? (realizedPnl >= 0 ? 'stat-val-green' : 'stat-val-red') : ''}">${hasRealized ? `${realizedSign}${formatCurrency(Math.abs(realizedPnl))}` : '—'}</span>
                <span class="stat-sub">Realized P/L</span>
            </div>
            <div class="stat-card">
                <div class="stat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                </div>
                <span class="stat-label">תשואת דיבידנד</span>
                <span class="stat-value ${hasDivYield ? 'stat-val-green' : ''}">${hasDivYield ? `${divYield.toFixed(2)}%` : '—'}</span>
                <span class="stat-sub">Dividend Yield</span>
            </div>
            <div class="stat-card">
                <div class="stat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${avgClass === 'positive' ? 'var(--accent-green)' : avgClass === 'negative' ? 'var(--accent-red)' : 'var(--text-muted)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                </div>
                <span class="stat-label">תשואה משוקללת</span>
                <span class="stat-value ${avgClass === 'positive' ? 'stat-val-green' : avgClass === 'negative' ? 'stat-val-red' : ''}">${globalAllStale ? '<span class="stat-stale">ממתין...</span>' : `${avgSign}${avgReturn.toFixed(2)}%`}</span>
                <span class="stat-sub">Weighted Return</span>
            </div>
            <div class="stat-card">
                <div class="stat-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
                </div>
                <span class="stat-label">תיקים מנוהלים</span>
                <span class="stat-value">${src.length}</span>
                <span class="stat-sub">Managed Portfolios</span>
            </div>
        </div>
        <div class="summary-secondary">
            <div class="risk-counter-card">
                <div class="risk-counter-info">
                    <span class="risk-counter-label">סיכון גבוה</span>
                    <span class="risk-counter-value risk-val-high">${highClients.length} תיקים</span>
                </div>
                <div class="risk-counter-detail">
                    <span class="risk-counter-sub">${formatCurrency(highClients.reduce((s, c) => s + c.portfolioValue, 0))}</span>
                    <span class="risk-counter-pct">${groupReturn(highClients)}</span>
                </div>
            </div>
            <div class="risk-counter-card">
                <div class="risk-counter-info">
                    <span class="risk-counter-label">סיכון בינוני</span>
                    <span class="risk-counter-value risk-val-medium">${medClients.length} תיקים</span>
                </div>
                <div class="risk-counter-detail">
                    <span class="risk-counter-sub">${formatCurrency(medClients.reduce((s, c) => s + c.portfolioValue, 0))}</span>
                    <span class="risk-counter-pct">${groupReturn(medClients)}</span>
                </div>
            </div>
            <div class="risk-counter-card">
                <div class="risk-counter-info">
                    <span class="risk-counter-label">סיכון נמוך</span>
                    <span class="risk-counter-value risk-val-low">${lowClients.length} תיקים</span>
                </div>
                <div class="risk-counter-detail">
                    <span class="risk-counter-sub">${formatCurrency(lowClients.reduce((s, c) => s + c.portfolioValue, 0))}</span>
                    <span class="risk-counter-pct">${groupReturn(lowClients)}</span>
                </div>
            </div>
        </div>
    `;

    // Lazy-load realized P/L from transactions (async, updates card when ready)
    if (!hasRealized) _loadRealizedPnlAsync();
}

// ========== CLIENT CARDS ==========

// Incremented on each render — used as canvas key to force clean re-draw
let _cardRenderKey = 0;

function renderClientCards() {
    _cardRenderKey++;
    const grid = document.getElementById('clientsGrid');
    grid.innerHTML = '';

    // Destroy only card-level charts (doughnut + sparkline), preserve exposure/modal charts
    const preserveKeys = ['sector-exposure', 'modal-sector'];
    Object.keys(charts).forEach(key => {
        if (preserveKeys.includes(key)) return;
        _safeDestroyChart(key);
    });

    // Empty state — no portfolios at all
    if (!clients || clients.length === 0) {
        grid.innerHTML = `
            <div class="empty-state glass-card">
                <div class="empty-state-icon">📊</div>
                <h3>אין תיקים להצגה</h3>
                <p>לחץ על <strong style="color:var(--accent-blue)">"+ הוסף תיק"</strong> כדי להתחיל</p>
            </div>
        `;
        updateRiskMiniSummary([]);
        return;
    }

    let filtered = clients.filter(c => {
        if (activeFilters.risk !== 'all' && c.risk !== activeFilters.risk) return false;
        if (activeFilters.sector !== 'all') {
            const hasSector = c.holdings.some(h => h.sector === activeFilters.sector);
            if (!hasSector) return false;
        }
        if (activeFilters.search) {
            const q = activeFilters.search.toLowerCase();
            const nameMatch = c.name.toLowerCase().includes(q);
            const tickerMatch = c.holdings.some(h => h.ticker.toLowerCase().includes(q) || h.name.toLowerCase().includes(q));
            if (!nameMatch && !tickerMatch) return false;
        }
        if (activeFilters.sizeMin !== null && c.portfolioValue < activeFilters.sizeMin) return false;
        if (activeFilters.sizeMax !== null && c.portfolioValue > activeFilters.sizeMax) return false;
        const returnPct = calcPortfolioReturn(c).returnPct;
        if (activeFilters.returnMin !== null && returnPct < activeFilters.returnMin) return false;
        if (activeFilters.returnMax !== null && returnPct > activeFilters.returnMax) return false;
        return true;
    });

    // Update risk mini-summary with filtered results
    updateRiskMiniSummary(filtered);

    // Sorting
    if (activeFilters.sort === 'return-high') {
        filtered.sort((a, b) => calcPortfolioReturn(b).returnPct - calcPortfolioReturn(a).returnPct);
    } else if (activeFilters.sort === 'return-low') {
        filtered.sort((a, b) => calcPortfolioReturn(a).returnPct - calcPortfolioReturn(b).returnPct);
    } else if (activeFilters.sort === 'size-high') {
        filtered.sort((a, b) => b.portfolioValue - a.portfolioValue);
    } else if (activeFilters.sort === 'size-low') {
        filtered.sort((a, b) => a.portfolioValue - b.portfolioValue);
    }

    // No matching results for current filter
    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="empty-state glass-card">
                <div class="empty-state-icon">🔍</div>
                <h3>לא נמצאו תיקים תואמים</h3>
                <p>נסה לשנות את הפילטרים או לחץ על <strong style="color:var(--accent-blue)">"הכל"</strong></p>
            </div>
        `;
        return;
    }

    filtered.forEach(client => {
        const card = document.createElement('div');
        card.className = 'client-card glass-card';
        card.onclick = () => openModal(client.id);

        const stockHoldings = client.holdings.filter(h => h.type === 'stock');
        const bondHoldings = client.holdings.filter(h => h.type === 'bond');

        const showStocks = activeFilters.asset === 'all' || activeFilters.asset === 'stocks';
        const showBonds = activeFilters.asset === 'all' || activeFilters.asset === 'bonds';

        // === Asset rows (stocks + bonds) ===
        let assetsHTML = '';
        if (showStocks) {
            stockHoldings.slice(0, 3).forEach(h => {
                const change = h.previousClose > 0 ? ((h.price - h.previousClose) / h.previousClose * 100) : 0;
                const changeClass = change >= 0 ? 'positive' : 'negative';
                const changeSign = change >= 0 ? '+' : '';
                const heName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
                const cardStockName = heName || h.ticker;
                const currSym = h.currency === 'ILS' ? '₪' : '$';
                assetsHTML += `
                    <div class="allocation-row">
                        <span class="allocation-label">
                            <span class="allocation-dot" style="background: var(--accent-blue)"></span>
                            ${cardStockName}${heName ? ` <span style="color:var(--text-muted);font-size:10px">${h.ticker}</span>` : ''}
                        </span>
                        <span class="allocation-value">
                            ${h.allocationPct.toFixed(1)}%
                            <small class="price-change ${changeClass}" style="font-size:10px; margin-right:4px">${changeSign}${change.toFixed(1)}%</small>
                            <small style="color:var(--text-muted);font-size:9px">${currSym}${formatNumber(h.price)}</small>
                        </span>
                    </div>`;
            });
            if (stockHoldings.length > 3) {
                assetsHTML += `<div class="allocation-row" style="color:var(--text-muted);font-size:11px">+${stockHoldings.length - 3} מניות נוספות</div>`;
            }
        }
        if (showBonds) {
            bondHoldings.slice(0, 2).forEach(h => {
                const bondCurrSym = h.currency === 'ILS' ? '₪' : '$';
                assetsHTML += `
                    <div class="allocation-row">
                        <span class="allocation-label">
                            <span class="allocation-dot" style="background: var(--accent-purple)"></span>
                            ${h.name.length > 20 ? h.name.slice(0, 20) + '...' : h.name}
                        </span>
                        <span class="allocation-value">${h.allocationPct.toFixed(1)}% <small style="color:var(--text-muted);font-size:9px">${bondCurrSym}${formatNumber(h.price)}</small></span>
                    </div>`;
            });
            if (bondHoldings.length > 2) {
                assetsHTML += `<div class="allocation-row" style="color:var(--text-muted);font-size:11px">+${bondHoldings.length - 2} אג"ח נוספות</div>`;
            }
        }

        // === Cash rows — ALWAYS show both USD and ILS ===
        let _cashUsd = client.cash?.usd || 0;
        let _cashIls = client.cash?.ils || 0;
        // Legacy fallback: if both buckets are 0 but cashBalance exists, show as USD
        if (_cashUsd === 0 && _cashIls === 0 && (client.cashBalance || 0) > 0) {
            _cashUsd = client.cashBalance;
        }
        const cashHTML = `
            <div class="allocation-row">
                <span class="allocation-label">
                    <span class="allocation-dot" style="background:var(--accent-green)"></span>
                    מזומן (USD)
                </span>
                <span class="allocation-value">${formatCurrency(_cashUsd, 'USD')}</span>
            </div>
            <div class="allocation-row">
                <span class="allocation-label">
                    <span class="allocation-dot" style="background:var(--accent-green)"></span>
                    מזומן (ILS)
                </span>
                <span class="allocation-value">${formatCurrency(_cashIls, 'ILS')}</span>
            </div>`;

        const totalStockPct = stockHoldings.reduce((s, h) => s + h.allocationPct, 0);
        const totalBondPct = bondHoldings.reduce((s, h) => s + h.allocationPct, 0);

        // Unified FX-aware return calculation
        const _pr = calcPortfolioReturn(client);
        const profit = _pr.profit;
        const returnPct = _pr.returnPct;

        // Detect "price not yet resolved" — use _livePriceResolved flag set by mapHolding / price-service
        const stockHoldingsWithCost = stockHoldings.filter(h => h.shares > 0 && h.costBasis > 0);
        const allPricesStale = stockHoldingsWithCost.length > 0 && stockHoldingsWithCost.every(h => !h._livePriceResolved);

        const profitSign = allPricesStale ? '' : (profit >= 0 ? '+' : '');

        // Return badge color
        const returnColor = allPricesStale ? '' : (returnPct >= 0 ? 'yield-positive' : 'yield-negative');

        card.innerHTML = `
                <div class="card-header">
                    <div class="card-header-start">
                        <h3 class="client-name">${client.name}</h3>
                        <span class="risk-badge ${client.risk}">${client.riskLabel}</span>
                    </div>
                    <div class="card-header-end">
                        <div class="card-view-toggle">
                            <button class="view-toggle-btn active" onclick="event.stopPropagation();" title="תרשים">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>
                            </button>
                            <button class="view-toggle-btn" onclick="event.stopPropagation(); openFullscreenChart(${client.id})" title="גרף ביצועים">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/></svg>
                            </button>
                        </div>
                        <div class="card-actions">
                            <button class="card-action-btn deposit" onclick="event.stopPropagation(); openMgmtModal('depositCash', clients.find(c=>c.id===${client.id}))" title="הפקד מזומן">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </button>
                            <button class="card-action-btn" onclick="event.stopPropagation(); openMgmtModal('editClient', clients.find(c=>c.id===${client.id}))" title="ערוך תיק">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                            </button>
                            <button class="card-action-btn delete" onclick="event.stopPropagation(); openMgmtModal('deleteClient', clients.find(c=>c.id===${client.id}))" title="מחק תיק">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="chart-container">
                        <canvas id="chart-${client.id}" data-render-key="${_cardRenderKey}"></canvas>
                    </div>
                    <div class="holdings-summary">
                        <div class="holdings-list">${assetsHTML}</div>
                        <div class="cash-section">${cashHTML}</div>
                    </div>
                </div>
                <div class="card-sparkline-section">
                    <div class="time-range-toggle">
                        <button class="time-range-btn" onclick="event.stopPropagation(); setCardTimeRange(${client.id}, '1m', this)">1M</button>
                        <button class="time-range-btn" onclick="event.stopPropagation(); setCardTimeRange(${client.id}, '3m', this)">3M</button>
                        <button class="time-range-btn" onclick="event.stopPropagation(); setCardTimeRange(${client.id}, '1y', this)">1Y</button>
                        <button class="time-range-btn active" onclick="event.stopPropagation(); setCardTimeRange(${client.id}, 'all', this)">All</button>
                    </div>
                    <div class="card-performance chart-wrapper-relative">
                        <button class="expand-btn" onclick="event.stopPropagation(); openFullscreenChart(${client.id})" title="הגדל גרף">&#x26F6;</button>
                        <div class="card-performance-chart">
                            <canvas id="perf-${client.id}" data-render-key="${_cardRenderKey}"></canvas>
                        </div>
                    </div>
                </div>
            <div class="card-footer">
                <div class="card-footer-stat">
                    <span class="card-footer-label">תשואה</span>
                    <span class="card-footer-value ${returnColor}">${allPricesStale ? '<span class="stat-stale">ממתין...</span>' : `${profitSign}${returnPct.toFixed(2)}%`}</span>
                </div>
                <div class="card-footer-stat card-footer-stat-end">
                    <span class="card-footer-label">שווי תיק</span>
                    <span class="card-footer-value">${formatCurrency(client.portfolioValue)}</span>
                </div>
            </div>
        `;

        grid.appendChild(card);

        // Create pie chart + performance sparkline (version-guarded)
        const renderKey = _cardRenderKey; // capture current version
        setTimeout(() => {
            // Stale callback — a newer renderClientCards() already ran
            if (renderKey !== _cardRenderKey) return;

            const ctx = document.getElementById(`chart-${client.id}`);
            if (!ctx) return;

            // Destroy any existing chart on this canvas (belt-and-suspenders)
            _safeDestroyChart(client.id);
            _destroyChartOnCanvas(ctx);
            _clearCanvas(ctx);

            // Handle zero-data: show placeholder ring with "fetching" message when all prices are stale,
            // or a "cash-only" ring when there are no holdings.
            const hasData = totalStockPct > 0 || totalBondPct > 0;
            if (!hasData && allPricesStale && stockHoldings.length > 0) {
                // Prices not yet fetched — show a "loading" placeholder ring
                ctx.parentElement.style.position = 'relative';
                const loadingMsg = document.createElement('div');
                loadingMsg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-muted);font-size:10px;text-align:center;pointer-events:none;';
                loadingMsg.textContent = 'טוען מחירים...';
                ctx.parentElement.appendChild(loadingMsg);
            }
            const chartData = hasData ? [totalStockPct, totalBondPct] : [1];
            const chartLabels = hasData ? ['מניות', 'אג"ח'] : (allPricesStale && stockHoldings.length > 0 ? ['טוען...'] : ['מזומן']);
            const chartBg = hasData ? ['#00e5ff', '#a855f7'] : ['rgba(255,255,255,0.08)'];
            const chartBorder = hasData ? ['#00b8d4', '#9333ea'] : ['rgba(255,255,255,0.15)'];

            charts[client.id] = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: chartLabels,
                    datasets: [{
                        data: chartData,
                        backgroundColor: chartBg,
                        borderColor: chartBorder,
                        borderWidth: 2,
                        hoverOffset: hasData ? 6 : 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    cutout: '55%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            enabled: hasData,
                            rtl: true,
                            textDirection: 'rtl',
                            callbacks: {
                                label: (ctx) => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%`
                            }
                        }
                    }
                }
            });

            // Performance sparkline — async to support synthetic fallback
            _renderCardSparkline(client, renderKey);
        }, 50);
    });
}

// ========== REFRESH DASHBOARD ==========

function refreshDashboard() {
    renderSummaryBar();
    renderExposureSection();
    renderClientCards();
}
