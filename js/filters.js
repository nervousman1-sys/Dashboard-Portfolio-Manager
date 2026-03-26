// ========== FILTERS - Filtering, Sorting & Time Range ==========

function setFilter(type, value, btn) {
    activeFilters[type] = value;

    // Update button states
    document.querySelectorAll(`[data-filter="${type}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    _updateDrawerBadge();
    _updateClearFiltersVisibility();
    renderExposureSection();
    renderClientCards();
}

function searchClients(query) {
    activeFilters.search = query;
    _updateClearFiltersVisibility();
    renderExposureSection();
    renderClientCards();
}

function setSizeFilter(size, btn) {
    document.querySelectorAll('[data-filter="size"]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (size === 'all') { activeFilters.sizeMin = null; activeFilters.sizeMax = null; }
    else if (size === 'small') { activeFilters.sizeMin = null; activeFilters.sizeMax = 250000; }
    else if (size === 'medium') { activeFilters.sizeMin = 250000; activeFilters.sizeMax = 500000; }
    else if (size === 'large') { activeFilters.sizeMin = 500000; activeFilters.sizeMax = null; }
    _updateDrawerBadge();
    _updateClearFiltersVisibility();
    renderExposureSection();
    renderClientCards();
}

function setSort(value) {
    activeFilters.sort = value;
    renderClientCards();
}

// ========== FILTER DRAWER ==========

function toggleFilterDrawer(forceState) {
    const drawer = document.getElementById('filterDrawer');
    const backdrop = document.getElementById('filterDrawerBackdrop');
    if (!drawer || !backdrop) return;

    const isOpen = drawer.classList.contains('open');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !isOpen;

    if (shouldOpen) {
        drawer.classList.add('open');
        backdrop.classList.add('active');
    } else {
        drawer.classList.remove('open');
        backdrop.classList.remove('active');
    }
}

function _updateDrawerBadge() {
    const badge = document.getElementById('drawerBadge');
    const toggle = document.getElementById('filterDrawerToggle');
    if (!badge || !toggle) return;

    let count = 0;
    if (activeFilters.asset && activeFilters.asset !== 'all') count++;
    if (activeFilters.sector && activeFilters.sector !== 'all') count++;
    if (activeFilters.sizeMin !== null || activeFilters.sizeMax !== null) count++;

    if (count > 0) {
        badge.textContent = count;
        badge.style.display = '';
        toggle.classList.add('has-active');
    } else {
        badge.style.display = 'none';
        toggle.classList.remove('has-active');
    }
}

// ========== CLEAR ALL FILTERS ==========

function clearAllFilters() {
    // Reset search
    activeFilters.search = '';
    const searchInput = document.querySelector('.filters .search-input');
    if (searchInput) searchInput.value = '';

    // Reset risk
    activeFilters.risk = 'all';
    document.querySelectorAll('[data-filter="risk"]').forEach(b => b.classList.remove('active'));
    const riskAll = document.querySelector('[data-filter="risk"][data-value="all"]');
    if (riskAll) riskAll.classList.add('active');

    // Reset asset
    activeFilters.asset = 'all';
    document.querySelectorAll('[data-filter="asset"]').forEach(b => b.classList.remove('active'));
    const assetAll = document.querySelector('[data-filter="asset"][data-value="all"]');
    if (assetAll) assetAll.classList.add('active');

    // Reset sector
    activeFilters.sector = 'all';
    document.querySelectorAll('[data-filter="sector"]').forEach(b => b.classList.remove('active'));
    const sectorAll = document.querySelector('[data-filter="sector"][data-value="all"]');
    if (sectorAll) sectorAll.classList.add('active');

    // Reset size
    activeFilters.sizeMin = null;
    activeFilters.sizeMax = null;
    document.querySelectorAll('[data-filter="size"]').forEach(b => b.classList.remove('active'));
    const sizeAll = document.querySelector('[data-filter="size"][data-value="all"]');
    if (sizeAll) sizeAll.classList.add('active');

    _updateDrawerBadge();
    _updateClearFiltersVisibility();
    renderExposureSection();
    renderClientCards();
}

function _hasAnyActiveFilter() {
    if (activeFilters.search) return true;
    if (activeFilters.risk && activeFilters.risk !== 'all') return true;
    if (activeFilters.asset && activeFilters.asset !== 'all') return true;
    if (activeFilters.sector && activeFilters.sector !== 'all') return true;
    if (activeFilters.sizeMin !== null || activeFilters.sizeMax !== null) return true;
    return false;
}

function _updateClearFiltersVisibility() {
    const btn = document.getElementById('clearFiltersBtn');
    if (!btn) return;
    btn.style.display = _hasAnyActiveFilter() ? '' : 'none';
}

// Close drawer on Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const drawer = document.getElementById('filterDrawer');
        if (drawer && drawer.classList.contains('open')) {
            toggleFilterDrawer(false);
        }
    }
});

// ========== TIME RANGE ==========

function filterHistoryByRange(history, range) {
    if (!history || !Array.isArray(history)) return [];
    if (range === 'all' || range === 'max' || !history.length) return history;
    const now = new Date();
    let cutoff;
    if (range === '1d') cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    else if (range === '5d') cutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    else if (range === '1m') cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    else if (range === '3m') cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    else if (range === '6m') cutoff = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    else if (range === 'ytd') cutoff = new Date(now.getFullYear(), 0, 1);
    else if (range === '1y') cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    else if (range === '5y') cutoff = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    else return history;

    // Performance history dates are in he-IL format DD.MM.YYYY - parse them
    return history.filter(p => {
        const parts = p.date.split('.');
        if (parts.length === 3) {
            const d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
            return d >= cutoff;
        }
        return true;
    });
}

async function setCardTimeRange(clientId, range, btn) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    btn.parentElement.querySelectorAll('.time-range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    let hist = filterHistoryByRange(client.performanceHistory || [], range);

    // Synthetic fallback for sparse data
    if (hist.length < 5 && typeof fetchSyntheticHistory === 'function') {
        const hasEligible = client.holdings && client.holdings.some(
            h => (h.type === 'stock' || h.type === 'fund') && h.shares > 0
        );
        if (hasEligible) {
            const synth = await fetchSyntheticHistory(client, range);
            if (synth && synth.length >= 2) hist = synth;
        }
    }

    if (!hist || hist.length < 2) return;

    _safeDestroyChart(`perf-${clientId}`);

    const perfCtx = document.getElementById(`perf-${clientId}`);
    if (!perfCtx) return;

    _destroyChartOnCanvas(perfCtx);
    _clearCanvas(perfCtx);

    const firstVal = hist[0]?.value || 0;
    const lastVal = hist[hist.length - 1]?.value || 0;
    const isPositive = lastVal >= firstVal;
    const lineColor = isPositive ? COLORS.profit : COLORS.loss;
    const bgColor = isPositive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';

    charts[`perf-${clientId}`] = new Chart(perfCtx, {
        type: 'line',
        data: {
            labels: hist.map(p => p.date),
            datasets: [{
                data: hist.map(p => p.value),
                borderColor: lineColor, backgroundColor: bgColor,
                borderWidth: 2, fill: true, pointRadius: 0, tension: 0.3,
                clip: true
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            layout: { padding: { top: 4, bottom: 4 } },
            scales: { x: { display: false }, y: { display: false, beginAtZero: false, grace: '15%' } },
            plugins: { legend: { display: false }, tooltip: { rtl: true, callbacks: { title: (items) => items[0].label, label: (ctx) => ` שווי: ${formatCurrency(ctx.parsed.y)}` } } },
            interaction: { intersect: false, mode: 'index' }
        }
    });
}
