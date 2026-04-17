// ========== MODALS - Client Detail Modal, CRUD Management, Reports ==========

// Transaction history is now fetched from Supabase (supaFetchTransactions)

function switchModalTab(tabName) {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.modal-tab-content').forEach(t => t.classList.remove('active'));
    document.querySelector(`.modal-tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    // Update URL with current tab
    if (typeof updateURLState === 'function' && currentModalClientId) {
        updateURLState({ client: currentModalClientId, tab: tabName });
    }

    const client = clients.find(c => c.id === currentModalClientId);
    if (!client) return;

    // Render sector chart on demand
    if (tabName === 'sectors') {
        setTimeout(() => renderModalSectorChart(client), 50);
    }

    // Fresh-fetch transactions from Supabase every time the tab is opened
    if (tabName === 'transactions') {
        const tbody = document.querySelector('#tab-transactions .holdings-table tbody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px">
                <div class="trans-skeleton"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
                <div style="color:var(--text-muted);font-size:12px;margin-top:8px">טוען היסטוריית פעולות...</div>
            </td></tr>`;
        }
        _loadTransactionHistory(client.id);
    }
}

async function openModal(clientId) {
    currentModalClientId = clientId;
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    // Save state to URL
    if (typeof updateURLState === 'function') {
        updateURLState({ client: clientId, tab: 'overview' });
    }

    const stockHoldings = client.holdings.filter(h => h.type === 'stock');
    const bondHoldings = client.holdings.filter(h => h.type === 'bond');
    const totalStockValue = stockHoldings.reduce((s, h) => s + h.value, 0);
    const totalBondValue = bondHoldings.reduce((s, h) => s + h.value, 0);
    // Unified FX-aware return calculation (same function used by dashboard cards)
    const _fxR = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    const _pReturn = calcPortfolioReturn(client);
    const totalProfit = _pReturn.profit;
    const totalReturnPct = _pReturn.returnPct;
    const totalProfitSign = totalProfit >= 0 ? '+' : '';

    // ── Risk & allocation metrics (reuses _calcListMetrics logic) ──
    const _rm = (typeof _calcListMetrics === 'function') ? _calcListMetrics(client) : null;

    // Holdings table — columns: נכס, מחיר קנייה, מחיר נוכחי, כמות, שווי כולל, שינוי יומי %, רווח $, תשואה %, פעולות
    let holdingsRows = '';
    let totalHoldingsValue = 0;   // FX-converted to USD for correct cross-currency totals
    let totalHoldingsPnL = 0;     // FX-converted to USD
    client.holdings.forEach((h, hIdx) => {
        const isStale = h.type === 'stock' && !h._livePriceResolved;
        const change = h.previousClose > 0 ? ((h.price - h.previousClose) / h.previousClose * 100) : 0;
        const changeClass = change >= 0 ? 'positive' : 'negative';
        const changeSign = change >= 0 ? '+' : '';
        const holdingProfit = h.value - h.costBasis;
        const holdingReturn = h.costBasis > 0 ? (holdingProfit / h.costBasis * 100) : 0;
        const holdingProfitClass = holdingProfit >= 0 ? 'positive' : 'negative';
        const holdingProfitSign = holdingProfit >= 0 ? '+' : '';
        const currSymbol = h.currency === 'ILS' ? '₪' : '$';
        const purchasePrice = h.shares > 0 ? (h.costBasis / h.shares) : 0;
        const heName = typeof getHebrewName === 'function' ? getHebrewName(h) : '';
        // Hebrew name is PRIMARY when available; ticker/English name shown as secondary
        const primaryName = heName || (h.type === 'stock' ? h.ticker : h.name);
        const secondaryName = heName ? (h.type === 'stock' ? h.ticker : '') : '';
        const subName = secondaryName ? `<span style="font-size:10px;color:var(--text-muted)">${secondaryName}</span>` : '';
        const _hFx = _fxR(h.currency);
        totalHoldingsValue += h.value * _hFx;
        totalHoldingsPnL += isStale ? 0 : holdingProfit * _hFx;
        holdingsRows += `<tr>
            <td>
                <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:var(--text-primary)">${primaryName}</span>
                    ${subName}
                    <span class="asset-type-badge ${h.type}" style="font-size:10px;width:fit-content">${h.typeLabel}</span>
                </div>
            </td>
            <td>${formatPrice(purchasePrice)} ${currSymbol}</td>
            <td>${isStale ? `<span style="color:var(--text-muted)" title="ממתין לעדכון מחיר מהשוק">${formatPrice(h.price)} ${currSymbol}</span>` : `${formatPrice(h.price)} ${currSymbol}`}</td>
            <td data-label="כמות" class="col-quantity">${formatAssetQuantity(h.shares)}</td>
            <td style="font-weight:600;color:var(--text-primary)">${formatCurrency(h.value, h.currency)}</td>
            <td class="price-change ${isStale ? '' : changeClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${changeSign}${change.toFixed(2)}%`}</td>
            <td class="price-change ${isStale ? '' : holdingProfitClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${holdingProfitSign}${formatCurrency(Math.abs(holdingProfit), h.currency)}`}</td>
            <td class="price-change ${isStale ? '' : holdingProfitClass}" style="font-weight:700">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${holdingProfitSign}${holdingReturn.toFixed(2)}%`}</td>
            <td>
                <button class="holding-action-btn sell" onclick="openMgmtModal('sellHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">מכור</button>
                <button class="holding-action-btn" onclick="openMgmtModal('editHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">ערוך</button>
                <button class="holding-action-btn delete" onclick="openMgmtModal('removeHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">הסר</button>
            </td>
        </tr>`;
    });

    // Summary footer row
    const totalPnLClass = totalHoldingsPnL >= 0 ? 'positive' : 'negative';
    const totalPnLSign = totalHoldingsPnL >= 0 ? '+' : '';
    const totalReturnPctHoldings = _pReturn.totalCost > 0 ? (totalHoldingsPnL / _pReturn.totalCost * 100) : 0;
    const holdingsFooter = `<tr class="holdings-footer-row">
        <td style="font-weight:700;color:var(--text-primary)">סה"כ</td>
        <td></td>
        <td></td>
        <td></td>
        <td style="font-weight:700;color:var(--text-primary)">${formatCurrency(totalHoldingsValue)}</td>
        <td></td>
        <td class="price-change ${totalPnLClass}" style="font-weight:700">${totalPnLSign}${formatCurrency(Math.abs(totalHoldingsPnL))}</td>
        <td class="price-change ${totalPnLClass}" style="font-weight:700">${totalPnLSign}${totalReturnPctHoldings.toFixed(2)}%</td>
        <td></td>
    </tr>`;

    // Sector breakdown table
    const sectorData = {};
    stockHoldings.forEach(h => { const s = h.sector || 'Other'; sectorData[s] = (sectorData[s] || 0) + h.value; });
    const sortedSectors = Object.entries(sectorData).sort((a, b) => b[1] - a[1]);
    let sectorRows = '';
    sortedSectors.forEach(([sector, value]) => {
        const pct = (value / client.portfolioValue * 100).toFixed(1);
        const color = SECTOR_COLORS[sector] || '#64748b';
        sectorRows += `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-left:6px"></span>${sector}</td><td>${formatCurrency(value)}</td><td>${pct}%</td></tr>`;
    });

    // Transaction history — rendered asynchronously (does NOT block modal open)
    // Skeleton placeholder is shown immediately; real data injected after fetch.
    const transRows = `<tr id="trans-loading-row"><td colspan="7" style="text-align:center;padding:32px">
        <div class="trans-skeleton">
            <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
        </div>
        <div style="color:var(--text-muted);font-size:12px;margin-top:8px">טוען היסטוריית פעולות...</div>
    </td></tr>`;

    document.getElementById('modalContent').innerHTML = `
        <div class="modal-header">
            <div style="display:flex;align-items:center;gap:12px">
                <div>
                    <h2>${client.name}</h2>
                    <span class="risk-badge ${client.risk}" style="margin-top:6px;display:inline-block">${client.riskLabel}</span>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="filter-btn" style="color:var(--accent-green);border-color:rgba(34,197,94,0.3)" onclick="openMgmtModal('depositCash', clients.find(c=>c.id===${client.id}))">הפקד מזומן</button>
                <button class="filter-btn" onclick="openMgmtModal('editClient', clients.find(c=>c.id===${client.id}))">ערוך תיק</button>
                <button class="filter-btn" style="color:var(--accent-red);border-color:rgba(239,68,68,0.3)" onclick="openMgmtModal('deleteClient', clients.find(c=>c.id===${client.id}))">מחק תיק</button>
                <button class="filter-btn" onclick="generateReport(${client.id})">הפק דוח</button>
                <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
        </div>
        <div class="modal-tab-bar">
            <button class="modal-tab active" data-tab="overview" onclick="switchModalTab('overview')">סקירה כללית</button>
            <button class="modal-tab" data-tab="holdings" onclick="switchModalTab('holdings')">נכסים</button>
            <button class="modal-tab" data-tab="sectors" onclick="switchModalTab('sectors')">סקטורים</button>
            <button class="modal-tab" data-tab="transactions" onclick="switchModalTab('transactions')">היסטוריית פעולות</button>
        </div>
        <div class="modal-body">
            <!-- Tab: Overview -->
            <div class="modal-tab-content active" id="tab-overview">
                <!-- ═══ HERO — Portfolio Value (top) + KPI Cards (bottom) ═══ -->
                <div class="ov-hero-block">
                    <div class="ov-hero-top">
                        <span class="ov-hero-label">שווי תיק כולל</span>
                        <span class="ov-hero-value">${formatCurrency(client.portfolioValue)}</span>
                    </div>
                    <div class="ov-hero-sep"></div>
                    <div class="ov-hero-kpis">
                        <div class="ov-kpi-card">
                            <span class="ov-kpi-label">רווח/הפסד</span>
                            <span class="ov-kpi-value ${totalProfit >= 0 ? 'val-positive' : 'val-negative'}">${totalProfitSign}${formatCurrency(Math.abs(totalProfit))}</span>
                        </div>
                        <div class="ov-kpi-card">
                            <span class="ov-kpi-label">תשואה</span>
                            <span class="ov-kpi-value ${totalProfit >= 0 ? 'val-positive' : 'val-negative'}">${totalProfitSign}${totalReturnPct.toFixed(2)}%</span>
                        </div>
                        <div class="ov-kpi-card">
                            <span class="ov-kpi-label">P&L יומי</span>
                            <span class="ov-kpi-value ${_rm && _rm.dailyPnl >= 0 ? 'val-positive' : 'val-negative'}">${_rm ? (_rm.dailyPnl >= 0 ? '+' : '') + formatCurrency(Math.abs(_rm.dailyPnl)) : '—'}</span>
                        </div>
                    </div>
                </div>

                <!-- ═══ TWO-PANEL GRID: Allocation + Risk ═══ -->
                <div class="ov-panels">
                    <!-- Panel: Allocation -->
                    <div class="ov-panel">
                        <div class="ov-panel-title">הרכב תיק</div>
                        <div class="ov-panel-grid cols-3">
                            <div class="ov-cell">
                                <div class="ov-cell-label">מניות</div>
                                <div class="ov-cell-value">${formatCurrency(totalStockValue)}</div>
                                <div class="ov-cell-bar"><div class="ov-cell-bar-fill" style="width:${_rm ? _rm.marketExposure : 0}%;background:#00e5ff"></div></div>
                                <div class="ov-cell-sub">${_rm ? _rm.marketExposure + '%' : ''}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">אג"ח</div>
                                <div class="ov-cell-value">${formatCurrency(totalBondValue)}</div>
                                <div class="ov-cell-bar"><div class="ov-cell-bar-fill" style="width:${_rm ? _rm.bondExposure : 0}%;background:#a78bfa"></div></div>
                                <div class="ov-cell-sub">${_rm ? _rm.bondExposure + '%' : ''}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">מזומן</div>
                                <div class="ov-cell-value">${formatCurrency((client.cash?.usd || 0) + (client.cash?.ils || 0))}</div>
                                <div class="ov-cell-bar"><div class="ov-cell-bar-fill" style="width:${_rm ? (100 - _rm.marketExposure - _rm.bondExposure) : 0}%;background:#00ff94"></div></div>
                                <div class="ov-cell-sub">${_rm ? (100 - _rm.marketExposure - _rm.bondExposure).toFixed(1) + '%' : ''}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">השקעה ראשונית</div>
                                <div class="ov-cell-value">${formatCurrency(client.initialInvestment)}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">נכסים</div>
                                <div class="ov-cell-value">${_rm ? _rm.holdingsCount : client.holdings.length}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">ריכוזיות</div>
                                <div class="ov-cell-value ${_rm && _rm.concentration > 50 ? 'val-warn' : ''}">${_rm ? _rm.concentration.toFixed(1) + '%' : '—'}</div>
                                <div class="ov-cell-sub">${_rm && _rm.topHolding ? _rm.topHolding : ''}</div>
                            </div>
                        </div>
                    </div>
                    <!-- Panel: Risk -->
                    <div class="ov-panel">
                        <div class="ov-panel-title">מדדי סיכון</div>
                        <div class="ov-panel-grid cols-3">
                            <div class="ov-cell ov-cell-risk-score">
                                <div class="ov-cell-label">ציון סיכון</div>
                                <div class="ov-cell-value ${_rm && _rm.riskScore >= 75 ? 'val-negative' : _rm && _rm.riskScore >= 40 ? 'val-warn' : 'val-positive'}">${_rm ? _rm.riskScore : '—'}<span class="ov-cell-dim">/100</span></div>
                                <div class="ov-cell-bar"><div class="ov-cell-bar-fill" style="width:${_rm ? _rm.riskScore : 0}%;background:${_rm && _rm.riskScore >= 75 ? '#ff4d4d' : _rm && _rm.riskScore >= 40 ? '#facc15' : '#00ff94'}"></div></div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">סטיית תקן</div>
                                <div class="ov-cell-value ${_rm && _rm.stdDev !== '—' && parseFloat(_rm.stdDev) > 15 ? 'val-warn' : ''}">${_rm && _rm.stdDev !== '—' ? _rm.stdDev + '%' : '—'}</div>
                                <div class="ov-cell-sub">חודשית</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">Max Drawdown</div>
                                <div class="ov-cell-value ${_rm && _rm.maxDD !== '—' && parseFloat(_rm.maxDD) < 0 ? 'val-negative' : ''}">${_rm && _rm.maxDD !== '—' ? _rm.maxDD + '%' : '—'}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">Sharpe</div>
                                <div class="ov-cell-value ${_rm && _rm.sharpe !== '—' ? (parseFloat(_rm.sharpe) >= 1 ? 'val-positive' : parseFloat(_rm.sharpe) >= 0 ? 'val-warn' : 'val-negative') : ''}">${_rm ? _rm.sharpe : '—'}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">Sortino</div>
                                <div class="ov-cell-value ${_rm && _rm.sortino !== '—' ? (parseFloat(_rm.sortino) >= 1.5 ? 'val-positive' : parseFloat(_rm.sortino) >= 0 ? 'val-warn' : 'val-negative') : ''}">${_rm ? _rm.sortino : '—'}</div>
                            </div>
                            <div class="ov-cell">
                                <div class="ov-cell-label">VaR 95%</div>
                                <div class="ov-cell-value ${_rm && _rm.VaR > 0 ? 'val-negative' : ''}">${_rm && _rm.VaR > 0 ? '-' + formatCurrency(_rm.VaR) : '—'}</div>
                                <div class="ov-cell-sub">יומי</div>
                            </div>
                        </div>
                        ${_rm && !_rm.hasHistory ? '<div class="ov-panel-footnote">* מבוסס על הרכב תיק — אין היסטוריה</div>' : ''}
                    </div>
                </div>

                <!-- ═══ CURRENCY EXPOSURE — full-width row ═══ -->
                <div class="ov-currency-bar">
                    <div class="ov-curbar-side">
                        <span class="ov-curbar-symbol">$</span>
                        <span class="ov-curbar-label">USD</span>
                        <span class="ov-curbar-pct">${_rm ? _rm.usdExposurePct : 50}%</span>
                    </div>
                    <div class="ov-curbar-track">
                        <div class="ov-curbar-fill" style="width:${_rm ? _rm.usdExposurePct : 50}%"></div>
                    </div>
                    <div class="ov-curbar-side">
                        <span class="ov-curbar-pct">${_rm ? _rm.ilsExposurePct : 50}%</span>
                        <span class="ov-curbar-label">ILS</span>
                        <span class="ov-curbar-symbol">₪</span>
                    </div>
                </div>

                <!-- ═══ FULL-WIDTH PERFORMANCE CHART ═══ -->
                <div class="ov-chart-section">
                    <div class="modal-performance-container chart-wrapper-relative">
                        <button class="expand-btn" onclick="openFullscreenChart(currentModalClientId)" title="הגדל גרף">&#x26F6;</button>
                        <div class="perf-chart-header">
                            <div class="perf-time-range">
                                <button class="time-btn" onclick="setModalPerfRange('1d', this)">1D</button>
                                <button class="time-btn" onclick="setModalPerfRange('5d', this)">5D</button>
                                <button class="time-btn" onclick="setModalPerfRange('1m', this)">1M</button>
                                <button class="time-btn" onclick="setModalPerfRange('6m', this)">6M</button>
                                <button class="time-btn" onclick="setModalPerfRange('ytd', this)">YTD</button>
                                <button class="time-btn active" onclick="setModalPerfRange('1y', this)">1Y</button>
                                <button class="time-btn" onclick="setModalPerfRange('5y', this)">5Y</button>
                                <button class="time-btn" onclick="setModalPerfRange('max', this)">Max</button>
                            </div>
                            <div class="perf-benchmarks">
                                <button class="benchmark-toggle-btn" onclick="toggleBenchmarkPanel(this)">השוואה למדד</button>
                                <div class="benchmark-options" style="display:none">
                                    <button class="benchmark-btn" onclick="toggleModalBenchmark('SPY', this)">S&P 500</button>
                                    <button class="benchmark-btn" onclick="toggleModalBenchmark('QQQ', this)">Nasdaq 100</button>
                                    <button class="benchmark-btn" onclick="toggleModalBenchmark('DIA', this)">Dow Jones</button>
                                    <button class="benchmark-btn" onclick="toggleModalBenchmark('IWM', this)">Russell 2000</button>
                                    <button class="benchmark-btn" onclick="toggleModalBenchmark('TA125.TA', this)">TA-125</button>
                                    <button class="benchmark-btn" onclick="toggleModalBenchmark('TA35.TA', this)">TA-35</button>
                                </div>
                                <button class="display-mode-btn active-percent" onclick="toggleChartDisplayMode(this)" title="% / $">%</button>
                            </div>
                        </div>
                        <canvas id="modal-perf-chart"></canvas>
                    </div>
                </div>
                <!-- Hidden donut canvas for sectors tab data (still needed for chart init) -->
                <div style="display:none"><canvas id="modal-chart"></canvas></div>
            </div>
            <!-- Tab: Holdings -->
            <div class="modal-tab-content" id="tab-holdings">
                <button class="add-asset-btn" onclick="openMgmtModal('addHolding', clients.find(c=>c.id===${client.id}))">+ הוסף נכס חדש</button>
                <div class="holdings-table-wrapper">
                <table class="holdings-table">
                    <thead><tr><th>נכס</th><th class="col-price">מחיר קנייה</th><th class="col-price">מחיר נוכחי</th><th class="col-qty-header">כמות</th><th>שווי כולל</th><th class="col-pct">שינוי יומי</th><th>רווח/הפסד</th><th class="col-pct">תשואה</th><th>פעולות</th></tr></thead>
                    <tbody>${holdingsRows}${holdingsFooter}</tbody>
                </table>
                </div>
            </div>
            <!-- Tab: Sectors -->
            <div class="modal-tab-content" id="tab-sectors">
                <div class="sectors-layout">
                    <div class="sectors-chart-wrap"><canvas id="modal-sector-chart"></canvas></div>
                    <div class="sectors-table-wrap"><table class="sector-table"><thead><tr><th>סקטור</th><th>שווי</th><th>אחוז</th></tr></thead><tbody>${sectorRows}</tbody></table></div>
                </div>
            </div>
            <!-- Tab: Transactions -->
            <div class="modal-tab-content" id="tab-transactions">
                <div class="holdings-table-wrapper">
                <table class="holdings-table">
                    <thead><tr><th>תאריך</th><th>פעולה</th><th>נכס</th><th>כמות</th><th>מחיר</th><th>סה"כ</th><th>רווח ממומש</th></tr></thead>
                    <tbody>${transRows}</tbody>
                </table>
                </div>
            </div>
        </div>
    `;

    document.getElementById('modalOverlay').classList.add('active');

    // Create modal charts
    setTimeout(() => {
        // Doughnut - allocation
        const ctx = document.getElementById('modal-chart');
        if (ctx) {
            _destroyChartOnCanvas(ctx);
            _clearCanvas(ctx);

            const totalValue = client.holdings.reduce((s, h) => s + h.value, 0);
            const hasHoldings = client.holdings.length > 0 && totalValue > 0;

            if (hasHoldings) {
                const labels = client.holdings.map(h => h.type === 'stock' ? h.ticker : h.name.slice(0, 15));
                const data = client.holdings.map(h => h.allocationPct);
                const colors = client.holdings.map(h =>
                    h.type === 'stock' ? (SECTOR_COLORS[h.sector] || COLORS.neutral) : COLORS.bonds
                );
                new Chart(ctx, {
                    type: 'doughnut',
                    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#1e293b' }] },
                    options: {
                        responsive: true, maintainAspectRatio: true, cutout: '45%',
                        plugins: {
                            legend: { position: 'bottom', rtl: true, labels: { color: '#94a3b8', font: { size: 10 }, padding: 6, usePointStyle: true, pointStyleWidth: 6 } },
                            tooltip: { rtl: true, callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%` } }
                        }
                    }
                });
            } else {
                // Empty/cash-only portfolio — show placeholder ring
                new Chart(ctx, {
                    type: 'doughnut',
                    data: { labels: ['אין נתונים'], datasets: [{ data: [1], backgroundColor: ['#334155'], borderColor: ['#475569'], borderWidth: 2 }] },
                    options: {
                        responsive: true, maintainAspectRatio: true, cutout: '45%',
                        plugins: { legend: { display: false }, tooltip: { enabled: false } }
                    }
                });
            }
        }

        // Performance chart — uses unified renderer from charts.js
        _modalPerfRange = '1y';
        _modalPerfBenchmarks = [];
        if (_modalPerfChartInstance) { _modalPerfChartInstance.destroy(); _modalPerfChartInstance = null; }

        // Render after a single rAF so the browser has committed the flex layout.
        // renderPerformanceChart() reads canvas.offsetHeight to set an explicit CSS height
        // before Chart.js initializes — this prevents the "black canvas" bug where Chart.js
        // uses parentElement.clientHeight (full container) instead of the flex-allocated height.
        const _perfCanvas = document.getElementById('modal-perf-chart');
        if (_perfCanvas) {
            requestAnimationFrame(() => {
                renderPerformanceChart('modal-perf-chart', client.id, '1y', []).then(inst => {
                    _modalPerfChartInstance = inst;
                });
            });
        }
    }, 300);

    // ── Async: Fetch transaction history from Supabase (non-blocking) ──
    _loadTransactionHistory(client.id);
}

// Fetches transactions and injects rows into the already-rendered modal
async function _loadTransactionHistory(portfolioId) {
    const tbody = document.querySelector('#tab-transactions .holdings-table tbody');
    if (!tbody) return;

    try {
        const transactions = supabaseConnected ? await supaFetchTransactions(portfolioId) : [];

        // Table doesn't exist in Supabase — show setup instructions with retry
        if (transactions.unavailable) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px">
                <div style="color:var(--accent-red);font-weight:600;margin-bottom:8px">טבלת פעולות אינה זמינה</div>
                <div style="color:var(--text-muted);font-size:13px;margin-bottom:12px;line-height:1.6">
                    יש ליצור את הטבלה ב-Supabase SQL Editor.<br>
                    פתח את הקונסול (F12) להוראות מלאות.
                </div>
                <button onclick="_retryTransactionLoad(${portfolioId})" style="
                    background:var(--accent-blue);color:#fff;border:none;border-radius:8px;
                    padding:8px 20px;cursor:pointer;font-size:13px;font-weight:600;
                ">נסה שוב</button>
            </td></tr>`;
            return;
        }

        if (transactions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">אין היסטוריית פעולות</td></tr>';
            return;
        }

        let rows = '';
        transactions.forEach(t => {
            const dateStr = t.date.toLocaleDateString('he-IL');
            const TYPE_LABEL_MAP = { buy: 'קנייה', sell: 'מכירה', deposit: 'הפקדה', withdraw: 'משיכה', edit_settings: 'עדכון הגדרות', edit_holding: 'עריכת נכס' };
            const typeLabel = TYPE_LABEL_MAP[t.type] || t.type;
            let pnlCell = '-';
            if (t.type === 'sell' && t.realizedPnl !== null && t.realizedPnl !== undefined) {
                const pnlClass = t.realizedPnl >= 0 ? 'positive' : 'negative';
                const pnlSign = t.realizedPnl >= 0 ? '+' : '';
                pnlCell = `<span class="price-change ${pnlClass}">${pnlSign}${formatCurrency(Math.abs(t.realizedPnl))}</span>`;
            } else if (t.description) {
                pnlCell = `<span style="color:var(--text-muted);font-size:12px">${t.description}</span>`;
            }
            const currSym = t.currency === 'ILS' ? '₪' : '$';
            const sharesDisplay = t.shares > 0 ? Number(t.shares).toLocaleString('en-US') : '-';
            const priceDisplay = t.price > 0 ? `${formatPrice(t.price)} ${currSym}` : '-';
            const totalDisplay = t.total > 0 ? formatCurrency(t.total, t.currency) : '-';
            rows += `<tr>
                <td>${dateStr}</td>
                <td><span class="transaction-badge ${t.type}">${typeLabel}</span></td>
                <td style="font-weight:600;color:var(--text-primary)">${t.name || (t.ticker !== '-' ? t.ticker : '')}</td>
                <td>${sharesDisplay}</td>
                <td>${priceDisplay}</td>
                <td style="font-weight:600">${totalDisplay}</td>
                <td>${pnlCell}</td>
            </tr>`;
        });
        tbody.innerHTML = rows;
    } catch (e) {
        console.warn('[Modal] Transaction fetch failed:', e.message);
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px">
            <div style="color:var(--accent-red);margin-bottom:8px">שגיאה בטעינת היסטוריית פעולות</div>
            <button onclick="_retryTransactionLoad(${portfolioId})" style="
                background:var(--accent-blue);color:#fff;border:none;border-radius:8px;
                padding:8px 16px;cursor:pointer;font-size:13px;
            ">נסה שוב</button>
        </td></tr>`;
    }
}

// Retry handler for the "try again" button in the transactions tab
async function _retryTransactionLoad(portfolioId) {
    const tbody = document.querySelector('#tab-transactions .holdings-table tbody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px">
            <div class="trans-skeleton"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>
            <div style="color:var(--text-muted);font-size:12px;margin-top:8px">מנסה להתחבר מחדש...</div>
        </td></tr>`;
    }
    // Force re-probe then reload
    await _probeTransactionsTable(true);
    await _loadTransactionHistory(portfolioId);
}

function closeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('modalOverlay').classList.remove('active');
    currentModalClientId = null;
    // Clear URL state
    if (typeof clearURLState === 'function') clearURLState();
}

// ========== REPORTS ==========

function generateReport(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    const _rpt = calcPortfolioReturn(client);
    const totalProfit = _rpt.profit;
    const totalReturn = _rpt.returnPct;
    const profitSign = totalProfit >= 0 ? '+' : '';

    // Period returns
    function getPeriodReturn(months) {
        if (!client.performanceHistory || client.performanceHistory.length < 2) return 'N/A';
        const hist = filterHistoryByRange(client.performanceHistory, months <= 1 ? '1m' : months <= 3 ? '3m' : '1y');
        if (hist.length < 2) return 'N/A';
        const startVal = hist[0].value;
        const endVal = hist[hist.length - 1].value;
        const ret = ((endVal - startVal) / startVal * 100);
        return (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%';
    }

    // Holdings table
    let holdingsTableHTML = client.holdings.map(h => {
        const profit = h.value - h.costBasis;
        const ret = h.costBasis > 0 ? (profit / h.costBasis * 100) : 0;
        const rptHeName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
        const rptName = rptHeName || (h.type === 'stock' ? h.ticker : h.name);
        return `<tr><td>${rptName}</td><td>${h.type === 'stock' ? 'מניה' : 'אג"ח'}</td><td>${h.allocationPct.toFixed(1)}%</td><td>${formatCurrency(h.value, h.currency)}</td><td style="color:${ret >= 0 ? 'green' : 'red'}">${(ret >= 0 ? '+' : '') + ret.toFixed(2)}%</td></tr>`;
    }).join('');

    const dateStr = new Date().toLocaleDateString('he-IL');

    // Close modal
    document.getElementById('modalOverlay').classList.remove('active');

    // Hide main UI
    document.querySelector('.header').style.display = 'none';
    document.querySelector('.summary-bar').style.display = 'none';
    document.querySelector('.filters').style.display = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display = 'none';

    const reportView = document.getElementById('reportView');
    reportView.classList.add('active');
    reportView.innerHTML = `
        <button class="report-back-btn" onclick="closeReport()">חזור לדשבורד</button>
        <div class="report-header">
            <h1>דוח תיק השקעות</h1>
            <p>${client.name} | תאריך: ${dateStr} | פרופיל סיכון: ${client.riskLabel}</p>
        </div>
        <div class="report-section">
            <h3>סיכום ביצועים</h3>
            <div class="report-stats-grid">
                <div class="report-stat"><div class="label">שווי תיק</div><div class="value">${formatCurrency(client.portfolioValue)}</div></div>
                <div class="report-stat"><div class="label">השקעה ראשונית</div><div class="value">${formatCurrency(client.initialInvestment)}</div></div>
                <div class="report-stat"><div class="label">רווח/הפסד</div><div class="value" style="color:${totalProfit >= 0 ? 'green' : 'red'}">${profitSign}${formatCurrency(Math.abs(totalProfit))}</div></div>
                <div class="report-stat"><div class="label">תשואה כוללת</div><div class="value" style="color:${totalReturn >= 0 ? 'green' : 'red'}">${profitSign}${totalReturn.toFixed(2)}%</div></div>
                <div class="report-stat"><div class="label">תשואה חודש</div><div class="value">${getPeriodReturn(1)}</div></div>
                <div class="report-stat"><div class="label">תשואה שנה</div><div class="value">${getPeriodReturn(12)}</div></div>
            </div>
        </div>
        <div class="report-section">
            <h3>חלוקת נכסים</h3>
            <p>מניות: ${client.stockPct.toFixed(1)}% | אג"ח: ${client.bondPct.toFixed(1)}%</p>
        </div>
        <div class="report-section">
            <h3>פירוט נכסים</h3>
            <table class="report-table">
                <thead><tr><th>נכס</th><th>סוג</th><th>הקצאה</th><th>שווי</th><th>תשואה</th></tr></thead>
                <tbody>${holdingsTableHTML}</tbody>
            </table>
        </div>
        <div class="report-section" style="text-align:center;margin-top:40px">
            <p style="color:#999;font-size:11px">דוח זה הופק אוטומטית מתוך Dashboard Portfolio Manager | ${dateStr}</p>
            <button class="report-back-btn" style="position:static;margin-top:16px" onclick="window.print()">הדפס / שמור כ-PDF</button>
        </div>
    `;
}

function closeReport() {
    document.getElementById('reportView').classList.remove('active');
    document.getElementById('reportView').innerHTML = '';
    document.querySelector('.header').style.display = '';
    document.querySelector('.summary-bar').style.display = '';
    document.querySelector('.filters').style.display = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display = '';
}

// ========== PORTFOLIO & ASSET MANAGEMENT ==========

function openMgmtModal(action, data) {
    const box = document.getElementById('mgmtBox');
    let html = '';

    if (action === 'addClient') {
        html = `
            <div class="mgmt-header"><h3>הוספת תיק חדש</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body" style="max-height:65vh;overflow-y:auto">
                <div class="mgmt-field"><label>שם הלקוח</label><input type="text" id="mgmt-name" placeholder="הזן שם לקוח..." /></div>
                <div class="mgmt-field"><label>מזומן (USD)</label><input type="text" inputmode="decimal" id="mgmt-cash-usd" value="0" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk()" /></div>
                <div class="mgmt-field"><label>מזומן (ILS)</label><input type="text" inputmode="decimal" id="mgmt-cash-ils" value="0" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk()" /></div>

                <div class="mgmt-section-divider">הוספת אחזקות</div>

                <div class="file-dropzone" id="addClientDropzone"
                     ondragover="event.preventDefault(); this.classList.add('dragover')"
                     ondragleave="this.classList.remove('dragover')"
                     ondrop="event.preventDefault(); this.classList.remove('dragover'); handleDropzoneFile(event.dataTransfer.files[0])"
                     onclick="document.getElementById('addClientFileInput').click()">
                    <div class="dropzone-icon">&#x2601;</div>
                    <div class="dropzone-text">גרור קובץ Excel, CSV או PDF</div>
                    <div class="dropzone-sub">או לחץ לבחירת קובץ</div>
                    <input type="file" id="addClientFileInput" accept=".xlsx,.xls,.csv,.pdf" style="display:none"
                           onchange="handleDropzoneFile(this.files[0])" />
                </div>
                <div id="addClientFileStatus" style="display:none;margin-bottom:10px"></div>

                <div class="mgmt-holdings-wrapper">
                    <table class="mgmt-holdings-table" id="mgmt-holdings-table">
                        <thead>
                            <tr>
                                <th style="width:30%">סימול</th>
                                <th style="width:20%">כמות</th>
                                <th style="width:18%" id="addPortfolio-price-header">מחיר קנייה ($)</th>
                                <th style="width:20%">מחיר נוכחי</th>
                                <th style="width:12%"></th>
                            </tr>
                        </thead>
                        <tbody id="mgmt-holdings-tbody"></tbody>
                    </table>
                    <button class="add-row-btn" onclick="addHoldingRow()">+ הוסף שורה</button>
                </div>

                <div class="risk-indicator" id="addClientRiskIndicator">
                    <span class="risk-indicator-label">רמת סיכון:</span>
                    <span class="risk-indicator-dot" id="riskDot" style="background:var(--risk-low)"></span>
                    <span class="risk-indicator-value" id="riskValue">נמוך</span>
                    <span class="risk-indicator-pct" id="riskPct">(0%)</span>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" id="addClientSubmitBtn" onclick="addClient()">הוסף תיק</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'editClient') {
        const c = data;
        html = `
            <div class="mgmt-header"><h3>עריכת תיק - ${c.name}</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="mgmt-field"><label>שם הלקוח</label><input type="text" id="mgmt-name" value="${c.name}" /></div>
                <div style="padding:8px 12px;background:rgba(100,116,139,0.08);border-radius:8px;border:1px solid rgba(100,116,139,0.2);font-size:12px;color:var(--text-muted);direction:rtl">
                    רמת סיכון נוכחית: <strong style="color:var(--risk-${c.risk})">${c.riskLabel}</strong> (מחושבת אוטומטית לפי הרכב התיק)
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" onclick="editClient(${c.id})">שמור שינויים</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'deleteClient') {
        const c = data;
        html = `
            <div class="mgmt-header"><h3>מחיקת תיק</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="mgmt-confirm-text">האם אתה בטוח שברצונך למחוק את התיק של <strong>${c.name}</strong>?<br>פעולה זו אינה ניתנת לביטול.</div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn danger" onclick="deleteClient(${c.id})">מחק תיק</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'addHolding') {
        const c = data;
        const cashUsd = c.cash?.usd || 0;
        const cashIls = c.cash?.ils || 0;
        html = `
            <div class="mgmt-header"><h3>קניית נכס - ${c.name}</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="cash-balance-display">
                    <span>מזומן (USD):</span>
                    <span class="cash-amount">${formatCurrency(cashUsd, 'USD')}</span>
                </div>
                <div class="cash-balance-display">
                    <span>מזומן (ILS):</span>
                    <span class="cash-amount">${formatCurrency(cashIls, 'ILS')}</span>
                </div>
                <input type="hidden" id="mgmt-available-cash-usd" value="${cashUsd}" />
                <input type="hidden" id="mgmt-available-cash-ils" value="${cashIls}" />
                <input type="hidden" id="mgmt-asset-type" value="stock" />
                <div class="mgmt-field" id="mgmt-ticker-field">
                    <label>חיפוש נייר ערך</label>
                    <div class="ticker-search-wrapper">
                        <input type="hidden" id="mgmt-ticker-symbol" />
                        <input type="hidden" id="mgmt-ticker-currency" />
                        <input type="hidden" id="mgmt-ticker-name" />
                        <div id="mgmt-ticker-selected" class="ticker-selected-badge" style="display:none"></div>
                        <input type="text" id="mgmt-ticker-search" placeholder='חפש: AAPL, טבע, לאומי...' style="text-align:left" oninput="onTickerSearch()" autocomplete="off" />
                        <div id="mgmt-ticker-dropdown" class="ticker-search-dropdown"></div>
                    </div>
                </div>
                <div class="mgmt-field" id="mgmt-bondname-field" style="display:none"><label>Bond Name</label><input type="text" id="mgmt-bondname" placeholder='e.g. IL Gov Bond CPI-Linked' /></div>
                <input type="hidden" id="mgmt-asset-class" value="Gov Bond" />
                <div class="mgmt-field" id="mgmt-bond-class-display" style="display:none">
                    <label>סיווג אוטומטי</label>
                    <div class="auto-class-badge" id="mgmt-bond-class-badge">Gov Bond</div>
                </div>
                <div id="mgmt-live-price-preview" style="display:none;padding:4px 0;font-size:12px;text-align:right"></div>
                <div class="mgmt-field"><label>מחיר קנייה (<span id="mgmt-price-currency-label">$</span>)</label><input type="text" inputmode="decimal" id="mgmt-price" placeholder="0.00" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateBuyCost()" /></div>
                <div class="mgmt-field"><label>כמות יחידות</label><input type="text" inputmode="decimal" id="mgmt-qty" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateBuyCost(); _updateQtyPreview('mgmt-qty','mgmt-qty-preview')" /><div class="qty-live-preview" id="mgmt-qty-preview"></div></div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>סה"כ עלות:</span><span id="mgmt-buy-total">$0</span></div>
                    <div class="buy-cost-row"><span>יתרה לאחר קניה:</span><span id="mgmt-buy-remaining">${formatCurrency(cashUsd, 'USD')}</span></div>
                    <div class="insufficient-cash-warning" id="mgmt-cash-warning" style="display:none">אין מספיק מזומן בתיק</div>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" id="mgmt-buy-btn" onclick="addHolding(${c.id})">קנה נכס</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'editHolding') {
        const { client: c, holdingId, holding: h } = data;
        const isStock = h.type === 'stock';
        const editCurrSymbol = h.currency === 'ILS' ? '₪' : '$';
        const editHeName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
        const editDisplayName = editHeName || (isStock ? h.ticker : h.name);
        html = `
            <div class="mgmt-header"><h3>עריכת נכס - ${editDisplayName}</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="mgmt-field"><label>${isStock ? 'סימול (Ticker)' : 'שם האג"ח'}</label><input type="text" id="mgmt-edit-name" value="${isStock ? h.ticker : h.name}" ${isStock ? 'style="direction:ltr;text-align:left"' : ''} /></div>
                <div class="mgmt-field"><label>מחיר קנייה (${editCurrSymbol})</label><input type="text" inputmode="decimal" id="mgmt-edit-price" value="${formatPrice(h.shares > 0 ? (h.costBasis / h.shares) : h.price)}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" /></div>
                <div class="mgmt-field"><label>כמות יחידות</label><input type="text" inputmode="decimal" id="mgmt-edit-qty" value="${Number(h.shares).toLocaleString('en-US')}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); _updateQtyPreview('mgmt-edit-qty','mgmt-edit-qty-preview')" /><div class="qty-live-preview" id="mgmt-edit-qty-preview">${describeQuantity(h.shares)}</div></div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" onclick="editHolding(${c.id}, ${holdingId})">שמור שינויים</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'removeHolding') {
        const { client: c, holdingId, holding: h } = data;
        const removeHeName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
        const displayName = removeHeName || (h.type === 'stock' ? h.ticker : h.name);
        html = `
            <div class="mgmt-header"><h3>הסרת נכס</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="mgmt-confirm-text">האם אתה בטוח שברצונך להסיר את <strong>${displayName}</strong> מהתיק של <strong>${c.name}</strong>?</div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn danger" onclick="removeHolding(${c.id}, ${holdingId})">הסר נכס</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'sellHolding') {
        const { client: c, holdingId, holding: h } = data;
        const sellHeName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
        const displayName = sellHeName || (h.type === 'stock' ? h.ticker : h.name);
        const currSymbol = h.currency === 'ILS' ? '₪' : '$';
        const avgCost = h.shares > 0 ? (h.costBasis / h.shares) : 0;
        html = `
            <div class="mgmt-header"><h3>מכירת נכס - ${displayName}</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="mgmt-field"><label>מחיר שוק נוכחי</label><div class="mgmt-readonly">${formatPrice(h.price)} ${currSymbol}</div></div>
                <div class="mgmt-field"><label>עלות ממוצעת למניה</label><div class="mgmt-readonly">${avgCost.toFixed(2)} ${currSymbol}</div></div>
                <div class="mgmt-field"><label>כמות באחזקה</label><div class="mgmt-readonly col-quantity">${formatAssetQuantity(h.shares)}</div></div>
                <input type="hidden" id="mgmt-sell-avg-cost" value="${avgCost}" />
                <input type="hidden" id="mgmt-sell-currency" value="${h.currency || 'USD'}" />
                <div class="mgmt-field"><label>מחיר מכירה (${currSymbol})</label><input type="text" inputmode="decimal" id="mgmt-sell-price" value="${formatPrice(h.price)}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateSellSummary()" /></div>
                <div class="mgmt-field"><label>כמות למכירה</label><input type="text" inputmode="decimal" id="mgmt-sell-qty" value="${Number(h.shares).toLocaleString('en-US')}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateSellSummary(); _updateQtyPreview('mgmt-sell-qty','mgmt-sell-qty-preview')" /><div class="qty-live-preview" id="mgmt-sell-qty-preview">${describeQuantity(h.shares)}</div></div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>סה"כ תמורה:</span><span id="mgmt-sell-total" style="color:var(--accent-green);font-weight:700">${formatCurrency(h.price * h.shares, h.currency)}</span></div>
                    <div class="buy-cost-row"><span>רווח/הפסד ממומש:</span><span id="mgmt-sell-pnl" style="font-weight:700"></span></div>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn danger" onclick="sellHolding(${c.id}, ${holdingId})">מכור</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
        // Trigger initial P&L calculation after DOM is ready
        setTimeout(() => updateSellSummary(), 0);
    }
    else if (action === 'depositCash') {
        const c = data;
        const cashUsd = c.cash?.usd || 0;
        const cashIls = c.cash?.ils || 0;
        html = `
            <div class="mgmt-header"><h3>הפקדת מזומן - ${c.name}</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="cash-balance-display">
                    <span>יתרה נוכחית (USD):</span>
                    <span class="cash-amount">${formatCurrency(cashUsd, 'USD')}</span>
                </div>
                <div class="cash-balance-display">
                    <span>יתרה נוכחית (ILS):</span>
                    <span class="cash-amount">${formatCurrency(cashIls, 'ILS')}</span>
                </div>
                <div class="mgmt-field"><label>מטבע</label>
                    <select id="mgmt-deposit-currency" onchange="updateDepositPreview()">
                        <option value="USD">USD ($)</option>
                        <option value="ILS">ILS (₪)</option>
                    </select>
                </div>
                <input type="hidden" id="mgmt-deposit-cash-usd" value="${cashUsd}" />
                <input type="hidden" id="mgmt-deposit-cash-ils" value="${cashIls}" />
                <div class="mgmt-field"><label>סכום להפקדה</label><input type="text" inputmode="decimal" id="mgmt-deposit-amount" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateDepositPreview()" /></div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>יתרה לאחר הפקדה:</span><span id="mgmt-deposit-new-balance">${formatCurrency(cashUsd, 'USD')}</span></div>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" onclick="depositCash(${c.id})">הפקד</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }

    box.innerHTML = html;
    document.getElementById('mgmtOverlay').classList.add('active');
}

function closeMgmtModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('mgmtOverlay').classList.remove('active');
}

// Called internally when asset type changes (now auto-detected, not user-driven)
function onAssetTypeChange() {
    const type = document.getElementById('mgmt-asset-type').value;
    // Ticker search is always visible (unified search for all security types)
    document.getElementById('mgmt-ticker-field').style.display = '';
    // Bond-specific fields shown only when type is bond
    document.getElementById('mgmt-bondname-field').style.display = type === 'bond' ? '' : 'none';
    const assetClassField = document.getElementById('mgmt-asset-class-field');
    if (assetClassField) assetClassField.style.display = type === 'bond' ? '' : 'none';
    // Update price label currency — bonds default to ₪, stocks/funds reset to $
    const priceCurrLabel = document.getElementById('mgmt-price-currency-label');
    if (priceCurrLabel) priceCurrLabel.textContent = type === 'bond' ? '₪' : '$';
    // For bonds, also set hidden currency field to ILS
    if (type === 'bond') {
        const tickerCurrEl = document.getElementById('mgmt-ticker-currency');
        if (tickerCurrEl) tickerCurrEl.value = 'ILS';
    }
    // Hide live price preview when switching types
    const preview = document.getElementById('mgmt-live-price-preview');
    if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
    // Update buy cost display for currency switch
    updateBuyCost();
}

// ========== AUTO ASSET TYPE DETECTION ==========
// Determines if a security is a stock, bond, or fund based on symbol, name, and API type.
// Rules:
//   1. API type contains "Bond" → bond
//   2. Israeli numeric symbol (7-9 digits): prefix "11" = Gov Bond, "95" = Makam/T-Bill, name keywords → bond
//   3. Name contains bond keywords (Hebrew or English) → bond
//   4. Default → stock
// Helper: classify bond sub-type (government vs corporate)
function _classifyBondType(nameStr) {
    const n = (nameStr || '').toLowerCase();
    const govKeywords = ['ממשלתי', 'ממשל', 'גליל', 'שחר', 'כפיר', 'מלווה', 'גילון', 'מק"מ', 'מקמ',
        'galil', 'shahar', 'gilon', 'makam',
        'gov bond', 'gov', 'il gov', 'cpi-linked', 'treasury', 'fixed rate', 'variable rate'];
    const corpKeywords = ['קונצרני', 'נאמנות', 'corp bond', 'corp', 'corporate'];
    if (corpKeywords.some(kw => n.includes(kw))) return { bondType: 'corporate', assetClass: 'Corp Bond' };
    if (govKeywords.some(kw => n.includes(kw))) return { bondType: 'government', assetClass: 'Gov Bond' };
    return { bondType: 'government', assetClass: 'Gov Bond' };
}

function detectAssetType(symbol, name, apiType) {
    const sym = (symbol || '').toUpperCase().trim();
    const nm = (name || '').toLowerCase();
    const api = (apiType || '').toLowerCase();

    // Rule 1: API explicitly says Bond
    if (api.includes('bond')) {
        const cls = _classifyBondType(name);
        return { type: 'bond', ...cls };
    }

    // Rule 2: Israeli numeric security (7-9 digits)
    if (/^\d{7,9}$/.test(sym)) {
        // 2a: Known STOCK in the numeric-to-Yahoo mapping → it's a stock, not a bond
        if (typeof ISRAELI_ID_TO_YAHOO !== 'undefined' && ISRAELI_ID_TO_YAHOO[sym]) {
            return { type: 'stock', assetClass: null, bondType: null };
        }
        // 2b: Government bond prefixes (11xxxx = CPI-linked, 95xxxx = fixed/variable)
        if (sym.startsWith('11') || sym.startsWith('95')) {
            return { type: 'bond', bondType: 'government', assetClass: 'Gov Bond' };
        }
        // 2c: Bond keywords in name
        const bondKeywords = ['אגח', 'אג"ח', 'ממשלתי', 'ממשל', 'שקלי', 'גליל', 'שחר', 'כפיר', 'מלווה', 'גילון', 'מק"מ', 'מקמ',
            'קונצרני', 'נאמנות', 'bond', 'gov bond', 'cpi-linked', 'treasury', 'corp bond',
            'galil', 'shahar', 'gilon', 'makam'];
        if (bondKeywords.some(kw => nm.includes(kw))) {
            const cls = _classifyBondType(name);
            return { type: 'bond', ...cls };
        }
        // 2d: Known BOND in the bond-to-Yahoo mapping
        if (typeof ISRAELI_BOND_TO_YAHOO !== 'undefined' && ISRAELI_BOND_TO_YAHOO[sym]) {
            const cls = _classifyBondType(name);
            return { type: 'bond', ...cls };
        }
        // 2e: Unknown numeric ID — default to stock (user can correct if needed)
        // Previously defaulted to bond which broke purchases of unmapped Israeli stocks
        return { type: 'stock', assetClass: null, bondType: null };
    }

    // Rule 3: Name-based bond detection (for non-numeric symbols)
    const bondNameKeywords = ['אגח', 'אג"ח', 'ממשלתי', 'ממשל', 'שקלי', 'גליל', 'שחר', 'כפיר', 'מלווה', 'גילון', 'מק"מ', 'מקמ',
        'קונצרני', 'נאמנות', 'gov bond', 'cpi-linked', 'treasury', 'corp bond', 'il gov bond', 'corporate bond',
        'galil', 'shahar', 'gilon', 'makam'];
    if (bondNameKeywords.some(kw => nm.includes(kw))) {
        const cls = _classifyBondType(name);
        return { type: 'bond', ...cls };
    }

    // Rule 4: Check if mapped in ISRAELI_BOND_TO_YAHOO (price-service.js)
    if (typeof ISRAELI_BOND_TO_YAHOO !== 'undefined' && ISRAELI_BOND_TO_YAHOO[sym]) {
        const cls = _classifyBondType(name);
        return { type: 'bond', ...cls };
    }

    // Default: stock
    return { type: 'stock', assetClass: null, bondType: null };
}

// ========== CENTRALIZED ASSET CLASSIFIER ==========
// Single entry point for classifying assets — used by both addClient (initial portfolio)
// and buyAsset flows. Detects bonds, money market funds, and stocks.
// Returns { type, assetClass, bondType, risk } for consistent tagging across all paths.

function classifyAsset(ticker, name) {
    const sym = (ticker || '').toUpperCase().trim();
    const nm = (name || '').toLowerCase();

    // Money Market Funds: low risk, type = 'fund'
    const mmfKeywords = ['כספית', 'money market', 'mmf', 'כספי', 'שקלית', 'דולרית'];
    if (mmfKeywords.some(kw => nm.includes(kw))) {
        return { type: 'fund', assetClass: 'Money Market', bondType: null, risk: 'low' };
    }

    // ISIN-format bonds (IL00...)
    if (/^IL\d{10,12}(\.TA)?$/i.test(sym)) {
        const cls = _classifyBondType(name);
        return { ...cls, type: 'bond', risk: 'low' };
    }

    // Delegate to detectAssetType for all other cases
    const detected = detectAssetType(sym, name, '');

    // Assign risk level based on type
    let risk = 'high'; // stocks default to high
    if (detected.type === 'bond') risk = 'low';
    if (detected.type === 'fund') risk = 'low';

    return {
        type: detected.type,
        assetClass: detected.assetClass,
        bondType: detected.bondType,
        risk
    };
}

// Live buy cost calculation
// Live quantity preview — updates the description below the input as the user types
function _updateQtyPreview(inputId, previewId) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    if (!input || !preview) return;
    const val = parseInputNumber(input.value);
    preview.textContent = val > 0 ? describeQuantity(val) : '';
}

function updateBuyCost() {
    const price = parseInputNumber(document.getElementById('mgmt-price')?.value);
    const qty = parseInputNumber(document.getElementById('mgmt-qty')?.value);
    const total = price * qty;

    // Determine which currency bucket to check based on selected ticker's currency
    const tickerCurrency = document.getElementById('mgmt-ticker-currency')?.value || 'USD';
    const assetType = document.getElementById('mgmt-asset-type')?.value || 'stock';
    const currency = (assetType === 'bond') ? 'ILS' : tickerCurrency;
    const availableCash = (currency === 'ILS')
        ? (parseFloat(document.getElementById('mgmt-available-cash-ils')?.value) || 0)
        : (parseFloat(document.getElementById('mgmt-available-cash-usd')?.value) || 0);
    const remaining = availableCash - total;

    const totalEl = document.getElementById('mgmt-buy-total');
    const remainingEl = document.getElementById('mgmt-buy-remaining');
    const warningEl = document.getElementById('mgmt-cash-warning');
    const buyBtn = document.getElementById('mgmt-buy-btn');

    if (totalEl) totalEl.textContent = formatCurrency(total, currency);
    if (remainingEl) {
        remainingEl.textContent = formatCurrency(Math.max(0, remaining), currency);
        remainingEl.style.color = remaining < 0 ? 'var(--accent-red)' : 'var(--accent-green)';
    }
    if (warningEl) warningEl.style.display = (total > 0 && remaining < 0) ? '' : 'none';
    if (buyBtn) buyBtn.disabled = (total > 0 && remaining < 0);
}

// Live deposit preview
function updateDepositPreview() {
    const amount = parseInputNumber(document.getElementById('mgmt-deposit-amount')?.value);
    const currency = document.getElementById('mgmt-deposit-currency')?.value || 'USD';
    const currentCash = (currency === 'ILS')
        ? parseInputNumber(document.getElementById('mgmt-deposit-cash-ils')?.value)
        : parseInputNumber(document.getElementById('mgmt-deposit-cash-usd')?.value);
    const newBalanceEl = document.getElementById('mgmt-deposit-new-balance');
    if (newBalanceEl) newBalanceEl.textContent = formatCurrency(currentCash + amount, currency);
}

// --- Ticker Search (Twelve Data symbol_search + local Hebrew lookup) ---

// Track the type of the last clicked search result (for bond detection in selectSearchResult)
let _lastSearchResultType = null;

// Shared renderer for both main and row dropdowns
// RTL 4-column grid: [Name (1fr)] [Ticker 70px] [Exchange 65px] [Price 70px]
function _renderSearchDropdown(results, dropdown, fetchPrices) {
    if (results.length === 0) {
        dropdown.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>';
        return;
    }
    dropdown.innerHTML = results.map((r, i) => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[(r.symbol || '').replace('.TA', '').toUpperCase()] : '');
        const safeName = (r.name || '').replace(/'/g, "\\'");
        const exchangeLabel = r.exchange || '';
        const isBond = r.type === 'Bond';
        // Bonds: English name is primary ("Galil 0523"), Hebrew is secondary ("גליל (צמוד מדד)")
        // Stocks: Hebrew name is primary ("Bank Leumi"), English/ticker is secondary
        let primaryLabel, secondaryLabel;
        if (isBond) {
            primaryLabel = r.name || r.symbol;
            secondaryLabel = heName && heName !== r.name ? heName : '';
        } else {
            primaryLabel = heName || r.name || r.symbol;
            secondaryLabel = heName && r.name && heName !== r.name ? r.name : '';
        }
        const bondTag = isBond ? '<span class="search-bond-tag">אג"ח</span>' : '';
        const rType = r.type || 'Common Stock';
        // Show .TA suffix for TASE stocks in the display ticker
        const displayTicker = (exchangeLabel === 'TASE' && !r.symbol.includes('.TA')) ? r.symbol + '.TA' : r.symbol;
        return `<div class="ticker-search-item" onclick="_lastSearchResultType='${rType}';selectSearchResult('${r.symbol}', '${safeName}', '${r.currency}', '${exchangeLabel}')">
            <div class="search-row-grid">
                <div class="search-col-name">
                    <span class="search-name-primary">${bondTag}${primaryLabel}</span>
                    ${secondaryLabel ? `<span class="search-name-secondary">${secondaryLabel}</span>` : ''}
                </div>
                <div class="search-col-ticker">${displayTicker}</div>
                <div class="search-col-exchange">${exchangeLabel}</div>
                <div class="search-col-price" id="slp_main_${i}"><span class="price-loading">···</span></div>
            </div>
        </div>`;
    }).join('');
    if (fetchPrices) _fetchSearchResultPrices(results, 'main');
}

function _mergeLocalAndApiResults(localResults, apiResults) {
    const seen = new Set();
    const merged = [];
    localResults.forEach(r => {
        const key = r.symbol.toUpperCase();
        if (!seen.has(key)) { seen.add(key); merged.push(r); }
    });
    apiResults.forEach(r => {
        const key = r.symbol.toUpperCase();
        if (!seen.has(key)) { seen.add(key); merged.push(r); }
    });
    return merged;
}

// Sort search results by relevance: name starts with query > name contains query > rest.
// Within each tier, local matches (bonds/Hebrew) appear before API results.
function _sortSearchResults(results, query) {
    if (!query || results.length <= 1) return results;
    const q = query.trim().toLowerCase();
    return results.slice().sort((a, b) => {
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        const aStarts = aName.startsWith(q) ? 0 : 1;
        const bStarts = bName.startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        // Within same tier, local matches first
        const aLocal = a._localMatch ? 0 : 1;
        const bLocal = b._localMatch ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
        // Then by name contains query
        const aContains = aName.includes(q) ? 0 : 1;
        const bContains = bName.includes(q) ? 0 : 1;
        return aContains - bContains;
    });
}

// Abort counter to cancel stale price fetches when user types again
let _searchPriceAbortId = 0;

async function _fetchSearchResultPrices(results, prefix) {
    const batchId = ++_searchPriceAbortId;
    const limit = Math.min(results.length, 5);
    for (let i = 0; i < limit; i++) {
        if (_searchPriceAbortId !== batchId) return; // cancelled
        const r = results[i];
        const el = document.getElementById(`slp_${prefix}_${i}`);
        if (!el) continue;
        try {
            const currency = r.currency || 'USD';
            const priceData = (typeof fetchSingleTickerPrice === 'function')
                ? await fetchSingleTickerPrice(r.symbol, currency)
                : null;
            if (_searchPriceAbortId !== batchId) return; // cancelled
            if (priceData && priceData.price > 0) {
                const sym = (currency === 'ILS' || currency === 'ILA') ? '₪' : '$';
                el.textContent = sym + priceData.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            } else {
                el.textContent = '—';
            }
        } catch (e) {
            if (el) el.textContent = '—';
        }
    }
}

function onTickerSearch() {
    clearTimeout(tickerSearchTimeout);
    const query = document.getElementById('mgmt-ticker-search')?.value?.trim();
    const dropdown = document.getElementById('mgmt-ticker-dropdown');
    if (!dropdown) return;

    if (!query || query.length < 1) {
        dropdown.innerHTML = '';
        dropdown.style.display = 'none';
        return;
    }

    // Instantly show local Hebrew + bond matches while API loads
    const localStocks = (typeof searchHebrewNames === 'function') ? searchHebrewNames(query) : [];
    const localBonds = (typeof searchLocalBonds === 'function') ? searchLocalBonds(query) : [];
    const localResults = _sortSearchResults([...localStocks, ...localBonds], query);
    dropdown.style.display = 'block';
    if (localResults.length > 0) {
        _renderSearchDropdown(localResults, dropdown, true);
    } else {
        dropdown.innerHTML = '<div class="ticker-search-loading">מחפש...</div>';
    }

    tickerSearchTimeout = setTimeout(async () => {
        const apiResults = await searchTwelveDataSymbols(query);
        const merged = _sortSearchResults(_mergeLocalAndApiResults(localResults, apiResults), query);
        _renderSearchDropdown(merged, dropdown, true);
    }, 300);
}

function _isIsraeliAsset(symbol, currency) {
    if (currency === 'ILS' || currency === 'ILA') return true;
    if (symbol.endsWith('.TA') || symbol.endsWith('.TASE')) return true;
    // 7-9 digit purely numeric symbol = Israeli bond ISIN fragment
    if (/^\d{7,9}$/.test(symbol)) return true;
    return false;
}

function selectSearchResult(symbol, name, currency, exchange) {
    // Detect Israeli asset — force currency to ILS
    const isIsraeli = _isIsraeliAsset(symbol, currency);
    const effectiveCurrency = isIsraeli ? 'ILS' : (currency || 'USD');

    // Auto-detect asset type using the unified detector
    const apiType = _lastSearchResultType || '';
    const detected = detectAssetType(symbol, name, apiType);
    const isBond = detected.type === 'bond';

    // Set the hidden asset type field
    document.getElementById('mgmt-asset-type').value = detected.type;

    document.getElementById('mgmt-ticker-symbol').value = symbol;
    document.getElementById('mgmt-ticker-currency').value = isBond && isIsraeli ? 'ILS' : effectiveCurrency;
    document.getElementById('mgmt-ticker-name').value = name;

    // Display name priority — show English name from HEBREW_NAMES if available
    const heName = (typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[(symbol || '').replace('.TA', '').toUpperCase()] : '';
    const displayLabel = heName ? `${symbol} — ${heName}` : `${symbol} — ${name}`;
    const currLabel = (isBond && isIsraeli) ? '₪' : (effectiveCurrency === 'ILS' ? '₪' : '$');

    // Show selected badge, hide search input
    const badge = document.getElementById('mgmt-ticker-selected');
    const bondTag = isBond ? ' <span style="color:var(--accent-purple,#a855f7);font-size:10px">[Bond]</span>' : '';
    badge.innerHTML = `<span>${displayLabel} (${exchange}, ${currLabel})${bondTag}</span><button class="ticker-clear-btn" onclick="clearTickerSelection()">&times;</button>`;
    badge.style.display = 'flex';

    document.getElementById('mgmt-ticker-search').style.display = 'none';
    document.getElementById('mgmt-ticker-dropdown').style.display = 'none';

    // Update price label to match the asset's currency
    const priceCurrLabelEl = document.getElementById('mgmt-price-currency-label');
    if (priceCurrLabelEl) priceCurrLabelEl.textContent = currLabel;

    // If bond detected, show bond-specific fields and auto-fill
    if (isBond) {
        const bondNameField = document.getElementById('mgmt-bondname-field');
        if (bondNameField) bondNameField.style.display = '';
        const bondNameInput = document.getElementById('mgmt-bondname');
        if (bondNameInput) bondNameInput.value = name || symbol;
        // Auto-set hidden asset class + show badge
        const assetClassHidden = document.getElementById('mgmt-asset-class');
        if (assetClassHidden && detected.assetClass) assetClassHidden.value = detected.assetClass;
        const bondClassDisplay = document.getElementById('mgmt-bond-class-display');
        if (bondClassDisplay) bondClassDisplay.style.display = '';
        const bondClassBadge = document.getElementById('mgmt-bond-class-badge');
        if (bondClassBadge) {
            bondClassBadge.textContent = detected.assetClass || 'Gov Bond';
            bondClassBadge.className = 'auto-class-badge ' + (detected.bondType === 'corporate' ? 'corp' : 'gov');
        }
        if (isIsraeli) {
            document.getElementById('mgmt-ticker-currency').value = 'ILS';
        }
    } else {
        // Stock selected — hide bond fields
        const bondNameField = document.getElementById('mgmt-bondname-field');
        if (bondNameField) bondNameField.style.display = 'none';
        const bondClassDisplay = document.getElementById('mgmt-bond-class-display');
        if (bondClassDisplay) bondClassDisplay.style.display = 'none';
    }

    updateBuyCost();

    // Live price preview — fetch current market price in background
    _fetchLivePricePreview(symbol);

    // Reset the type tracker
    _lastSearchResultType = null;
}

async function _fetchLivePricePreview(symbol) {
    const previewEl = document.getElementById('mgmt-live-price-preview');
    if (!previewEl) return;

    previewEl.textContent = 'טוען מחיר שוק...';
    previewEl.style.display = '';

    const currency = document.getElementById('mgmt-ticker-currency')?.value || 'USD';
    // Pass buy_price as fallback baseline if all live APIs fail
    const buyPriceVal = parseFloat(document.getElementById('mgmt-buy-price')?.value) || null;

    try {
        const result = (typeof fetchSingleTickerPrice === 'function')
            ? await fetchSingleTickerPrice(symbol, currency, buyPriceVal)
            : null;

        // Element may have been removed if modal closed
        const el = document.getElementById('mgmt-live-price-preview');
        if (!el) return;

        if (result && result.price > 0) {
            const curr = document.getElementById('mgmt-ticker-currency')?.value || 'USD';
            const sym = curr === 'ILS' ? '₪' : '$';
            el.innerHTML = `<span style="color:var(--accent-blue);font-weight:600">מחיר שוק נוכחי: ${result.price.toFixed(2)} ${sym}</span>`;
        } else {
            el.textContent = 'לא ניתן לטעון מחיר שוק';
        }
    } catch (e) {
        const el = document.getElementById('mgmt-live-price-preview');
        if (el) el.textContent = '';
    }
}

function clearTickerSelection() {
    document.getElementById('mgmt-ticker-symbol').value = '';
    document.getElementById('mgmt-ticker-currency').value = '';
    document.getElementById('mgmt-ticker-name').value = '';

    // Reset auto-detected type back to stock
    document.getElementById('mgmt-asset-type').value = 'stock';

    const badge = document.getElementById('mgmt-ticker-selected');
    badge.style.display = 'none';

    const searchInput = document.getElementById('mgmt-ticker-search');
    searchInput.style.display = '';
    searchInput.value = '';
    searchInput.focus();

    document.getElementById('mgmt-ticker-dropdown').style.display = 'none';

    // Reset price currency label to default ($)
    const priceCurrLabel = document.getElementById('mgmt-price-currency-label');
    if (priceCurrLabel) priceCurrLabel.textContent = '$';

    // Hide bond-specific fields and reset auto-classification
    const bondNameField = document.getElementById('mgmt-bondname-field');
    if (bondNameField) bondNameField.style.display = 'none';
    const bondClassDisplay = document.getElementById('mgmt-bond-class-display');
    if (bondClassDisplay) bondClassDisplay.style.display = 'none';
    const assetClassHidden = document.getElementById('mgmt-asset-class');
    if (assetClassHidden) assetClassHidden.value = 'Gov Bond';

    // Hide live price preview
    const preview = document.getElementById('mgmt-live-price-preview');
    if (preview) { preview.textContent = ''; preview.style.display = 'none'; }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.ticker-search-wrapper');
    const dropdown = document.getElementById('mgmt-ticker-dropdown');
    if (wrapper && dropdown && !wrapper.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

// --- Client CRUD (routes to Supabase when connected, fallback to backend API) ---

async function addClient() {
    const submitBtn = document.getElementById('addClientSubmitBtn');

    // --- Step 1: Client-side validation (synchronous, before any async work) ---
    const name = (document.getElementById('mgmt-name')?.value || '').trim();
    const rawUsd = document.getElementById('mgmt-cash-usd')?.value;
    const rawIls = document.getElementById('mgmt-cash-ils')?.value;
    const cashUsd = parseInputNumber(rawUsd);
    const cashIls = parseInputNumber(rawIls);

    if (!name) {
        console.warn('addClient validation: name is empty');
        alert('נא להזין שם לקוח');
        return;
    }
    if (cashUsd < 0 || cashIls < 0) {
        alert('ערך מזומן לא יכול להיות שלילי');
        return;
    }

    // Collect holdings from dynamic table
    const holdingsData = _collectHoldingRows();

    const portfolioData = { name, cashUsd, cashIls, holdingsCount: holdingsData.length };
    console.log('addClient: submitting data:', portfolioData);

    // --- Step 2: Show loading state with progress ---
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="btn-spinner"></span> יוצר תיק...';
    }

    // Progress callback: updates button text as batch progresses
    const onProgress = (msg) => {
        if (submitBtn) submitBtn.innerHTML = '<span class="btn-spinner"></span> ' + msg;
    };

    try {
        let finalClient;

        if (supabaseConnected) {
            // 30s timeout — no external API calls during creation, only Supabase DB calls
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 30000)
            );
            const supaPromise = holdingsData.length > 0
                ? supaAddClientWithHoldings(name, cashUsd, cashIls, holdingsData, onProgress)
                : supaAddClient(name, cashUsd, cashIls);

            finalClient = await Promise.race([supaPromise, timeoutPromise]);
        } else {
            finalClient = await apiAddClient(name, 'low');
        }

        console.log('addClient result:', finalClient ? 'success (id=' + finalClient.id + ')' : 'null — check console for supaAddClient errors');

        if (!finalClient) {
            alert('יצירת התיק נכשלה — בדוק את הקונסול (F12) לפרטי השגיאה');
            return;  // finally block will reset button
        }

        clients.push(finalClient);
        closeMgmtModal();
        refreshDashboard();

        // Fetch live prices in background AFTER portfolio is created and modal is closed
        if (holdingsData.length > 0 && supabaseConnected) {
            priceCacheTimestamp = 0;
            updatePricesFromAPI(() => {
                refreshDashboard();
            }).catch(e => console.warn('Post-create price update:', e.message));
        }
    } catch (err) {
        console.error('addClient error:', err);
        if (err.message === 'timeout') {
            alert('השרת עמוס. ייתכן שהתיק נוצר ברקע — רענן את הדף בעוד דקה.');
        } else {
            alert('שגיאה ביצירת התיק: ' + (err.message || err));
        }
    } finally {
        // ALWAYS reset button — whether success, error, or timeout
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'הוסף תיק'; }
    }
}

async function editClient(clientId) {
    const name = document.getElementById('mgmt-name').value.trim();
    if (!name) { alert('נא להזין שם לקוח'); return; }

    const updated = supabaseConnected
        ? await supaEditClient(clientId, name)
        : await apiEditClient(clientId, name);
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    closeMgmtModal();
    refreshDashboard();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

async function deleteClient(clientId) {
    supabaseConnected
        ? await supaDeleteClient(clientId)
        : await apiDeleteClient(clientId);
    clients = clients.filter(c => c.id !== clientId);
    closeMgmtModal();
    if (currentModalClientId === clientId) {
        document.getElementById('modalOverlay').classList.remove('active');
        currentModalClientId = null;
    }
    refreshDashboard();
}

// --- Holding CRUD (routes to Supabase when connected, fallback to backend API) ---

async function addHolding(clientId) {
    const price = parseInputNumber(document.getElementById('mgmt-price').value);
    const quantity = parseInputNumber(document.getElementById('mgmt-qty').value);

    if (!price || price <= 0) { alert('נא להזין מחיר קנייה תקין'); return; }
    if (!quantity || quantity <= 0) { alert('נא להזין כמות תקינה'); return; }

    // Ticker is always from the unified search (stocks, bonds, funds all go through it)
    const ticker = (document.getElementById('mgmt-ticker-symbol')?.value || '').toUpperCase().trim();
    if (!ticker) { alert('נא לבחור נכס מתוך תוצאות החיפוש'); return; }

    // Auto-detected type from selectSearchResult (stored in hidden field)
    const type = document.getElementById('mgmt-asset-type').value || 'stock';
    const currency = document.getElementById('mgmt-ticker-currency')?.value || 'USD';
    const stockName = document.getElementById('mgmt-ticker-name')?.value || ticker;

    let holdingData = { type, price, quantity, ticker, currency, stockName };

    // For bonds: also pass bond-specific fields + auto-detected bond_type
    if (type === 'bond') {
        holdingData.bondName = document.getElementById('mgmt-bondname')?.value?.trim() || stockName;
        holdingData.assetClass = document.getElementById('mgmt-asset-class')?.value || 'Gov Bond';
        // Re-detect to get bondType (government/corporate)
        const detected = detectAssetType(ticker, stockName, '');
        holdingData.bondType = detected.bondType || 'government';
    }

    // Use portfolioBuyAsset which checks cash balance
    let updated;
    if (supabaseConnected) {
        updated = await portfolioBuyAsset(clientId, holdingData);
        if (updated && updated.error === 'insufficient_cash') {
            const cur = holdingData.currency || 'USD';
            alert(`אין מספיק מזומן (${cur}) בתיק.\nנדרש: ${formatCurrency(updated.required, cur)}\nזמין: ${formatCurrency(updated.available, cur)}`);
            return;
        }
        if (updated && updated.error) {
            alert(`שגיאה בביצוע הקנייה: ${updated.error}`);
            return;
        }
        if (!updated) {
            alert('שגיאה בשמירת הנכס. נא לנסות שנית.');
            return;
        }
    } else {
        updated = await apiAddHolding(clientId, holdingData);
    }

    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    closeMgmtModal();
    refreshDashboard();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

// --- Deposit Cash ---

async function depositCash(clientId) {
    const amount = parseInputNumber(document.getElementById('mgmt-deposit-amount')?.value);
    const currency = document.getElementById('mgmt-deposit-currency')?.value || 'USD';
    if (!amount || amount <= 0) { alert('נא להזין סכום תקין'); return; }

    const updated = await portfolioDepositCash(clientId, amount, currency);
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    closeMgmtModal();
    refreshDashboard();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

async function editHolding(clientId, holdingId) {
    const newName = document.getElementById('mgmt-edit-name').value.trim();
    const newPrice = parseInputNumber(document.getElementById('mgmt-edit-price').value);
    const newQty = parseInputNumber(document.getElementById('mgmt-edit-qty').value);

    if (!newName) { alert('נא להזין שם/סימול'); return; }
    if (!newPrice || newPrice <= 0) { alert('נא להזין מחיר תקין'); return; }
    if (!newQty || newQty <= 0) { alert('נא להזין כמות תקינה'); return; }

    const updated = supabaseConnected
        ? await supaEditHolding(clientId, holdingId, { name: newName, price: newPrice, quantity: newQty })
        : await apiEditHolding(clientId, holdingId, { name: newName, price: newPrice, quantity: newQty });
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    closeMgmtModal();
    refreshDashboard();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

async function removeHolding(clientId, holdingId) {
    const updated = supabaseConnected
        ? await supaRemoveHolding(clientId, holdingId)
        : await apiRemoveHolding(clientId, holdingId);
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    closeMgmtModal();
    refreshDashboard();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

// --- Sell Holding ---

function updateSellSummary() {
    const sellPrice = parseInputNumber(document.getElementById('mgmt-sell-price')?.value);
    const qty = parseInputNumber(document.getElementById('mgmt-sell-qty')?.value);
    const avgCost = parseFloat(document.getElementById('mgmt-sell-avg-cost')?.value) || 0;
    const currency = document.getElementById('mgmt-sell-currency')?.value || 'USD';

    const total = sellPrice * qty;
    const pnl = (sellPrice - avgCost) * qty;

    const totalEl = document.getElementById('mgmt-sell-total');
    const pnlEl = document.getElementById('mgmt-sell-pnl');

    if (totalEl) totalEl.textContent = formatCurrency(total, currency);
    if (pnlEl) {
        const sign = pnl >= 0 ? '+' : '';
        pnlEl.textContent = `${sign}${formatCurrency(Math.abs(pnl), currency)}`;
        pnlEl.style.color = pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    }
}

async function sellHolding(clientId, holdingId) {
    const sellQty = parseInputNumber(document.getElementById('mgmt-sell-qty').value);
    const sellPrice = parseInputNumber(document.getElementById('mgmt-sell-price').value);
    if (!sellQty || sellQty <= 0) { alert('נא להזין כמות למכירה'); return; }
    if (!sellPrice || sellPrice <= 0) { alert('נא להזין מחיר מכירה תקין'); return; }

    const client = clients.find(c => c.id === clientId);
    const holding = client ? client.holdings.find(h => h.id === holdingId) : null;
    if (holding && sellQty > holding.shares) { alert('לא ניתן למכור יותר מהכמות שבאחזקה'); return; }

    const updated = supabaseConnected
        ? await supaSellHolding(clientId, holdingId, sellQty, sellPrice)
        : null;
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    closeMgmtModal();
    refreshDashboard();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

// ========== ADD CLIENT - DYNAMIC HOLDINGS TABLE ==========

let _holdingRowCounter = 0;
let _rowSearchTimeouts = {};

function addHoldingRow(prefill = null) {
    const tbody = document.getElementById('mgmt-holdings-tbody');
    if (!tbody) return;

    const rowId = 'hrow_' + (++_holdingRowCounter);
    const tr = document.createElement('tr');
    tr.id = rowId;
    tr.innerHTML = `
        <td class="row-ticker-cell">
            <div class="row-ticker-wrapper">
                <input type="hidden" class="row-ticker-symbol" value="${prefill?.ticker || ''}" />
                <div class="row-ticker-badge" style="display:${prefill?.ticker ? 'flex' : 'none'}">${prefill?.ticker || ''}<button class="ticker-clear-btn" onclick="clearRowTicker('${rowId}')">&times;</button></div>
                <input type="text" class="row-ticker-search" placeholder="חפש שם או סימול..."
                       style="direction:ltr;text-align:left;${prefill?.ticker ? 'display:none' : ''}"
                       oninput="onRowTickerSearch('${rowId}')" autocomplete="off" />
                <div class="row-ticker-dropdown" id="dropdown_${rowId}"></div>
            </div>
        </td>
        <td><input type="text" inputmode="decimal" class="row-shares" value="${prefill?.shares ? Number(prefill.shares).toLocaleString('en-US') : ''}" placeholder="0"
                   style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk()" /></td>
        <td><input type="text" inputmode="decimal" class="row-price" value="${prefill?.avgPrice ? formatPrice(prefill.avgPrice) : ''}" placeholder="0.00"
                   style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk()" /></td>
        <td class="row-live-price" style="font-size:12px;color:var(--text-muted);text-align:center">—</td>
        <td><button class="holding-action-btn delete" onclick="removeHoldingRow('${rowId}')">&times;</button></td>
    `;
    tbody.appendChild(tr);
    updateAddClientRisk();

    // Focus the ticker search if not prefilled
    if (!prefill?.ticker) {
        const searchInput = tr.querySelector('.row-ticker-search');
        if (searchInput) searchInput.focus();
    }

    // If prefilled with ticker, fetch live price
    if (prefill?.ticker) {
        tr.dataset.currency = prefill.currency || 'USD';
        _fetchRowLivePrice(rowId, prefill.ticker, prefill.currency || 'USD');
    }
}

function removeHoldingRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) row.remove();
    _updateAddPortfolioPriceHeader();
    updateAddClientRisk();
}

function clearRowTicker(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    row.querySelector('.row-ticker-symbol').value = '';
    row.querySelector('.row-ticker-badge').style.display = 'none';
    row.querySelector('.row-ticker-badge').textContent = '';
    delete row.dataset.currency;
    const searchInput = row.querySelector('.row-ticker-search');
    searchInput.style.display = '';
    searchInput.value = '';
    searchInput.focus();
    // Reset live price cell
    const priceCell = row.querySelector('.row-live-price');
    if (priceCell) priceCell.innerHTML = '<span style="color:var(--text-muted);font-size:11px">—</span>';
    _updateAddPortfolioPriceHeader();
    updateAddClientRisk();
}

function _renderRowSearchDropdown(results, dropdown, rowId, fetchPrices) {
    if (results.length === 0) {
        dropdown.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>';
        return;
    }
    dropdown.innerHTML = results.map((r, i) => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[(r.symbol || '').replace('.TA', '').toUpperCase()] : '');
        const exchangeLabel = r.exchange || '';
        const isBond = r.type === 'Bond';
        let primaryLabel, secondaryLabel;
        if (isBond) {
            primaryLabel = r.name || r.symbol;
            secondaryLabel = heName && heName !== r.name ? heName : '';
        } else {
            primaryLabel = heName || r.name || r.symbol;
            secondaryLabel = heName && r.name && heName !== r.name ? r.name : '';
        }
        const bondTag = isBond ? '<span class="search-bond-tag">אג"ח</span>' : '';
        const displayTicker = (exchangeLabel === 'TASE' && !r.symbol.includes('.TA')) ? r.symbol + '.TA' : r.symbol;
        return `<div class="ticker-search-item" onclick="selectRowTicker('${rowId}', '${r.symbol}', '${r.currency}')">
            <div class="search-row-grid">
                <div class="search-col-name">
                    <span class="search-name-primary">${bondTag}${primaryLabel}</span>
                    ${secondaryLabel ? `<span class="search-name-secondary">${secondaryLabel}</span>` : ''}
                </div>
                <div class="search-col-ticker">${displayTicker}</div>
                <div class="search-col-exchange">${exchangeLabel}</div>
                <div class="search-col-price" id="slp_row_${i}"><span class="price-loading">···</span></div>
            </div>
        </div>`;
    }).join('');
    if (fetchPrices) _fetchSearchResultPrices(results, 'row');
}

function onRowTickerSearch(rowId) {
    if (_rowSearchTimeouts[rowId]) clearTimeout(_rowSearchTimeouts[rowId]);

    const row = document.getElementById(rowId);
    if (!row) return;
    const input = row.querySelector('.row-ticker-search');
    const dropdown = document.getElementById('dropdown_' + rowId);
    const query = input?.value?.trim();

    if (!query || query.length < 1) {
        if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
        return;
    }

    // Instantly show local Hebrew + bond matches
    const localStocks = (typeof searchHebrewNames === 'function') ? searchHebrewNames(query) : [];
    const localBonds = (typeof searchLocalBonds === 'function') ? searchLocalBonds(query) : [];
    const localResults = _sortSearchResults([...localStocks, ...localBonds], query);
    if (dropdown) {
        dropdown.style.display = 'block';
        if (localResults.length > 0) {
            _renderRowSearchDropdown(localResults, dropdown, rowId, true);
        } else {
            dropdown.innerHTML = '<div class="ticker-search-loading">מחפש...</div>';
        }
    }

    _rowSearchTimeouts[rowId] = setTimeout(async () => {
        const apiResults = await searchTwelveDataSymbols(query);
        if (!dropdown) return;
        const merged = _sortSearchResults(_mergeLocalAndApiResults(localResults, apiResults), query);
        _renderRowSearchDropdown(merged, dropdown, rowId, true);
    }, 300);
}

function selectRowTicker(rowId, symbol, currency) {
    const row = document.getElementById(rowId);
    if (!row) return;

    // Detect Israeli asset — force currency to ILS
    const isIsraeli = (typeof _isIsraeliAsset === 'function') ? _isIsraeliAsset(symbol, currency) : false;
    const effectiveCurrency = isIsraeli ? 'ILS' : (currency || 'USD');

    row.querySelector('.row-ticker-symbol').value = symbol;
    row.dataset.currency = effectiveCurrency;

    // Show Hebrew name in badge if available
    const heName = (typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[symbol.replace('.TA', '').toUpperCase()] : '';
    const currSym = effectiveCurrency === 'ILS' ? '₪' : '$';
    const badgeLabel = heName ? `${heName} (${symbol})` : symbol;
    const badge = row.querySelector('.row-ticker-badge');
    badge.innerHTML = `<span style="font-size:12px">${badgeLabel} <span style="color:var(--text-muted);font-size:10px">${currSym}</span></span><button class="ticker-clear-btn" onclick="clearRowTicker('${rowId}')">&times;</button>`;
    badge.style.display = 'flex';

    row.querySelector('.row-ticker-search').style.display = 'none';
    const dropdown = document.getElementById('dropdown_' + rowId);
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }

    // Update the price header to reflect the latest row's currency
    _updateAddPortfolioPriceHeader();

    updateAddClientRisk();

    // Fetch live price for this row in the background
    _fetchRowLivePrice(rowId, symbol, effectiveCurrency);
}

// Dynamic price header: scans all rows' currencies and updates the table header
function _updateAddPortfolioPriceHeader() {
    const header = document.getElementById('addPortfolio-price-header');
    if (!header) return;
    const tbody = document.getElementById('mgmt-holdings-tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    let hasILS = false, hasUSD = false;
    rows.forEach(row => {
        const curr = row.dataset?.currency || '';
        if (curr === 'ILS') hasILS = true;
        else if (curr === 'USD' || !curr) hasUSD = true;
    });
    if (hasILS && hasUSD) {
        header.textContent = 'מחיר קנייה ($/₪)';
    } else if (hasILS) {
        header.textContent = 'מחיר קנייה (₪)';
    } else {
        header.textContent = 'מחיר קנייה ($)';
    }
}

// Fetch live price for a dynamic row and display in the "מחיר נוכחי" cell
async function _fetchRowLivePrice(rowId, symbol, currency) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const priceCell = row.querySelector('.row-live-price');
    if (!priceCell) return;

    priceCell.innerHTML = '<span style="color:var(--text-muted);font-size:11px">טוען...</span>';

    try {
        const result = (typeof fetchSingleTickerPrice === 'function')
            ? await fetchSingleTickerPrice(symbol, currency)
            : null;

        // Row may have been removed while we were fetching
        const el = document.getElementById(rowId)?.querySelector('.row-live-price');
        if (!el) return;

        if (result && result.price > 0) {
            const currSym = currency === 'ILS' ? '₪' : '$';
            el.innerHTML = `<span style="color:var(--accent-blue);font-weight:600;font-size:12px">${result.price.toFixed(2)} ${currSym}</span>`;
        } else {
            el.innerHTML = '<span style="color:var(--text-muted);font-size:11px">—</span>';
        }
    } catch (e) {
        const el = document.getElementById(rowId)?.querySelector('.row-live-price');
        if (el) el.innerHTML = '<span style="color:var(--text-muted);font-size:11px">—</span>';
    }
}

// Collect all holding rows into an array for submission
function _collectHoldingRows() {
    const tbody = document.getElementById('mgmt-holdings-tbody');
    if (!tbody) return [];

    const rows = tbody.querySelectorAll('tr');
    const holdings = [];
    let extraCash = 0;

    rows.forEach(row => {
        const ticker = row.querySelector('.row-ticker-symbol')?.value?.trim().toUpperCase();
        const shares = parseInputNumber(row.querySelector('.row-shares')?.value);
        const price = parseInputNumber(row.querySelector('.row-price')?.value);
        const currency = row.dataset?.currency || 'USD';

        if (!ticker || shares <= 0 || price <= 0) return;

        // Detect cash rows — route to cash balance, not holdings
        if (typeof _isCashRow === 'function' && _isCashRow(ticker)) {
            extraCash += shares * price;
            return;
        }

        // Classify asset using centralized logic (bonds, MMF, stocks)
        const rowName = row.querySelector('.row-ticker-name')?.value || ticker;
        const classified = classifyAsset(ticker, rowName);

        const holding = {
            type: classified.type,
            ticker,
            stockName: rowName || ticker,
            price,
            quantity: shares,
            currency
        };
        // Pass bond/fund metadata for correct Supabase insert
        if (classified.assetClass) holding.assetClass = classified.assetClass;
        if (classified.bondType) holding.bondType = classified.bondType;
        if (classified.type === 'bond') holding.bondName = rowName || ticker;

        holdings.push(holding);
    });

    // If cash rows were found, add to the USD cash input field
    if (extraCash > 0) {
        const cashInput = document.getElementById('mgmt-cash-usd');
        if (cashInput) {
            const existing = parseInputNumber(cashInput.value);
            cashInput.value = formatPrice(existing + extraCash);
        }
    }

    return holdings;
}

// Real-time risk calculation
function updateAddClientRisk() {
    const cash = parseInputNumber(document.getElementById('mgmt-cash-usd')?.value) + parseInputNumber(document.getElementById('mgmt-cash-ils')?.value);
    const tbody = document.getElementById('mgmt-holdings-tbody');

    let totalStockValue = 0;
    let totalBondValue = 0;
    if (tbody) {
        tbody.querySelectorAll('tr').forEach(row => {
            const shares = parseInputNumber(row.querySelector('.row-shares')?.value);
            const price = parseInputNumber(row.querySelector('.row-price')?.value);
            const rowValue = shares * price;
            // Classify to correctly separate stocks from bonds/funds
            const ticker = row.querySelector('.row-ticker-symbol')?.value?.trim().toUpperCase() || '';
            const rowName = row.querySelector('.row-ticker-name')?.value || ticker;
            const classified = classifyAsset(ticker, rowName);
            if (classified.type === 'bond' || classified.type === 'fund') {
                totalBondValue += rowValue;
            } else {
                totalStockValue += rowValue;
            }
        });
    }

    const total = totalStockValue + totalBondValue + cash;
    const stockPct = total > 0 ? (totalStockValue / total) * 100 : 0;

    let risk, riskLabel, riskColor;
    if (stockPct > 70) { risk = 'high'; riskLabel = 'גבוה'; riskColor = 'var(--risk-high)'; }
    else if (stockPct >= 40) { risk = 'medium'; riskLabel = 'בינוני'; riskColor = 'var(--risk-medium)'; }
    else { risk = 'low'; riskLabel = 'נמוך'; riskColor = 'var(--risk-low)'; }

    const dot = document.getElementById('riskDot');
    const val = document.getElementById('riskValue');
    const pct = document.getElementById('riskPct');

    if (dot) dot.style.background = riskColor;
    if (val) { val.textContent = riskLabel; val.style.color = riskColor; }
    if (pct) pct.textContent = `(${stockPct.toFixed(0)}% מניות)`;
}

// Handle file drop/select from dropzone
async function handleDropzoneFile(file) {
    if (!file) return;

    const statusEl = document.getElementById('addClientFileStatus');
    const dropzone = document.getElementById('addClientDropzone');

    // Show loading state
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.innerHTML = '<div class="file-status-loading">מעבד קובץ: ' + file.name + '...</div>';
    }
    if (dropzone) dropzone.style.opacity = '0.5';

    try {
        const result = await handleImportFile(file);

        // handleImportFile returns { holdings: [...], cashTotal: number }
        const parsed = result.holdings || [];
        const cashFromFile = result.cashTotal || 0;

        if (parsed.length > 0 || cashFromFile > 0) {
            // Clear existing rows
            const tbody = document.getElementById('mgmt-holdings-tbody');
            if (tbody) tbody.innerHTML = '';

            // Add parsed holdings rows
            parsed.forEach(row => addHoldingRow(row));

            // Add cash from file to the USD cash balance field
            if (cashFromFile > 0) {
                const cashInput = document.getElementById('mgmt-cash-usd');
                if (cashInput) {
                    const existing = parseInputNumber(cashInput.value);
                    cashInput.value = formatPrice(existing + cashFromFile);
                }
            }

            // Build status message
            let statusMsg = `נטענו ${parsed.length} אחזקות`;
            if (cashFromFile > 0) statusMsg += ` + $${cashFromFile.toLocaleString()} מזומן`;
            statusMsg += ` מ-${file.name}`;

            if (statusEl) {
                statusEl.innerHTML = `<div class="file-status-success">${statusMsg}</div>`;
            }

            updateAddClientRisk();
        } else {
            if (statusEl) {
                statusEl.innerHTML = '<div class="file-status-error">לא נמצאו אחזקות בקובץ. נסה קובץ אחר או הזן ידנית.</div>';
            }
        }
    } catch (err) {
        console.error('File parse error:', err);
        if (statusEl) {
            statusEl.innerHTML = '<div class="file-status-error">שגיאה בקריאת הקובץ</div>';
        }
    }

    if (dropzone) dropzone.style.opacity = '1';
}

// Close row dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-ticker-wrapper')) {
        document.querySelectorAll('.row-ticker-dropdown').forEach(d => {
            d.style.display = 'none';
        });
    }
});
