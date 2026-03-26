// ========== APP - Global State & Utility Functions ==========

// Price cache
let priceCache = {};
let clients = [];
let charts = {};
let activeFilters = { risk: 'all', asset: 'all', search: '', sector: 'all', returnMin: null, returnMax: null, sizeMin: null, sizeMax: null, sort: 'none' };
let currentModalClientId = null;
let fullscreenChartInstance = null;
let alerts = [];

// Read/unread state stored in localStorage
let readAlertIds = JSON.parse(localStorage.getItem('readMacroAlerts') || '[]');

// ========== UTILITY ==========

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function pickRandom(arr, n) {
    return shuffle(arr).slice(0, n);
}

function formatCurrency(val, currency = 'USD') {
    if (currency === 'ILS') {
        return val.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
    }
    return val.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatNumber(val) {
    return Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Format a price with thousands separators and 2 decimal places: 1250.5 → "1,250.50"
function formatPrice(val) {
    return Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
