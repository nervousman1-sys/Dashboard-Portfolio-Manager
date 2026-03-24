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
    const totalProfit = client.portfolioValue - client.initialInvestment;
    // Weighted return on invested capital (holdings only, excludes idle cash)
    const investedCostBasis = client.holdings.reduce((s, h) => s + h.costBasis, 0);
    const investedCurrentValue = client.holdings.reduce((s, h) => s + h.value, 0);
    const investedProfit = investedCurrentValue - investedCostBasis;
    const totalReturnPct = investedCostBasis > 0 ? (investedProfit / investedCostBasis * 100) : 0;
    const totalProfitClass = totalProfit >= 0 ? 'positive' : 'negative';
    const totalProfitSign = totalProfit >= 0 ? '+' : '';

    // Holdings table — columns: נכס, מחיר קנייה, מחיר נוכחי, כמות, שווי כולל, שינוי יומי %, רווח $, תשואה %, פעולות
    let holdingsRows = '';
    let totalHoldingsValue = 0;
    let totalHoldingsPnL = 0;
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
        totalHoldingsValue += h.value;
        totalHoldingsPnL += isStale ? 0 : holdingProfit;
        holdingsRows += `<tr>
            <td>
                <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:var(--text-primary)">${primaryName}</span>
                    ${subName}
                    <span class="asset-type-badge ${h.type}" style="font-size:10px;width:fit-content">${h.typeLabel}</span>
                </div>
            </td>
            <td>${purchasePrice.toFixed(2)} ${currSymbol}</td>
            <td>${isStale ? `<span style="color:var(--text-muted)" title="ממתין לעדכון מחיר מהשוק">${h.price.toFixed(2)} ${currSymbol}</span>` : `${h.price.toFixed(2)} ${currSymbol}`}</td>
            <td>${h.shares}</td>
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
    const totalCostBasis = client.holdings.reduce((s, h) => s + h.costBasis, 0);
    const totalReturnPctHoldings = totalCostBasis > 0 ? (totalHoldingsPnL / totalCostBasis * 100) : 0;
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

    // Transaction history — fetch from Supabase
    const transactions = supabaseConnected ? await supaFetchTransactions(client.id) : [];
    let transRows = '';
    if (transactions.length === 0) {
        transRows = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">אין היסטוריית פעולות</td></tr>';
    }
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
        const sharesDisplay = t.shares > 0 ? t.shares : '-';
        const priceDisplay = t.price > 0 ? `${t.price.toFixed(2)} $` : '-';
        const totalDisplay = t.total > 0 ? formatCurrency(t.total) : '-';
        transRows += `<tr>
            <td>${dateStr}</td>
            <td><span class="transaction-badge ${t.type}">${typeLabel}</span></td>
            <td style="font-weight:600;color:var(--text-primary)">${t.ticker !== '-' ? t.ticker : ''}</td>
            <td>${sharesDisplay}</td>
            <td>${priceDisplay}</td>
            <td style="font-weight:600">${totalDisplay}</td>
            <td>${pnlCell}</td>
        </tr>`;
    });

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
                <div class="modal-stats">
                    <div class="modal-stat"><div class="stat-label">שווי תיק כולל</div><div class="stat-value" style="color:var(--color-profit)">${formatCurrency(client.portfolioValue)}</div></div>
                    <div class="modal-stat"><div class="stat-label">השקעה ראשונית</div><div class="stat-value" style="color:var(--text-secondary)">${formatCurrency(client.initialInvestment)}</div></div>
                    <div class="modal-stat"><div class="stat-label">רווח/הפסד</div><div class="stat-value price-change ${totalProfitClass}">${totalProfitSign}${formatCurrency(Math.abs(totalProfit))}</div></div>
                    <div class="modal-stat"><div class="stat-label">תשואה משוכללת</div><div class="stat-value price-change ${totalProfitClass}" style="font-size:22px">${totalProfitSign}${totalReturnPct.toFixed(2)}%</div></div>
                    <div class="modal-stat"><div class="stat-label">שווי מניות</div><div class="stat-value" style="color:var(--color-neutral)">${formatCurrency(totalStockValue)}</div></div>
                    <div class="modal-stat"><div class="stat-label">שווי אג"ח</div><div class="stat-value" style="color:var(--color-bonds)">${formatCurrency(totalBondValue)}</div></div>
                    <div class="modal-stat"><div class="stat-label">מזומן (USD)</div><div class="stat-value" style="color:var(--accent-green)">${formatCurrency(client.cash?.usd || 0, 'USD')}</div></div>
                    <div class="modal-stat"><div class="stat-label">מזומן (ILS)</div><div class="stat-value" style="color:var(--accent-green)">${formatCurrency(client.cash?.ils || 0, 'ILS')}</div></div>
                </div>
                <div class="modal-charts-row">
                    <div class="modal-chart-container modal-chart-small" style="margin:0"><canvas id="modal-chart"></canvas></div>
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
            </div>
            <!-- Tab: Holdings -->
            <div class="modal-tab-content" id="tab-holdings">
                <button class="add-asset-btn" onclick="openMgmtModal('addHolding', clients.find(c=>c.id===${client.id}))">+ הוסף נכס חדש</button>
                <table class="holdings-table">
                    <thead><tr><th>נכס</th><th>מחיר קנייה</th><th>מחיר נוכחי</th><th>כמות</th><th>שווי כולל</th><th>שינוי יומי</th><th>רווח/הפסד</th><th>תשואה</th><th>פעולות</th></tr></thead>
                    <tbody>${holdingsRows}${holdingsFooter}</tbody>
                </table>
            </div>
            <!-- Tab: Sectors -->
            <div class="modal-tab-content" id="tab-sectors">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
                    <div><div style="height:280px"><canvas id="modal-sector-chart"></canvas></div></div>
                    <div><table class="sector-table"><thead><tr><th>סקטור</th><th>שווי</th><th>אחוז</th></tr></thead><tbody>${sectorRows}</tbody></table></div>
                </div>
            </div>
            <!-- Tab: Transactions -->
            <div class="modal-tab-content" id="tab-transactions">
                <table class="holdings-table">
                    <thead><tr><th>תאריך</th><th>פעולה</th><th>נכס</th><th>כמות</th><th>מחיר</th><th>סה"כ</th><th>רווח ממומש</th></tr></thead>
                    <tbody>${transRows}</tbody>
                </table>
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
        renderPerformanceChart('modal-perf-chart', client.id, '1y', []).then(inst => {
            _modalPerfChartInstance = inst;
        });
    }, 100);
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

    const totalProfit = client.portfolioValue - client.initialInvestment;
    const totalReturn = client.initialInvestment > 0 ? (totalProfit / client.initialInvestment * 100) : 0;
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
                <div class="mgmt-field"><label>מזומן (USD)</label><input type="number" id="mgmt-cash-usd" min="0" step="100" value="0" placeholder="0" oninput="updateAddClientRisk()" /></div>
                <div class="mgmt-field"><label>מזומן (ILS)</label><input type="number" id="mgmt-cash-ils" min="0" step="100" value="0" placeholder="0" oninput="updateAddClientRisk()" /></div>

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
                                <th style="width:32%">סימול</th>
                                <th style="width:15%">כמות</th>
                                <th style="width:20%" id="addPortfolio-price-header">מחיר קנייה ($)</th>
                                <th style="width:22%">מחיר נוכחי</th>
                                <th style="width:11%"></th>
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
                <div class="mgmt-field"><label>סוג נכס</label>
                    <select id="mgmt-asset-type" onchange="onAssetTypeChange()">
                        <option value="stock">מניה</option>
                        <option value="bond">אג"ח</option>
                        <option value="fund">קרן נאמנות</option>
                    </select>
                </div>
                <div class="mgmt-field" id="mgmt-ticker-field">
                    <label>חיפוש מניה</label>
                    <div class="ticker-search-wrapper">
                        <input type="hidden" id="mgmt-ticker-symbol" />
                        <input type="hidden" id="mgmt-ticker-currency" />
                        <input type="hidden" id="mgmt-ticker-name" />
                        <div id="mgmt-ticker-selected" class="ticker-selected-badge" style="display:none"></div>
                        <input type="text" id="mgmt-ticker-search" placeholder='חפש: AAPL, טבע, לאומי...' style="text-align:left" oninput="onTickerSearch()" autocomplete="off" />
                        <div id="mgmt-ticker-dropdown" class="ticker-search-dropdown"></div>
                    </div>
                </div>
                <div class="mgmt-field" id="mgmt-bondname-field" style="display:none"><label>שם האג"ח</label><input type="text" id="mgmt-bondname" placeholder='לדוגמה: אג"ח ממשלתי צמוד' /></div>
                <div class="mgmt-field" id="mgmt-asset-class-field" style="display:none"><label>סיווג אג"ח</label>
                    <select id="mgmt-asset-class">
                        <option value="Gov Bond">אג"ח ממשלתי</option>
                        <option value="Corp Bond">אג"ח קונצרני</option>
                    </select>
                </div>
                <div id="mgmt-live-price-preview" style="display:none;padding:4px 0;font-size:12px;text-align:right"></div>
                <div class="mgmt-field"><label>מחיר קנייה (<span id="mgmt-price-currency-label">$</span>)</label><input type="number" id="mgmt-price" step="0.01" min="0" placeholder="0.00" style="direction:ltr;text-align:left" oninput="updateBuyCost()" /></div>
                <div class="mgmt-field"><label>כמות יחידות</label><input type="number" id="mgmt-qty" min="1" placeholder="0" style="direction:ltr;text-align:left" oninput="updateBuyCost()" /></div>
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
                <div class="mgmt-field"><label>מחיר קנייה (${editCurrSymbol})</label><input type="number" id="mgmt-edit-price" step="0.01" min="0" value="${h.shares > 0 ? (h.costBasis / h.shares).toFixed(2) : h.price.toFixed(2)}" style="direction:ltr;text-align:left" /></div>
                <div class="mgmt-field"><label>כמות יחידות</label><input type="number" id="mgmt-edit-qty" min="1" value="${h.shares}" style="direction:ltr;text-align:left" /></div>
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
                <div class="mgmt-field"><label>מחיר שוק נוכחי</label><div class="mgmt-readonly">${h.price.toFixed(2)} ${currSymbol}</div></div>
                <div class="mgmt-field"><label>עלות ממוצעת למניה</label><div class="mgmt-readonly">${avgCost.toFixed(2)} ${currSymbol}</div></div>
                <div class="mgmt-field"><label>כמות באחזקה</label><div class="mgmt-readonly">${h.shares}</div></div>
                <input type="hidden" id="mgmt-sell-avg-cost" value="${avgCost}" />
                <input type="hidden" id="mgmt-sell-currency" value="${h.currency || 'USD'}" />
                <div class="mgmt-field"><label>מחיר מכירה (${currSymbol})</label><input type="number" id="mgmt-sell-price" step="0.01" min="0.01" value="${h.price.toFixed(2)}" style="direction:ltr;text-align:left" oninput="updateSellSummary()" /></div>
                <div class="mgmt-field"><label>כמות למכירה</label><input type="number" id="mgmt-sell-qty" min="1" max="${h.shares}" value="${h.shares}" style="direction:ltr;text-align:left" oninput="updateSellSummary()" /></div>
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
                <div class="mgmt-field"><label>סכום להפקדה</label><input type="number" id="mgmt-deposit-amount" step="100" min="1" placeholder="0" style="direction:ltr;text-align:left" oninput="updateDepositPreview()" /></div>
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

function onAssetTypeChange() {
    const type = document.getElementById('mgmt-asset-type').value;
    // Stock and fund use ticker search; bond uses free-text name
    document.getElementById('mgmt-ticker-field').style.display = (type === 'stock' || type === 'fund') ? '' : 'none';
    document.getElementById('mgmt-bondname-field').style.display = type === 'bond' ? '' : 'none';
    // Show asset_class selector only for bonds
    const assetClassField = document.getElementById('mgmt-asset-class-field');
    if (assetClassField) assetClassField.style.display = type === 'bond' ? '' : 'none';
    // Update search label
    const searchLabel = document.querySelector('#mgmt-ticker-field label');
    if (searchLabel) {
        searchLabel.textContent = type === 'fund' ? 'חיפוש קרן נאמנות' : 'חיפוש מניה';
    }
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
    // Clear previous selection when switching type
    clearTickerSelection();
    // Update buy cost display for currency switch
    updateBuyCost();
}

// Live buy cost calculation
function updateBuyCost() {
    const price = parseFloat(document.getElementById('mgmt-price')?.value) || 0;
    const qty = parseInt(document.getElementById('mgmt-qty')?.value) || 0;
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
    const amount = parseFloat(document.getElementById('mgmt-deposit-amount')?.value) || 0;
    const currency = document.getElementById('mgmt-deposit-currency')?.value || 'USD';
    const currentCash = (currency === 'ILS')
        ? (parseFloat(document.getElementById('mgmt-deposit-cash-ils')?.value) || 0)
        : (parseFloat(document.getElementById('mgmt-deposit-cash-usd')?.value) || 0);
    const newBalanceEl = document.getElementById('mgmt-deposit-new-balance');
    if (newBalanceEl) newBalanceEl.textContent = formatCurrency(currentCash + amount, currency);
}

// --- Ticker Search (Twelve Data symbol_search + local Hebrew lookup) ---

// Shared renderer for both main and row dropdowns
function _renderSearchDropdown(results, dropdown, fetchPrices = false) {
    if (results.length === 0) {
        dropdown.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>';
        return;
    }
    dropdown.innerHTML = results.map(r => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[r.symbol.replace('.TA', '').toUpperCase()] : '');
        const safeName = (r.name || '').replace(/'/g, "\\'");
        const currDisplay = (r.currency === 'ILS' || r.currency === 'ILA') ? '₪' : '$';
        const exchangeLabel = r.exchange || '';
        const primaryLabel = heName || r.name;
        const secondaryLabel = heName ? r.name : '';
        const safeId = r.symbol.replace(/[^a-zA-Z0-9]/g, '_');
        return `<div class="ticker-search-item" onclick="selectSearchResult('${r.symbol}', '${safeName}', '${r.currency}', '${r.exchange}')" style="padding:8px 10px">
            <div style="display:flex;align-items:center;width:100%;gap:8px">
                <div style="display:flex;flex-direction:column;min-width:0;flex:1;overflow:hidden">
                    <span class="ticker-search-item-name" style="font-weight:600;color:var(--text-primary);font-size:13px">${primaryLabel}</span>
                    ${secondaryLabel ? `<span class="ticker-search-item-name" style="color:var(--text-muted);font-size:11px">${secondaryLabel}</span>` : ''}
                </div>
                <span class="search-live-price" id="slp_${safeId}"></span>
                <div class="ticker-search-item-info" style="display:flex;flex-direction:column;align-items:flex-end">
                    <span style="font-weight:600;color:var(--accent-blue);font-size:12px;direction:ltr">${r.symbol}</span>
                    <span style="color:var(--text-muted);font-size:10px">${exchangeLabel} · ${currDisplay}</span>
                </div>
            </div>
        </div>`;
    }).join('');

    if (fetchPrices) _fetchSearchResultPrices(results);
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

// --- Live price fetching for search dropdown results ---
let _searchPriceBatchId = 0;

async function _fetchSearchResultPrices(results, idPrefix = '') {
    const batchId = ++_searchPriceBatchId;
    // Limit to first 5 results to avoid API rate limits
    const toFetch = results.slice(0, 5);

    for (const r of toFetch) {
        // Bail if a newer search replaced this dropdown
        if (_searchPriceBatchId !== batchId) return;

        const safeId = r.symbol.replace(/[^a-zA-Z0-9]/g, '_');
        const el = document.getElementById(`slp_${idPrefix}${safeId}`);
        if (!el) continue;

        el.textContent = '...';

        // Check priceCache first (instant hit)
        const cached = (typeof priceCache !== 'undefined') ? priceCache[r.symbol.toUpperCase().trim()] : null;
        if (cached && cached.price > 0) {
            const cs = (r.currency === 'ILS' || r.currency === 'ILA') ? '₪' : '$';
            el.textContent = `${cached.price.toFixed(2)} ${cs}`;
            continue;
        }

        // Fire async fetch (don't await all — fire sequentially to avoid hammering)
        try {
            const result = (typeof fetchSingleTickerPrice === 'function')
                ? await fetchSingleTickerPrice(r.symbol, r.currency || null)
                : null;
            if (_searchPriceBatchId !== batchId) return;
            const el2 = document.getElementById(`slp_${idPrefix}${safeId}`);
            if (!el2) continue;
            if (result && result.price > 0) {
                const cs = (r.currency === 'ILS' || r.currency === 'ILA') ? '₪' : '$';
                el2.textContent = `${result.price.toFixed(2)} ${cs}`;
            } else {
                el2.textContent = '—';
            }
        } catch (e) {
            const el2 = document.getElementById(`slp_${idPrefix}${safeId}`);
            if (el2) el2.textContent = '—';
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

    // Instantly show local Hebrew matches while API loads
    const localResults = (typeof searchHebrewNames === 'function') ? searchHebrewNames(query) : [];
    dropdown.style.display = 'block';
    if (localResults.length > 0) {
        _renderSearchDropdown(localResults, dropdown);
    } else {
        dropdown.innerHTML = '<div class="ticker-search-loading">מחפש...</div>';
    }

    tickerSearchTimeout = setTimeout(async () => {
        const apiResults = await searchTwelveDataSymbols(query);
        const merged = _mergeLocalAndApiResults(localResults, apiResults);
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

    document.getElementById('mgmt-ticker-symbol').value = symbol;
    document.getElementById('mgmt-ticker-currency').value = effectiveCurrency;
    document.getElementById('mgmt-ticker-name').value = name;

    // Hebrew name priority — show Hebrew name if available
    const heName = (typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[symbol.replace('.TA', '').toUpperCase()] : '';
    const displayLabel = heName ? `${symbol} — ${heName}` : `${symbol} — ${name}`;
    const currLabel = effectiveCurrency === 'ILS' ? '₪' : '$';

    // Show selected badge, hide search input
    const badge = document.getElementById('mgmt-ticker-selected');
    badge.innerHTML = `<span>${displayLabel} (${exchange}, ${currLabel})</span><button class="ticker-clear-btn" onclick="clearTickerSelection()">&times;</button>`;
    badge.style.display = 'flex';

    document.getElementById('mgmt-ticker-search').style.display = 'none';
    document.getElementById('mgmt-ticker-dropdown').style.display = 'none';

    // Update price label to match the asset's currency
    const priceCurrLabelEl = document.getElementById('mgmt-price-currency-label');
    if (priceCurrLabelEl) priceCurrLabelEl.textContent = currLabel;

    // If 7-9 digit numeric symbol, auto-switch to bond type
    // NOTE: Do NOT call onAssetTypeChange() here — it calls clearTickerSelection()
    // which would wipe the values we just set. Instead, toggle UI fields directly.
    if (/^\d{7,9}$/.test(symbol)) {
        const typeSelect = document.getElementById('mgmt-asset-type');
        if (typeSelect) typeSelect.value = 'bond';
        // Show bond fields, hide ticker search (already hidden by badge)
        const bondNameField = document.getElementById('mgmt-bondname-field');
        if (bondNameField) bondNameField.style.display = '';
        const assetClassField = document.getElementById('mgmt-asset-class-field');
        if (assetClassField) assetClassField.style.display = '';
        // Pre-fill bond name
        const bondNameInput = document.getElementById('mgmt-bondname');
        if (bondNameInput) bondNameInput.value = name || symbol;
        // Set hidden currency to ILS
        document.getElementById('mgmt-ticker-currency').value = 'ILS';
    }

    updateBuyCost();

    // Live price preview — fetch current market price in background
    _fetchLivePricePreview(symbol);
}

async function _fetchLivePricePreview(symbol) {
    const previewEl = document.getElementById('mgmt-live-price-preview');
    if (!previewEl) return;

    previewEl.textContent = 'טוען מחיר שוק...';
    previewEl.style.display = '';

    const currency = document.getElementById('mgmt-ticker-currency')?.value || 'USD';

    try {
        const result = (typeof fetchSingleTickerPrice === 'function')
            ? await fetchSingleTickerPrice(symbol, currency)
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
    const cashUsd = parseFloat(rawUsd) || 0;
    const cashIls = parseFloat(rawIls) || 0;

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
    const type = document.getElementById('mgmt-asset-type').value;
    const price = parseFloat(document.getElementById('mgmt-price').value);
    const quantity = parseInt(document.getElementById('mgmt-qty').value);

    if (!price || price <= 0) { alert('נא להזין מחיר קנייה תקין'); return; }
    if (!quantity || quantity <= 0) { alert('נא להזין כמות תקינה'); return; }

    let holdingData = { type, price, quantity };

    if (type === 'stock' || type === 'fund') {
        const ticker = (document.getElementById('mgmt-ticker-symbol')?.value || '').toUpperCase().trim();
        if (!ticker) { alert('נא לבחור נכס מתוך תוצאות החיפוש'); return; }
        holdingData.ticker = ticker;
        holdingData.currency = document.getElementById('mgmt-ticker-currency')?.value || 'USD';
        holdingData.stockName = document.getElementById('mgmt-ticker-name')?.value || ticker;
    } else {
        const bondName = (document.getElementById('mgmt-bondname').value || '').trim();
        if (!bondName) { alert('נא להזין שם אג"ח'); return; }
        holdingData.bondName = bondName;
        holdingData.assetClass = document.getElementById('mgmt-asset-class')?.value || 'Gov Bond';
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
            alert('שגיאה בביצוע הקנייה');
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
    const amount = parseFloat(document.getElementById('mgmt-deposit-amount')?.value);
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
    const newPrice = parseFloat(document.getElementById('mgmt-edit-price').value);
    const newQty = parseInt(document.getElementById('mgmt-edit-qty').value);

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
    const sellPrice = parseFloat(document.getElementById('mgmt-sell-price')?.value) || 0;
    const qty = parseInt(document.getElementById('mgmt-sell-qty')?.value) || 0;
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
    const sellQty = parseInt(document.getElementById('mgmt-sell-qty').value);
    const sellPrice = parseFloat(document.getElementById('mgmt-sell-price').value);
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
        <td><input type="number" class="row-shares" min="1" value="${prefill?.shares || ''}" placeholder="0"
                   style="direction:ltr;text-align:left" oninput="updateAddClientRisk()" /></td>
        <td><input type="number" class="row-price" min="0" step="0.01" value="${prefill?.avgPrice || ''}" placeholder="0.00"
                   style="direction:ltr;text-align:left" oninput="updateAddClientRisk()" /></td>
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

function _renderRowSearchDropdown(results, dropdown, rowId, fetchPrices = false) {
    if (results.length === 0) {
        dropdown.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>';
        return;
    }
    dropdown.innerHTML = results.map(r => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[r.symbol.replace('.TA', '').toUpperCase()] : '');
        const currDisplay = (r.currency === 'ILS' || r.currency === 'ILA') ? '₪' : '$';
        const exchangeLabel = r.exchange || '';
        const primaryLabel = heName || r.name;
        const secondaryLabel = heName ? r.name : '';
        const safeId = r.symbol.replace(/[^a-zA-Z0-9]/g, '_');
        return `<div class="ticker-search-item" onclick="selectRowTicker('${rowId}', '${r.symbol}', '${r.currency}')" style="padding:8px 10px">
            <div style="display:flex;align-items:center;width:100%;gap:8px">
                <div style="display:flex;flex-direction:column;min-width:0;flex:1;overflow:hidden">
                    <span class="ticker-search-item-name" style="font-weight:600;color:var(--text-primary);font-size:13px">${primaryLabel}</span>
                    ${secondaryLabel ? `<span class="ticker-search-item-name" style="color:var(--text-muted);font-size:11px">${secondaryLabel}</span>` : ''}
                </div>
                <span class="search-live-price" id="slp_row_${safeId}"></span>
                <div class="ticker-search-item-info" style="display:flex;flex-direction:column;align-items:flex-end">
                    <span style="font-weight:600;color:var(--accent-blue);font-size:12px;direction:ltr">${r.symbol}</span>
                    <span style="color:var(--text-muted);font-size:10px">${exchangeLabel} · ${currDisplay}</span>
                </div>
            </div>
        </div>`;
    }).join('');

    if (fetchPrices) _fetchSearchResultPrices(results, 'row_');
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

    // Instantly show local Hebrew matches
    const localResults = (typeof searchHebrewNames === 'function') ? searchHebrewNames(query) : [];
    if (dropdown) {
        dropdown.style.display = 'block';
        if (localResults.length > 0) {
            _renderRowSearchDropdown(localResults, dropdown, rowId);
        } else {
            dropdown.innerHTML = '<div class="ticker-search-loading">מחפש...</div>';
        }
    }

    _rowSearchTimeouts[rowId] = setTimeout(async () => {
        const apiResults = await searchTwelveDataSymbols(query);
        if (!dropdown) return;
        const merged = _mergeLocalAndApiResults(localResults, apiResults);
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
        const shares = parseInt(row.querySelector('.row-shares')?.value) || 0;
        const price = parseFloat(row.querySelector('.row-price')?.value) || 0;
        const currency = row.dataset?.currency || 'USD';

        if (!ticker || shares <= 0 || price <= 0) return;

        // Detect cash rows — route to cash balance, not holdings
        if (typeof _isCashRow === 'function' && _isCashRow(ticker)) {
            extraCash += shares * price;
            return;
        }

        holdings.push({
            type: 'stock',
            ticker,
            stockName: ticker,
            price,
            quantity: shares,
            currency
        });
    });

    // If cash rows were found, add to the USD cash input field
    if (extraCash > 0) {
        const cashInput = document.getElementById('mgmt-cash-usd');
        if (cashInput) {
            const existing = parseFloat(cashInput.value) || 0;
            cashInput.value = (existing + extraCash).toFixed(2);
        }
    }

    return holdings;
}

// Real-time risk calculation
function updateAddClientRisk() {
    const cash = (parseFloat(document.getElementById('mgmt-cash-usd')?.value) || 0) + (parseFloat(document.getElementById('mgmt-cash-ils')?.value) || 0);
    const tbody = document.getElementById('mgmt-holdings-tbody');

    let totalStockValue = 0;
    if (tbody) {
        tbody.querySelectorAll('tr').forEach(row => {
            const shares = parseInt(row.querySelector('.row-shares')?.value) || 0;
            const price = parseFloat(row.querySelector('.row-price')?.value) || 0;
            totalStockValue += shares * price;
        });
    }

    const total = totalStockValue + cash;
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
                    const existing = parseFloat(cashInput.value) || 0;
                    cashInput.value = (existing + cashFromFile).toFixed(2);
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
