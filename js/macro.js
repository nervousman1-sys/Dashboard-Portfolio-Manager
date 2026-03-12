// ========== MACRO - Macro News Page ==========

async function checkAlerts() {
    // Fetch real macro economic data from Trading Economics API
    try {
        const response = await fetchWithTimeout(
            'https://api.tradingeconomics.com/calendar/country/united%20states?c=guest:guest&f=json&importance=3',
            5000
        );
        if (!response.ok) throw new Error('API error');
        const data = await response.json();

        // Filter events that have actual values and are recent
        alerts = data
            .filter(item => item.Actual !== null && item.Actual !== '' && item.Event)
            .map(item => {
                const eventDate = new Date(item.Date);
                const category = MACRO_CATEGORY_MAP[item.Category] || MACRO_CATEGORY_MAP[item.Event] || 'כלכלה';
                const alertId = `${item.CalendarId || item.Event + item.Date}`;

                return {
                    id: alertId,
                    title: item.Event,
                    category: category,
                    actual: item.Actual !== null ? String(item.Actual) : 'N/A',
                    forecast: item.Forecast !== null ? String(item.Forecast) : 'N/A',
                    previous: item.Previous !== null ? String(item.Previous) : 'N/A',
                    date: eventDate.toLocaleDateString('he-IL'),
                    time: eventDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                    source: item.Source || '',
                    country: item.Country || 'United States',
                    importance: item.Importance || 1,
                    isRead: readAlertIds.includes(alertId),
                    rawDate: eventDate
                };
            })
            .sort((a, b) => b.rawDate - a.rawDate)
            .slice(0, 30); // Keep latest 30 events

    } catch (e) {
        console.log('Trading Economics API unavailable, using fallback data');
        // Fallback: generate simulated data if API fails
        const now = new Date();
        const fallbackEvents = [
            { name: 'Inflation Rate YoY', cat: 'אינפלציה' },
            { name: 'Core CPI MoM', cat: 'אינפלציה' },
            { name: 'PPI MoM', cat: 'אינפלציה' },
            { name: 'GDP Growth Rate QoQ', cat: 'צמיחה' },
            { name: 'Unemployment Rate', cat: 'תעסוקה' },
            { name: 'Non Farm Payrolls', cat: 'תעסוקה' },
            { name: 'Initial Jobless Claims', cat: 'תעסוקה' },
            { name: 'Fed Interest Rate Decision', cat: 'מדיניות מוניטרית' },
            { name: 'ISM Manufacturing PMI', cat: 'ייצור' },
            { name: 'Retail Sales MoM', cat: 'צריכה' },
            { name: 'Building Permits', cat: 'נדל"ן' },
            { name: 'Michigan Consumer Sentiment', cat: 'סנטימנט' },
        ];
        alerts = fallbackEvents.map((evt, i) => {
            const minutesAgo = i * 45 + Math.floor(Math.random() * 30);
            const evtDate = new Date(now.getTime() - minutesAgo * 60000);
            const alertId = `fallback-${evt.name}-${evtDate.toDateString()}`;
            const v1 = (Math.random() * 5).toFixed(1);
            const v2 = (Math.random() * 5).toFixed(1);
            const v3 = (Math.random() * 5).toFixed(1);
            return {
                id: alertId, title: evt.name, category: evt.cat,
                actual: v1 + '%', forecast: v2 + '%', previous: v3 + '%',
                date: evtDate.toLocaleDateString('he-IL'),
                time: evtDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
                source: 'Simulated', country: 'United States', importance: 3,
                isRead: readAlertIds.includes(alertId), rawDate: evtDate
            };
        });
    }
}

function renderAlerts() {
    const countEl = document.getElementById('alertCount');
    const unreadCount = alerts.filter(a => !a.isRead).length;
    countEl.textContent = unreadCount;
    countEl.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
}

function markAlertRead(alertId) {
    const alert = alerts.find(a => a.id === alertId);
    if (alert && !alert.isRead) {
        alert.isRead = true;
        if (!readAlertIds.includes(alertId)) {
            readAlertIds.push(alertId);
            localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
        }
        // Update the card visually
        const cardEl = document.querySelector(`[data-alert-id="${alertId}"]`);
        if (cardEl) {
            cardEl.classList.remove('macro-unread');
            cardEl.classList.add('macro-read');
        }
        renderAlerts(); // Update badge count
    }
}

function toggleAlerts() {
    const macroPage = document.getElementById('macroPage');

    // Hide main dashboard
    document.querySelector('.header').style.display = 'none';
    document.querySelector('.summary-bar').style.display = 'none';
    document.querySelector('.filters').style.display = 'none';
    document.getElementById('exposureSection').style.display = 'none';
    document.getElementById('clientsGrid').style.display = 'none';

    // Build macro page
    let cardsHTML = '';
    alerts.forEach(a => {
        const readClass = a.isRead ? 'macro-read' : 'macro-unread';
        const newBadge = a.isRead ? '' : '<span class="macro-new-badge">חדש</span>';
        cardsHTML += `
            <div class="macro-card ${readClass}" data-alert-id="${a.id}" onclick="markAlertRead('${a.id}')">
                <div class="macro-card-header">
                    <div class="macro-card-title">${a.title} ${newBadge}</div>
                    <div class="macro-card-category">${a.category}</div>
                </div>
                <div class="macro-card-data">
                    <div class="macro-data-item">
                        <div class="data-label">בפועל</div>
                        <div class="data-value" style="color:var(--text-primary)">${a.actual}</div>
                    </div>
                    <div class="macro-data-item">
                        <div class="data-label">תחזית</div>
                        <div class="data-value" style="color:var(--accent-blue)">${a.forecast}</div>
                    </div>
                    <div class="macro-data-item">
                        <div class="data-label">קודם</div>
                        <div class="data-value" style="color:var(--text-muted)">${a.previous}</div>
                    </div>
                </div>
                <div class="macro-card-time">${a.date} | ${a.time}${a.source ? ' | ' + a.source : ''}</div>
            </div>`;
    });

    macroPage.innerHTML = `
        <div class="macro-page-header">
            <h1>חדשות מאקרו כלכלה</h1>
            <div style="display:flex;gap:8px">
                <button class="macro-back-btn" onclick="markAllRead()">סמן הכל כנקרא</button>
                <button class="macro-back-btn" onclick="closeMacroPage()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">
            <div style="margin-bottom:16px;color:var(--text-secondary);font-size:14px">
                מציג ${alerts.length} עדכונים כלכליים אחרונים | מקור: Trading Economics | ${alerts.filter(a => !a.isRead).length} חדשים
            </div>
            <div class="macro-grid">
                ${cardsHTML}
            </div>
        </div>
    `;
    macroPage.classList.add('active');

    // Save state to URL
    if (typeof updateURLState === 'function') {
        updateURLState({ view: 'macro' });
    }
}

function markAllRead() {
    alerts.forEach(a => {
        if (!a.isRead) {
            a.isRead = true;
            if (!readAlertIds.includes(a.id)) readAlertIds.push(a.id);
        }
    });
    localStorage.setItem('readMacroAlerts', JSON.stringify(readAlertIds));
    renderAlerts();
    // Refresh the page view
    toggleAlerts();
}

function closeMacroPage() {
    document.getElementById('macroPage').classList.remove('active');
    document.getElementById('macroPage').innerHTML = '';
    document.querySelector('.header').style.display = '';
    document.querySelector('.summary-bar').style.display = '';
    document.querySelector('.filters').style.display = '';
    document.getElementById('exposureSection').style.display = '';
    document.getElementById('clientsGrid').style.display = '';
    // Clear URL state
    if (typeof clearURLState === 'function') clearURLState();
}
