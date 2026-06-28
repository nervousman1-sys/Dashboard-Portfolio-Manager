// ========== SCANNER AGENT — Early-Alpha intelligence feed ==========
// Displays the catalyst_cards produced by the 24/7 Agent Scanner (Supabase). Read-only here:
// the client reads with the anon key (RLS allows SELECT); only the agent writes (via its RPC).
// Full-screen Cyber-Noir overlay, RTL Hebrew, no chart libs. Cards are COLLAPSED by default
// (date + sector + related tickers); click a card to open it. Auto-refreshes 24/7 while open.

let _saLoaded = false;
let _saTimer = null;
let _saSig = '';

// Open as a routed PAGE (not a popup) — same pattern as the reports/LHE pages.
function openScannerAgentPage() {
    const page = document.getElementById('scannerPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'scannerPage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('scanneragent');
    if (typeof updateURLState === 'function') updateURLState({ view: 'scanneragent' });

    _saRenderShell();
    window.scrollTo(0, 0);
    _saLoad();
    // Continuous 24/7 refresh while the page is open (re-renders only when the data changes).
    if (_saTimer) clearInterval(_saTimer);
    _saTimer = setInterval(() => { if (document.getElementById('saBody')) _saLoad(); }, 120000);
}

function closeScannerAgentPage() {
    const page = document.getElementById('scannerPage');
    if (_saTimer) { clearInterval(_saTimer); _saTimer = null; }
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
// Back-compat aliases (sidebar / history / router all keep working).
if (typeof window !== 'undefined') {
    window.openScannerAgentPage = openScannerAgentPage; window.closeScannerAgentPage = closeScannerAgentPage;
    window.openScannerAgent = openScannerAgentPage; window.closeScannerAgent = closeScannerAgentPage;
}

function _saRenderShell() {
    const page = document.getElementById('scannerPage');
    if (!page) return;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">📡 Scanner Agent — מודיעין Early-Alpha</h1>
            <button class="macro-back-btn" onclick="closeScannerAgentPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="sa-intro">
                <p class="sa-subtitle">סקטורים ותתי-תעשיות בשלב המוקדם ביותר, לפני המדיה ופריצות המחיר — מבוסס הצלבת פטנטים/מדע, שרשרת אספקה, תנועת כוח-אדם והון סיכון שקט.</p>
                <button class="sa-refresh" onclick="_saLoad(true)" title="רענן">⟳ רענן</button>
            </div>
            <div class="sa-body" id="saBody"><div class="sa-loading">טוען מודיעין…</div></div>
        </div>
    </div>`;
}

const SA_CACHE = 'sa_cards_v1';
async function _saLoad(force) {
    const body = document.getElementById('saBody');
    if (!body) return;
    if (force) { body.innerHTML = '<div class="sa-loading">מרענן…</div>'; _saSig = ''; }
    // Instant paint from the last-seen intel while the fresh Supabase fetch is in flight — opening
    // the overlay shows cards immediately instead of a long "טוען מודיעין…" spinner (cold fetch).
    if (!force && body.querySelector('.sa-loading')) {
        try {
            const c = JSON.parse(localStorage.getItem(SA_CACHE) || 'null');
            if (c && Array.isArray(c.cards) && c.cards.length) {
                body.innerHTML = _saStatusHTML(c.status, c.cards.length) + c.cards.map(_saCardHTML).join('');
                _saLoaded = true; // keep _saSig empty so the fresh fetch still re-renders when it differs
            }
        } catch (e) { /* ignore corrupt cache */ }
    }
    let cards = null, status = null;
    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('no supabase client');
        const [cardsRes, statusRes] = await Promise.all([
            supabaseClient.from('catalyst_cards').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(60),
            supabaseClient.from('agent_status').select('*').eq('agent', 'scanner').maybeSingle(),
        ]);
        if (cardsRes.error) throw cardsRes.error;
        cards = cardsRes.data || [];
        status = statusRes && statusRes.data ? statusRes.data : null;
    } catch (e) {
        if (!_saLoaded) body.innerHTML = `<div class="sa-empty">שגיאה בטעינת המודיעין. נסה לרענן בעוד רגע.<br><small>${(e && e.message) || ''}</small></div>`;
        return;
    }
    if (!cards.length) {
        body.innerHTML = _saStatusHTML(status, 0) + `<div class="sa-empty">📡 הסוכן סורק — עדיין לא נמצא מודיעין חדש בעל ודאות מספקת.<br>ברגע שיימצא, כרטיס Early-Alpha יופיע כאן אוטומטית.</div>`;
        _saSig = '';
        try { localStorage.removeItem(SA_CACHE); } catch (e) { } // don't keep showing intel that's no longer active
        return;
    }
    // Re-render the card list only when it actually changed — keeps any open card open during 24/7
    // refresh — but always refresh the live status line.
    const sig = cards.map(c => `${c.id}:${c.created_at}`).join('|');
    if (!force && sig === _saSig) {
        const sEl = document.getElementById('saStatus');
        if (sEl) sEl.outerHTML = _saStatusHTML(status, cards.length);
        return;
    }
    _saSig = sig;
    _saLoaded = true;
    body.innerHTML = _saStatusHTML(status, cards.length) + cards.map(_saCardHTML).join('');
    // Persist for the next open's instant paint (cap to bound localStorage size).
    try { localStorage.setItem(SA_CACHE, JSON.stringify({ cards: cards.slice(0, 40), status })); } catch (e) { /* quota — fine */ }
}

function _saEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _saDate(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; }
function _saRel(ts, future) {
    if (!ts) return ''; const d = new Date(ts); if (isNaN(d)) return '';
    let s = Math.round((future ? d.getTime() - Date.now() : Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 60) return future ? 'בעוד רגע' : 'ממש עכשיו';
    const m = Math.round(s / 60); if (m < 60) return (future ? 'בעוד ' : 'לפני ') + m + ' דק׳';
    const h = Math.round(m / 60); if (h < 24) return (future ? 'בעוד ' : 'לפני ') + h + ' שע׳';
    return (future ? 'בעוד ' : 'לפני ') + Math.round(h / 24) + ' ימים';
}

// Live "agent is scanning" status line — proves the 24/7 daemon is alive (heartbeat from agent_status).
function _saStatusHTML(st, count) {
    const last = st && st.last_run ? new Date(st.last_run) : null;
    const live = !!last && (Date.now() - last.getTime() < 6 * 3600 * 1000); // healthy if it reported within 6h
    const label = live ? 'הסוכן פעיל וסורק מודיעין 24/7' : (last ? 'הסוכן לא דיווח לאחרונה — בודק' : 'ממתין לדיווח ראשון מהסוכן');
    const bits = [];
    if (last) bits.push(`סריקה אחרונה ${_saRel(st.last_run, false)}`);
    if (st && st.next_run) bits.push(`הסריקה הבאה ${_saRel(st.next_run, true)}`);
    if (st && st.cycles) bits.push(`${st.cycles} סבבי סריקה`);
    bits.push(`${count} כרטיסים`);
    const note = st && st.last_result ? `<div class="sa-status-note">↳ ${_saEsc(st.last_result)}</div>` : '';
    return `<div class="sa-meta-bar" id="saStatus">
        <div class="sa-status-line"><span class="sa-live ${live ? 'sa-live-on' : 'sa-live-warn'}"></span><b>${label}</b></div>
        <div class="sa-status-sub">${bits.join(' · ')}</div>${note}
    </div>`;
}

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
