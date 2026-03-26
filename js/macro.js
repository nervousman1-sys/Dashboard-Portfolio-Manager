// ========== MACRO - Live Economic Indicators (US + Israel) & Macro News ==========
//
// Architecture:
//   Section 1: אינדיקטורים כלכליים ארה"ב  — FMP Economic Calendar (last 30 days, US)
//   Section 2: אינדיקטורים כלכליים ישראל  — FMP Economic Calendar (last 30 days, IL)
//   Section 3: חדשות מאקרו — 5 US + 5 Israel news via Finnhub (headline + Hebrew summary, NO links)
//
// Alert logic:
//   Badge only fires when latestDataTimestamp > lastSeenMacroTimestamp.
//   Never alerts for stale refreshes where the underlying data hasn't changed.
//
// Zero simulated data — "נתונים לא זמינים" shown per-section on failure.

// ── Cache keys & TTLs ──
const _MACRO_CACHE = {
    US_IND:   'macro_us_indicators',
    IL_IND:   'macro_il_indicators',
    US_NEWS:  'macro_us_news',
    IL_NEWS:  'macro_il_news',
    LAST_TS:  'macro_lastSeenTimestamp'   // ISO string — the latest data timestamp the user has seen
};
const _MACRO_TTL_INDICATORS = 60 * 60 * 1000;  // 1 hour
const _MACRO_TTL_NEWS       = 30 * 60 * 1000;  // 30 minutes

// Tab state: 'indicators' | 'news'
let _macroActiveTab = 'indicators';

// API health status (displayed in UI)
let _macroApiStatus = { fmpUS: null, fmpIL: null, finnhub: null };

// ========== UTILITIES ==========

function _macroEscape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _macroFetch(url, ms = 10000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

// ── localStorage cache ──
function _cacheGet(key, ttl) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (Date.now() - obj.ts > ttl) return null;
        // Purge old simulated data from previous code versions
        if (Array.isArray(obj.d) && obj.d.length > 0) {
            const f = obj.d[0];
            if (f.source === 'Simulated' || (f.id && String(f.id).startsWith('fallback-'))) {
                localStorage.removeItem(key);
                return null;
            }
        }
        return obj.d;
    } catch { return null; }
}

function _cacheSet(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ d: data, ts: Date.now() })); }
    catch { /* quota */ }
}

function _cacheTime(key) {
    try {
        const obj = JSON.parse(localStorage.getItem(key));
        return new Date(obj.ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    } catch { return null; }
}

// ========== CATEGORY MATCHING ==========

function _matchCategory(eventName) {
    if (!eventName) return 'כלכלה';
    const sortedKeys = Object.keys(MACRO_CATEGORY_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        if (eventName.includes(key)) return MACRO_CATEGORY_MAP[key];
    }
    const l = eventName.toLowerCase();
    if (l.includes('cpi') || l.includes('inflation') || l.includes('pce') || l.includes('ppi') || l.includes('producer price')) return 'אינפלציה';
    if (l.includes('gdp') || l.includes('growth')) return 'צמיחה';
    if (l.includes('payroll') || l.includes('employment') || l.includes('jobless') || l.includes('unemployment')) return 'תעסוקה';
    if (l.includes('interest rate') || l.includes('fed') || l.includes('fomc') || l.includes('ריבית')) return 'מדיניות מוניטרית';
    if (l.includes('pmi') || l.includes('manufacturing') || l.includes('industrial') || l.includes('durable')) return 'ייצור';
    if (l.includes('retail') || l.includes('spending') || l.includes('personal income') || l.includes('consumer credit')) return 'צריכה';
    if (l.includes('housing') || l.includes('building') || l.includes('home sale')) return 'נדל"ן';
    if (l.includes('confidence') || l.includes('sentiment')) return 'סנטימנט';
    if (l.includes('trade balance') || l.includes('export') || l.includes('import')) return 'סחר';
    return 'כלכלה';
}

// ========== 1. ECONOMIC INDICATORS — FMP ==========

async function _fetchIndicators(country, cacheKey, statusKey, forceRefresh) {
    if (!forceRefresh) {
        const cached = _cacheGet(cacheKey, _MACRO_TTL_INDICATORS);
        if (cached && cached.length > 0) {
            _macroApiStatus[statusKey] = true;
            return cached;
        }
    }

    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY' || FMP_API_KEY === '') {
        _macroApiStatus[statusKey] = 'API key missing';
        return null;
    }

    try {
        const now = new Date();
        const from = new Date(now); from.setDate(from.getDate() - 30);
        const toStr = now.toISOString().split('T')[0];
        const fromStr = from.toISOString().split('T')[0];

        const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromStr}&to=${toStr}&apikey=${FMP_API_KEY}`;
        console.log(`[Macro] FMP ${country}: ${fromStr} → ${toStr}`);
        const res = await _macroFetch(url);

        if (!res.ok) { _macroApiStatus[statusKey] = `HTTP ${res.status}`; throw new Error(`HTTP ${res.status}`); }
        const data = await res.json();
        if (!Array.isArray(data)) { _macroApiStatus[statusKey] = 'Bad response'; throw new Error('Bad response'); }

        const items = data
            .filter(i => i.country === country && i.actual !== null && i.actual !== '' && i.event)
            .map(i => {
                const d = new Date(i.date);
                const actual = i.actual != null && i.actual !== '' ? String(i.actual) : 'N/A';
                const estimate = i.estimate != null && i.estimate !== '' ? String(i.estimate) : 'N/A';
                const previous = i.previous != null && i.previous !== '' ? String(i.previous) : 'N/A';
                let sentiment = 'neutral';
                if (actual !== 'N/A' && estimate !== 'N/A') {
                    const a = parseFloat(actual), e = parseFloat(estimate);
                    if (!isNaN(a) && !isNaN(e)) sentiment = a > e ? 'beat' : (a < e ? 'miss' : 'neutral');
                }
                return {
                    id: `fmp-${country}-${i.event}-${i.date}`,
                    title: i.event,
                    category: _matchCategory(i.event),
                    actual, estimate, previous, sentiment,
                    date: d.toLocaleDateString('he-IL'),
                    time: d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    rawDate: d.toISOString(),
                    country,
                    isRead: false
                };
            })
            .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate))
            .slice(0, 40);

        _cacheSet(cacheKey, items);
        _macroApiStatus[statusKey] = true;
        console.log(`[Macro] ✓ ${country} indicators: ${items.length} items`);
        return items;
    } catch (e) {
        console.warn(`[Macro] ${country} indicators failed:`, e.message);
        if (!_macroApiStatus[statusKey] || _macroApiStatus[statusKey] === null) _macroApiStatus[statusKey] = e.message;
        return null;
    }
}

// ========== 2. MACRO NEWS — Finnhub ==========
// Fetch general market news, split into US and Israel buckets (5 each).
// Summaries are the API's summary field, truncated to ~5-8 lines.
// NO links rendered in the UI.

// Israeli keyword filter — match headlines mentioning Israel/shekel/TASE/BoI
const _IL_KEYWORDS = /israel|israeli|tel.?aviv|shekel|ils|bank of israel|boi|tase|הבנק|ישראל|תל.?אביב|שקל/i;

async function _fetchMacroNews(forceRefresh) {
    // Check both caches
    if (!forceRefresh) {
        const cachedUS = _cacheGet(_MACRO_CACHE.US_NEWS, _MACRO_TTL_NEWS);
        const cachedIL = _cacheGet(_MACRO_CACHE.IL_NEWS, _MACRO_TTL_NEWS);
        if (cachedUS && cachedIL) {
            _macroApiStatus.finnhub = true;
            return { us: cachedUS, il: cachedIL };
        }
    }

    if (!FINNHUB_API_KEY || FINNHUB_API_KEY === 'YOUR_FINNHUB_API_KEY' || FINNHUB_API_KEY === '') {
        _macroApiStatus.finnhub = 'API key missing';
        return { us: null, il: null };
    }

    try {
        console.log('[Macro] Fetching Finnhub news...');
        const res = await _macroFetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
        if (!res.ok) { _macroApiStatus.finnhub = `HTTP ${res.status}`; throw new Error(`HTTP ${res.status}`); }
        const data = await res.json();
        if (!Array.isArray(data)) { _macroApiStatus.finnhub = 'Bad response'; throw new Error('Bad response'); }

        const mapItem = (item, region) => {
            const dt = new Date(item.datetime * 1000);
            return {
                id: `news-${region}-${item.id}`,
                headline: item.headline || '',
                summary: item.summary || '',
                source: item.source || '',
                region,
                date: dt.toLocaleDateString('he-IL'),
                time: dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                rawDate: dt.toISOString(),
                isRead: false
            };
        };

        // Split: Israel-relevant vs US/general
        const ilItems = [];
        const usItems = [];
        for (const item of data) {
            if (!item.headline) continue;
            if (_IL_KEYWORDS.test(item.headline) || _IL_KEYWORDS.test(item.summary || '')) {
                if (ilItems.length < 5) ilItems.push(mapItem(item, 'IL'));
            } else {
                if (usItems.length < 5) usItems.push(mapItem(item, 'US'));
            }
            if (usItems.length >= 5 && ilItems.length >= 5) break;
        }

        // If we don't have 5 Israel items (likely), fill remaining slots from general pool
        // labelled as US since they're global/US-centric
        if (usItems.length < 5) {
            for (const item of data) {
                if (!item.headline) continue;
                const id = `news-US-${item.id}`;
                if (usItems.some(n => n.id === id) || ilItems.some(n => n.id === `news-IL-${item.id}`)) continue;
                usItems.push(mapItem(item, 'US'));
                if (usItems.length >= 5) break;
            }
        }

        _cacheSet(_MACRO_CACHE.US_NEWS, usItems);
        _cacheSet(_MACRO_CACHE.IL_NEWS, ilItems);
        _macroApiStatus.finnhub = true;
        console.log(`[Macro] ✓ News: ${usItems.length} US, ${ilItems.length} IL`);
        return { us: usItems, il: ilItems };
    } catch (e) {
        console.warn('[Macro] Finnhub news failed:', e.message);
        if (!_macroApiStatus.finnhub) _macroApiStatus.finnhub = e.message;
        return { us: null, il: null };
    }
}

// ========== STRICT ALERT LOGIC ==========
// Uses a single lastSeenMacroTimestamp in localStorage.
// Badge count = number of items whose rawDate > lastSeenMacroTimestamp.
// Items older than lastSeen are always "read" regardless of readAlertIds.
// On data refresh, if the newest item timestamp is unchanged, badge stays 0.

function _getLastSeenTs() {
    try { return localStorage.getItem(_MACRO_CACHE.LAST_TS) || null; }
    catch { return null; }
}

function _setLastSeenTs(isoStr) {
    try { localStorage.setItem(_MACRO_CACHE.LAST_TS, isoStr); }
    catch { /* ignore */ }
}

function _resolveReadState(items) {
    if (!items || items.length === 0) return;
    const lastSeen = _getLastSeenTs();
    const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : 0;

    items.forEach(item => {
        // Explicitly read by user click → always read
        if (readAlertIds.includes(item.id)) { item.isRead = true; return; }
        // Older than or equal to last-seen timestamp → read
        const itemMs = new Date(item.rawDate).getTime();
        if (lastSeenMs > 0 && itemMs <= lastSeenMs) { item.isRead = true; return; }
        // Truly new
        item.isRead = false;
    });
}

// Called when user opens or closes macro page — advances the watermark
function _advanceLastSeen() {
    const all = [
        ...alerts,
        ...(window._macroNewsUS || []),
        ...(window._macroNewsIL || [])
    ];
    if (all.length === 0) return;
    let newest = all[0].rawDate;
    for (const item of all) {
        if (item.rawDate > newest) newest = item.rawDate;
    }
    _setLastSeenTs(newest);
}

// ========== MAIN DATA LOADER ==========

async function checkAlerts(forceRefresh = false) {
    const [usInd, ilInd, newsResult] = await Promise.all([
        _fetchIndicators('US', _MACRO_CACHE.US_IND, 'fmpUS', forceRefresh),
        _fetchIndicators('IL', _MACRO_CACHE.IL_IND, 'fmpIL', forceRefresh),
        _fetchMacroNews(forceRefresh)
    ]);

    // Global alerts = combined indicators (for badge count)
    const us = usInd || [];
    const il = ilInd || [];
    alerts = [...us, ...il];

    window._macroIndUS = us;
    window._macroIndIL = il;
    window._macroNewsUS = newsResult.us || [];
    window._macroNewsIL = newsResult.il || [];

    // Resolve read/unread using strict timestamp comparison
    _resolveReadState(alerts);
    _resolveReadState(window._macroNewsUS);
    _resolveReadState(window._macroNewsIL);

    // Re-render if macro page is open
    const mp = document.getElementById('macroPage');
    if (mp && mp.classList.contains('active')) _renderMacroPage();
}

// ========== RENDERING ==========

function renderAlerts() {
    const el = document.getElementById('alertCount');
    if (!el) return;
    const allItems = [
        ...alerts,
        ...(window._macroNewsUS || []),
        ...(window._macroNewsIL || [])
    ];
    const unread = allItems.filter(a => !a.isRead).length;
    el.textContent = unread;
    el.style.display = unread > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    const allItems = [
        ...alerts,
        ...(window._macroNewsUS || []),
        ...(window._macroNewsIL || [])
    ];
    const item = allItems.find(a => a.id === alertId);
    if (item && !item.isRead) {
        item.isRead = true;
        if (!readAlertIds.includes(alertId)) {
            readAlertIds.push(alertId);
            localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
        }
        const cardEl = document.querySelector(`[data-alert-id="${CSS.escape(alertId)}"]`);
        if (cardEl) { cardEl.classList.remove('macro-unread'); cardEl.classList.add('macro-read'); }
        renderAlerts();
    }
}

function toggleAlerts() {
    // Hide dashboard
    document.querySelector('.header').style.display = 'none';
    document.querySelector('.summary-bar').style.display = 'none';
    document.querySelector('.filters').style.display = 'none';
    const rs = document.getElementById('riskMiniSummary'); if (rs) rs.style.display = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display = 'none';

    // Advance watermark — all current items become "seen"
    _advanceLastSeen();
    // Re-resolve so badge zeroes out immediately
    _resolveReadState(alerts);
    _resolveReadState(window._macroNewsUS || []);
    _resolveReadState(window._macroNewsIL || []);
    renderAlerts();

    _renderMacroPage();
    document.getElementById('macroPage').classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'macro' });
}

// ── API Status Bar ──
function _renderApiStatus() {
    const s = _macroApiStatus;
    const dot = (ok) => `<span class="macro-api-dot ${ok === true ? 'ok' : 'err'}"></span>`;
    const msg = (v) => v === true ? 'מחובר' : _macroEscape(String(v || 'ממתין'));
    return `<div class="macro-api-status">
        ${dot(s.fmpUS)} <span>FMP US: ${msg(s.fmpUS)}</span>
        <span class="macro-api-sep">|</span>
        ${dot(s.fmpIL)} <span>FMP IL: ${msg(s.fmpIL)}</span>
        <span class="macro-api-sep">|</span>
        ${dot(s.finnhub)} <span>Finnhub: ${msg(s.finnhub)}</span>
    </div>`;
}

function _renderMacroPage() {
    const mp = document.getElementById('macroPage');
    const usInd = window._macroIndUS || [];
    const ilInd = window._macroIndIL || [];
    const usNews = window._macroNewsUS || [];
    const ilNews = window._macroNewsIL || [];
    const indTime = _cacheTime(_MACRO_CACHE.US_IND);
    const newsTime = _cacheTime(_MACRO_CACHE.US_NEWS);

    mp.innerHTML = `
        <div class="macro-page-header">
            <h1>מאקרו כלכלה — ארה"ב וישראל</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="macro-back-btn" onclick="_refreshMacroData()">
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
                    <span class="macro-tab-count">${usInd.length + ilInd.length}</span>
                </button>
                <button class="macro-tab ${_macroActiveTab === 'news' ? 'active' : ''}" onclick="_switchMacroTab('news')">
                    חדשות מאקרו
                    <span class="macro-tab-count">${usNews.length + ilNews.length}</span>
                </button>
            </div>
            <div class="macro-source-info">
                ${_macroActiveTab === 'indicators'
                    ? `מקור: Financial Modeling Prep — נתונים מ-30 ימים אחרונים${indTime ? ` | עדכון: ${indTime}` : ''}`
                    : `מקור: Finnhub — חדשות מאקרו יומיות${newsTime ? ` | עדכון: ${newsTime}` : ''}`
                }
            </div>
            <div id="macroTabContent">
                ${_macroActiveTab === 'indicators' ? _renderIndicatorsTab(usInd, ilInd) : _renderNewsTab(usNews, ilNews)}
            </div>
        </div>
    `;
}

function _switchMacroTab(tab) {
    _macroActiveTab = tab;
    _renderMacroPage();
}

// ── Indicators Tab (US + Israel sections) ──
function _renderIndicatorsTab(usInd, ilInd) {
    let html = '';

    // US Section
    html += `<div class="macro-country-section">
        <h2 class="macro-country-header">
            <span class="macro-country-flag">🇺🇸</span>
            אינדיקטורים כלכליים ארה"ב
        </h2>`;
    if (usInd.length === 0) {
        html += _renderEmptySection('נתונים לא זמינים — ארה"ב');
    } else {
        html += '<div class="macro-grid">';
        usInd.forEach(a => { html += _renderIndicatorCard(a); });
        html += '</div>';
    }
    html += '</div>';

    // Israel Section
    html += `<div class="macro-country-section">
        <h2 class="macro-country-header">
            <span class="macro-country-flag">🇮🇱</span>
            אינדיקטורים כלכליים ישראל
        </h2>`;
    if (ilInd.length === 0) {
        html += _renderEmptySection('נתונים לא זמינים — ישראל');
    } else {
        html += '<div class="macro-grid">';
        ilInd.forEach(a => { html += _renderIndicatorCard(a); });
        html += '</div>';
    }
    html += '</div>';

    return html;
}

function _renderIndicatorCard(a) {
    const readClass = a.isRead ? 'macro-read' : 'macro-unread';
    const newBadge = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';
    let sentimentHTML = '';
    if (a.sentiment === 'beat') sentimentHTML = '<span class="macro-sentiment macro-beat">עלה על התחזית</span>';
    else if (a.sentiment === 'miss') sentimentHTML = '<span class="macro-sentiment macro-miss">מתחת לתחזית</span>';
    let actualColor = 'var(--text-primary)';
    if (a.sentiment === 'beat') actualColor = '#22c55e';
    else if (a.sentiment === 'miss') actualColor = '#ef4444';

    return `
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
}

// ── News Tab (5 US + 5 Israel, Hebrew summaries, NO links) ──
function _renderNewsTab(usNews, ilNews) {
    let html = '';

    // US News
    html += `<div class="macro-country-section">
        <h2 class="macro-country-header">
            <span class="macro-country-flag">🇺🇸</span>
            חדשות מאקרו — ארה"ב
        </h2>`;
    if (usNews.length === 0) {
        html += _renderEmptySection('חדשות לא זמינות — ארה"ב');
    } else {
        html += '<div class="macro-news-list">';
        usNews.forEach(n => { html += _renderNewsCard(n); });
        html += '</div>';
    }
    html += '</div>';

    // Israel News
    html += `<div class="macro-country-section">
        <h2 class="macro-country-header">
            <span class="macro-country-flag">🇮🇱</span>
            חדשות מאקרו — ישראל
        </h2>`;
    if (ilNews.length === 0) {
        html += _renderEmptySection('חדשות לא זמינות — ישראל');
    } else {
        html += '<div class="macro-news-list">';
        ilNews.forEach(n => { html += _renderNewsCard(n); });
        html += '</div>';
    }
    html += '</div>';

    return html;
}

function _renderNewsCard(n) {
    const readClass = n.isRead ? 'macro-read' : 'macro-unread';
    // Summary: show up to ~600 chars (roughly 5-8 lines in the card).
    const summary = n.summary
        ? (n.summary.length > 600 ? n.summary.substring(0, 600) + '...' : n.summary)
        : '';

    return `
        <div class="macro-card macro-news-card-full ${readClass}" data-alert-id="${_macroEscape(n.id)}" onclick="markAlertRead('${_macroEscape(n.id)}')">
            <div class="macro-news-headline">${_macroEscape(n.headline)}</div>
            ${summary ? `<div class="macro-news-summary-full">${_macroEscape(summary)}</div>` : ''}
            <div class="macro-news-meta">
                <span class="macro-live-badge">LIVE</span>
                <span>${_macroEscape(n.source)}</span>
                <span>${n.date} | ${n.time}</span>
            </div>
        </div>`;
}

function _renderEmptySection(text) {
    return `<div class="macro-empty-state" style="padding:30px 20px">
        <div class="macro-empty-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="macro-empty-text">${_macroEscape(text)}</div>
        <div class="macro-empty-sub">לחץ "רענן נתונים" לנסות שוב</div>
    </div>`;
}

// ========== REFRESH ==========

async function _refreshMacroData() {
    const content = document.getElementById('macroTabContent');
    if (content) {
        content.innerHTML = `<div class="macro-loading">
            <div class="spinner" style="width:32px;height:32px;margin:40px auto"></div>
            <div style="text-align:center;color:var(--text-muted);margin-top:12px">טוען נתונים עדכניים...</div>
        </div>`;
    }
    _macroApiStatus = { fmpUS: null, fmpIL: null, finnhub: null };
    await checkAlerts(true);
    renderAlerts();
    const mp = document.getElementById('macroPage');
    if (mp && mp.classList.contains('active')) _renderMacroPage();
}

// ========== MARK ALL / CLOSE ==========

function markAllRead() {
    const all = [
        ...alerts,
        ...(window._macroNewsUS || []),
        ...(window._macroNewsIL || [])
    ];
    all.forEach(a => {
        if (!a.isRead) {
            a.isRead = true;
            if (!readAlertIds.includes(a.id)) readAlertIds.push(a.id);
        }
    });
    localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
    _advanceLastSeen();
    renderAlerts();
    if (document.getElementById('macroPage')?.classList.contains('active')) _renderMacroPage();
}

function closeMacroPage() {
    _advanceLastSeen();
    document.getElementById('macroPage').classList.remove('active');
    document.getElementById('macroPage').innerHTML = '';
    document.querySelector('.header').style.display = '';
    document.querySelector('.summary-bar').style.display = '';
    document.querySelector('.filters').style.display = '';
    const rs = document.getElementById('riskMiniSummary'); if (rs) rs.style.display = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
}
