// ========== MACRO - Live Economic Indicators & Market News ==========
//
// Data Sources:
//   1. FMP Economic Calendar API — real economic indicator releases (CPI, PPI, GDP, etc.)
//   2. Finnhub Market News API — rolling daily general market news feed
//
// Caching: localStorage with 1-hour TTL for indicators, 30-min for news
//          Cache is invalidated if it contains stale/simulated data.
// Alerts:  Smart — only counts events newer than the last time the user opened the page,
//          and never alerts for data older than 24 hours.

const _MACRO_CACHE_KEY_INDICATORS = 'macro_indicators_cache';
const _MACRO_CACHE_KEY_NEWS = 'macro_news_cache';
const _MACRO_CACHE_KEY_LAST_SEEN = 'macro_last_seen_event';  // {date, event} of newest seen
const _MACRO_CACHE_TTL_INDICATORS = 60 * 60 * 1000;   // 1 hour
const _MACRO_CACHE_TTL_NEWS = 30 * 60 * 1000;          // 30 minutes

// Active tab state
let _macroActiveTab = 'indicators';

// API health status — set during fetch, displayed in UI
let _macroApiStatus = { fmp: null, finnhub: null }; // null = unknown, true = ok, false = failed, string = error msg

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
        // Invalidate cache that contains stale/simulated data from old code
        if (cached.data && Array.isArray(cached.data) && cached.data.length > 0) {
            const first = cached.data[0];
            if (first.source === 'Simulated' || (first.id && String(first.id).startsWith('fallback-'))) {
                console.log('[Macro] Purging stale simulated cache');
                localStorage.removeItem(key);
                return null;
            }
        }
        return cached.data;
    } catch { return null; }
}

function _macroSetCache(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch { /* quota exceeded — ignore */ }
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

// ========== CATEGORY MATCHING ==========
// FMP event names often include suffixes like "YoY", "MoM", "QoQ", "Adv", "Final", "Prel"
// and may not match MACRO_CATEGORY_MAP keys exactly. We use a two-pass strategy:
//   1. Direct substring match:  event.includes(key)
//   2. Keyword extraction:      match individual words from the map key

function _matchCategory(eventName) {
    if (!eventName) return 'כלכלה';

    // Pass 1: direct — check if any map key is a substring of the event name
    // Sort keys longest-first so "Core Inflation Rate" matches before "Inflation Rate"
    const sortedKeys = Object.keys(MACRO_CATEGORY_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        if (eventName.includes(key)) return MACRO_CATEGORY_MAP[key];
    }

    // Pass 2: keyword — normalize and check for primary keyword matches
    const lower = eventName.toLowerCase();
    if (lower.includes('cpi') || lower.includes('inflation') || lower.includes('pce') || lower.includes('ppi') || lower.includes('producer price')) return 'אינפלציה';
    if (lower.includes('gdp') || lower.includes('growth rate')) return 'צמיחה';
    if (lower.includes('payroll') || lower.includes('employment') || lower.includes('jobless') || lower.includes('unemployment')) return 'תעסוקה';
    if (lower.includes('interest rate') || lower.includes('fed') || lower.includes('fomc')) return 'מדיניות מוניטרית';
    if (lower.includes('pmi') || lower.includes('manufacturing') || lower.includes('industrial') || lower.includes('durable')) return 'ייצור';
    if (lower.includes('retail') || lower.includes('spending') || lower.includes('personal income') || lower.includes('consumer credit')) return 'צריכה';
    if (lower.includes('housing') || lower.includes('building') || lower.includes('home sale')) return 'נדל"ן';
    if (lower.includes('confidence') || lower.includes('sentiment')) return 'סנטימנט';
    if (lower.includes('trade balance') || lower.includes('export') || lower.includes('import')) return 'סחר';

    return 'כלכלה';
}

// ========== 1. ECONOMIC INDICATORS (FMP) ==========

async function _fetchEconomicIndicators(forceRefresh = false) {
    // Check cache first (unless forcing)
    if (!forceRefresh) {
        const cached = _macroGetCache(_MACRO_CACHE_KEY_INDICATORS, _MACRO_CACHE_TTL_INDICATORS);
        if (cached && cached.length > 0) {
            console.log(`[Macro] Using cached economic indicators (${cached.length} items)`);
            _macroApiStatus.fmp = true;
            return cached;
        }
    }

    // Validate API key
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') {
        const msg = 'FMP_API_KEY not configured';
        console.warn(`[Macro] ${msg}`);
        _macroApiStatus.fmp = msg;
        return null;
    }

    try {
        // Fetch last 30 days of economic calendar data (focused window = faster + more relevant)
        const now = new Date();
        const from = new Date(now);
        from.setDate(from.getDate() - 30);
        const toStr = now.toISOString().split('T')[0];
        const fromStr = from.toISOString().split('T')[0];

        const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromStr}&to=${toStr}&apikey=${FMP_API_KEY}`;
        console.log(`[Macro] Fetching FMP economic calendar: ${fromStr} → ${toStr}`);

        const res = await _macroFetchWithTimeout(url, 10000);

        if (!res.ok) {
            const msg = `FMP HTTP ${res.status}`;
            console.warn(`[Macro] ${msg}`);
            _macroApiStatus.fmp = msg;
            throw new Error(msg);
        }

        const data = await res.json();
        console.log(`[Macro] FMP raw response: ${Array.isArray(data) ? data.length : 'non-array'} items`);

        if (!Array.isArray(data) || data.length === 0) {
            _macroApiStatus.fmp = 'Empty response';
            throw new Error('Empty response from FMP');
        }

        // Filter: US events with actual values
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
                const category = _matchCategory(eventName);

                const actual = item.actual !== null && item.actual !== '' ? String(item.actual) : 'N/A';
                const estimate = item.estimate !== null && item.estimate !== '' ? String(item.estimate) : 'N/A';
                const previous = item.previous !== null && item.previous !== '' ? String(item.previous) : 'N/A';

                // Determine beat/miss
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
                    change: item.change !== null && item.change !== undefined ? String(item.change) : null,
                    changePercent: item.changePercentage !== null && item.changePercentage !== undefined ? String(item.changePercentage) : null,
                    sentiment,
                    date: eventDate.toLocaleDateString('he-IL'),
                    time: eventDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    rawDate: eventDate.toISOString(),
                    isRead: false   // will be resolved in checkAlerts()
                };
            })
            .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate))
            .slice(0, 50);

        _macroSetCache(_MACRO_CACHE_KEY_INDICATORS, usEvents);
        _macroApiStatus.fmp = true;
        console.log(`[Macro] ✓ Fetched ${usEvents.length} economic indicators from FMP (${data.length} raw → ${usEvents.length} filtered)`);
        return usEvents;

    } catch (e) {
        console.warn('[Macro] FMP economic calendar failed:', e.message);
        if (_macroApiStatus.fmp === null) _macroApiStatus.fmp = e.message;
        return null;
    }
}

// ========== 2. MARKET NEWS (Finnhub) ==========

async function _fetchMarketNews(forceRefresh = false) {
    if (!forceRefresh) {
        const cached = _macroGetCache(_MACRO_CACHE_KEY_NEWS, _MACRO_CACHE_TTL_NEWS);
        if (cached && cached.length > 0) {
            console.log(`[Macro] Using cached market news (${cached.length} items)`);
            _macroApiStatus.finnhub = true;
            return cached;
        }
    }

    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY' || FINNHUB_API_KEY === '') {
        const msg = 'FINNHUB_API_KEY not configured';
        console.warn(`[Macro] ${msg}`);
        _macroApiStatus.finnhub = msg;
        return null;
    }

    try {
        console.log('[Macro] Fetching Finnhub market news...');
        const res = await _macroFetchWithTimeout(
            `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`,
            10000
        );

        if (!res.ok) {
            const msg = `Finnhub HTTP ${res.status}`;
            console.warn(`[Macro] ${msg}`);
            _macroApiStatus.finnhub = msg;
            throw new Error(msg);
        }

        const data = await res.json();
        console.log(`[Macro] Finnhub raw response: ${Array.isArray(data) ? data.length : 'non-array'} items`);

        if (!Array.isArray(data) || data.length === 0) {
            _macroApiStatus.finnhub = 'Empty response';
            throw new Error('Empty response from Finnhub');
        }

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
                rawDate: dt.toISOString(),
                isRead: false   // resolved in checkAlerts()
            };
        });

        _macroSetCache(_MACRO_CACHE_KEY_NEWS, news);
        _macroApiStatus.finnhub = true;
        console.log(`[Macro] ✓ Fetched ${news.length} news items from Finnhub`);
        return news;

    } catch (e) {
        console.warn('[Macro] Finnhub news failed:', e.message);
        if (_macroApiStatus.finnhub === null) _macroApiStatus.finnhub = e.message;
        return null;
    }
}

// ========== SMART ALERT LOGIC ==========
// Only mark as "unread" if:
//   1. The event is newer than the last time the user opened the macro page
//   2. The event is less than 24 hours old
// This prevents the badge from showing stale data every time the page loads.

function _resolveReadState(items) {
    if (!items || items.length === 0) return;

    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;

    // Load last-seen marker: the newest event date+name seen when user last opened macro page
    let lastSeen = null;
    try {
        const raw = localStorage.getItem(_MACRO_CACHE_KEY_LAST_SEEN);
        if (raw) lastSeen = JSON.parse(raw);
    } catch { /* ignore */ }

    const lastSeenDate = lastSeen ? new Date(lastSeen.date).getTime() : 0;

    items.forEach(item => {
        const itemDate = new Date(item.rawDate).getTime();

        // Already explicitly read by user → always read
        if (readAlertIds.includes(item.id)) {
            item.isRead = true;
            return;
        }

        // Older than 24h → auto-read (stale)
        if (itemDate < cutoff24h) {
            item.isRead = true;
            return;
        }

        // Older than or equal to last seen event → read
        if (lastSeenDate > 0 && itemDate <= lastSeenDate) {
            item.isRead = true;
            return;
        }

        // Truly new event
        item.isRead = false;
    });
}

// Called when user opens macro page — marks current newest event as "seen"
function _updateLastSeenEvent() {
    const allItems = [...alerts, ...(window._macroNews || [])];
    if (allItems.length === 0) return;

    // Find the newest event
    let newest = allItems[0];
    for (const item of allItems) {
        if (new Date(item.rawDate) > new Date(newest.rawDate)) newest = item;
    }

    try {
        localStorage.setItem(_MACRO_CACHE_KEY_LAST_SEEN, JSON.stringify({
            date: newest.rawDate,
            event: newest.id
        }));
    } catch { /* ignore */ }
}

// ========== MAIN DATA LOADER ==========

async function checkAlerts(forceRefresh = false) {
    const [indicators, news] = await Promise.all([
        _fetchEconomicIndicators(forceRefresh),
        _fetchMarketNews(forceRefresh)
    ]);

    // alerts = economic indicators (used for badge count)
    alerts = indicators || [];
    window._macroNews = news || [];

    // Resolve read/unread state using smart logic
    _resolveReadState(alerts);
    _resolveReadState(window._macroNews);

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
    // Count unread across both indicators AND news
    const unreadIndicators = alerts.filter(a => !a.isRead).length;
    const unreadNews = (window._macroNews || []).filter(a => !a.isRead).length;
    const unreadCount = unreadIndicators + unreadNews;
    countEl.textContent = unreadCount;
    countEl.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    const alert = alerts.find(a => a.id === alertId)
        || (window._macroNews || []).find(a => a.id === alertId);
    if (alert && !alert.isRead) {
        alert.isRead = true;
        if (!readAlertIds.includes(alertId)) {
            readAlertIds.push(alertId);
            localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
        }
        const cardEl = document.querySelector(`[data-alert-id="${CSS.escape(alertId)}"]`);
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

    // Mark current newest event as "seen" — future alerts only for newer events
    _updateLastSeenEvent();

    _renderMacroPageContent();
    macroPage.classList.add('active');

    if (typeof updateURLState === 'function') {
        updateURLState({ view: 'macro' });
    }
}

// ── API Status Indicator ──
function _renderApiStatus() {
    const fmpOk = _macroApiStatus.fmp === true;
    const finnhubOk = _macroApiStatus.finnhub === true;
    const fmpMsg = fmpOk ? 'מחובר' : (_macroApiStatus.fmp || 'לא מחובר');
    const finnhubMsg = finnhubOk ? 'מחובר' : (_macroApiStatus.finnhub || 'לא מחובר');

    return `<div class="macro-api-status">
        <span class="macro-api-dot ${fmpOk ? 'ok' : 'err'}"></span>
        <span>FMP: ${_macroEscape(String(fmpMsg))}</span>
        <span class="macro-api-sep">|</span>
        <span class="macro-api-dot ${finnhubOk ? 'ok' : 'err'}"></span>
        <span>Finnhub: ${_macroEscape(String(finnhubMsg))}</span>
    </div>`;
}

function _renderMacroPageContent() {
    const macroPage = document.getElementById('macroPage');

    const indicatorCount = alerts.length;
    const newsCount = (window._macroNews || []).length;
    const unreadIndicators = alerts.filter(a => !a.isRead).length;
    const unreadNews = (window._macroNews || []).filter(a => !a.isRead).length;

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
            ${_renderApiStatus()}
            <div class="macro-tabs">
                <button class="macro-tab ${_macroActiveTab === 'indicators' ? 'active' : ''}" onclick="_switchMacroTab('indicators')">
                    אינדיקטורים כלכליים
                    <span class="macro-tab-count">${indicatorCount}</span>
                    ${unreadIndicators > 0 ? `<span class="macro-tab-badge">${unreadIndicators} חדשים</span>` : ''}
                </button>
                <button class="macro-tab ${_macroActiveTab === 'news' ? 'active' : ''}" onclick="_switchMacroTab('news')">
                    חדשות שוק
                    <span class="macro-tab-count">${newsCount}</span>
                    ${unreadNews > 0 ? `<span class="macro-tab-badge">${unreadNews} חדשים</span>` : ''}
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
            <div class="macro-empty-text">עדכון בתהליך</div>
            <div class="macro-empty-sub">לחץ "רענן נתונים" לטעון אינדיקטורים כלכליים</div>
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
            <div class="macro-empty-text">עדכון בתהליך</div>
            <div class="macro-empty-sub">לחץ "רענן נתונים" לטעון חדשות שוק</div>
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

    // Reset API status before refetch
    _macroApiStatus = { fmp: null, finnhub: null };

    await checkAlerts(true);
    renderAlerts();

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
    _updateLastSeenEvent();
    renderAlerts();
    if (document.getElementById('macroPage')?.classList.contains('active')) {
        _renderMacroPageContent();
    }
}

function closeMacroPage() {
    // Update last-seen so these events don't trigger alerts again
    _updateLastSeenEvent();

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
