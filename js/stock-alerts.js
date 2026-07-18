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
    ma_w200: { he: 'ממוצע 200 שבועות', unit: '' },
    ma_w300: { he: 'ממוצע 300 שבועות', unit: '' },
    fvg_m: { he: 'FVG חודשי', unit: '' },
    fvg_q: { he: 'FVG רבעוני', unit: '' },
    atr: { he: 'ATR יומי', unit: '%' },
    vol: { he: 'נפח חריג', unit: '×' },
    earnings: { he: 'פרסום דוח כספי', unit: '' },
};
function _saEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function _saHeDate(d) { try { const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(d); } catch (e) { return String(d); } }

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
                <!-- Alert types = the table's price-relative indicators: a user PRICE target + price
                     crossing the 200/300 day & week MAs + entering a monthly/quarterly FVG. The
                     type-an-indicator-value kinds (RSI/ATR/volume) were intentionally removed from the
                     create flow (kept in _SA_KINDS below so existing alerts still render). -->
                <select id="saKind" class="st-pf-select" onchange="_saKindChanged()">
                    <option value="price">מחיר מגיע ל…</option>
                    <option value="ma200">המחיר חוצה ממוצע 200 יום</option>
                    <option value="ma300">המחיר חוצה ממוצע 300 יום</option>
                    <option value="ma_w200">המחיר חוצה ממוצע 200 שבועות</option>
                    <option value="ma_w300">המחיר חוצה ממוצע 300 שבועות</option>
                    <option value="fvg_m">המחיר נכנס ל-FVG חודשי</option>
                    <option value="fvg_q">המחיר נכנס ל-FVG רבעוני</option>
                </select>
            </div>
            <div class="sa-field" id="saDirWrap"><label>כיוון</label>
                <select id="saDir" class="st-pf-select">
                    <option value="above">מעל / חוצה כלפי מעלה</option>
                    <option value="below">מתחת / חוצה כלפי מטה</option>
                </select>
            </div>
            <div class="sa-field" id="saThreshWrap"><label id="saThreshLbl">מחיר יעד ($)</label>
                <input type="number" id="saThresh" class="corr-input" step="any" value="${price}" placeholder="ערך יעד" />
            </div>
            <div class="sa-cur" id="saCur">${cur ? `כרגע: מחיר $${price} · RSI יומי ${rsiD} · RSI שבועי ${rsiW}${cur.ma && cur.ma.d200 != null ? ' · ממ׳ 200 יום $' + (+cur.ma.d200).toFixed(2) : ''}${cur.ma && cur.ma.w200 != null ? ' · ממ׳ 200 שב׳ $' + (+cur.ma.w200).toFixed(2) : ''}${cur.atrPct != null ? ' · ATR ' + cur.atrPct + '%' : ''}${(cur.fvgM && cur.fvgM.inside) ? ' · בתוך FVG חודשי' : ''}` : 'הנתונים הנוכחיים ייטענו מהסריקה הטכנית'}</div>
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
// Kinds whose "level" is a moving indicator / a state → no manual threshold needed.
const _SA_NO_THRESH = ['ma200', 'ma300', 'ma_w200', 'ma_w300', 'fvg_m', 'fvg_q'];
const _SA_NO_DIR = ['fvg_m', 'fvg_q']; // FVG = "price enters the gap", direction is irrelevant
function _saKindChanged() {
    const kind = (document.getElementById('saKind') || {}).value;
    const wrap = document.getElementById('saThreshWrap');
    const lbl = document.getElementById('saThreshLbl');
    const dirWrap = document.getElementById('saDirWrap');
    if (dirWrap) dirWrap.style.display = _SA_NO_DIR.includes(kind) ? 'none' : '';
    if (!wrap) return;
    if (_SA_NO_THRESH.includes(kind)) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    lbl.textContent = kind === 'price' ? 'מחיר יעד ($)'
        : (kind === 'rsi_d' || kind === 'rsi_w') ? 'ערך RSI יעד (0–100)'
            : kind === 'atr' ? 'ATR יומי יעד (%)'
                : kind === 'vol' ? 'מכפיל נפח מול הממוצע (למשל 2)'
                    : 'ערך יעד';
}
async function _saSave(sym, market) {
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    const kind = document.getElementById('saKind').value;
    const direction = _SA_NO_DIR.includes(kind) ? 'above' : document.getElementById('saDir').value;
    const needThresh = !_SA_NO_THRESH.includes(kind);
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

// Earnings alert — created from the "דוחות קרובים" modal: notify in the bell the moment the
// company's next report is published (with beat/miss). Stores the scheduled date in `note`.
async function createEarningsAlert(sym, schedDate) {
    if (typeof ensureSupabaseReady !== 'function' || !(await ensureSupabaseReady())) { if (typeof showToast === 'function') showToast('אין כרגע חיבור לשרת. נסה שוב בעוד רגע.', 'error'); return; }
    try {
        const symU = String(sym).toUpperCase();
        // Avoid duplicate active earnings alerts for the same symbol.
        const dup = (_saAlerts || []).some(a => a.kind === 'earnings' && a.active && !a.triggered_at && String(a.symbol).toUpperCase() === symU);
        if (dup) { if (typeof showToast === 'function') showToast('כבר קיימת התראת דוח פעילה למניה זו', 'info'); return; }
        const { error } = await supabaseClient.from('stock_alerts').insert({ symbol: symU, market: symU.endsWith('.TA') ? 'il' : 'us', kind: 'earnings', direction: 'above', threshold: null, note: String(schedDate || '').slice(0, 10) });
        if (error) throw error;
        if (typeof showToast === 'function') showToast('התראת דוח נקבעה — תופיע בפעמון כשהדוח יתפרסם', 'success');
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
    if (a.kind === 'ma_w200' && cur.ma && cur.ma.w200 != null && cur.price != null) return cmp(cur.price, cur.ma.w200) ? cur.price : null;
    if (a.kind === 'ma_w300' && cur.ma && cur.ma.w300 != null && cur.price != null) return cmp(cur.price, cur.ma.w300) ? cur.price : null;
    if (a.kind === 'fvg_m') return (cur.fvgM && cur.fvgM.inside && cur.price != null) ? cur.price : null;
    if (a.kind === 'fvg_q') return (cur.fvgQ && cur.fvgQ.inside && cur.price != null) ? cur.price : null;
    if (a.kind === 'atr' && cur.atrPct != null) return cmp(cur.atrPct, a.threshold) ? cur.atrPct : null;
    if (a.kind === 'vol' && cur.vol != null && cur.volAvg > 0) { const ratio = cur.vol / cur.volAvg; return cmp(ratio, a.threshold) ? +ratio.toFixed(2) : null; }
    return null;
}
// Earnings alert: released when the latest reported quarter reaches (within a few days of) the
// scheduled report date stored on the alert. Returns the signed surprise % (beat>0 / miss<0) on hit.
function _saEarningsMet(a, info) {
    if (!info || !info.reportedDate) return null;
    const sched = a.note ? String(a.note).slice(0, 10) : (info.scheduled || null);
    if (!sched) return null;
    const released = (new Date(info.reportedDate) - new Date(sched)) / 86400e3 >= -4;
    if (!released) return null;
    return info.surprisePct != null ? info.surprisePct : (info.epsActual != null ? info.epsActual : 0);
}
async function _saTrigger(a, value) {
    const ts = new Date().toISOString(); const v = +(+value).toFixed(2);
    try { await supabaseClient.from('stock_alerts').update({ triggered_at: ts, triggered_value: v, active: false }).eq('id', a.id); } catch (e) { }
    a.triggered_at = ts; a.triggered_value = v; a.active = false;
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
        const techPending = pending.filter(a => a.kind !== 'earnings');
        const earnPending = pending.filter(a => a.kind === 'earnings');
        // price / RSI / MA alerts → live technical scan
        if (techPending.length) {
            const syms = [...new Set(techPending.map(a => String(a.symbol).toUpperCase()))].slice(0, 60);
            let scan = {};
            try {
                const today = new Date().toISOString().slice(0, 10);
                const r = await fetch(`/api/technicals?mode=scan&symbols=${encodeURIComponent(syms.join(','))}&d=${today}&v=2`, { headers: { Accept: 'application/json' } });
                const j = await r.json(); scan = (j && j.results) || {};
            } catch (e) { }
            for (const a of techPending) {
                const hit = _saConditionMet(a, scan[String(a.symbol).toUpperCase()]);
                if (hit != null) await _saTrigger(a, hit);
            }
        }
        // earnings alerts → live Yahoo earnings status (real-time report detection)
        if (earnPending.length) {
            const syms = [...new Set(earnPending.map(a => String(a.symbol).toUpperCase()))].slice(0, 24);
            let er = {};
            try {
                const r = await fetch(`/api/technicals?mode=earnings&symbols=${encodeURIComponent(syms.join(','))}`, { headers: { Accept: 'application/json' } });
                const j = await r.json(); er = (j && j.results) || {};
            } catch (e) { }
            for (const a of earnPending) {
                const hit = _saEarningsMet(a, er[String(a.symbol).toUpperCase()]);
                if (hit != null) await _saTrigger(a, hit);
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
        const dir = a.direction === 'above' ? 'מעל' : 'מתחת ל';
        if (a.kind === 'earnings') return `📊 ${k}${a.note ? ' · צפוי ' + _saHeDate(a.note) : ''}`;
        if (a.kind === 'fvg_m' || a.kind === 'fvg_q') return `המחיר נכנס ל-${k}`;
        if (a.kind === 'ma200' || a.kind === 'ma300' || a.kind === 'ma_w200' || a.kind === 'ma_w300') return `המחיר ${dir}${k}`;
        if (a.kind === 'atr') return `ATR יומי ${dir} ${a.threshold}%`;
        if (a.kind === 'vol') return `נפח ${a.threshold}× מהממוצע ומעלה`;
        return `${k} ${dir} ${a.kind === 'price' ? '$' : ''}${a.threshold}`;
    };
    const doneChip = (a) => {
        if (a.kind === 'earnings') {
            const sp = a.triggered_value;
            if (sp == null) return '✓ הדוח התקבל';
            return sp >= 0 ? `✓ הדוח התקבל · היכתה +${sp}%` : `✓ הדוח התקבל · פספסה ${sp}%`;
        }
        return `✓ התקבל · ${a.kind === 'price' ? '$' : ''}${a.triggered_value}`;
    };
    const linkBtn = (a) => a.kind === 'earnings'
        ? `<button class="wl-report" onclick="if(typeof openReportForTicker==='function'){openReportForTicker('${_saEsc(a.symbol)}'); closeAlertsPanel();}">📊 דוח</button>`
        : `<button class="wl-report" onclick="if(typeof openTechnicalForTicker==='function'){openTechnicalForTicker('${_saEsc(a.symbol)}'); closeAlertsPanel();}">📈 טכני</button>`;
    const row = (a, done) => `<div class="sa-alert-row ${done ? 'sa-done' : ''}">
        <button class="wl-star sa-del" onclick="_saDelete(${a.id})" title="מחק התראה">✕</button>
        <div class="wl-id"><span class="wl-tk">${_saEsc(String(a.symbol).replace(/\.TA$/, ''))}</span><span class="wl-co">${_saEsc(kindTxt(a))}</span></div>
        ${done ? `<span class="sa-hit ${a.kind === 'earnings' && a.triggered_value < 0 ? 'sa-hit-miss' : ''}">${_saEsc(doneChip(a))}</span>` : '<span class="sa-pending">ממתין</span>'}
        ${linkBtn(a)}
    </div>`;
    ov.innerHTML = `<div class="wl-box sa-box" dir="rtl">
        <div class="wl-head"><span class="wl-title">🔔 ההתראות שלי</span><button class="wl-close" onclick="closeAlertsPanel()">✕</button></div>
        <div class="wl-list">
            ${triggered.length ? `<div class="wl-group-head">✓ התקבלו</div>${triggered.map(a => row(a, true)).join('')}` : ''}
            ${pending.length ? `<div class="wl-group-head">⏳ ממתינות</div>${pending.map(a => row(a, false)).join('')}` : ''}
            ${(!triggered.length && !pending.length) ? '<div class="wl-empty">אין התראות עדיין. קבע התראת מחיר/אינדיקטור מעמוד הניתוח הטכני (🔔 ליד כל מניה), או התראת דוח מ"דוחות קרובים".</div>' : ''}
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
    window.createEarningsAlert = createEarningsAlert;
    window._saKindChanged = _saKindChanged; window._saSave = _saSave;
    window.openAlertsPanel = openAlertsPanel; window.closeAlertsPanel = closeAlertsPanel;
    window._saDelete = _saDelete; window.checkStockAlerts = checkStockAlerts;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_saInit, 3000));
    else setTimeout(_saInit, 3000);
}
