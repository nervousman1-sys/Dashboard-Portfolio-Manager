// ========== CHARTS - Chart.js Rendering (Fullscreen, Benchmark, Sector) ==========

function generateSP500Benchmark(client) {
    if (!client.performanceHistory || !client.performanceHistory.length) return [];
    const hist = client.performanceHistory;
    let value = 100; // Normalized to 100
    const benchmark = [];
    const drift = 0.00035;
    const vol = 0.01;
    for (let i = 0; i < hist.length; i++) {
        let eventMul = 1;
        const y = hist[i].year, m = hist[i].month;
        if (y === 2020 && m >= 1 && m <= 3) eventMul = 0.97;
        if (y === 2020 && m >= 4 && m <= 8) eventMul = 1.02;
        if (y === 2022 && m >= 0 && m <= 9) eventMul = 0.995;
        const ret = (drift + vol * (Math.random() * 2 - 1)) * eventMul;
        value = value * (1 + ret);
        benchmark.push({ returnPct: (value - 100) });
    }
    return benchmark;
}

function renderModalSectorChart(client) {
    const ctx = document.getElementById('modal-sector-chart');
    if (!ctx) return;
    if (charts['modal-sector']) charts['modal-sector'].destroy();
    const sectorData = {};
    client.holdings.filter(h => h.type === 'stock').forEach(h => {
        const s = h.sector || 'Other';
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

function openFullscreenChart(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client || !client.performanceHistory) return;

    document.getElementById('fullscreenTitle').textContent = `מעקב תשואה - ${client.name}`;
    document.getElementById('fullscreenOverlay').classList.add('active');

    // Destroy previous instance
    if (fullscreenChartInstance) {
        fullscreenChartInstance.destroy();
        fullscreenChartInstance = null;
    }

    setTimeout(() => {
        const ctx = document.getElementById('fullscreen-chart');
        if (!ctx) return;

        const hist = client.performanceHistory;
        if (!hist || hist.length === 0) return;
        const isPositive = (hist[hist.length - 1]?.returnPct || 0) >= 0;

        fullscreenChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: hist.map((_, i) => i),
                datasets: [
                    {
                        label: 'תשואה %',
                        data: hist.map(p => p.returnPct),
                        borderColor: isPositive ? '#22c55e' : '#ef4444',
                        backgroundColor: isPositive ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                        borderWidth: 2.5,
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 7,
                        pointBackgroundColor: isPositive ? '#22c55e' : '#ef4444',
                        pointBorderColor: '#1e293b',
                        pointBorderWidth: 2,
                        tension: 0.3
                    },
                    {
                        label: 'שווי תיק ($)',
                        data: hist.map(p => p.value),
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59,130,246,0.05)',
                        borderWidth: 2,
                        borderDash: [6, 3],
                        fill: true,
                        pointRadius: 2,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#3b82f6',
                        pointBorderColor: '#1e293b',
                        pointBorderWidth: 2,
                        tension: 0.3,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    x: {
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 13, weight: 'bold' },
                            autoSkip: true,
                            maxRotation: 0,
                            maxTicksLimit: 15,
                            callback: function (val, index) {
                                return getSmartLabel(hist, index, this.chart);
                            }
                        },
                        grid: { color: 'rgba(51,65,85,0.3)' }
                    },
                    y: {
                        position: 'right',
                        title: { display: true, text: 'תשואה %', color: '#94a3b8', font: { size: 13 } },
                        ticks: { color: '#94a3b8', font: { size: 12 }, callback: v => v.toFixed(1) + '%' },
                        grid: { color: 'rgba(51,65,85,0.3)' }
                    },
                    y1: {
                        position: 'left',
                        title: { display: true, text: 'שווי ($)', color: '#94a3b8', font: { size: 13 } },
                        ticks: { color: '#94a3b8', font: { size: 12 }, callback: v => '$' + (v / 1000).toFixed(0) + 'K' },
                        grid: { display: false }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        rtl: true,
                        labels: { color: '#94a3b8', font: { size: 13 }, usePointStyle: true, padding: 20 }
                    },
                    tooltip: {
                        rtl: true,
                        titleFont: { size: 14 },
                        bodyFont: { size: 13 },
                        padding: 12,
                        callbacks: {
                            title: (items) => hist[items[0].dataIndex].date,
                            label: (ctx) => {
                                if (ctx.datasetIndex === 0) return ` תשואה: ${ctx.parsed.y.toFixed(2)}%`;
                                return ` שווי: $${ctx.parsed.y.toLocaleString()}`;
                            }
                        }
                    },
                    zoom: {
                        pan: {
                            enabled: true,
                            mode: 'x',
                            modifierKey: null
                        },
                        zoom: {
                            wheel: { enabled: true, speed: 0.1 },
                            pinch: { enabled: true },
                            drag: {
                                enabled: true,
                                backgroundColor: 'rgba(59,130,246,0.15)',
                                borderColor: '#3b82f6',
                                borderWidth: 1
                            },
                            mode: 'x'
                        }
                    }
                }
            }
        });
    }, 150);
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
