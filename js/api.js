// ========== API - Backend API Client ==========

const API_BASE = 'http://localhost:3001/api';

// ========== AUTH HEADERS ==========

function authHeaders(includeContentType = true) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (includeContentType) headers['Content-Type'] = 'application/json';
    return headers;
}

// Handle 401 responses (expired/invalid token)
function handleAuthError(res) {
    if (res.status === 401) {
        logout();
        return true;
    }
    return false;
}

// ========== CLIENT API ==========

async function fetchClients() {
    const res = await fetch(`${API_BASE}/clients`, { headers: authHeaders(false) });
    if (handleAuthError(res)) return [];
    if (!res.ok) throw new Error('Failed to fetch clients');
    return res.json();
}

async function apiAddClient(name, risk) {
    const res = await fetch(`${API_BASE}/clients`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, risk })
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) throw new Error('Failed to add client');
    return res.json();
}

async function apiEditClient(id, name, risk) {
    const res = await fetch(`${API_BASE}/clients/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ name, risk })
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) throw new Error('Failed to edit client');
    return res.json();
}

async function apiDeleteClient(id) {
    const res = await fetch(`${API_BASE}/clients/${id}`, {
        method: 'DELETE',
        headers: authHeaders(false)
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) throw new Error('Failed to delete client');
    return res.json();
}

// ========== HOLDING API ==========

async function apiAddHolding(clientId, holdingData) {
    const res = await fetch(`${API_BASE}/clients/${clientId}/holdings`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(holdingData)
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) throw new Error('Failed to add holding');
    return res.json();
}

async function apiEditHolding(clientId, holdingId, data) {
    const res = await fetch(`${API_BASE}/clients/${clientId}/holdings/${holdingId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(data)
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) throw new Error('Failed to edit holding');
    return res.json();
}

async function apiRemoveHolding(clientId, holdingId) {
    const res = await fetch(`${API_BASE}/clients/${clientId}/holdings/${holdingId}`, {
        method: 'DELETE',
        headers: authHeaders(false)
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) throw new Error('Failed to remove holding');
    return res.json();
}

// ========== PRICE API ==========

async function fetchStockPrice(ticker) {
    try {
        const res = await fetch(`${API_BASE}/prices/${ticker}`, { headers: authHeaders(false) });
        if (handleAuthError(res)) return null;
        if (!res.ok) return null;
        return res.json();
    } catch (e) {
        return null;
    }
}

async function fetchAllPrices(tickers) {
    try {
        const res = await fetch(`${API_BASE}/prices/batch`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ tickers })
        });
        if (handleAuthError(res)) return {};
        if (!res.ok) return {};
        return res.json();
    } catch (e) {
        return {};
    }
}

// Trigger server-side price refresh and re-fetch all clients
async function updatePricesForClients() {
    try {
        await fetch(`${API_BASE}/prices/refresh`, {
            method: 'POST',
            headers: authHeaders(false)
        });
        clients = await fetchClients();
    } catch (e) {
        console.warn('Price refresh failed:', e);
    }
}

// Keep generateSimulatedPrice for frontend fallback
function generateSimulatedPrice(ticker, baseMin = 20, baseMax = 500) {
    let hash = 0;
    for (let i = 0; i < ticker.length; i++) hash = ((hash << 5) - hash) + ticker.charCodeAt(i);
    const base = baseMin + (Math.abs(hash) % (baseMax - baseMin));
    const variation = (Math.random() - 0.5) * base * 0.04;
    const price = base + variation;
    const previousClose = price - (Math.random() - 0.5) * price * 0.03;
    return { price: Math.round(price * 100) / 100, previousClose: Math.round(previousClose * 100) / 100, currency: 'USD' };
}
