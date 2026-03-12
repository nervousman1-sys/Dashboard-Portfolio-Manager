// ========== SUPABASE API - CRUD Operations via Supabase ==========

// Risk profile mappings
const RISK_LABELS_MAP = { high: 'גבוה', medium: 'בינוני', low: 'נמוך' };
const RISK_STOCK_PCT_MAP = { high: 80, medium: 50, low: 15 };
const RISK_BOND_PCT_MAP = { high: 20, medium: 50, low: 85 };

// ========== HELPER: map DB row (snake_case) to frontend object (camelCase) ==========

function mapPortfolio(p) {
    return {
        id: p.id,
        name: p.name,
        risk: p.risk,
        riskLabel: p.risk_label,
        stockPct: p.stock_pct,
        bondPct: p.bond_pct,
        portfolioValue: p.portfolio_value,
        initialInvestment: p.initial_investment,
        cashBalance: p.cash_balance || 0,
        performanceHistory: p.performance_history || [],
        holdings: (p.holdings || []).map(mapHolding)
    };
}

function mapHolding(h) {
    return {
        id: h.id,
        ticker: h.ticker,
        name: h.name,
        type: h.type,
        typeLabel: h.type_label,
        sector: h.sector,
        allocationPct: h.allocation_pct,
        value: h.value,
        costBasis: h.cost_basis,
        shares: h.shares,
        price: h.price,
        previousClose: h.previous_close,
        currency: h.currency
    };
}

// ========== FETCH ALL CLIENTS ==========

async function supaFetchClients() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabaseClient
        .from('portfolios')
        .select('*, holdings(*)')
        .eq('user_id', user.id)
        .order('id', { ascending: true });

    if (error) { console.error('supaFetchClients:', error.message); return []; }
    return data.map(mapPortfolio);
}

// ========== FETCH SINGLE CLIENT ==========

async function supaFetchClient(clientId) {
    const { data, error } = await supabaseClient
        .from('portfolios')
        .select('*, holdings(*)')
        .eq('id', clientId)
        .single();

    if (error) { console.error('supaFetchClient:', error.message); return null; }
    return mapPortfolio(data);
}

// ========== CLIENT CRUD ==========

async function supaAddClient(name, cashBalance = 0) {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return null;

    // New portfolio starts with only cash → 0% stocks → risk = low
    const { data, error } = await supabaseClient
        .from('portfolios')
        .insert({
            user_id: user.id,
            name,
            risk: 'low',
            risk_label: 'נמוך',
            stock_pct: 0,
            bond_pct: 0,
            portfolio_value: cashBalance,
            initial_investment: cashBalance,
            cash_balance: cashBalance,
            performance_history: []
        })
        .select('*, holdings(*)')
        .single();

    if (error) { console.error('supaAddClient:', error.message); return null; }
    return mapPortfolio(data);
}

// Create portfolio with initial holdings in one go
async function supaAddClientWithHoldings(name, cashBalance, holdings) {
    // Step 1: Create the portfolio
    const portfolio = await supaAddClient(name, cashBalance);
    if (!portfolio) return null;

    // Step 2: Add each holding sequentially (handles aggregation)
    let totalHoldingsCost = 0;
    for (const h of holdings) {
        totalHoldingsCost += h.price * h.quantity;
        await supaAddHolding(portfolio.id, h);
    }

    // Step 3: Update initial_investment to include holdings cost
    const totalInvestment = cashBalance + totalHoldingsCost;
    await supabaseClient
        .from('portfolios')
        .update({ initial_investment: totalInvestment })
        .eq('id', portfolio.id);

    // Step 4: Final recalc and return
    await supaRecalcClient(portfolio.id);
    return await supaFetchClient(portfolio.id);
}

async function supaEditClient(clientId, name) {
    // Fetch current data for logging the change
    const { data: current } = await supabaseClient
        .from('portfolios')
        .select('name')
        .eq('id', clientId)
        .single();

    const updateData = {};
    if (name) updateData.name = name;

    const { data, error } = await supabaseClient
        .from('portfolios')
        .update(updateData)
        .eq('id', clientId)
        .select('*, holdings(*)')
        .single();

    if (error) { console.error('supaEditClient:', error.message); return null; }

    // Log settings change (best-effort)
    try {
        const changes = [];
        if (current && name && name !== current.name) changes.push(`שם: ${current.name} → ${name}`);
        if (changes.length > 0) {
            await supaLogTransaction(clientId, {
                type: 'edit_settings',
                ticker: '-',
                name: name || current?.name || '',
                asset_type: 'cash',
                shares: 0,
                price: 0,
                total: 0,
                description: changes.join(', ')
            });
        }
    } catch (e) { console.warn('Edit settings log failed:', e.message); }

    return mapPortfolio(data);
}

async function supaDeleteClient(clientId) {
    const { error } = await supabaseClient
        .from('portfolios')
        .delete()
        .eq('id', clientId);

    if (error) { console.error('supaDeleteClient:', error.message); return null; }
    return { success: true };
}

// ========== HOLDING CRUD ==========

async function supaAddHolding(clientId, holdingData) {
    const { type, ticker: rawTicker, bondName, price, quantity } = holdingData;

    let holdingTicker, name, sector, currency, currentPrice, previousClose;

    const TYPE_LABELS = { stock: 'מניה', bond: 'אג"ח', fund: 'קרן נאמנות' };

    if (type === 'stock' || type === 'fund') {
        holdingTicker = (rawTicker || '').toUpperCase().trim();
        name = holdingData.stockName || holdingTicker;
        sector = type === 'stock' ? (SECTOR_MAP[holdingTicker] || 'Other') : null;
        currency = holdingData.currency || 'USD';
        currentPrice = price;
        previousClose = price * (1 + (Math.random() - 0.5) * 0.03);
    } else {
        name = (bondName || '').trim();
        holdingTicker = 'BOND_' + Date.now();
        sector = null;
        currency = 'ILS';
        currentPrice = price;
        previousClose = price * (1 + (Math.random() - 0.5) * 0.003);
    }

    const costBasis = price * quantity;

    // Check if same ticker already exists in portfolio — aggregate if so
    if (type === 'stock' || type === 'fund') {
        const { data: existing } = await supabaseClient
            .from('holdings')
            .select('*')
            .eq('portfolio_id', clientId)
            .eq('ticker', holdingTicker)
            .single();

        if (existing) {
            // Weighted average cost basis
            const newShares = existing.shares + quantity;
            const newCostBasis = existing.cost_basis + costBasis;
            const newValue = currentPrice * newShares;

            const { error } = await supabaseClient
                .from('holdings')
                .update({
                    shares: newShares,
                    cost_basis: newCostBasis,
                    price: currentPrice,
                    previous_close: previousClose,
                    value: newValue
                })
                .eq('id', existing.id);

            if (error) { console.error('supaAddHolding (aggregate):', error.message); return null; }

            // Log buy transaction
            await supaLogTransaction(clientId, {
                type: 'buy', ticker: holdingTicker, name, asset_type: type,
                shares: quantity, price, total: costBasis
            });

            await supaRecalcClient(clientId);
            return await supaFetchClient(clientId);
        }
    }

    // New holding — insert fresh row
    const value = currentPrice * quantity;

    const { error } = await supabaseClient
        .from('holdings')
        .insert({
            portfolio_id: clientId,
            ticker: holdingTicker,
            name,
            type,
            type_label: TYPE_LABELS[type] || type,
            sector,
            allocation_pct: 0,
            value,
            cost_basis: costBasis,
            shares: quantity,
            price: currentPrice,
            previous_close: previousClose,
            currency
        });

    if (error) { console.error('supaAddHolding:', error.message); return null; }

    // Log buy transaction
    await supaLogTransaction(clientId, {
        type: 'buy', ticker: holdingTicker, name, asset_type: type,
        shares: quantity, price, total: costBasis
    });

    // Recalculate and return updated client
    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}

async function supaEditHolding(clientId, holdingId, data) {
    const { name: newName, price: newPrice, quantity: newQty } = data;

    // Get current holding to check type and detect quantity reduction
    const { data: h, error: fetchErr } = await supabaseClient
        .from('holdings')
        .select('*')
        .eq('id', holdingId)
        .single();

    if (fetchErr || !h) { console.error('supaEditHolding fetch:', fetchErr?.message); return null; }

    // If quantity decreased, transfer sale proceeds to cash_balance
    if (newQty < h.shares) {
        const soldShares = h.shares - newQty;
        const saleProceeds = soldShares * h.price;

        const { data: portfolio } = await supabaseClient
            .from('portfolios')
            .select('cash_balance')
            .eq('id', clientId)
            .single();

        if (portfolio) {
            await supabaseClient
                .from('portfolios')
                .update({ cash_balance: (portfolio.cash_balance || 0) + saleProceeds })
                .eq('id', clientId);
        }
    }

    const updateData = {
        cost_basis: newPrice * newQty,
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

    const { error } = await supabaseClient
        .from('holdings')
        .update(updateData)
        .eq('id', holdingId);

    if (error) { console.error('supaEditHolding:', error.message); return null; }

    // Log edit action (best-effort, don't break if DB constraints reject it)
    try {
        const editChanges = [];
        if (newQty !== h.shares) editChanges.push(`כמות: ${h.shares} → ${newQty}`);
        if (Math.abs(newPrice - (h.cost_basis / h.shares)) > 0.01) editChanges.push(`מחיר: ${(h.cost_basis / h.shares).toFixed(2)} → ${newPrice.toFixed(2)}`);
        await supaLogTransaction(clientId, {
            type: 'edit_holding',
            ticker: h.ticker,
            name: h.name,
            asset_type: h.type,
            shares: newQty,
            price: newPrice,
            total: newPrice * newQty,
            description: editChanges.join(', ')
        });
    } catch (e) { console.warn('Edit holding log failed:', e.message); }

    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}

async function supaRemoveHolding(clientId, holdingId) {
    // Fetch the holding to calculate sale proceeds
    const { data: holding, error: hErr } = await supabaseClient
        .from('holdings')
        .select('*')
        .eq('id', holdingId)
        .single();

    if (hErr || !holding) { console.error('supaRemoveHolding fetch:', hErr?.message); return null; }

    const saleProceeds = holding.shares * holding.price;

    // Get current cash balance and add sale proceeds
    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_balance')
        .eq('id', clientId)
        .single();

    if (!pErr && portfolio) {
        await supabaseClient
            .from('portfolios')
            .update({ cash_balance: (portfolio.cash_balance || 0) + saleProceeds })
            .eq('id', clientId);
    }

    // Log sell transaction
    await supaLogTransaction(clientId, {
        type: 'sell',
        ticker: holding.ticker,
        name: holding.name,
        asset_type: holding.type,
        shares: holding.shares,
        price: holding.price,
        total: saleProceeds
    });

    // Delete the holding
    const { error } = await supabaseClient
        .from('holdings')
        .delete()
        .eq('id', holdingId);

    if (error) { console.error('supaRemoveHolding:', error.message); return null; }

    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}

// ========== RECALCULATE CLIENT TOTALS ==========

async function supaRecalcClient(clientId) {
    const { data: holdings, error } = await supabaseClient
        .from('holdings')
        .select('*')
        .eq('portfolio_id', clientId);

    if (error) return;

    // Get current cash balance
    const { data: portfolio } = await supabaseClient
        .from('portfolios')
        .select('cash_balance')
        .eq('id', clientId)
        .single();

    const cashBalance = portfolio?.cash_balance || 0;

    let holdingsValue = 0;
    holdings.forEach(h => { holdingsValue += h.shares * h.price; });

    const totalValue = holdingsValue + cashBalance;

    // Update each holding's value + allocation (allocation based on total including cash)
    for (const h of holdings) {
        const value = h.shares * h.price;
        const allocationPct = totalValue > 0 ? (value / totalValue * 100) : 0;
        await supabaseClient
            .from('holdings')
            .update({ value, allocation_pct: allocationPct })
            .eq('id', h.id);
    }

    // Update portfolio totals
    let stockPct = 0, bondPct = 0;
    if (totalValue > 0) {
        holdings.forEach(h => {
            const pct = (h.shares * h.price) / totalValue * 100;
            if (h.type === 'stock') stockPct += pct;
            else bondPct += pct;
        });
    }

    const initialInvestment = holdings.reduce((s, h) => s + h.cost_basis, 0) + cashBalance;

    // Dynamic risk level based on actual stock allocation
    let risk, riskLabel;
    if (stockPct > 70) { risk = 'high'; riskLabel = 'גבוה'; }
    else if (stockPct >= 40) { risk = 'medium'; riskLabel = 'בינוני'; }
    else { risk = 'low'; riskLabel = 'נמוך'; }

    await supabaseClient
        .from('portfolios')
        .update({
            portfolio_value: totalValue,
            initial_investment: initialInvestment,
            stock_pct: stockPct,
            bond_pct: bondPct,
            risk,
            risk_label: riskLabel
        })
        .eq('id', clientId);
}

// ========== PERFORMANCE HISTORY SNAPSHOT ==========

// Records a daily snapshot of portfolio value for chart display.
// Called after price refresh — max 1 snapshot per day per portfolio.
async function supaRecordPerformanceSnapshot(clientId) {
    try {
        const { data: portfolio } = await supabaseClient
            .from('portfolios')
            .select('portfolio_value, initial_investment, performance_history')
            .eq('id', clientId)
            .single();

        if (!portfolio || !portfolio.portfolio_value) return;

        const history = portfolio.performance_history || [];
        const now = new Date();
        const dateStr = now.toLocaleDateString('he-IL'); // DD.MM.YYYY format

        // Skip if we already have a snapshot for today
        if (history.length > 0 && history[history.length - 1].date === dateStr) return;

        const costBasis = portfolio.initial_investment || 1;
        const returnPct = ((portfolio.portfolio_value - costBasis) / costBasis) * 100;

        const snapshot = {
            date: dateStr,
            value: portfolio.portfolio_value,
            returnPct: parseFloat(returnPct.toFixed(2)),
            year: now.getFullYear(),
            month: now.getMonth(),
            yearLabel: now.getFullYear().toString(),
            monthLabel: now.toLocaleDateString('he-IL', { month: 'short', year: 'numeric' })
        };

        history.push(snapshot);

        // Keep max 1825 points (~5 years of daily data)
        if (history.length > 1825) history.splice(0, history.length - 1825);

        await supabaseClient
            .from('portfolios')
            .update({ performance_history: history })
            .eq('id', clientId);
    } catch (e) {
        console.warn('supaRecordPerformanceSnapshot error:', e.message);
    }
}

// ========== TRANSACTION LOG (localStorage primary, Supabase optional) ==========

// Flag: set to false once we detect the transactions table doesn't exist
let _supaTransactionsAvailable = true;

function _localTxKey(portfolioId) {
    return `portfolio_transactions_${portfolioId}`;
}

function _saveTransactionLocal(portfolioId, txRecord) {
    try {
        const key = _localTxKey(portfolioId);
        const existing = JSON.parse(localStorage.getItem(key) || '[]');
        existing.unshift(txRecord);
        if (existing.length > 500) existing.length = 500;
        localStorage.setItem(key, JSON.stringify(existing));
    } catch (e) {
        console.warn('_saveTransactionLocal error:', e);
    }
}

function _getLocalTransactions(portfolioId) {
    try {
        const key = _localTxKey(portfolioId);
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch (e) {
        return [];
    }
}

async function supaLogTransaction(portfolioId, txData) {
    // Build transaction record
    const record = {
        id: 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        portfolio_id: portfolioId,
        created_at: new Date().toISOString(),
        type: txData.type,
        ticker: txData.ticker || '-',
        name: txData.name || '',
        asset_type: txData.asset_type || 'stock',
        shares: txData.shares ?? 0,
        price: txData.price ?? 0,
        total: txData.total ?? 0,
        realized_pnl: txData.realized_pnl ?? null,
        description: txData.description || null
    };

    // Always save to localStorage (primary storage — works instantly)
    _saveTransactionLocal(portfolioId, record);

    // Also try Supabase if the table is available (optional, silent)
    if (_supaTransactionsAvailable) {
        try {
            const { error } = await supabaseClient
                .from('transactions')
                .insert({
                    portfolio_id: portfolioId,
                    type: txData.type,
                    ticker: txData.ticker || '-',
                    name: txData.name || '',
                    asset_type: txData.asset_type || 'stock',
                    shares: txData.shares ?? 0,
                    price: txData.price ?? 0,
                    total: txData.total ?? 0
                });

            if (error) {
                // If table doesn't exist, disable further Supabase attempts this session
                if (error.message && error.message.includes('transactions')) {
                    _supaTransactionsAvailable = false;
                    console.log('Transactions table not found in Supabase — using localStorage for this session.');
                }
            }
        } catch (e) {
            // Silent — localStorage already has the data
        }
    }
}

async function supaFetchTransactions(portfolioId) {
    // Primary: localStorage (always available, always has data)
    const localTx = _getLocalTransactions(portfolioId).map(mapTransaction);

    // If Supabase transactions table is available, try to merge
    if (_supaTransactionsAvailable) {
        try {
            const { data, error } = await supabaseClient
                .from('transactions')
                .select('*')
                .eq('portfolio_id', portfolioId)
                .order('created_at', { ascending: false });

            if (error) {
                if (error.message && error.message.includes('transactions')) {
                    _supaTransactionsAvailable = false;
                }
                return localTx;
            }

            if (data && data.length > 0) {
                const supaTx = data.map(mapTransaction);
                // Merge: Supabase + local-only (deduplicate by type+ticker+time proximity)
                const merged = [...supaTx];
                for (const lt of localTx) {
                    const isDuplicate = supaTx.some(st =>
                        st.type === lt.type &&
                        st.ticker === lt.ticker &&
                        Math.abs(st.date.getTime() - lt.date.getTime()) < 5000
                    );
                    if (!isDuplicate) merged.push(lt);
                }
                merged.sort((a, b) => b.date.getTime() - a.date.getTime());
                return merged;
            }
        } catch (e) {
            // Silent fallback to localStorage
        }
    }

    return localTx;
}

function mapTransaction(t) {
    return {
        id: t.id,
        portfolioId: t.portfolio_id,
        date: new Date(t.created_at),
        type: t.type,
        ticker: t.ticker || '-',
        name: t.name || '',
        assetType: t.asset_type || '',
        shares: t.shares || 0,
        price: t.price || 0,
        total: t.total || 0,
        realizedPnl: t.realized_pnl || null,
        description: t.description || null
    };
}

// ========== SELL HOLDING (partial or full) ==========

async function supaSellHolding(clientId, holdingId, sellQty, sellPrice) {
    // Fetch the holding
    const { data: h, error: hErr } = await supabaseClient
        .from('holdings')
        .select('*')
        .eq('id', holdingId)
        .single();

    if (hErr || !h) { console.error('supaSellHolding fetch:', hErr?.message); return null; }

    if (sellQty > h.shares) { console.error('Cannot sell more than owned'); return null; }

    // Use user-entered sell price, fallback to current market price
    const actualSellPrice = sellPrice || h.price;
    const saleProceeds = sellQty * actualSellPrice;

    // Calculate realized P&L based on weighted average cost
    const avgCostPerShare = h.cost_basis / h.shares;
    const realizedPnL = (actualSellPrice - avgCostPerShare) * sellQty;

    // Add sale proceeds to cash_balance
    const { data: portfolio } = await supabaseClient
        .from('portfolios')
        .select('cash_balance')
        .eq('id', clientId)
        .single();

    if (portfolio) {
        await supabaseClient
            .from('portfolios')
            .update({ cash_balance: (portfolio.cash_balance || 0) + saleProceeds })
            .eq('id', clientId);
    }

    // Log sell transaction (includes realized P&L)
    await supaLogTransaction(clientId, {
        type: 'sell', ticker: h.ticker, name: h.name, asset_type: h.type,
        shares: sellQty, price: actualSellPrice, total: saleProceeds,
        realized_pnl: realizedPnL
    });

    if (sellQty === h.shares) {
        // Full sell — delete the holding
        await supabaseClient.from('holdings').delete().eq('id', holdingId);
    } else {
        // Partial sell — reduce shares, keep weighted avg cost
        const remainingShares = h.shares - sellQty;
        await supabaseClient
            .from('holdings')
            .update({
                shares: remainingShares,
                cost_basis: avgCostPerShare * remainingShares,
                value: h.price * remainingShares
            })
            .eq('id', holdingId);
    }

    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}

