// ========== PORTFOLIO - Buy/Sell/Deposit Business Logic ==========

// ========== BUY ASSET ==========
// Validates cash balance, deducts from cash, creates holding

async function portfolioBuyAsset(clientId, holdingData) {
    if (!supabaseConnected) return null;

    const currency = holdingData.currency || 'USD';
    const cashCol = (currency === 'ILS') ? 'cash_ils' : 'cash_usd';

    // Fetch current cash balances
    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_usd, cash_ils')
        .eq('id', clientId)
        .single();

    if (pErr || !portfolio) {
        console.error('portfolioBuyAsset: failed to fetch portfolio', pErr?.message);
        return { error: 'fetch_failed' };
    }

    const availableInBucket = portfolio[cashCol] || 0;
    const totalCost = holdingData.price * holdingData.quantity;

    // Check sufficient funds in the correct currency bucket
    if (totalCost > availableInBucket) {
        return { error: 'insufficient_cash', available: availableInBucket, required: totalCost };
    }

    // Deduct from correct currency bucket
    const prevCashUsd = portfolio.cash_usd || 0;
    const prevCashIls = portfolio.cash_ils || 0;
    const newCashInBucket = availableInBucket - totalCost;
    const totalCash = prevCashUsd + prevCashIls - totalCost;
    const { error: updateErr } = await supabaseClient
        .from('portfolios')
        .update({ [cashCol]: newCashInBucket, cash_balance: totalCash })
        .eq('id', clientId);

    if (updateErr) {
        console.error('portfolioBuyAsset: failed to deduct cash', updateErr.message);
        return { error: 'update_failed' };
    }

    // Create the holding (supaAddHolding handles insert + transaction log + recalc)
    const updated = await supaAddHolding(clientId, holdingData);

    // If holding creation failed, rollback the cash deduction
    if (!updated) {
        console.error('portfolioBuyAsset: supaAddHolding failed — rolling back cash deduction');
        await supabaseClient
            .from('portfolios')
            .update({ [cashCol]: availableInBucket, cash_balance: prevCashUsd + prevCashIls })
            .eq('id', clientId);
        return { error: 'insert_failed' };
    }

    // Invalidate synthetic history cache — holdings changed, backfill data is stale
    if (typeof invalidateSyntheticCache === 'function') invalidateSyntheticCache(clientId);

    return updated;
}

// ========== SELL ASSET ==========
// Wrapper around supaSellHolding (already handles cash addition)

async function portfolioSellAsset(clientId, holdingId, sellQty) {
    if (!supabaseConnected) return null;
    const result = await supaSellHolding(clientId, holdingId, sellQty);

    // Invalidate synthetic history cache — holdings changed, backfill data is stale
    if (typeof invalidateSyntheticCache === 'function') invalidateSyntheticCache(clientId);

    return result;
}

// ========== DEPOSIT CASH ==========
// Add external money to portfolio cash balance

async function portfolioDepositCash(clientId, amount, currency = 'USD') {
    if (!supabaseConnected) return null;
    if (!amount || amount <= 0) return null;

    const cashCol = (currency === 'ILS') ? 'cash_ils' : 'cash_usd';

    // Fetch current values
    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_usd, cash_ils, portfolio_value, initial_investment')
        .eq('id', clientId)
        .single();

    if (pErr || !portfolio) {
        console.error('portfolioDepositCash: failed to fetch portfolio', pErr?.message);
        return null;
    }

    const newCashInBucket = (portfolio[cashCol] || 0) + amount;
    const totalCash = (portfolio.cash_usd || 0) + (portfolio.cash_ils || 0) + amount;
    const newPortfolioValue = (portfolio.portfolio_value || 0) + amount;
    const newInitialInvestment = (portfolio.initial_investment || 0) + amount;

    // Update portfolio
    const { error: updateErr } = await supabaseClient
        .from('portfolios')
        .update({
            [cashCol]: newCashInBucket,
            cash_balance: totalCash,
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
        name: currency === 'ILS' ? 'הפקדת מזומן (ILS)' : 'הפקדת מזומן (USD)',
        asset_type: 'cash',
        shares: 1,
        price: amount,
        total: amount
    });

    // Invalidate synthetic history cache — cash balance changed
    if (typeof invalidateSyntheticCache === 'function') invalidateSyntheticCache(clientId);

    // Recalculate allocations
    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}

// ========== WITHDRAW CASH ==========
// Remove money from portfolio cash balance

async function portfolioWithdrawCash(clientId, amount, currency = 'USD') {
    if (!supabaseConnected) return null;
    if (!amount || amount <= 0) return null;

    const cashCol = (currency === 'ILS') ? 'cash_ils' : 'cash_usd';

    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_usd, cash_ils, portfolio_value, initial_investment')
        .eq('id', clientId)
        .single();

    if (pErr || !portfolio) return null;

    const availableInBucket = portfolio[cashCol] || 0;
    if (amount > availableInBucket) return { error: 'insufficient_cash' };

    const newCashInBucket = availableInBucket - amount;
    const totalCash = (portfolio.cash_usd || 0) + (portfolio.cash_ils || 0) - amount;

    const { error: updateErr } = await supabaseClient
        .from('portfolios')
        .update({
            [cashCol]: newCashInBucket,
            cash_balance: totalCash,
            portfolio_value: (portfolio.portfolio_value || 0) - amount,
            initial_investment: (portfolio.initial_investment || 0) - amount
        })
        .eq('id', clientId);

    if (updateErr) return null;

    await supaLogTransaction(clientId, {
        type: 'withdraw',
        ticker: 'CASH',
        name: currency === 'ILS' ? 'משיכת מזומן (ILS)' : 'משיכת מזומן (USD)',
        asset_type: 'cash',
        shares: 1,
        price: amount,
        total: amount
    });

    // Invalidate synthetic history cache — cash balance changed
    if (typeof invalidateSyntheticCache === 'function') invalidateSyntheticCache(clientId);

    await supaRecalcClient(clientId);
    return await supaFetchClient(clientId);
}
