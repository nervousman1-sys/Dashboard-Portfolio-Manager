// ========== APP - Global State & Utility Functions ==========

// ── Mobile collapsible: dense sections collapse behind a tap-to-expand header on phones;
// desktop shows everything (the header is CSS-hidden ≥769px). Markup:
//   <div class="mcoll"><button class="mcoll-head" onclick="_mCollToggle(this)">
//       <span>Title</span><span class="mcoll-chev">▾</span></button>
//     <div class="mcoll-body">…dense content…</div></div>
// Opens in a focused POPUP (not an inline expand down the page). The real .mcoll-body node is
// MOVED into the modal — that keeps live Chart.js canvases intact — and moved back on close.
// Uses .wl-overlay so the phone Back button + swipe-to-dismiss already cover it.
var _mCollReturn = null;
function _mCollToggle(head) {
    var box = head && head.closest ? head.closest('.mcoll') : null;
    if (!box) return;
    var body = box.querySelector('.mcoll-body');
    if (!body) return;
    var lbl = head.querySelector('span');

    var ov = document.getElementById('mcollOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'mcollOverlay';
        ov.className = 'wl-overlay mcoll-overlay';
        ov.addEventListener('click', function (e) { if (e.target === ov) _mCollPopupClose(); });
        document.body.appendChild(ov);
    }
    ov.innerHTML = '<div class="wl-box mcoll-modal" dir="rtl">'
        + '<div class="mcoll-modal-head"><span class="mcoll-modal-title"></span>'
        + '<button class="mcoll-modal-x" aria-label="סגור" onclick="_mCollPopupClose()">✕</button></div>'
        + '<div class="mcoll-modal-body"></div></div>';
    ov.querySelector('.mcoll-modal-title').textContent = lbl ? lbl.textContent : '';

    // Remember exactly where it came from so it can be put back in place.
    _mCollReturn = { body: body, parent: box, next: body.nextSibling };
    ov.querySelector('.mcoll-modal-body').appendChild(body);
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) { } }, 60);
}
function _mCollPopupClose() {
    var ov = document.getElementById('mcollOverlay');
    if (_mCollReturn && _mCollReturn.body && _mCollReturn.parent) {
        // If the section re-rendered while the popup was open its old parent is detached —
        // then just drop the node instead of re-attaching it to nothing.
        if (document.contains(_mCollReturn.parent)) {
            _mCollReturn.parent.insertBefore(_mCollReturn.body, _mCollReturn.next || null);
        }
    }
    _mCollReturn = null;
    if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; }
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}
if (typeof window !== 'undefined') { window._mCollToggle = _mCollToggle; window._mCollPopupClose = _mCollPopupClose; }

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

function formatCurrency(val, sourceCurrency = null) {
    // Resolve source and display currencies
    const src = sourceCurrency || 'USD';
    const display = (typeof _displayCurrency !== 'undefined') ? _displayCurrency : 'USD';

    // Get live USD/ILS rate — fx-service.js populates _fxRates.USDILS on init
    const rate = (typeof _fxRates !== 'undefined' && _fxRates && _fxRates.USDILS > 0)
        ? _fxRates.USDILS
        : (typeof FX_HARDCODED_USDILS !== 'undefined' ? FX_HARDCODED_USDILS : 3.65);

    // Convert value from source currency to display currency
    let v = Number(val) || 0;
    if (src === 'USD' && display === 'ILS') v = v * rate;
    else if (src === 'ILS' && display === 'USD') v = v / rate;

    if (display === 'ILS') {
        return v.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
    }
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Format an amount IN ITS OWN currency (no conversion to the global display currency).
// Use for currency-specific lines like "מזומן (ILS)" or an Israeli asset's buy cost, where
// converting ILS→$ would be wrong/misleading. Israeli assets are quoted & bought in ₪.
function formatMoneyInCurrency(val, currency) {
    const v = Number(val) || 0;
    const sym = currency === 'ILS' ? '₪' : '$';
    return sym + Math.round(v).toLocaleString(currency === 'ILS' ? 'he-IL' : 'en-US');
}

function formatNumber(val) {
    return Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Format a price with thousands separators and 2 decimal places: 1250.5 → "1,250.50"
function formatPrice(val) {
    return Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Strip commas from a formatted input string and return a number: "1,500,000" → 1500000
function parseInputNumber(val) {
    if (val == null) return 0;
    const stripped = String(val).replace(/,/g, '');
    const num = parseFloat(stripped);
    return isNaN(num) ? 0 : num;
}

// Format an input field's value with commas while preserving cursor position and decimal typing.
// Attach via oninput: formatInputWithCommas(this)
function formatInputWithCommas(input) {
    const raw = input.value;
    // Allow empty, lone minus, or value ending with "." (user is typing a decimal)
    if (raw === '' || raw === '-' || raw.endsWith('.')) return;

    const cursorPos = input.selectionStart;
    const commasBefore = (raw.slice(0, cursorPos).match(/,/g) || []).length;

    const stripped = raw.replace(/,/g, '');
    const num = parseFloat(stripped);
    if (isNaN(num)) return;

    // Split on decimal — only format the integer part
    const parts = stripped.split('.');
    const intPart = parseInt(parts[0], 10);
    const formatted = isNaN(intPart) ? '0' : intPart.toLocaleString('en-US');
    const newValue = parts.length > 1 ? formatted + '.' + parts[1] : formatted;

    if (newValue !== raw) {
        input.value = newValue;
        // Restore cursor accounting for added/removed commas
        const commasAfter = (newValue.slice(0, cursorPos + 1).match(/,/g) || []).length;
        const newPos = cursorPos + (commasAfter - commasBefore);
        input.setSelectionRange(newPos, newPos);
    }
}
