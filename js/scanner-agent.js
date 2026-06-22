// ========== SCANNER AGENT — Early-Alpha intelligence feed ==========
// Displays the catalyst_cards produced by the 24/7 Agent Scanner (Supabase). Read-only here:
// the client reads with the anon key (RLS allows SELECT); only the agent writes (via its RPC).
// Full-screen Cyber-Noir overlay, RTL Hebrew, no chart libs — glass cards + metric chips.

let _saLoaded = false;

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
}

function closeScannerAgent(event) {
    if (event && event.target !== event.currentTarget) return;
    const overlay = document.getElementById('scannerAgentOverlay');
    if (overlay) overlay.classList.remove('active');
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
    if (force) body.innerHTML = '<div class="sa-loading">מרענן…</div>';
    let cards = null;
    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('no supabase client');
        const { data, error } = await supabaseClient
            .from('catalyst_cards').select('*').eq('status', 'active')
            .order('created_at', { ascending: false }).limit(60);
        if (error) throw error;
        cards = data || [];
    } catch (e) {
        body.innerHTML = `<div class="sa-empty">שגיאה בטעינת המודיעין. נסה לרענן בעוד רגע.<br><small>${(e && e.message) || ''}</small></div>`;
        return;
    }
    if (!cards.length) {
        body.innerHTML = `<div class="sa-empty">📡 הסוכן עדיין לא הפיק כרטיסים.<br>ברגע שהסוכן ירוץ, תובנות ה-Early-Alpha יופיעו כאן אוטומטית.</div>`;
        return;
    }
    _saLoaded = true;
    body.innerHTML = `<div class="sa-meta-bar">${cards.length} כרטיסי מודיעין · מתעדכן אוטומטית מהסוכן</div>` + cards.map(_saCardHTML).join('');
}

function _saEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _saDate(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; }

function _saCardHTML(c) {
    const stage = _saEsc(c.stage_score || '');
    const sat = _saEsc(c.media_saturation || '');
    const satLow = /low|near|zero|נמ/i.test(sat);
    const targets = Array.isArray(c.stealth_targets) ? c.stealth_targets : [];
    const sources = Array.isArray(c.sources) ? c.sources : [];

    const layer = (ic, title, txt) => txt ? `
        <div class="sa-layer">
            <span class="sa-layer-ic">${ic}</span>
            <div class="sa-layer-txt"><div class="sa-layer-t">${title}</div><div class="sa-layer-b">${_saEsc(txt)}</div></div>
        </div>` : '';

    const targetsHTML = targets.map(t => {
        const tk = String(t.ticker || '').trim();
        const real = tk && !/^n\/?a$/i.test(tk) && /^[A-Z.]{1,6}$/.test(tk);
        const tkHTML = real
            ? `<span class="sa-tk sa-tk-link" onclick="openTechnicalForTicker('${_saEsc(tk)}')" title="פתח בניתוח טכני">${_saEsc(tk)}</span>`
            : (tk ? `<span class="sa-tk sa-tk-na">${_saEsc(tk)}</span>` : '');
        return `<div class="sa-target">
            <div class="sa-target-head">${tkHTML}<span class="sa-co">${_saEsc(t.company || '')}</span></div>
            ${t.why ? `<div class="sa-why">${_saEsc(t.why)}</div>` : ''}
        </div>`;
    }).join('');

    const srcHTML = sources.map(s => {
        const title = _saEsc(s.title || s.uri || 'מקור');
        return s.uri ? `<a class="sa-src" href="${_saEsc(s.uri)}" target="_blank" rel="noopener">${title}</a>` : `<span class="sa-src">${title}</span>`;
    }).join('');

    return `
    <div class="sa-card">
        <div class="sa-card-head">
            <div class="sa-sector">${_saEsc(c.sector_name || '')}</div>
            <div class="sa-badges">
                ${stage ? `<span class="sa-badge sa-stage">${stage}</span>` : ''}
                ${sat ? `<span class="sa-badge ${satLow ? 'sa-sat-low' : 'sa-sat-hi'}">רוויה: ${sat}</span>` : ''}
                <span class="sa-badge sa-date">${_saDate(c.created_at)}</span>
            </div>
        </div>
        ${c.thesis ? `<div class="sa-thesis">${_saEsc(c.thesis)}</div>` : ''}
        <div class="sa-layers">
            ${layer('🔬', 'קטליסט טכנולוגי ומדעי', c.tech_layer)}
            ${layer('🏭', 'שרשרת אספקה וביקושים', c.supply_layer)}
            ${layer('👥', 'תנועת כוח אדם (Talent)', c.talent_layer)}
        </div>
        ${targets.length ? `<div class="sa-targets-title">מטרות סמויות (Stealth Targets)</div><div class="sa-targets">${targetsHTML}</div>` : ''}
        ${sources.length ? `<div class="sa-sources"><span class="sa-sources-lbl">מקורות:</span> ${srcHTML}</div>` : ''}
    </div>`;
}
