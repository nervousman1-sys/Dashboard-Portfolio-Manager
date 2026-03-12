// ========== SERVICE WORKER - Cache Strategy ==========

const CACHE_NAME = 'portfolio-dashboard-v15';

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
    './js/render.js',
    './js/filters.js',
    './js/modals.js',
    './js/portfolio.js',
    './js/macro.js',
    './js/init.js',
    './manifest.json'
];

// CDN libraries to cache on first fetch
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
    'https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js',
    'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js'
];

// Install - pre-cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    // Activate immediately without waiting for old SW to finish
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
    // Take control of all open pages immediately
    self.clients.claim();
});

// Fetch - network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // API calls (backend, Yahoo Finance, Trading Economics) - network only, no cache
    if (url.pathname.startsWith('/api/') || url.hostname.includes('yahoo') || url.hostname.includes('tradingeconomics')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                return new Response(JSON.stringify({ error: 'offline' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // CDN assets - cache on first use, then serve from cache
    if (url.hostname.includes('cdn.jsdelivr.net')) {
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

    // Static assets - network first, fallback to cache (ensures code updates are picked up)
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
});
