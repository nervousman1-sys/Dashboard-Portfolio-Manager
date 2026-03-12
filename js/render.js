// ========== RENDER - DOM Rendering (Summary, Exposure, Client Cards) ==========

// ========== EXPOSURE ==========

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
                <div class="sector-chart-container">
                    <canvas id="sector-exposure-chart"></canvas>
                </div>
            </div>
        </div>
    `;

    // Sector doughnut chart
    setTimeout(() => {
        const ctx = document.getElementById('sector-exposure-chart');
        if (!ctx) return;
        if (charts['sector-exposure']) charts['sector-exposure'].destroy();
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
    const totalInvested = clients.reduce((sum, c) => sum + c.initialInvestment, 0);
    const totalProfit = totalAUM - totalInvested;
    // Weighted return on invested capital (all portfolios, excludes idle cash)
    const allCostBasis = clients.reduce((s, c) => s + c.holdings.reduce((s2, h) => s2 + h.costBasis, 0), 0);
    const allCurrentValue = clients.reduce((s, c) => s + c.holdings.reduce((s2, h) => s2 + h.value, 0), 0);
    const totalReturn = allCostBasis > 0 ? ((allCurrentValue - allCostBasis) / allCostBasis * 100) : 0;
    const profitClass = totalProfit >= 0 ? 'positive' : 'negative';
    const profitSign = totalProfit >= 0 ? '+' : '';

    const highClients = clients.filter(c => c.risk === 'high');
    const medClients = clients.filter(c => c.risk === 'medium');
    const lowClients = clients.filter(c => c.risk === 'low');

    // Weighted average return across portfolios (based on invested capital)
    const avgReturn = allCostBasis > 0 ? clients.reduce((s, c) => {
        const cb = c.holdings.reduce((s2, h) => s2 + h.costBasis, 0);
        const cv = c.holdings.reduce((s2, h) => s2 + h.value, 0);
        const r = cb > 0 ? ((cv - cb) / cb * 100) : 0;
        return s + r * (cb / allCostBasis);
    }, 0) : 0;
    const avgClass = avgReturn >= 0 ? 'positive' : 'negative';
    const avgSign = avgReturn >= 0 ? '+' : '';

    function groupReturn(group) {
        const cb = group.reduce((s, c) => s + c.holdings.reduce((s2, h) => s2 + h.costBasis, 0), 0);
        const cv = group.reduce((s, c) => s + c.holdings.reduce((s2, h) => s2 + h.value, 0), 0);
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
                <div class="value price-change ${profitClass}">${profitSign}${formatCurrency(Math.abs(totalProfit))}</div>
                <div class="sub">תשואה: <span class="price-change ${profitClass}" style="font-weight:700">${profitSign}${totalReturn.toFixed(2)}%</span></div>
            </div>
            <div class="summary-card-large">
                <div class="label">תיקים פעילים</div>
                <div class="value" style="color: var(--text-primary)">${clients.length}</div>
                <div class="sub">גבוה: ${highClients.length} | בינוני: ${medClients.length} | נמוך: ${lowClients.length}</div>
            </div>
            <div class="summary-card-large">
                <div class="label">תשואה ממוצעת</div>
                <div class="value price-change ${avgClass}">${avgSign}${avgReturn.toFixed(2)}%</div>
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

function renderClientCards() {
    const grid = document.getElementById('clientsGrid');
    grid.innerHTML = '';

    // Destroy existing charts
    Object.values(charts).forEach(c => c.destroy());
    charts = {};

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
        const returnPct = c.initialInvestment > 0 ? ((c.portfolioValue - c.initialInvestment) / c.initialInvestment * 100) : 0;
        if (activeFilters.returnMin !== null && returnPct < activeFilters.returnMin) return false;
        if (activeFilters.returnMax !== null && returnPct > activeFilters.returnMax) return false;
        return true;
    });

    // Sorting
    if (activeFilters.sort === 'return-high') {
        filtered.sort((a, b) => {
            const ra = (a.portfolioValue - a.initialInvestment) / a.initialInvestment;
            const rb = (b.portfolioValue - b.initialInvestment) / b.initialInvestment;
            return rb - ra;
        });
    } else if (activeFilters.sort === 'return-low') {
        filtered.sort((a, b) => {
            const ra = (a.portfolioValue - a.initialInvestment) / a.initialInvestment;
            const rb = (b.portfolioValue - b.initialInvestment) / b.initialInvestment;
            return ra - rb;
        });
    } else if (activeFilters.sort === 'size-high') {
        filtered.sort((a, b) => b.portfolioValue - a.portfolioValue);
    } else if (activeFilters.sort === 'size-low') {
        filtered.sort((a, b) => a.portfolioValue - b.portfolioValue);
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
                holdingsHTML += `
                    <div class="allocation-row">
                        <span class="allocation-label">
                            <span class="allocation-dot" style="background: var(--accent-blue)"></span>
                            ${h.ticker}
                        </span>
                        <span class="allocation-value">
                            ${h.allocationPct.toFixed(1)}%
                            <small class="price-change ${changeClass}" style="font-size:10px; margin-right:4px">${changeSign}${change.toFixed(1)}%</small>
                        </span>
                    </div>`;
            });
            if (stockHoldings.length > 3) {
                holdingsHTML += `<div class="allocation-row" style="color:var(--text-muted);font-size:11px">+${stockHoldings.length - 3} מניות נוספות</div>`;
            }
        }
        if (showBonds) {
            bondHoldings.slice(0, 2).forEach(h => {
                holdingsHTML += `
                    <div class="allocation-row">
                        <span class="allocation-label">
                            <span class="allocation-dot" style="background: var(--accent-purple)"></span>
                            ${h.name.length > 20 ? h.name.slice(0, 20) + '...' : h.name}
                        </span>
                        <span class="allocation-value">${h.allocationPct.toFixed(1)}%</span>
                    </div>`;
            });
            if (bondHoldings.length > 2) {
                holdingsHTML += `<div class="allocation-row" style="color:var(--text-muted);font-size:11px">+${bondHoldings.length - 2} אג"ח נוספות</div>`;
            }
        }

        // Cash balance row
        if (client.cashBalance > 0) {
            holdingsHTML += `
                <div class="allocation-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px">
                    <span class="allocation-label">
                        <span class="allocation-dot" style="background:var(--accent-green)"></span>
                        מזומן פנוי
                    </span>
                    <span class="allocation-value">${formatCurrency(client.cashBalance)}</span>
                </div>`;
        }

        const totalStockPct = stockHoldings.reduce((s, h) => s + h.allocationPct, 0);
        const totalBondPct = bondHoldings.reduce((s, h) => s + h.allocationPct, 0);

        const profit = client.portfolioValue - client.initialInvestment;
        // Weighted return on invested capital (holdings only, excludes idle cash)
        const investedCostBasis = client.holdings.reduce((s, h) => s + h.costBasis, 0);
        const investedCurrentValue = client.holdings.reduce((s, h) => s + h.value, 0);
        const investedProfit = investedCurrentValue - investedCostBasis;
        const returnPct = investedCostBasis > 0 ? (investedProfit / investedCostBasis * 100) : 0;
        const profitClass = profit >= 0 ? 'positive' : 'negative';
        const profitSign = profit >= 0 ? '+' : '';

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
                        <canvas id="chart-${client.id}"></canvas>
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
                        <canvas id="perf-${client.id}"></canvas>
                    </div>
                </div>
            <div class="card-footer">
                <div>
                    <div class="portfolio-label">שווי תיק</div>
                    <div class="portfolio-value">${formatCurrency(client.portfolioValue)}</div>
                </div>
                <div style="text-align: center;">
                    <div class="portfolio-label">רווח/הפסד</div>
                    <div class="price-change ${profitClass}" style="font-size:15px; font-weight:700">${profitSign}${formatCurrency(Math.abs(profit))}</div>
                </div>
                <div style="text-align: left;">
                    <div class="portfolio-label">תשואה משוכללת</div>
                    <div class="price-change ${profitClass}" style="font-size:15px; font-weight:700">${profitSign}${returnPct.toFixed(2)}%</div>
                </div>
            </div>
        `;

        grid.appendChild(card);

        // Create pie chart + performance sparkline
        setTimeout(() => {
            const ctx = document.getElementById(`chart-${client.id}`);
            if (!ctx) return;
            charts[client.id] = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['מניות', 'אג"ח'],
                    datasets: [{
                        data: [totalStockPct, totalBondPct],
                        backgroundColor: ['#3b82f6', '#a855f7'],
                        borderColor: ['#2563eb', '#9333ea'],
                        borderWidth: 2,
                        hoverOffset: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    cutout: '55%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            rtl: true,
                            textDirection: 'rtl',
                            callbacks: {
                                label: (ctx) => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%`
                            }
                        }
                    }
                }
            });

            // Performance sparkline
            const perfCtx = document.getElementById(`perf-${client.id}`);
            if (!perfCtx || !client.performanceHistory || client.performanceHistory.length === 0) return;
            const hist = client.performanceHistory;
            const isPositive = (hist[hist.length - 1]?.returnPct || 0) >= 0;
            const lineColor = isPositive ? '#22c55e' : '#ef4444';
            const bgColor = isPositive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';

            charts[`perf-${client.id}`] = new Chart(perfCtx, {
                type: 'line',
                data: {
                    labels: hist.map(p => p.date),
                    datasets: [{
                        data: hist.map(p => p.returnPct),
                        borderColor: lineColor,
                        backgroundColor: bgColor,
                        borderWidth: 1.5,
                        fill: true,
                        pointRadius: 0,
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { display: false },
                        y: {
                            display: false,
                            beginAtZero: false
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            rtl: true,
                            callbacks: {
                                title: (items) => items[0].label,
                                label: (ctx) => ` תשואה: ${ctx.parsed.y.toFixed(2)}%`
                            }
                        }
                    },
                    interaction: { intersect: false, mode: 'index' }
                }
            });
        }, 50);
    });
}

// ========== REFRESH DASHBOARD ==========

function refreshDashboard() {
    renderSummaryBar();
    renderExposureSection();
    renderClientCards();
}
