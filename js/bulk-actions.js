// ========== SMART BULK PORTFOLIO MANAGER ==========
//
// Parallel control over ALL portfolios from one window:
//   BUY    — buy an asset across many portfolios at once (risk-on). Portfolios
//            without enough USD cash for the entered amount are auto-excluded live.
//   REDUCE — risk-off: sell a given PERCENT of a specific stock, or of EVERY stock,
//            across the selected portfolios.
// Risk-level toggles (high/medium/low) include or exclude whole risk classes —
// e.g. leave low-risk portfolios untouched during a risk-off move.

let _bulkMode = 'buy';          // 'buy' | 'reduce'
let _bulkScope = 'all';         // reduce scope: 'all' | 'ticker'
let _bulkBusy = false;
let _bulkManualOff = new Set(); // portfolios the user manually unchecked

function openBulkManager() {
    let ov = document.getElementById('bulkOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'bulkOverlay';
        ov.className = 'reco-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov && !_bulkBusy) closeBulkManager(); });
        document.body.appendChild(ov);
    }
    _bulkManualOff = new Set();
    _bulkBusy = false;

    ov.innerHTML = `<div class="reco-box bulk-box" dir="rtl">
        <div class="reco-head">
            <div><h3>ניהול חכם — פעולה מקבילה על תיקים</h3>
            <span class="reco-sub">קנייה או צמצום סיכון בכל התיקים בבת אחת · תיקים ללא מזומן מוסרים אוטומטית</span></div>
            <button class="reco-close" onclick="closeBulkManager()">✕</button>
        </div>

        <div class="bulk-mode-row">
            <button class="bulk-mode-btn active" id="bulkModeBuy" onclick="setBulkMode('buy')">קנייה מקבילה (לקיחת סיכון)</button>
            <button class="bulk-mode-btn" id="bulkModeReduce" onclick="setBulkMode('reduce')">צמצום סיכון (מכירה ב-%)</button>
        </div>

        <!-- BUY controls -->
        <div id="bulkBuyControls" class="bulk-controls">
            <div class="bulk-field">
                <label>סימול לקנייה (ארה"ב)</label>
                <input type="text" id="bulkTicker" placeholder="למשל: SPY" style="direction:ltr;text-align:left"
                       oninput="this.value=this.value.toUpperCase(); _bulkRefreshList()" />
            </div>
            <div class="bulk-field">
                <label>סכום קנייה לכל תיק ($)</label>
                <input type="text" inputmode="decimal" id="bulkAmount" placeholder="1,000" style="direction:ltr;text-align:left"
                       oninput="formatInputWithCommas(this); _bulkRefreshList()" />
            </div>
        </div>

        <!-- REDUCE controls -->
        <div id="bulkReduceControls" class="bulk-controls" style="display:none">
            <div class="bulk-field">
                <label>היקף הצמצום</label>
                <select id="bulkScope" onchange="_bulkScope=this.value; _bulkRefreshList()">
                    <option value="all">כל המניות בתיק</option>
                    <option value="ticker">מניה מסוימת</option>
                </select>
            </div>
            <div class="bulk-field" id="bulkReduceTickerField" style="display:none">
                <label>סימול לצמצום</label>
                <input type="text" id="bulkReduceTicker" placeholder="למשל: NVDA" style="direction:ltr;text-align:left"
                       oninput="this.value=this.value.toUpperCase(); _bulkRefreshList()" />
            </div>
            <div class="bulk-field">
                <label>אחוז צמצום (%)</label>
                <input type="text" inputmode="decimal" id="bulkPct" placeholder="25" style="direction:ltr;text-align:left"
                       oninput="_bulkRefreshList()" />
            </div>
        </div>

        <!-- Risk-class include toggles -->
        <div class="bulk-risk-row">
            <span class="bulk-risk-label">כלול תיקים לפי רמת סיכון:</span>
            <label class="bulk-risk-chk"><input type="checkbox" id="bulkRiskHigh" checked onchange="_bulkRefreshList()" /> <span class="risk-badge high">גבוה</span></label>
            <label class="bulk-risk-chk"><input type="checkbox" id="bulkRiskMedium" checked onchange="_bulkRefreshList()" /> <span class="risk-badge medium">בינוני</span></label>
            <label class="bulk-risk-chk"><input type="checkbox" id="bulkRiskLow" checked onchange="_bulkRefreshList()" /> <span class="risk-badge low">נמוך</span></label>
        </div>

        <div id="bulkList" class="bulk-list"></div>

        <div class="bulk-footer">
            <span id="bulkSummary" class="bulk-summary"></span>
            <button class="mgmt-btn primary" id="bulkExecBtn" onclick="executeBulkAction()">בצע פעולה</button>
        </div>
        <div id="bulkProgress" class="bulk-progress"></div>
    </div>`;

    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    try { history.pushState({ popup: 'bulk' }, '', location.href); } catch (e) { /* ignore */ }
    _bulkRefreshList();
}

function closeBulkManager() {
    if (_bulkBusy) return;
    const ov = document.getElementById('bulkOverlay');
    if (ov) ov.classList.remove('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}

function setBulkMode(mode) {
    _bulkMode = mode;
    document.getElementById('bulkModeBuy')?.classList.toggle('active', mode === 'buy');
    document.getElementById('bulkModeReduce')?.classList.toggle('active', mode === 'reduce');
    const buyC = document.getElementById('bulkBuyControls');
    const redC = document.getElementById('bulkReduceControls');
    if (buyC) buyC.style.display = mode === 'buy' ? '' : 'none';
    if (redC) redC.style.display = mode === 'reduce' ? '' : 'none';
    _bulkRefreshList();
}

function _bulkToggleManual(id, checked) {
    if (checked) _bulkManualOff.delete(id); else _bulkManualOff.add(id);
    _bulkRefreshList();
}

// Eligibility of each portfolio for the current operation. Returns
// { ok, reason } — ineligible rows are shown disabled with the reason.
function _bulkEligibility(c) {
    const riskOn = {
        high: document.getElementById('bulkRiskHigh')?.checked !== false,
        medium: document.getElementById('bulkRiskMedium')?.checked !== false,
        low: document.getElementById('bulkRiskLow')?.checked !== false,
    };
    if (!riskOn[c.risk || 'low']) return { ok: false, reason: 'רמת סיכון לא נכללת' };

    if (_bulkMode === 'buy') {
        const amount = parseInputNumber(document.getElementById('bulkAmount')?.value);
        const cashUsd = c.cash?.usd || 0;
        if (amount > 0 && cashUsd < amount) {
            return { ok: false, reason: `אין מספיק מזומן ($${Math.round(cashUsd).toLocaleString('en-US')})` };
        }
        return { ok: true };
    }

    // reduce
    const stocks = (c.holdings || []).filter(h => h.type === 'stock' && (h.shares || 0) > 0);
    if (!stocks.length) return { ok: false, reason: 'אין מניות בתיק' };
    if (_bulkScope === 'ticker') {
        const t = (document.getElementById('bulkReduceTicker')?.value || '').toUpperCase().trim();
        if (t && !stocks.some(h => (h.ticker || '').toUpperCase() === t)) {
            return { ok: false, reason: 'לא מחזיק בנכס' };
        }
    }
    return { ok: true };
}

function _bulkRefreshList() {
    const listEl = document.getElementById('bulkList');
    if (!listEl) return;
    // reduce: show/hide the ticker field
    const tf = document.getElementById('bulkReduceTickerField');
    if (tf) tf.style.display = (_bulkScope === 'ticker') ? '' : 'none';

    const rows = (typeof clients !== 'undefined' ? clients : []).map(c => {
        const el = _bulkEligibility(c);
        const manualOff = _bulkManualOff.has(c.id);
        const checked = el.ok && !manualOff;
        const cashUsd = c.cash?.usd || 0;
        return `
        <label class="bulk-row ${el.ok ? '' : 'bulk-row-off'}">
            <input type="checkbox" ${checked ? 'checked' : ''} ${el.ok ? '' : 'disabled'}
                   onchange="_bulkToggleManual(${c.id}, this.checked)" />
            <span class="bulk-row-name">${c.name}</span>
            <span class="risk-badge ${c.risk || 'low'}">${c.riskLabel || ''}</span>
            <span class="bulk-row-cash">מזומן: $${Math.round(cashUsd).toLocaleString('en-US')}</span>
            ${el.ok ? '' : `<span class="bulk-row-reason">${el.reason}</span>`}
        </label>`;
    }).join('');
    listEl.innerHTML = rows || '<div class="adv-empty">אין תיקים.</div>';

    // summary
    const selected = _bulkSelectedClients();
    const sEl = document.getElementById('bulkSummary');
    if (sEl) {
        if (_bulkMode === 'buy') {
            const amount = parseInputNumber(document.getElementById('bulkAmount')?.value) || 0;
            sEl.textContent = `${selected.length} תיקים נבחרו · סה"כ קנייה: $${Math.round(amount * selected.length).toLocaleString('en-US')}`;
        } else {
            const pct = parseFloat(document.getElementById('bulkPct')?.value) || 0;
            sEl.textContent = `${selected.length} תיקים נבחרו · צמצום של ${pct}%`;
        }
    }
}

function _bulkSelectedClients() {
    return (typeof clients !== 'undefined' ? clients : [])
        .filter(c => _bulkEligibility(c).ok && !_bulkManualOff.has(c.id));
}

async function executeBulkAction() {
    if (_bulkBusy) return;
    const selected = _bulkSelectedClients();
    if (!selected.length) { alert('לא נבחרו תיקים מתאימים לפעולה'); return; }
    const progEl = document.getElementById('bulkProgress');
    const log = (msg) => { if (progEl) progEl.innerHTML += `<div>${msg}</div>`; };

    if (_bulkMode === 'buy') {
        const ticker = (document.getElementById('bulkTicker')?.value || '').toUpperCase().trim();
        const amount = parseInputNumber(document.getElementById('bulkAmount')?.value);
        if (!ticker) { alert('נא להזין סימול לקנייה'); return; }
        if (!(amount > 0)) { alert('נא להזין סכום קנייה תקין'); return; }
        if (!confirm(`לקנות ${ticker} ב-$${Math.round(amount).toLocaleString('en-US')} בכל אחד מ-${selected.length} התיקים?`)) return;

        _bulkBusy = true;
        document.getElementById('bulkExecBtn').disabled = true;
        if (progEl) progEl.innerHTML = '';
        log(`מאתר מחיר עדכני ל-${ticker}…`);
        const q = await fetchSingleTickerPrice(ticker, 'USD');
        if (!q || !(q.price > 0)) { log(`✗ לא נמצא מחיר ל-${ticker} — הפעולה בוטלה`); _bulkBusy = false; document.getElementById('bulkExecBtn').disabled = false; return; }
        const price = q.price;
        const quantity = Math.round((amount / price) * 10000) / 10000;
        log(`מחיר: $${price.toFixed(2)} → ${quantity} יחידות לכל תיק`);

        let okCount = 0;
        for (const c of selected) {
            try {
                const updated = await portfolioBuyAsset(c.id, { type: 'stock', price, quantity, ticker, currency: 'USD', stockName: ticker });
                if (updated && !updated.error) {
                    const idx = clients.findIndex(x => x.id === c.id);
                    if (idx !== -1) clients[idx] = updated;
                    okCount++;
                    log(`✓ ${c.name} — נקנו ${quantity} יח' ${ticker}`);
                } else {
                    log(`✗ ${c.name} — ${updated && updated.error === 'insufficient_cash' ? 'אין מספיק מזומן' : (updated && updated.error) || 'שגיאה'}`);
                }
            } catch (e) { log(`✗ ${c.name} — שגיאה: ${e.message}`); }
        }
        log(`<b>הושלם: ${okCount}/${selected.length} תיקים עודכנו.</b>`);
    } else {
        const pct = parseFloat(document.getElementById('bulkPct')?.value);
        if (!(pct > 0) || pct > 100) { alert('נא להזין אחוז צמצום בין 1 ל-100'); return; }
        const scopeTicker = _bulkScope === 'ticker'
            ? (document.getElementById('bulkReduceTicker')?.value || '').toUpperCase().trim() : null;
        if (_bulkScope === 'ticker' && !scopeTicker) { alert('נא להזין סימול לצמצום'); return; }
        const what = scopeTicker ? scopeTicker : 'כל המניות';
        if (!confirm(`לצמצם ${pct}% מ-${what} ב-${selected.length} תיקים?`)) return;

        _bulkBusy = true;
        document.getElementById('bulkExecBtn').disabled = true;
        if (progEl) progEl.innerHTML = '';

        let okCount = 0;
        for (const c of selected) {
            try {
                const targets = (c.holdings || []).filter(h => h.type === 'stock' && (h.shares || 0) > 0
                    && (!scopeTicker || (h.ticker || '').toUpperCase() === scopeTicker));
                let sold = 0;
                for (const h of targets) {
                    const qty = Math.round(h.shares * (pct / 100) * 10000) / 10000;
                    if (!(qty > 0)) continue;
                    const updated = await supaSellHolding(c.id, h.id, qty, h.price);
                    if (updated) {
                        const idx = clients.findIndex(x => x.id === c.id);
                        if (idx !== -1) clients[idx] = updated;
                        sold++;
                    }
                }
                if (sold > 0) { okCount++; log(`✓ ${c.name} — צומצמו ${sold} נכסים ב-${pct}%`); }
                else log(`— ${c.name} — אין מה לצמצם`);
            } catch (e) { log(`✗ ${c.name} — שגיאה: ${e.message}`); }
        }
        log(`<b>הושלם: ${okCount}/${selected.length} תיקים עודכנו.</b>`);
    }

    _bulkBusy = false;
    const btn = document.getElementById('bulkExecBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'בצע פעולה נוספת'; }
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    refreshDashboard();
    _bulkRefreshList();
}

// Expose
if (typeof window !== 'undefined') {
    window.openBulkManager = openBulkManager;
    window.closeBulkManager = closeBulkManager;
    window.setBulkMode = setBulkMode;
    window.executeBulkAction = executeBulkAction;
    window._bulkRefreshList = _bulkRefreshList;
    window._bulkToggleManual = _bulkToggleManual;
}
