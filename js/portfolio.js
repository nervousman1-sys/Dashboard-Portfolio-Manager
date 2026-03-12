// ========== PORTFOLIO - Buy/Sell/Deposit Business Logic ==========

// ========== BUY ASSET ==========
// Validates cash balance, deducts from cash, creates holding

async function portfolioBuyAsset(clientId, holdingData) {
    if (!supabaseConnected) return null;

    // Fetch current cash balance
    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_balance')
        .eq('id', clientId)
        .single();

    if (pErr || !portfolio) {
        console.error('portfolioBuyAsset: failed to fetch portfolio', pErr?.message);
        return { error: 'fetch_failed' };
    }

    const cashBalance = portfolio.cash_balance || 0;
    const totalCost = holdingData.price * holdingData.quantity;

    // Check sufficient funds
    if (totalCost > cashBalance) {
        return { error: 'insufficient_cash', available: cashBalance, required: totalCost };
    }

    // Deduct cash balance
    const { error: updateErr } = await supabaseClient
        .from('portfolios')
        .update({ cash_balance: cashBalance - totalCost })
        .eq('id', clientId);

    if (updateErr) {
        console.error('portfolioBuyAsset: failed to deduct cash', updateErr.message);
        return { error: 'update_failed' };
    }

    // Create the holding (supaAddHolding handles insert + transaction log + recalc)
    const updated = await supaAddHolding(clientId, holdingData);
    return updated;
}

// ========== SELL ASSET ==========
// Wrapper around supaSellHolding (already handles cash addition)

async function portfolioSellAsset(clientId, holdingId, sellQty) {
    if (!supabaseConnected) return null;
    return await supaSellHolding(clientId, holdingId, sellQty);
}

// ========== DEPOSIT CASH ==========
// Add external money to portfolio cash balance

async function portfolioDepositCash(clientId, amount) {
    if (!supabaseConnected) return null;
    if (!amount || amount <= 0) return null;

    // Fetch current values
    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_balance, portfolio_value, initial_investment')
        .eq('id', clientId)
        .single();

    if (pErr || !portfolio) {
        console.error('portfolioDepositCash: failed to fetch portfolio', pErr?.message);
        return null;
    }

    const newCash = (portfolio.cash_balance || 0) + amount;
    const newPortfolioValue = (portfolio.portfolio_value || 0) + amount;
    const newInitialInvestment = (portfolio.initial_investment || 0) + amount;

    // Update portfolio
    const { error: updateErr } = await supabaseClient
        .from('portfolios')
        .update({
            cash_balance: newCash,
            portfolio_value: newPortfolioValue,
            initial_investment: newInitialInvestment
        })
        .eq('id', clientId);

    if (updateErr) {
        console.error('portfolioDepositCash: update failed', updateErr.message);
        return null;
    }

    // Log deposit transaction
    await supaLogTransaction(clientId, {
        type: 'deposit',
        ticker: 'CASH',
        name: 'הפקדת מזומן',
        asset_type: 'cash',
        shares: 1,
        price: amount,
        total: amount
    });

    // Recalculate allocations
    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}

// ========== WITHDRAW CASH ==========
// Remove money from portfolio cash balance

async function portfolioWithdrawCash(clientId, amount) {
    if (!supabaseConnected) return null;
    if (!amount || amount <= 0) return null;

    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_balance, portfolio_value, initial_investment')
        .eq('id', clientId)
        .single();

    if (pErr || !portfolio) return null;

    const cashBalance = portfolio.cash_balance || 0;
    if (amount > cashBalance) return { error: 'insufficient_cash' };

    const { error: updateErr } = await supabaseClient
        .from('portfolios')
        .update({
            cash_balance: cashBalance - amount,
            portfolio_value: (portfolio.portfolio_value || 0) - amount,
            initial_investment: (portfolio.initial_investment || 0) - amount
        })
        .eq('id', clientId);

    if (updateErr) return null;

    await supaLogTransaction(clientId, {
        type: 'withdraw',
        ticker: 'CASH',
        name: 'משיכת מזומן',
        asset_type: 'cash',
        shares: 1,
        price: amount,
        total: amount
    });

    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}
