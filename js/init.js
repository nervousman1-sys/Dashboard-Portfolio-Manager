// ========== INIT - Initialization & Event Handlers ==========

// ========== LOCAL CACHE (instant offline-first UI) ==========

const CLIENTS_CACHE_KEY = 'portfolio_clients_cache';
const CACHE_TS_KEY = 'portfolio_cache_ts';

function saveClientsToCache(data) {
    try {
        localStorage.setItem(CLIENTS_CACHE_KEY, JSON.stringify(data));
        localStorage.setItem(CACHE_TS_KEY, Date.now().toString());
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

let _cacheRendered = false;

(function renderFromCacheImmediately() {
    const cached = loadClientsFromCache();
    if (cached && cached.length > 0) {
        console.log(`[Init] Phase 0: Instant render of ${cached.length} cached portfolios`);
        clients = cached;

        // These render functions are synchronous DOM writes
        renderSummaryBar();
        renderExposureSection();
        renderClientCards();
        updateUserDisplay();

        // Hide skeleton overlay immediately
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.classList.add('hidden');

        document.getElementById('lastUpdate').textContent = 'מעדכן נתונים...';
        _cacheRendered = true;
    }
})();

// ========== REFRESH ==========

async function refreshAllPrices() {
    document.getElementById('lastUpdate').textContent = 'מעדכן...';

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
    const useSupabase = await checkSupabaseConnection();

    let freshClients;
    if (useSupabase) {
        freshClients = await supaFetchClients();
    } else {
        freshClients = await fetchClients();
    }

    if (freshClients && freshClients.length > 0) {
        clients = freshClients;
        saveClientsToCache(clients);

        // Re-render with fresh Supabase data (has last-known prices from DB)
        renderSummaryBar();
        renderExposureSection();
        renderClientCards();
    }

    // ── Hide overlay if it was still showing (first-ever visit) ──
    if (overlay && !overlay.classList.contains('hidden')) {
        updateUserDisplay();
        overlay.classList.add('hidden');
    }

    // Restore state from URL query params
    restoreStateFromURL();

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
}

// ========== PERSISTENT STATE (URL QUERY PARAMS) ==========

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

    history.replaceState(null, '', url);
}

function clearURLState() {
    const url = new URL(window.location);
    url.searchParams.delete('view');
    url.searchParams.delete('client');
    url.searchParams.delete('tab');
    history.replaceState(null, '', url);
}

function restoreStateFromURL() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const clientId = params.get('client');
    const tab = params.get('tab');

    if (view === 'macro') {
        toggleAlerts();
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

// ========== AUTH CHECK (streamlined — runs AFTER cache render) ==========

async function checkAuthAndInit() {
    try {
        // getSession() — Supabase SDK reads local storage first, but may refresh token via network.
        // Race with a short timeout so we don't block forever.
        const sessionPromise = supabaseClient.auth.getSession();
        const timeoutPromise = new Promise((resolve) =>
            setTimeout(() => resolve({ data: { session: null }, error: new Error('Session timeout') }), 3000)
        );

        const { data: { session }, error } = await Promise.race([sessionPromise, timeoutPromise]);

        if (session && !error) {
            _cachedUserId = session.user.id;
            saveToken(session.access_token);

            const username = session.user.user_metadata?.full_name
                || session.user.user_metadata?.username
                || session.user.email;
            saveUser({ id: session.user.id, username });

            init();
            return;
        }

        // Session failed or timed out — check localStorage fallback
        if (isLoggedIn()) {
            // We have a stored token — try init anyway, supaFetchClients will handle auth
            _cachedUserId = getCachedUserId();
            init();
        } else {
            showLoginForm();
        }
    } catch (e) {
        console.warn('Auth check failed:', e.message);
        if (isLoggedIn()) {
            _cachedUserId = getCachedUserId();
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
