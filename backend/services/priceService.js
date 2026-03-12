// ========== PRICE SERVICE - Yahoo Finance Proxy & Simulated Prices ==========

const store = require('../store/memoryStore');
const prisma = require('./db');

// Fetch with timeout (ported from js/api.js)
function fetchWithTimeout(url, timeoutMs = 3000) {
    return Promise.race([
        fetch(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
}

// Fetch single stock price from Yahoo Finance
async function fetchStockPrice(ticker) {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        const response = await fetchWithTimeout(url, 3000);
        if (!response.ok) throw new Error('API error');
        const data = await response.json();
        const meta = data.chart.result[0].meta;
        return {
            price: meta.regularMarketPrice,
            previousClose: meta.previousClose || meta.chartPreviousClose,
            currency: meta.currency
        };
    } catch (e) {
        return null;
    }
}

// Deterministic simulated price (ported from js/api.js)
function generateSimulatedPrice(ticker, baseMin = 20, baseMax = 500) {
    let hash = 0;
    for (let i = 0; i < ticker.length; i++) hash = ((hash << 5) - hash) + ticker.charCodeAt(i);
    const base = baseMin + (Math.abs(hash) % (baseMax - baseMin));
    const variation = (Math.random() - 0.5) * base * 0.04;
    const price = base + variation;
    const previousClose = price - (Math.random() - 0.5) * price * 0.03;
    return { price: Math.round(price * 100) / 100, previousClose: Math.round(previousClose * 100) / 100, currency: 'USD' };
}

// Batch fetch all prices (ported from js/api.js)
async function fetchAllPrices(tickers) {
    const uniqueTickers = [...new Set(tickers)];
    const results = {};

    // Quick test: can we reach Yahoo Finance?
    let apiAvailable = false;
    try {
        const testResponse = await fetchWithTimeout(
            `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d`, 3000
        );
        if (testResponse.ok) {
            apiAvailable = true;
            const data = await testResponse.json();
            const meta = data.chart.result[0].meta;
            results['AAPL'] = {
                price: meta.regularMarketPrice,
                previousClose: meta.previousClose || meta.chartPreviousClose,
                currency: meta.currency
            };
        }
    } catch (e) { }

    if (apiAvailable) {
        const remaining = uniqueTickers.filter(t => t !== 'AAPL');
        const batchSize = 10;
        for (let i = 0; i < remaining.length; i += batchSize) {
            const batch = remaining.slice(i, i + batchSize);
            const promises = batch.map(async (ticker) => {
                const result = await fetchStockPrice(ticker);
                if (result) results[ticker] = result;
            });
            await Promise.all(promises);
        }
    }

    // Fill missing with simulated prices
    for (const t of uniqueTickers) {
        if (!results[t]) results[t] = generateSimulatedPrice(t);
    }
    return results;
}

// Update client holdings with current prices (optionally filtered by userId)
async function updatePricesForClients(userId) {
    // Fetch holdings from DB (optionally filtered by user's clients)
    const whereClause = userId
        ? { client: { userId } }
        : {};
    const allHoldings = await prisma.holding.findMany({ where: whereClause });

    const allStockTickers = [];
    const bondTickers = [];
    allHoldings.forEach(h => {
        if (h.type === 'stock') allStockTickers.push(h.ticker);
        else if (h.type === 'bond' && h.ticker && !h.ticker.startsWith('IL_')) {
            bondTickers.push(h.ticker);
        }
    });

    const allTickers = [...new Set([...allStockTickers, ...bondTickers])];
    if (allTickers.length > 0) {
        store.priceCache = await fetchAllPrices(allTickers);
    }

    // Get unique client IDs
    const clientIds = [...new Set(allHoldings.map(h => h.clientId))];

    // Update each holding's price in DB
    for (const h of allHoldings) {
        let price = h.price;
        let previousClose = h.previousClose;
        let currency = h.currency;

        if (store.priceCache[h.ticker]) {
            price = store.priceCache[h.ticker].price;
            previousClose = store.priceCache[h.ticker].previousClose;
            currency = store.priceCache[h.ticker].currency || h.currency;
        } else if (h.type === 'bond' && h.ticker.startsWith('IL_')) {
            // Israeli bonds - simulate small daily change
            price = h.price * (1 + (Math.random() - 0.5) * 0.005);
            previousClose = price * (1 + (Math.random() - 0.5) * 0.003);
        }

        const shares = price > 0 ? Math.floor(h.value / price) : 0;
        const value = shares * price;

        await prisma.holding.update({
            where: { id: h.id },
            data: { price, previousClose, currency, shares, value }
        });
    }

    // Recalculate each client's totals
    for (const clientId of clientIds) {
        const holdings = await prisma.holding.findMany({ where: { clientId } });
        let totalValue = 0;
        holdings.forEach(h => { totalValue += h.value; });

        if (totalValue > 0) {
            // Update allocation percentages
            for (const h of holdings) {
                await prisma.holding.update({
                    where: { id: h.id },
                    data: { allocationPct: (h.value / totalValue * 100) }
                });
            }

            const stockPct = holdings.filter(h => h.type === 'stock').reduce((sum, h) => sum + (h.value / totalValue * 100), 0);
            const bondPct = holdings.filter(h => h.type === 'bond').reduce((sum, h) => sum + (h.value / totalValue * 100), 0);

            await prisma.client.update({
                where: { id: clientId },
                data: { portfolioValue: totalValue, stockPct, bondPct }
            });
        }
    }
}

module.exports = {
    fetchStockPrice,
    generateSimulatedPrice,
    fetchAllPrices,
    updatePricesForClients
};
