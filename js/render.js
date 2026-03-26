// ========== RENDER - DOM Rendering (Summary, Exposure, Client Cards) ==========

// ========== QUANTITY FORMATTING ==========

// Short notation: 1.5M, 250K, etc. One decimal only when needed.
function _formatShort(num) {
    if (num >= 1000000) {
        const m = num / 1000000;
        return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
    }
    if (num >= 1000) {
        const k = num / 1000;
        return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + 'K';
    }
    return num.toString();
}

// Display-only: returns HTML with vertical qty-container > qty-main + qty-suffix
// Uses toLocaleString for full comma-separated display — never truncates the number.
function formatAssetQuantity(qty) {
    if (qty == null || isNaN(qty)) return '<div class="qty-container" title="0"><span class="qty-main"><span class="qty-display">0</span></span></div>';
    const num = Number(qty);
    // Decimals: show only when non-zero; sub-1 values get up to 6 (crypto), others 2
    const decimals = num % 1 !== 0 ? (num < 1 ? 6 : 2) : 0;
    const formatted = num.toLocaleString('en-US', { maximumFractionDigits: decimals, useGrouping: true });
    const suffix = num >= 1000 ? `<span class="qty-suffix">(${_formatShort(num)})</span>` : '';
    return `<div class="qty-container" title="${num}"><span class="qty-main"><span class="qty-display">${formatted}</span></span>${suffix}</div>`;
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
            <h2>סקירת חשיפה כוללת</h2>
            <div class="empty-state">
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
        <h2>סקירת חשיפה כוללת</h2>
        <div class="exposure-grid">
            <div class="exposure-card">
                <h3>חלוקת נכסים</h3>
                <div class="exposure-bar">
                    <div class="exposure-bar-segment" style="width:${stockPct}%;background:${COLORS.neutral}">מניות ${stockPct.toFixed(1)}%</div>
                    <div class="exposure-bar-segment" style="width:${bondPct}%;background:${COLORS.bonds}">אג"ח ${bondPct.toFixed(1)}%</div>
                </div>
                <div class="exposure-legend">
                    <div class="exposure-legend-item"><span class="exposure-legend-dot" style="background:${COLORS.neutral}"></span>מניות: ${formatCurrency(exp.totalStocks)}</div>
                    <div class="exposure-legend-item"><span class="exposure-legend-dot" style="background:${COLORS.bonds}"></span>אג"ח: ${formatCurrency(exp.totalBonds)}</div>
                </div>
            </div>
            <div class="exposure-card">
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
                    borderColor: '#1e293b'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                cutout: '40%',
                plugins: {
                    legend: { position: 'right', rtl: true, labels: { color: '#f1f5f9', font: { size: 11, weight: '600' }, padding: 8, usePointStyle: true, pointStyleWidth: 10, boxWidth: 10 } },
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

    // Destroy any existing chart on this canvas
    _safeDestroyChart(`perf-${client.id}`);
    _destroyChartOnCanvas(perfCtx);
    _clearCanvas(perfCtx);
    perfCtx.style.display = '';

    const firstVal = hist[0]?.value || 0;
    const lastVal = hist[hist.length - 1]?.value || 0;
    const isPositive = lastVal >= firstVal;
    const lineColor = isPositive ? '#22c55e' : '#ef4444';
    const bgColor = isPositive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';

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
    if (!clients || clients.length === 0) {
        document.getElementById('summaryBar').innerHTML = `
            <div class="summary-main">
                <div class="summary-card-large"><div class="label">סך נכסים מנוהלים</div><div class="value" style="color: var(--color-neutral)">$0</div><div class="sub">0 תיקים פעילים</div></div>
                <div class="summary-card-large"><div class="label">רווח / הפסד כולל</div><div class="value price-change">$0</div><div class="sub">תשואה: 0.00%</div></div>
                <div class="summary-card-large"><div class="label">תיקים פעילים</div><div class="value" style="color: var(--text-primary)">0</div><div class="sub">גבוה: 0 | בינוני: 0 | נמוך: 0</div></div>
                <div class="summary-card-large"><div class="label">תשואה ממוצעת</div><div class="value price-change">0.00%</div><div class="sub">ממוצע משוקלל</div></div>
            </div>
        `;
        return;
    }
    const totalAUM = clients.reduce((sum, c) => sum + c.portfolioValue, 0);
    // Unified FX-aware profit/return — uses calcPortfolioReturn (clients.js)
    const allCostBasis = clients.reduce((s, c) => s + calcPortfolioReturn(c).totalCost, 0);
    const allCurrentValue = clients.reduce((s, c) => s + calcPortfolioReturn(c).totalValue, 0);
    const totalProfit = allCurrentValue - allCostBasis;
    const totalReturn = allCostBasis > 0 ? ((totalProfit) / allCostBasis * 100) : 0;

    // Global stale detection — if ALL stock holdings have unresolved prices
    const allStockHoldings = clients.flatMap(c => c.holdings.filter(h => h.type === 'stock' && h.shares > 0 && h.costBasis > 0));
    const globalAllStale = allStockHoldings.length > 0 && allStockHoldings.every(h => !h._livePriceResolved);

    const profitClass = globalAllStale ? 'neutral' : (totalProfit >= 0 ? 'positive' : 'negative');
    const profitSign = globalAllStale ? '' : (totalProfit >= 0 ? '+' : '');

    const highClients = clients.filter(c => c.risk === 'high');
    const medClients = clients.filter(c => c.risk === 'medium');
    const lowClients = clients.filter(c => c.risk === 'low');

    // Weighted average return across portfolios (based on invested capital)
    const avgReturn = allCostBasis > 0 ? clients.reduce((s, c) => {
        const r = calcPortfolioReturn(c);
        return s + r.returnPct * (r.totalCost / allCostBasis);
    }, 0) : 0;
    const avgClass = globalAllStale ? 'neutral' : (avgReturn >= 0 ? 'positive' : 'negative');
    const avgSign = globalAllStale ? '' : (avgReturn >= 0 ? '+' : '');

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
            <div class="summary-card-large">
                <div class="label">סך נכסים מנוהלים</div>
                <div class="value" style="color: var(--color-neutral)">${formatCurrency(totalAUM)}</div>
                <div class="sub">${clients.length} תיקים פעילים</div>
            </div>
            <div class="summary-card-large">
                <div class="label">רווח / הפסד כולל</div>
                <div class="value price-change ${profitClass}">${globalAllStale ? '<span style="color:var(--text-muted);font-size:14px">ממתין למחירים...</span>' : `${profitSign}${formatCurrency(Math.abs(totalProfit))}`}</div>
                <div class="sub">תשואה: ${globalAllStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `<span class="price-change ${profitClass}" style="font-weight:700">${profitSign}${totalReturn.toFixed(2)}%</span>`}</div>
            </div>
            <div class="summary-card-large">
                <div class="label">תיקים פעילים</div>
                <div class="value" style="color: var(--text-primary)">${clients.length}</div>
                <div class="sub">גבוה: ${highClients.length} | בינוני: ${medClients.length} | נמוך: ${lowClients.length}</div>
            </div>
            <div class="summary-card-large">
                <div class="label">תשואה ממוצעת</div>
                <div class="value price-change ${avgClass}">${globalAllStale ? '<span style="color:var(--text-muted);font-size:14px">ממתין...</span>' : `${avgSign}${avgReturn.toFixed(2)}%`}</div>
                <div class="sub">ממוצע משוקלל</div>
            </div>
        </div>
        <div class="summary-secondary">
            <div class="summary-card">
                <div class="label">סיכון גבוה</div>
                <div class="value" style="color: var(--risk-high)">${highClients.length} תיקים</div>
                <div class="sub">${formatCurrency(highClients.reduce((s, c) => s + c.portfolioValue, 0))} | ${groupReturn(highClients)}</div>
            </div>
            <div class="summary-card">
                <div class="label">סיכון בינוני</div>
                <div class="value" style="color: var(--risk-medium)">${medClients.length} תיקים</div>
                <div class="sub">${formatCurrency(medClients.reduce((s, c) => s + c.portfolioValue, 0))} | ${groupReturn(medClients)}</div>
            </div>
            <div class="summary-card">
                <div class="label">סיכון נמוך</div>
                <div class="value" style="color: var(--risk-low)">${lowClients.length} תיקים</div>
                <div class="sub">${formatCurrency(lowClients.reduce((s, c) => s + c.portfolioValue, 0))} | ${groupReturn(lowClients)}</div>
            </div>
        </div>
    `;
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
            <div class="empty-state">
                <div class="empty-state-icon">📊</div>
                <h3>אין תיקים להצגה</h3>
                <p>לחץ על <strong>"+ הוסף תיק"</strong> כדי להתחיל</p>
            </div>
        `;
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
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <h3>לא נמצאו תיקים תואמים</h3>
                <p>נסה לשנות את הפילטרים או לחץ על "הכל"</p>
            </div>
        `;
        return;
    }

    filtered.forEach(client => {
        const card = document.createElement('div');
        card.className = 'client-card';
        card.onclick = () => openModal(client.id);

        const stockHoldings = client.holdings.filter(h => h.type === 'stock');
        const bondHoldings = client.holdings.filter(h => h.type === 'bond');

        const showStocks = activeFilters.asset === 'all' || activeFilters.asset === 'stocks';
        const showBonds = activeFilters.asset === 'all' || activeFilters.asset === 'bonds';

        let holdingsHTML = '';
        if (showStocks) {
            stockHoldings.slice(0, 3).forEach(h => {
                const change = h.previousClose > 0 ? ((h.price - h.previousClose) / h.previousClose * 100) : 0;
                const changeClass = change >= 0 ? 'positive' : 'negative';
                const changeSign = change >= 0 ? '+' : '';
                const heName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
                const cardStockName = heName || h.ticker;
                const currSym = h.currency === 'ILS' ? '₪' : '$';
                holdingsHTML += `
                    <div class="allocation-row">
                        <span class="allocation-label">
                            <span class="allocation-dot" style="background: var(--accent-blue)"></span>
                            ${cardStockName}${heName ? ` <span style="color:var(--text-muted);font-size:10px">${h.ticker}</span>` : ''}
                        </span>
                        <span class="allocation-value">
                            ${h.allocationPct.toFixed(1)}%
                            <small class="price-change ${changeClass}" style="font-size:10px; margin-right:4px">${changeSign}${change.toFixed(1)}%</small>
                            <small style="color:var(--text-muted);font-size:9px">${currSym}${h.price.toFixed(0)}</small>
                        </span>
                    </div>`;
            });
            if (stockHoldings.length > 3) {
                holdingsHTML += `<div class="allocation-row" style="color:var(--text-muted);font-size:11px">+${stockHoldings.length - 3} מניות נוספות</div>`;
            }
        }
        if (showBonds) {
            bondHoldings.slice(0, 2).forEach(h => {
                const bondCurrSym = h.currency === 'ILS' ? '₪' : '$';
                holdingsHTML += `
                    <div class="allocation-row">
                        <span class="allocation-label">
                            <span class="allocation-dot" style="background: var(--accent-purple)"></span>
                            ${h.name.length > 20 ? h.name.slice(0, 20) + '...' : h.name}
                        </span>
                        <span class="allocation-value">${h.allocationPct.toFixed(1)}% <small style="color:var(--text-muted);font-size:9px">${bondCurrSym}${h.price.toFixed(0)}</small></span>
                    </div>`;
            });
            if (bondHoldings.length > 2) {
                holdingsHTML += `<div class="allocation-row" style="color:var(--text-muted);font-size:11px">+${bondHoldings.length - 2} אג"ח נוספות</div>`;
            }
        }

        // Cash balance rows (per currency, with legacy fallback)
        let _cashUsd = client.cash?.usd || 0;
        let _cashIls = client.cash?.ils || 0;
        // Legacy fallback: if both buckets are 0 but cashBalance exists, show as USD
        if (_cashUsd === 0 && _cashIls === 0 && (client.cashBalance || 0) > 0) {
            _cashUsd = client.cashBalance;
        }
        let _cashBorderAdded = false;
        if (_cashUsd > 0) {
            holdingsHTML += `
                <div class="allocation-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px">
                    <span class="allocation-label">
                        <span class="allocation-dot" style="background:var(--accent-green)"></span>
                        מזומן (USD)
                    </span>
                    <span class="allocation-value">${formatCurrency(_cashUsd, 'USD')}</span>
                </div>`;
            _cashBorderAdded = true;
        }
        if (_cashIls > 0) {
            holdingsHTML += `
                <div class="allocation-row" style="${!_cashBorderAdded ? 'border-top:1px solid var(--border);margin-top:4px;padding-top:4px' : ''}">
                    <span class="allocation-label">
                        <span class="allocation-dot" style="background:var(--accent-green)"></span>
                        מזומן (ILS)
                    </span>
                    <span class="allocation-value">${formatCurrency(_cashIls, 'ILS')}</span>
                </div>`;
        }

        const totalStockPct = stockHoldings.reduce((s, h) => s + h.allocationPct, 0);
        const totalBondPct = bondHoldings.reduce((s, h) => s + h.allocationPct, 0);

        // Unified FX-aware return calculation
        const _pr = calcPortfolioReturn(client);
        const profit = _pr.profit;
        const returnPct = _pr.returnPct;

        // Detect "price not yet resolved" — use _livePriceResolved flag set by mapHolding / price-service
        const stockHoldingsWithCost = stockHoldings.filter(h => h.shares > 0 && h.costBasis > 0);
        const allPricesStale = stockHoldingsWithCost.length > 0 && stockHoldingsWithCost.every(h => !h._livePriceResolved);

        const profitClass = allPricesStale ? 'neutral' : (profit >= 0 ? 'positive' : 'negative');
        const profitSign = allPricesStale ? '' : (profit >= 0 ? '+' : '');

        card.innerHTML = `
                <div class="card-header">
                    <span class="client-name">${client.name}</span>
                    <div style="display:flex;align-items:center;gap:6px">
                        <span class="risk-badge ${client.risk}">${client.riskLabel}</span>
                        <div class="card-actions">
                            <button class="card-action-btn deposit" onclick="event.stopPropagation(); openMgmtModal('depositCash', clients.find(c=>c.id===${client.id}))" title="הפקד מזומן">&#128176;</button>
                            <button class="card-action-btn" onclick="event.stopPropagation(); openMgmtModal('editClient', clients.find(c=>c.id===${client.id}))" title="ערוך תיק">&#9998;</button>
                            <button class="card-action-btn delete" onclick="event.stopPropagation(); openMgmtModal('deleteClient', clients.find(c=>c.id===${client.id}))" title="מחק תיק">&#128465;</button>
                        </div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="chart-container">
                        <canvas id="chart-${client.id}" data-render-key="${_cardRenderKey}"></canvas>
                    </div>
                    <div class="holdings-summary">
                        ${holdingsHTML}
                    </div>
                </div>
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
            <div class="card-footer">
                <div>
                    <div class="portfolio-label">שווי תיק</div>
                    <div class="portfolio-value">${formatCurrency(client.portfolioValue)}</div>
                </div>
                <div style="text-align: center;">
                    <div class="portfolio-label">רווח/הפסד</div>
                    <div class="price-change ${profitClass}" style="font-size:15px; font-weight:700">${allPricesStale ? '<span style="color:var(--text-muted);font-size:12px">ממתין למחירים...</span>' : `${profitSign}${formatCurrency(Math.abs(profit))}`}</div>
                </div>
                <div style="text-align: left;">
                    <div class="portfolio-label">תשואה משוכללת</div>
                    <div class="price-change ${profitClass}" style="font-size:15px; font-weight:700">${allPricesStale ? '<span style="color:var(--text-muted);font-size:12px">ממתין...</span>' : `${profitSign}${returnPct.toFixed(2)}%`}</div>
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
            const chartBg = hasData ? ['#3b82f6', '#a855f7'] : ['#334155'];
            const chartBorder = hasData ? ['#2563eb', '#9333ea'] : ['#475569'];

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
