// ========== INIT - Initialization & Event Handlers ==========

// ── Quick-Watch: searchable pool — indices, US mega-caps, TASE stocks, crypto ──
const _QW_TICKER_POOL = [
    // Global Indices
    { sym: 'SPY',      label: 'S&P 500',          type: 'index',  currency: 'USD' },
    { sym: 'QQQ',      label: 'NASDAQ 100',        type: 'index',  currency: 'USD' },
    { sym: 'DIA',      label: 'Dow Jones',         type: 'index',  currency: 'USD' },
    { sym: 'IWM',      label: 'Russell 2000',      type: 'index',  currency: 'USD' },
    { sym: 'EWG',      label: 'DAX (Germany)',     type: 'index',  currency: 'USD' },
    { sym: 'EWQ',      label: 'CAC 40 (France)',   type: 'index',  currency: 'USD' },
    { sym: 'EWJ',      label: 'Nikkei (Japan)',    type: 'index',  currency: 'USD' },
    { sym: 'FXI',      label: 'China Large-Cap',   type: 'index',  currency: 'USD' },
    { sym: 'TA35.TA',  label: 'TA-35',             type: 'index',  currency: 'ILS' },
    { sym: 'GLD',      label: 'Gold',              type: 'index',  currency: 'USD' },
    { sym: 'USO',      label: 'Oil (WTI)',         type: 'index',  currency: 'USD' },
    { sym: 'TLT',      label: 'US Bonds 20Y',      type: 'index',  currency: 'USD' },
    // US Mega-Cap Stocks (NASDAQ / S&P 500)
    { sym: 'AAPL',     label: 'Apple',             type: 'stock',  currency: 'USD' },
    { sym: 'MSFT',     label: 'Microsoft',         type: 'stock',  currency: 'USD' },
    { sym: 'NVDA',     label: 'NVIDIA',            type: 'stock',  currency: 'USD' },
    { sym: 'AMZN',     label: 'Amazon',            type: 'stock',  currency: 'USD' },
    { sym: 'GOOGL',    label: 'Alphabet (Google)', type: 'stock',  currency: 'USD' },
    { sym: 'META',     label: 'Meta',              type: 'stock',  currency: 'USD' },
    { sym: 'TSLA',     label: 'Tesla',             type: 'stock',  currency: 'USD' },
    { sym: 'JPM',      label: 'JPMorgan Chase',    type: 'stock',  currency: 'USD' },
    { sym: 'V',        label: 'Visa',              type: 'stock',  currency: 'USD' },
    { sym: 'JNJ',      label: 'Johnson & Johnson', type: 'stock',  currency: 'USD' },
    { sym: 'XOM',      label: 'ExxonMobil',        type: 'stock',  currency: 'USD' },
    // Tel Aviv Stock Exchange (TASE)
    { sym: 'NICE.TA',  label: 'NICE Systems',      type: 'stock',  currency: 'ILS' },
    { sym: 'CHKP.TA',  label: 'Check Point',       type: 'stock',  currency: 'ILS' },
    { sym: 'TEVA.TA',  label: 'Teva',              type: 'stock',  currency: 'ILS' },
    { sym: 'ICL.TA',   label: 'ICL Group',         type: 'stock',  currency: 'ILS' },
    { sym: 'LUMI.TA',  label: 'Bank Leumi',        type: 'stock',  currency: 'ILS' },
    { sym: 'DSCT.TA',  label: 'Bank Discount',     type: 'stock',  currency: 'ILS' },
    // Crypto
    { sym: 'BTC-USD',  label: 'Bitcoin (BTC)',     type: 'crypto', currency: 'USD' },
    { sym: 'ETH-USD',  label: 'Ethereum (ETH)',    type: 'crypto', currency: 'USD' },
];

const _QW_LS_KEY = 'finextium_qw_tickers';

// Default 4 tickers: the core analytical indices
const _QW_DEFAULT = [
    { sym: 'SPY',     label: 'S&P 500',    type: 'index', currency: 'USD' },
    { sym: 'QQQ',     label: 'NASDAQ 100', type: 'index', currency: 'USD' },
    { sym: 'EWG',     label: 'DAX',        type: 'index', currency: 'USD' },
    { sym: 'TA35.TA', label: 'TA-35',      type: 'index', currency: 'ILS' }
];

function _loadQWTickers() {
    try {
        const saved = localStorage.getItem(_QW_LS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 5) return parsed;
        }
    } catch (_) {}
    return _QW_DEFAULT.map(t => ({ ...t }));
}

// Mutable array — rebuilt from localStorage or default at init, updated on modal save
let _QW_TICKERS = _loadQWTickers();

// ========== LOCAL CACHE (instant offline-first UI) ==========

const CLIENTS_CACHE_KEY = 'portfolio_clients_cache';
const CACHE_TS_KEY = 'portfolio_cache_ts';

function saveClientsToCache(data) {
    try {
        // GUARD: Don't cache data where no stock holdings have resolved live prices.
        // This prevents caching stale DB data with purchase prices as current prices.
        if (data && data.length > 0) {
            const allStocks = data.flatMap(c => (c.holdings || []).filter(h => h.type === 'stock' && h.shares > 0));
            const anyResolved = allStocks.some(h => h._livePriceResolved);
            if (allStocks.length > 0 && !anyResolved) {
                console.warn('[Cache] BLOCKED: No live prices resolved — not caching stale data');
                return;
            }
        }
        localStorage.setItem(CLIENTS_CACHE_KEY, JSON.stringify(data));
        localStorage.setItem(CACHE_TS_KEY, Date.now().toString());
        // Tag cache with current user ID so Phase 0 can verify ownership
        const user = getUser();
        if (user && user.id) {
            localStorage.setItem('portfolio_cache_uid', user.id);
        }
    } catch (e) {
        // localStorage full — silent fail
    }
}

function loadClientsFromCache() {
    try {
        const raw = localStorage.getItem(CLIENTS_CACHE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

// Cached user ID to avoid repeated getUser() network calls
let _cachedUserId = null;

function getCachedUserId() {
    if (_cachedUserId) return _cachedUserId;
    const user = getUser(); // from auth.js — reads localStorage only
    return user ? user.id : null;
}

// ========== SERVICE WORKER REGISTRATION ==========

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then((reg) => {
                console.log('Service Worker registered, scope:', reg.scope);
            })
            .catch((err) => {
                console.warn('Service Worker registration failed:', err);
            });
    });
}

// ========== PHASE 0: SYNCHRONOUS CACHE RENDER (runs before ANY network call) ==========
// This block executes at script parse time — no await, no async, pure localStorage read.
// SECURITY: Only render from cache if the cached user matches the currently logged-in user.

let _cacheRendered = false;

(function renderFromCacheImmediately() {
    // Verify the logged-in user matches the cached data owner
    const currentUser = getUser(); // from auth.js — reads localStorage only
    const cachedUserId = localStorage.getItem('portfolio_cache_uid');

    // If no user logged in, or cache belongs to a different user, skip cache render
    if (!currentUser || !cachedUserId || currentUser.id !== cachedUserId) {
        console.log('[Init] Phase 0: Skipped — no user match for cached data');
        return;
    }

    const cached = loadClientsFromCache();
    if (cached && cached.length > 0) {
        console.log(`[Init] Phase 0: Instant render of ${cached.length} cached portfolios`);
        clients = cached;

        try {
            renderSummaryBar();
            renderExposureSection();
            renderClientCards();
            updateUserDisplay();
        } catch (e) {
            console.error('[Init] Phase 0 render failed:', e);
        } finally {
            // Always hide overlay — even if a render function throws
            const overlay = document.getElementById('loadingOverlay');
            if (overlay) overlay.classList.add('hidden');
            document.getElementById('lastUpdate').textContent = 'מעדכן נתונים...';
            _cacheRendered = true;
        }
    }
})();

// ========== REFRESH ==========

async function refreshAllPrices() {
    document.getElementById('lastUpdate').textContent = 'מעדכן...';

    // Refresh FX rates on manual refresh
    if (typeof fetchFxRates === 'function') {
        fetchFxRates().catch(e => console.warn('[Refresh] FX rate fetch failed:', e.message));
    }

    const onRefreshUpdate = () => {
        renderSummaryBar();
        renderExposureSection();
        renderClientCards();
        saveClientsToCache(clients);
        const now = new Date();
        document.getElementById('lastUpdate').textContent =
            `עודכן: ${now.toLocaleTimeString('he-IL')}`;
    };

    if (supabaseConnected) {
        await updatePricesFromAPI(onRefreshUpdate);
    } else {
        await updatePricesForClients();
    }

    onRefreshUpdate();

    // Alerts in background
    checkAlerts().then(() => renderAlerts());
}

// ========== INIT (Progressive Hydration — called after auth succeeds) ==========

async function init() {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = overlay ? overlay.querySelector('.loading-text') : null;

    // If cache didn't render (first-ever visit), show skeleton
    if (!_cacheRendered) {
        if (overlay) overlay.classList.remove('hidden');
        if (loadingText) loadingText.textContent = 'טוען תיקים...';
    }

    // ── Phase 1: Fetch fresh portfolio structure from Supabase ──
    // checkSupabaseConnection() is synchronous now (no network call)
    let useSupabase = false;
    try {
        useSupabase = await checkSupabaseConnection();
    } catch (e) {
        console.warn('[Init] Phase 1: Supabase connection check failed:', e.message);
    }

    let freshClients;
    try {
        if (useSupabase) {
            freshClients = await supaFetchClients();
        } else {
            freshClients = typeof fetchClients === 'function' ? await fetchClients() : null;
        }
    } catch (e) {
        console.error('[Init] Phase 1: Client fetch failed:', e.message);
        freshClients = null;
    }

    if (freshClients) {
        // Supabase is the source of truth — always replace local state with fresh data.
        // Even if freshClients is empty (new user / all portfolios deleted), that is the
        // correct state and we must clear any stale cache from a previous session.
        clients = freshClients;
        saveClientsToCache(clients);

        // Re-render with fresh Supabase data (has last-known prices from DB)
        renderSummaryBar();
        renderExposureSection();
        renderClientCards();

        if (freshClients.length === 0 && _cacheRendered) {
            // Cache showed portfolios that no longer exist in Supabase — clear stale UI
            console.log('[Init] Phase 1: Supabase returned 0 portfolios — clearing stale cache');
        }
    } else if (useSupabase) {
        // Supabase connected but fetch failed — we're running on stale cache
        console.warn('[Init] Phase 1: Supabase fetch failed — using cached data (may be stale)');
        document.getElementById('lastUpdate').textContent = 'נתונים מהמטמון (לא מעודכן)';
    }

    // ── Phase 1.1: Probe transactions table (BLOCKING — must complete before any sell/buy) ──
    // Ensures _supaTransactionsAvailable is set correctly before any user action.
    if (useSupabase && typeof _probeTransactionsTable === 'function') {
        try {
            await _probeTransactionsTable();
        } catch (e) {
            console.warn('[Init] Transactions table probe failed:', e.message);
        }
    }

    // ── Hide overlay ALWAYS — never leave user stuck on loading screen ──
    if (overlay && !overlay.classList.contains('hidden')) {
        updateUserDisplay();
        overlay.classList.add('hidden');
    }

    // Restore state from URL query params
    restoreStateFromURL();

    // ── Phase 1.5: Fetch FX rates for multi-currency valuation ──
    // Must resolve before price update so portfolio totals are FX-converted.
    // Await with a short timeout — has hardcoded fallback if APIs fail.
    if (typeof fetchFxRates === 'function') {
        try {
            await Promise.race([
                fetchFxRates(),
                new Promise(resolve => setTimeout(resolve, 3000))
            ]);
        } catch (e) {
            console.warn('[Init] FX rate fetch failed, using fallback:', e.message);
        }
    }

    // ── Phase 2: Update live market prices in background ──
    // Use requestIdleCallback so we don't compete with rendering
    const startPriceUpdate = () => {
        if (!useSupabase) {
            const now = new Date();
            document.getElementById('lastUpdate').textContent =
                `עודכן: ${now.toLocaleTimeString('he-IL')}`;
            return;
        }

        document.getElementById('lastUpdate').textContent = 'מעדכן מחירים...';

        // onUpdate callback — called incrementally as each price batch arrives
        const onPriceUpdate = () => {
            renderSummaryBar();
            renderExposureSection();
            renderClientCards();
            saveClientsToCache(clients);
            const now = new Date();
            document.getElementById('lastUpdate').textContent =
                `עודכן: ${now.toLocaleTimeString('he-IL')}`;
        };

        updatePricesFromAPI(onPriceUpdate).catch(err => {
            console.warn('Background price update failed:', err.message);
            document.getElementById('lastUpdate').textContent = 'מחירים מהמטמון';
        });
    };

    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(startPriceUpdate, { timeout: 2000 });
    } else {
        setTimeout(startPriceUpdate, 100);
    }

    // ── Phase 3: Alerts (lowest priority — 3s delay) ──
    setTimeout(() => {
        checkAlerts().then(() => renderAlerts());
    }, 3000);

    // Auto-refresh every 5 minutes
    setInterval(refreshAllPrices, 300000);

    // Build ticker DOM then fetch prices (non-blocking, best-effort)
    _renderQWTickers();
    _updateQuickWatch();
}

// ── Quick-Watch: build ticker DOM from _QW_TICKERS ──
function _renderQWTickers() {
    const container = document.getElementById('qwTickers');
    if (!container) return;
    container.innerHTML = _QW_TICKERS.map(t => {
        const domId = t.sym.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        const typeTag = t.type === 'crypto' ? 'crypto' : t.type === 'index' ? 'idx' : '';
        return `
        <div class="qw-ticker" id="qw-item-${domId}">
            <span class="qw-name">${t.label}${typeTag ? `<span class="qw-type-tag">${typeTag}</span>` : ''}</span>
            <span class="qw-price" id="qw-${domId}">—</span>
            <span class="qw-change" id="qw-${domId}-chg">—</span>
        </div>`;
    }).join('');
}

// ── Quick-Watch price cache (localStorage) ──
const _QW_PRICE_CACHE_KEY = 'finextium_qw_prices';

function _saveQWPriceCache(prices) {
    try { localStorage.setItem(_QW_PRICE_CACHE_KEY, JSON.stringify({ ts: Date.now(), prices })); } catch (_) {}
}

function _loadQWPriceCache() {
    try {
        const raw = localStorage.getItem(_QW_PRICE_CACHE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        // Cache valid for 30 minutes
        if (Date.now() - obj.ts > 30 * 60 * 1000) return null;
        return obj.prices || null;
    } catch (_) { return null; }
}

function _applyQWPrices(priceMap) {
    for (const t of _QW_TICKERS) {
        const domId = t.sym.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        const data  = priceMap[t.sym];
        if (!data || !data.price) continue;
        const priceEl = document.getElementById(`qw-${domId}`);
        const chgEl   = document.getElementById(`qw-${domId}-chg`);
        const itemEl  = document.getElementById(`qw-item-${domId}`);
        if (!priceEl || !chgEl) continue;

        const price  = data.price;
        const prev   = data.previousClose || price;
        const chgPct = prev > 0 ? ((price - prev) / prev * 100) : 0;
        const isPos  = chgPct >= 0;

        // All pool entries are type:'index' — always plain points, no currency symbol
        priceEl.textContent = Number(price).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
        chgEl.textContent   = `${isPos ? '+' : ''}${chgPct.toFixed(2)}%`;
        chgEl.className     = `qw-change ${isPos ? 'positive' : 'negative'}`;
        if (itemEl) {
            itemEl.classList.remove('qw-ticker--positive', 'qw-ticker--negative');
            itemEl.classList.add(isPos ? 'qw-ticker--positive' : 'qw-ticker--negative');
        }
    }
}

// ── Quick-Watch: fetch prices and update DOM ──
// Strategy: render cached prices immediately, then fetch fresh data in parallel.
// Each ticker retries up to 2 times with exponential backoff before giving up.
async function _updateQuickWatch() {
    if (typeof fetchSingleTickerPrice !== 'function') return;

    // Step 1: apply cache immediately so UI is never blank
    const cached = _loadQWPriceCache();
    if (cached) _applyQWPrices(cached);

    // Step 2: fetch fresh prices with per-ticker retry + 3s timeout
    const freshPrices = cached ? { ...cached } : {};
    const fetchWithRetry = async (t, attempt = 0) => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const result = await fetchSingleTickerPrice(t.sym, t.currency);
            clearTimeout(timeout);
            if (result && result.price) {
                freshPrices[t.sym] = result;
            }
        } catch (_) {
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
                return fetchWithRetry(t, attempt + 1);
            }
            // All retries exhausted — cached value already shown, no further action
        }
    };

    await Promise.allSettled(_QW_TICKERS.map(t => fetchWithRetry(t)));

    // Step 3: apply fresh prices and persist to cache
    _applyQWPrices(freshPrices);
    _saveQWPriceCache(freshPrices);
}

// ========== TICKER CONFIGURATION MODAL ==========

let _qwPendingSelection = [];

function openTickerModal() {
    _qwPendingSelection = _QW_TICKERS.map(t => ({ ...t }));
    _renderModalAssetList('');
    _renderModalSelectedList();
    const modal = document.getElementById('qwConfigModal');
    if (modal) {
        modal.classList.add('active');
        document.getElementById('qwSearchInput').value = '';
        document.getElementById('qwSearchInput').focus();
    }
}

function closeTickerModal() {
    const modal = document.getElementById('qwConfigModal');
    if (modal) modal.classList.remove('active');
}

// Runtime cache of dynamic search results — keyed by sym so _toggleQWAsset
// can find full metadata for items that aren't in the static pool.
let _qwDynamicResults = [];
let _qwSearchTimeout = null;
let _qwLastQuery = '';

function _renderQWPool(items) {
    const el = document.getElementById('qwPoolList');
    if (!el) return;
    el.innerHTML = items.map(t => {
        const isSelected = _qwPendingSelection.some(s => s.sym === t.sym);
        const typeLabel = t.type === 'index' ? 'מדד' : t.type === 'crypto' ? 'קריפטו' : t.type === 'bond' ? 'אג"ח' : 'מניה';
        return `<div class="qw-pool-item ${isSelected ? 'selected' : ''}" onclick="_toggleQWAsset('${t.sym}')">
            <span class="qw-pool-label">${t.label}</span>
            <span class="qw-pool-sym">${t.sym}</span>
            <span class="qw-pool-type">${typeLabel}</span>
            ${isSelected ? '<span class="qw-pool-check">✓</span>' : ''}
        </div>`;
    }).join('') || '<p style="color:var(--text-muted);padding:12px;font-size:12px;">לא נמצאו תוצאות</p>';
}

function _mapApiToPool(item) {
    const isIsraeli = item.exchange === 'TASE' || item.currency === 'ILS';
    const displaySym = isIsraeli && !item.symbol.endsWith('.TA') ? item.symbol + '.TA' : item.symbol;
    const t = (item.type || '').toLowerCase();
    let poolType = 'stock';
    if (t.includes('etf') || t.includes('mutual') || t.includes('index')) poolType = 'index';
    return {
        sym: displaySym,
        label: item.name || item.symbol,
        type: poolType,
        currency: isIsraeli ? 'ILS' : (item.currency || 'USD')
    };
}

function _mapHebrewToPool(r) {
    return {
        sym: r.symbol,
        label: r.hebrewName || r.name || r.symbol,
        type: 'stock',
        currency: (r.currency === 'ILA' ? 'ILS' : r.currency) || 'USD'
    };
}

function _mapBondToPool(r) {
    return {
        sym: r.symbol,
        label: r.hebrewName || r.name || r.symbol,
        type: 'bond',
        currency: 'ILS'
    };
}

async function _renderModalAssetList(query) {
    const el = document.getElementById('qwPoolList');
    if (!el) return;
    const q = (query || '').toLowerCase().trim();
    _qwLastQuery = q;

    if (!q) {
        _qwDynamicResults = [];
        _renderQWPool(_QW_TICKER_POOL);
        return;
    }

    // Static pool matches (shown instantly)
    const staticMatches = _QW_TICKER_POOL.filter(t =>
        t.label.toLowerCase().includes(q) || t.sym.toLowerCase().includes(q)
    );

    // Local Hebrew stocks + bonds (shown instantly)
    const localStocks = (typeof searchHebrewNames === 'function') ? searchHebrewNames(query) : [];
    const localBonds  = (typeof searchLocalBonds === 'function') ? searchLocalBonds(query) : [];
    const localPool   = [
        ...staticMatches,
        ...localStocks.map(_mapHebrewToPool),
        ...localBonds.map(_mapBondToPool)
    ];
    _qwDynamicResults = _dedupeBySym(localPool);
    _renderQWPool(_qwDynamicResults);

    // Debounced API call — merges results as they arrive
    clearTimeout(_qwSearchTimeout);
    _qwSearchTimeout = setTimeout(async () => {
        if (_qwLastQuery !== q) return; // query changed — abort
        try {
            const apiResults = await searchTwelveDataSymbols(query);
            if (_qwLastQuery !== q) return;
            const apiPool = apiResults.map(_mapApiToPool);
            _qwDynamicResults = _dedupeBySym([..._qwDynamicResults, ...apiPool]);
            _renderQWPool(_qwDynamicResults);
        } catch (_) { /* ignore */ }
    }, 280);
}

function _dedupeBySym(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (seen.has(item.sym)) continue;
        seen.add(item.sym);
        out.push(item);
    }
    return out;
}

function _renderModalSelectedList() {
    const el = document.getElementById('qwSelectedList');
    if (!el) return;
    el.innerHTML = _qwPendingSelection.map(t => `
        <div class="qw-selected-item">
            <span>${t.label}</span>
            <button class="qw-remove-btn" onclick="_removeQWAsset('${t.sym}')">✕</button>
        </div>`).join('');
    const countEl = document.getElementById('qwSelectedCount');
    if (countEl) countEl.textContent = `${_qwPendingSelection.length}/4`;
}

function _toggleQWAsset(sym) {
    const existing = _qwPendingSelection.findIndex(t => t.sym === sym);
    if (existing !== -1) {
        _qwPendingSelection.splice(existing, 1);
    } else {
        if (_qwPendingSelection.length >= 4) return; // max 4
        const poolItem =
            _QW_TICKER_POOL.find(t => t.sym === sym) ||
            _qwDynamicResults.find(t => t.sym === sym);
        if (poolItem) _qwPendingSelection.push({ ...poolItem });
    }
    const query = document.getElementById('qwSearchInput')?.value || '';
    _renderModalAssetList(query);
    _renderModalSelectedList();
}

function _removeQWAsset(sym) {
    _qwPendingSelection = _qwPendingSelection.filter(t => t.sym !== sym);
    const query = document.getElementById('qwSearchInput')?.value || '';
    _renderModalAssetList(query);
    _renderModalSelectedList();
}

function saveTickerConfig() {
    if (_qwPendingSelection.length === 0) return;
    _QW_TICKERS = _qwPendingSelection.map(t => ({ ...t }));
    try { localStorage.setItem(_QW_LS_KEY, JSON.stringify(_QW_TICKERS)); } catch (_) {}
    _renderQWTickers();
    _updateQuickWatch();
    closeTickerModal();
}

// ========== PERSISTENT STATE (URL QUERY PARAMS) ==========

// ========== BROWSER HISTORY & BACK BUTTON SUPPORT ==========
// Uses pushState so that the browser back button (and Android back gesture)
// navigates between dashboard views: dashboard ← modal ← macro ← full-list.

let _suppressPopstate = false; // prevent loops when we programmatically navigate

function updateURLState(params) {
    const url = new URL(window.location);
    url.searchParams.delete('view');
    url.searchParams.delete('client');
    url.searchParams.delete('tab');

    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') {
            url.searchParams.set(key, value);
        }
    });

    // pushState creates a history entry — back button returns to previous state
    history.pushState({ finextium: true, ...params }, '', url);
}

function clearURLState() {
    const url = new URL(window.location);
    url.searchParams.delete('view');
    url.searchParams.delete('client');
    url.searchParams.delete('tab');
    history.pushState({ finextium: true, dashboard: true }, '', url);
}

function restoreStateFromURL() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const clientId = params.get('client');
    const tab = params.get('tab');

    if (view === 'macro') {
        toggleAlerts();
    } else if (view === 'fulllist') {
        if (typeof openFullPortfolioList === 'function') openFullPortfolioList();
    } else if (clientId) {
        const id = parseInt(clientId);
        const client = clients.find(c => c.id === id);
        if (client) {
            openModal(id).then(() => {
                if (tab && tab !== 'overview') {
                    switchModalTab(tab);
                }
            });
        }
    }
}

// ── Back button handler (browser + Android) ──
window.addEventListener('popstate', function(e) {
    if (_suppressPopstate) { _suppressPopstate = false; return; }

    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const clientId = params.get('client');

    // Close everything first
    const modalOpen = document.getElementById('modalOverlay')?.classList.contains('active');
    const macroOpen = document.getElementById('macroPage')?.style.display === 'block';
    const fullListOpen = document.querySelector('.full-list-page');

    if (fullListOpen && !clientId && view !== 'fulllist') {
        if (typeof closeFullPortfolioList === 'function') closeFullPortfolioList();
        return;
    }
    if (modalOpen && !clientId) {
        // Back from modal → dashboard (don't push new state)
        _suppressPopstate = true;
        document.getElementById('modalOverlay').classList.remove('active');
        return;
    }
    if (macroOpen && view !== 'macro') {
        if (typeof closeMacroPage === 'function') closeMacroPage();
        return;
    }

    // Restore whatever the URL says
    if (clientId) {
        const id = parseInt(clientId);
        if (id && clients && clients.find(c => c.id === id)) {
            _suppressPopstate = true;
            openModal(id);
        }
    } else if (view === 'macro') {
        if (typeof toggleAlerts === 'function') toggleAlerts();
    } else if (view === 'fulllist') {
        if (typeof openFullPortfolioList === 'function') openFullPortfolioList();
    }
});

// ========== AUTH CHECK (runs AFTER cache render) ==========

async function checkAuthAndInit() {
    // ── Detect OAuth redirect-back ──
    // With implicit flow, Supabase puts tokens in the URL hash: #access_token=...&...
    // The SDK reads these automatically via detectSessionInUrl:true and fires
    // onAuthStateChange(SIGNED_IN), which calls onAuthSuccess() → init().
    // We must NOT race that with a short getSession() timeout here — just return early
    // and let the listener do its job.
    const hash = window.location.hash;
    if (hash.includes('access_token=') || hash.includes('error_description=')) {
        console.log('[Auth] OAuth hash detected — waiting for onAuthStateChange');
        // Clear the hash so a manual refresh doesn't re-trigger the OAuth flow
        history.replaceState(null, '', window.location.pathname + window.location.search);
        // Safety net: if SIGNED_IN never fires within 10s, show login
        setTimeout(() => {
            if (!window._dashboardBooted) {
                console.warn('[Auth] OAuth SIGNED_IN timeout — showing login form');
                showLoginForm();
            }
        }, 10000);
        return;
    }

    // ── Normal page load: check for an existing session ──
    try {
        // getSession() reads localStorage first — fast on most loads.
        // Only needs the network if a token refresh is required.
        const { data: { session }, error } = await supabaseClient.auth.getSession();

        if (session && !error) {
            _cachedUserId = session.user.id;
            saveToken(session.access_token);
            const username = session.user.user_metadata?.full_name
                || session.user.user_metadata?.username
                || session.user.email;
            saveUser({ id: session.user.id, username });
            window._dashboardBooted = true;
            console.log('[Auth] Existing session:', username);
            init();
            return;
        }

        // No valid session — check if we have a stored token as fallback
        if (isLoggedIn()) {
            _cachedUserId = getCachedUserId();
            window._dashboardBooted = true;
            init();
        } else {
            showLoginForm();
        }
    } catch (e) {
        console.warn('[Auth] checkAuthAndInit error:', e.message);
        if (isLoggedIn()) {
            _cachedUserId = getCachedUserId();
            window._dashboardBooted = true;
            init();
        } else {
            showLoginForm();
        }
    }
}

// Handle ESC key for modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.getElementById('fullscreenOverlay').classList.contains('active')) {
            closeFullscreen();
            return;
        }
        document.getElementById('modalOverlay').classList.remove('active');
        currentModalClientId = null;
        clearURLState();
    }
});

// Start auth check — but cache has already rendered above (Phase 0)
checkAuthAndInit();
