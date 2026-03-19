// ========== SERVICE WORKER - Stale-While-Revalidate Cache Strategy ==========

const CACHE_NAME = 'portfolio-dashboard-v50';

// Static assets to cache on install
const STATIC_ASSETS = [
    './',
    './index.html',
    './css/main.css',
    './css/auth.css',
    './js/env-config.js',
    './js/supabase-config.js',
    './js/supabase-api.js',
    './js/data.js',
    './js/app.js',
    './js/api.js',
    './js/price-service.js',
    './js/auth.js',
    './js/clients.js',
    './js/charts.js',
    './js/synthetic-history.js',
    './js/render.js',
    './js/filters.js',
    './js/file-parser.js',
    './js/modals.js',
    './js/portfolio.js',
    './js/macro.js',
    './js/init.js',
    './manifest.json'
];

// Hosts that should never be cached (APIs, auth, realtime)
const API_HOSTS = ['supabase.co', 'supabase.io', 'twelvedata.com', 'financialmodelingprep.com', 'finnhub.io', 'yahoo', 'tradingeconomics'];

// Install - pre-cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Critical files that MUST use network-first strategy.
// These contain auth logic, price protection, and state management — a stale
// cached version could cause the price overwrite loop or auth UI disappearance.
const NETWORK_FIRST_FILES = [
    'index.html',
    'auth.js',
    'init.js',
    'price-service.js',
    'supabase-config.js',
    'charts.js',
    'render.js',
    'synthetic-history.js',
    'filters.js',
    'modals.js'
];

// Check if a URL matches a network-first file
function _isNetworkFirst(pathname) {
    return NETWORK_FIRST_FILES.some(f => pathname.endsWith(f) || pathname === '/' || pathname === './');
}

// Fetch - network-first for critical files, stale-while-revalidate for rest
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // API calls - network only, never cache
    if (url.pathname.startsWith('/api/') || API_HOSTS.some(h => url.hostname.includes(h))) {
        event.respondWith(
            fetch(event.request).catch(() => {
                return new Response(JSON.stringify({ error: 'offline' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // CDN assets - cache-first (immutable versioned URLs)
    if (url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('cdnjs.cloudflare.com')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // CRITICAL FILES — NETWORK-FIRST with cache fallback
    // Always try to fetch the latest version from the server first.
    // Only fall back to cache if the network is unavailable.
    if (_isNetworkFirst(url.pathname)) {
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                return caches.match(event.request);
            })
        );
        return;
    }

    // Other static assets - STALE-WHILE-REVALIDATE
    // Serve from cache immediately, fetch fresh version in background
    event.respondWith(
        caches.match(event.request).then((cached) => {
            const fetchPromise = fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => cached);

            // Return cached immediately if available, otherwise wait for network
            return cached || fetchPromise;
        })
    );
});
