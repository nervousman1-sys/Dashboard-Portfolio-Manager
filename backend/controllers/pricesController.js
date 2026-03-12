// ========== PRICES CONTROLLER ==========

const store = require('../store/memoryStore');
const prisma = require('../services/db');
const { fetchStockPrice, generateSimulatedPrice, fetchAllPrices, updatePricesForClients } = require('../services/priceService');

// GET /api/prices/:ticker
async function getPrice(req, res, next) {
    try {
        const { ticker } = req.params;

        // Return from cache if available
        if (store.priceCache[ticker]) {
            return res.json(store.priceCache[ticker]);
        }

        // Fetch from Yahoo Finance
        const price = await fetchStockPrice(ticker);
        const result = price || generateSimulatedPrice(ticker);
        store.priceCache[ticker] = result;
        res.json(result);
    } catch (err) {
        next(err);
    }
}

// POST /api/prices/batch  { tickers: [...] }
async function batchPrices(req, res, next) {
    try {
        const { tickers } = req.body;
        if (!tickers || !Array.isArray(tickers)) {
            return res.status(400).json({ error: 'tickers array is required' });
        }

        const results = await fetchAllPrices(tickers);
        // Update cache
        Object.assign(store.priceCache, results);
        res.json(results);
    } catch (err) {
        next(err);
    }
}

// POST /api/prices/refresh — only refresh this user's clients
async function refreshAll(req, res, next) {
    try {
        await updatePricesForClients(req.user.id);
        const clientCount = await prisma.client.count({ where: { userId: req.user.id } });
        res.json({ success: true, clientCount });
    } catch (err) {
        next(err);
    }
}

module.exports = { getPrice, batchPrices, refreshAll };
