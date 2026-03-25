// ========== CLIENTS - Frontend Chart Helpers & Portfolio Calculations ==========

// ========== UNIFIED PORTFOLIO CALCULATIONS (FX-AWARE) ==========
// These functions are the SINGLE SOURCE OF TRUTH for portfolio totals.
// Used by: render.js (dashboard cards, summary bar), modals.js (client detail),
//          charts.js (performance normalization).
// All amounts are converted to USD (display currency) at the asset level before summing.

function calcPortfolioValue(client) {
    const fx = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    const holdingsValue = client.holdings.reduce((sum, h) => sum + (h.shares * h.price) * fx(h.currency), 0);
    const cashUsd = (client.cash_usd || 0) + (client.cash_ils || 0) * fx('ILS');
    return holdingsValue + (cashUsd || client.cashBalance || 0);
}

// Unified return calculator — returns { totalValue, totalCost, profit, returnPct }
// All values are in USD (display currency). FX conversion happens per-holding.
function calcPortfolioReturn(client) {
    const fx = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    const totalCost = client.holdings.reduce((s, h) => s + (h.costBasis || 0) * fx(h.currency), 0);
    const totalValue = client.holdings.reduce((s, h) => s + (h.value || 0) * fx(h.currency), 0);
    const profit = totalValue - totalCost;
    const returnPct = totalCost > 0 ? (profit / totalCost * 100) : 0;
    return { totalValue, totalCost, profit, returnPct };
}

// ========== SMART LABELS (zoom-aware) ==========

function getSmartLabel(hist, index, chart) {
    // Determine visible range
    const xScale = chart.scales.x;
    const minIndex = Math.max(0, Math.floor(xScale.min || 0));
    const maxIndex = Math.min(hist.length - 1, Math.ceil(xScale.max || hist.length - 1));
    const visibleCount = maxIndex - minIndex + 1;

    const point = hist[index];
    if (!point) return null;

    // Calculate how many years are visible
    const startYear = hist[minIndex] ? hist[minIndex].year : point.year;
    const endYear = hist[maxIndex] ? hist[maxIndex].year : point.year;
    const yearSpan = endYear - startYear;

    if (yearSpan > 1 || visibleCount > 150) {
        // Zoomed out: show years - only at first occurrence of each year
        if (index === 0 || point.year !== hist[index - 1].year) {
            return point.yearLabel;
        }
        return null;
    } else {
        // Zoomed in: show months - only at first occurrence of each month
        if (index === 0 || point.month !== hist[index - 1].month || point.year !== hist[index - 1].year) {
            return point.monthLabel;
        }
        return null;
    }
}
