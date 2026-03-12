// ========== CLIENT GENERATOR - Ported from js/clients.js + js/app.js ==========

const prisma = require('./db');
const { ISRAELI_NAMES, ALL_TICKERS, SECTOR_MAP, BONDS } = require('../data/constants');

// Utility: shuffle array (ported from js/app.js)
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Utility: pick N random items (ported from js/app.js)
function pickRandom(arr, n) {
    return shuffle(arr).slice(0, n);
}

// Distribute percentage among N items (ported from js/clients.js)
function distributePercentage(total, count) {
    const parts = [];
    let remaining = total;
    for (let i = 0; i < count - 1; i++) {
        const min = Math.max(1, Math.floor(remaining / (count - i) * 0.4));
        const max = Math.floor(remaining / (count - i) * 1.6);
        const part = min + Math.floor(Math.random() * (max - min + 1));
        const clamped = Math.min(part, remaining - (count - i - 1));
        parts.push(clamped);
        remaining -= clamped;
    }
    parts.push(remaining);
    return parts;
}

// Generate performance history (returns the history array, does NOT mutate client)
function generatePerformanceHistory(client) {
    const history = [];
    let value = client.initialInvestment || 100000;
    const today = new Date();
    const startDate = new Date(2019, 0, 1);

    const totalDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

    const volatility = { high: 0.014, medium: 0.009, low: 0.004 };
    const drift = { high: 0.0003, medium: 0.00025, low: 0.00015 };
    const vol = volatility[client.risk];
    const d = drift[client.risk];

    for (let i = 0; i <= totalDays; i += 5) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        if (date.getDay() === 0 || date.getDay() === 6) continue;

        let eventMultiplier = 1;
        const y = date.getFullYear();
        const m = date.getMonth();
        if (y === 2020 && m >= 1 && m <= 3) eventMultiplier = 0.97;
        if (y === 2020 && m >= 4 && m <= 8) eventMultiplier = 1.02;
        if (y === 2022 && m >= 0 && m <= 9) eventMultiplier = 0.995;

        const dailyReturn = (d + vol * (Math.random() * 2 - 1)) * eventMultiplier;
        value = value * (1 + dailyReturn);

        history.push({
            date: date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }),
            monthLabel: date.toLocaleDateString('he-IL', { month: 'short', year: '2-digit' }),
            yearLabel: date.getFullYear().toString(),
            month: date.getMonth(),
            year: date.getFullYear(),
            value: Math.round(value),
            returnPct: ((value - (client.initialInvestment || 100000)) / (client.initialInvestment || 100000) * 100)
        });
    }

    // Last point matches current portfolio value
    if (history.length > 0 && client.portfolioValue > 0) {
        history[history.length - 1].value = Math.round(client.portfolioValue);
        history[history.length - 1].returnPct = ((client.portfolioValue - client.initialInvestment) / client.initialInvestment * 100);
    }

    return history;
}

// Recalculate client totals from DB holdings, update DB, return full client
async function recalcClient(clientId) {
    const client = await prisma.client.findUnique({
        where: { id: clientId },
        include: { holdings: true }
    });
    if (!client) return null;

    let totalValue = 0;
    const holdingUpdates = [];

    client.holdings.forEach(h => {
        const value = h.shares * h.price;
        totalValue += value;
        holdingUpdates.push({ id: h.id, value });
    });

    // Update holding values and allocation percentages
    for (const hu of holdingUpdates) {
        const allocationPct = totalValue > 0 ? (hu.value / totalValue * 100) : 0;
        await prisma.holding.update({
            where: { id: hu.id },
            data: { value: hu.value, allocationPct }
        });
    }

    // Calculate stock/bond percentages
    let stockPct = 0;
    let bondPct = 0;
    if (totalValue > 0) {
        client.holdings.forEach(h => {
            const pct = (h.shares * h.price) / totalValue * 100;
            if (h.type === 'stock') stockPct += pct;
            else bondPct += pct;
        });
    }

    const initialInvestment = client.holdings.reduce((s, h) => s + h.costBasis, 0);

    // Generate performance history
    const perfClient = { ...client, portfolioValue: totalValue, initialInvestment };
    const perfHistory = generatePerformanceHistory(perfClient);

    // Update client record
    const updated = await prisma.client.update({
        where: { id: clientId },
        data: {
            portfolioValue: totalValue,
            initialInvestment,
            stockPct,
            bondPct,
            performanceHistory: perfHistory
        },
        include: { holdings: true }
    });

    return updated;
}

// Seed 20 clients for a specific user
async function seedClients(userId) {
    if (!userId) {
        console.log('seedClients called without userId, skipping.');
        return;
    }

    const names = shuffle(ISRAELI_NAMES);

    const riskProfiles = [
        ...Array(5).fill({ risk: 'high', stockPct: 80, bondPct: 20, label: 'גבוה' }),
        ...Array(5).fill({ risk: 'medium', stockPct: 50, bondPct: 50, label: 'בינוני' }),
        ...Array(10).fill({ risk: 'low', stockPct: 15, bondPct: 85, label: 'נמוך' }),
    ];

    for (let i = 0; i < 20; i++) {
        const profile = riskProfiles[i];
        const portfolioValue = 100000 + Math.floor(Math.random() * 900000);

        const numStocks = 3 + Math.floor(Math.random() * 4);
        const selectedStocks = pickRandom(ALL_TICKERS, numStocks);

        const numBonds = 2 + Math.floor(Math.random() * 2);
        const selectedBonds = pickRandom(BONDS, numBonds);

        const stockAllocations = distributePercentage(profile.stockPct, numStocks);
        const bondAllocations = distributePercentage(profile.bondPct, numBonds);

        const holdingsData = [];

        selectedStocks.forEach((ticker, j) => {
            const allocValue = portfolioValue * stockAllocations[j] / 100;
            const costVariation = 1 + (Math.random() * 0.25 - 0.15);
            holdingsData.push({
                ticker,
                name: ticker,
                type: 'stock',
                typeLabel: 'מניה',
                sector: SECTOR_MAP[ticker] || 'Other',
                allocationPct: stockAllocations[j],
                value: allocValue,
                costBasis: allocValue / costVariation,
                shares: 0,
                price: 0,
                previousClose: 0,
                currency: 'USD'
            });
        });

        selectedBonds.forEach((bond, j) => {
            const allocValue = portfolioValue * bondAllocations[j] / 100;
            const costVariation = 1 + (Math.random() * 0.08 - 0.03);
            holdingsData.push({
                ticker: bond.ticker || bond.id,
                name: bond.name,
                type: 'bond',
                typeLabel: 'אג"ח',
                allocationPct: bondAllocations[j],
                value: allocValue,
                costBasis: allocValue / costVariation,
                shares: 0,
                price: bond.basePrice,
                previousClose: bond.basePrice * (1 + (Math.random() - 0.5) * 0.01),
                currency: bond.type === 'il_cpi' ? 'ILS' : 'USD'
            });
        });

        const initialInvestment = holdingsData.reduce((s, h) => s + h.costBasis, 0);

        // Create client with nested holdings
        const client = await prisma.client.create({
            data: {
                name: names[i],
                risk: profile.risk,
                riskLabel: profile.label,
                stockPct: profile.stockPct,
                bondPct: profile.bondPct,
                portfolioValue,
                initialInvestment,
                performanceHistory: [],
                userId,
                holdings: {
                    create: holdingsData
                }
            },
            include: { holdings: true }
        });

        // Generate and save performance history
        const perfHistory = generatePerformanceHistory(client);
        await prisma.client.update({
            where: { id: client.id },
            data: { performanceHistory: perfHistory }
        });
    }

    console.log('Seeded 20 clients to database.');
}

module.exports = {
    seedClients,
    recalcClient,
    generatePerformanceHistory
};
