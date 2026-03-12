// ========== CLIENTS - Frontend Chart Helpers & Portfolio Calculations ==========

// ========== PORTFOLIO VALUE CALCULATION ==========

function calcPortfolioValue(client) {
    const holdingsValue = client.holdings.reduce((sum, h) => sum + (h.shares * h.price), 0);
    return holdingsValue + (client.cashBalance || 0);
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
