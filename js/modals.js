// ========== MODALS - Client Detail Modal, CRUD Management, Reports ==========

// Transaction history is now fetched from Supabase (supaFetchTransactions)

// ── Background scroll lock ──
// While ANY overlay (client modal / CRUD modal / stock-recommendations popup) is
// open, the page behind must not scroll — wheel/touch outside the window otherwise
// scrolls the background. Checks every overlay so closing one popup while another
// is still open keeps the lock.
function syncBodyScrollLock() {
    const anyOpen = ['modalOverlay', 'mgmtOverlay', 'stockRecoOverlay', 'qwConfigModal', 'assetFitOverlay', 'bulkOverlay']
        .some(id => {
            const el = document.getElementById(id);
            return el && el.classList.contains('active');
        });
    // The page scrolls on the <html> element (html has overflow-x:hidden, which makes
    // IT the scroll container — body{overflow:hidden} alone does NOT stop wheel
    // scrolling). Lock BOTH html and body.
    document.documentElement.classList.toggle('modal-open', anyOpen);
    document.body.classList.toggle('modal-open', anyOpen);
}

// Fills the per-portfolio CML/SML advisory panel in the client modal overview.
// Reuses the cached risk model when available; otherwise builds it on demand.
// Fills the Overview tab's risk-detail block with the model verdict + the
// quantified action plan (no charts/picker — those live in the CML/SML tab).
async function _fillModalAdvisory(clientId) {
    const body = document.getElementById('modalOverviewRiskBody');
    if (!body) return;
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client) return;
    if (typeof buildPortfolioAdvisory !== 'function' || typeof buildRiskModel !== 'function') {
        body.innerHTML = '<div class="adv-empty">מנוע ה-CML/SML אינו זמין.</div>';
        return;
    }
    try {
        let model = window._lastRiskModel;
        if (!model || !model.portfolios) model = await buildRiskModel(clients);
        window._lastRiskModel = model;
        const stillOpen = document.getElementById('modalOverviewRiskBody');
        if (!stillOpen) return;
        const adv = buildPortfolioAdvisory(client, model);
        stillOpen.innerHTML = renderAdvisoryHTML(adv, { compact: true, noCandidates: true, clientId });
        // Refresh the compact compliance bar now that the model is in
        const p = model.portfolios.find(x => x.id === clientId);
        if (p) { client.complianceScore = p.complianceScore; client.complianceLabel = p.complianceLabel; client.compliancePartial = p.partial; }
        // The holdings table renders before the risk model is built, so the β cells
        // start as "—". Now that the model is in, fill them in place.
        if (typeof _refreshHoldingBetaCells === 'function') _refreshHoldingBetaCells(model);
    } catch (e) {
        body.innerHTML = '<div class="adv-empty">לא ניתן לבנות ניתוח CML/SML כרגע.</div>';
    }
}

// Fill the β cells in the open holdings table once the risk model has computed betas.
function _refreshHoldingBetaCells(model) {
    if (!model || !model.assets) return;
    document.querySelectorAll('td[data-bticker]').forEach(td => {
        const tk = td.getAttribute('data-bticker');
        if (!tk) return;
        const a = model.assets[tk];
        if (a && a.beta != null && isFinite(a.beta)) td.textContent = a.beta.toFixed(2);
    });
}

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

    // Render sector chart + correlation matrix + portfolio news on demand
    if (tabName === 'sectors') {
        setTimeout(() => renderModalSectorChart(client), 50);
        if (typeof _renderModalCorrelation === 'function') _renderModalCorrelation(client.id);
        if (typeof _renderPortfolioNews === 'function') _renderPortfolioNews(client.id);
    }

    // Render per-portfolio CML/SML curves + advisory on demand
    if (tabName === 'cmlsml') {
        if (typeof _renderModalRiskCharts === 'function') {
            setTimeout(() => _renderModalRiskCharts(client.id), 50);
        }
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

// ── Holdings table: sortable body (click "נכס" header to cycle) ──
// 0 = original order · 1 = strongest performers (return % high→low) · 2 = by sector
let _holdingsSortMode = 0;
const _HOLD_SORT_LABEL = ['נכס', 'נכס · ביצועים', 'נכס · לפי סקטור'];

function _sortHoldingsFor(holdings, mode) {
    const arr = holdings.slice();
    if (mode === 1) {
        const ret = (h) => (h.costBasis > 0 ? (h.value - h.costBasis) / h.costBasis * 100 : -Infinity);
        arr.sort((a, b) => ret(b) - ret(a));
    } else if (mode === 2) {
        const sec = (h) => h.sector || (h.type === 'stock' ? 'Other' : (h.typeLabel || 'אחר'));
        arr.sort((a, b) => String(sec(a)).localeCompare(String(sec(b))) || (b.value || 0) - (a.value || 0));
    }
    return arr;
}

// Builds the full <tbody> inner HTML (rows + footer) for the current sort mode.
function _buildHoldingsTable(client) {
    const _fxR = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    const _pReturn = (typeof calcPortfolioReturn === 'function') ? calcPortfolioReturn(client) : { totalCost: 0 };
    const _portTotalForPct = client.holdings.reduce((s, hh) => s + (hh.value || 0) * _fxR(hh.currency), 0)
        + ((client.cash?.usd || 0) + (client.cash?.ils || 0) * _fxR('ILS'));

    let holdingsRows = '';
    let totalHoldingsValue = 0, totalHoldingsPnL = 0, totalDailyPnL = 0;
    const ordered = _sortHoldingsFor(client.holdings, _holdingsSortMode);
    let lastSector = null;

    ordered.forEach((h) => {
        // "ממתין" only when we truly have no price yet. A position opened now at the
        // market price already has a price (= cost), so its return is a real 0 — show it.
        const isStale = h.type === 'stock' && !h._livePriceResolved && !(h.price > 0);
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
        const primaryName = heName || (h.type === 'stock' ? h.ticker : h.name);
        const secondaryName = heName ? (h.type === 'stock' ? h.ticker : '') : '';
        const subName = secondaryName ? `<span style="font-size:10px;color:var(--text-muted)">${secondaryName}</span>` : '';
        const _recChip = (() => {
            const m = window._lastRiskModel;
            if (!m || !m.assets || h.type !== 'stock') return '';
            const a = m.assets[h.ticker];
            if (!a || !a.hasData || a.recommendation === 'unknown') return '';
            const color = (typeof rmRecColor === 'function') ? rmRecColor(a.recommendation) : '#64748b';
            const label = (typeof rmRecLabel === 'function') ? rmRecLabel(a.recommendation) : '';
            const tip = `β=${a.beta != null ? a.beta.toFixed(2) : '—'} · α=${a.alpha != null ? (a.alpha * 100).toFixed(1) + '%' : '—'}`;
            return `<span class="rec-chip" style="--rec:${color}" title="${tip}">${label}</span>`;
        })();
        // Order tag + stop-loss/target badges (local annotation), with breach flagging.
        const _orderChip = (() => {
            const ann = (typeof _orderAnnGet === 'function') ? _orderAnnGet(client.id, h.ticker) : null;
            if (!ann) return '';
            const cs = currSymbol;
            const out = [];
            if (ann.orderType === 'limit') out.push('<span class="order-badge ot">לימיט</span>');
            if (ann.stopLoss) {
                const hit = h.price > 0 && h.price <= ann.stopLoss;
                out.push(`<span class="order-badge sl${hit ? ' breach' : ''}" title="${hit ? 'מחיר השוק חצה את הסטופ-לוס!' : 'סטופ-לוס מוגדר'}">⛒ ${formatPrice(ann.stopLoss)}${cs}${hit ? ' ⚠' : ''}</span>`);
            }
            if (ann.target) {
                const hit = h.price > 0 && h.price >= ann.target;
                out.push(`<span class="order-badge tp${hit ? ' reached' : ''}" title="${hit ? 'מחיר השוק הגיע ליעד!' : 'יעד / טייק-פרופיט'}">◎ ${formatPrice(ann.target)}${cs}${hit ? ' ✓' : ''}</span>`);
            }
            return out.join(' ');
        })();
        const _hFx = _fxR(h.currency);
        totalHoldingsValue += h.value * _hFx;
        totalHoldingsPnL += isStale ? 0 : holdingProfit * _hFx;
        const dailyProfit = (h.previousClose > 0 && h.shares > 0) ? (h.price - h.previousClose) * h.shares : 0;
        totalDailyPnL += isStale ? 0 : dailyProfit * _hFx;
        const dailyProfitClass = dailyProfit >= 0 ? 'positive' : 'negative';
        const dailyProfitSign = dailyProfit >= 0 ? '+' : '';
        const _betaCell = (() => {
            const m = window._lastRiskModel;
            const a = m && m.assets && h.type === 'stock' ? m.assets[h.ticker] : null;
            return (a && a.beta != null && isFinite(a.beta)) ? a.beta.toFixed(2) : '<span style="color:var(--text-muted)">—</span>';
        })();
        const _pctOfPort = _portTotalForPct > 0 ? (h.value * _hFx / _portTotalForPct * 100) : 0;

        // In "by sector" mode, emit a thin sector divider row when the sector changes
        if (_holdingsSortMode === 2) {
            const sec = h.sector || (h.type === 'stock' ? 'Other' : (h.typeLabel || 'אחר'));
            if (sec !== lastSector) {
                lastSector = sec;
                holdingsRows += `<tr class="hold-sector-row"><td colspan="14">${sec}</td></tr>`;
            }
        }

        holdingsRows += `<tr>
            <td>
                <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:var(--text-primary)">${primaryName}</span>
                    ${subName}
                    <span style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                        <span class="asset-type-badge ${(typeof isFundLike === 'function' && isFundLike(h)) ? 'fund' : h.type}" style="font-size:10px;width:fit-content">${(typeof assetTypeLabel === 'function') ? assetTypeLabel(h) : h.typeLabel}</span>
                        ${_recChip}
                        ${_orderChip}
                    </span>
                </div>
            </td>
            <td>${formatPrice(purchasePrice)} ${currSymbol}</td>
            <td>${isStale ? `<span style="color:var(--text-muted)" title="ממתין לעדכון מחיר מהשוק">${formatPrice(h.price)} ${currSymbol}</span>` : `${formatPrice(h.price)} ${currSymbol}`}</td>
            <td id="yh_${h.id}">${h.yearHigh ? `${formatPrice(h.yearHigh)} ${currSymbol}` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td id="yl_${h.id}">${h.yearLow ? `${formatPrice(h.yearLow)} ${currSymbol}` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td data-label="כמות" class="col-quantity">${formatAssetQuantity(h.shares)}</td>
            <td style="font-weight:600;color:var(--text-primary)">${formatCurrency(h.value, h.currency)}</td>
            <td style="font-weight:600">${_pctOfPort >= 0.05 ? _pctOfPort.toFixed(1) + '%' : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td id="beta_${h.id}" data-bticker="${h.type === 'stock' ? h.ticker : ''}">${_betaCell}</td>
            <td class="price-change ${isStale ? '' : changeClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${changeSign}${change.toFixed(2)}%`}</td>
            <td class="price-change ${isStale ? '' : dailyProfitClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${dailyProfitSign}${formatCurrency(Math.abs(dailyProfit), h.currency)}`}</td>
            <td class="price-change ${isStale ? '' : holdingProfitClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${holdingProfitSign}${formatCurrency(Math.abs(holdingProfit), h.currency)}`}</td>
            <td class="price-change ${isStale ? '' : holdingProfitClass}" style="font-weight:700">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${holdingProfitSign}${holdingReturn.toFixed(2)}%`}</td>
            <td>
                <button class="holding-action-btn buy" onclick="openMgmtModal('buyHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">קנה</button>
                <button class="holding-action-btn sell" onclick="openMgmtModal('sellHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">מכור</button>
            </td>
        </tr>`;
    });

    const totalPnLClass = totalHoldingsPnL >= 0 ? 'positive' : 'negative';
    const totalPnLSign = totalHoldingsPnL >= 0 ? '+' : '';
    const totalReturnPctHoldings = _pReturn.totalCost > 0 ? (totalHoldingsPnL / _pReturn.totalCost * 100) : 0;
    const totalDailyClass = totalDailyPnL >= 0 ? 'positive' : 'negative';
    const totalDailySign = totalDailyPnL >= 0 ? '+' : '';
    const totalDailyPct = (totalHoldingsValue - totalDailyPnL) > 0 ? (totalDailyPnL / (totalHoldingsValue - totalDailyPnL) * 100) : 0;
    const holdingsFooter = `<tr class="holdings-footer-row">
        <td style="font-weight:700;color:var(--text-primary)">סה"כ</td>
        <td></td><td></td><td></td><td></td><td></td>
        <td style="font-weight:700;color:var(--text-primary)">${formatCurrency(totalHoldingsValue)}</td>
        <td></td><td></td>
        <td class="price-change ${totalDailyClass}" style="font-weight:700">${totalDailySign}${totalDailyPct.toFixed(2)}%</td>
        <td class="price-change ${totalDailyClass}" style="font-weight:700">${totalDailySign}${formatCurrency(Math.abs(totalDailyPnL))}</td>
        <td class="price-change ${totalPnLClass}" style="font-weight:700">${totalPnLSign}${formatCurrency(Math.abs(totalHoldingsPnL))}</td>
        <td class="price-change ${totalPnLClass}" style="font-weight:700">${totalPnLSign}${totalReturnPctHoldings.toFixed(2)}%</td>
        <td></td>
    </tr>`;
    return holdingsRows + holdingsFooter;
}

function _cycleHoldingsSort(clientId) {
    _holdingsSortMode = (_holdingsSortMode + 1) % 3;
    const client = (typeof clients !== 'undefined' ? clients : []).find(c => c.id === clientId);
    if (!client) return;
    const body = document.getElementById('holdingsTbody');
    if (body) body.innerHTML = _buildHoldingsTable(client);
    const lbl = document.getElementById('holdSortLabel');
    if (lbl) lbl.textContent = _HOLD_SORT_LABEL[_holdingsSortMode];
    if (typeof _enrichHoldings52w === 'function') _enrichHoldings52w(client); // re-fill 52w cells
}
if (typeof window !== 'undefined') {
    window._cycleHoldingsSort = _cycleHoldingsSort;
    window._buildHoldingsTable = _buildHoldingsTable;
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
    // FX-aware: respect the תשואה מתואמת מט"ח toggle in the modal too
    const _pReturn = (typeof _calcReturn === 'function') ? _calcReturn(client) : calcPortfolioReturn(client);
    const totalProfit = _pReturn.profit;
    const totalReturnPct = _pReturn.returnPct;
    const totalProfitSign = totalProfit >= 0 ? '+' : '';
    const _heroValue = (typeof _clientDisplayValue === 'function') ? _clientDisplayValue(client) : client.portfolioValue;

    // ── Risk & allocation metrics (reuses _calcListMetrics logic) ──
    const _rm = (typeof _calcListMetrics === 'function') ? _calcListMetrics(client) : null;

    // Holdings table body — built by a reusable, re-sortable function so clicking
    // the "נכס" header can re-order in place without rebuilding the whole modal.
    const holdingsTableBody = _buildHoldingsTable(client);
    if (false) { // legacy inline build retained (dead) — _buildHoldingsTable is authoritative
    let holdingsRows = '';
    let totalHoldingsValue = 0;   // FX-converted to USD for correct cross-currency totals
    let totalHoldingsPnL = 0;     // FX-converted to USD
    let totalDailyPnL = 0;        // FX-converted to USD — sum of per-asset daily profit
    // Total portfolio value (holdings + cash, FX→USD) — denominator for each asset's weight
    const _portTotalForPct = client.holdings.reduce((s, hh) => s + (hh.value || 0) * _fxR(hh.currency), 0)
        + ((client.cash?.usd || 0) + (client.cash?.ils || 0) * _fxR('ILS'));
    client.holdings.forEach((h, hIdx) => {
        // "ממתין" only when we truly have no price yet. A position opened now at the
        // market price already has a price (= cost), so its return is a real 0 — show it.
        const isStale = h.type === 'stock' && !h._livePriceResolved && !(h.price > 0);
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
        // CML/SML recommendation chip — from the risk model (Jensen's alpha)
        const _recChip = (() => {
            const m = window._lastRiskModel;
            if (!m || !m.assets || h.type !== 'stock') return '';
            const a = m.assets[h.ticker];
            if (!a || !a.hasData || a.recommendation === 'unknown') return '';
            const color = (typeof rmRecColor === 'function') ? rmRecColor(a.recommendation) : '#64748b';
            const label = (typeof rmRecLabel === 'function') ? rmRecLabel(a.recommendation) : '';
            const tip = `β=${a.beta != null ? a.beta.toFixed(2) : '—'} · α=${a.alpha != null ? (a.alpha * 100).toFixed(1) + '%' : '—'}`;
            return `<span class="rec-chip" style="--rec:${color}" title="${tip}">${label}</span>`;
        })();
        // Order tag + stop-loss/target badges (local annotation), with breach flagging.
        const _orderChip = (() => {
            const ann = (typeof _orderAnnGet === 'function') ? _orderAnnGet(client.id, h.ticker) : null;
            if (!ann) return '';
            const cs = currSymbol;
            const out = [];
            if (ann.orderType === 'limit') out.push('<span class="order-badge ot">לימיט</span>');
            if (ann.stopLoss) {
                const hit = h.price > 0 && h.price <= ann.stopLoss;
                out.push(`<span class="order-badge sl${hit ? ' breach' : ''}" title="${hit ? 'מחיר השוק חצה את הסטופ-לוס!' : 'סטופ-לוס מוגדר'}">⛒ ${formatPrice(ann.stopLoss)}${cs}${hit ? ' ⚠' : ''}</span>`);
            }
            if (ann.target) {
                const hit = h.price > 0 && h.price >= ann.target;
                out.push(`<span class="order-badge tp${hit ? ' reached' : ''}" title="${hit ? 'מחיר השוק הגיע ליעד!' : 'יעד / טייק-פרופיט'}">◎ ${formatPrice(ann.target)}${cs}${hit ? ' ✓' : ''}</span>`);
            }
            return out.join(' ');
        })();
        const _hFx = _fxR(h.currency);
        totalHoldingsValue += h.value * _hFx;
        totalHoldingsPnL += isStale ? 0 : holdingProfit * _hFx;
        // Daily profit per asset (in the holding's currency) + accumulate the USD total
        const dailyProfit = (h.previousClose > 0 && h.shares > 0) ? (h.price - h.previousClose) * h.shares : 0;
        totalDailyPnL += isStale ? 0 : dailyProfit * _hFx;
        const dailyProfitClass = dailyProfit >= 0 ? 'positive' : 'negative';
        const dailyProfitSign = dailyProfit >= 0 ? '+' : '';
        // β from the CML/SML model (stocks only); % weight of the whole portfolio
        const _betaCell = (() => {
            const m = window._lastRiskModel;
            const a = m && m.assets && h.type === 'stock' ? m.assets[h.ticker] : null;
            return (a && a.beta != null && isFinite(a.beta)) ? a.beta.toFixed(2) : '<span style="color:var(--text-muted)">—</span>';
        })();
        const _pctOfPort = _portTotalForPct > 0 ? (h.value * _hFx / _portTotalForPct * 100) : 0;
        holdingsRows += `<tr>
            <td>
                <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:var(--text-primary)">${primaryName}</span>
                    ${subName}
                    <span style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                        <span class="asset-type-badge ${(typeof isFundLike === 'function' && isFundLike(h)) ? 'fund' : h.type}" style="font-size:10px;width:fit-content">${(typeof assetTypeLabel === 'function') ? assetTypeLabel(h) : h.typeLabel}</span>
                        ${_recChip}
                        ${_orderChip}
                    </span>
                </div>
            </td>
            <td>${formatPrice(purchasePrice)} ${currSymbol}</td>
            <td>${isStale ? `<span style="color:var(--text-muted)" title="ממתין לעדכון מחיר מהשוק">${formatPrice(h.price)} ${currSymbol}</span>` : `${formatPrice(h.price)} ${currSymbol}`}</td>
            <td id="yh_${h.id}">${h.yearHigh ? `${formatPrice(h.yearHigh)} ${currSymbol}` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td id="yl_${h.id}">${h.yearLow ? `${formatPrice(h.yearLow)} ${currSymbol}` : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td data-label="כמות" class="col-quantity">${formatAssetQuantity(h.shares)}</td>
            <td style="font-weight:600;color:var(--text-primary)">${formatCurrency(h.value, h.currency)}</td>
            <td style="font-weight:600">${_pctOfPort >= 0.05 ? _pctOfPort.toFixed(1) + '%' : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td id="beta_${h.id}" data-bticker="${h.type === 'stock' ? h.ticker : ''}">${_betaCell}</td>
            <td class="price-change ${isStale ? '' : changeClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${changeSign}${change.toFixed(2)}%`}</td>
            <td class="price-change ${isStale ? '' : dailyProfitClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${dailyProfitSign}${formatCurrency(Math.abs(dailyProfit), h.currency)}`}</td>
            <td class="price-change ${isStale ? '' : holdingProfitClass}">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${holdingProfitSign}${formatCurrency(Math.abs(holdingProfit), h.currency)}`}</td>
            <td class="price-change ${isStale ? '' : holdingProfitClass}" style="font-weight:700">${isStale ? '<span style="color:var(--text-muted)">ממתין...</span>' : `${holdingProfitSign}${holdingReturn.toFixed(2)}%`}</td>
            <td>
                <button class="holding-action-btn buy" onclick="openMgmtModal('buyHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">קנה</button>
                <button class="holding-action-btn sell" onclick="openMgmtModal('sellHolding', {client: clients.find(c=>c.id===${client.id}), holdingId: ${h.id}, holding: clients.find(c=>c.id===${client.id}).holdings.find(h=>h.id===${h.id})})">מכור</button>
            </td>
        </tr>`;
    });

    // Summary footer row
    const totalPnLClass = totalHoldingsPnL >= 0 ? 'positive' : 'negative';
    const totalPnLSign = totalHoldingsPnL >= 0 ? '+' : '';
    const totalReturnPctHoldings = _pReturn.totalCost > 0 ? (totalHoldingsPnL / _pReturn.totalCost * 100) : 0;
    const totalDailyClass = totalDailyPnL >= 0 ? 'positive' : 'negative';
    const totalDailySign = totalDailyPnL >= 0 ? '+' : '';
    const totalDailyPct = (totalHoldingsValue - totalDailyPnL) > 0 ? (totalDailyPnL / (totalHoldingsValue - totalDailyPnL) * 100) : 0;
    const holdingsFooter = `<tr class="holdings-footer-row">
        <td style="font-weight:700;color:var(--text-primary)">סה"כ</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td style="font-weight:700;color:var(--text-primary)">${formatCurrency(totalHoldingsValue)}</td>
        <td></td>
        <td></td>
        <td class="price-change ${totalDailyClass}" style="font-weight:700">${totalDailySign}${totalDailyPct.toFixed(2)}%</td>
        <td class="price-change ${totalDailyClass}" style="font-weight:700">${totalDailySign}${formatCurrency(Math.abs(totalDailyPnL))}</td>
        <td class="price-change ${totalPnLClass}" style="font-weight:700">${totalPnLSign}${formatCurrency(Math.abs(totalHoldingsPnL))}</td>
        <td class="price-change ${totalPnLClass}" style="font-weight:700">${totalPnLSign}${totalReturnPctHoldings.toFixed(2)}%</td>
        <td></td>
    </tr>`;
    } // end dead legacy block

    // Sector breakdown table
    const sectorData = {};
    stockHoldings.forEach(h => { const s = (typeof resolveHoldingSector === 'function') ? resolveHoldingSector(h) : (h.sector || 'Other'); sectorData[s] = (sectorData[s] || 0) + h.value; });
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
            <button class="modal-tab" data-tab="cmlsml" onclick="switchModalTab('cmlsml')">CML / SML</button>
            <button class="modal-tab" data-tab="holdings" onclick="switchModalTab('holdings')">נכסים</button>
            <button class="modal-tab" data-tab="sectors" onclick="switchModalTab('sectors')">נתוני תיק</button>
            <button class="modal-tab" data-tab="transactions" onclick="switchModalTab('transactions')">היסטוריית פעולות</button>
        </div>
        <div class="modal-body">
            <!-- Tab: Overview -->
            <div class="modal-tab-content active" id="tab-overview">
                <!-- ═══ HERO — Command Center Banner ═══ -->
                <div class="ov-hero-block">
                    <div class="ov-hero-scan"></div>
                    <div class="ov-hero-inner">
                        <div class="ov-hero-top">
                            <span class="ov-hero-label">שווי תיק כולל${_fxAdjustedReturn ? ' <span class="fx-badge">FX</span>' : ''}</span>
                            <span class="ov-hero-value">${formatCurrency(_heroValue)}</span>
                            <span class="ov-hero-live"><span class="ov-hero-live-dot"></span>LIVE</span>
                        </div>
                        <div class="ov-hero-sep"></div>
                        <div class="ov-hero-kpis">
                            <div class="ov-kpi-card ${totalProfit >= 0 ? 'kpi-positive' : 'kpi-negative'}">
                                <span class="ov-kpi-label">רווח/הפסד</span>
                                <span class="ov-kpi-value ${totalProfit >= 0 ? 'val-positive' : 'val-negative'}">${totalProfitSign}${formatCurrency(Math.abs(totalProfit))}</span>
                            </div>
                            <div class="ov-kpi-card ${totalProfit >= 0 ? 'kpi-positive' : 'kpi-negative'}">
                                <span class="ov-kpi-label">תשואה</span>
                                <span class="ov-kpi-value ${totalProfit >= 0 ? 'val-positive' : 'val-negative'}">${totalProfitSign}${totalReturnPct.toFixed(2)}%</span>
                            </div>
                            <div class="ov-kpi-card ${_rm && _rm.dailyPnl >= 0 ? 'kpi-positive' : 'kpi-negative'}">
                                <span class="ov-kpi-label">רווח יומי</span>
                                <span class="ov-kpi-value ${_rm && _rm.dailyPnl >= 0 ? 'val-positive' : 'val-negative'}">${_rm ? (_rm.dailyPnl >= 0 ? '+' : '') + formatCurrency(Math.abs(_rm.dailyPnl)) : '—'}</span>
                            </div>
                            <div class="ov-kpi-card ${_rm && _rm.dailyPnl >= 0 ? 'kpi-positive' : 'kpi-negative'}">
                                <span class="ov-kpi-label">תשואה יומית</span>
                                <span class="ov-kpi-value ${_rm && _rm.dailyPnl >= 0 ? 'val-positive' : 'val-negative'}">${(() => {
                                    if (!_rm || _rm.dailyPnl == null) return '—';
                                    const base = (client.portfolioValue || 0) - _rm.dailyPnl;
                                    if (!(base > 0)) return '—';
                                    const pct = _rm.dailyPnl / base * 100;
                                    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
                                })()}</span>
                            </div>
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
                            ${(() => {
                                // Composite MODEL score (fundamental + SML/CML + technical) — the SAME number as
                                // the list view. Higher = better → green; low = red.
                                const _ms = (typeof rmModelScoreOf === 'function' ? rmModelScoreOf(client) : null);
                                const has = _ms != null;
                                const col = !has ? '#8a93a6' : _ms >= 65 ? '#00ff94' : _ms >= 45 ? '#facc15' : '#ff4d4d';
                                const cls = !has ? '' : _ms >= 65 ? 'val-positive' : _ms >= 45 ? 'val-warn' : 'val-negative';
                                const _modelTip = 'מודל התיק — ציון משוקלל (0–100) של החברות המוחזקות, הבנוי משלושה רכיבים: 40% נתוני הדוחות הכספיים (רווחיות, צמיחה, איתנות) · 40% מודל CML/SML (אלפא מול הסיכון השיטתי) · 20% ניתוח טכני (מגמה ומומנטום). לכן הוא יכול להיות שונה מציון CML/SML שמודד רק את ממד הסיכון–תשואה.';
                                return `<div class="ov-cell ov-cell-risk-score">
                                <div class="ov-cell-label">מודל התיק <span class="ov-info-i" title="${_modelTip.replace(/"/g, '&quot;')}">&#9432;</span></div>
                                <div class="ov-cell-value ${cls}">${has ? _ms : '—'}<span class="ov-cell-dim">/100</span></div>
                                <div class="ov-cell-bar"><div class="ov-cell-bar-fill" style="width:${has ? _ms : 0}%;background:${col}"></div></div>
                            </div>`;
                            })()}
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

                <!-- ═══ CURRENCY EXPOSURE — full-width row (ABOVE model compliance) ═══ -->
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
                        <span class="ov-curbar-symbol ils">₪</span>
                    </div>
                </div>
                ${(() => {
                    if (typeof getPortfolioAvgUsdRate !== 'function') return '';
                    const hasUsd = (client.holdings || []).some(h => (h.currency || 'USD').toUpperCase() === 'USD');
                    if (!hasUsd) return '';
                    const b = getPortfolioAvgUsdRate(client.id);
                    // Show the FX P&L ONLY when we have a REAL recorded purchase rate — never a
                    // fabricated one. No conversion history → no note (keeps every figure verified).
                    if (!b || !b.real || !(b.rate > 0)) return '';
                    const cur = (typeof _fxRates !== 'undefined' && _fxRates.USDILS > 0) ? _fxRates.USDILS : 3.7;
                    // FX P&L for an ILS investor: ₪ now per $ vs ₪ paid per $.
                    const fxPnl = (cur / b.rate - 1) * 100;
                    const cls = fxPnl >= 0 ? 'val-positive' : 'val-negative';
                    const sign = fxPnl >= 0 ? '+' : '';
                    const word = fxPnl >= 0 ? 'רווח' : 'הפסד';
                    return `<div class="ov-fx-note">שער דולר ממוצע בתיק (לפי המרות בפועל): <b>₪${b.rate.toFixed(3)}</b> · שער נוכחי ₪${cur.toFixed(3)} · ${word} מט"ח על הדולר: <b class="${cls}">${sign}${fxPnl.toFixed(1)}%</b></div>`;
                })()}

                <!-- ═══ MODEL COMPLIANCE — compact, links to the CML/SML tab ═══ -->
                ${(() => {
                    const partial = client.compliancePartial;
                    const cs = partial ? null : client.complianceScore;
                    const cl = client.complianceLabel || '';
                    const col = cs == null ? 'var(--text-muted)' : cs >= 75 ? 'var(--risk-low)' : cs >= 50 ? 'var(--accent-yellow)' : 'var(--risk-high)';
                    const sub = partial ? 'מחשב — ממתין לנתוני שוק מלאים…' : (cs == null ? 'לחץ לפתיחת הניתוח, העקומות וההמלצות' : cl + ' · לחץ לעקומות ולתוכנית הפעולה');
                    return `<div class="ov-compliance" onclick="switchModalTab('cmlsml')" style="--cc:${col}">
                        <div class="ov-comp-left">
                            <span class="ov-comp-ring">${cs == null ? '—' : cs}<small>/100</small></span>
                            <div class="ov-comp-txt">
                                <span class="ov-comp-label">מודל CML / SML</span>
                                <span class="ov-comp-sub">${sub}</span>
                            </div>
                        </div>
                        <span class="ov-comp-cta">ניתוח CML / SML →</span>
                    </div>`;
                })()}

                <!-- Performance chart intentionally lives OUTSIDE the modal — open it
                     from the portfolio card's expand button on the dashboard. -->
                <!-- ═══ PORTFOLIO RISK DETAIL — fills the overview with the model verdict + changes ═══ -->
                <div class="ov-risk-detail glass-card" id="modalOverviewRisk">
                    <div class="ov-advisory-head">
                        <span>פירוט סיכון התיק והשינויים הנדרשים</span>
                        <span class="ov-advisory-sub">לפי CML/SML וקורלציות — לתיק האופטימלי. העקומות והבורר בלשונית CML / SML</span>
                    </div>
                    <div id="modalOverviewRiskBody"><div class="adv-empty">מחשב ניתוח CML/SML…</div></div>
                </div>

                <!-- Hidden donut canvas for sectors tab data (still needed for chart init) -->
                <div style="display:none"><canvas id="modal-chart"></canvas></div>
            </div>
            <!-- Tab: CML / SML -->
            <div class="modal-tab-content" id="tab-cmlsml">
                <div class="mcs-charts">
                    <div class="mcs-chart-card">
                        <div class="mcs-chart-head">
                            <h4>קו שוק ההון (CML) <button class="chart-info-btn" onclick="openChartInfo('cml')" title="הסבר על הגרף" aria-label="הסבר על גרף ה-CML">i</button></h4>
                            <span>החזית היעילה (עקומה) · מיקום התיק שלך עליה</span>
                        </div>
                        <div class="mcs-canvas-wrap"><canvas id="modal-cml-chart"></canvas></div>
                    </div>
                    <div class="mcs-chart-card">
                        <div class="mcs-chart-head">
                            <h4>קו שוק נייר הערך (SML) <button class="chart-info-btn" onclick="openChartInfo('sml')" title="הסבר על הגרף" aria-label="הסבר על גרף ה-SML">i</button></h4>
                            <span>תשואה מול β · מעל הקו = מתומחר בחסר, מתחת = ביתר</span>
                        </div>
                        <div class="mcs-canvas-wrap"><canvas id="modal-sml-chart"></canvas></div>
                    </div>
                </div>
                <button class="mcs-reco-btn" onclick="openStockRecommendations(${client.id})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>
                    </svg>
                    <span>המלצות לאיזון התיק וייעולו</span>
                </button>
                <div id="modalCmlSmlAdvisory"><div class="adv-empty">מחשב ניתוח CML/SML…</div></div>
            </div>
            <!-- Tab: Holdings -->
            <div class="modal-tab-content" id="tab-holdings">
                <button class="add-asset-btn" onclick="openMgmtModal('addHolding', clients.find(c=>c.id===${client.id}))">+ הוסף נכס חדש</button>
                <div class="holdings-table-wrapper">
                <table class="holdings-table">
                    <thead><tr><th class="hold-sort-th" onclick="_cycleHoldingsSort(${client.id})" title="לחץ למיון: רגיל → ביצועים → לפי סקטור"><span id="holdSortLabel">נכס</span> <span class="hold-sort-ind">⇅</span></th><th class="col-price">מחיר קנייה</th><th class="col-price">מחיר נוכחי</th><th class="col-price">שנתי גבוה</th><th class="col-price">שנתי נמוך</th><th class="col-qty-header">כמות</th><th>שווי כולל</th><th class="col-pct">% מהתיק</th><th class="col-pct">β</th><th class="col-pct">תשואה יומית</th><th>רווח יומי</th><th>רווח/הפסד</th><th class="col-pct">תשואה כוללת</th><th>פעולות</th></tr></thead>
                    <tbody id="holdingsTbody">${holdingsTableBody}</tbody>
                </table>
                </div>
            </div>
            <!-- Tab: Portfolio Data (sectors + correlation matrix) -->
            <div class="modal-tab-content" id="tab-sectors">
                <div class="sectors-layout">
                    <div class="sectors-chart-wrap"><canvas id="modal-sector-chart"></canvas></div>
                    <div class="sectors-table-wrap"><table class="sector-table"><thead><tr><th>סקטור</th><th>שווי</th><th>אחוז</th></tr></thead><tbody>${sectorRows}</tbody></table></div>
                </div>
                <div class="pf-data-lower">
                    <div class="pf-news-section">
                        <div class="pf-corr-head">
                            <h4>עדכונים מהותיים — נכסי התיק</h4>
                            <span>כותרות יומיות אמיתיות, מתורגמות לעברית · מתעדכן אוטומטית</span>
                        </div>
                        <div id="modalPortfolioNews"><div class="adv-empty">טוען עדכונים…</div></div>
                    </div>
                    <div class="pf-corr-section">
                        <div class="pf-corr-head">
                            <h4>קורלציה וריכוזיות — נכסי התיק</h4>
                            <span>קורלציה ממוצעת של כל נכס לשאר התיק, ציון פיזור והמלצה לצמצום ריכוזיות</span>
                        </div>
                        <div id="modalCorrMatrix"><div class="adv-empty">מחשב קורלציות…</div></div>
                    </div>
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
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();

    // Fill any missing 52-week high/low cells in the holdings table (Yahoo proxy)
    _enrichHoldings52w(client);
    // Resolve Israeli funds/ETFs (numeric ids) → real name + correct type tag.
    if (typeof _enrichILFunds === 'function') _enrichILFunds(client);

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

        // Performance chart removed from the modal by design — it's opened from the
        // dashboard card's expand button (openFullscreenChart) instead.
        if (_modalPerfChartInstance) { _modalPerfChartInstance.destroy(); _modalPerfChartInstance = null; }
        // Fill the Overview risk-detail block (verdict + action plan); the full
        // CML/SML charts + picker render in the dedicated tab on demand.
        if (typeof _fillModalAdvisory === 'function') _fillModalAdvisory(client.id);
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
            const TYPE_LABEL_MAP = { buy: 'קנייה', sell: 'מכירה', deposit: 'הפקדה', withdraw: 'משיכה', fx: 'המרת מט"ח', tax: 'פעולת מס', bonus: 'הטבה', edit_settings: 'עדכון הגדרות', edit_holding: 'עריכת נכס' };
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
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    currentModalClientId = null;
    // Clear URL state
    if (typeof clearURLState === 'function') clearURLState();
}

// ========== REPORTS ==========

// Hide ALL app UI — the report becomes the only visible element (print-clean).
// CRITICAL: the report view sits AFTER the app-shell in the DOM, and the shell keeps
// min-height:100vh even when its children are hidden — so the shell itself must be
// hidden too, or the report starts a full screen down.
function _hideAppForReport() {
    // History entry so the browser back button returns from the report to the dashboard
    try { history.pushState({ popup: 'report' }, '', location.href); } catch (e) { /* ignore */ }
    const shell = document.getElementById('appShell');
    if (shell) shell.style.display = 'none';
    document.querySelector('.header').style.display = 'none';
    document.querySelector('.summary-bar').style.display = 'none';
    const filtersEl = document.querySelector('.filters');
    if (filtersEl) filtersEl.style.display = 'none';
    const filtersRow = document.querySelector('.filters-search-row');
    if (filtersRow) filtersRow.style.display = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) heroFold.style.display = 'none';
    const portfolioHeader = document.querySelector('.portfolio-section-header');
    if (portfolioHeader) portfolioHeader.style.display = 'none';
    const quickWatch = document.querySelector('.quick-watch-bar');
    if (quickWatch) quickWatch.style.display = 'none';
    const mobileNav = document.getElementById('mobileBottomNav');
    if (mobileNav) mobileNav.style.display = 'none';
    const sidebar = document.getElementById('appSidebar');
    if (sidebar) sidebar.style.display = 'none';
}

function generateReport(clientId) {
    // No specific client → consolidated all-portfolios report
    if (clientId == null) { generateAllPortfoliosReport(); return; }
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
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();

    _hideAppForReport();
    window.scrollTo(0, 0);

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
    const filtersEl = document.querySelector('.filters');
    if (filtersEl) filtersEl.style.display = '';
    const filtersRow = document.querySelector('.filters-search-row');
    if (filtersRow) filtersRow.style.display = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display = '';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) heroFold.style.display = '';
    const portfolioHeader = document.querySelector('.portfolio-section-header');
    if (portfolioHeader) portfolioHeader.style.display = '';
    const quickWatch = document.querySelector('.quick-watch-bar');
    if (quickWatch) quickWatch.style.display = '';
    const mobileNav = document.getElementById('mobileBottomNav');
    if (mobileNav) mobileNav.style.display = '';
    const sidebar = document.getElementById('appSidebar');
    if (sidebar) sidebar.style.display = '';
    const shell = document.getElementById('appShell');
    if (shell) shell.style.display = '';
}

// ========== CONSOLIDATED ALL-PORTFOLIOS REPORT ==========
// One clean, print-ready report covering EVERY portfolio: value, return, risk level,
// CML/SML model efficiency, and per-portfolio sector exposure (%).

function generateAllPortfoliosReport() {
    const list = (typeof clients !== 'undefined' ? clients : []).filter(c => c && (c.holdings || []).length >= 0);
    if (!list.length) { alert('אין תיקים להפקת דוח'); return; }
    const dateStr = new Date().toLocaleDateString('he-IL');
    const model = window._lastRiskModel || null;

    // Totals
    const fx = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    let totalAUM = 0, totalCost = 0, totalValue = 0;
    for (const c of list) {
        totalAUM += c.portfolioValue || 0;
        const r = calcPortfolioReturn(c);
        totalCost += r.totalCost; totalValue += r.totalValue;
    }
    const totalRet = totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100) : 0;

    // Per-portfolio sector exposure (% of securities value)
    const sectorsOf = (c) => {
        const by = {};
        let tot = 0;
        for (const h of (c.holdings || [])) {
            const v = (h._valueInDisplayCurrency != null) ? h._valueInDisplayCurrency : (h.value || 0) * fx(h.currency);
            if (!(v > 0)) continue;
            const sec = h.type === 'bond' ? 'אג"ח'
                : (h.sector || (typeof SECTOR_MAP !== 'undefined' && SECTOR_MAP[h.ticker]) || 'Other');
            by[sec] = (by[sec] || 0) + v;
            tot += v;
        }
        return Object.entries(by).map(([s, v]) => ({ s, pct: tot > 0 ? v / tot * 100 : 0 }))
            .sort((a, b) => b.pct - a.pct);
    };

    const effCell = (c) => {
        const p = model && model.portfolios ? model.portfolios.find(x => x.id === c.id) : null;
        if (!p || !p.hasData) return '<span style="color:#888">—</span>';
        return p.aboveCML
            ? '<span style="color:green;font-weight:700">יעיל ✓ (על/מעל ה-CML)</span>'
            : '<span style="color:#c00;font-weight:700">לא יעיל ✗ (מתחת ל-CML)</span>';
    };

    // Per-portfolio dividend yield ESTIMATE — weighted by holding value using
    // approximate trailing annual yields (%) for common names; unknown tickers = 0.
    const DIV_EST = {
        SPY: 1.2, VOO: 1.2, QQQ: 0.6, DIA: 1.6, IWM: 1.2, SCHD: 3.4, TLT: 3.8, IEF: 3.3, LQD: 4.2, GLD: 0,
        AAPL: 0.4, MSFT: 0.7, NVDA: 0.03, GOOGL: 0.5, AMZN: 0, META: 0.4, AVGO: 1.2, NFLX: 0, AMD: 0, ORCL: 1.1,
        CRM: 0.4, ADBE: 0, CSCO: 2.7, QCOM: 2.1, TXN: 3.0, INTC: 1.5, T: 4.0, VZ: 6.2,
        JPM: 2.0, V: 0.7, MA: 0.5, BAC: 2.4, WFC: 2.6, GS: 2.0, MS: 3.2, AXP: 1.0, SCHW: 1.3, BLK: 2.0,
        UNH: 1.5, JNJ: 3.0, LLY: 0.7, ABBV: 3.5, MRK: 3.0, PFE: 5.9, TMO: 0.3, ABT: 1.9, AMGN: 3.1, DHR: 0.4,
        XOM: 3.3, CVX: 4.1, COP: 2.9, SLB: 2.5, EOG: 3.2,
        PG: 2.4, KO: 2.9, PEP: 3.2, COST: 0.5, WMT: 0.9, HD: 2.3, MCD: 2.2, NKE: 2.0, SBUX: 2.5, DIS: 0.9, LOW: 1.9,
        CAT: 1.5, BA: 0, HON: 2.0, GE: 0.7, UPS: 4.5, RTX: 2.0,
        XLF: 1.5, XLV: 1.6, XLE: 3.2, XLK: 0.7, XLI: 1.4, XLP: 2.5,
    };
    const divYieldOf = (c) => {
        let tot = 0, weighted = 0;
        for (const h of (c.holdings || [])) {
            const v = (h._valueInDisplayCurrency != null) ? h._valueInDisplayCurrency : (h.value || 0) * fx(h.currency);
            if (!(v > 0)) continue;
            tot += v;
            const base = (h.ticker || '').toUpperCase().replace(/\.TA$/, '');
            weighted += v * (DIV_EST[base] || 0);
        }
        return tot > 0 ? weighted / tot : 0;
    };

    // Per-portfolio holdings detail table (asset, type, allocation, value, return)
    const holdingsTable = (c) => {
        const hs = (c.holdings || []).filter(h => (h.value || 0) > 0 || (h.shares || 0) > 0);
        if (!hs.length) return '<p class="rpt-sectors" style="color:#888">אין נכסים בתיק.</p>';
        const rows = hs.map(h => {
            const profit = (h.value || 0) - (h.costBasis || 0);
            const ret = h.costBasis > 0 ? (profit / h.costBasis * 100) : 0;
            const heName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
            const nm = heName || (h.type === 'stock' ? h.ticker : (h.name || h.ticker));
            return `<tr>
                <td>${nm}</td>
                <td>${h.type === 'bond' ? 'אג"ח' : 'מניה'}</td>
                <td>${(h.allocationPct || 0).toFixed(1)}%</td>
                <td>${formatCurrency(h.value || 0, h.currency)}</td>
                <td style="color:${ret >= 0 ? 'green' : 'red'}">${(ret >= 0 ? '+' : '')}${ret.toFixed(2)}%</td>
            </tr>`;
        }).join('');
        return `<table class="report-table rpt-holdings">
            <thead><tr><th>נכס</th><th>סוג</th><th>הקצאה</th><th>שווי</th><th>תשואה</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    };

    const portfolioSections = list.map(c => {
        const r = calcPortfolioReturn(c);
        const sign = r.returnPct >= 0 ? '+' : '';
        const secs = sectorsOf(c);
        const secLine = secs.length
            ? secs.map(x => `${x.s} <b>${x.pct.toFixed(1)}%</b>`).join(' · ')
            : 'אין נכסים';
        return `
        <div class="report-section rpt-portfolio">
            <div class="rpt-port-head">
                <h3 style="margin:0">${c.name}</h3>
                <span class="rpt-risk rpt-risk-${c.risk || 'low'}">${c.riskLabel || ''}</span>
            </div>
            <div class="report-stats-grid">
                <div class="report-stat"><div class="label">שווי תיק</div><div class="value">${formatCurrency(c.portfolioValue)}</div></div>
                <div class="report-stat"><div class="label">תשואה</div><div class="value" style="color:${r.returnPct >= 0 ? 'green' : 'red'}">${sign}${r.returnPct.toFixed(2)}%</div></div>
                <div class="report-stat"><div class="label">רווח/הפסד</div><div class="value" style="color:${r.profit >= 0 ? 'green' : 'red'}">${r.profit >= 0 ? '+' : ''}${formatCurrency(Math.abs(r.profit))}</div></div>
                <div class="report-stat"><div class="label">יעילות לפי המודל</div><div class="value" style="font-size:13px">${effCell(c)}</div></div>
                <div class="report-stat"><div class="label">עסקאות החודש</div><div class="value" id="rpt-tx-${c.id}">…</div></div>
                <div class="report-stat"><div class="label">תשואת דיבידנד</div><div class="value" style="color:green">${divYieldOf(c).toFixed(2)}%</div></div>
            </div>
            <h4 class="rpt-subhead">נכסים בתיק (${(c.holdings || []).length})</h4>
            ${holdingsTable(c)}
            <p class="rpt-sectors"><b>חשיפה לסקטורים:</b> ${secLine}</p>
            <h4 class="rpt-subhead">עסקאות אחרונות — מחירי קנייה/מכירה</h4>
            <div id="rpt-txtable-${c.id}"><p class="rpt-sectors" style="color:#888">טוען עסקאות…</p></div>
        </div>`;
    }).join('');

    _hideAppForReport();
    const reportView = document.getElementById('reportView');
    reportView.classList.add('active');
    reportView.innerHTML = `
        <button class="report-back-btn" onclick="closeReport()">חזור לדשבורד</button>
        <div class="report-header">
            <h1>דוח תיקים מרוכז — Finextium</h1>
            <p>תאריך: ${dateStr} | ${list.length} תיקים | סך נכסים: ${formatCurrency(totalAUM)} | תשואה כוללת: <b style="color:${totalRet >= 0 ? 'green' : 'red'}">${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%</b></p>
        </div>
        ${portfolioSections}
        <div class="report-section" style="text-align:center;margin-top:32px">
            <p style="color:#999;font-size:11px">הדוח הופק אוטומטית ע"י Finextium | יעילות לפי מודל CML/SML | ${dateStr}</p>
            <button class="report-back-btn" style="position:static;margin-top:16px" onclick="window.print()">הדפס / שמור כ-PDF</button>
        </div>
    `;

    // Open at the TOP of the page (the dashboard may have been scrolled down)
    window.scrollTo(0, 0);

    // Per portfolio (async, parallel): "transactions this month" count + a detailed
    // table of the latest transactions with their actual buy/sell prices.
    const TX_LABEL = { buy: 'קנייה', sell: 'מכירה', deposit: 'הפקדה', withdraw: 'משיכה', fx: 'המרת מט"ח', tax: 'פעולת מס', bonus: 'הטבה', edit_settings: 'עדכון הגדרות', edit_holding: 'עריכת נכס' };
    const txTableHTML = (txs) => {
        const shown = (txs || []).filter(t => t.type === 'buy' || t.type === 'sell' || t.type === 'deposit' || t.type === 'withdraw').slice(0, 10);
        if (!shown.length) return '<p class="rpt-sectors" style="color:#888">אין עסקאות בתיק.</p>';
        const rows = shown.map(t => {
            const sym = t.currency === 'ILS' ? '₪' : '$';
            return `<tr>
                <td>${t.date instanceof Date ? t.date.toLocaleDateString('he-IL') : ''}</td>
                <td><b>${TX_LABEL[t.type] || t.type}</b></td>
                <td>${t.name || (t.ticker !== '-' ? t.ticker : '—')}</td>
                <td>${t.shares > 0 ? Number(t.shares).toLocaleString('en-US') : '—'}</td>
                <td>${t.price > 0 ? `${formatPrice(t.price)} ${sym}` : '—'}</td>
                <td>${t.total > 0 ? formatCurrency(t.total, t.currency) : '—'}</td>
                <td>${(t.type === 'sell' && t.realizedPnl != null) ? `<span style="color:${t.realizedPnl >= 0 ? 'green' : 'red'}">${t.realizedPnl >= 0 ? '+' : ''}${formatCurrency(Math.abs(t.realizedPnl))}</span>` : '—'}</td>
            </tr>`;
        }).join('');
        return `<table class="report-table rpt-holdings">
            <thead><tr><th>תאריך</th><th>פעולה</th><th>נכס</th><th>כמות</th><th>מחיר</th><th>סה"כ</th><th>רווח ממומש</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    };

    if (typeof supaFetchTransactions === 'function' && typeof supabaseConnected !== 'undefined' && supabaseConnected) {
        const now = new Date();
        const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
        list.forEach(async (c) => {
            const countEl = document.getElementById(`rpt-tx-${c.id}`);
            const tableEl = document.getElementById(`rpt-txtable-${c.id}`);
            try {
                const txs = await supaFetchTransactions(c.id);
                if (txs && txs.unavailable) {
                    if (countEl) countEl.textContent = '—';
                    if (tableEl) tableEl.innerHTML = '<p class="rpt-sectors" style="color:#888">היסטוריית עסקאות אינה זמינה.</p>';
                    return;
                }
                if (countEl) countEl.textContent = String((txs || []).filter(t => t.date instanceof Date && t.date >= mStart).length);
                if (tableEl) tableEl.innerHTML = txTableHTML(txs);
            } catch (e) {
                if (countEl) countEl.textContent = '—';
                if (tableEl) tableEl.innerHTML = '<p class="rpt-sectors" style="color:#888">שגיאה בטעינת עסקאות.</p>';
            }
        });
    } else {
        list.forEach(c => {
            const el = document.getElementById(`rpt-tx-${c.id}`);
            if (el) el.textContent = '—';
            const tableEl = document.getElementById(`rpt-txtable-${c.id}`);
            if (tableEl) tableEl.innerHTML = '<p class="rpt-sectors" style="color:#888">היסטוריית עסקאות אינה זמינה.</p>';
        });
    }

    // Model not built yet (e.g. report opened right after login)? Build it in the
    // background and fill the efficiency cells in place when ready.
    if (!model && typeof buildRiskModel === 'function') {
        buildRiskModel(list).then(m => {
            window._lastRiskModel = m;
            if (document.getElementById('reportView')?.classList.contains('active')) generateAllPortfoliosReport();
        }).catch(() => { /* keep dashes */ });
    }
}

// Fill missing 52-week high/low cells in the holdings table via the same-origin
// Yahoo quote proxy (most reliable, keyless). TASE quotes arrive in agorot (ILA)
// → scaled to shekels. Cells are patched in place by id, no full re-render.
// Resolve Israeli funds/ETFs (numeric ids, not on Yahoo) from Israeli sources
// (funder/bizportal via /api/ilfund): real NAME + asset TYPE (קרן סל / קרן נאמנות),
// so they show with their proper name and are TAGGED correctly instead of "מניה".
window._ilFundInfo = window._ilFundInfo || {};
async function _enrichILFunds(client) {
    if (!client || !Array.isArray(client.holdings)) return;
    const ids = [...new Set(client.holdings
        .map(h => (h.ticker || '').replace(/\.TA$/i, '').toUpperCase())
        .filter(t => /^\d{4,9}$/.test(t) && !window._ilFundInfo[t]))];
    if (!ids.length) return;
    let changed = false;
    await Promise.all(ids.map(async (id) => {
        try {
            const r = await fetch(`/api/ilfund?id=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
            if (!r.ok) return;
            const j = await r.json();
            if (j && (j.name || j.type)) { window._ilFundInfo[id] = { name: j.name || null, type: j.type || 'קרן סל' }; changed = true; }
        } catch (e) { /* leave as-is */ }
    }));
    if (!changed) return;
    // Stamp the resolved type label onto the matching holdings, then repaint the table.
    for (const h of client.holdings) {
        const t = (h.ticker || '').replace(/\.TA$/i, '').toUpperCase();
        const info = window._ilFundInfo[t];
        if (info) { h.typeLabel = info.type; if (info.name) h.name = info.name; }
    }
    const body = document.getElementById('holdingsTbody');
    if (body && typeof _buildHoldingsTable === 'function') { body.innerHTML = _buildHoldingsTable(client); _enrichHoldings52w(client); }
    if (typeof renderClientCards === 'function') renderClientCards();
}

async function _enrichHoldings52w(client) {
    if (!client || !Array.isArray(client.holdings)) return;
    const proxyOf = (h) => (typeof _proxySymbolFor === 'function') ? _proxySymbolFor(h.ticker) : null;
    // Include stocks AND any holding with an index proxy (e.g. an Israeli S&P-500 KTF that
    // isn't on Yahoo — we derive its ₪ 52-week range from the underlying index it tracks).
    const targets = client.holdings.filter(h => h.id != null && !(h.yearHigh > 0 && h.yearLow > 0) && (h.type === 'stock' || proxyOf(h)));
    if (!targets.length) return;
    const symOf = (h) => {
        const proxy = proxyOf(h);
        if (proxy) return proxy;
        const t = (h.ticker || '').toUpperCase();
        if (!t) return '';
        if (h.currency === 'ILS') {
            return (typeof _resolveYahooSymbol === 'function') ? _resolveYahooSymbol(t, true) : t.replace(/\.TA$/, '') + '.TA';
        }
        return t;
    };
    const bySym = {};
    for (const h of targets) { const s = symOf(h); if (s) (bySym[s] = bySym[s] || []).push(h); }
    const syms = Object.keys(bySym);
    if (!syms.length) return;
    try {
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(syms.join(','))}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) return;
        const data = await r.json();
        for (const s of syms) {
            const q = data[s];
            if (!q) continue;
            const k = (q.currency === 'ILA') ? 0.01 : 1; // agorot → shekels
            for (const h of bySym[s]) {
                const cur = h.currency === 'ILS' ? '₪' : '$';
                let yh, yl;
                if (proxyOf(h) && q.price > 0 && h.price > 0) {
                    // Proxied tracker: scale the index's 52-week range by the fund's own price,
                    // so the ₪ high/low match the fund's scale (not the index's).
                    const scale = h.price / q.price;
                    yh = q.yearHigh > 0 ? q.yearHigh * scale : null;
                    yl = q.yearLow > 0 ? q.yearLow * scale : null;
                } else {
                    yh = q.yearHigh > 0 ? q.yearHigh * k : null;
                    yl = q.yearLow > 0 ? q.yearLow * k : null;
                }
                if (yh) { h.yearHigh = yh; const c = document.getElementById('yh_' + h.id); if (c) c.innerHTML = `${formatPrice(yh)} ${cur}`; }
                if (yl) { h.yearLow = yl; const c = document.getElementById('yl_' + h.id); if (c) c.innerHTML = `${formatPrice(yl)} ${cur}`; }
            }
        }
    } catch (e) { /* leave dashes */ }
}

// Small HTML-escaper for values interpolated into modal markup
function _mEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========== CHART INFO POPUP (CML / SML explanations) ==========
const _CHART_INFO = {
    cml: {
        title: 'קו שוק ההון (CML) — מה הוא מראה',
        body: `
            <p><b>הרעיון:</b> הגרף מודד את התיק שלך מול ה<b>סיכון הכולל</b> שלו (סטיית תקן, σ — התנודתיות של כל התיק). זהו מבחן היעילות: כמה תשואה אתה מקבל על כל יחידת סיכון שאתה לוקח.</p>
            <ul>
                <li><b>העקומה הירוקה</b> = החזית היעילה (Markowitz) — צירופי הנכסים הטובים ביותר שאפשר להרכיב לכל רמת סיכון.</li>
                <li><b>הקו הכחול המקווקו (CML)</b> = שילוב בין נכס חסר-סיכון (מזומן/אג"ח קצר) לבין תיק השוק. כל תיק <b>על הקו או מעליו</b> הוא יעיל; תיק <b>מתחת לקו</b> מקבל פחות תשואה ממה שמגיע לו לרמת הסיכון.</li>
                <li><b>הנקודה התכולה</b> = התיק שלך, במיקומו האמיתי (σ, תשואה צפויה).</li>
                <li><b>היהלום הסגול</b> = מדד השוק (S&P 500). <b>הקו המקווקו האפור</b> = הפער מהחזית — כמה סיכון אפשר לחסוך באיזון מחדש מבלי לוותר על תשואה.</li>
            </ul>
            <p><b>המסקנה:</b> ככל שהנקודה התכולה קרובה יותר לקו הכחול / לעקומה הירוקה — התיק יעיל יותר. אם היא מתחת, יש מקום לאזן אותו לאזור היעיל.</p>`,
    },
    sml: {
        title: 'קו שוק נייר הערך (SML) — מה הוא מראה',
        body: `
            <p><b>הרעיון:</b> כאן כל נקודה היא <b>נכס בודד</b> בתיק, ממוקמת לפי ה<b>ביטא (β)</b> שלו — הסיכון השיטתי, כלומר כמה הנכס זז ביחס לשוק — מול התשואה הצפויה ממנו.</p>
            <ul>
                <li><b>הקו הכחול (SML)</b> = התשואה ה"הוגנת" שמודל CAPM דורש מנכס לפי הביטא שלו.</li>
                <li><b>נקודה מעל הקו</b> = הנכס נותן יותר מהנדרש → <span style="color:#22c55e;font-weight:700">מתומחר בחסר (מומלץ)</span>.</li>
                <li><b>נקודה על הקו</b> = מתומחר הוגן → <span style="color:#eab308;font-weight:700">ניטרלי</span>.</li>
                <li><b>נקודה מתחת לקו</b> = נותן פחות מהנדרש → <span style="color:#ef4444;font-weight:700">מתומחר ביתר (לא מומלץ)</span>.</li>
            </ul>
            <p><b>חשוב:</b> הנקודות הירוקות, הצהובות <u>והאדומות</u> — כולן נכסים שאתה כבר מחזיק בתיק. הצבע מציין רק את חוות הדעת לגביהן: ירוק = להחזיק/להגדיל, אדום = לשקול צמצום. היהלום הסגול = השוק (β=1), הנקודה התכולה = התיק כולו.</p>`,
    },
};

function openChartInfo(which) {
    const info = _CHART_INFO[which];
    if (!info) return;
    let ov = document.getElementById('chartInfoOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'chartInfoOverlay';
        ov.className = 'chart-info-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) closeChartInfo(); });
        document.body.appendChild(ov);
    }
    ov.innerHTML = `
        <div class="chart-info-dialog" dir="rtl">
            <div class="chart-info-head">
                <h3>${info.title}</h3>
                <button class="chart-info-close" onclick="closeChartInfo()" aria-label="סגור">&times;</button>
            </div>
            <div class="chart-info-body">${info.body}</div>
        </div>`;
    ov.classList.add('active');
}
function closeChartInfo() {
    const ov = document.getElementById('chartInfoOverlay');
    if (ov) ov.classList.remove('active');
}
if (typeof window !== 'undefined') {
    window.openChartInfo = openChartInfo;
    window.closeChartInfo = closeChartInfo;
}

// ========== PORTFOLIO & ASSET MANAGEMENT ==========

function openMgmtModal(action, data) {
    const box = document.getElementById('mgmtBox');
    let html = '';

    if (action === 'addClient') {
        window._brokerImport = null; // fresh modal — never reuse a previous file's history
        html = `
            <div class="mgmt-header"><h3>הוספת תיק חדש</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body" style="max-height:65vh;overflow-y:auto">
                <div class="mgmt-field"><label>שם הלקוח</label><input type="text" id="mgmt-name" placeholder="הזן שם לקוח..." /></div>
                <div class="mgmt-field"><label>מזומן (USD)</label><input type="text" inputmode="decimal" id="mgmt-cash-usd" value="0" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk()" /></div>
                <div class="mgmt-field"><label>מזומן (ILS)</label><input type="text" inputmode="decimal" id="mgmt-cash-ils" value="0" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk()" /></div>

                <div class="mgmt-field" id="mgmt-usd-rate-field">
                    <label>שער קניית הדולר הממוצע (₪ ל-$) — אופציונלי</label>
                    <div style="display:flex;gap:8px;align-items:stretch">
                        <input type="text" inputmode="decimal" id="mgmt-usd-rate" placeholder="לדוגמה: 3.65" style="direction:ltr;text-align:left;flex:1" oninput="formatInputWithCommas(this)" />
                        <button type="button" class="mgmt-btn secondary" style="white-space:nowrap;padding:0 14px" onclick="_fillTodayUsdRate()">שער היום</button>
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">השער שבו נקנו הדולרים בתיק. התשואה הדולרית (מעליית/ירידת הדולר מול השקל) תחושב מולו.</div>
                </div>

                <div class="mgmt-section-divider">הוספת אחזקות</div>

                <div class="file-dropzone" id="addClientDropzone"
                     ondragover="event.preventDefault(); this.classList.add('dragover')"
                     ondragleave="this.classList.remove('dragover')"
                     ondrop="event.preventDefault(); this.classList.remove('dragover'); handleDropzoneFile(event.dataTransfer.files[0])"
                     onclick="document.getElementById('addClientFileInput').click()">
                    <div class="dropzone-icon">&#x2601;</div>
                    <div class="dropzone-text">גרור קובץ Excel, CSV או PDF</div>
                    <div class="dropzone-sub">או לחץ לבחירת קובץ</div>
                    <input type="file" id="addClientFileInput" accept=".xlsx,.xls,.xlsm,.csv,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/pdf,.txt" style="display:none"
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
                    <span class="cash-amount">${formatMoneyInCurrency(cashUsd, 'USD')}</span>
                </div>
                <div class="cash-balance-display">
                    <span>מזומן (ILS):</span>
                    <span class="cash-amount">${formatMoneyInCurrency(cashIls, 'ILS')}</span>
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
                <div class="mgmt-field"><label>סוג פקודה</label>
                    <input type="hidden" id="mgmt-order-type" value="market" />
                    <div class="order-toggle">
                        <button type="button" class="order-toggle-btn active" data-ot="market" onclick="_setOrderType('market')">קנייה במחיר שוק</button>
                        <button type="button" class="order-toggle-btn" data-ot="limit" onclick="_setOrderType('limit')">קנייה בלימיט</button>
                    </div>
                </div>
                <div class="mgmt-field"><label><span id="mgmt-price-label-text">מחיר קנייה</span> (<span id="mgmt-price-currency-label">$</span>)</label><input type="text" inputmode="decimal" id="mgmt-price" placeholder="0.00" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateBuyCost()" /></div>
                <div class="mgmt-field"><label>כמות יחידות</label><input type="text" inputmode="decimal" id="mgmt-qty" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateBuyCost(); _updateQtyPreview('mgmt-qty','mgmt-qty-preview')" /><div class="qty-live-preview" id="mgmt-qty-preview"></div></div>
                <div class="mgmt-field"><label>סטופ-לוס (אופציונלי)</label><input type="text" inputmode="decimal" id="mgmt-stoploss" placeholder="מחיר יציאה להגנה" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" /></div>
                <div class="mgmt-field"><label>יעד / טייק-פרופיט (אופציונלי)</label><input type="text" inputmode="decimal" id="mgmt-target" placeholder="מחיר יעד למימוש" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" /></div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>סה"כ עלות:</span><span id="mgmt-buy-total">$0</span></div>
                    <div class="buy-cost-row"><span>יתרה לאחר קניה:</span><span id="mgmt-buy-remaining">${formatMoneyInCurrency(cashUsd, 'USD')}</span></div>
                    <div class="insufficient-cash-warning" id="mgmt-cash-warning" style="display:none">אין מספיק מזומן בתיק</div>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" id="mgmt-buy-btn" onclick="addHolding(${c.id})">קנה נכס</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }
    else if (action === 'buyHolding') {
        // Buy MORE of an asset already held — same flow as addHolding but the
        // ticker is locked to this holding (no search).
        const { client: c, holding: h } = data;
        const cashUsd = c.cash?.usd || 0;
        const cashIls = c.cash?.ils || 0;
        const buyHeName = (typeof getHebrewName === 'function') ? getHebrewName(h) : '';
        const buyDisplayName = buyHeName || (h.type === 'stock' ? h.ticker : h.name);
        const buyCurLabel = h.currency === 'ILS' ? '₪' : '$';
        html = `
            <div class="mgmt-header"><h3>קניית ${_mEsc(buyDisplayName)}</h3><button class="modal-close" onclick="closeMgmtModal()">&times;</button></div>
            <div class="mgmt-body">
                <div class="cash-balance-display"><span>מזומן (USD):</span><span class="cash-amount">${formatMoneyInCurrency(cashUsd, 'USD')}</span></div>
                <div class="cash-balance-display"><span>מזומן (ILS):</span><span class="cash-amount">${formatMoneyInCurrency(cashIls, 'ILS')}</span></div>
                <input type="hidden" id="mgmt-available-cash-usd" value="${cashUsd}" />
                <input type="hidden" id="mgmt-available-cash-ils" value="${cashIls}" />
                <input type="hidden" id="mgmt-asset-type" value="${h.type}" />
                <input type="hidden" id="mgmt-ticker-symbol" value="${_mEsc(h.ticker)}" />
                <input type="hidden" id="mgmt-ticker-currency" value="${h.currency || 'USD'}" />
                <input type="hidden" id="mgmt-ticker-name" value="${_mEsc(h.name || h.ticker)}" />
                <input type="hidden" id="mgmt-asset-class" value="${h.assetClass || 'Gov Bond'}" />
                <div class="mgmt-field"><label>נכס</label><div class="ticker-selected-badge" style="display:flex">${_mEsc(buyDisplayName)} <span style="direction:ltr;opacity:.7">${_mEsc(h.ticker)}</span></div></div>
                <div id="mgmt-live-price-preview" style="padding:4px 0;font-size:12px;text-align:right"><span style="color:var(--accent-blue);font-weight:600">מחיר שוק נוכחי: ${formatPrice(h.price)} ${buyCurLabel}</span></div>
                <div class="mgmt-field"><label>סוג פקודה</label>
                    <input type="hidden" id="mgmt-order-type" value="market" />
                    <div class="order-toggle">
                        <button type="button" class="order-toggle-btn active" data-ot="market" onclick="_setOrderType('market')">קנייה במחיר שוק</button>
                        <button type="button" class="order-toggle-btn" data-ot="limit" onclick="_setOrderType('limit')">קנייה בלימיט</button>
                    </div>
                </div>
                <div class="mgmt-field"><label><span id="mgmt-price-label-text">מחיר קנייה</span> (<span id="mgmt-price-currency-label">${buyCurLabel}</span>)</label><input type="text" inputmode="decimal" id="mgmt-price" value="${formatPrice(h.price || 0)}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateBuyCost()" /></div>
                <div class="mgmt-field"><label>כמות יחידות</label><input type="text" inputmode="decimal" id="mgmt-qty" placeholder="0" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateBuyCost(); _updateQtyPreview('mgmt-qty','mgmt-qty-preview')" /><div class="qty-live-preview" id="mgmt-qty-preview"></div></div>
                <div class="mgmt-field"><label>סטופ-לוס (אופציונלי)</label><input type="text" inputmode="decimal" id="mgmt-stoploss" value="${(typeof _orderAnnGet === 'function' && _orderAnnGet(c.id, h.ticker)?.stopLoss) ? formatPrice(_orderAnnGet(c.id, h.ticker).stopLoss) : ''}" placeholder="מחיר יציאה להגנה" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" /></div>
                <div class="mgmt-field"><label>יעד / טייק-פרופיט (אופציונלי)</label><input type="text" inputmode="decimal" id="mgmt-target" value="${(typeof _orderAnnGet === 'function' && _orderAnnGet(c.id, h.ticker)?.target) ? formatPrice(_orderAnnGet(c.id, h.ticker).target) : ''}" placeholder="מחיר יעד למימוש" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" /></div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>סה"כ עלות:</span><span id="mgmt-buy-total">${buyCurLabel}0</span></div>
                    <div class="buy-cost-row"><span>יתרה לאחר קניה:</span><span id="mgmt-buy-remaining">${formatMoneyInCurrency(h.currency === 'ILS' ? cashIls : cashUsd, h.currency || 'USD')}</span></div>
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
                <div class="mgmt-field"><label>סוג פקודה</label>
                    <input type="hidden" id="mgmt-sell-order-type" value="market" />
                    <div class="order-toggle">
                        <button type="button" class="order-toggle-btn active" data-sot="market" onclick="_setSellOrderType('market')">מכירה בשוק</button>
                        <button type="button" class="order-toggle-btn" data-sot="limit" onclick="_setSellOrderType('limit')">מכירה בלימיט</button>
                        <button type="button" class="order-toggle-btn" data-sot="stop" onclick="_setSellOrderType('stop')">סטופ-לוס</button>
                    </div>
                </div>
                <div class="mgmt-field"><label><span id="mgmt-sell-price-label">מחיר מכירה</span> (${currSymbol})</label><input type="text" inputmode="decimal" id="mgmt-sell-price" value="${formatPrice(h.price)}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateSellSummary()" /></div>
                <div class="mgmt-field"><label>כמות למכירה</label><input type="text" inputmode="decimal" id="mgmt-sell-qty" value="${Number(h.shares).toLocaleString('en-US')}" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateSellSummary(); _updateQtyPreview('mgmt-sell-qty','mgmt-sell-qty-preview')" /><div class="qty-live-preview" id="mgmt-sell-qty-preview">${describeQuantity(h.shares)}</div></div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>סה"כ תמורה:</span><span id="mgmt-sell-total" style="color:var(--accent-green);font-weight:700">${formatCurrency(h.price * h.shares, h.currency)}</span></div>
                    <div class="buy-cost-row"><span>רווח/הפסד ממומש:</span><span id="mgmt-sell-pnl" style="font-weight:700"></span></div>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn danger" id="mgmt-sell-btn" onclick="sellHolding(${c.id}, ${holdingId})">מכור</button>
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
                <div class="mgmt-field" id="mgmt-deposit-fx-section">
                    <label>מקור הכסף — הומר משקלים לדולרים? (משפיע על תשואה מותאמת מט"ח)</label>
                    <select id="mgmt-deposit-fxmode" onchange="_onDepositFxModeChange()">
                        <option value="none">לא — הופקדו דולרים</option>
                        <option value="today">כן — לפי שער היום (₪${(window.USD_ILS_RATE || 3.7).toFixed(3)} לדולר)</option>
                        <option value="custom">כן — שער המרה מותאם אישית</option>
                    </select>
                    <input type="text" inputmode="decimal" id="mgmt-deposit-fxrate" placeholder="לדוגמה: 3.62"
                           style="display:none;direction:ltr;text-align:left;margin-top:8px" />
                </div>
                <div class="buy-cost-summary">
                    <div class="buy-cost-row"><span>יתרה לאחר הפקדה:</span><span id="mgmt-deposit-new-balance">${formatCurrency(cashUsd, 'USD')}</span></div>
                </div>
            </div>
            <div class="mgmt-footer">
                <button class="mgmt-btn primary" id="mgmt-deposit-btn" onclick="depositCash(${c.id})">הפקד</button>
                <button class="mgmt-btn secondary" onclick="closeMgmtModal()">ביטול</button>
            </div>`;
    }

    box.innerHTML = html;
    document.getElementById('mgmtOverlay').classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    // History entry so the browser back button closes this window (popstate handler)
    try { history.pushState({ popup: 'mgmt' }, '', location.href); } catch (e) { /* ignore */ }
}

function closeMgmtModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('mgmtOverlay').classList.remove('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
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

    // Show the cost/remaining IN THE ASSET'S OWN CURRENCY (Israeli assets trade in ₪ only) —
    // not converted to the global display currency.
    if (totalEl) totalEl.textContent = formatMoneyInCurrency(total, currency);
    if (remainingEl) {
        remainingEl.textContent = formatMoneyInCurrency(Math.max(0, remaining), currency);
        remainingEl.style.color = remaining < 0 ? 'var(--accent-red)' : 'var(--accent-green)';
    }
    if (warningEl) {
        const short = total > 0 && remaining < 0;
        warningEl.style.display = short ? '' : 'none';
        if (short) {
            // Israeli assets can only be bought with shekels — guide the user to convert/deposit.
            const usdCash = parseFloat(document.getElementById('mgmt-available-cash-usd')?.value) || 0;
            warningEl.textContent = (currency === 'ILS' && usdCash > 0)
                ? 'אין מספיק מזומן בשקלים — נכס ישראלי נרכש בשקלים בלבד. המר דולרים לשקלים (הפקדה/המרה) או הפקד שקלים.'
                : 'אין מספיק מזומן בתיק';
        }
    }
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
    // ILS→USD conversion section is only meaningful for USD deposits
    const fxSection = document.getElementById('mgmt-deposit-fx-section');
    if (fxSection) fxSection.style.display = (currency === 'USD') ? '' : 'none';
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

// Sell order-type toggle (market / limit / stop-loss) — relabels the sell price field.
function _setSellOrderType(t) {
    const hid = document.getElementById('mgmt-sell-order-type');
    if (hid) hid.value = t;
    document.querySelectorAll('.order-toggle .order-toggle-btn[data-sot]').forEach(b => b.classList.toggle('active', b.getAttribute('data-sot') === t));
    const lbl = document.getElementById('mgmt-sell-price-label');
    if (lbl) lbl.textContent = t === 'limit' ? 'מחיר לימיט' : (t === 'stop' ? 'מחיר סטופ-לוס' : 'מחיר מכירה');
}

// Fill the average-USD-rate field with today's live USD/ILS rate.
function _fillTodayUsdRate() {
    const el = document.getElementById('mgmt-usd-rate');
    const rate = window.USD_ILS_RATE || (typeof USD_ILS_RATE !== 'undefined' ? USD_ILS_RATE : 0);
    if (el && rate > 0) el.value = rate.toFixed(3);
}

async function addClient() {
    const submitBtn = document.getElementById('addClientSubmitBtn');

    // --- Step 1: Client-side validation (synchronous, before any async work) ---
    const name = (document.getElementById('mgmt-name')?.value || '').trim();
    const rawUsd = document.getElementById('mgmt-cash-usd')?.value;
    const rawIls = document.getElementById('mgmt-cash-ils')?.value;
    const cashUsd = parseInputNumber(rawUsd);
    const cashIls = parseInputNumber(rawIls);
    const usdAvgRate = parseInputNumber(document.getElementById('mgmt-usd-rate')?.value);
    const rowOrders = (typeof _collectRowOrders === 'function') ? _collectRowOrders() : []; // read DOM before the modal closes

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

    // Guard against SILENT data loss on import: if an asset+quantity row was skipped purely for a
    // missing price (e.g. a holdings snapshot with no cost column and no live price yet), tell the
    // user instead of dropping it quietly.
    const _rowsWithAsset = Array.from(document.querySelectorAll('#mgmt-holdings-tbody tr')).filter(r =>
        (r.querySelector('.row-ticker-symbol')?.value || '').trim() &&
        parseInputNumber(r.querySelector('.row-shares')?.value) > 0).length;
    if (_rowsWithAsset > holdingsData.length) {
        const skipped = _rowsWithAsset - holdingsData.length;
        const ok = confirm(`שים לב: ל-${skipped} נכס(ים) חסר מחיר (לא נמצא מחיר שוק עדכני ולא הוזן מחיר עלות), ולכן הם לא ייכללו בתיק.\n\nטיפ: המתן 2–3 שניות לטעינת המחירים האוטומטית, או הזן מחיר ידנית בשורות המסומנות, ואז שמור.\n\nלהמשיך בכל זאת (ללא הנכסים האלה)?`);
        if (!ok) return;
    }

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

        // Supabase-only. If the connection flag isn't set yet (fresh session: cached UI can
        // accept this click before init finishes), re-verify it — but NEVER fall through to the
        // dead legacy /api backend, whose 401 logout()s the user out to the home screen.
        if (!(await ensureSupabaseReady())) {
            alert('אין כרגע חיבור לשרת. המתן רגע ונסה שוב — לא נוצר ולא נמחק דבר.');
            return;  // finally block resets the button; modal stays open
        }

        // 30s timeout — no external API calls during creation, only Supabase DB calls
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 30000)
        );
        // Broker import → persist the FULL operation history with real dates
        const brokerTxs = (window._brokerImport && window._brokerImport.txs) ? window._brokerImport.txs : null;
        const supaPromise = holdingsData.length > 0
            ? supaAddClientWithHoldings(name, cashUsd, cashIls, holdingsData, onProgress, brokerTxs)
            : supaAddClient(name, cashUsd, cashIls);

        finalClient = await Promise.race([supaPromise, timeoutPromise]);

        console.log('addClient result:', finalClient ? 'success (id=' + finalClient.id + ')' : 'null — check console for supaAddClient errors');

        if (!finalClient) {
            alert('יצירת התיק נכשלה — בדוק את הקונסול (F12) לפרטי השגיאה');
            return;  // finally block will reset button
        }

        clients.push(finalClient);
        // Record the average USD purchase rate so the FX-adjusted return measures the
        // dollar's appreciation/depreciation against the rate the dollars were bought at.
        if (cashUsd > 0 && usdAvgRate > 0.5 && usdAvgRate < 20 && typeof addClientFxBasis === 'function') {
            addClientFxBasis(finalClient.id, cashUsd, usdAvgRate);
        }
        // Persist per-row order tags / stop-loss / target as local annotations.
        if (rowOrders.length && typeof _orderAnnSet === 'function') {
            rowOrders.forEach(o => _orderAnnSet(finalClient.id, o.ticker, { orderType: o.orderType, stopLoss: o.stopLoss, target: o.target }));
        }
        window._brokerImport = null;
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

    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.'); return; }
    const updated = await supaEditClient(clientId, name);
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    closeMgmtModal();
    refreshDashboard();
    _warmModelAfterTrade();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

async function deleteClient(clientId) {
    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.'); return; }
    await supaDeleteClient(clientId);
    clients = clients.filter(c => c.id !== clientId);
    // Deleting the last portfolio is a CONFIRMED-empty state → allow the empty message
    // (otherwise the dashboard would show a perpetual spinner).
    if (typeof window !== 'undefined' && clients.length === 0) window._clientsConfirmedEmpty = true;
    closeMgmtModal();
    if (currentModalClientId === clientId) {
        document.getElementById('modalOverlay').classList.remove('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
        currentModalClientId = null;
    }
    refreshDashboard();
}

// --- Holding CRUD (routes to Supabase when connected, fallback to backend API) ---

// ── Order annotations (order type + stop-loss + target) ──────────────────────
// Stored locally (per portfolio+ticker) so we don't touch the Supabase holdings
// schema. Used to tag the entry (market/limit) and to flag a stop-loss/target
// breach on the holding row. Key: "<portfolioId>:<TICKER>".
const _ORDER_ANN_LS = 'order_ann_v1';
function _orderAnnAll() { try { return JSON.parse(localStorage.getItem(_ORDER_ANN_LS) || '{}'); } catch (e) { return {}; } }
function _orderAnnKey(clientId, ticker) { return `${clientId}:${String(ticker || '').toUpperCase()}`; }
function _orderAnnGet(clientId, ticker) { return _orderAnnAll()[_orderAnnKey(clientId, ticker)] || null; }
function _orderAnnSet(clientId, ticker, ann) {
    try {
        const m = _orderAnnAll(); const k = _orderAnnKey(clientId, ticker);
        const merged = { ...(m[k] || {}), ...ann };
        // Drop empty keys so a cleared field removes the badge.
        Object.keys(merged).forEach(kk => { if (merged[kk] == null || merged[kk] === '') delete merged[kk]; });
        if (Object.keys(merged).length) m[k] = merged; else delete m[k];
        localStorage.setItem(_ORDER_ANN_LS, JSON.stringify(m));
    } catch (e) { }
}
// Segmented order-type toggle (both options always visible). Sets the hidden input
// that addHolding() reads, and relabels the price field for limit orders.
function _setOrderType(t) {
    const hid = document.getElementById('mgmt-order-type');
    if (hid) hid.value = t;
    document.querySelectorAll('.order-toggle .order-toggle-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-ot') === t));
    const lbl = document.getElementById('mgmt-price-label-text');
    if (lbl) lbl.textContent = t === 'limit' ? 'מחיר לימיט' : 'מחיר קנייה';
}

// Lock an action button on submit: shows a pressed/spinner state and blocks a second click while
// the trade is in flight (prevents the slow double-submits the user hit). Returns { ok, end }:
// ok=false means it's already processing → abort; call end() to restore on failure (success closes
// the modal, so the button goes away on its own).
function _beginAction(btnId, busyLabel) {
    const b = document.getElementById(btnId);
    if (!b) return { ok: true, end: () => { } };
    if (b.dataset.busy === '1') return { ok: false, end: () => { } };
    b.dataset.busy = '1';
    b.disabled = true;
    b.classList.add('is-busy');
    const idle = b.innerHTML;
    b.innerHTML = '<span class="btn-spinner"></span> ' + (busyLabel || 'מעבד…');
    return {
        ok: true,
        end: () => { b.dataset.busy = ''; b.disabled = false; b.classList.remove('is-busy'); b.innerHTML = idle; },
    };
}

// After a trade the holdings signature changes, so the risk model must rebuild. Do it in the
// BACKGROUND (non-blocking) and force it once — this warms the cache so opening the CML/SML tab is
// instant instead of triggering a cold build, and refreshes the dashboard model chips. The build
// de-dupes by signature, so a later CML/SML open reuses this in-flight build rather than starting
// a second one.
function _warmModelAfterTrade() {
    setTimeout(() => {
        try {
            if (typeof applyModelRiskToClients === 'function') applyModelRiskToClients({ force: true });
            else if (typeof buildRiskModel === 'function') buildRiskModel(typeof clients !== 'undefined' ? clients : []);
        } catch (e) { /* non-fatal */ }
    }, 80);
}

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
    const _act = _beginAction('mgmt-buy-btn', 'קונה…');
    if (!_act.ok) return;  // already processing — ignore the repeat click
    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.'); _act.end(); return; }
    updated = await portfolioBuyAsset(clientId, holdingData);
    if (updated && updated.error === 'insufficient_cash') {
        const cur = holdingData.currency || 'USD';
        alert(`אין מספיק מזומן (${cur}) בתיק.\nנדרש: ${formatCurrency(updated.required, cur)}\nזמין: ${formatCurrency(updated.available, cur)}`);
        _act.end();
        return;
    }
    if (updated && updated.error) {
        alert(`שגיאה בביצוע הקנייה: ${updated.error}`);
        _act.end();
        return;
    }
    if (!updated) {
        alert('שגיאה בשמירת הנכס. נא לנסות שנית.');
        _act.end();
        return;
    }

    // Save the order tag + stop-loss/target as a local annotation on this position.
    // Only when the fields are present (the add-new-asset form) — "buy more" omits
    // them, and we must not wipe an existing annotation.
    if (document.getElementById('mgmt-order-type')) {
        const _ot = document.getElementById('mgmt-order-type').value || 'market';
        const _sl = parseInputNumber(document.getElementById('mgmt-stoploss')?.value);
        const _tp = parseInputNumber(document.getElementById('mgmt-target')?.value);
        _orderAnnSet(clientId, ticker, { orderType: _ot, stopLoss: _sl > 0 ? _sl : null, target: _tp > 0 ? _tp : null });
    }

    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    closeMgmtModal();
    refreshDashboard();
    _warmModelAfterTrade();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

// --- Deposit Cash ---

// Show the custom-rate input only for "custom" mode; the whole FX section is
// relevant only for USD deposits (handled in updateDepositPreview).
function _onDepositFxModeChange() {
    const mode = document.getElementById('mgmt-deposit-fxmode')?.value;
    const rateEl = document.getElementById('mgmt-deposit-fxrate');
    if (rateEl) {
        rateEl.style.display = (mode === 'custom') ? '' : 'none';
        if (mode === 'custom' && !rateEl.value) rateEl.value = (window.USD_ILS_RATE || 3.7).toFixed(3);
    }
}

async function depositCash(clientId) {
    const amount = parseInputNumber(document.getElementById('mgmt-deposit-amount')?.value);
    const currency = document.getElementById('mgmt-deposit-currency')?.value || 'USD';
    if (!amount || amount <= 0) { alert('נא להזין סכום תקין'); return; }

    // ILS→USD conversion basis: record the REAL rate the dollars were bought at,
    // so the FX-adjusted return measures against the actual purchase rate.
    if (currency === 'USD' && typeof addClientFxBasis === 'function') {
        const mode = document.getElementById('mgmt-deposit-fxmode')?.value || 'none';
        if (mode !== 'none') {
            const rate = mode === 'today'
                ? (window.USD_ILS_RATE || 0)
                : parseInputNumber(document.getElementById('mgmt-deposit-fxrate')?.value);
            if (rate > 0.5 && rate < 20) addClientFxBasis(clientId, amount, rate);
            else if (mode === 'custom') { alert('נא להזין שער המרה תקין (למשל 3.62)'); return; }
        }
    }

    const _act = _beginAction('mgmt-deposit-btn', 'מפקיד…');
    if (!_act.ok) return;
    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע — לא בוצעה הפקדה.'); _act.end(); return; }
    const updated = await portfolioDepositCash(clientId, amount, currency);
    if (!updated) { alert('שמירת ההפקדה נכשלה. נסה שוב.'); _act.end(); return; }  // keep modal open, don't dump to dashboard
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    closeMgmtModal();
    refreshDashboard();
    _warmModelAfterTrade();
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

    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.'); return; }
    const updated = await supaEditHolding(clientId, holdingId, { name: newName, price: newPrice, quantity: newQty });
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    closeMgmtModal();
    refreshDashboard();
    _warmModelAfterTrade();
    if (currentModalClientId === clientId) {
        openModal(clientId);
    }
}

async function removeHolding(clientId, holdingId) {
    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.'); return; }
    const updated = await supaRemoveHolding(clientId, holdingId);
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    closeMgmtModal();
    refreshDashboard();
    _warmModelAfterTrade();
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

    const _act = _beginAction('mgmt-sell-btn', 'מוכר…');
    if (!_act.ok) return;
    if (!(await ensureSupabaseReady())) { alert('אין כרגע חיבור לשרת. נסה שוב בעוד רגע — לא בוצעה מכירה.'); _act.end(); return; }
    const updated = await supaSellHolding(clientId, holdingId, sellQty, sellPrice);
    if (!updated) { alert('המכירה נכשלה. נסה שוב.'); _act.end(); return; }
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1 && updated) clients[idx] = updated;
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    closeMgmtModal();
    refreshDashboard();
    _warmModelAfterTrade();
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
    // Carry the imported currency onto the row — _collectHoldingRows reads row.dataset.currency,
    // so without this an imported ILS holding (e.g. a TASE security) would be saved as USD.
    tr.dataset.currency = (prefill && prefill.currency) || 'USD';
    const todayIso = new Date().toISOString().slice(0, 10);
    tr.innerHTML = `
        <td class="row-ticker-cell">
            <div class="row-ticker-wrapper">
                <input type="hidden" class="row-ticker-symbol" value="${prefill?.ticker || ''}" />
                <input type="hidden" class="row-ticker-name" value="${(prefill?.stockName || '').replace(/"/g, '&quot;')}" />
                <div class="row-ticker-badge" style="display:${prefill?.ticker ? 'flex' : 'none'}" title="${(prefill?.stockName || '').replace(/"/g, '&quot;')}">${prefill?.stockName && prefill.stockName !== prefill.ticker ? `${prefill.stockName} <span class="badge-secid">${prefill.ticker}</span>` : (prefill?.ticker || '')}<button class="ticker-clear-btn" onclick="clearRowTicker('${rowId}')">&times;</button></div>
                <input type="text" class="row-ticker-search" placeholder=""
                       style="direction:ltr;text-align:left;${prefill?.ticker ? 'display:none' : ''}"
                       oninput="onRowTickerSearch('${rowId}')" autocomplete="off" />
                <div class="row-ticker-dropdown" id="dropdown_${rowId}"></div>
            </div>
        </td>
        <td><input type="text" inputmode="decimal" class="row-shares" value="${prefill?.shares ? Number(prefill.shares).toLocaleString('en-US') : ''}" placeholder="0"
                   style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk(); _updateRowValue('${rowId}')" /></td>
        <td><input type="text" inputmode="decimal" class="row-price" value="${prefill?.avgPrice ? formatPrice(prefill.avgPrice) : ''}" placeholder="0.00"
                   style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this); updateAddClientRisk(); _updateRowValue('${rowId}')" />
                   <div class="row-value" id="rowval_${rowId}"></div></td>
        <td class="row-live-price" style="font-size:12px;color:var(--text-muted);text-align:center">—</td>
        <td>
            <div class="row-actions-cell">
                <button class="holding-action-btn rowdate ${prefill?.buyDate ? 'has-date' : ''}" id="datebtn_${rowId}"
                        title="${prefill?.buyDate ? 'תאריך קנייה: ' + prefill.buyDate : 'תאריך קנייה (אופציונלי)'}"
                        onclick="toggleRowDatePop('${rowId}')">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                </button>
                <button class="holding-action-btn roworder" id="orderbtn_${rowId}" title="סוג פקודה, סטופ-לוס ויעד (אופציונלי)" onclick="toggleRowOrderPop('${rowId}')">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
                </button>
                <button class="holding-action-btn delete" onclick="removeHoldingRow('${rowId}')">&times;</button>
                <div class="row-date-pop" id="datepop_${rowId}" style="display:none">
                    <label>תאריך קנייה</label>
                    <input type="date" class="row-buydate" value="${prefill?.buyDate || ''}" min="1990-01-01" max="${todayIso}"
                           onchange="_onRowBuyDate('${rowId}', this.value, true)" />
                    <div class="row-date-btns">
                        <button type="button" class="row-date-ok" onclick="_onRowBuyDate('${rowId}', document.querySelector('#datepop_${rowId} .row-buydate').value)">אישור</button>
                        <button type="button" class="row-date-clear" onclick="_onRowBuyDate('${rowId}', '')">נקה</button>
                    </div>
                </div>
                <div class="row-date-pop row-order-pop" id="orderpop_${rowId}" style="display:none">
                    <input type="hidden" class="row-ordertype" value="market" />
                    <label>סוג פקודה</label>
                    <div class="order-toggle order-toggle-sm">
                        <button type="button" class="order-toggle-btn active" data-ot="market" onclick="_setRowOrderType('${rowId}','market')">שוק</button>
                        <button type="button" class="order-toggle-btn" data-ot="limit" onclick="_setRowOrderType('${rowId}','limit')">לימיט</button>
                    </div>
                    <label style="margin-top:6px">סטופ-לוס</label>
                    <input type="text" inputmode="decimal" class="row-stoploss" placeholder="מחיר" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" />
                    <label style="margin-top:6px">יעד / טייק-פרופיט</label>
                    <input type="text" inputmode="decimal" class="row-target" placeholder="מחיר" style="direction:ltr;text-align:left" oninput="formatInputWithCommas(this)" />
                    <div class="row-date-btns"><button type="button" class="row-date-ok" onclick="toggleRowOrderPop('${rowId}')">סגור</button></div>
                </div>
            </div>
        </td>
    `;
    tbody.appendChild(tr);
    updateAddClientRisk();
    _updateRowValue(rowId);

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

// ── Per-row purchase-date popover (optional — earliest date becomes the portfolio opening date) ──
function toggleRowDatePop(rowId) {
    const pop = document.getElementById('datepop_' + rowId);
    if (!pop) return;
    const isOpen = pop.style.display !== 'none';
    document.querySelectorAll('.row-date-pop').forEach(p => { p.style.display = 'none'; });
    if (!isOpen) {
        pop.style.display = 'block';
        const inp = pop.querySelector('.row-buydate');
        if (inp) inp.focus();
    }
}

function _onRowBuyDate(rowId, value, keepOpen) {
    // Mid-typing the browser commits partial years like 0002 — ignore until plausible
    const valid = !!value && Number(value.slice(0, 4)) >= 1990;
    if (value && !valid) return; // user is still typing the year — don't react, don't close

    const pop = document.getElementById('datepop_' + rowId);
    const btn = document.getElementById('datebtn_' + rowId);
    if (pop) {
        const inp = pop.querySelector('.row-buydate');
        if (inp && inp.value !== value) inp.value = value;
        if (!keepOpen) pop.style.display = 'none';
    }
    if (btn) {
        btn.classList.toggle('has-date', valid);
        btn.title = valid ? 'תאריך קנייה: ' + value : 'תאריך קנייה (אופציונלי)';
    }
}

// ── Per-row order popup (order type + stop-loss + target) in the add-portfolio table ──
function toggleRowOrderPop(rowId) {
    const pop = document.getElementById('orderpop_' + rowId);
    if (!pop) return;
    const isOpen = pop.style.display !== 'none';
    document.querySelectorAll('.row-date-pop').forEach(p => { p.style.display = 'none'; });
    if (!isOpen) pop.style.display = 'block';
}
function _setRowOrderType(rowId, t) {
    const pop = document.getElementById('orderpop_' + rowId);
    if (!pop) return;
    const hid = pop.querySelector('.row-ordertype');
    if (hid) hid.value = t;
    pop.querySelectorAll('.order-toggle-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-ot') === t));
    const btn = document.getElementById('orderbtn_' + rowId);
    if (btn) btn.classList.toggle('has-date', t === 'limit' || !!pop.querySelector('.row-stoploss')?.value || !!pop.querySelector('.row-target')?.value);
}
// Show how much a row's holding is worth (shares × price) in its currency.
function _updateRowValue(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const el = document.getElementById('rowval_' + rowId);
    if (!el) return;
    const shares = parseInputNumber(row.querySelector('.row-shares')?.value);
    const price = parseInputNumber(row.querySelector('.row-price')?.value);
    if (shares > 0 && price > 0) {
        const cur = row.dataset?.currency || 'USD';
        const sym = cur === 'ILS' ? '₪' : '$';
        el.textContent = `שווי: ${sym}${(shares * price).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    } else {
        el.textContent = '';
    }
}

// Read order metadata from each add-portfolio row → [{ ticker, orderType, stopLoss, target }].
function _collectRowOrders() {
    const tbody = document.getElementById('mgmt-holdings-tbody');
    if (!tbody) return [];
    const out = [];
    tbody.querySelectorAll('tr').forEach(row => {
        const ticker = row.querySelector('.row-ticker-symbol')?.value?.trim().toUpperCase();
        if (!ticker) return;
        const orderType = row.querySelector('.row-ordertype')?.value || 'market';
        const stopLoss = parseInputNumber(row.querySelector('.row-stoploss')?.value);
        const target = parseInputNumber(row.querySelector('.row-target')?.value);
        if (orderType === 'limit' || stopLoss > 0 || target > 0) {
            out.push({ ticker, orderType, stopLoss: stopLoss > 0 ? stopLoss : null, target: target > 0 ? target : null });
        }
    });
    return out;
}

function clearRowTicker(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    row.querySelector('.row-ticker-symbol').value = '';
    const nameInp = row.querySelector('.row-ticker-name');
    if (nameInp) nameInp.value = '';
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
            // CRITICAL: a holdings snapshot (assets + quantities, no cost column) imports with an empty
            // price. Without backfilling it, _collectHoldingRows drops the row on save (price<=0) and the
            // imported holding silently vanishes. Value such a holding at the current market price (the
            // user can still edit). Never overwrite a price the file already provided.
            const rowEl = document.getElementById(rowId);
            if (rowEl) {
                rowEl.dataset.livePrice = String(result.price);
                const priceInput = rowEl.querySelector('.row-price');
                if (priceInput && !(parseInputNumber(priceInput.value) > 0)) {
                    priceInput.value = formatPrice(result.price);
                    priceInput.dataset.fromLive = '1';
                    _updateRowValue(rowId);
                    if (typeof updateAddClientRisk === 'function') updateAddClientRisk();
                }
            }
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
        let price = parseInputNumber(row.querySelector('.row-price')?.value);
        const currency = row.dataset?.currency || 'USD';

        // Save-time fallback: imported holdings snapshot with no cost column → use the fetched live
        // price so a valid asset+quantity is never silently dropped just because price was blank.
        if (!(price > 0) && row.dataset?.livePrice) price = parseFloat(row.dataset.livePrice) || 0;

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
            currency,
            buyDate: (() => {
                const bd = row.querySelector('.row-buydate')?.value || '';
                return bd && Number(bd.slice(0, 4)) >= 1990 ? bd : null;
            })()
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

        // ── Broker activity export: full reconstruction (holdings + cash + history) ──
        if (result && result.broker) {
            window._brokerImport = result;
            const tbody = document.getElementById('mgmt-holdings-tbody');
            if (tbody) tbody.innerHTML = '';
            result.holdings.forEach(h => addHoldingRow(h));

            // The statement is authoritative — SET the cash buckets (not add)
            const cu = document.getElementById('mgmt-cash-usd');
            const ci = document.getElementById('mgmt-cash-ils');
            if (cu) cu.value = formatPrice(result.cashUsd || 0);
            if (ci) ci.value = formatPrice(result.cashIls || 0);

            const [oy, om, od] = (result.openDate || '').split('-');
            if (statusEl) {
                statusEl.innerHTML = `<div class="file-status-success">דוח ברוקר זוהה: ${result.txs.length} פעולות → ${result.holdings.length} אחזקות פעילות
                    ${result.openDate ? `<br>תאריך פתיחת התיק (קנייה ראשונה): <strong>${od}.${om}.${oy}</strong>` : ''}</div>`;
            }
            _renderBrokerHistory(result);
            updateAddClientRisk();
            if (dropzone) dropzone.style.opacity = '1';
            return;
        }

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

            // Purchase dates found → earliest becomes the portfolio opening date
            const buyDates = parsed.map(r => r.buyDate).filter(Boolean).sort();
            if (buyDates.length) {
                const [y, m, d] = buyDates[0].split('-');
                statusMsg += `<br>זוהו תאריכי קנייה ל-${buyDates.length} אחזקות — תאריך פתיחת התיק ייקבע לפי הקנייה הראשונה: <strong>${d}.${m}.${y}</strong>`;
            }

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

// ── Broker import: history panel inside the add-portfolio modal ──
// Trades (קניות/מכירות) shown by default; everything else (המרות מט"ח, הפקדות,
// משיכות, פעולות מס, הטבות) behind a "פעולות נוספות" button. Bonuses get a
// special gold badge.
function _renderBrokerHistory(result) {
    const host = document.getElementById('addClientFileStatus');
    if (!host) return;
    let panel = document.getElementById('brokerHistoryPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'brokerHistoryPanel';
        host.after(panel);
    }
    const heDate = (iso) => { const [y, m, d] = (iso || '').split('-'); return `${d}.${m}.${y}`; };
    const money = (n, cur) => (cur === 'USD' ? '$' : '₪') + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

    const trades = result.txs.filter(t => t.kind === 'buy' || t.kind === 'sell' || t.kind === 'secdeposit')
        .sort((a, b) => b.date.localeCompare(a.date));
    const others = result.txs.filter(t => !['buy', 'sell', 'secdeposit', 'other'].includes(t.kind))
        .sort((a, b) => b.date.localeCompare(a.date));

    const tradeRows = trades.map(t => `
        <tr>
            <td>${heDate(t.date)}</td>
            <td><span class="bh-kind ${t.kind === 'sell' ? 'sell' : 'buy'}">${t.kind === 'sell' ? 'מכירה' : t.kind === 'secdeposit' ? 'העברת נייר' : 'קנייה'}</span></td>
            <td style="direction:ltr">${t.ticker}</td>
            <td>${Number(t.shares).toLocaleString('en-US')}</td>
            <td>${money(t.price, t.currency)}</td>
            <td>${t.fee ? money(t.fee, t.currency) : '—'}</td>
        </tr>`).join('');

    const otherLabel = { fx: 'המרת מט"ח', deposit: 'הפקדה', withdraw: 'משיכה', tax: 'פעולת מס', bonus: 'הטבה' };
    const otherRows = others.map(t => {
        const what = t.kind === 'fx'
            ? `$${Number(t.usd).toLocaleString('en-US')} בשער ${Number(t.fxRate).toFixed(3)} (₪${Number(t.ils).toLocaleString('en-US')})`
            : t.kind === 'tax'
                ? `${t.name} — ${t.dirOut ? 'חיוב' : 'זיכוי'} ₪${Number(t.amount).toLocaleString('en-US')}`
                : `${t.name || ''} ₪${Number(Math.abs(t.amount || 0)).toLocaleString('en-US')}`;
        return `
        <tr class="${t.kind === 'bonus' ? 'bh-bonus-row' : ''}">
            <td>${heDate(t.date)}</td>
            <td>${t.kind === 'bonus' ? '<span class="bh-bonus-badge">★ הטבה</span>' : `<span class="bh-kind misc">${otherLabel[t.kind] || t.kind}</span>`}</td>
            <td colspan="4">${what}</td>
        </tr>`;
    }).join('');

    panel.innerHTML = `
        <div class="broker-history">
            <div class="bh-title">היסטוריית קניות ומכירות (${trades.length})</div>
            <div class="bh-scroll">
                <table class="bh-table">
                    <thead><tr><th>תאריך</th><th>פעולה</th><th>נייר</th><th>כמות</th><th>מחיר</th><th>עמלה</th></tr></thead>
                    <tbody>${tradeRows || '<tr><td colspan="6">אין עסקאות</td></tr>'}</tbody>
                </table>
            </div>
            <button type="button" class="bh-more-btn" onclick="const x=document.getElementById('bhOthers'); const on=x.style.display==='none'; x.style.display=on?'':'none'; this.textContent=on?'הסתר פעולות נוספות':'הצג פעולות נוספות (${others.length}) — המרות מט"ח, הפקדות, מסים והטבות';">הצג פעולות נוספות (${others.length}) — המרות מט"ח, הפקדות, מסים והטבות</button>
            <div id="bhOthers" style="display:none">
                <div class="bh-scroll">
                    <table class="bh-table"><tbody>${otherRows || '<tr><td>אין פעולות נוספות</td></tr>'}</tbody></table>
                </div>
            </div>
        </div>`;
}

// Close row dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-actions-cell')) {
        document.querySelectorAll('.row-date-pop').forEach(p => { p.style.display = 'none'; });
    }
    if (!e.target.closest('.row-ticker-wrapper')) {
        document.querySelectorAll('.row-ticker-dropdown').forEach(d => {
            d.style.display = 'none';
        });
    }
});
