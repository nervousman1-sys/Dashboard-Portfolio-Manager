// ========== MACRO - Live Economic Indicators & Market News ==========
//
// Data Sources:
//   1. FMP Economic Calendar API — real economic indicator releases (CPI, PPI, GDP, etc.)
//   2. Finnhub Market News API — rolling daily general market news feed
//
// Caching: localStorage with 1-hour TTL for indicators, 30-min for news
// Fallback: graceful per-section error messages (never breaks the whole page)

const _MACRO_CACHE_KEY_INDICATORS = 'macro_indicators_cache';
const _MACRO_CACHE_KEY_NEWS = 'macro_news_cache';
const _MACRO_CACHE_TTL_INDICATORS = 60 * 60 * 1000;   // 1 hour
const _MACRO_CACHE_TTL_NEWS = 30 * 60 * 1000;          // 30 minutes

// Active tab state
let _macroActiveTab = 'indicators';

// ── HTML entity escaping (prevent XSS from external API data) ──
function _macroEscape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Fetch with timeout (local utility) ──
function _macroFetchWithTimeout(url, ms = 8000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// ── localStorage cache helpers ──
function _macroGetCache(key, ttl) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (Date.now() - cached.timestamp > ttl) return null;
        return cached.data;
    } catch { return null; }
}

function _macroSetCache(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch { /* quota exceeded — ignore */ }
}

// ========== 1. ECONOMIC INDICATORS (FMP) ==========

async function _fetchEconomicIndicators(forceRefresh = false) {
    // Check cache first
    if (!forceRefresh) {
        const cached = _macroGetCache(_MACRO_CACHE_KEY_INDICATORS, _MACRO_CACHE_TTL_INDICATORS);
        if (cached) {
            console.log('[Macro] Using cached economic indicators');
            return cached;
        }
    }

    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') {
        console.warn('[Macro] FMP_API_KEY not configured');
        return null;
    }

    try {
        // Fetch last 3 months of economic calendar data
        const now = new Date();
        const from = new Date(now);
        from.setMonth(from.getMonth() - 3);
        const toStr = now.toISOString().split('T')[0];
        const fromStr = from.toISOString().split('T')[0];

        const res = await _macroFetchWithTimeout(
            `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromStr}&to=${toStr}&apikey=${FMP_API_KEY}`
        );
        if (!res.ok) throw new Error(`FMP returned ${res.status}`);
        const data = await res.json();

        if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');

        // Filter: US events with actual values, important ones first
        const usEvents = data
            .filter(item =>
                item.country === 'US' &&
                item.actual !== null &&
                item.actual !== '' &&
                item.event
            )
            .map(item => {
                const eventDate = new Date(item.date);
                const eventName = item.event || '';
                // Match category from MACRO_CATEGORY_MAP — try event name and partial matches
                let category = 'כלכלה';
                for (const [key, val] of Object.entries(MACRO_CATEGORY_MAP)) {
                    if (eventName.includes(key) || key.includes(eventName.split(' ')[0])) {
                        category = val;
                        break;
                    }
                }

                const actual = item.actual !== null && item.actual !== '' ? String(item.actual) : 'N/A';
                const estimate = item.estimate !== null && item.estimate !== '' ? String(item.estimate) : 'N/A';
                const previous = item.previous !== null && item.previous !== '' ? String(item.previous) : 'N/A';

                // Determine beat/miss/inline
                let sentiment = 'neutral';
                if (actual !== 'N/A' && estimate !== 'N/A') {
                    const a = parseFloat(actual);
                    const e = parseFloat(estimate);
                    if (!isNaN(a) && !isNaN(e)) {
                        if (a > e) sentiment = 'beat';
                        else if (a < e) sentiment = 'miss';
                    }
                }

                const alertId = `fmp-${eventName}-${item.date}`;
                return {
                    id: alertId,
                    title: eventName,
                    category,
                    actual,
                    estimate,
                    previous,
                    change: item.change !== null ? String(item.change) : null,
                    changePercent: item.changePercentage !== null ? String(item.changePercentage) : null,
                    sentiment,
                    date: eventDate.toLocaleDateString('he-IL'),
                    time: eventDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    rawDate: eventDate,
                    isRead: readAlertIds.includes(alertId)
                };
            })
            .sort((a, b) => b.rawDate - a.rawDate)
            .slice(0, 50);

        _macroSetCache(_MACRO_CACHE_KEY_INDICATORS, usEvents);
        console.log(`[Macro] Fetched ${usEvents.length} economic indicators from FMP`);
        return usEvents;

    } catch (e) {
        console.warn('[Macro] FMP economic calendar failed:', e.message);
        return null;
    }
}

// ========== 2. MARKET NEWS (Finnhub) ==========

async function _fetchMarketNews(forceRefresh = false) {
    if (!forceRefresh) {
        const cached = _macroGetCache(_MACRO_CACHE_KEY_NEWS, _MACRO_CACHE_TTL_NEWS);
        if (cached) {
            console.log('[Macro] Using cached market news');
            return cached;
        }
    }

    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY') {
        console.warn('[Macro] FINNHUB_API_KEY not configured');
        return null;
    }

    try {
        const res = await _macroFetchWithTimeout(
            `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`
        );
        if (!res.ok) throw new Error(`Finnhub returned ${res.status}`);
        const data = await res.json();

        if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');

        const news = data.slice(0, 30).map(item => {
            const dt = new Date(item.datetime * 1000);
            return {
                id: `news-${item.id}`,
                headline: item.headline || '',
                summary: item.summary || '',
                source: item.source || '',
                url: item.url || '',
                image: item.image || '',
                category: item.category || 'general',
                date: dt.toLocaleDateString('he-IL'),
                time: dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                rawDate: dt,
                isRead: readAlertIds.includes(`news-${item.id}`)
            };
        });

        _macroSetCache(_MACRO_CACHE_KEY_NEWS, news);
        console.log(`[Macro] Fetched ${news.length} news items from Finnhub`);
        return news;

    } catch (e) {
        console.warn('[Macro] Finnhub news failed:', e.message);
        return null;
    }
}

// ========== MAIN DATA LOADER ==========

async function checkAlerts(forceRefresh = false) {
    const [indicators, news] = await Promise.all([
        _fetchEconomicIndicators(forceRefresh),
        _fetchMarketNews(forceRefresh)
    ]);

    // alerts = economic indicators (used for badge count)
    alerts = indicators || [];

    // Store news separately
    window._macroNews = news || [];

    // If macro page is currently open, re-render it
    const macroPage = document.getElementById('macroPage');
    if (macroPage && macroPage.classList.contains('active')) {
        _renderMacroPageContent();
    }
}

// ========== RENDERING ==========

function renderAlerts() {
    const countEl = document.getElementById('alertCount');
    if (!countEl) return;
    const unreadCount = alerts.filter(a => !a.isRead).length;
    countEl.textContent = unreadCount;
    countEl.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    // Check both indicators and news
    const alert = alerts.find(a => a.id === alertId)
        || (window._macroNews || []).find(a => a.id === alertId);
    if (alert && !alert.isRead) {
        alert.isRead = true;
        if (!readAlertIds.includes(alertId)) {
            readAlertIds.push(alertId);
            localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
        }
        const cardEl = document.querySelector(`[data-alert-id="${alertId}"]`);
        if (cardEl) {
            cardEl.classList.remove('macro-unread');
            cardEl.classList.add('macro-read');
        }
        renderAlerts();
    }
}

function toggleAlerts() {
    const macroPage = document.getElementById('macroPage');

    // Hide main dashboard
    document.querySelector('.header').style.display = 'none';
    document.querySelector('.summary-bar').style.display = 'none';
    document.querySelector('.filters').style.display = 'none';
    const riskSummary = document.getElementById('riskMiniSummary');
    if (riskSummary) riskSummary.style.display = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display = 'none';

    _renderMacroPageContent();
    macroPage.classList.add('active');

    if (typeof updateURLState === 'function') {
        updateURLState({ view: 'macro' });
    }
}

function _renderMacroPageContent() {
    const macroPage = document.getElementById('macroPage');

    const indicatorCount = alerts.length;
    const newsCount = (window._macroNews || []).length;
    const unreadCount = alerts.filter(a => !a.isRead).length;

    // Cache timestamps for display
    const indicatorsCacheTime = _macroGetCacheTime(_MACRO_CACHE_KEY_INDICATORS);
    const newsCacheTime = _macroGetCacheTime(_MACRO_CACHE_KEY_NEWS);

    macroPage.innerHTML = `
        <div class="macro-page-header">
            <h1>חדשות מאקרו כלכלה</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="macro-back-btn" onclick="_refreshMacroData()" title="רענן נתונים">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">
                        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    רענן נתונים
                </button>
                <button class="macro-back-btn" onclick="markAllRead()">סמן הכל כנקרא</button>
                <button class="macro-back-btn" onclick="closeMacroPage()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">
            <div class="macro-tabs">
                <button class="macro-tab ${_macroActiveTab === 'indicators' ? 'active' : ''}" onclick="_switchMacroTab('indicators')">
                    אינדיקטורים כלכליים
                    <span class="macro-tab-count">${indicatorCount}</span>
                    ${unreadCount > 0 ? `<span class="macro-tab-badge">${unreadCount} חדשים</span>` : ''}
                </button>
                <button class="macro-tab ${_macroActiveTab === 'news' ? 'active' : ''}" onclick="_switchMacroTab('news')">
                    חדשות שוק
                    <span class="macro-tab-count">${newsCount}</span>
                </button>
            </div>
            <div class="macro-source-info">
                ${_macroActiveTab === 'indicators'
                    ? `מקור: Financial Modeling Prep | ${indicatorCount} אינדיקטורים${indicatorsCacheTime ? ` | עדכון אחרון: ${indicatorsCacheTime}` : ''}`
                    : `מקור: Finnhub | ${newsCount} כתבות${newsCacheTime ? ` | עדכון אחרון: ${newsCacheTime}` : ''}`
                }
            </div>
            <div id="macroTabContent">
                ${_macroActiveTab === 'indicators' ? _renderIndicatorsTab() : _renderNewsTab()}
            </div>
        </div>
    `;
}

function _macroGetCacheTime(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        const dt = new Date(cached.timestamp);
        return dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    } catch { return null; }
}

function _switchMacroTab(tab) {
    _macroActiveTab = tab;
    _renderMacroPageContent();
}

// ── Indicators Tab ──
function _renderIndicatorsTab() {
    if (!alerts || alerts.length === 0) {
        return `<div class="macro-empty-state">
            <div class="macro-empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div class="macro-empty-text">נתונים כלכליים אינם זמינים כרגע</div>
            <div class="macro-empty-sub">לחץ "רענן נתונים" לנסות שוב</div>
        </div>`;
    }

    let html = '<div class="macro-grid">';
    alerts.forEach(a => {
        const readClass = a.isRead ? 'macro-read' : 'macro-unread';
        const newBadge = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';

        // Beat/miss indicator
        let sentimentHTML = '';
        if (a.sentiment === 'beat') {
            sentimentHTML = '<span class="macro-sentiment macro-beat">עלה על התחזית</span>';
        } else if (a.sentiment === 'miss') {
            sentimentHTML = '<span class="macro-sentiment macro-miss">מתחת לתחזית</span>';
        }

        // Color the actual value based on beat/miss
        let actualColor = 'var(--text-primary)';
        if (a.sentiment === 'beat') actualColor = 'var(--accent-green, #22c55e)';
        else if (a.sentiment === 'miss') actualColor = 'var(--accent-red, #ef4444)';

        html += `
            <div class="macro-card ${readClass}" data-alert-id="${_macroEscape(a.id)}" onclick="markAlertRead('${_macroEscape(a.id)}')">
                <div class="macro-card-header">
                    <div class="macro-card-title">${_macroEscape(a.title)} ${newBadge}</div>
                    <div class="macro-card-category">${_macroEscape(a.category)}</div>
                </div>
                ${sentimentHTML}
                <div class="macro-card-data">
                    <div class="macro-data-item">
                        <div class="data-label">בפועל</div>
                        <div class="data-value" style="color:${actualColor}">${_macroEscape(a.actual)}</div>
                    </div>
                    <div class="macro-data-item">
                        <div class="data-label">תחזית</div>
                        <div class="data-value" style="color:var(--accent-blue)">${_macroEscape(a.estimate)}</div>
                    </div>
                    <div class="macro-data-item">
                        <div class="data-label">קודם</div>
                        <div class="data-value" style="color:var(--text-muted)">${_macroEscape(a.previous)}</div>
                    </div>
                </div>
                <div class="macro-card-time">
                    <span class="macro-live-badge">LIVE</span>
                    ${a.date} | ${a.time}
                </div>
            </div>`;
    });
    html += '</div>';
    return html;
}

// ── News Tab ──
function _renderNewsTab() {
    const news = window._macroNews || [];

    if (news.length === 0) {
        return `<div class="macro-empty-state">
            <div class="macro-empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1m2 13a2 2 0 0 1-2-2V7m2 13a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"/></svg>
            </div>
            <div class="macro-empty-text">חדשות שוק אינן זמינות כרגע</div>
            <div class="macro-empty-sub">לחץ "רענן נתונים" לנסות שוב</div>
        </div>`;
    }

    let html = '<div class="macro-news-grid">';
    news.forEach(n => {
        const readClass = n.isRead ? 'macro-read' : 'macro-unread';
        const summaryText = n.summary.length > 180
            ? n.summary.substring(0, 180) + '...'
            : n.summary;

        html += `
            <div class="macro-card macro-news-card ${readClass}" data-alert-id="${_macroEscape(n.id)}" onclick="markAlertRead('${_macroEscape(n.id)}')">
                ${n.image ? `<div class="macro-news-image" style="background-image:url('${_macroEscape(n.image)}')"></div>` : ''}
                <div class="macro-news-body">
                    <div class="macro-news-headline">${_macroEscape(n.headline)}</div>
                    ${summaryText ? `<div class="macro-news-summary">${_macroEscape(summaryText)}</div>` : ''}
                    <div class="macro-news-meta">
                        <span class="macro-live-badge">LIVE</span>
                        <span>${_macroEscape(n.source)}</span>
                        <span>${n.date} | ${n.time}</span>
                        ${n.url ? `<a href="${_macroEscape(n.url)}" target="_blank" rel="noopener" class="macro-news-link" onclick="event.stopPropagation()">קרא עוד →</a>` : ''}
                    </div>
                </div>
            </div>`;
    });
    html += '</div>';
    return html;
}

// ========== REFRESH ==========

async function _refreshMacroData() {
    const macroPage = document.getElementById('macroPage');
    const content = document.getElementById('macroTabContent');
    if (content) {
        content.innerHTML = `<div class="macro-loading">
            <div class="spinner" style="width:32px;height:32px;margin:40px auto"></div>
            <div style="text-align:center;color:var(--text-muted);margin-top:12px">טוען נתונים עדכניים...</div>
        </div>`;
    }

    await checkAlerts(true);
    renderAlerts();

    // Re-render if still on macro page
    if (macroPage && macroPage.classList.contains('active')) {
        _renderMacroPageContent();
    }
}

// ========== MARK ALL / CLOSE ==========

function markAllRead() {
    const allItems = [...alerts, ...(window._macroNews || [])];
    allItems.forEach(a => {
        if (!a.isRead) {
            a.isRead = true;
            if (!readAlertIds.includes(a.id)) readAlertIds.push(a.id);
        }
    });
    localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
    renderAlerts();
    // Refresh the page view
    if (document.getElementById('macroPage')?.classList.contains('active')) {
        _renderMacroPageContent();
    }
}

function closeMacroPage() {
    document.getElementById('macroPage').classList.remove('active');
    document.getElementById('macroPage').innerHTML = '';
    document.querySelector('.header').style.display = '';
    document.querySelector('.summary-bar').style.display = '';
    document.querySelector('.filters').style.display = '';
    const riskSummary = document.getElementById('riskMiniSummary');
    if (riskSummary) riskSummary.style.display = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
}
