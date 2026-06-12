// ========== SMART PORTFOLIO MANAGEMENT PAGE ==========
//
// A dedicated page (sidebar → "ניהול חכם") with:
//   1. PARALLEL ACTIONS — buy an asset across many portfolios at once (risk-on),
//      or sell a % of a specific stock / ALL stocks (risk-off). Portfolios without
//      enough USD cash for the entered buy amount are auto-excluded live, and
//      whole risk classes (high/medium/low) can be included/excluded.
//   2. ALLOCATION GUARD — per-portfolio minimum-cash target (%). When equities
//      push cash below the target, a breach badge appears; clicking it shows the
//      required reduction and a one-click proportional fix that keeps the
//      portfolio's composition (and therefore its efficient-region position).

let _bulkMode = 'buy';          // 'buy' | 'reduce'
let _bulkScope = 'all';         // reduce scope: 'all' | 'ticker'
let _bulkBusy = false;
let _bulkManualOff = new Set(); // portfolios the user manually unchecked

// ── Allocation targets (min cash %) — persisted per portfolio ──
const _ALLOC_LS_PREFIX = 'alloc_target_v1_';

function getAllocTarget(clientId) {
    const v = parseFloat(localStorage.getItem(_ALLOC_LS_PREFIX + clientId));
    return (isFinite(v) && v > 0 && v <= 95) ? v : null;
}

function setAllocTarget(clientId, pct) {
    try {
        if (pct > 0 && pct <= 95) localStorage.setItem(_ALLOC_LS_PREFIX + clientId, String(pct));
        else localStorage.removeItem(_ALLOC_LS_PREFIX + clientId);
    } catch (e) { /* full */ }
}

// Current allocation state of a portfolio (USD terms, consistent with the cards).
function _allocStateOf(c) {
    const rate = (typeof window !== 'undefined' && window.USD_ILS_RATE > 0) ? window.USD_ILS_RATE : 3.7;
    const cash = (c.cash?.usd || 0) + (c.cash?.ils || 0) / rate;
    const fxr = (cur) => (typeof getFxRate === 'function') ? getFxRate(cur || 'USD', 'USD') : 1;
    const hVal = (h) => h._valueInDisplayCurrency != null ? h._valueInDisplayCurrency : (h.value || 0) * fxr(h.currency);
    const stocksVal = (c.holdings || []).filter(h => h.type === 'stock').reduce((s, h) => s + hVal(h), 0);
    const bondsVal = (c.holdings || []).filter(h => h.type === 'bond').reduce((s, h) => s + hVal(h), 0);
    const total = cash + stocksVal + bondsVal;
    return { cash, stocksVal, bondsVal, total, cashPct: total > 0 ? cash / total * 100 : 0 };
}

// Breach check: returns null when fine, or details for the badge/fix.
// HYSTERESIS: the breach triggers only when cash is a FULL 1% below the target,
// and the fix sells up to target +0.5% — so after executing the suggested fix
// once, normal intraday price drift can no longer instantly re-trigger the alert.
const _ALLOC_TRIGGER_GAP = 1.0;   // flag only when cashPct < target − 1%
const _ALLOC_FIX_BUFFER = 0.5;    // fix aims for target + 0.5%

function allocBreachOf(c) {
    const target = getAllocTarget(c.id);
    if (!target) return null;
    const st = _allocStateOf(c);
    if (st.total <= 0 || st.cashPct >= target - _ALLOC_TRIGGER_GAP) return null;
    // Sell S of stocks so cash reaches target+buffer: S = t'·V − C (total V unchanged)
    const aim = Math.min(95, target + _ALLOC_FIX_BUFFER);
    const needSell = (aim / 100) * st.total - st.cash;
    const pctOfStocks = st.stocksVal > 0 ? Math.min(100, needSell / st.stocksVal * 100) : 0;
    return { target, cashPct: st.cashPct, needSell, pctOfStocks, stocksVal: st.stocksVal };
}

// ── Page open/close (mirrors the riskmodel-page pattern) ──

function openBulkPage(focusAllocId) {
    const page = document.getElementById('bulkPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => {
        if (el.id !== 'bulkPage') el.style.display = 'none';
    });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';
    const risk = document.getElementById('riskmodelPage');
    if (risk && risk.classList.contains('active') && typeof closeRiskAnalysis === 'function') closeRiskAnalysis();

    _bulkManualOff = new Set();
    _bulkBusy = false;
    page.classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'bulkmgr' });
    // Keep the sidebar highlight in sync even when opened directly (e.g. from a
    // card's allocation-breach chip), not via navigateTo()
    if (typeof _setActiveNav === 'function') _setActiveNav('bulkmgr');
    _renderBulkPage();
    window.scrollTo(0, 0);

    // Came from a card's breach chip → open THAT portfolio's rebalance
    // instructions and scroll straight to them.
    if (focusAllocId != null && typeof focusAllocId === 'number') {
        setTimeout(() => {
            const d = document.getElementById(`allocDetail-${focusAllocId}`);
            if (d) {
                d.style.display = '';
                d.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                document.getElementById('allocList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 80);
    }
}

function closeBulkPage() {
    const page = document.getElementById('bulkPage');
    if (!page) return;
    page.classList.remove('active');
    page.innerHTML = '';
    const header = document.querySelector('.header');
    if (header) header.style.display = '';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { el.style.display = ''; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = '';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
}

function _renderBulkPage() {
    const page = document.getElementById('bulkPage');
    if (!page) return;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">ניהול חכם — שליטה מקבילה בתיקים</h1>
            <button class="macro-back-btn" onclick="closeBulkPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">

        <div class="risk-table-card glass-card">
            <div class="risk-chart-head"><h3>פעולה מקבילה</h3>
                <span class="risk-chart-sub">תיקים ללא מספיק מזומן לקנייה מוסרים אוטומטית · ניתן להחריג רמות סיכון שלמות</span></div>

            <div class="bulk-mode-row">
                <button class="bulk-mode-btn ${_bulkMode === 'buy' ? 'active' : ''}" id="bulkModeBuy" onclick="setBulkMode('buy')">קנייה מקבילה (לקיחת סיכון)</button>
                <button class="bulk-mode-btn ${_bulkMode === 'reduce' ? 'active' : ''}" id="bulkModeReduce" onclick="setBulkMode('reduce')">צמצום סיכון (מכירה ב-%)</button>
            </div>

            <div id="bulkBuyControls" class="bulk-controls" style="${_bulkMode === 'buy' ? '' : 'display:none'}">
                <div class="bulk-field">
                    <label>סימול לקנייה (ארה"ב)</label>
                    <input type="text" autocomplete="off" id="bulkTicker" placeholder="למשל: SPY" style="direction:ltr;text-align:left"
                           oninput="this.value=this.value.toUpperCase(); _bulkRefreshList()" />
                </div>
                <div class="bulk-field">
                    <label>סכום קנייה לכל תיק ($)</label>
                    <input type="text" inputmode="decimal" autocomplete="off" id="bulkAmount" placeholder="1,000" style="direction:ltr;text-align:left"
                           oninput="formatInputWithCommas(this); _bulkRefreshList()" />
                </div>
            </div>

            <div id="bulkReduceControls" class="bulk-controls" style="${_bulkMode === 'reduce' ? '' : 'display:none'}">
                <div class="bulk-field">
                    <label>היקף הצמצום</label>
                    <select id="bulkScope" onchange="_bulkScope=this.value; _bulkRefreshList()">
                        <option value="all" ${_bulkScope === 'all' ? 'selected' : ''}>כל המניות בתיק</option>
                        <option value="ticker" ${_bulkScope === 'ticker' ? 'selected' : ''}>מניה מסוימת</option>
                    </select>
                </div>
                <div class="bulk-field" id="bulkReduceTickerField" style="${_bulkScope === 'ticker' ? '' : 'display:none'}">
                    <label>סימול לצמצום</label>
                    <div style="position:relative;width:100%">
                        <input type="text" autocomplete="off" id="bulkReduceTicker" placeholder="למשל: NVDA" style="direction:ltr;text-align:left;width:100%;box-sizing:border-box"
                               oninput="this.value=this.value.toUpperCase(); _bulkTickerSuggest(); _bulkRefreshList()" />
                        <div class="row-ticker-dropdown" id="bulkReduceDrop"></div>
                    </div>
                </div>
                <div class="bulk-field">
                    <label>אחוז צמצום (%)</label>
                    <input type="text" inputmode="decimal" autocomplete="off" id="bulkPct" placeholder="25" style="direction:ltr;text-align:left"
                           oninput="_bulkRefreshList()" />
                </div>
            </div>

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
        </div>

        <div class="risk-table-card glass-card">
            <div class="risk-chart-head"><h3>יעדי אלוקציה — מזומן מול נכסים</h3>
                <span class="risk-chart-sub">הגדר אחוז מזומן מינימלי לכל תיק · כשהחשיפה למניות חורגת — מופיעה התראה עם פעולת תיקון ששומרת על האיזור היעיל</span></div>
            <div class="bulk-risk-row alloc-bulk-row">
                <span class="bulk-risk-label">הגדרה מרובה — יעד מזומן מינימלי:</span>
                <span class="bulk-risk-label">לתיקים ברמת סיכון:</span>
                <label class="bulk-risk-chk"><input type="checkbox" id="allocBulkHigh" checked /> <span class="risk-badge high">גבוה</span></label>
                <label class="bulk-risk-chk"><input type="checkbox" id="allocBulkMedium" checked /> <span class="risk-badge medium">בינוני</span></label>
                <label class="bulk-risk-chk"><input type="checkbox" id="allocBulkLow" checked /> <span class="risk-badge low">נמוך</span></label>
                <span class="alloc-mini-wrap">
                    <input type="text" inputmode="decimal" autocomplete="off" id="allocBulkPct" placeholder="20" />
                    <span class="alloc-input-pct">%</span>
                </span>
                <button class="mgmt-btn primary alloc-bulk-apply" onclick="applyAllocTargetBulk()">החל על כלל התיקים</button>
                <button class="mgmt-btn secondary alloc-bulk-clear" onclick="clearAllAllocTargets()">בטל יעד לכלל התיקים</button>
            </div>
            <div id="allocList" class="bulk-list"></div>
        </div>
        </div>
    </div>`;
    _bulkRefreshList();
    _renderAllocSection();
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

// Eligibility of each portfolio for the current operation.
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

// Suggest ONLY tickers actually held in the portfolios (filtered by what's typed) —
// the reduce box accepts existing symbols, like the buy windows' search.
function _bulkTickerSuggest() {
    const inp = document.getElementById('bulkReduceTicker');
    const drop = document.getElementById('bulkReduceDrop');
    if (!inp || !drop) return;
    const q = (inp.value || '').toUpperCase().trim();
    // Suggestions appear only once typing starts — never on a bare click
    if (!q) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

    // ticker → { name, portfolios held in }
    const held = new Map();
    for (const c of (typeof clients !== 'undefined' ? clients : [])) {
        for (const h of (c.holdings || [])) {
            if (h.type !== 'stock' || !(h.shares > 0) || !h.ticker) continue;
            const t = h.ticker.toUpperCase();
            if (!held.has(t)) held.set(t, { name: h.name || t, count: 0 });
            held.get(t).count++;
        }
    }
    const matches = [...held.entries()]
        .filter(([t, v]) => !q || t.includes(q) || String(v.name).toUpperCase().includes(q))
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, 8);

    if (!matches.length) {
        drop.innerHTML = q ? '<div class="ticker-search-empty">אין נכס כזה בתיקים</div>' : '';
        drop.style.display = q ? 'block' : 'none';
        return;
    }
    drop.innerHTML = matches.map(([t, v]) => `
        <div class="ticker-search-item" onclick="_bulkPickTicker('${t}')">
            <div class="search-row-grid">
                <div class="search-col-name"><span class="search-name-primary">${v.name}</span></div>
                <div class="search-col-ticker">${t}</div>
                <div class="search-col-exchange">${v.count} תיקים</div>
            </div>
        </div>`).join('');
    drop.style.display = 'block';
}

function _bulkPickTicker(t) {
    const inp = document.getElementById('bulkReduceTicker');
    const drop = document.getElementById('bulkReduceDrop');
    if (inp) inp.value = t;
    if (drop) { drop.innerHTML = ''; drop.style.display = 'none'; }
    _bulkRefreshList();
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('#bulkReduceTickerField')) {
        const drop = document.getElementById('bulkReduceDrop');
        if (drop) { drop.innerHTML = ''; drop.style.display = 'none'; }
    }
});

function _bulkRefreshList() {
    const listEl = document.getElementById('bulkList');
    if (!listEl) return;
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
        if (!q || !(q.price > 0)) {
            log(`✗ לא נמצא מחיר ל-${ticker} — הפעולה בוטלה`);
            _bulkBusy = false; document.getElementById('bulkExecBtn').disabled = false;
            return;
        }
        const price = q.price;
        const quantity = Math.round((amount / price) * 10000) / 10000;
        log(`מחיר: $${price.toFixed(2)} → ${quantity} יחידות לכל תיק`);

        // All portfolios buy in PARALLEL (each touches only its own cash row)
        let okCount = 0;
        await Promise.all(selected.map(async (c) => {
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
        }));
        log(`<b>הושלם: ${okCount}/${selected.length} תיקים עודכנו.</b>`);
    } else {
        const pct = parseFloat(document.getElementById('bulkPct')?.value);
        if (!(pct > 0) || pct > 100) { alert('נא להזין אחוז צמצום בין 1 ל-100'); return; }
        const scopeTicker = _bulkScope === 'ticker'
            ? (document.getElementById('bulkReduceTicker')?.value || '').toUpperCase().trim() : null;
        if (_bulkScope === 'ticker' && !scopeTicker) { alert('נא להזין סימול לצמצום'); return; }
        // Only symbols that actually exist in the portfolios are actionable
        if (scopeTicker && !(typeof clients !== 'undefined' ? clients : []).some(c =>
            (c.holdings || []).some(h => h.type === 'stock' && (h.shares || 0) > 0 && (h.ticker || '').toUpperCase() === scopeTicker))) {
            alert(`הסימול ${scopeTicker} לא מוחזק באף תיק — בחר נכס קיים מהרשימה`);
            return;
        }
        const what = scopeTicker ? scopeTicker : 'כל המניות';
        if (!confirm(`לצמצם ${pct}% מ-${what} ב-${selected.length} תיקים?`)) return;

        _bulkBusy = true;
        document.getElementById('bulkExecBtn').disabled = true;
        if (progEl) progEl.innerHTML = '';
        log('מוכר במקביל בכל התיקים…');

        // FAST PATH: one batched sell per portfolio (≈6 round-trips total instead of
        // ~7 per holding), and all portfolios run in PARALLEL (separate cash rows).
        let okCount = 0;
        await Promise.all(selected.map(async (c) => {
            try {
                const targets = (c.holdings || []).filter(h => h.type === 'stock' && (h.shares || 0) > 0
                    && (!scopeTicker || (h.ticker || '').toUpperCase() === scopeTicker));
                const sales = targets.map(h => ({
                    holdingId: h.id,
                    qty: Math.round(h.shares * (pct / 100) * 10000) / 10000,
                    price: h.price,
                })).filter(s => s.qty > 0);
                if (!sales.length) { log(`— ${c.name} — אין מה לצמצם`); return; }

                let updated = null;
                if (typeof supaSellHoldingsBatch === 'function') {
                    updated = await supaSellHoldingsBatch(c.id, sales);
                } else {
                    for (const s of sales) updated = await supaSellHolding(c.id, s.holdingId, s.qty, s.price) || updated;
                }
                if (updated) {
                    const idx = clients.findIndex(x => x.id === c.id);
                    if (idx !== -1) clients[idx] = updated;
                    okCount++;
                    log(`✓ ${c.name} — צומצמו ${sales.length} נכסים ב-${pct}%`);
                } else {
                    log(`✗ ${c.name} — שגיאה במכירה`);
                }
            } catch (e) { log(`✗ ${c.name} — שגיאה: ${e.message}`); }
        }));
        log(`<b>הושלם: ${okCount}/${selected.length} תיקים עודכנו.</b>`);
    }

    _bulkBusy = false;
    const btn = document.getElementById('bulkExecBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'בצע פעולה נוספת'; }
    if (typeof invalidateRiskModel === 'function') invalidateRiskModel();
    refreshDashboard();
    _bulkRefreshList();
    _renderAllocSection();
}

// ── Allocation guard section ──

function _renderAllocSection() {
    const el = document.getElementById('allocList');
    if (!el) return;
    const rows = (typeof clients !== 'undefined' ? clients : []).map(c => {
        const st = _allocStateOf(c);
        const target = getAllocTarget(c.id);
        const breach = allocBreachOf(c);
        const badge = breach
            ? `<button class="alloc-breach" onclick="toggleAllocDetail(${c.id})">⚠ חריגה מהאלוקציה</button>`
            : (target ? '<span class="alloc-ok">✓ בתוך היעד</span>' : '<span class="adv-dim" style="font-size:11px">לא הוגדר יעד</span>');
        const detail = breach ? `
            <div class="alloc-detail" id="allocDetail-${c.id}" style="display:none">
                יש חריגה מהאלוקציה שהוגדרה: מזומן נוכחי <b>${st.cashPct.toFixed(1)}%</b> מתחת ליעד <b>${breach.target}%</b>.
                כדי לחזור ליעד: <b>צמצם את אחוז המניות ב-${breach.pctOfStocks.toFixed(1)}%</b>
                (מכירה פרופורציונלית של כל המניות — שומרת על הרכב התיק, על הפיזור ועל מיקומו באיזור היעיל של העקומה).
                <button class="mgmt-btn primary alloc-fix-btn" onclick="fixAllocation(${c.id}, ${breach.pctOfStocks.toFixed(2)})">צמצם עכשיו ${breach.pctOfStocks.toFixed(1)}%</button>
            </div>` : '';
        return `
        <div class="bulk-row alloc-row" style="flex-wrap:wrap">
            <span class="bulk-row-name">${c.name}</span>
            <span class="risk-badge ${c.risk || 'low'}">${c.riskLabel || ''}</span>
            <span class="bulk-row-cash">מזומן: ${st.cashPct.toFixed(1)}% · מניות: ${(st.total > 0 ? st.stocksVal / st.total * 100 : 0).toFixed(1)}%</span>
            <span class="alloc-target-wrap">יעד מזומן מינימלי:
                <span class="alloc-input-wrap">
                    <input type="text" inputmode="decimal" autocomplete="off" class="alloc-input" value="${target ?? ''}" placeholder="—"
                           onchange="setAllocTarget(${c.id}, parseFloat(this.value)); _renderAllocSection(); if(typeof renderClientCards==='function') renderClientCards();" />
                    <span class="alloc-input-pct">%</span>
                </span>
            </span>
            ${badge}
            ${detail}
        </div>`;
    }).join('');
    el.innerHTML = rows || '<div class="adv-empty">אין תיקים.</div>';
}

// Multi-portfolio allocation target: apply one min-cash % to every portfolio in the
// selected risk classes (same filtering pattern as the parallel-action section).
function applyAllocTargetBulk() {
    const pct = parseFloat(document.getElementById('allocBulkPct')?.value);
    if (!(pct > 0) || pct > 95) { alert('נא להזין יעד מזומן בין 1 ל-95 אחוז'); return; }
    const riskOn = {
        high: document.getElementById('allocBulkHigh')?.checked !== false,
        medium: document.getElementById('allocBulkMedium')?.checked !== false,
        low: document.getElementById('allocBulkLow')?.checked !== false,
    };
    const targets = (typeof clients !== 'undefined' ? clients : []).filter(c => riskOn[c.risk || 'low']);
    if (!targets.length) { alert('אין תיקים ברמות הסיכון שנבחרו'); return; }
    if (!confirm(`להגדיר יעד מזומן מינימלי של ${pct}% ל-${targets.length} תיקים?`)) return;
    for (const c of targets) setAllocTarget(c.id, pct);
    _renderAllocSection();
    if (typeof renderClientCards === 'function') renderClientCards();
}

// Remove the min-cash target from EVERY portfolio (clears the breach badges too)
function clearAllAllocTargets() {
    const list = (typeof clients !== 'undefined' ? clients : []);
    if (!list.length) return;
    if (!confirm(`לבטל את יעד המזומן המינימלי בכל ${list.length} התיקים?`)) return;
    for (const c of list) setAllocTarget(c.id, 0); // 0 → removes the stored target
    _renderAllocSection();
    if (typeof renderClientCards === 'function') renderClientCards();
}

function toggleAllocDetail(id) {
    const d = document.getElementById(`allocDetail-${id}`);
    if (d) d.style.display = d.style.display === 'none' ? '' : 'none';
}

// One-click fix: pre-arms the reduce flow for THIS portfolio only with the computed %.
function fixAllocation(clientId, pct) {
    setBulkMode('reduce');
    _bulkScope = 'all';
    const scopeSel = document.getElementById('bulkScope');
    if (scopeSel) scopeSel.value = 'all';
    const pctEl = document.getElementById('bulkPct');
    if (pctEl) pctEl.value = String(Math.ceil(pct * 10) / 10);
    // select ONLY this portfolio
    _bulkManualOff = new Set((typeof clients !== 'undefined' ? clients : []).map(c => c.id).filter(id => id !== clientId));
    _bulkRefreshList();
    document.getElementById('bulkList')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Expose
if (typeof window !== 'undefined') {
    window.openBulkPage = openBulkPage;
    window.closeBulkPage = closeBulkPage;
    window.setBulkMode = setBulkMode;
    window.executeBulkAction = executeBulkAction;
    window._bulkRefreshList = _bulkRefreshList;
    window._bulkToggleManual = _bulkToggleManual;
    window.getAllocTarget = getAllocTarget;
    window.setAllocTarget = setAllocTarget;
    window.allocBreachOf = allocBreachOf;
    window.toggleAllocDetail = toggleAllocDetail;
    window.fixAllocation = fixAllocation;
    window.applyAllocTargetBulk = applyAllocTargetBulk;
    window.clearAllAllocTargets = clearAllAllocTargets;
}
