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

// ========== DAY / NIGHT THEME ==========
// Default is the cyber-noir night mode; day mode is a full light skin driven by
// CSS variable overrides (html.day-mode). Persisted across sessions.

function toggleDayMode() {
    const isDay = document.documentElement.classList.toggle('day-mode');
    try { localStorage.setItem('ui_theme', isDay ? 'day' : 'night'); } catch (e) { /* ignore */ }
    _syncThemeButton();
    // Charts bake their ink colors at render time — re-render any that are open
    // so light charts get black numbers (and vice versa) immediately.
    try {
        if (document.getElementById('riskmodelPage')?.classList.contains('active')
            && typeof openRiskAnalysis === 'function') openRiskAnalysis();
        if (document.getElementById('modal-cml-chart')
            && typeof _renderModalRiskCharts === 'function' && typeof currentModalClientId !== 'undefined'
            && currentModalClientId) _renderModalRiskCharts(currentModalClientId);
        // Yield curves bake their ink too — force a repaint with the new theme
        if (document.getElementById('usYieldCurve') && typeof _renderYieldCurves === 'function') {
            window._yieldData = null;
            _renderYieldCurves();
        }
    } catch (e) { /* best effort */ }
}

function _syncThemeButton() {
    const label = document.getElementById('themeToggleLabel');
    if (label) label.textContent = document.documentElement.classList.contains('day-mode') ? 'מצב לילה' : 'מצב יום';
}
// Sync the button label on load (theme class was applied pre-paint in <head>)
window.addEventListener('DOMContentLoaded', _syncThemeButton);

// ========== SERVICE WORKER REGISTRATION ==========

if ('serviceWorker' in navigator) {
    // NOTE: we deliberately do NOT auto-reload on `controllerchange`. Doing so made the
    // open page jump to the top every time a new version deployed (jarring "refresh"
    // jumps). The new SW still installs silently in the background (updateViaCache:'none'
    // + reg.update()), so the update applies on the user's next natural refresh — with
    // no surprise scroll-to-top mid-session.
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' })
            .then((reg) => {
                console.log('Service Worker registered, scope:', reg.scope);
                reg.update().catch(() => {});
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
// True while the initial portfolio fetch is still in flight — so the dashboard shows a
// LOADING state instead of the "אין תיקים להצגה" empty state during the first load window.
if (typeof window !== 'undefined') {
    window._clientsLoading = true;
    // Only true once the SERVER confirms the account genuinely has 0 portfolios. Until then the
    // dashboard shows a loading state, never the false "אין תיקים" empty state.
    window._clientsConfirmedEmpty = false;
    // Safety: never let the loading state stick forever (e.g. a hung/failed fetch).
    setTimeout(() => { window._clientsLoading = false; if (typeof renderClientCards === 'function') renderClientCards(); }, 20000);
}

(function renderFromCacheImmediately() {
    // SECURITY GATE: never render cached data unless there is a VALID auth token AND the
    // cache belongs to the logged-in user. A lingering user object without a token (logged
    // out / expired) must NOT flash the previous portfolio before the login screen shows.
    const hasToken = (typeof isLoggedIn === 'function') ? isLoggedIn() : false;
    const currentUser = getUser(); // from auth.js — reads localStorage only
    const cachedUserId = localStorage.getItem('portfolio_cache_uid');

    if (!hasToken || !currentUser || !cachedUserId || currentUser.id !== cachedUserId) {
        console.log('[Init] Phase 0: Skipped — no valid token / user-cache mismatch');
        return;
    }

    const cached = loadClientsFromCache();
    if (cached && cached.length > 0) {
        console.log(`[Init] Phase 0: Instant render of ${cached.length} cached portfolios (kept under the loading overlay until auth is confirmed)`);
        clients = cached;
        // Stamp frozen model scores instantly (no build) so the badges show immediately.
        if (typeof rmApplyFrozenScores === 'function') { try { rmApplyFrozenScores(clients); } catch (e) { } }

        try {
            renderSummaryBar();
            renderExposureSection();
            renderClientCards();
            updateUserDisplay();
        } catch (e) {
            console.error('[Init] Phase 0 render failed:', e);
        } finally {
            // Render into the DOM but DO NOT reveal it yet — the loading overlay stays up
            // until checkAuthAndInit confirms the session (authed → reveal; not authed →
            // clearAllAppData + login). This closes the flash-of-previous-portfolio window.
            document.getElementById('lastUpdate').textContent = 'מעדכן נתונים...';
            _cacheRendered = true;
        }
        // Warm the CML/SML risk model the INSTANT we have (cached) holdings — not 2s later
        // behind requestIdleCallback. Returns the persisted model immediately when fresh,
        // otherwise starts the build now so opening a CML/SML tab isn't a cold ~5s wait.
        try {
            if (typeof buildRiskModel === 'function' && clients && clients.length) {
                buildRiskModel(clients).catch(() => { });
            }
        } catch (e) { /* non-fatal */ }
    }
    // If the URL points to a specific page/portfolio, open it RIGHT NOW (on top of
    // the cache render) so a refresh lands straight on that page — no dashboard
    // flash. The later init-phase restore is idempotent and just re-asserts it.
    try {
        if (new URLSearchParams(window.location.search).toString() && typeof restoreStateFromURL === 'function') {
            restoreStateFromURL();
        }
    } catch (e) { /* init-phase restore will cover it */ }
})();

// ========== REFRESH ==========

async function refreshAllPrices() {
    document.getElementById('lastUpdate').textContent = 'מעדכן...';

    // Refresh FX rates on manual refresh
    if (typeof fetchFxRates === 'function') {
        fetchFxRates().catch(e => console.warn('[Refresh] FX rate fetch failed:', e.message));
    }

    // Debounced render — the price updater fires this 8+ times per cycle; coalesce the burst
    // into one render (see onPriceUpdate). A trailing render is forced after the cycle completes.
    let _ruTimer = null;
    const _doRefreshRender = () => {
        renderSummaryBar();
        renderExposureSection();
        renderClientCards();
        saveClientsToCache(clients);
        document.getElementById('lastUpdate').textContent = `עודכן: ${new Date().toLocaleTimeString('he-IL')}`;
    };
    const onRefreshUpdate = () => { if (_ruTimer) clearTimeout(_ruTimer); _ruTimer = setTimeout(_doRefreshRender, 250); };

    if (supabaseConnected) {
        await updatePricesFromAPI(onRefreshUpdate);
    } else {
        await updatePricesForClients();
    }

    if (_ruTimer) clearTimeout(_ruTimer);
    _doRefreshRender(); // final, immediate render after the cycle

    // Recompute CML/SML auto-risk in the background once fresh prices are in
    if (typeof applyModelRiskToClients === 'function') {
        applyModelRiskToClients({ force: true });
    }

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
        // Server CONFIRMED the portfolio count — now (and only now) the empty state is allowed.
        if (typeof window !== 'undefined') window._clientsConfirmedEmpty = (freshClients.length === 0);
        // Re-apply the frozen model scores to the fresh objects (instant, deterministic badges).
        if (typeof rmApplyFrozenScores === 'function') { try { rmApplyFrozenScores(clients); } catch (e) { } }

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

    // Initial portfolio load is done (success, empty, or failed-onto-cache) — drop the
    // loading state and re-render so an empty result now shows the real "אין תיקים" state
    // rather than a spinner, and a populated result shows the cards.
    if (typeof window !== 'undefined') window._clientsLoading = false;
    if (typeof renderClientCards === 'function') renderClientCards();

    // ── Phase 1.1: Probe transactions table (BLOCKING — must complete before any sell/buy) ──
    // Ensures _supaTransactionsAvailable is set correctly before any user action.
    if (useSupabase && typeof _probeTransactionsTable === 'function') {
        try {
            await _probeTransactionsTable();
        } catch (e) {
            console.warn('[Init] Transactions table probe failed:', e.message);
        }
    }

    // Restore the URL's target view FIRST (under the still-visible overlay), THEN hide the
    // overlay — so a refresh on a modal/page reveals that view directly and NEVER flashes
    // the dashboard underneath. (Open helpers set their overlay .active synchronously, so
    // by the time we hide the loader the target already covers the dashboard.)
    restoreStateFromURL();

    // ── Hide overlay ALWAYS — never leave user stuck on loading screen ──
    if (overlay && !overlay.classList.contains('hidden')) {
        updateUserDisplay();
        overlay.classList.add('hidden');
    }
    // Safety net: re-assert once data is settled, in case the page/modal needed
    // clients or DOM that weren't ready on the first pass. Idempotent (won't
    // re-open anything already open), and skipped if the user already navigated.
    setTimeout(() => {
        const stillThere = new URLSearchParams(window.location.search).toString();
        if (stillThere) syncViewToURL();
    }, 1800);

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

    // Preload USD/ILS daily history (real reference rate for the FX-adjusted return + ₪ currency
    // P&L). Non-blocking — repaint when it lands so the FX figures appear for every portfolio.
    if (typeof ensureUsdIlsHistory === 'function') {
        ensureUsdIlsHistory().then(() => {
            if (typeof renderClientCards === 'function') renderClientCards();
            if (typeof renderSummaryBar === 'function') renderSummaryBar();
        }).catch(() => { });
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

        // New computer? Pull today's CML/SML model from the cloud cache BEFORE the
        // first build — the page then renders the model instantly instead of
        // refetching ~70 ticker histories and recomputing from scratch. Then warm
        // the model RIGHT AWAY (it derives from history, not live prices), so opening
        // a portfolio's CML/SML tab is instant instead of triggering a cold build.
        const _warmRiskModel = () => {
            if (typeof buildRiskModel === 'function' && typeof clients !== 'undefined' && clients.length) {
                buildRiskModel(clients).catch(() => { });
            }
        };
        if (typeof rmHydrateModelFromCloud === 'function') {
            rmHydrateModelFromCloud().then(_warmRiskModel).catch(_warmRiskModel);
        } else {
            _warmRiskModel();
        }

        // onUpdate callback — called incrementally as each price batch arrives. updatePricesFromAPI
        // fires this 8+ times per cycle (fast/background/persist phases); a full re-render each time
        // (which destroys+recreates every card's Chart.js instances) is wasteful and janky. DEBOUNCE
        // so a burst of updates collapses into ONE render ~250ms after the last — still progressive
        // across the seconds-apart phases, but smooth within each phase.
        let _puTimer = null;
        const _doPriceRender = () => {
            renderSummaryBar();
            renderExposureSection();
            renderClientCards();
            saveClientsToCache(clients);
            document.getElementById('lastUpdate').textContent = `עודכן: ${new Date().toLocaleTimeString('he-IL')}`;
        };
        const onPriceUpdate = () => { if (_puTimer) clearTimeout(_puTimer); _puTimer = setTimeout(_doPriceRender, 250); };

        updatePricesFromAPI(onPriceUpdate)
            .then(() => {
                // Once live prices are applied, run the CML/SML model in the
                // background to upgrade each portfolio's risk from the provisional
                // heuristic to the model-based classification.
                if (typeof applyModelRiskToClients === 'function') {
                    setTimeout(() => applyModelRiskToClients(), 1500);
                }
            })
            .catch(err => {
                console.warn('Background price update failed:', err.message);
                document.getElementById('lastUpdate').textContent = 'מחירים מהמטמון';
                if (typeof applyModelRiskToClients === 'function') {
                    setTimeout(() => applyModelRiskToClients(), 1500);
                }
            });
    };

    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(startPriceUpdate, { timeout: 2000 });
    } else {
        setTimeout(startPriceUpdate, 100);
    }

    // ── Phase 3: Alerts (lowest priority — 10s delay) ──
    // Staggered to avoid simultaneous FMP calls with price updates (Phase 2)
    // and sentiment service (5s delay). Baseline data shows immediately.
    setTimeout(() => {
        checkAlerts().then(() => renderAlerts());
    }, 10000);

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

// ── USD/ILS live rate ──
// Renders the fixed FX badge in the top bar (rate + daily %, shekel strength) AND
// pushes the live rate into the app-wide FX state (_fxRates + USD_ILS_RATE), so
// ILS-mode portfolio values and the FX-adjusted return both use the REAL rate.
window.USD_ILS_RATE = window.USD_ILS_RATE || 3.7;
function _applyFxQuote(q) {
    if (!q || !(q.price > 0)) return;
    const rate = q.price;
    const prev = q.prevClose > 0 ? q.prevClose : rate;
    const chgPct = prev > 0 ? ((rate - prev) / prev * 100) : 0;

    // Badge: rate + daily change. Rate UP = dollar up = shekel WEAKER (red);
    // rate DOWN = shekel STRONGER (green).
    const rateEl = document.getElementById('qwFxRate');
    const chgEl = document.getElementById('qwFxChg');
    if (rateEl) rateEl.textContent = `${rate.toFixed(3)} ₪`;  // number first, ₪ on the right
    if (chgEl) {
        const up = chgPct >= 0.005, down = chgPct <= -0.005;
        chgEl.textContent = `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}% ${down ? '· השקל מתחזק' : up ? '· השקל נחלש' : ''}`;
        chgEl.className = `qw-fx-chg ${down ? 'positive' : up ? 'negative' : ''}`;
    }

    // Push into the app-wide FX state so every ILS conversion uses the live rate
    const prevAppRate = (typeof _fxRates !== 'undefined' && _fxRates.USDILS) ? _fxRates.USDILS : window.USD_ILS_RATE;
    try { _fxRates = { USDILS: rate, ILSUSD: 1 / rate }; } catch (e) { /* fx-service not loaded */ }
    window.USD_ILS_RATE = rate;
    // Material rate move while viewing in ILS or with FX-adjusted return ON →
    // re-render so USD portfolio values/returns reflect the live rate.
    const rateMoved = Math.abs(rate - prevAppRate) / prevAppRate > 0.0005;
    const fxMatters = (typeof _displayCurrency !== 'undefined' && _displayCurrency === 'ILS')
        || (typeof _fxAdjustedReturn !== 'undefined' && _fxAdjustedReturn);
    if (rateMoved && fxMatters) {
        try {
            if (typeof renderSummaryBar === 'function') renderSummaryBar();
            if (typeof renderClientCards === 'function') renderClientCards();
            if (typeof renderExposureSection === 'function') renderExposureSection();
        } catch (e) { /* render not ready yet */ }
    }
}

// ── Quick-Watch: fetch prices and update DOM ──
// Strategy: render cached prices immediately, then resolve ALL tickers in a single
// same-origin /api/quote batch round-trip (incl. TA-35 — TASE indices are quoted in
// points, handled by isIndex). Per-ticker fallback only for what the batch missed.
async function _updateQuickWatch() {
    if (typeof fetchSingleTickerPrice !== 'function') return;

    // Step 1: apply cache immediately so UI is never blank
    const cached = _loadQWPriceCache();
    if (cached) _applyQWPrices(cached);

    const freshPrices = cached ? { ...cached } : {};

    // Step 2: ONE batched request for every ticker on the bar + the USD/ILS rate
    let missing = _QW_TICKERS.slice();
    if (typeof _fetchYahooQuotesBatch === 'function' && typeof _shapeYahooQuote === 'function') {
        const raw = await _fetchYahooQuotesBatch(_QW_TICKERS.map(t => t.sym).concat(['ILS=X']));
        missing = [];
        for (const t of _QW_TICKERS) {
            const isTaseIndex = t.type === 'index' && /\.TA$/i.test(t.sym);
            const shaped = _shapeYahooQuote(t.sym, raw[t.sym], { isIndex: isTaseIndex });
            if (shaped && shaped.price) freshPrices[t.sym] = shaped;
            else missing.push(t);
        }
        if (raw['ILS=X']) _applyFxQuote(raw['ILS=X']);   // USD/ILS badge + live app-wide rate
        if (Object.keys(raw).length) _applyQWPrices(freshPrices); // paint as soon as the batch lands
    }

    // Step 3: per-ticker fallback only for what the batch didn't resolve
    const fetchOne = async (t) => {
        try {
            const isTaseIndex = t.type === 'index' && /\.TA$/i.test(t.sym);
            if (isTaseIndex && typeof _fetchYahooPrice === 'function') {
                const r = await _fetchYahooPrice(t.sym, { isIndex: true });
                if (r && r.price) { freshPrices[t.sym] = r; return; }
            }
            const result = await fetchSingleTickerPrice(t.sym, t.currency);
            if (result && result.price) freshPrices[t.sym] = result;
        } catch (_) { /* cached value already shown */ }
    };
    if (missing.length) await Promise.allSettled(missing.map(fetchOne));

    // Step 4: apply fresh prices and persist to cache
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
        try { history.pushState({ popup: 'qw' }, '', location.href); } catch (e) { /* ignore */ }
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
let _restoringView = false;    // while true, open/close functions must NOT push history

// Registry of the full-page views (class-based overlays).
const _VIEW_PAGES = [
    { view: 'macro', id: 'macroPage', open: () => typeof toggleAlerts === 'function' && toggleAlerts(), close: () => typeof closeMacroPage === 'function' && closeMacroPage() },
    { view: 'riskmodel', id: 'riskmodelPage', open: () => typeof openRiskAnalysis === 'function' && openRiskAnalysis(), close: () => typeof closeRiskAnalysis === 'function' && closeRiskAnalysis() },
    { view: 'bulkmgr', id: 'bulkPage', open: () => typeof openBulkPage === 'function' && openBulkPage(), close: () => typeof closeBulkPage === 'function' && closeBulkPage() },
    { view: 'disconews', id: 'discordNewsPage', open: () => typeof openDiscordNews === 'function' && openDiscordNews(), close: () => typeof closeDiscordNews === 'function' && closeDiscordNews() },
    { view: 'technical', id: 'technicalPage', open: () => typeof openTechnicalPage === 'function' && openTechnicalPage(), close: () => typeof closeTechnicalPage === 'function' && closeTechnicalPage() },
    { view: 'reports', id: 'reportsPage', open: () => typeof openReportsPage === 'function' && openReportsPage(), close: () => typeof closeReportsPage === 'function' && closeReportsPage() },
];
const _isPageOpen = (id) => !!document.getElementById(id)?.classList.contains('active');

// While true, page open/close helpers must NOT write history. Used by navigateTo so a
// single sidebar navigation produces ONE history entry (the target) instead of two
// (an intermediate "dashboard" from closing the old page + the target), which made the
// browser Back button land on the dashboard instead of the actually-previous page.
let _suppressURLWrites = false;
if (typeof window !== 'undefined') window._navSuppressURL = (v) => { _suppressURLWrites = !!v; };

function updateURLState(params) {
    if (_restoringView || _suppressURLWrites) return; // navigating/restoring — keep the URL as the source of truth
    const url = new URL(window.location);
    url.searchParams.delete('view');
    url.searchParams.delete('client');
    url.searchParams.delete('tab');
    url.searchParams.delete('mkt');
    url.searchParams.delete('sym');

    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') {
            url.searchParams.set(key, value);
        }
    });

    // pushState creates a history entry — back button returns to previous state
    history.pushState({ finextium: true, ...params }, '', url);
}

function clearURLState() {
    if (_restoringView || _suppressURLWrites) return;
    const url = new URL(window.location);
    url.searchParams.delete('view');
    url.searchParams.delete('client');
    url.searchParams.delete('tab');
    url.searchParams.delete('mkt');
    url.searchParams.delete('sym');
    history.pushState({ finextium: true, dashboard: true }, '', url);
}

// Single source of truth: make the visible UI match the current URL. Used for the
// initial load (refresh), the Back button AND the Forward button — all identical.
// _restoringView stops the open/close helpers from pushing new history entries,
// so navigation never loops or corrupts the forward stack.
function syncViewToURL() {
    _restoringView = true;
    try {
        const params = new URLSearchParams(window.location.search);
        const view = params.get('view');
        const clientId = params.get('client') ? parseInt(params.get('client')) : null;
        const tab = params.get('tab');

        // 1. Close every page/overlay that is NOT the current target
        for (const p of _VIEW_PAGES) {
            if (_isPageOpen(p.id) && view !== p.view) p.close();
        }
        const fullList = document.querySelector('.full-list-page');
        if (fullList && view !== 'fulllist' && typeof closeFullPortfolioList === 'function') closeFullPortfolioList();
        const modalEl = document.getElementById('modalOverlay');
        if (modalEl && modalEl.classList.contains('active') && !clientId) {
            modalEl.classList.remove('active');
            if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
            currentModalClientId = null;
        }

        // 2. Open the current target (idempotent — only if not already open)
        if (clientId) {
            if (typeof clients !== 'undefined' && clients.find(c => c.id === clientId)) {
                if (currentModalClientId !== clientId) {
                    const r = openModal(clientId);
                    if (r && r.then) r.then(() => { if (tab && tab !== 'overview' && typeof switchModalTab === 'function') switchModalTab(tab); });
                } else if (tab && typeof switchModalTab === 'function') {
                    switchModalTab(tab);
                }
            }
        } else if (view === 'fulllist') {
            if (!document.querySelector('.full-list-page') && typeof openFullPortfolioList === 'function') openFullPortfolioList();
        } else {
            const target = _VIEW_PAGES.find(p => p.view === view);
            if (target && !_isPageOpen(target.id)) target.open();
        }
        // Reports: when the page is already open, reconcile its internal list/detail
        // state with the URL so Back/Forward move between the company and the list.
        if (view === 'reports' && _isPageOpen('reportsPage') && typeof _repSyncToURL === 'function') {
            _repSyncToURL();
        }
    } catch (e) {
        console.warn('[Nav] syncViewToURL failed:', e.message);
    } finally {
        _restoringView = false;
    }
}

// Initial load / refresh: restore exactly what the URL points to.
function restoreStateFromURL() { syncViewToURL(); }

// ── History navigation (Back AND Forward, browser + Android) ──
window.addEventListener('popstate', function (e) {
    if (_suppressPopstate) { _suppressPopstate = false; return; }

    // Landing BACK on a recommendations entry (e.g. returning from a technical/reports
    // deep-link the user opened from the recommendations) → restore the underlying view
    // then reopen that overlay on top.
    if (e.state && e.state.popup === 'reco' && e.state.recoClient != null) {
        const ov = document.getElementById('stockRecoOverlay');
        if ((!ov || !ov.classList.contains('active')) && typeof openStockRecommendations === 'function') {
            syncViewToURL();                               // close the page we came from, restore the modal
            openStockRecommendations(e.state.recoClient, true);
            return;
        }
    }

    // Lightweight popups FIRST: back closes the topmost open popup (these push a
    // same-URL history entry when opened, so popping it just closes the popup).
    const popupClosers = [
        ['assetFitOverlay', () => typeof closeAssetFitPopup === 'function' && closeAssetFitPopup()],
        ['stockRecoOverlay', () => typeof closeStockRecommendations === 'function' && closeStockRecommendations()],
        ['mgmtOverlay', () => typeof closeMgmtModal === 'function' && closeMgmtModal()],
        ['decisionCoreOverlay', () => typeof closeDecisionCore === 'function' && closeDecisionCore()],
        ['scannerAgentOverlay', () => typeof closeScannerAgent === 'function' && closeScannerAgent()],
        ['qwConfigModal', () => typeof closeTickerModal === 'function' && closeTickerModal()],
    ];
    for (const [id, closer] of popupClosers) {
        const el = document.getElementById(id);
        if (el && el.classList.contains('active')) { closer(); return; }
    }
    // Report view: back returns to the dashboard
    if (document.getElementById('reportView')?.classList.contains('active')) {
        if (typeof closeReport === 'function') closeReport();
        return;
    }

    // Everything else: just make the UI match the URL — this handles BOTH the Back
    // button (close current view) and the Forward button (re-open the next view).
    syncViewToURL();
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
            _revealIfPreRendered();   // session confirmed → show the user's own pre-rendered data
            init();
            return;
        }

        // No valid session — check if we have a stored token as fallback
        if (isLoggedIn()) {
            _cachedUserId = getCachedUserId();
            window._dashboardBooted = true;
            _revealIfPreRendered();
            init();
        } else {
            showLoginForm();
        }
    } catch (e) {
        console.warn('[Auth] checkAuthAndInit error:', e.message);
        if (isLoggedIn()) {
            _cachedUserId = getCachedUserId();
            window._dashboardBooted = true;
            _revealIfPreRendered();
            init();
        } else {
            showLoginForm();
        }
    }
}

// Reveal the Phase-0 pre-rendered dashboard ONLY after auth is confirmed. (Phase-0 keeps
// it hidden under the loading overlay until here, so the previous portfolio can never
// flash before the auth gate decides.)
function _revealIfPreRendered() {
    if (!_cacheRendered) return;
    // Re-assert the URL's target view BEFORE revealing — Phase-0 already opened it, but this
    // guarantees the modal/page is on screen so hiding the overlay never flashes the
    // dashboard underneath on refresh.
    try { if (typeof restoreStateFromURL === 'function') restoreStateFromURL(); } catch (e) { /* init re-asserts */ }
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
}

// Handle ESC key for modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.getElementById('fullscreenOverlay').classList.contains('active')) {
            closeFullscreen();
            return;
        }
        document.getElementById('modalOverlay').classList.remove('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
        currentModalClientId = null;
        clearURLState();
    }
});

// Start auth check — but cache has already rendered above (Phase 0)
checkAuthAndInit();
