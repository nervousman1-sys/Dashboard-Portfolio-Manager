// ========== STOCK ALERTS — price / indicator alerts with header-bell notifications ==========
//
// Set an alert on any stock from the technical page ("🔔 התראה"): notify when the price or a
// technical indicator (RSI daily/weekly, 200/300-day moving average) crosses a chosen level.
// Active alerts are checked against LIVE technical-scan data; a triggered alert lights the
// header bell (bellDot) and appears in the bell dropdown. All real: no simulated values.
//
// Storage: Supabase `stock_alerts` (RLS: user_id = auth.uid()). Evaluation source:
// /api/technicals?mode=scan (the same live price/RSI/MA the technical board shows).

let _saAlerts = [];          // cached alerts (active + recently triggered)
let _saSeenTriggered = new Set();  // triggered ids the user has already opened (clears the dot)
let _saChecking = false;

const _SA_KINDS = {
    price: { he: 'מחיר', unit: '$' },
    rsi_d: { he: 'RSI יומי', unit: '' },
    rsi_w: { he: 'RSI שבועי', unit: '' },
    ma200: { he: 'ממוצע 200 יום', unit: '' },
    ma300: { he: 'ממוצע 300 יום', unit: '' },
};
function _saEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// Current live values for a symbol from the technical scan cache (technical-view.js).
function _saCurrent(sym, market) {
    try {
        const mkt = market || (typeof _techMarket !== 'undefined' ? _techMarket : 'sp500');
        const d = (typeof _techDataMkt !== 'undefined' && _techDataMkt[mkt]) ? (_techDataMkt[mkt][sym] || (typeof _techExtra !== 'undefined' && _techExtra[mkt] && _techExtra[mkt][sym])) : null;
        return d || null;
    } catch (e) { return null; }
}

// ── Create-alert modal (opened from the technical table) ──
function openCreateAlert(sym, market) {
    const cur = _saCurrent(sym, market);
    const price = cur && cur.price != null ? +cur.price.toFixed(2) : '';
    const rsiD = cur && cur.rsiD != null ? Math.round(cur.rsiD) : 65;
    const rsiW = cur && cur.rsiW != null ? Math.round(cur.rsiW) : 65;
    const disp = String(sym).replace(/\.TA$/, '');
    let ov = document.getElementById('saOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'saOverlay'; ov.className = 'wl-overlay'; ov.addEventListener('click', e => { if (e.target === ov) closeCreateAlert(); }); document.body.appendChild(ov); }
    ov.innerHTML = `<div class="wl-box sa-box" dir="rtl">
        <div class="wl-head"><span class="wl-title">🔔 התראה חדשה · ${_saEsc(disp)}</span><button class="wl-close" onclick="closeCreateAlert()">✕</button></div>
        <div class="sa-form">
            <div class="sa-field"><label>סוג ההתראה</label>
                <select id="saKind" class="st-pf-select" onchange="_saKindChanged()">
                    <option value="price">מחיר מגיע ל…</option>
                    <option value="rsi_d">RSI יומי מגיע ל…</option>
                    <option value="rsi_w">RSI שבועי מגיע ל…</option>
                    <option value="ma200">המחיר חוצה את ממוצע 200 יום</option>
                    <option value="ma300">המחיר חוצה את ממוצע 300 יום</option>
                </select>
            </div>
            <div class="sa-field"><label>כיוון</label>
                <select id="saDir" class="st-pf-select">
                    <option value="above">מעל / חוצה כלפי מעלה</option>
                    <option value="below">מתחת / חוצה כלפי מטה</option>
                </select>
            </div>
            <div class="sa-field" id="saThreshWrap"><label id="saThreshLbl">מחיר יעד ($)</label>
                <input type="number" id="saThresh" class="corr-input" step="any" value="${price}" placeholder="ערך יעד" />
            </div>
            <div class="sa-cur" id="saCur">${cur ? `כרגע: מחיר $${price} · RSI יומי ${rsiD} · RSI שבועי ${rsiW}${cur.ma && cur.ma.d200 != null ? ' · ממוצע 200: $' + (+cur.ma.d200).toFixed(2) : ''}` : 'הנתונים הנוכחיים ייטענו מהסריקה הטכנית'}</div>
        </div>
        <div class="sa-actions">
            <button class="corr-run-btn corr-run-primary" onclick="_saSave('${_saEsc(sym)}','${market || (typeof _techMarket!=='undefined'?_techMarket:'sp500')}')">קבע התראה</button>
            <button class="wl-close-btn" onclick="closeCreateAlert()">ביטול</button>
        </div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    _saKindChanged();
}
function closeCreateAlert() { const ov = document.getElementById('saOverlay'); if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; } if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock(); }
// MA-cross alerts need no threshold (the level is the moving MA itself).
function _saKindChanged() {
    const kind = (document.getElementById('saKind') || {}).value;
    const wrap = document.getElementById('saThreshWrap');
    const lbl = document.getElementById('saThreshLbl');
    if (!wrap) return;
    if (kind === 'ma200' || kind === 'ma300') { wrap.style.display = 'none'; }
    else { wrap.style.display = ''; lbl.textContent = kind === 'price' ? 'מחיר יעד ($)' : 'ערך RSI יעד (0–100)'; }
}
async function _saSave(sym, market) {
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    const kind = document.getElementById('saKind').value;
    const direction = document.getElementById('saDir').value;
    const needThresh = kind !== 'ma200' && kind !== 'ma300';
    const threshold = needThresh ? parseFloat(document.getElementById('saThresh').value) : null;
    if (needThresh && (!isFinite(threshold))) { if (typeof showToast === 'function') showToast('הזן ערך יעד תקין', 'error'); return; }
    try {
        const { error } = await supabaseClient.from('stock_alerts').insert({ symbol: String(sym).toUpperCase(), market: market || 'us', kind, direction, threshold });
        if (error) throw error;
        closeCreateAlert();
        if (typeof showToast === 'function') showToast('ההתראה נקבעה — תופיע בפעמון כשתתקיים', 'success');
        checkStockAlerts();
    } catch (e) { if (typeof showToast === 'function') showToast('שמירת ההתראה נכשלה', 'error'); }
}

// ── Evaluate active alerts against live scan data; trigger + light the bell ──
function _saConditionMet(a, cur) {
    if (!cur) return null;
    const dir = a.direction;
    const cmp = (val, th) => dir === 'above' ? (val >= th) : (val <= th);
    if (a.kind === 'price' && cur.price != null) return cmp(cur.price, a.threshold) ? cur.price : null;
    if (a.kind === 'rsi_d' && cur.rsiD != null) return cmp(cur.rsiD, a.threshold) ? cur.rsiD : null;
    if (a.kind === 'rsi_w' && cur.rsiW != null) return cmp(cur.rsiW, a.threshold) ? cur.rsiW : null;
    if (a.kind === 'ma200' && cur.ma && cur.ma.d200 != null && cur.price != null) return cmp(cur.price, cur.ma.d200) ? cur.price : null;
    if (a.kind === 'ma300' && cur.ma && cur.ma.d300 != null && cur.price != null) return cmp(cur.price, cur.ma.d300) ? cur.price : null;
    return null;
}
async function checkStockAlerts() {
    if (_saChecking) return;
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) return;
    _saChecking = true;
    try {
        const { data, error } = await supabaseClient.from('stock_alerts').select('*').order('created_at', { ascending: false });
        if (error) { _saChecking = false; return; }
        _saAlerts = data || [];
        const pending = _saAlerts.filter(a => a.active && !a.triggered_at);
        if (pending.length) {
            const syms = [...new Set(pending.map(a => String(a.symbol).toUpperCase()))].slice(0, 60);
            let scan = {};
            try {
                const today = new Date().toISOString().slice(0, 10);
                const r = await fetch(`/api/technicals?mode=scan&symbols=${encodeURIComponent(syms.join(','))}&d=${today}&v=2`, { headers: { Accept: 'application/json' } });
                const j = await r.json(); scan = (j && j.results) || {};
            } catch (e) { }
            for (const a of pending) {
                const cur = scan[String(a.symbol).toUpperCase()];
                const hit = _saConditionMet(a, cur);
                if (hit != null) {
                    try {
                        await supabaseClient.from('stock_alerts').update({ triggered_at: new Date().toISOString(), triggered_value: +(+hit).toFixed(2), active: false }).eq('id', a.id);
                        a.triggered_at = new Date().toISOString(); a.triggered_value = +(+hit).toFixed(2); a.active = false;
                    } catch (e) { }
                }
            }
        }
        _saRefreshBell();
    } catch (e) { }
    _saChecking = false;
}
function _saRefreshBell() {
    const unseen = _saAlerts.filter(a => a.triggered_at && !_saSeenTriggered.has(a.id));
    const dot = document.getElementById('bellDot');
    if (dot) dot.style.display = unseen.length ? 'block' : 'none';
}

// ── Bell panel: triggered + pending alerts ──
function openAlertsPanel() {
    let ov = document.getElementById('saPanelOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'saPanelOverlay'; ov.className = 'wl-overlay'; ov.addEventListener('click', e => { if (e.target === ov) closeAlertsPanel(); }); document.body.appendChild(ov); }
    const triggered = _saAlerts.filter(a => a.triggered_at);
    const pending = _saAlerts.filter(a => a.active && !a.triggered_at);
    const kindTxt = (a) => {
        const k = _SA_KINDS[a.kind] ? _SA_KINDS[a.kind].he : a.kind;
        if (a.kind === 'ma200' || a.kind === 'ma300') return `המחיר ${a.direction === 'above' ? 'מעל' : 'מתחת ל'}${k}`;
        return `${k} ${a.direction === 'above' ? 'מעל' : 'מתחת ל'} ${a.kind === 'price' ? '$' : ''}${a.threshold}`;
    };
    const row = (a, done) => `<div class="sa-alert-row ${done ? 'sa-done' : ''}">
        <button class="wl-star sa-del" onclick="_saDelete(${a.id})" title="מחק התראה">✕</button>
        <div class="wl-id"><span class="wl-tk">${_saEsc(String(a.symbol).replace(/\.TA$/, ''))}</span><span class="wl-co">${_saEsc(kindTxt(a))}</span></div>
        ${done ? `<span class="sa-hit">✓ התקבל · ${a.kind === 'price' ? '$' : ''}${a.triggered_value}</span>` : '<span class="sa-pending">ממתין</span>'}
        <button class="wl-report" onclick="if(typeof openTechnicalForTicker==='function'){openTechnicalForTicker('${_saEsc(a.symbol)}'); closeAlertsPanel();}">📈 טכני</button>
    </div>`;
    ov.innerHTML = `<div class="wl-box sa-box" dir="rtl">
        <div class="wl-head"><span class="wl-title">🔔 ההתראות שלי</span><button class="wl-close" onclick="closeAlertsPanel()">✕</button></div>
        <div class="wl-list">
            ${triggered.length ? `<div class="wl-group-head">✓ התקבלו</div>${triggered.map(a => row(a, true)).join('')}` : ''}
            ${pending.length ? `<div class="wl-group-head">⏳ ממתינות</div>${pending.map(a => row(a, false)).join('')}` : ''}
            ${(!triggered.length && !pending.length) ? '<div class="wl-empty">אין התראות עדיין. קבע התראה מעמוד הניתוח הטכני (🔔 ליד כל מניה).</div>' : ''}
        </div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    // Opening the panel marks triggered alerts as seen → clears the bell dot.
    _saAlerts.forEach(a => { if (a.triggered_at) _saSeenTriggered.add(a.id); });
    _saRefreshBell();
}
function closeAlertsPanel() { const ov = document.getElementById('saPanelOverlay'); if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; } if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock(); }
async function _saDelete(id) {
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    try { await supabaseClient.from('stock_alerts').delete().eq('id', id); _saAlerts = _saAlerts.filter(a => a.id !== id); openAlertsPanel(); _saRefreshBell(); }
    catch (e) { if (typeof showToast === 'function') showToast('מחיקה נכשלה', 'error'); }
}

// Wire the header bell + start the check loop once the app is up.
function _saInit() {
    const bell = document.getElementById('headerBellBtn');
    if (bell && !bell.dataset.saWired) { bell.dataset.saWired = '1'; bell.addEventListener('click', openAlertsPanel); }
    checkStockAlerts();
    if (!window._saTimer) window._saTimer = setInterval(checkStockAlerts, 5 * 60 * 1000);   // re-check every 5 min
}
if (typeof window !== 'undefined') {
    window.openCreateAlert = openCreateAlert; window.closeCreateAlert = closeCreateAlert;
    window._saKindChanged = _saKindChanged; window._saSave = _saSave;
    window.openAlertsPanel = openAlertsPanel; window.closeAlertsPanel = closeAlertsPanel;
    window._saDelete = _saDelete; window.checkStockAlerts = checkStockAlerts;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_saInit, 3000));
    else setTimeout(_saInit, 3000);
}
