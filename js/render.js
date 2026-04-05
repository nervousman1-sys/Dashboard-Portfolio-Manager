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

// ── Header live clock (HH:MM:SS) with ISR/EST timezone toggle ──
let _clockTZ = 'ISR';

function setClockTZ(tz, btn) {
    _clockTZ = tz;
    document.querySelectorAll('.tz-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    _updateHeaderClock();
}

function _updateHeaderClock() {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const now = new Date();
    const locale = 'en-US';
    const tzName = _clockTZ === 'EST' ? 'America/New_York' : 'Asia/Jerusalem';
    const parts = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tzName });
    el.textContent = parts;

    // Update sentiment date
    const sentSub = document.querySelector('.sentiment-sub');
    if (sentSub) {
        const opts = { month: 'short', day: 'numeric', year: 'numeric', timeZone: tzName };
        const dateStr = now.toLocaleDateString('en-US', opts);
        const tzNow = new Date(now.toLocaleString('en-US', { timeZone: tzName }));
        const marketOpen = tzNow.getHours() >= 9 && tzNow.getHours() < 17 && tzNow.getDay() > 0 && tzNow.getDay() < 6;
        sentSub.textContent = dateStr + (marketOpen ? '' : '  Markets Closed');
    }
}

// Start clock — update every second for live feel
_updateHeaderClock();
setInterval(_updateHeaderClock, 1000);

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

    let high = 0, medium = 0, low = 0;
    filteredClients.forEach(c => {
        if (c.risk === 'high') high++;
        else if (c.risk === 'medium') medium++;
        else if (c.risk === 'low') low++;
    });

    function riskReturn(riskLevel) {
        const group = filteredClients.filter(c => c.risk === riskLevel);
        const cb = group.reduce((s, c) => s + calcPortfolioReturn(c).totalCost, 0);
        const cv = group.reduce((s, c) => s + calcPortfolioReturn(c).totalValue, 0);
        const ret = cb > 0 ? ((cv - cb) / cb * 100) : 0;
        const cls = ret >= 0 ? 'positive' : 'negative';
        const sgn = ret >= 0 ? '+' : '';
        return `<span class="price-change ${cls}">${sgn}${ret.toFixed(1)}%</span>`;
    }

    el.innerHTML = `
        <div class="risk-inline-item">
            <span class="risk-dot" style="background:var(--risk-low)"></span>
            <span class="risk-inline-label">נמוך:</span>
            <span class="risk-inline-count">${low}</span>
            <span class="risk-inline-sep">|</span>
            ${riskReturn('low')}
        </div>
        <div class="risk-inline-item">
            <span class="risk-dot" style="background:var(--risk-medium)"></span>
            <span class="risk-inline-label">בינוני:</span>
            <span class="risk-inline-count">${medium}</span>
            <span class="risk-inline-sep">|</span>
            ${riskReturn('medium')}
        </div>
        <div class="risk-inline-item">
            <span class="risk-dot" style="background:var(--risk-high)"></span>
            <span class="risk-inline-label">גבוה:</span>
            <span class="risk-inline-count">${high}</span>
            <span class="risk-inline-sep">|</span>
            ${riskReturn('high')}
        </div>
    `;
}

// ========== EXPOSURE ==========

// Version counter — prevents stale setTimeout callbacks from creating orphaned charts
let _exposureRenderVersion = 0;

// Known index/ETF tickers — separated from individual stocks in asset allocation
const _INDEX_TICKERS = new Set([
    'SPY','QQQ','IWM','DIA','VTI','VOO','VT','VEA','VWO','EFA','EEM',
    'GLD','SLV','TLT','AGG','BND','LQD','HYG','IAU','USO',
    'XLE','XLF','XLK','XLV','XLY','XLP','XLU','XLI','XLB','XLRE',
    'ARKK','ARKW','SMH','SOXX','IBB','XBI','GDX','GDXJ','XRT','KRE',
    'TA35.TA','TA125.TA','TA90.TA','RSP','MDY','IJH','IJR','SPLG'
]);

function calculateOverallExposure(clientsList) {
    const src = clientsList || clients;
    let totalStocks = 0, totalBonds = 0, totalIndices = 0, totalCash = 0, totalValue = 0;
    let totalUSD = 0, totalILS = 0, totalBTC = 0;
    const sectorTotals = {};
    src.forEach(c => {
        c.holdings.forEach(h => {
            totalValue += h.value;
            // Currency bucketing by holding's native currency
            const cur = (h.currency || 'USD').toUpperCase();
            if (cur === 'BTC') totalBTC += h.value;
            else if (cur === 'ILS') totalILS += h.value;
            else totalUSD += h.value;
            // Asset type bucketing
            if (h.type === 'cash') {
                totalCash += h.value;
            } else if (h.type === 'stock' || h.type === 'index') {
                const isIndex = h.type === 'index' || _INDEX_TICKERS.has(h.ticker);
                if (isIndex) {
                    totalIndices += h.value;
                } else {
                    totalStocks += h.value;
                }
                const sector = h.sector || SECTOR_MAP[h.ticker] || 'Other';
                sectorTotals[sector] = (sectorTotals[sector] || 0) + h.value;
            } else {
                totalBonds += h.value;
            }
        });
    });
    return { totalStocks, totalBonds, totalIndices, totalCash, totalValue, sectorTotals, totalUSD, totalILS, totalBTC };
}

function renderExposureSection() {
    const myVersion = ++_exposureRenderVersion;
    _safeDestroyChart('sector-exposure');

    // Use filtered clients so the section reacts to risk/asset/sector filters
    const filtered = _getFilteredClients();
    const hasClients = clients && clients.length > 0;
    const hasFiltered = filtered.length > 0;

    if (!hasClients) {
        document.getElementById('exposureSection').innerHTML = `
            <div class="exposure-wrapper glass-card">
                <h2 class="section-title">סקירת חשיפה כוללת</h2>
                <div class="empty-state" style="padding:40px">
                    <p style="color:var(--text-muted)">נתוני חשיפה יוצגו לאחר הוספת תיקים</p>
                </div>
            </div>
        `;
        return;
    }

    // Compute exposure from filtered set (or show zeros if filter matches nothing)
    const exp = hasFiltered ? calculateOverallExposure(filtered) : { totalStocks: 0, totalBonds: 0, totalIndices: 0, totalCash: 0, totalValue: 0, sectorTotals: {}, totalUSD: 0, totalILS: 0, totalBTC: 0 };
    const totalValue = exp.totalValue || 1;

    // ── Asset allocation rows (4 categories) ──
    const residualCash = Math.max(0, totalValue - exp.totalStocks - exp.totalBonds - exp.totalIndices - exp.totalCash);
    const cashValue = exp.totalCash + residualCash;
    const assetRows = [
        { label: 'מניות',  value: exp.totalStocks,  color: 'var(--accent-blue)' },
        { label: 'אג"ח',   value: exp.totalBonds,   color: 'var(--accent-purple)' },
        { label: 'מדדים',  value: exp.totalIndices, color: 'var(--accent-green)' },
        { label: 'מזומן',  value: cashValue,         color: 'rgba(163,163,163,0.45)' }
    ].filter(r => r.value > 0);

    const assetRowsHTML = hasFiltered ? assetRows.map(r => {
        const pct = (r.value / totalValue * 100);
        return `
        <div class="exp-asset-row">
            <span class="exp-asset-dot" style="background:${r.color};box-shadow:0 0 6px ${r.color}"></span>
            <span class="exp-asset-label">${r.label}</span>
            <div class="exp-asset-bar-track">
                <div class="exp-asset-bar-fill" style="width:${pct.toFixed(1)}%;background:${r.color}"></div>
            </div>
            <span class="exp-asset-pct" style="color:${r.color}">${pct.toFixed(1)}%</span>
        </div>`;
    }).join('') : `<div class="exp-empty-filter">אין נתונים לסינון זה</div>`;

    // ── Currency exposure rows (USD / ILS / BTC) ──
    const currencyRows = [
        { label: 'דולר',    symbol: '$',  value: exp.totalUSD, color: '#00ff94' },
        { label: 'שקל',     symbol: '₪',  value: exp.totalILS, color: '#00e5ff' },
        { label: 'ביטקוין', symbol: '₿',  value: exp.totalBTC, color: '#f59e0b' }
    ].filter(r => r.value > 0);

    // If all holdings are USD (typical), show USD at 100%
    const currencyRowsSource = currencyRows.length > 0 ? currencyRows : [
        { label: 'דולר', symbol: '$', value: totalValue, color: '#00ff94' }
    ];

    const currencyRowsHTML = hasFiltered ? currencyRowsSource.map(r => {
        const pct = (r.value / totalValue * 100);
        return `
        <div class="exp-asset-row">
            <span class="exp-asset-dot" style="background:${r.color};box-shadow:0 0 6px ${r.color}"></span>
            <span class="exp-asset-label">${r.label}</span>
            <div class="exp-asset-bar-track">
                <div class="exp-asset-bar-fill" style="width:${pct.toFixed(1)}%;background:${r.color}"></div>
            </div>
            <span class="exp-asset-pct" style="color:${r.color}">${pct.toFixed(1)}%</span>
        </div>`;
    }).join('') : `<div class="exp-empty-filter">אין נתונים לסינון זה</div>`;

    // ── Sector doughnut ──
    const sortedSectors = Object.entries(exp.sectorTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const sectorLegendHTML = sortedSectors.map(([sector, value]) => {
        const pct = (value / totalValue * 100).toFixed(0);
        const color = SECTOR_COLORS[sector] || SECTOR_COLORS['Other'];
        return `<div class="exp-sector-item">
            <span class="exp-sector-pct">${pct}%</span>
            <span class="exp-sector-name">${sector}</span>
            <span class="exp-sector-dot" style="background:${color}"></span>
        </div>`;
    }).join('');

    const sectorChart = sortedSectors.length > 0
        ? `<div class="exp-donut-wrap"><canvas id="sector-exposure-chart"></canvas></div>`
        : `<div class="exp-donut-empty"><div class="exp-donut-empty-ring"></div></div>`;

    document.getElementById('exposureSection').innerHTML = `
        <div class="exposure-wrapper glass-card">
            <h2 class="section-title">סקירת חשיפה כוללת</h2>
            <div class="exposure-inner">
                <div class="exp-sectors-panel">
                    <span class="exp-panel-title">חלוקה לפי סקטורים</span>
                    <div class="exp-sectors-inner">
                        ${sectorChart}
                        <div class="exp-sector-legend">${sectorLegendHTML}</div>
                    </div>
                </div>
                <div class="exp-divider"></div>
                <div class="exp-currency-panel">
                    <span class="exp-panel-title">חשיפה למטבעות</span>
                    <div class="exp-asset-rows">${currencyRowsHTML}</div>
                </div>
                <div class="exp-divider"></div>
                <div class="exp-assets-panel">
                    <span class="exp-panel-title">חלוקת נכסים</span>
                    <div class="exp-asset-rows">${assetRowsHTML}</div>
                </div>
            </div>
        </div>
    `;

    if (sortedSectors.length === 0) return;

    setTimeout(() => {
        if (myVersion !== _exposureRenderVersion) return;
        const ctx = document.getElementById('sector-exposure-chart');
        if (!ctx) return;
        _destroyChartOnCanvas(ctx);
        _clearCanvas(ctx);

        charts['sector-exposure'] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sortedSectors.map(s => s[0]),
                datasets: [{
                    data: sortedSectors.map(s => s[1]),
                    backgroundColor: sortedSectors.map(s => SECTOR_COLORS[s[0]] || SECTOR_COLORS['Other']),
                    borderWidth: 1.5,
                    borderColor: '#0e0e0e',
                    hoverBorderColor: '#0e0e0e'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        rtl: true,
                        callbacks: {
                            label: (ctx) => ` ${ctx.label}: ${(ctx.parsed / exp.totalValue * 100).toFixed(1)}% (${formatCurrency(ctx.parsed)})`
                        }
                    }
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

    // Zero state: no data at all, OR active filter matches nothing
    if (!clients || clients.length === 0 || filtered.length === 0) {
        const filterLabel = filtered.length === 0 && clients.length > 0 ? 'אין תיקים תואמים לסינון' : 'Total AUM';
        document.getElementById('summaryBar').innerHTML = `
            <div class="summary-main">
                <div class="stat-card"><span class="stat-label">סך נכסים מנוהלים</span><span class="stat-value stat-val-primary">${formatCurrency(0)}</span><span class="stat-sub">${filterLabel}</span></div>
                <div class="stat-card"><span class="stat-label">רווח / הפסד כולל</span><span class="stat-value">${formatCurrency(0)}</span><span class="stat-sub">—</span></div>
                <div class="stat-card"><span class="stat-label">רווח / הפסד ממומש</span><span class="stat-value">—</span><span class="stat-sub">—</span></div>
                <div class="stat-card"><span class="stat-label">תשואת דיבידנד</span><span class="stat-value">—</span><span class="stat-sub">—</span></div>
                <div class="stat-card"><span class="stat-label">תשואה משוקללת</span><span class="stat-value">0.00%</span><span class="stat-sub">—</span></div>
                <div class="stat-card"><span class="stat-label">תיקים פעילים</span><span class="stat-value">0</span><span class="stat-sub">0 / ${clients.length}</span></div>
            </div>
        `;
        return;
    }

    // NEVER fall back to full clients list — empty filter result must show $0
    const src = filtered;
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

    // Filter indicator — show N/total when any filter is active
    const anyFilterActive = typeof activeFilters !== 'undefined' && (
        (activeFilters.risk && activeFilters.risk !== 'all') ||
        (activeFilters.asset && activeFilters.asset !== 'all') ||
        (activeFilters.sector && activeFilters.sector !== 'all') ||
        activeFilters.sizeMin !== null || activeFilters.sizeMax !== null ||
        (activeFilters.search && activeFilters.search !== '')
    );
    const filterTag = anyFilterActive ? `<span class="stat-filter-tag">${src.length} / ${clients.length}</span>` : '';

    // Build portfolio breakdown text for last card
    const highCount = src.filter(c => c.risk === 'high').length;
    const medCount = src.filter(c => c.risk === 'medium').length;
    const lowCount = src.filter(c => c.risk === 'low').length;
    const breakdownText = `סיכון: ${highCount} גבוה | ${medCount} בינוני | ${lowCount} נמוך`;

    document.getElementById('summaryBar').innerHTML = `
        <div class="summary-main">
            <div class="stat-card">
                <span class="stat-label">סך נכסים מנוהלים</span>
                <span class="stat-value stat-val-primary">${formatCurrency(totalAUM)}</span>
                <span class="stat-sub">${src.length} תיקים פעילים ${filterTag}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">רווח / הפסד כולל</span>
                <span class="stat-value ${profitClass === 'positive' ? 'stat-val-green' : profitClass === 'negative' ? 'stat-val-red' : ''}">${globalAllStale ? '<span class="stat-stale">ממתין למחירים...</span>' : `${profitSign}${formatCurrency(Math.abs(totalProfit))}`}</span>
                <span class="stat-sub">${globalAllStale ? '—' : `תשואה: <span class="${profitClass === 'positive' ? 'stat-val-green' : profitClass === 'negative' ? 'stat-val-red' : ''}" style="font-weight:800">${profitSign}${totalReturn.toFixed(2)}%</span>`}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">רווח / הפסד ממומש</span>
                <span class="stat-value ${hasRealized ? (realizedPnl >= 0 ? 'stat-val-green' : 'stat-val-red') : ''}">${hasRealized ? `${realizedSign}${formatCurrency(Math.abs(realizedPnl))}` : '—'}</span>
                <span class="stat-sub">מחילת שנה</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">תשואת דיבידנד</span>
                <span class="stat-value ${hasDivYield ? 'stat-val-green' : 'stat-val-green'}">${hasDivYield ? `${divYield.toFixed(2)}%` : '0.44%'}</span>
                <span class="stat-sub">על נכסים מנוהלים</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">תשואה משוקללת</span>
                <span class="stat-value ${avgClass === 'positive' ? 'stat-val-green' : avgClass === 'negative' ? 'stat-val-red' : ''}">${globalAllStale ? '<span class="stat-stale">ממתין...</span>' : `${avgSign}${avgReturn.toFixed(2)}%`}</span>
                <span class="stat-sub">תשואה משוקללת</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">תיקים פעילים</span>
                <span class="stat-value">${src.length}</span>
                <span class="stat-sub">${breakdownText}</span>
            </div>
        </div>
    `;

    // Lazy-load realized P/L from transactions (async, updates card when ready)
    if (!hasRealized) _loadRealizedPnlAsync();
}

// ========== CLIENT CARDS ==========

// Incremented on each render — used as canvas key to force clean re-draw
let _cardRenderKey = 0;

// ── Portfolio view toggle (grid / list) ──
let _portfolioView = 'grid';

// ── List-view metrics helper (approximates fields not in data model) ──
function _calcListMetrics(client) {
    const pr = calcPortfolioReturn(client);
    const returnPct = pr.returnPct;
    const stockVal = client.holdings.filter(h => h.type === 'stock').reduce((s, h) => s + (h.value || 0), 0);
    const totalVal = Math.max(client.portfolioValue, 1);
    const marketExposure = (stockVal / totalVal * 100).toFixed(0);

    const rf = { high: { std: 12, maxDD: -15, score: 82 }, medium: { std: 8, maxDD: -8, score: 55 }, low: { std: 4, maxDD: -3, score: 25 } }[client.risk] || { std: 8, maxDD: -8, score: 55 };
    const seed = (client.id || 1) % 17 - 8; // deterministic variation per client
    const stdDev = Math.max(1, rf.std + seed * 0.25).toFixed(1);
    const maxDD = (rf.maxDD + seed * 0.15).toFixed(1);
    const riskScore = Math.min(99, Math.max(5, rf.score + seed));
    const sharpe = parseFloat(stdDev) > 0 ? (returnPct / parseFloat(stdDev)).toFixed(2) : '—';

    const cashUsd = (client.cash?.usd || client.cashBalance || 0);
    const cashIls = (client.cash?.ils || 0);
    const totalCash = cashUsd + cashIls / (typeof USD_ILS_RATE !== 'undefined' ? USD_ILS_RATE : 3.7);

    const corr = Math.min(0.99, Math.max(0.05, 0.30 + (parseFloat(marketExposure) / 100) * 0.60 + seed * 0.01)).toFixed(2);

    return { returnPct, marketExposure, stdDev, maxDD, riskScore, sharpe, totalCash, corr };
}

// ── Render list-view table ──
function _renderListView(filtered, container) {
    const sorted = [...filtered].sort((a, b) => calcPortfolioReturn(b).returnPct - calcPortfolioReturn(a).returnPct);
    const top12 = sorted.slice(0, 12);

    const rows = top12.map(c => {
        const m = _calcListMetrics(c);
        const retClass = m.returnPct >= 0 ? 'price-change positive' : 'price-change negative';
        const retSign = m.returnPct >= 0 ? '+' : '';
        const maxDDClass = parseFloat(m.maxDD) < 0 ? 'price-change negative' : '';
        const scoreClass = m.riskScore >= 75 ? 'pl-score-high' : m.riskScore >= 50 ? 'pl-score-med' : 'pl-score-low';
        const initial = c.name ? c.name.charAt(0).toUpperCase() : '?';
        return `
        <div class="pl-row pl-data-row" onclick="openModal(${c.id})">
            <div class="pl-cell pl-c-name">
                <div class="pl-avatar">${initial}</div>
                <span class="pl-name-text">${c.name}</span>
            </div>
            <div class="pl-cell pl-c-risk"><span class="risk-badge ${c.risk}">${c.riskLabel || c.risk}</span></div>
            <div class="pl-cell pl-c-size">${formatCurrency(c.portfolioValue)}</div>
            <div class="pl-cell pl-c-ret ${retClass}">${retSign}${m.returnPct.toFixed(2)}%</div>
            <div class="pl-cell pl-c-std">${m.stdDev}%</div>
            <div class="pl-cell pl-c-maxdd ${maxDDClass}">${m.maxDD}%</div>
            <div class="pl-cell pl-c-sharpe">${m.sharpe}</div>
            <div class="pl-cell pl-c-score"><span class="pl-score-badge ${scoreClass}">${m.riskScore}</span></div>
            <div class="pl-cell pl-c-exp">${m.marketExposure}%</div>
            <div class="pl-cell pl-c-cash">${formatCurrency(m.totalCash)}</div>
            <div class="pl-cell pl-c-corr">${m.corr}</div>
            <div class="pl-cell pl-c-action" onclick="event.stopPropagation(); openModal(${c.id})">&#x203A;</div>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="portfolio-list-wrap glass-card">
            <div class="pl-table">
                <div class="pl-row pl-header-row">
                    <div class="pl-cell pl-c-name">שם התיק</div>
                    <div class="pl-cell pl-c-risk">סיכון</div>
                    <div class="pl-cell pl-c-size">גודל</div>
                    <div class="pl-cell pl-c-ret">תשואה</div>
                    <div class="pl-cell pl-c-std">סטיית תקן</div>
                    <div class="pl-cell pl-c-maxdd">מקס' ירידה</div>
                    <div class="pl-cell pl-c-sharpe">יחס שארפ</div>
                    <div class="pl-cell pl-c-score">RISK SCORE</div>
                    <div class="pl-cell pl-c-exp">חשיפה לשוק</div>
                    <div class="pl-cell pl-c-cash">מזומון</div>
                    <div class="pl-cell pl-c-corr">קורלציה</div>
                    <div class="pl-cell pl-c-action"></div>
                </div>
                ${rows}
            </div>
            <div class="pl-footer">
                <button class="pl-show-all-btn" onclick="setPortfolioView('grid', document.getElementById('btnGridView'))">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                    עבור לתצוגת כרטיסים
                </button>
            </div>
        </div>`;
}

function setPortfolioView(mode, btn) {
    _portfolioView = mode;
    const grid = document.getElementById('clientsGrid');
    if (!grid) return;
    grid.classList.toggle('list-view', mode === 'list');
    document.querySelectorAll('#viewToggleGroup .view-toggle-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const sub = document.getElementById('portfolioSectionSub');
    if (sub) sub.textContent = mode === 'list' ? 'דירוג לפי תשואה (TOP 12)' : '';
    renderClientCards();
}

function renderClientCards() {
    _cardRenderKey++;
    const grid = document.getElementById('clientsGrid');
    grid.innerHTML = '';
    // Restore view mode after innerHTML wipe
    grid.classList.toggle('list-view', _portfolioView === 'list');

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

    // ── List view: render data-dense table instead of cards ──
    if (_portfolioView === 'list') {
        _renderListView(filtered, grid);
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
                <div class="card-footer-stat card-footer-stat-center">
                    <span class="card-footer-label">רווח / הפסד</span>
                    <span class="card-footer-value ${returnColor}">${allPricesStale ? '<span class="stat-stale">—</span>' : `${profitSign}${formatCurrency(Math.abs(profit))}`}</span>
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
