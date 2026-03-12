// ========== INIT - Initialization & Event Handlers ==========

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

// ========== REFRESH ==========

async function refreshAllPrices() {
    document.getElementById('lastUpdate').textContent = 'מעדכן...';
    if (supabaseConnected) {
        // Fetch real prices from FMP API and update Supabase
        await updatePricesFromAPI();
    } else {
        await updatePricesForClients();
    }
    renderSummaryBar();
    renderExposureSection();
    renderClientCards();
    await checkAlerts();
    renderAlerts();
    const now = new Date();
    document.getElementById('lastUpdate').textContent =
        `עודכן: ${now.toLocaleTimeString('he-IL')}`;
}

// ========== INIT ==========

async function init() {
    document.getElementById('loadingOverlay').classList.remove('hidden');

    // Check if Supabase is configured and reachable
    const useSupabase = await checkSupabaseConnection();

    if (useSupabase) {
        console.log('Loading data from Supabase...');
        clients = await supaFetchClients();
        // Fetch real market prices on first load
        await updatePricesFromAPI();
    } else {
        console.log('Loading data from backend API...');
        clients = await fetchClients();
    }

    renderSummaryBar();
    renderExposureSection();
    renderClientCards();
    await checkAlerts();
    renderAlerts();
    updateUserDisplay();

    const now = new Date();
    document.getElementById('lastUpdate').textContent =
        `עודכן: ${now.toLocaleTimeString('he-IL')}`;

    document.getElementById('loadingOverlay').classList.add('hidden');

    // Restore state from URL query params (persistent routing)
    restoreStateFromURL();

    // Auto-refresh every 5 minutes (to respect FMP API daily limit of 250 calls)
    setInterval(refreshAllPrices, 300000);
}

// ========== PERSISTENT STATE (URL QUERY PARAMS) ==========

function updateURLState(params) {
    const url = new URL(window.location);
    // Clear all state params first
    url.searchParams.delete('view');
    url.searchParams.delete('client');
    url.searchParams.delete('tab');

    // Set new params
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

// Check authentication on page load
async function checkAuthAndInit() {
    // Verify authenticated user via Supabase (server-validated, not just session cache)
    const { data: { user }, error } = await supabaseClient.auth.getUser();

    if (user && !error) {
        // Get session for access token
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            saveToken(session.access_token);
        }

        const username = user.user_metadata?.full_name
            || user.user_metadata?.username
            || user.email;
        saveUser({ id: user.id, username });

        init();
    } else if (isLoggedIn()) {
        // Fallback to localStorage token (backend API mode)
        init();
    } else {
        showLoginForm();
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

checkAuthAndInit();
