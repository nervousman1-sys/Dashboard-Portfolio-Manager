// ============================================================================
// Finextium — "פיד הודעות מהותיות בזמן אמת" (Live Material Press-Release Stream)
// ----------------------------------------------------------------------------
// A routed page (same pattern as the LHE / Decision-Core pages) that shows a LIVE,
// auto-refreshing feed of MATERIAL company press-releases (buyback, CEO change,
// guidance change, lawsuit, M&A…) for the tickers the signed-in user actually holds.
//
// Data flow:
//   24/7 press-agent (Node, VPS)  ──route_portfolio_alert()──►  public.portfolio_alerts
//        portfolio_alerts is Realtime-enabled  ──INSERT──►  this component (no refresh!)
//
// RLS makes the Realtime stream return ONLY the user's own portfolios' alerts.
// A client-side DEMO simulator injects a mock alert every 20s so the live entry
// animation can be tested before the backend agent is wired in production.
//
// NOTE: Finextium's frontend is vanilla JS (not React). The original spec was written
// in React/TS terms; this is the faithful vanilla-JS implementation that drops into the
// existing app. TypeScript shapes are documented as JSDoc @typedef below.
// ============================================================================

/**
 * @typedef {('buyback'|'ceo_change'|'guidance_up'|'guidance_down'|'lawsuit'|'ma'|'dividend'|'offering'|'other')} PaCategory
 *
 * @typedef {Object} PortfolioAlert
 * @property {number|string} id            Unique row id (DB id, or a synthetic id for demo rows).
 * @property {number|null}   portfolio_id  The portfolio this alert was routed to.
 * @property {string}        ticker        Stock symbol, e.g. "AAPL".
 * @property {string}        company       Company name, e.g. "Apple Inc.".
 * @property {PaCategory}    category      Material-event category.
 * @property {number}        sentiment     -100 (very bearish) .. +100 (very bullish).
 * @property {boolean}       materiality   Always true once it reaches the feed (filtered upstream).
 * @property {string}        summary_he    TL;DR — one Hebrew line.
 * @property {string}        headline_en   Original English headline.
 * @property {string}        body_en       Original English press-release body.
 * @property {string}        analysis_he   The agent's fundamental analysis (Hebrew).
 * @property {string}        source        e.g. "PR Newswire".
 * @property {string}        [source_url]  Link to the original release.
 * @property {string}        created_at    ISO timestamp the alert was routed.
 * @property {string}        [published_at] ISO timestamp the release was published.
 * @property {boolean}       [_demo]       True for client-side simulator rows.
 */

// ── Category → Hebrew label + colour class + sentiment hint ──────────────────
const PA_CATEGORIES = {
    buyback:       { he: 'רכישה עצמית',     cls: 'pa-cat-green',  bias: 'pos' },
    ceo_change:    { he: 'החלפת מנכ״ל',      cls: 'pa-cat-red',    bias: 'neg' },
    guidance_up:   { he: 'העלאת תחזית',      cls: 'pa-cat-green',  bias: 'pos' },
    guidance_down: { he: 'הורדת תחזית',      cls: 'pa-cat-red',    bias: 'neg' },
    lawsuit:       { he: 'תביעה משפטית',     cls: 'pa-cat-red',    bias: 'neg' },
    ma:            { he: 'מיזוג / רכישה',    cls: 'pa-cat-purple', bias: 'pos' },
    dividend:      { he: 'דיבידנד',          cls: 'pa-cat-green',  bias: 'pos' },
    offering:      { he: 'הנפקת מניות',      cls: 'pa-cat-orange', bias: 'neg' },
    other:         { he: 'דיווח מהותי',      cls: 'pa-cat-slate',  bias: 'neutral' },
};
function _paCatMeta(cat) { return PA_CATEGORIES[cat] || PA_CATEGORIES.other; }

// ── Comprehensive MOCK data (used by the demo simulator + as an empty-state seed) ──
/** @type {PortfolioAlert[]} */
const PA_MOCK_ALERTS = [
    {
        ticker: 'AAPL', company: 'Apple Inc.', category: 'buyback', sentiment: 74,
        summary_he: 'אפל אישרה תוכנית רכישה עצמית של 110 מיליארד דולר — הגדולה אי-פעם בתעשייה.',
        headline_en: 'Apple authorizes record $110 billion share buyback, raises dividend 4%',
        body_en: 'CUPERTINO, Calif. — Apple’s board of directors has authorized an additional $110 billion for share repurchases and raised its quarterly dividend by 4% to $0.25 per share, the largest buyback authorization in U.S. corporate history. The move underscores management’s confidence in sustained free-cash-flow generation.',
        analysis_he: 'רכישה עצמית בהיקף שיא מאותתת על עודף מזומנים חריג ואמון הנהלה גבוה בתזרים העתידי. הצמצום בכמות המניות מגדיל את הרווח-למניה (EPS) ותומך במחיר. שילוב עם העלאת דיבידנד מחזק את התזה של חברה בוגרת עם החזר-הון אגרסיבי לבעלי המניות.',
        source: 'PR Newswire',
    },
    {
        ticker: 'MSFT', company: 'Microsoft Corp.', category: 'buyback', sentiment: 68,
        summary_he: 'מיקרוסופט הכריזה על תוכנית רכישה עצמית ענקית של 60 מיליארד דולר והעלתה דיבידנד ב-10%.',
        headline_en: 'Microsoft announces new $60 billion share repurchase program and 10% dividend increase',
        body_en: 'REDMOND, Wash. — Microsoft Corp. announced that its board approved a new share repurchase program authorizing up to $60 billion in buybacks, with no expiration date, alongside a 10% increase to the quarterly dividend. The capital-return plan reflects strong Azure and AI-driven cash flows.',
        analysis_he: 'התוכנית משקפת תזרים חזק מ-Azure ומפעילות ה-AI. רכישה עצמית ללא מועד פקיעה נותנת להנהלה גמישות לתזמן קניות בירידות. ההעלאה בדיבידנד מאותתת על ביטחון ברווחיות ארוכת-טווח — חיובי לבעלי המניות.',
        source: 'Business Wire',
    },
    {
        ticker: 'NVDA', company: 'NVIDIA Corp.', category: 'guidance_up', sentiment: 81,
        summary_he: 'אנבידיה העלתה דרמטית את תחזית ההכנסות לרבעון על רקע ביקושי-שיא ל-GPU של מרכזי נתונים.',
        headline_en: 'NVIDIA raises Q3 revenue guidance to $32.5B on unprecedented data-center demand',
        body_en: 'SANTA CLARA, Calif. — NVIDIA raised its third-quarter revenue outlook to approximately $32.5 billion, well above prior guidance, citing unprecedented demand for its data-center GPUs powering generative-AI workloads. Gross margins are expected to remain in the mid-70% range.',
        analysis_he: 'העלאת תחזית חדה היא מהאיתותים החיוביים ביותר — היא מקדימה את הקונצנזוס ומעידה על ביקוש שמקדים את ההיצע. שמירה על מרווח גולמי ~75% מצביעה על תמחור-כוח (pricing power) יוצא דופן. סיכון עיקרי: ריכוזיות לקוחות ומגבלות ייצוא.',
        source: 'NVIDIA Investor Relations',
    },
    {
        ticker: 'MSTR', company: 'MicroStrategy Inc.', category: 'offering', sentiment: -28,
        summary_he: 'מייקרוסטרטג׳י הודיעה על הנפקת אג״ח להמרה של 700 מיליון דולר למימון רכישת ביטקוין נוספת.',
        headline_en: 'MicroStrategy to offer $700 million convertible notes to acquire additional bitcoin',
        body_en: 'TYSONS CORNER, Va. — MicroStrategy announced a proposed private offering of $700 million of convertible senior notes due 2031. The company intends to use the net proceeds to acquire additional bitcoin and for general corporate purposes.',
        analysis_he: 'הנפקת אג״ח להמרה היא דו-כיוונית: היא ממנפת את החשיפה לביטקוין (מנוף כלפי מעלה אם ה-BTC עולה), אך מדללת בעלי מניות בהמרה ומגדילה את הסיכון הפיננסי. התלות במחיר הביטקוין הופכת את המניה לפרוקסי ממונף — תנודתיות גבוהה לשני הכיוונים.',
        source: 'GlobeNewswire',
    },
    {
        ticker: 'GOOGL', company: 'Alphabet Inc.', category: 'lawsuit', sentiment: -41,
        summary_he: 'בית משפט פדרלי קבע כי גוגל הפרה את חוקי ההגבלים העסקיים בשוק החיפוש — צפוי ערעור.',
        headline_en: 'Federal judge rules Alphabet’s Google violated antitrust law in search market',
        body_en: 'WASHINGTON — A federal judge ruled that Google illegally maintained a monopoly in online search through exclusionary agreements. Remedies will be determined in a separate phase; Alphabet said it intends to appeal the decision.',
        analysis_he: 'פסיקת הגבלים עסקיים מוסיפה אי-ודאות רגולטורית ארוכת-טווח — הסיכון אינו הקנס המיידי אלא תרופות מבניות אפשריות (פירוק הסכמי ברירת-מחדל). ההשפעה התזרימית תלויה בשלב הסעדים ובערעור; בטווח הקצר לחץ סנטימנט שלילי.',
        source: 'Reuters',
    },
    {
        ticker: 'TSLA', company: 'Tesla Inc.', category: 'ceo_change', sentiment: -35,
        summary_he: 'טסלה הודיעה על פרישת סמנכ״ל הכספים (CFO); השוק מגיב בחשש לאי-ודאות ניהולית.',
        headline_en: 'Tesla’s Chief Financial Officer to step down; company names interim successor',
        body_en: 'AUSTIN, Texas — Tesla announced that its Chief Financial Officer will step down effective at the end of the quarter, with a long-time finance executive named as interim CFO while the board conducts a search.',
        analysis_he: 'חילופי CFO בכיר מוסיפים אי-ודאות ניהולית, במיוחד בחברה עם הוצאות הון גבוהות ופרויקטים עתירי-מימון. מינוי ממלא-מקום מהבית מרכך, אך השוק יבחן את המשכיות המדיניות הפיננסית. השפעה שלילית בטווח הקצר עד שתתבהר ההנהגה.',
        source: 'CNBC',
    },
    {
        ticker: 'AMD', company: 'Advanced Micro Devices', category: 'ma', sentiment: 52,
        summary_he: 'AMD רוכשת חברת תוכנת-AI במיליארד דולר כדי לחזק את מערך התוכנה מול אנבידיה.',
        headline_en: 'AMD to acquire AI software startup for $1 billion to bolster software stack',
        body_en: 'SANTA CLARA, Calif. — Advanced Micro Devices agreed to acquire an artificial-intelligence software company for approximately $1 billion in cash and stock, aiming to strengthen its software ecosystem and accelerate enterprise AI adoption against rivals.',
        analysis_he: 'רכישה אסטרטגית שסוגרת פער מול אנבידיה בשכבת התוכנה (CUDA) — נקודת התורפה ההיסטורית של AMD. אינטגרציה מוצלחת יכולה להגדיל את שיעור ה-attach של מעבדי ה-AI. הסיכון: סיכוני אינטגרציה ודילול קל. נטו — חיובי-מתון.',
        source: 'Bloomberg',
    },
    {
        ticker: 'META', company: 'Meta Platforms Inc.', category: 'dividend', sentiment: 44,
        summary_he: 'מטא הכריזה לראשונה על דיבידנד רבעוני והגדילה את תוכנית הרכישה העצמית ב-50 מיליארד דולר.',
        headline_en: 'Meta initiates first-ever dividend and adds $50 billion to buyback authorization',
        body_en: 'MENLO PARK, Calif. — Meta Platforms declared its first quarterly cash dividend of $0.50 per share and announced a $50 billion increase to its share-repurchase authorization, signaling a shift toward disciplined capital returns.',
        analysis_he: 'יוזמת דיבידנד ראשונה היא ציון-דרך — היא מסמנת מעבר מחברת-צמיחה לחברה בוגרת עם משמעת-הון. בשילוב הגדלת הרכישה העצמית, ההנהלה מאותתת ביטחון בתזרים החופשי גם תוך השקעות כבדות ב-AI. חיובי לבעלי המניות.',
        source: 'PR Newswire',
    },
];

// ── Module state ─────────────────────────────────────────────────────────────
let _paAlerts = [];                 // current feed (newest first)
let _paChannel = null;              // supabase realtime channel
let _paSimTimer = null;             // demo injector interval
let _paClockTimer = null;           // relative-timestamp refresh interval
let _paSimOn = true;                // demo simulator default ON (so the live effect is visible)
let _paFilter = 'all';              // portfolio filter: 'all' | <portfolio id>
let _paSeen = new Set();            // de-dup guard across DB + realtime + simulator
const PA_MAX = 60;                  // cap the feed length in the DOM

// ── Open / close as a routed page (mirrors openLHEPage) ──────────────────────
function openPressAlertsPage() {
    const page = document.getElementById('pressAlertsPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'pressAlertsPage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('pressalerts');
    if (typeof updateURLState === 'function') updateURLState({ view: 'pressalerts' });

    _paRenderShell();
    window.scrollTo(0, 0);
    _paAlerts = [];
    _paSeen = new Set();
    _paLoad();                       // initial fetch from Supabase (RLS → own alerts)
    _paSubscribeRealtime();          // live INSERTs
    if (_paSimOn) _paStartSimulator();
    if (_paClockTimer) clearInterval(_paClockTimer);
    _paClockTimer = setInterval(_paRefreshClocks, 15000);   // keep "הרגע / לפני X דק׳" fresh
}

function closePressAlertsPage() {
    const page = document.getElementById('pressAlertsPage');
    _paStopSimulator();
    if (_paClockTimer) { clearInterval(_paClockTimer); _paClockTimer = null; }
    if (_paChannel) { try { supabaseClient.removeChannel(_paChannel); } catch (e) { } _paChannel = null; }
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
if (typeof window !== 'undefined') {
    window.openPressAlertsPage = openPressAlertsPage;
    window.closePressAlertsPage = closePressAlertsPage;
}

// ── Page shell ───────────────────────────────────────────────────────────────
function _paRenderShell() {
    const page = document.getElementById('pressAlertsPage');
    if (!page) return;
    // Portfolio filter options from the loaded clients (each client = one portfolio).
    const opts = ['<option value="all">כל התיקים שלי</option>'];
    if (typeof clients !== 'undefined' && Array.isArray(clients)) {
        clients.forEach(c => opts.push(`<option value="${_paEsc(String(c.id))}">${_paEsc(c.name || ('תיק ' + c.id))}</option>`));
    }
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">פיד הודעות מהותיות בזמן אמת (24/7)</h1>
            <button class="macro-back-btn" onclick="closePressAlertsPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="pa-toolbar">
                <div class="pa-live">
                    <span class="pa-live-dot"><span class="pa-live-ping"></span></span>
                    <span class="pa-live-label">LIVE</span>
                    <span class="pa-live-sub">סורק דיווחי חברות ו-Press Releases — ומסנן רק את המהותיים</span>
                </div>
                <div class="pa-controls">
                    <select class="pa-select" id="paFilter" onchange="_paOnFilter(this.value)" title="סנן לפי תיק">${opts.join('')}</select>
                    <button class="pa-sim-toggle ${_paSimOn ? 'on' : ''}" id="paSimToggle" onclick="_paToggleSim()" title="הזרקת הודעת דמו כל 20 שניות לבדיקת הלייב">
                        <span class="pa-sim-pulse"></span><span class="pa-sim-text">${_paSimOn ? 'דמו פעיל' : 'דמו כבוי'}</span>
                    </button>
                </div>
            </div>
            <div class="pa-feed" id="paFeed">
                <div class="pa-empty" id="paEmpty">ממתין להודעות מהותיות עבור הנכסים שבתיקך… הפיד יתעדכן אוטומטית ברגע שתתקבל הודעה.</div>
            </div>
        </div>
    </div>
    <div class="pa-modal-overlay" id="paModalOverlay" onclick="if(event.target===this)_paCloseModal()">
        <div class="pa-modal" id="paModal" role="dialog" aria-modal="true"></div>
    </div>`;
}

// ── Initial load from Supabase (RLS returns only the signed-in user's alerts) ──
async function _paLoad() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        let q = supabaseClient.from('portfolio_alerts')
            .select('*').eq('status', 'active')
            .order('created_at', { ascending: false }).limit(PA_MAX);
        if (_paFilter !== 'all') q = q.eq('portfolio_id', Number(_paFilter));
        const { data, error } = await q;
        if (error) { console.warn('[PressAlerts] load:', error.message); return; }
        (data || []).reverse().forEach(a => _paPrepend(a, false));   // oldest→newest so newest ends on top
    } catch (e) { console.warn('[PressAlerts] load failed:', e.message); }
}

// ── Realtime: subscribe to INSERTs (RLS-filtered to the user's own alerts) ────
function _paSubscribeRealtime() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    if (_paChannel) { try { supabaseClient.removeChannel(_paChannel); } catch (e) { } _paChannel = null; }
    const cfg = { event: 'INSERT', schema: 'public', table: 'portfolio_alerts' };
    if (_paFilter !== 'all') cfg.filter = `portfolio_id=eq.${Number(_paFilter)}`;
    try {
        _paChannel = supabaseClient
            .channel('portfolio-alerts-live-' + Date.now())
            .on('postgres_changes', cfg, (payload) => {
                if (payload && payload.new) _paPrepend(payload.new, true);   // LIVE → animate in
            })
            .subscribe((status) => {
                const dot = document.querySelector('.pa-live-dot');
                if (dot) dot.classList.toggle('pa-live-off', status !== 'SUBSCRIBED');
            });
    } catch (e) { console.warn('[PressAlerts] realtime subscribe failed:', e.message); }
}

// ── Demo simulator: inject a mock material alert every 20s (client-side only) ──
function _paStartSimulator() {
    _paStopSimulator();
    _paSimTimer = setInterval(() => {
        const m = PA_MOCK_ALERTS[Math.floor(Math.random() * PA_MOCK_ALERTS.length)];
        const alert = Object.assign({}, m, {
            id: 'demo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            portfolio_id: null,
            materiality: true,
            created_at: new Date().toISOString(),
            published_at: new Date().toISOString(),
            _demo: true,
        });
        _paPrepend(alert, true);
    }, 20000);
}
function _paStopSimulator() { if (_paSimTimer) { clearInterval(_paSimTimer); _paSimTimer = null; } }

function _paToggleSim() {
    _paSimOn = !_paSimOn;
    if (_paSimOn) _paStartSimulator(); else _paStopSimulator();
    const btn = document.getElementById('paSimToggle');
    if (btn) { btn.classList.toggle('on', _paSimOn); const t = btn.querySelector('.pa-sim-text'); if (t) t.textContent = _paSimOn ? 'דמו פעיל' : 'דמו כבוי'; }
}
if (typeof window !== 'undefined') window._paToggleSim = _paToggleSim;

// ── Portfolio filter change → reload + re-subscribe with the new filter ───────
function _paOnFilter(val) {
    _paFilter = val || 'all';
    _paAlerts = []; _paSeen = new Set();
    const feed = document.getElementById('paFeed');
    if (feed) feed.innerHTML = '<div class="pa-empty" id="paEmpty">טוען הודעות…</div>';
    _paLoad();
    _paSubscribeRealtime();
}
if (typeof window !== 'undefined') window._paOnFilter = _paOnFilter;

// ── Prepend an alert to the feed (with the live entry animation when isLive) ──
function _paPrepend(alert, isLive) {
    if (!alert) return;
    const key = String(alert.id != null ? alert.id : (alert.ticker + '|' + alert.headline_en));
    if (_paSeen.has(key)) return;
    _paSeen.add(key);
    _paAlerts.unshift(alert);
    if (_paAlerts.length > PA_MAX) _paAlerts.length = PA_MAX;

    const feed = document.getElementById('paFeed');
    if (!feed) return;
    const empty = document.getElementById('paEmpty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.innerHTML = _paCardHTML(alert);
    const card = wrap.firstElementChild;
    if (!card) return;
    if (isLive) card.classList.add('pa-enter');
    feed.insertBefore(card, feed.firstChild);
    if (isLive) {
        // force reflow so the transition runs, then settle
        // eslint-disable-next-line no-unused-expressions
        card.offsetHeight;
        requestAnimationFrame(() => card.classList.remove('pa-enter'));
    }
    // trim overflow from the DOM
    while (feed.children.length > PA_MAX) feed.removeChild(feed.lastChild);
}

// ── One alert card ───────────────────────────────────────────────────────────
function _paCardHTML(a) {
    const cat = _paCatMeta(a.category);
    const sent = +a.sentiment || 0;
    const sArrow = sent > 4 ? '▲' : sent < -4 ? '▼' : '◆';
    const sCls = sent > 4 ? 'pa-pos' : sent < -4 ? 'pa-neg' : 'pa-neu';
    const ts = a.created_at || a.published_at;
    const id = _paEsc(String(a.id));
    return `
    <div class="pa-card ${sCls}" id="pa-card-${id}" data-ts="${_paEsc(String(ts || ''))}">
        <div class="pa-card-l">
            <div class="pa-card-top">
                <span class="pa-ticker">$${_paEsc(a.ticker || '')}</span>
                <span class="pa-badge ${cat.cls}">${_paEsc(cat.he)}</span>
                ${a._demo ? '<span class="pa-demo">דמו</span>' : ''}
                <span class="pa-sent ${sCls}" title="מדד סנטימנט של ה-AI">${sArrow} ${sent > 0 ? '+' : ''}${sent}</span>
            </div>
            <div class="pa-summary">${_paEsc(a.summary_he || a.headline_en || '')}</div>
            <div class="pa-meta">
                <span class="pa-company">${_paEsc(a.company || '')}</span>
                <span class="pa-dot">·</span>
                <span class="pa-time" data-ts="${_paEsc(String(ts || ''))}">${_paTimeAgo(ts)}</span>
                ${a.source ? `<span class="pa-dot">·</span><span class="pa-source">${_paEsc(a.source)}</span>` : ''}
            </div>
        </div>
        <div class="pa-card-r">
            <button class="pa-read-btn" onclick="_paOpenModal('${id}')">קרא את הדיווח המלא</button>
        </div>
    </div>`;
}

// ── "Read full report" modal: original EN release + the agent's HE analysis ───
function _paOpenModal(id) {
    const a = _paAlerts.find(x => String(x.id) === String(id));
    if (!a) return;
    const cat = _paCatMeta(a.category);
    const sent = +a.sentiment || 0;
    const sCls = sent > 4 ? 'pa-pos' : sent < -4 ? 'pa-neg' : 'pa-neu';
    const modal = document.getElementById('paModal');
    const overlay = document.getElementById('paModalOverlay');
    if (!modal || !overlay) return;
    modal.innerHTML = `
        <div class="pa-modal-head">
            <div class="pa-modal-title">
                <span class="pa-ticker">$${_paEsc(a.ticker || '')}</span>
                <span class="pa-badge ${cat.cls}">${_paEsc(cat.he)}</span>
                <span class="pa-sent ${sCls}">${sent > 0 ? '+' : ''}${sent}</span>
            </div>
            <button class="pa-modal-x" onclick="_paCloseModal()" aria-label="סגור">×</button>
        </div>
        <div class="pa-modal-company">${_paEsc(a.company || '')} · ${_paTimeAgo(a.created_at || a.published_at)} · ${_paEsc(a.source || '')}</div>
        <div class="pa-modal-section">
            <div class="pa-modal-h">ניתוח פונדמנטלי של הסוכן</div>
            <p class="pa-modal-analysis" dir="rtl">${_paEsc(a.analysis_he || a.summary_he || '')}</p>
        </div>
        <div class="pa-modal-section">
            <div class="pa-modal-h">הדיווח המקורי (אנגלית)</div>
            <div class="pa-modal-en" dir="ltr">
                <div class="pa-modal-en-head">${_paEsc(a.headline_en || '')}</div>
                <p class="pa-modal-en-body">${_paEsc(a.body_en || '')}</p>
                ${a.source_url ? `<a class="pa-modal-link" href="${_paEsc(a.source_url)}" target="_blank" rel="noopener">פתח את המקור ↗</a>` : ''}
            </div>
        </div>`;
    overlay.classList.add('open');
}
function _paCloseModal() { const o = document.getElementById('paModalOverlay'); if (o) o.classList.remove('open'); }
if (typeof window !== 'undefined') { window._paOpenModal = _paOpenModal; window._paCloseModal = _paCloseModal; }

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
function _paRefreshClocks() {
    document.querySelectorAll('#paFeed .pa-time').forEach(el => {
        const ts = el.getAttribute('data-ts');
        if (ts) el.textContent = _paTimeAgo(ts);
    });
}

function _paEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
