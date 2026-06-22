// ========== SCANNER AGENT — Early-Alpha intelligence feed ==========
// Displays the catalyst_cards produced by the 24/7 Agent Scanner (Supabase). Read-only here:
// the client reads with the anon key (RLS allows SELECT); only the agent writes (via its RPC).
// Full-screen Cyber-Noir overlay, RTL Hebrew, no chart libs. Cards are COLLAPSED by default
// (date + sector + related tickers); click a card to open it. Auto-refreshes 24/7 while open.

let _saLoaded = false;
let _saTimer = null;
let _saSig = '';

function openScannerAgent() {
    let overlay = document.getElementById('scannerAgentOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'scannerAgentOverlay';
        overlay.className = 'sa-overlay';
        overlay.setAttribute('onclick', 'closeScannerAgent(event)');
        document.body.appendChild(overlay);
    }
    overlay.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    if (typeof _setActiveNav === 'function') _setActiveNav('scanneragent');
    try { history.pushState({ popup: 'scanneragent' }, '', location.href); } catch (e) { }
    _saRenderShell();
    _saLoad();
    // Continuous 24/7 refresh while the page is open (re-renders only when the data changes).
    if (_saTimer) clearInterval(_saTimer);
    _saTimer = setInterval(() => { if (document.getElementById('saBody')) _saLoad(); }, 120000);
}

function closeScannerAgent(event) {
    if (event && event.target !== event.currentTarget) return;
    const overlay = document.getElementById('scannerAgentOverlay');
    if (overlay) overlay.classList.remove('active');
    if (_saTimer) { clearInterval(_saTimer); _saTimer = null; }
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
}
if (typeof window !== 'undefined') { window.openScannerAgent = openScannerAgent; window.closeScannerAgent = closeScannerAgent; }

function _saRenderShell() {
    const overlay = document.getElementById('scannerAgentOverlay');
    if (!overlay) return;
    overlay.innerHTML = `
    <div class="sa-modal" dir="rtl" onclick="event.stopPropagation()">
        <div class="sa-header">
            <div>
                <h2 class="sa-title">📡 Scanner Agent — מודיעין Early-Alpha</h2>
                <p class="sa-subtitle">סקטורים ותתי-תעשיות בשלב המוקדם ביותר, לפני המדיה ופריצות המחיר — מבוסס הצלבת פטנטים/מדע, שרשרת אספקה, תנועת כוח-אדם והון סיכון שקט.</p>
            </div>
            <div class="sa-head-actions">
                <button class="sa-refresh" onclick="_saLoad(true)" title="רענן">⟳</button>
                <button class="sa-close" onclick="closeScannerAgent()">&times;</button>
            </div>
        </div>
        <div class="sa-body" id="saBody"><div class="sa-loading">טוען מודיעין…</div></div>
    </div>`;
}

async function _saLoad(force) {
    const body = document.getElementById('saBody');
    if (!body) return;
    if (force) { body.innerHTML = '<div class="sa-loading">מרענן…</div>'; _saSig = ''; }
    let cards = null;
    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('no supabase client');
        const { data, error } = await supabaseClient
            .from('catalyst_cards').select('*').eq('status', 'active')
            .order('created_at', { ascending: false }).limit(60);
        if (error) throw error;
        cards = data || [];
    } catch (e) {
        if (!_saLoaded) body.innerHTML = `<div class="sa-empty">שגיאה בטעינת המודיעין. נסה לרענן בעוד רגע.<br><small>${(e && e.message) || ''}</small></div>`;
        return;
    }
    if (!cards.length) {
        body.innerHTML = `<div class="sa-empty">📡 הסוכן עדיין לא הפיק כרטיסים.<br>ברגע שהסוכן ירוץ, תובנות ה-Early-Alpha יופיעו כאן אוטומטית.</div>`;
        _saSig = '';
        return;
    }
    // Re-render only when the set of cards actually changed — keeps any open card open during 24/7 refresh.
    const sig = cards.map(c => `${c.id}:${c.created_at}`).join('|');
    if (!force && sig === _saSig) return;
    _saSig = sig;
    _saLoaded = true;
    body.innerHTML = `<div class="sa-meta-bar">${cards.length} כרטיסי מודיעין · מתעדכן אוטומטית מהסוכן 24/7</div>` + cards.map(_saCardHTML).join('');
}

function _saEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _saDate(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; }

function _saToggle(id) {
    const el = document.getElementById('sa-card-' + id);
    if (el) el.classList.toggle('collapsed');
}
if (typeof window !== 'undefined') window._saToggle = _saToggle;

function _saCardHTML(c) {
    const id = _saEsc(String(c.id != null ? c.id : Math.random().toString(36).slice(2)));
    const stage = _saEsc(c.stage_score || '');
    const sat = _saEsc(c.media_saturation || '');
    const satLow = /low|near|zero|נמ/i.test(sat);
    const targets = Array.isArray(c.stealth_targets) ? c.stealth_targets : [];
    const sources = Array.isArray(c.sources) ? c.sources : [];

    // Related stocks shown in the collapsed header.
    const chips = targets.map(t => {
        const tk = String(t.ticker || '').trim().toUpperCase();
        return tk ? `<span class="sa-chip">${_saEsc(tk)}</span>` : '';
    }).join('');

    const layer = (ic, title, txt) => txt ? `
        <div class="sa-layer">
            <span class="sa-layer-ic">${ic}</span>
            <div class="sa-layer-txt"><div class="sa-layer-t">${title}</div><div class="sa-layer-b">${_saEsc(txt)}</div></div>
        </div>` : '';

    const targetsHTML = targets.map(t => {
        const tk = String(t.ticker || '').trim().toUpperCase();
        const real = tk && /^[A-Z.]{1,7}$/.test(tk);
        const mcap = (t.market_cap_b != null) ? `<span class="sa-mcap">$${t.market_cap_b}B</span>` : '';
        const tkHTML = tk ? `<span class="sa-tk">${_saEsc(tk)}</span>` : '';
        const actions = real ? `
            <div class="sa-target-actions">
                <button class="sa-act" onclick="openTechnicalForTicker('${_saEsc(tk)}')">📈 ניתוח טכני</button>
                <button class="sa-act" onclick="openReportForTicker('${_saEsc(tk)}')">📄 דוחות</button>
            </div>` : '';
        return `<div class="sa-target">
            <div class="sa-target-head">${tkHTML}<span class="sa-co">${_saEsc(t.company || '')}</span>${mcap}</div>
            ${t.why ? `<div class="sa-why">${_saEsc(t.why)}</div>` : ''}
            ${actions}
        </div>`;
    }).join('');

    const srcHTML = sources.map(s => {
        const title = _saEsc(s.title || s.uri || 'מקור');
        return s.uri ? `<a class="sa-src" href="${_saEsc(s.uri)}" target="_blank" rel="noopener">${title}</a>` : `<span class="sa-src">${title}</span>`;
    }).join('');

    return `
    <div class="sa-card collapsed" id="sa-card-${id}">
        <div class="sa-card-head" onclick="_saToggle('${id}')">
            <div class="sa-head-row">
                <span class="sa-caret">▸</span>
                <div class="sa-sector">${_saEsc(c.sector_name || '')}</div>
            </div>
            <div class="sa-head-meta">
                ${chips ? `<div class="sa-chips">${chips}</div>` : ''}
                <span class="sa-badge sa-date">${_saDate(c.created_at)}</span>
            </div>
        </div>
        <div class="sa-card-body">
            ${(stage || sat) ? `<div class="sa-badges">
                ${stage ? `<span class="sa-badge sa-stage">${stage}</span>` : ''}
                ${sat ? `<span class="sa-badge ${satLow ? 'sa-sat-low' : 'sa-sat-hi'}">רוויה: ${sat}</span>` : ''}
            </div>` : ''}
            ${c.thesis ? `<div class="sa-thesis">${_saEsc(c.thesis)}</div>` : ''}
            <div class="sa-layers">
                ${layer('🔬', 'קטליסט טכנולוגי ומדעי', c.tech_layer)}
                ${layer('🏭', 'שרשרת אספקה וביקושים', c.supply_layer)}
                ${layer('👥', 'תנועת כוח אדם (Talent)', c.talent_layer)}
            </div>
            ${targets.length ? `<div class="sa-targets-title">מטרות סמויות (Stealth Targets)</div><div class="sa-targets">${targetsHTML}</div>` : ''}
            ${sources.length ? `<div class="sa-sources"><span class="sa-sources-lbl">מקורות:</span> ${srcHTML}</div>` : ''}
        </div>
    </div>`;
}
