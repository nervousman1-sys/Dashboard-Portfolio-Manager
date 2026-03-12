// ========== FILTERS - Filtering, Sorting & Time Range ==========

function setFilter(type, value, btn) {
    activeFilters[type] = value;

    // Update button states
    document.querySelectorAll(`[data-filter="${type}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    renderClientCards();
}

function searchClients(query) {
    activeFilters.search = query;
    renderClientCards();
}

function setSizeFilter(size, btn) {
    document.querySelectorAll('[data-filter="size"]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (size === 'all') { activeFilters.sizeMin = null; activeFilters.sizeMax = null; }
    else if (size === 'small') { activeFilters.sizeMin = null; activeFilters.sizeMax = 250000; }
    else if (size === 'medium') { activeFilters.sizeMin = 250000; activeFilters.sizeMax = 500000; }
    else if (size === 'large') { activeFilters.sizeMin = 500000; activeFilters.sizeMax = null; }
    renderClientCards();
}

function setSort(value) {
    activeFilters.sort = value;
    renderClientCards();
}

// ========== TIME RANGE ==========

function filterHistoryByRange(history, range) {
    if (range === 'all' || !history.length) return history;
    const now = new Date();
    let cutoff;
    if (range === '1m') cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    else if (range === '3m') cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    else if (range === '1y') cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
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

function setCardTimeRange(clientId, range, btn) {
    const client = clients.find(c => c.id === clientId);
    if (!client || !client.performanceHistory) return;

    btn.parentElement.querySelectorAll('.time-range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const hist = filterHistoryByRange(client.performanceHistory, range);
    if (!hist.length) return;

    if (charts[`perf-${clientId}`]) { charts[`perf-${clientId}`].destroy(); delete charts[`perf-${clientId}`]; }

    const perfCtx = document.getElementById(`perf-${clientId}`);
    if (!perfCtx) return;

    const isPositive = (hist[hist.length - 1]?.returnPct || 0) >= 0;
    const lineColor = isPositive ? COLORS.profit : COLORS.loss;
    const bgColor = isPositive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';

    charts[`perf-${clientId}`] = new Chart(perfCtx, {
        type: 'line',
        data: {
            labels: hist.map(p => p.date),
            datasets: [{ data: hist.map(p => p.returnPct), borderColor: lineColor, backgroundColor: bgColor, borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.3 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { display: false }, y: { display: false, beginAtZero: false } },
            plugins: { legend: { display: false }, tooltip: { rtl: true, callbacks: { title: (items) => items[0].label, label: (ctx) => ` תשואה: ${ctx.parsed.y.toFixed(2)}%` } } },
            interaction: { intersect: false, mode: 'index' }
        }
    });
}
