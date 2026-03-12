// ========== CLIENTS CONTROLLER ==========

const prisma = require('../services/db');
const { recalcClient, generatePerformanceHistory } = require('../services/clientGenerator');

const RISK_LABELS = { high: 'גבוה', medium: 'בינוני', low: 'נמוך' };
const RISK_STOCK_PCT = { high: 80, medium: 50, low: 15 };
const RISK_BOND_PCT = { high: 20, medium: 50, low: 85 };

// GET /api/clients — only this user's clients
async function getAll(req, res, next) {
    try {
        const clients = await prisma.client.findMany({
            where: { userId: req.user.id },
            include: { holdings: true },
            orderBy: { id: 'asc' }
        });
        res.json(clients);
    } catch (err) {
        next(err);
    }
}

// GET /api/clients/:id — only if belongs to this user
async function getById(req, res, next) {
    try {
        const client = await prisma.client.findFirst({
            where: { id: parseInt(req.params.id), userId: req.user.id },
            include: { holdings: true }
        });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        res.json(client);
    } catch (err) {
        next(err);
    }
}

// POST /api/clients  { name, risk } — assigned to this user
async function create(req, res, next) {
    try {
        const { name, risk } = req.body;
        if (!name || !risk) return res.status(400).json({ error: 'name and risk are required' });
        if (!RISK_LABELS[risk]) return res.status(400).json({ error: 'risk must be high, medium, or low' });

        const newClient = await prisma.client.create({
            data: {
                name,
                risk,
                riskLabel: RISK_LABELS[risk],
                stockPct: RISK_STOCK_PCT[risk],
                bondPct: RISK_BOND_PCT[risk],
                portfolioValue: 0,
                initialInvestment: 0,
                performanceHistory: [],
                userId: req.user.id
            },
            include: { holdings: true }
        });

        // Generate performance history and save
        const perfHistory = generatePerformanceHistory(newClient);
        const updated = await prisma.client.update({
            where: { id: newClient.id },
            data: { performanceHistory: perfHistory },
            include: { holdings: true }
        });

        res.status(201).json(updated);
    } catch (err) {
        next(err);
    }
}

// PUT /api/clients/:id  { name, risk } — only if belongs to this user
async function update(req, res, next) {
    try {
        const client = await prisma.client.findFirst({
            where: { id: parseInt(req.params.id), userId: req.user.id },
            include: { holdings: true }
        });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const { name, risk } = req.body;
        const updateData = {};
        if (name) updateData.name = name;
        if (risk && RISK_LABELS[risk]) {
            updateData.risk = risk;
            updateData.riskLabel = RISK_LABELS[risk];
        }

        const updatedClient = await prisma.client.update({
            where: { id: client.id },
            data: updateData,
            include: { holdings: true }
        });

        // Regenerate performance history
        const perfHistory = generatePerformanceHistory(updatedClient);
        const final = await prisma.client.update({
            where: { id: client.id },
            data: { performanceHistory: perfHistory },
            include: { holdings: true }
        });

        res.json(final);
    } catch (err) {
        next(err);
    }
}

// DELETE /api/clients/:id — only if belongs to this user
async function remove(req, res, next) {
    try {
        const client = await prisma.client.findFirst({
            where: { id: parseInt(req.params.id), userId: req.user.id }
        });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        await prisma.client.delete({ where: { id: client.id } });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

module.exports = { getAll, getById, create, update, remove };
