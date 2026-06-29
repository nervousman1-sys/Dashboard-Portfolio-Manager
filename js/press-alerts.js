// ============================================================================
// Finextium — "הוצאות לעיתונות" (Press Releases) — per-portfolio tab inside the portfolio modal
// ----------------------------------------------------------------------------
// NOT a standalone page. Mounts as a tab in each portfolio's modal (after "נתוני תיק"):
// live press releases that the portfolio's companies filed with the U.S. SEC (EDGAR 8-K
// current reports — the official "material event" filings, NOT Yahoo/news articles).
//
// Data flow:
//   24/7 press-agent (Node, VPS) ── SEC EDGAR 8-K ──► route_portfolio_alert() ──► portfolio_alerts
//        portfolio_alerts is Realtime-enabled ── INSERT (filtered by this portfolio) ──► this tab
//
// RLS + the portfolio_id filter make the stream return only THIS portfolio's filings.
// ============================================================================

/** @typedef {('buyback'|'ceo_change'|'guidance_up'|'guidance_down'|'lawsuit'|'ma'|'dividend'|'offering'|'other')} PaCategory */

const PA_CATEGORIES = {
    buyback:       { he: 'רכישה עצמית',     cls: 'pa-cat-green',  bias: 'pos' },
    ceo_change:    { he: 'שינוי בהנהלה',     cls: 'pa-cat-red',    bias: 'neg' },
    guidance_up:   { he: 'תוצאות / תחזית',   cls: 'pa-cat-green',  bias: 'pos' },
    guidance_down: { he: 'אזהרת רווח',       cls: 'pa-cat-red',    bias: 'neg' },
    lawsuit:       { he: 'משפטי / רגולציה',  cls: 'pa-cat-red',    bias: 'neg' },
    ma:            { he: 'הסכם מהותי',        cls: 'pa-cat-purple', bias: 'pos' },
    dividend:      { he: 'דיבידנד',          cls: 'pa-cat-green',  bias: 'pos' },
    offering:      { he: 'גיוס / הנפקה',      cls: 'pa-cat-orange', bias: 'neg' },
    other:         { he: 'דיווח מהותי (8-K)', cls: 'pa-cat-slate',  bias: 'neutral' },
};
function _paCatMeta(cat) { return PA_CATEGORIES[cat] || PA_CATEGORIES.other; }

// ── Per-mount state (one portfolio at a time — the modal shows one portfolio) ──
let _prAlerts = [];
let _prChannel = null;
let _prClientId = null;
let _prSeen = new Set();
let _prClockTimer = null;
const PR_MAX = 80;

// ── Mount the tab for a given portfolio (called from switchModalTab('pressreleases')) ──
function _prMount(clientId) {
    _prCleanup();
    _prClientId = clientId;
    _prAlerts = [];
    _prSeen = new Set();
    _prEnsureModal();
    const feed = document.getElementById('prFeed');
    if (feed) feed.innerHTML = '<div class="pa-empty" id="prEmpty">טוען הוצאות לעיתונות שהוגשו לרשות ניירות ערך (SEC)…</div>';
    _prLoad(clientId);
    _prSubscribe(clientId);
    if (_prClockTimer) clearInterval(_prClockTimer);
    _prClockTimer = setInterval(_prRefreshClocks, 15000);
}
if (typeof window !== 'undefined') window._prMount = _prMount;

function _prCleanup() {
    if (_prChannel) { try { supabaseClient.removeChannel(_prChannel); } catch (e) { } _prChannel = null; }
    if (_prClockTimer) { clearInterval(_prClockTimer); _prClockTimer = null; }
    _prClientId = null;
}
if (typeof window !== 'undefined') window._prCleanup = _prCleanup;

// ── Initial load: this portfolio's filings (RLS + portfolio_id, newest first) ──
async function _prLoad(clientId) {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) { _prEmptyState(); return; }
    try {
        const { data, error } = await supabaseClient.from('portfolio_alerts')
            .select('*').eq('status', 'active').eq('portfolio_id', Number(clientId))
            .order('created_at', { ascending: false }).limit(PR_MAX);
        if (error) { console.warn('[PressReleases] load:', error.message); _prEmptyState(); return; }
        if (Number(clientId) !== Number(_prClientId)) return;   // tab changed mid-fetch
        if (!data || !data.length) { _prEmptyState(); return; }
        data.reverse().forEach(a => _prPrepend(a, false));
    } catch (e) { console.warn('[PressReleases] load failed:', e.message); _prEmptyState(); }
}

function _prEmptyState() {
    const feed = document.getElementById('prFeed');
    if (feed && !feed.querySelector('.pa-card')) {
        feed.innerHTML = `<div class="pa-empty">אין עדיין הוצאות לעיתונות עבור נכסי תיק זה.<br>
        הסוכן סורק את הרשות לניירות ערך (SEC) 24/7 — ברגע שאחת מחברות התיק תגיש דיווח מהותי (8-K), הוא יופיע כאן אוטומטית.</div>`;
    }
}

// ── Realtime: live INSERTs for THIS portfolio only ───────────────────────────
function _prSubscribe(clientId) {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    if (_prChannel) { try { supabaseClient.removeChannel(_prChannel); } catch (e) { } _prChannel = null; }
    try {
        _prChannel = supabaseClient
            .channel('pr-portfolio-' + clientId + '-' + Date.now())
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'portfolio_alerts', filter: `portfolio_id=eq.${Number(clientId)}` },
                (payload) => { if (payload && payload.new) _prPrepend(payload.new, true); })
            .subscribe((status) => {
                const dot = document.querySelector('#tab-pressreleases .pa-live-dot');
                if (dot) dot.classList.toggle('pa-live-off', status !== 'SUBSCRIBED');
            });
    } catch (e) { console.warn('[PressReleases] subscribe failed:', e.message); }
}

// ── Insert a card (top), with the live entry animation when isLive ───────────
function _prPrepend(alert, isLive) {
    if (!alert) return;
    const key = String(alert.id != null ? alert.id : (alert.ticker + '|' + alert.headline_en));
    if (_prSeen.has(key)) return;
    _prSeen.add(key);
    _prAlerts.unshift(alert);
    if (_prAlerts.length > PR_MAX) _prAlerts.length = PR_MAX;

    const feed = document.getElementById('prFeed');
    if (!feed) return;
    const empty = feed.querySelector('.pa-empty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.innerHTML = _prCardHTML(alert);
    const card = wrap.firstElementChild;
    if (!card) return;
    if (isLive) card.classList.add('pa-enter');
    feed.insertBefore(card, feed.firstChild);
    if (isLive) { card.offsetHeight; requestAnimationFrame(() => card.classList.remove('pa-enter')); }
    while (feed.children.length > PR_MAX) feed.removeChild(feed.lastChild);
}

function _prCardHTML(a) {
    const cat = _paCatMeta(a.category);
    const sent = +a.sentiment || 0;
    const sArrow = sent > 4 ? '▲' : sent < -4 ? '▼' : '◆';
    const sCls = sent > 4 ? 'pa-pos' : sent < -4 ? 'pa-neg' : 'pa-neu';
    const ts = a.created_at || a.published_at;
    const id = _paEsc(String(a.id));
    return `
    <div class="pa-card ${sCls}" id="pr-card-${id}" data-ts="${_paEsc(String(ts || ''))}">
        <div class="pa-card-l">
            <div class="pa-card-top">
                <span class="pa-ticker">$${_paEsc(a.ticker || '')}</span>
                <span class="pa-badge ${cat.cls}">${_paEsc(cat.he)}</span>
                <span class="pa-sent ${sCls}" title="הערכת השפעה של ה-AI">${sArrow} ${sent > 0 ? '+' : ''}${sent}</span>
            </div>
            <div class="pa-summary">${_paEsc(a.summary_he || a.headline_en || '')}</div>
            <div class="pa-meta">
                <span class="pa-company">${_paEsc(a.company || '')}</span>
                <span class="pa-dot">·</span>
                <span class="pa-time" data-ts="${_paEsc(String(ts || ''))}">${_paTimeAgo(ts)}</span>
                <span class="pa-dot">·</span>
                <span class="pa-source">${_paEsc(a.source || 'SEC EDGAR')}</span>
            </div>
        </div>
        <div class="pa-card-r">
            <button class="pa-read-btn" onclick="_prOpenModal('${id}')">קרא את הדיווח המלא</button>
        </div>
    </div>`;
}

// ── "Read full report" modal (injected once into <body>; sits above the portfolio modal) ──
function _prEnsureModal() {
    if (document.getElementById('prModalOverlay')) return;
    const el = document.createElement('div');
    el.className = 'pa-modal-overlay';
    el.id = 'prModalOverlay';
    el.onclick = (e) => { if (e.target === el) _prCloseModal(); };
    el.innerHTML = '<div class="pa-modal" id="prModal" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(el);
}

function _prOpenModal(id) {
    const a = _prAlerts.find(x => String(x.id) === String(id));
    if (!a) return;
    _prEnsureModal();
    const cat = _paCatMeta(a.category);
    const sent = +a.sentiment || 0;
    const sCls = sent > 4 ? 'pa-pos' : sent < -4 ? 'pa-neg' : 'pa-neu';
    const modal = document.getElementById('prModal');
    const overlay = document.getElementById('prModalOverlay');
    if (!modal || !overlay) return;
    const an = a._analysis;
    const loading = `<div class="pa-an-loading"><span class="pa-an-spin"></span> מנתח את הדיווח…</div>`;
    modal.innerHTML = `
        <div class="pa-modal-head">
            <div class="pa-modal-title">
                <span class="pa-ticker">$${_paEsc(a.ticker || '')}</span>
                <span class="pa-badge ${cat.cls}">${_paEsc(cat.he)}</span>
                <span class="pa-sent ${sCls}">${sent > 0 ? '+' : ''}${sent}</span>
            </div>
            <button class="pa-modal-x" onclick="_prCloseModal()" aria-label="סגור">×</button>
        </div>
        <div class="pa-modal-company">${_paEsc(a.company || '')} · ${_paTimeAgo(a.created_at || a.published_at)} · ${_paEsc(a.source || 'SEC EDGAR')}</div>
        <div class="pa-modal-section">
            <div class="pa-modal-h">תקציר הנקודות המהותיות</div>
            <div id="prPoints" dir="rtl">${an ? _prPointsHTML(an, a) : loading}</div>
        </div>
        <div class="pa-modal-section">
            <div class="pa-modal-h">השלכות הדיווח</div>
            <div id="prImpl" class="pa-modal-analysis" dir="rtl">${an ? _paEsc(an.implications_he || a.analysis_he || '') : loading}</div>
        </div>
        <div class="pa-modal-section">
            <div class="pa-modal-h">הדיווח המקורי (מתוך הגשת ה-SEC)</div>
            <div class="pa-modal-en" dir="ltr">
                <div class="pa-modal-en-head">${_paEsc(a.headline_en || '')}</div>
                <p class="pa-modal-en-body">${_paEsc(a.body_en || '')}</p>
                ${a.source_url ? `<a class="pa-modal-link" href="${_paEsc(a.source_url)}" target="_blank" rel="noopener">פתח את ההגשה ב-SEC EDGAR ↗</a>` : ''}
            </div>
        </div>`;
    overlay.classList.add('open');
    if (!an) _prFetchAnalysis(a);
}

// Build the "material points" block: AI bullet points (+ the one-line summary if present).
function _prPointsHTML(an, a) {
    const pts = (an && Array.isArray(an.points_he) && an.points_he.length) ? an.points_he : null;
    const head = (an && an.summary_he) ? `<p class="pa-an-tldr">${_paEsc(an.summary_he)}</p>` : '';
    if (pts) return head + '<ul class="pa-an-points">' + pts.map(p => `<li>${_paEsc(p)}</li>`).join('') + '</ul>';
    return head + `<p class="pa-modal-analysis">${_paEsc((a && (a.summary_he || a.analysis_he)) || '')}</p>`;
}

// On-demand deep analysis (material points + implications) via the Gemini-backed serverless fn.
// Result is cached on the alert object so re-opening is instant.
async function _prFetchAnalysis(a) {
    try {
        const r = await fetch('/api/vision?mode=filing', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: a.ticker, company: a.company, category: a.category, headline: a.headline_en, body: a.body_en }),
        });
        const j = r.ok ? await r.json() : null;
        if (j && (Array.isArray(j.points_he) && j.points_he.length || j.implications_he)) {
            a._analysis = j;
        } else {
            a._analysis = { points_he: [], implications_he: a.analysis_he || '', summary_he: a.summary_he || '' };
        }
    } catch (e) {
        a._analysis = { points_he: [], implications_he: a.analysis_he || '', summary_he: a.summary_he || '' };
    }
    // Render into the open modal (if it's still showing this alert).
    const pEl = document.getElementById('prPoints');
    const iEl = document.getElementById('prImpl');
    if (pEl) pEl.innerHTML = _prPointsHTML(a._analysis, a);
    if (iEl) iEl.innerHTML = _paEsc(a._analysis.implications_he || a.analysis_he || '');
}
if (typeof window !== 'undefined') window._prFetchAnalysis = _prFetchAnalysis;
function _prCloseModal() { const o = document.getElementById('prModalOverlay'); if (o) o.classList.remove('open'); }
if (typeof window !== 'undefined') { window._prOpenModal = _prOpenModal; window._prCloseModal = _prCloseModal; }

// ── Dynamic relative timestamps ──────────────────────────────────────────────
function _paTimeAgo(ts) {
    if (!ts) return 'הרגע';
    const t = new Date(ts).getTime();
    if (!isFinite(t)) return 'הרגע';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 45) return 'הרגע';
    const m = Math.floor(s / 60);
    if (m < 60) return `לפני ${m} דק׳`;
    const h = Math.floor(m / 60);
    if (h < 24) return `לפני ${h} שע׳`;
    const d = Math.floor(h / 24);
    if (d < 7) return `לפני ${d} ימים`;
    return new Date(t).toLocaleDateString('he-IL');
}
function _prRefreshClocks() {
    document.querySelectorAll('#prFeed .pa-time').forEach(el => {
        const ts = el.getAttribute('data-ts');
        if (ts) el.textContent = _paTimeAgo(ts);
    });
}

function _paEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
