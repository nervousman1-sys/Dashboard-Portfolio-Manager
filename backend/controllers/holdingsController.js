// ========== HOLDINGS CONTROLLER ==========

const prisma = require('../services/db');
const store = require('../store/memoryStore');
const { SECTOR_MAP } = require('../data/constants');
const { recalcClient } = require('../services/clientGenerator');
const { fetchStockPrice, generateSimulatedPrice } = require('../services/priceService');

// POST /api/clients/:id/holdings  { type, ticker?, bondName?, price, quantity }
async function addHolding(req, res, next) {
    try {
        // Verify client belongs to this user
        const client = await prisma.client.findFirst({
            where: { id: parseInt(req.params.id), userId: req.user.id }
        });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const { type, ticker: rawTicker, bondName, price, quantity } = req.body;

        if (!type || !['stock', 'bond'].includes(type)) {
            return res.status(400).json({ error: 'type must be stock or bond' });
        }
        if (!price || price <= 0) return res.status(400).json({ error: 'Valid price is required' });
        if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Valid quantity is required' });

        let holdingTicker, name, sector, currency, currentPrice, previousClose;

        if (type === 'stock') {
            holdingTicker = (rawTicker || '').toUpperCase().trim();
            if (!holdingTicker) return res.status(400).json({ error: 'Ticker is required for stocks' });
            name = holdingTicker;
            sector = SECTOR_MAP[holdingTicker] || 'Other';
            currency = 'USD';

            // Get current market price
            if (store.priceCache[holdingTicker]) {
                currentPrice = store.priceCache[holdingTicker].price;
                previousClose = store.priceCache[holdingTicker].previousClose;
            } else {
                const fetched = await fetchStockPrice(holdingTicker);
                if (fetched) {
                    currentPrice = fetched.price;
                    previousClose = fetched.previousClose;
                    store.priceCache[holdingTicker] = fetched;
                } else {
                    const sim = generateSimulatedPrice(holdingTicker);
                    currentPrice = sim.price;
                    previousClose = sim.previousClose;
                    store.priceCache[holdingTicker] = sim;
                }
            }
        } else {
            name = (bondName || '').trim();
            if (!name) return res.status(400).json({ error: 'Bond name is required' });
            holdingTicker = 'BOND_' + Date.now();
            sector = null;
            currency = 'ILS';
            currentPrice = price;
            previousClose = price * (1 + (Math.random() - 0.5) * 0.003);
        }

        const costBasis = price * quantity;
        const value = currentPrice * quantity;

        await prisma.holding.create({
            data: {
                clientId: client.id,
                ticker: holdingTicker,
                name,
                type,
                typeLabel: type === 'stock' ? 'מניה' : 'אג"ח',
                sector,
                allocationPct: 0,
                value,
                costBasis,
                shares: quantity,
                price: currentPrice,
                previousClose,
                currency
            }
        });

        // Recalculate and return updated client
        const updated = await recalcClient(client.id);
        res.status(201).json(updated);
    } catch (err) {
        next(err);
    }
}

// PUT /api/clients/:id/holdings/:holdingId  { name, price, quantity }
async function editHolding(req, res, next) {
    try {
        // Verify client belongs to this user
        const client = await prisma.client.findFirst({
            where: { id: parseInt(req.params.id), userId: req.user.id }
        });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const holdingId = parseInt(req.params.holdingId);
        const h = await prisma.holding.findFirst({
            where: { id: holdingId, clientId: client.id }
        });
        if (!h) return res.status(404).json({ error: 'Holding not found' });

        const { name: newName, price: newPrice, quantity: newQty } = req.body;

        if (!newName) return res.status(400).json({ error: 'Name is required' });
        if (!newPrice || newPrice <= 0) return res.status(400).json({ error: 'Valid price is required' });
        if (!newQty || newQty <= 0) return res.status(400).json({ error: 'Valid quantity is required' });

        const updateData = {
            costBasis: newPrice * newQty,
            shares: newQty,
            value: h.price * newQty
        };

        if (h.type === 'stock') {
            updateData.ticker = newName.toUpperCase();
            updateData.name = updateData.ticker;
            updateData.sector = SECTOR_MAP[updateData.ticker] || 'Other';
        } else {
            updateData.name = newName;
        }

        await prisma.holding.update({
            where: { id: holdingId },
            data: updateData
        });

        // Recalculate and return updated client
        const updated = await recalcClient(client.id);
        res.json(updated);
    } catch (err) {
        next(err);
    }
}

// DELETE /api/clients/:id/holdings/:holdingId
async function removeHolding(req, res, next) {
    try {
        // Verify client belongs to this user
        const client = await prisma.client.findFirst({
            where: { id: parseInt(req.params.id), userId: req.user.id }
        });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const holdingId = parseInt(req.params.holdingId);
        const h = await prisma.holding.findFirst({
            where: { id: holdingId, clientId: client.id }
        });
        if (!h) return res.status(404).json({ error: 'Holding not found' });

        await prisma.holding.delete({ where: { id: holdingId } });

        // Recalculate and return updated client
        const updated = await recalcClient(client.id);
        res.json(updated);
    } catch (err) {
        next(err);
    }
}

module.exports = { addHolding, editHolding, removeHolding };
