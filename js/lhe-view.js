// ========== LHE VIEW — Liquidity Hydrodynamic Engine ==========
// Displays the lhe_signals produced by the 24/7 LHE Agent (Supabase). Read-only here:
// the client reads with the anon key (RLS allows SELECT); only the agent writes (via its RPC).
// Full-screen Cyber-Noir overlay, RTL Hebrew. Shows: the global liquidity state (HPI),
// the asset-conduit ranking (where capital flows first), and per-asset confluence cards
// (FVG gravity + alert narrative). Auto-refreshes 24/7 while open.

let _lheTimer = null;
let _lheSig = '';
let _lheLoaded = false;
const LHE_CACHE = 'lhe_signals_v1';

function openLHE() {
    let overlay = document.getElementById('lheOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'lheOverlay';
        overlay.className = 'lhe-overlay';
        overlay.setAttribute('onclick', 'closeLHE(event)');
        document.body.appendChild(overlay);
    }
    overlay.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    if (typeof _setActiveNav === 'function') _setActiveNav('lhe');
    try { history.pushState({ popup: 'lhe' }, '', location.href); } catch (e) { }
    _lheRenderShell();
    _lheLoad();
    if (_lheTimer) clearInterval(_lheTimer);
    _lheTimer = setInterval(() => { if (document.getElementById('lheBody')) _lheLoad(); }, 120000);
}

function closeLHE(event) {
    if (event && event.target !== event.currentTarget) return;
    const overlay = document.getElementById('lheOverlay');
    if (overlay) overlay.classList.remove('active');
    if (_lheTimer) { clearInterval(_lheTimer); _lheTimer = null; }
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
}
if (typeof window !== 'undefined') { window.openLHE = openLHE; window.closeLHE = closeLHE; }

function _lheRenderShell() {
    const overlay = document.getElementById('lheOverlay');
    if (!overlay) return;
    overlay.innerHTML = `
    <div class="lhe-modal" dir="rtl" onclick="event.stopPropagation()">
        <div class="lhe-header">
            <div>
                <h2 class="lhe-title">🌊 מנוע הנזילות ההידרודינמי (LHE)</h2>
                <p class="lhe-subtitle">מודל תלת-שכבתי: לחץ נזילות מאקרו (HPI) → תעלות הולכה לנכסים (רגישות) → כבידת אזורי חוסר-יעילות בגרף (FVG). מתעדכן אוטומטית 24/7.</p>
            </div>
            <div class="lhe-head-actions">
                <button class="lhe-refresh" onclick="_lheLoad(true)" title="רענן">⟳</button>
                <button class="lhe-close" onclick="closeLHE()">&times;</button>
            </div>
        </div>
        <div class="lhe-body" id="lheBody"><div class="lhe-loading">טוען מנוע נזילות…</div></div>
    </div>`;
}

async function _lheLoad(force) {
    const body = document.getElementById('lheBody');
    if (!body) return;
    if (force) { body.innerHTML = '<div class="lhe-loading">מרענן…</div>'; _lheSig = ''; }
    // Instant paint from cache while the fresh fetch is in flight.
    if (!force && body.querySelector('.lhe-loading')) {
        try {
            const c = JSON.parse(localStorage.getItem(LHE_CACHE) || 'null');
            if (c && Array.isArray(c.rows) && c.rows.length) { body.innerHTML = _lheBuildHTML(c.rows, c.status); _lheLoaded = true; }
        } catch (e) { /* ignore */ }
    }
    let rows = null, status = null;
    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('no supabase client');
        const [sigRes, stRes] = await Promise.all([
            supabaseClient.from('lhe_signals').select('*'),
            supabaseClient.from('agent_status').select('*').eq('agent', 'lhe').maybeSingle(),
        ]);
        if (sigRes.error) throw sigRes.error;
        rows = sigRes.data || [];
        status = stRes && stRes.data ? stRes.data : null;
    } catch (e) {
        if (!_lheLoaded) body.innerHTML = `<div class="lhe-empty">שגיאה בטעינת מנוע הנזילות. נסה לרענן בעוד רגע.<br><small>${(e && e.message) || ''}</small></div>`;
        return;
    }
    if (!rows.length) {
        body.innerHTML = _lheStatusHTML(status) + `<div class="lhe-empty">🌊 הסוכן מאתחל — אין עדיין סיגנלים.<br>ברגע שהמנוע יחשב את מצב הנזילות, הסיגנלים יופיעו כאן אוטומטית.</div>`;
        _lheSig = '';
        return;
    }
    const sig = rows.map(r => `${r.ticker}:${r.updated_at}`).join('|');
    if (!force && sig === _lheSig) {
        const sEl = document.getElementById('lheStatus');
        if (sEl) sEl.outerHTML = _lheStatusHTML(status);
        return;
    }
    _lheSig = sig;
    _lheLoaded = true;
    body.innerHTML = _lheBuildHTML(rows, status);
    try { localStorage.setItem(LHE_CACHE, JSON.stringify({ rows, status })); } catch (e) { /* quota */ }
}

function _lheEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _lheRel(ts, future) {
    if (!ts) return ''; const d = new Date(ts); if (isNaN(d)) return '';
    let s = Math.round((future ? d.getTime() - Date.now() : Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 60) return future ? 'בעוד רגע' : 'ממש עכשיו';
    const m = Math.round(s / 60); if (m < 60) return (future ? 'בעוד ' : 'לפני ') + m + ' דק׳';
    const h = Math.round(m / 60); if (h < 24) return (future ? 'בעוד ' : 'לפני ') + h + ' שע׳';
    return (future ? 'בעוד ' : 'לפני ') + Math.round(h / 24) + ' ימים';
}

const _LHE_REGIME = {
    flood: { he: 'הצפת נזילות', cls: 'lhe-pos' },
    expansion: { he: 'התרחבות נזילות', cls: 'lhe-pos' },
    neutral: { he: 'נזילות מאוזנת', cls: 'lhe-neu' },
    drain: { he: 'ניקוז נזילות', cls: 'lhe-neg' },
    drought: { he: 'בצורת נזילות', cls: 'lhe-neg' },
};
function _lheRegime(r) { return _LHE_REGIME[r] || { he: r || '—', cls: 'lhe-neu' }; }
function _lheBiasMeta(bias) {
    if (bias === 'bullish') return { arrow: '▲', he: 'תרחיש עולה', cls: 'lhe-pos' };
    if (bias === 'bearish') return { arrow: '▼', he: 'תרחיש יורד', cls: 'lhe-neg' };
    return { arrow: '◆', he: 'איזון', cls: 'lhe-neu' };
}
function _lheSevCls(sev) { return sev === 'critical' ? 'lhe-sev-crit' : sev === 'high' ? 'lhe-sev-high' : sev === 'elevated' ? 'lhe-sev-elev' : 'lhe-sev-info'; }

// Live "agent is computing" heartbeat line.
function _lheStatusHTML(st) {
    const last = st && st.last_run ? new Date(st.last_run) : null;
    const live = !!last && (Date.now() - last.getTime() < 3 * 3600 * 1000);
    const label = live ? 'המנוע פעיל ומחשב נזילות 24/7' : (last ? 'המנוע לא דיווח לאחרונה — בודק' : 'ממתין לחישוב ראשון מהמנוע');
    const bits = [];
    if (last) bits.push(`חישוב אחרון ${_lheRel(st.last_run, false)}`);
    if (st && st.next_run) bits.push(`הבא ${_lheRel(st.next_run, true)}`);
    const note = st && st.last_result ? `<div class="lhe-status-note">↳ ${_lheEsc(st.last_result)}</div>` : '';
    return `<div class="lhe-meta-bar" id="lheStatus">
        <div class="lhe-status-line"><span class="lhe-live ${live ? 'lhe-live-on' : 'lhe-live-warn'}"></span><b>${label}</b></div>
        <div class="lhe-status-sub">${bits.join(' · ')}</div>${note}
    </div>`;
}

// The global liquidity state panel (HPI gauge + net-liq + conduit ranking).
function _lheMacroHTML(m) {
    const reg = _lheRegime(m.regime);
    const score = Math.round(+m.hpi_score || 0);
    const delta = +m.hpi_delta || 0;
    const dArrow = delta > 1 ? '▲' : delta < -1 ? '▼' : '▬';
    const dCls = delta > 1 ? 'lhe-pos' : delta < -1 ? 'lhe-neg' : 'lhe-neu';
    const flow = +m.net_liquidity_flow || 0;
    const ranking = (m.payload && Array.isArray(m.payload.ranking)) ? m.payload.ranking : [];
    const maxAttr = ranking.reduce((mx, r) => Math.max(mx, +r.attraction || 0), 1);
    const bars = ranking.map(r => {
        const w = Math.max(4, Math.round((+r.attraction || 0) / maxAttr * 100));
        return `<div class="lhe-rank-row">
            <span class="lhe-rank-num">${r.rank}</span>
            <span class="lhe-rank-tk">${_lheEsc(r.ticker)}</span>
            <span class="lhe-rank-track"><span class="lhe-rank-fill" style="width:${w}%"></span></span>
            <span class="lhe-rank-val">${Math.round(+r.attraction || 0)} <small>β${(+r.beta || 0).toFixed(1)}</small></span>
        </div>`;
    }).join('');

    return `<div class="lhe-macro">
        <div class="lhe-macro-top">
            <div class="lhe-gauge">
                <div class="lhe-gauge-head">
                    <span class="lhe-gauge-lbl">מדד הלחץ ההידראולי (HPI)</span>
                    <span class="lhe-regime ${reg.cls}">${reg.he}</span>
                </div>
                <div class="lhe-gauge-bar"><span class="lhe-gauge-marker" style="left:calc(${score}% - 2px)"></span></div>
                <div class="lhe-gauge-foot">
                    <span class="lhe-gauge-score ${reg.cls}">${score}<small>/100</small></span>
                    <span class="lhe-gauge-delta ${dCls}">${dArrow} מומנטום ${delta > 0 ? '+' : ''}${delta}</span>
                </div>
            </div>
            <div class="lhe-flow">
                <div class="lhe-flow-lbl">זרימת נזילות-נטו</div>
                <div class="lhe-flow-val ${flow >= 0 ? 'lhe-pos' : 'lhe-neg'}">${flow >= 0 ? '+' : '−'}$${Math.abs(flow).toFixed(0)}<small>מיליארד</small></div>
                <div class="lhe-flow-sub">בנקים מרכזיים − TGA − RRP</div>
            </div>
        </div>
        ${m.body ? `<div class="lhe-macro-body">${_lheEsc(m.body)}</div>` : ''}
        ${bars ? `<div class="lhe-rank-title">תעדוף תעלות הולכה — לאן ההון נשאב קודם</div><div class="lhe-rank">${bars}</div>` : ''}
    </div>`;
}

function _lheToggle(id) {
    const el = document.getElementById('lhe-card-' + id);
    if (el) el.classList.toggle('collapsed');
}
if (typeof window !== 'undefined') window._lheToggle = _lheToggle;

function _lheCardHTML(c) {
    const id = _lheEsc(String(c.ticker || Math.random().toString(36).slice(2)));
    const bias = _lheBiasMeta(c.bias);
    const conf = Math.round(+c.confluence_score || 0);
    const beta = (+c.liquidity_beta || 0).toFixed(2);
    const attr = Math.round(+c.attraction_score || 0);
    const sevCls = _lheSevCls(c.severity);
    const flags = Array.isArray(c.flags) ? c.flags : [];
    const t = c.target;
    const p = c.payload || {};
    const ss = p.structureShift;

    const flagChips = flags.map(f => `<span class="lhe-flag">${_lheEsc(_lheFlagHe(f))}</span>`).join('');
    const targetHTML = (t && t.zone) ? `
        <div class="lhe-target">
            <span class="lhe-target-lbl">🎯 יעד שאיבה (FVG)</span>
            <span class="lhe-target-zone">${(+t.zone[0]).toFixed(2)} – ${(+t.zone[1]).toFixed(2)}</span>
            <span class="lhe-target-meta">מילוי ${Math.round((+t.fillProbability || 0) * 100)}% · ~${t.expectedBarsToFill} ברים</span>
        </div>` : '';
    const ssHTML = (ss && ss.detected) ? `<span class="lhe-flag lhe-flag-mss">${ss.type === 'MSS' ? 'היפוך מבנה' : 'פריצת מבנה'} ${ss.direction === 'bullish' ? '▲' : '▼'}</span>` : '';

    return `
    <div class="lhe-card collapsed ${bias.cls}" id="lhe-card-${id}">
        <div class="lhe-card-head" onclick="_lheToggle('${id}')">
            <div class="lhe-card-head-l">
                <span class="lhe-caret">▸</span>
                <span class="lhe-card-bias ${bias.cls}">${bias.arrow}</span>
                <div class="lhe-card-id">
                    <span class="lhe-card-tk">${_lheEsc(c.ticker)}</span>
                    <span class="lhe-card-name">${_lheEsc(c.name || '')}</span>
                </div>
            </div>
            <div class="lhe-card-head-r">
                <span class="lhe-conf ${sevCls}">שכנוע ${conf}</span>
            </div>
        </div>
        <div class="lhe-card-body">
            <div class="lhe-stats">
                <div class="lhe-stat"><span class="lhe-stat-v">${beta}</span><span class="lhe-stat-l">Liquidity-β</span></div>
                <div class="lhe-stat"><span class="lhe-stat-v">${attr}</span><span class="lhe-stat-l">משיכת הון</span></div>
                <div class="lhe-stat"><span class="lhe-stat-v ${bias.cls}">${bias.he}</span><span class="lhe-stat-l">הטיה</span></div>
            </div>
            ${(flagChips || ssHTML) ? `<div class="lhe-flags">${ssHTML}${flagChips}</div>` : ''}
            ${c.body ? `<div class="lhe-card-narrative">${_lheEsc(c.body)}</div>` : ''}
            ${targetHTML}
            ${(typeof openTechnicalForTicker === 'function' || typeof openReportForTicker === 'function') ? `
            <div class="lhe-card-actions">
                ${typeof openTechnicalForTicker === 'function' ? `<button class="lhe-act" onclick="openTechnicalForTicker('${_lheEsc(c.ticker)}')">📈 ניתוח טכני</button>` : ''}
                ${typeof openReportForTicker === 'function' ? `<button class="lhe-act" onclick="openReportForTicker('${_lheEsc(c.ticker)}')">📄 דוחות</button>` : ''}
            </div>` : ''}
        </div>
    </div>`;
}

function _lheFlagHe(f) {
    const map = {
        MSS_BULLISH: 'היפוך מבנה עולה', MSS_BEARISH: 'היפוך מבנה יורד',
        MACRO_FVG_CONFLUENCE: 'התלכדות מאקרו–FVG', HIGH_CONDUIT_ATTRACTION: 'משיכת הון גבוהה',
        HIGH_LIQUIDITY_BETA: 'רגישות נזילות גבוהה', MACRO_FLOOD: 'הצפת נזילות', MACRO_DROUGHT: 'בצורת נזילות',
    };
    return map[f] || f;
}

function _lheBuildHTML(rows, status) {
    const macro = rows.find(r => r.kind === 'macro' || r.ticker === '_MACRO');
    const assets = rows.filter(r => r.kind !== 'macro' && r.ticker !== '_MACRO')
        .sort((a, b) => (+b.confluence_score || 0) - (+a.confluence_score || 0));
    return _lheStatusHTML(status) +
        (macro ? _lheMacroHTML(macro) : '') +
        (assets.length ? `<div class="lhe-cards-title">סיגנלים לפי נכס — ${assets.length} נכסים</div><div class="lhe-cards">${assets.map(_lheCardHTML).join('')}</div>` : '');
}
