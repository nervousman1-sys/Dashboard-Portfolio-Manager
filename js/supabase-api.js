// ========== SUPABASE API - CRUD Operations via Supabase ==========

// Risk profile mappings
const RISK_LABELS_MAP = { high: 'גבוה', medium: 'בינוני', low: 'נמוך' };
const RISK_STOCK_PCT_MAP = { high: 80, medium: 50, low: 15 };
const RISK_BOND_PCT_MAP = { high: 20, medium: 50, low: 85 };

// ========== HELPER: map DB row (snake_case) to frontend object (camelCase) ==========

function _inferAssetClass(type) {
    if (type === 'bond') return 'Gov Bond';
    return 'Stock';
}

function mapPortfolio(p) {
    // Legacy fallback: ?? only handles null/undefined, NOT 0.
    // If DB migration added cash_usd column with DEFAULT 0, existing rows have cash_usd=0
    // even though cash_balance has the real value. Detect this and migrate in-memory.
    let cashUsd = p.cash_usd ?? 0;
    let cashIls = p.cash_ils ?? 0;
    if (cashUsd === 0 && cashIls === 0 && (p.cash_balance || 0) > 0) {
        cashUsd = p.cash_balance;  // Legacy data: treat all cash_balance as USD
    }
    return {
        id: p.id,
        name: p.name,
        risk: p.risk,
        riskLabel: p.risk_label,
        stockPct: p.stock_pct,
        bondPct: p.bond_pct,
        portfolioValue: p.portfolio_value,
        initialInvestment: p.initial_investment,
        cash: { usd: cashUsd, ils: cashIls },
        cashBalance: cashUsd + cashIls,  // backward compat — total across currencies
        performanceHistory: p.performance_history || [],
        holdings: (p.holdings || []).map(mapHolding)
    };
}

function mapHolding(h) {
    // Detect if the price stored in DB is just the purchase price (no live API data).
    // This happens when supaAddHolding couldn't fetch a live price and used the purchase price as placeholder.
    const purchasePrice = (h.cost_basis && h.shares > 0) ? h.cost_basis / h.shares : 0;
    const priceMatchesPurchase = purchasePrice > 0 && Math.abs(h.price - purchasePrice) < 0.01;

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
        currency: h.currency,
        assetClass: h.asset_class || _inferAssetClass(h.type),
        bondType: h.bond_type || null,
        _livePriceResolved: (h.type !== 'stock') || !priceMatchesPurchase
    };
}

// ========== FETCH ALL CLIENTS ==========

async function supaFetchClients() {
    // Use cached user ID from auth flow to avoid extra network call
    let userId = _cachedUserId || getCachedUserId();

    // Fallback: fetch from Supabase only if no cached ID
    if (!userId) {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return [];
        userId = user.id;
        _cachedUserId = userId;
    }

    const { data, error } = await supabaseClient
        .from('portfolios')
        .select('*, holdings(*)')
        .eq('user_id', userId)
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

async function supaAddClient(name, cashUsd = 0, cashIls = 0) {
    console.log('supaAddClient: starting, name=', name, 'cashUsd=', cashUsd, 'cashIls=', cashIls);

    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser();
    if (authErr) { console.error('supaAddClient: auth error:', authErr.message); return null; }
    if (!user) { console.error('supaAddClient: no user session'); return null; }

    const totalCash = cashUsd + cashIls;

    // New portfolio starts with only cash → 0% stocks → risk = low
    // Seed performance_history with an initial snapshot so charts have a starting point
    const now = new Date();
    const initialSnapshot = totalCash > 0 ? [{
        date: now.toLocaleDateString('he-IL'),
        value: totalCash,
        returnPct: 0,
        year: now.getFullYear(),
        month: now.getMonth(),
        yearLabel: now.getFullYear().toString(),
        monthLabel: now.toLocaleDateString('he-IL', { month: 'short', year: 'numeric' })
    }] : [];

    const insertPayload = {
        user_id: user.id,
        name,
        risk: 'low',
        risk_label: 'נמוך',
        stock_pct: 0,
        bond_pct: 0,
        portfolio_value: totalCash,
        initial_investment: totalCash,
        cash_balance: totalCash,
        cash_usd: cashUsd,
        cash_ils: cashIls,
        performance_history: initialSnapshot
    };
    console.table(insertPayload);

    const { data, error } = await supabaseClient
        .from('portfolios')
        .insert(insertPayload)
        .select('*, holdings(*)')
        .single();

    if (error) {
        console.error('supaAddClient INSERT failed:', error.message, '| code:', error.code, '| details:', error.details);
        // If cash_usd/cash_ils columns don't exist yet, retry without them
        if (error.message && error.message.includes('cash_usd')) {
            console.warn('supaAddClient: cash_usd column missing — retrying without currency columns');
            delete insertPayload.cash_usd;
            delete insertPayload.cash_ils;
            insertPayload.cash_balance = totalCash;
            const retry = await supabaseClient
                .from('portfolios')
                .insert(insertPayload)
                .select('*, holdings(*)')
                .single();
            if (retry.error) { console.error('supaAddClient retry failed:', retry.error.message); return null; }
            console.log('supaAddClient: retry succeeded (without currency columns)');
            return mapPortfolio(retry.data);
        }
        return null;
    }
    console.log('supaAddClient: success, id=', data.id);
    return mapPortfolio(data);
}

// Create portfolio with initial holdings in one go (BATCH optimized)
// ZERO external API calls during creation — uses purchase price as placeholder.
// Live prices are fetched AFTER creation by the normal updatePricesFromAPI cycle.
// Total: 1 portfolio insert + 1 bulk holdings insert + 1 recalc + 1 fetch = ~5 Supabase calls
async function supaAddClientWithHoldings(name, cashUsd, cashIls, holdings, onProgress) {
    const TYPE_LABELS = { stock: 'מניה', bond: 'אג"ח', fund: 'קרן נאמנות' };

    // --- Step 1: Create the empty portfolio shell (1 Supabase call) ---
    if (onProgress) onProgress('יוצר תיק...');
    const portfolio = await supaAddClient(name, cashUsd, cashIls);
    if (!portfolio) return null;

    const totalCash = cashUsd + cashIls;

    // --- Step 2: Build all holding rows in memory (NO API calls) ---
    if (onProgress) onProgress(`מכין ${holdings.length} נכסים...`);

    // Use only the in-memory priceCache (already populated from dashboard).
    // If a ticker isn't cached, use purchase price as placeholder.
    // The post-creation price refresh will update them within seconds.
    const aggregated = new Map();
    let totalHoldingsCost = 0;

    for (const h of holdings) {
        const type = h.type || 'stock';
        const isStock = type === 'stock' || type === 'fund';
        const rawTicker = (h.ticker || '').toUpperCase().trim();
        const ticker = isStock
            ? rawTicker
            : (rawTicker || ('BOND_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)));
        const isIsraeli = h.currency === 'ILS' || h.currency === 'ILA'
            || rawTicker.endsWith('.TA') || /^\d{7,9}$/.test(rawTicker);
        const currency = isIsraeli ? 'ILS' : (h.currency || (isStock ? 'USD' : 'ILS'));

        // Check in-memory cache only (instant, no network)
        const cached = (typeof priceCache !== 'undefined') ? priceCache[ticker] : null;
        const currentPrice = (cached && cached.price) ? cached.price : h.price;
        const previousClose = (cached && cached.previousClose) ? cached.previousClose : h.price;
        const costBasis = h.price * h.quantity;
        totalHoldingsCost += costBasis;

        if (aggregated.has(ticker)) {
            const existing = aggregated.get(ticker);
            existing.shares += h.quantity;
            existing.cost_basis += costBasis;
            existing.value = currentPrice * existing.shares;
        } else {
            aggregated.set(ticker, {
                portfolio_id: portfolio.id,
                ticker,
                name: isStock ? (h.stockName || ticker) : ((h.bondName || '').trim()),
                type,
                type_label: TYPE_LABELS[type] || type,
                sector: (type === 'stock') ? (SECTOR_MAP[ticker] || SECTOR_MAP[ticker.replace('.TA', '')] || 'Other') : null,
                allocation_pct: 0,
                value: currentPrice * h.quantity,
                cost_basis: costBasis,
                shares: h.quantity,
                price: currentPrice,
                previous_close: previousClose,
                currency,
                asset_class: h.assetClass || _inferAssetClass(type),
                bond_type: h.bondType || null
            });
        }
    }

    const holdingRows = Array.from(aggregated.values());

    // --- Step 3: SINGLE bulk insert for all holdings (1 Supabase call) ---
    if (onProgress) onProgress('שומר נכסים...');
    const { error: bulkErr } = await supabaseClient
        .from('holdings')
        .insert(holdingRows);

    if (bulkErr) {
        console.error('supaAddClientWithHoldings bulk insert failed:', bulkErr.message);
        await supabaseClient.from('portfolios').delete().eq('id', portfolio.id);
        return null;
    }

    // --- Step 4: Bulk-log all buy transactions ---
    const txRows = holdingRows.map(row => ({
        portfolio_id: portfolio.id,
        type: 'buy',
        ticker: row.ticker,
        name: row.name,
        asset_type: row.type,
        shares: row.shares,
        price: row.cost_basis / row.shares,
        total: row.cost_basis
    }));

    // localStorage logs (instant, no network)
    txRows.forEach(tx => {
        _saveTransactionLocal(portfolio.id, {
            id: 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            portfolio_id: portfolio.id,
            created_at: new Date().toISOString(),
            ...tx
        });
    });

    // Supabase transaction log (fire-and-forget, don't block creation)
    if (_supaTransactionsAvailable) {
        supabaseClient.from('transactions').insert(txRows).then(({ error }) => {
            if (error && error.message && error.message.includes('transactions')) {
                _supaTransactionsAvailable = false;
            }
        });
    }

    // --- Step 5: Finalize — update totals + recalc + snapshot (3 Supabase calls) ---
    if (onProgress) onProgress('מחשב תיק...');
    const totalInvestment = totalCash + totalHoldingsCost;
    await supabaseClient
        .from('portfolios')
        .update({ initial_investment: totalInvestment })
        .eq('id', portfolio.id);

    await supaRecalcClient(portfolio.id);
    await supaRecordPerformanceSnapshot(portfolio.id);
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

    // --- Detect Israeli security (7-9 digit numeric, .TA suffix, or ILS currency) ---
    const tickerUpper = (rawTicker || '').toUpperCase().trim();
    const isIsraeliNumeric = /^\d{7,9}$/.test(tickerUpper);
    const isIsraeli = holdingData.currency === 'ILS' || holdingData.currency === 'ILA'
        || tickerUpper.endsWith('.TA') || tickerUpper.endsWith('.TASE')
        || isIsraeliNumeric;

    if (type === 'stock' || type === 'fund') {
        holdingTicker = tickerUpper;
        name = holdingData.stockName || holdingTicker;
        sector = type === 'stock' ? (SECTOR_MAP[holdingTicker] || (SECTOR_MAP[holdingTicker.replace('.TA', '')] || 'Other')) : null;
        currency = isIsraeli ? 'ILS' : (holdingData.currency || 'USD');

        // Use real market price from priceCache if available, otherwise fetch live
        let cached = (typeof priceCache !== 'undefined') ? priceCache[holdingTicker] : null;

        // If priceCache is empty for this ticker (e.g. brand-new user), fetch live
        // Pass currency so fetchSingleTickerPrice can detect Israeli assets correctly
        if ((!cached || !cached.price) && typeof fetchSingleTickerPrice === 'function') {
            try {
                cached = await fetchSingleTickerPrice(holdingTicker, currency);
            } catch (e) {
                console.warn('[supaAddHolding] Live price fetch failed for', holdingTicker, e.message);
            }
        }

        if (cached && cached.price) {
            currentPrice = cached.price;
            previousClose = cached.previousClose || cached.price;
        } else {
            currentPrice = price;
            previousClose = price;
            console.warn(`[supaAddHolding] No live price for ${holdingTicker} — using purchase price as placeholder`);
        }
    } else {
        // --- BOND: use the actual rawTicker (not BOND_timestamp) so we can match for aggregation ---
        holdingTicker = tickerUpper || ('BOND_' + Date.now());
        name = (bondName || '').trim() || holdingData.stockName || holdingTicker;
        sector = null;
        currency = isIsraeli ? 'ILS' : (holdingData.currency || 'ILS');

        // Try to fetch a live bond price via Yahoo Finance
        let cached = (typeof priceCache !== 'undefined') ? priceCache[holdingTicker] : null;
        if ((!cached || !cached.price) && typeof fetchSingleTickerPrice === 'function') {
            try {
                cached = await fetchSingleTickerPrice(holdingTicker, currency, price);
            } catch (e) {
                console.warn('[supaAddHolding] Bond price fetch failed for', holdingTicker, e.message);
            }
        }

        if (cached && cached.price && !cached.unavailable) {
            currentPrice = cached.price;
            previousClose = cached.previousClose || cached.price;
        } else {
            currentPrice = price;
            previousClose = price;
        }
    }

    // Bond sub-type (government / corporate) — auto-detected by classifyAsset
    const bondType = holdingData.bondType || null;

    const costBasis = price * quantity;

    // --- Aggregation: check if same ticker already exists in portfolio ---
    const { data: existing } = await supabaseClient
        .from('holdings')
        .select('*')
        .eq('portfolio_id', clientId)
        .eq('ticker', holdingTicker)
        .single();

    if (existing) {
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

        await supaLogTransaction(clientId, {
            type: 'buy', ticker: holdingTicker, name, asset_type: type,
            shares: quantity, price, total: costBasis
        });

        await supaRecalcClient(clientId);
        return await supaFetchClient(clientId);
    }

    // --- New holding — insert fresh row ---
    const value = currentPrice * quantity;

    const assetClass = holdingData.assetClass || _inferAssetClass(type);

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
            currency,
            asset_class: assetClass,
            bond_type: bondType
        });

    if (error) { console.error('supaAddHolding:', error.message); return null; }

    await supaLogTransaction(clientId, {
        type: 'buy', ticker: holdingTicker, name, asset_type: type,
        shares: quantity, price, total: costBasis
    });

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

    // If quantity decreased, transfer sale proceeds to correct currency cash bucket
    if (newQty < h.shares) {
        const soldShares = h.shares - newQty;
        const saleProceeds = soldShares * h.price;
        const cashCol = (h.currency === 'ILS') ? 'cash_ils' : 'cash_usd';

        const { data: portfolio } = await supabaseClient
            .from('portfolios')
            .select('cash_usd, cash_ils')
            .eq('id', clientId)
            .single();

        if (portfolio) {
            const newCashInBucket = (portfolio[cashCol] || 0) + saleProceeds;
            const totalCash = (portfolio.cash_usd || 0) + (portfolio.cash_ils || 0) + saleProceeds;
            await supabaseClient
                .from('portfolios')
                .update({ [cashCol]: newCashInBucket, cash_balance: totalCash })
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
    const cashCol = (holding.currency === 'ILS') ? 'cash_ils' : 'cash_usd';

    // Get current cash balances and add sale proceeds to correct currency bucket
    const { data: portfolio, error: pErr } = await supabaseClient
        .from('portfolios')
        .select('cash_usd, cash_ils')
        .eq('id', clientId)
        .single();

    if (!pErr && portfolio) {
        const newCashInBucket = (portfolio[cashCol] || 0) + saleProceeds;
        const totalCash = (portfolio.cash_usd || 0) + (portfolio.cash_ils || 0) + saleProceeds;
        await supabaseClient
            .from('portfolios')
            .update({ [cashCol]: newCashInBucket, cash_balance: totalCash })
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
    // Fetch holdings + portfolio cash in parallel (2 queries instead of sequential)
    const [holdingsRes, portfolioRes] = await Promise.all([
        supabaseClient.from('holdings').select('*').eq('portfolio_id', clientId),
        supabaseClient.from('portfolios').select('cash_usd, cash_ils').eq('id', clientId).single()
    ]);

    if (holdingsRes.error) return;
    const holdings = holdingsRes.data;
    const cashUsd = portfolioRes.data?.cash_usd ?? 0;
    const cashIls = portfolioRes.data?.cash_ils ?? 0;

    // FX-aware valuation: convert all holdings + cash to display currency (USD)
    const displayCurrency = 'USD';
    let holdingsValue = 0;
    holdings.forEach(h => {
        const currency = h.currency || 'USD';
        const nativeValue = h.shares * h.price;
        const fxRate = (typeof getFxRate === 'function') ? getFxRate(currency, displayCurrency) : 1;
        holdingsValue += nativeValue * fxRate;
    });

    // Convert cash buckets to display currency
    const cashUsdConverted = (typeof convertToDisplayCurrency === 'function')
        ? convertToDisplayCurrency(cashUsd, 'USD', displayCurrency) : cashUsd;
    const cashIlsConverted = (typeof convertToDisplayCurrency === 'function')
        ? convertToDisplayCurrency(cashIls, 'ILS', displayCurrency) : cashIls;
    const totalCashConverted = cashUsdConverted + cashIlsConverted;

    const totalValue = holdingsValue + totalCashConverted;

    // Update all holdings in parallel (not one-by-one)
    // Store native-currency value in DB (value column), allocation uses FX-converted total
    await Promise.all(holdings.map(h => {
        const nativeValue = h.shares * h.price;
        const currency = h.currency || 'USD';
        const fxRate = (typeof getFxRate === 'function') ? getFxRate(currency, displayCurrency) : 1;
        const convertedValue = nativeValue * fxRate;
        const allocationPct = totalValue > 0 ? (convertedValue / totalValue * 100) : 0;
        return supabaseClient
            .from('holdings')
            .update({ value: nativeValue, allocation_pct: allocationPct })
            .eq('id', h.id);
    }));

    // Calculate portfolio totals
    let stockPct = 0, bondPct = 0;
    if (totalValue > 0) {
        holdings.forEach(h => {
            const nativeValue = h.shares * h.price;
            const currency = h.currency || 'USD';
            const fxRate = (typeof getFxRate === 'function') ? getFxRate(currency, displayCurrency) : 1;
            const pct = (nativeValue * fxRate) / totalValue * 100;
            if (h.type === 'stock') stockPct += pct;
            else bondPct += pct;
        });
    }

    const totalCash = cashUsd + cashIls; // Raw sum for cash_balance column (backward compat)
    const initialInvestment = holdings.reduce((s, h) => s + h.cost_basis, 0) + totalCash;

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
            cash_balance: totalCash,
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

// Flag: set to false since the Supabase 'transactions' table doesn't exist.
// Transactions are stored in localStorage only — no 404 noise in console.
let _supaTransactionsAvailable = false;

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

    // Add sale proceeds to correct currency cash bucket
    const cashCol = (h.currency === 'ILS') ? 'cash_ils' : 'cash_usd';
    const { data: portfolio } = await supabaseClient
        .from('portfolios')
        .select('cash_usd, cash_ils')
        .eq('id', clientId)
        .single();

    if (portfolio) {
        const newCashInBucket = (portfolio[cashCol] || 0) + saleProceeds;
        const totalCash = (portfolio.cash_usd || 0) + (portfolio.cash_ils || 0) + saleProceeds;
        await supabaseClient
            .from('portfolios')
            .update({ [cashCol]: newCashInBucket, cash_balance: totalCash })
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

