// ============================================================================
// Finextium — "סימולטור תרחישי קיצון" (Stress-Testing & Scenario Simulator)
// ----------------------------------------------------------------------------
// A what-if engine: pick (or define) a macro/geopolitical/sector shock and see, on the user's REAL
// portfolio, the projected P&L hit, a fragility score, the weakest holdings, and AI hedge advice.
//
// REAL data, not mock:
//   • Portfolio  → the signed-in user's actual holdings (global `clients`, from Supabase).
//   • Live macro baseline → pulled from the platform's real feeds (/api/macro, /api/quote ^VIX) so the
//     scenario deltas are applied on top of the CURRENT state the 24/7 agents collect.
//   • Per-asset sensitivities → coefficients calibrated to how each asset CLASS has historically moved
//     under rate/inflation/USD/VIX/sector shocks (same factor logic the LHE macro model uses).
//
// NOTE: Finextium's frontend is vanilla JS (not React). The spec was written in React/TS/Tailwind terms;
// this is the faithful vanilla-JS implementation that drops into the existing routed-page system.
// React→Vanilla map: useState→module vars; useEffect→open/close + _stLoadBaseline; Recharts→SVG gauge +
// CSS bars; shadcn cards→.st-card. calculateScenarioImpact() is the pure logic function requested.
// ============================================================================

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} title          Hebrew title
 * @property {string} desc           Hebrew one-line description
 * @property {string} icon
 * @property {{rate:number, infl:number, usd:number, vix:number, tech:number, ils:number}} deltas
 *           rate=Fed Δ %pts · infl=CPI Δ %pts · usd=USD strength Δ% (neg=weaker) · vix=VIX Δpts ·
 *           tech=tech-sector shock % (neg) · ils=ILS weakening %
 * @property {string} risk_he        AI "why you're exposed" narrative (parameterized at runtime)
 * @property {{asset:string, reason_he:string}} hedge   suggested hedge instrument + rationale
 */

// ── Per-asset-CLASS sensitivity: the % move in the asset per ONE unit of each macro factor.
// Calibrated to documented historical behaviour (rate-hike valuation compression, bond duration,
// gold as an inflation/▲VIX hedge, banks gaining on higher rates, etc.).
const ST_SENS = {
    //          rate    infl    usd    vix     tech    ils
    semis:    { rate: -9.0, infl: -1.2, usd: 0.45, vix: -0.85, tech: 1.45, ils: 0 },   // most fragile (NVDA/AMD/SOXX)
    tech:     { rate: -7.0, infl: -1.0, usd: 0.30, vix: -0.65, tech: 1.10, ils: 0 },
    equity:   { rate: -4.0, infl: -0.8, usd: 0.20, vix: -0.45, tech: 0.50, ils: 0 },
    consumer: { rate: -3.0, infl: -1.3, usd: 0.15, vix: -0.40, tech: 0.25, ils: 0 },
    energy:   { rate: -1.5, infl: 1.0, usd: -0.30, vix: -0.25, tech: 0.10, ils: 0 },
    bond_long:{ rate: -13.0, infl: -2.6, usd: 0.0, vix: 0.18, tech: 0, ils: 0 },        // TLT duration ≈ 17
    bond_short:{ rate: -2.0, infl: -0.6, usd: 0.0, vix: 0.06, tech: 0, ils: 0 },
    gold:     { rate: -1.6, infl: 2.3, usd: -1.30, vix: 0.55, tech: 0, ils: 0 },        // HEDGE: ▲ on inflation/VIX/weak-$
    cash:     { rate: 0.1, infl: -0.3, usd: 0.0, vix: 0.0, tech: 0, ils: 0.4 },
    il_bank:  { rate: 1.6, infl: -0.9, usd: 0.25, vix: -0.40, tech: 0.15, ils: 0.9 },   // banks BENEFIT from higher rates
    il_stock: { rate: -3.0, infl: -1.1, usd: 0.20, vix: -0.40, tech: 0.30, ils: 0.6 },
    il_index: { rate: -3.2, infl: -1.0, usd: 0.18, vix: -0.42, tech: 0.35, ils: 0.7 },
};
const ST_CLASS_HE = {
    semis: 'מוליכים למחצה', tech: 'טכנולוגיה', equity: 'מניות רחב', consumer: 'צריכה', energy: 'אנרגיה',
    bond_long: 'אג״ח ארוך', bond_short: 'אג״ח קצר', gold: 'זהב', cash: 'מזומן/שקלי',
    il_bank: 'בנקים בישראל', il_stock: 'מניה ישראלית', il_index: 'מדד ישראלי',
};

// Classify a holding into a sensitivity class (real ticker → asset class).
function _stClassify(h) {
    const t = String(h.ticker || '').toUpperCase().replace(/\.TA$/, '');
    const name = String(h.name || '');
    if (['NVDA', 'AMD', 'SMH', 'SOXX', 'AVGO', 'MU', 'TSM', 'ASML', 'QCOM', 'INTC', 'ARM', 'MRVL'].includes(t)) return 'semis';
    if (['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'QQQ', 'QQQM', 'XLK', 'VGT', 'AMZN', 'TSLA', 'NFLX', 'CRM', 'ADBE', 'PLTR', 'ORCL', 'NOW', 'SNOW', 'AMAT'].includes(t)) return 'tech';
    if (['TLT', 'VGLT', 'EDV', 'ZROZ'].includes(t)) return 'bond_long';
    if (['IEF', 'AGG', 'BND', 'SHY', 'BIL', 'SGOV', 'GOVT', 'SHV', 'VCSH', 'TIP'].includes(t)) return 'bond_short';
    if (['GLD', 'IAU', 'GLDM', 'SGOL', 'GC=F', 'PHYS'].includes(t)) return 'gold';
    if (['XLE', 'VDE', 'XOM', 'CVX', 'COP', 'OXY', 'SLB'].includes(t)) return 'energy';
    if (['XLP', 'VDC', 'KO', 'PG', 'PEP', 'COST', 'WMT', 'MCD'].includes(t)) return 'consumer';
    if (['SPY', 'VOO', 'IVV', 'DIA', 'IWM', 'VTI', 'SPLG', 'RSP', 'EFA', 'EEM', 'VEA', 'VWO'].includes(t)) return 'equity';
    const isIL = h.currency === 'ILS' || /\.TA$/.test(String(h.ticker || '')) || /^\d{4,9}$/.test(t);
    if (isIL) {
        if (/POLI|LUMI|MZTF|DSCT|FIBI|בנק|הפועלים|לאומי|מזרחי|דיסקונט/i.test(t + ' ' + name)) return 'il_bank';
        if (/ת["״]?א|S&P|נאסד|MSCI|מדד|מחקה/i.test(name)) return 'il_index';
        return 'il_stock';
    }
    if (h.type === 'bond') return 'bond_short';
    if (h.assetClass === 'crypto' || ['BTC', 'ETH', 'IBIT', 'FBTC'].includes(t)) return 'tech'; // crypto ≈ high-beta risk
    return 'equity';
}

// ── Pre-built scenarios (deltas + AI narrative + hedge). Deltas drive calculateScenarioImpact(). ──
/** @type {Scenario[]} */
const ST_SCENARIOS = [
    {
        id: 'fed_hike', title: 'העלאת ריבית פד 0.5% + היחלשות הדולר 3%', icon: '🏦',
        desc: 'הידוק מוניטרי מפתיע — לחץ על מכפילי היוון ועל נכסי משך ארוך.',
        deltas: { rate: 0.5, infl: 0, usd: -3, vix: 4, tech: 0, ils: 0 },
        risk_he: 'העלאת ריבית מעלה את שיעור ההיוון ומכווצת את שווי ההווה של רווחים עתידיים — הפגיעה מתרכזת בנכסי משך ארוך (אג״ח ארוך) ובמניות צמיחה/טכנולוגיה בעלות מכפילים גבוהים. היחלשות הדולר ממתנת מעט נכסים גלובליים אך אינה מגנה על הרגישות לריבית.',
        hedge: { asset: 'אג״ח קצר־מח״מ / מזומן (SGOV, SHV)', reason_he: 'מח״מ קצר כמעט חסין לעליית ריבית ומספק עוגן יציב; זהב נהנה מהיחלשות הדולר.' },
    },
    {
        id: 'supply_infl', title: 'משבר בשרשרת האספקה (אינפלציה מזנקת)', icon: '🚢',
        desc: 'זינוק אינפלציה + תנודתיות — שחיקת מרווחים ולחץ על מניות צמיחה.',
        deltas: { rate: 0.25, infl: 2.0, usd: 1, vix: 8, tech: -4, ils: 0 },
        risk_he: 'אינפלציה מזנקת שוחקת מרווחי רווח, מאלצת ריסון מוניטרי, ומורידה את שווי מניות הצמיחה. בתרחיש כזה זהב וסחורות נוטים לעלות ולספק הגנה, בעוד אג״ח ארוך ומניות טק נפגעים.',
        hedge: { asset: 'זהב / סחורות (GLD)', reason_he: 'לזהב קורלציה חיובית היסטורית לאינפלציה ולעליות VIX — מגן טבעי לתרחיש זה.' },
    },
    {
        id: 'tech_correction', title: 'תיקון בשוק הטכנולוגיה / פספוס דוחות NVDA', icon: '💻',
        desc: 'שוק הסמיקונדקטורס והטק מתקן בחדות — בטא גבוהה נפגעת ראשונה.',
        deltas: { rate: 0, infl: 0, usd: 1, vix: 12, tech: -15, ils: 0 },
        risk_he: 'תיקון ממוקד בטכנולוגיה ובמוליכים למחצה פוגע באופן לא־פרופורציונלי בנכסי בטא גבוהה. ככל שהחשיפה לטק/סמיקונדקטורס גבוהה יותר — הפגיעה חדה יותר. נכסים דפנסיביים, אג״ח וזהב סופגים פחות.',
        hedge: { asset: 'אג״ח ממשלתי / זהב (TLT, GLD)', reason_he: 'בתיקוני סיכון הון זורם לנכסי מקלט; אג״ח וזהב מציגים קורלציה הפוכה לטק.' },
    },
    {
        id: 'il_cpi_shekel', title: 'זינוק CPI בישראל + היחלשות השקל', icon: '🇮🇱',
        desc: 'אינפלציה מקומית + פיחות — לחץ על מניות מקומיות, יתרון ליצואניות/מט״ח.',
        deltas: { rate: 0.25, infl: 1.0, usd: 2, vix: 5, tech: 0, ils: 4 },
        risk_he: 'אינפלציה מקומית ופיחות השקל פוגעים בכוח הקנייה ובמניות הצרכניות המקומיות, אך מיטיבים עם יצואניות ועם חשיפה דולרית. בנקים מקומיים עשויים ליהנות מסביבת ריבית גבוהה. חשיפה גבוהה למניות ישראליות שקליות מגדילה את הרגישות.',
        hedge: { asset: 'חשיפה דולרית / מדדי חו״ל (S&P 500)', reason_he: 'פיחות השקל מגדיל את הערך השקלי של נכסים דולריים — קיזוז ישיר לסיכון המקומי.' },
    },
    {
        id: 'market_crash_2008', title: 'קריסת שוק כללית (סגנון 2008/2020)', icon: '📉',
        desc: 'קריסה דפלציונית חדה — בריחה לנכסי מקלט, אג״ח וזהב מזנקים.',
        deltas: { rate: -1.0, infl: -1.0, usd: 5, vix: 35, tech: -32, ils: 6 },
        risk_he: 'קריסת שוק רחבה (כמו 2008 או מרץ 2020) — זינוק חד ב-VIX ובריחה מנכסי סיכון. מניות, ובמיוחד טכנולוגיה ובטא גבוהה, נופלות בחדות; הון בורח לנכסי מקלט — אג״ח ממשלתי ארוך, זהב והדולר מזנקים. ככל שהתיק מרוכז יותר במניות צמיחה — הפגיעה עמוקה יותר.',
        hedge: { asset: 'אג״ח ממשלתי ארוך + זהב (TLT, GLD)', reason_he: 'בקריסות דפלציוניות אג״ח ארוך וזהב מציגים קורלציה הפוכה חזקה למניות ומשמשים מקלט קלאסי.' },
    },
    {
        id: 'inflation_crash_2022', title: 'קריסה אינפלציונית (סגנון 2022)', icon: '🔥',
        desc: 'אינפלציה + הידוק אגרסיבי — גם מניות וגם אג״ח נופלים יחד.',
        deltas: { rate: 2.0, infl: 3.0, usd: 4, vix: 20, tech: -24, ils: 3 },
        risk_he: 'קריסה אינפלציונית (כמו 2022) שונה מהותית: אינפלציה גבוהה מאלצת הידוק מוניטרי אגרסיבי, וגם מניות וגם אג״ח ארוך נופלים בו-זמנית — "אין לאן לברוח". התיק הקלאסי 60/40 נכשל בתרחיש זה. רק אג״ח קצר־מח״מ, זהב, אנרגיה וסחורות שרדו היסטורית.',
        hedge: { asset: 'אג״ח קצר / זהב / אנרגיה (SGOV, GLD, XLE)', reason_he: 'בניגוד לקריסה דפלציונית — כאן אג״ח ארוך הוא מלכודת; ההגנה היא מח״מ קצר, זהב וסחורות שעולות עם האינפלציה.' },
    },
];

// ── THE CORE LOGIC: project the scenario onto the portfolio. Pure function, no side effects. ──
// Returns per-holding drops, the portfolio P&L, the fragility score (1-100) and the dominant risk factor.
function calculateScenarioImpact(holdings, deltas) {
    const d = Object.assign({ rate: 0, infl: 0, usd: 0, vix: 0, tech: 0, ils: 0 }, deltas || {});
    let totalValue = 0;
    for (const h of holdings) totalValue += Math.max(0, +h.value || 0);
    if (totalValue <= 0) return { totalValue: 0, newValue: 0, pnl: 0, weightedDrop: 0, fragility: 1, rows: [], dominant: null };

    // Track each factor's contribution to the portfolio drop, to name the dominant risk.
    const factorContribution = { rate: 0, infl: 0, usd: 0, vix: 0, tech: 0, ils: 0 };
    const rows = [];
    let weightedSum = 0;
    const classWeight = {};

    for (const h of holdings) {
        const value = Math.max(0, +h.value || 0);
        if (value <= 0) continue;
        const weight = value / totalValue;
        const cls = _stClassify(h);
        const s = ST_SENS[cls] || ST_SENS.equity;
        const beta = (h.beta != null && isFinite(h.beta) && h.beta > 0) ? h.beta : null;

        // Per-factor % move, summed.
        const parts = {
            rate: s.rate * d.rate, infl: s.infl * d.infl, usd: s.usd * d.usd,
            vix: s.vix * d.vix, tech: s.tech * d.tech, ils: s.ils * d.ils,
        };
        let drop = parts.rate + parts.infl + parts.usd + parts.vix + parts.tech + parts.ils;
        // Real-beta tilt for equity-like classes (a high-beta name amplifies the equity-driven part).
        if (beta && /semis|tech|equity|consumer|il_stock|il_index/.test(cls)) drop *= (0.65 + 0.35 * beta);
        drop = Math.max(-65, Math.min(25, drop));   // clamp to a sane band

        const valueChange = value * drop / 100;
        weightedSum += weight * drop;
        for (const k in parts) factorContribution[k] += weight * (beta && /semis|tech|equity|consumer|il_stock|il_index/.test(cls) ? parts[k] * (0.65 + 0.35 * beta) : parts[k]);
        classWeight[cls] = (classWeight[cls] || 0) + weight;

        rows.push({
            ticker: h.ticker, name: h.name || '', cls, classHe: ST_CLASS_HE[cls] || cls,
            weightPct: weight * 100, beta: beta, dropPct: drop, valueChange, value,
        });
    }

    rows.sort((a, b) => a.dropPct - b.dropPct);   // most-hit first (the weakest links)
    const weightedDrop = weightedSum;             // portfolio % change (negative = loss)
    const newValue = totalValue * (1 + weightedDrop / 100);
    const pnl = newValue - totalValue;

    // Concentration penalty (Herfindahl on class weights) — a concentrated portfolio is more fragile.
    let hhi = 0; for (const k in classWeight) hhi += classWeight[k] * classWeight[k];
    const concPenalty = Math.max(0, (hhi - 0.25)) * 40;   // 0 when diversified, up to ~30 when concentrated

    // Fragility 1-100: driven by the loss magnitude + concentration.
    const fragility = Math.max(1, Math.min(100, Math.round(-Math.min(0, weightedDrop) * 4.2 + concPenalty)));

    // Dominant negative factor (most responsible for the loss) → drives the hedge wording.
    let dominant = null, worst = 0;
    for (const k in factorContribution) { if (factorContribution[k] < worst) { worst = factorContribution[k]; dominant = k; } }

    return { totalValue, newValue, pnl, weightedDrop, fragility, rows, dominant, classWeight };
}

// Estimate how much allocating `pct`% to a hedge instrument reduces the portfolio drop (the hedge's own
// drop in this scenario vs. the average holding), and find the allocation that reaches a target fragility.
function _stHedgePlan(holdings, deltas, baseResult) {
    // Pick the hedge class by the dominant risk factor.
    const map = { rate: 'bond_short', infl: 'gold', usd: 'gold', vix: 'gold', tech: 'bond_long', ils: 'cash' };
    const hedgeCls = map[baseResult.dominant] || 'gold';
    const s = ST_SENS[hedgeCls];
    const d = Object.assign({ rate: 0, infl: 0, usd: 0, vix: 0, tech: 0, ils: 0 }, deltas);
    let hedgeDrop = s.rate * d.rate + s.infl * d.infl + s.usd * d.usd + s.vix * d.vix + s.tech * d.tech + s.ils * d.ils;
    hedgeDrop = Math.max(-30, Math.min(25, hedgeDrop));
    const base = baseResult.weightedDrop;                 // negative
    // Try allocations 3%..30% (funded pro-rata from the rest) and pick the smallest that reaches ~45.
    const targetFrag = 45;
    let chosen = null;
    for (let pct = 3; pct <= 30; pct += 1) {
        const w = pct / 100;
        const newDrop = base * (1 - w) + hedgeDrop * w;
        const conc = 0; // adding a hedge also reduces concentration slightly; ignore for the estimate
        const frag = Math.max(1, Math.min(100, Math.round(-Math.min(0, newDrop) * 4.2 + Math.max(0, baseResult.fragility - (-Math.min(0, base) * 4.2)) * (1 - w))));
        if (frag <= targetFrag) { chosen = { pct, newDrop, frag }; break; }
    }
    if (!chosen) { const pct = 30, w = 0.3; const newDrop = base * (1 - w) + hedgeDrop * w; chosen = { pct, newDrop, frag: Math.max(1, Math.round(-Math.min(0, newDrop) * 4.2)) }; }
    const labelMap = {
        bond_short: 'אג״ח קצר־מח״מ (SGOV / SHV)', gold: 'זהב (GLD)', bond_long: 'אג״ח ממשלתי ארוך (TLT)',
        cash: 'חשיפה דולרית / מזומן', equity: 'מדד רחב (SPY)',
    };
    return { hedgeCls, hedgeLabel: labelMap[hedgeCls] || 'זהב (GLD)', pct: chosen.pct, fromFrag: baseResult.fragility, toFrag: chosen.frag, hedgeDrop };
}

// ── State ────────────────────────────────────────────────────────────────────
let _stPortfolioId = null;
let _stScenarioId = 'fed_hike';
let _stCustom = { rate: 0.5, infl: 1.0, usd: -2, vix: 6 };   // custom-slider state
let _stBaseline = null;                                       // live macro baseline (real)
let _stResult = null;
let _stProximity = null;   // crisis-detection indicator (migrated from the old Decision-Core page)

// ── Open / close as a routed page (mirrors the LHE / Decision-Core pages) ─────
function openStressTestPage() {
    const page = document.getElementById('stressTestPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'stressTestPage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('stresstest');
    if (typeof updateURLState === 'function') updateURLState({ view: 'stresstest' });

    // Default to the largest portfolio.
    if (_stPortfolioId == null && typeof clients !== 'undefined' && Array.isArray(clients) && clients.length) {
        _stPortfolioId = clients.slice().sort((a, b) => (b.portfolioValue || 0) - (a.portfolioValue || 0))[0].id;
    }
    _stResult = null;
    _stRenderShell();
    window.scrollTo(0, 0);
    _stLoadBaseline();
    // Crisis-detection indicator (24/7 agent data) — fill in async.
    _stComputeProximity().then(p => { _stProximity = p; const el = document.getElementById('stProxCard'); if (el) el.innerHTML = _stProximityHTML(); }).catch(() => { });
}

function closeStressTestPage() {
    const page = document.getElementById('stressTestPage');
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
if (typeof window !== 'undefined') { window.openStressTestPage = openStressTestPage; window.closeStressTestPage = closeStressTestPage; }

// Live macro baseline from the platform's REAL feeds (so deltas apply on top of the current state).
async function _stLoadBaseline() {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const [macro, vixQ] = await Promise.all([
            fetch(`/api/macro?d=${today}`, { headers: { Accept: 'application/json' } }).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch('/api/quote?symbols=%5EVIX', { headers: { Accept: 'application/json' } }).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        const us = macro && (macro.us || macro.US);
        const num = (x) => (x && typeof x === 'object') ? (x.value ?? x.actual ?? null) : x;
        const vix = vixQ && (vixQ['^VIX'] || vixQ.VIX) && ((vixQ['^VIX'] || vixQ.VIX).price ?? (vixQ['^VIX'] || vixQ.VIX).value);
        _stBaseline = {
            rate: us ? (num(us.fed_rate) ?? num(us.rate)) : null,
            cpi: us ? num(us.cpi) : null,
            vix: (vix != null && isFinite(vix)) ? +vix : null,
        };
    } catch (e) { _stBaseline = null; }
    const el = document.getElementById('stBaseline');
    if (el) el.innerHTML = _stBaselineHTML();
}
function _stBaselineHTML() {
    const b = _stBaseline;
    if (!b) return '<span class="st-bl-item">טוען מצב מאקרו נוכחי…</span>';
    const f = (v, suf) => (v != null && isFinite(v)) ? `${(+v).toFixed(suf === '%' ? 1 : 1)}${suf}` : '—';
    return `<span class="st-bl-lbl">מצב נוכחי (חי):</span>
        <span class="st-bl-item">ריבית פד <b>${f(b.rate, '%')}</b></span>
        <span class="st-bl-item">CPI ארה״ב <b>${f(b.cpi, '%')}</b></span>
        <span class="st-bl-item">VIX <b>${f(b.vix, '')}</b></span>`;
}

// ── Helpers for the portfolio under test ──────────────────────────────────────
function _stPortfolio() {
    if (typeof clients === 'undefined' || !Array.isArray(clients)) return null;
    return clients.find(c => c.id === _stPortfolioId) || clients[0] || null;
}
function _stHoldings() {
    const p = _stPortfolio();
    if (!p || !Array.isArray(p.holdings)) return [];
    // Only positions with a value; carry beta if the risk model attached one.
    return p.holdings.filter(h => (+h.value || 0) > 0).map(h => ({
        ticker: h.ticker, name: h.name, value: +h.value || 0, type: h.type, sector: h.sector,
        currency: h.currency, assetClass: h.assetClass, beta: (h.beta ?? (h.model && h.model.beta)) || null,
    }));
}
function _stActiveDeltas() {
    if (_stScenarioId === 'custom') return { rate: _stCustom.rate, infl: _stCustom.infl, usd: _stCustom.usd, vix: _stCustom.vix, tech: 0, ils: 0 };
    const s = ST_SCENARIOS.find(x => x.id === _stScenarioId);
    return s ? s.deltas : ST_SCENARIOS[0].deltas;
}

function _stEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// ── Crisis-detection indicator (migrated here from the old Decision-Core page) ────────────────
// PRIMARY: the 24/7 crisis-agent's latest reading from Supabase. FALLBACK: live client-side compute.
async function _stComputeProximity() {
    try {
        if (typeof supabaseClient !== 'undefined' && supabaseClient) {
            const { data, error } = await supabaseClient
                .from('crisis_indicator').select('score,label,parts,assessment_he,created_at')
                .eq('status', 'active').order('created_at', { ascending: false }).limit(1);
            if (!error && data && data.length && data[0].score != null && Array.isArray(data[0].parts) && data[0].parts.length) {
                const r = data[0];
                return { score: r.score, parts: r.parts, partial: false, assessment: r.assessment_he || '', asOf: r.created_at };
            }
        }
    } catch (e) { /* fall through to live computation */ }

    const parts = []; let missing = 0;
    const num = (x) => (x && typeof x === 'object') ? (x.value ?? x.actual ?? null) : x;
    let fg = null;
    try { const r = await fetch('/api/feargreed', { headers: { Accept: 'application/json' } }); if (r.ok) { const j = await r.json(); fg = (j && (j.score ?? j.value)); } } catch (e) { }
    if (fg != null && isFinite(fg)) parts.push({ key: 'הערכות יתר ושאננות', score: Math.round(fg), w: 0.25, note: `מדד פחד/חמדנות: ${Math.round(fg)}` });
    else { missing++; parts.push({ key: 'הערכות יתר ושאננות', score: 50, w: 0.25, note: 'נתון חלקי' }); }

    let macro = (typeof window !== 'undefined' && window._macroHeadUS) ? window._macroHeadUS : null;
    if (!macro || macro.cpi == null) {
        try { const r = await fetch(`/api/macro?d=${new Date().toISOString().slice(0, 10)}`, { headers: { Accept: 'application/json' } }); if (r.ok) { const j = await r.json(); macro = (j && (j.us || j.US)) || macro; } } catch (e) { }
    }
    const cpi = macro ? num(macro.cpi) : null;
    if (cpi != null && isFinite(cpi)) parts.push({ key: 'לחצי אינפלציה', score: Math.round(Math.max(0, Math.min(100, (cpi - 1.5) / 4 * 100))), w: 0.2, note: `CPI ${cpi}%` });
    else { missing++; parts.push({ key: 'לחצי אינפלציה', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    const rate = macro ? (num(macro.fed_rate) ?? num(macro.rate) ?? num(macro.fedRate) ?? num(macro.interestRate)) : null;
    if (rate != null && isFinite(rate)) parts.push({ key: 'מדיניות מוניטרית מהדקת', score: Math.round(Math.max(0, Math.min(100, rate / 6 * 100))), w: 0.2, note: `ריבית ${rate}%` });
    else { missing++; parts.push({ key: 'מדיניות מוניטרית מהדקת', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    let spread = null;
    try {
        const r = await fetch('/api/yields', { headers: { Accept: 'application/json' } });
        if (r.ok) { const j = await r.json(); const us = (j && (j.us || j.US)) || j; let y10 = null, y2 = null;
            if (Array.isArray(us)) { const find = (l) => { const e = us.find(x => x && x.label === l); return e ? Number(e.value) : null; }; y10 = find('10Y'); y2 = find('2Y'); }
            else { y10 = num(us && (us.y10 || us['10Y'] || us.tenYear)); y2 = num(us && (us.y2 || us['2Y'] || us.twoYear)); }
            if (y10 != null && y2 != null && isFinite(y10) && isFinite(y2)) spread = y10 - y2;
        }
    } catch (e) { }
    if (spread != null && isFinite(spread)) parts.push({ key: 'היפוך עקום התשואות', score: Math.round(Math.max(0, Math.min(100, (0.8 - spread) / 2 * 100))), w: 0.2, note: `מרווח 10ש'−2ש' ${spread.toFixed(2)}%` });
    else { missing++; parts.push({ key: 'היפוך עקום התשואות', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    let vix = null;
    try { const r = await fetch('/api/quote?symbols=%5EVIX', { headers: { Accept: 'application/json' } }); if (r.ok) { const j = await r.json(); const v = j && (j['^VIX'] || j.VIX); vix = v && (v.price ?? v.regularMarketPrice ?? v.value); } } catch (e) { }
    if (vix != null && isFinite(vix)) parts.push({ key: 'תנודתיות שוק (VIX)', score: Math.round(Math.max(0, Math.min(100, (vix - 12) / 33 * 100))), w: 0.15, note: `VIX ${Number(vix).toFixed(1)}` });
    else { missing++; parts.push({ key: 'תנודתיות שוק (VIX)', score: 40, w: 0.15, note: 'נתון חלקי' }); }

    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const score = Math.round(parts.reduce((s, p) => s + p.score * p.w, 0) / (wsum || 1));
    return { score, parts, partial: missing >= 3 };
}

function _stAgo(ts) {
    if (!ts) return '';
    const d = new Date(ts); if (isNaN(d)) return '';
    let s = Math.round((Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 90) return 'ממש עכשיו';
    const m = Math.round(s / 60); if (m < 60) return `לפני ${m} דק׳`;
    const h = Math.round(m / 60); if (h < 24) return `לפני ${h} שע׳`;
    return `לפני ${Math.round(h / 24)} ימים`;
}

// Renders the crisis indicator (reuses the existing dc-* styles in main.css).
function _stProximityHTML() {
    const p = _stProximity;
    if (!p) return `<div class="dc-card-title">אינדיקטור לזיהוי משברים</div><div class="dc-loading">מחשב מנתוני מאקרו חיים…</div>`;
    const score = p.score;
    const col = score >= 70 ? '#ef4444' : score >= 45 ? '#f59e0b' : '#10b981';
    const label = score >= 70 ? 'סיכון גבוה' : score >= 45 ? 'סיכון בינוני' : 'יציב';
    const liveTag = p.asOf ? `<span class="dc-live-tag"><span class="dc-live-dot"></span>סוכן 24/7 · עודכן ${_stAgo(p.asOf)}</span>` : '';
    return `<div class="dc-card-title">אינדיקטור לזיהוי משברים${p.partial ? ' <span class="dc-partial">(נתונים חלקיים)</span>' : ''}${liveTag}</div>
        <div class="dc-gauge">
            <div class="dc-gauge-num" style="color:${col}">${score}<span class="dc-gauge-max">/100</span></div>
            <div class="dc-gauge-label" style="color:${col}">${label}</div>
        </div>
        <div class="dc-gauge-bar"><div class="dc-gauge-fill" style="width:${score}%;background:linear-gradient(90deg,#10b981,#f59e0b,#ef4444)"></div><div class="dc-gauge-marker" style="inset-inline-start:${score}%"></div></div>
        <div class="dc-prox-parts">
            ${p.parts.map(part => {
        const c = part.score >= 70 ? '#ef4444' : part.score >= 45 ? '#f59e0b' : '#10b981';
        return `<div class="dc-prox-row"><span class="dc-prox-key">${_stEsc(part.key)}</span>
                    <div class="dc-prox-track"><span class="dc-prox-fill" style="width:${part.score}%;background:${c}"></span></div>
                    <span class="dc-prox-val" style="color:${c}">${part.score} <small>${_stEsc(part.note)}</small></span></div>`;
    }).join('')}
        </div>
        <div class="dc-card-foot">מבוסס על הערכות-שווי ושאננות שוק, לחצי אינפלציה, מדיניות מוניטרית, היפוך עקום התשואות, תנודתיות (VIX) ורמות המינוף בשוק — נתוני אמת. סוכן ייעודי סורק את השוק ומעדכן את האינדיקטור 24/7.</div>`;
}

// ── Page shell ────────────────────────────────────────────────────────────────
function _stRenderShell() {
    const page = document.getElementById('stressTestPage');
    if (!page) return;
    const hasPortfolios = typeof clients !== 'undefined' && Array.isArray(clients) && clients.length;
    const opts = hasPortfolios ? clients.map(c => `<option value="${_stEsc(String(c.id))}" ${c.id === _stPortfolioId ? 'selected' : ''}>${_stEsc(c.name || ('תיק ' + c.id))}</option>`).join('') : '';
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">סימולטור תרחישי קיצון</h1>
            <button class="macro-back-btn" onclick="closeStressTestPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="st-intro">
                <p class="st-subtitle">בחר תרחיש מאקרו / גיאופוליטי / קריסה סקטוריאלית — וראה כיצד הוא ישפיע על התיק שלך בזמן אמת: ציון פגיעוּת, צפי רווח/הפסד, הנכסים החשופים ביותר, והמלצות גידור מבוססות נתונים.</p>
                <div class="st-baseline" id="stBaseline">${_stBaselineHTML()}</div>
            </div>

            <div class="st-section-title">מצב השוק — אינדיקטור לזיהוי משברים</div>
            <div class="dc-card glass-card st-prox-card" id="stProxCard">${_stProximityHTML()}</div>

            ${hasPortfolios ? `
            <div class="st-portfolio-row">
                <label class="st-pf-label">תיק לבדיקה:</label>
                <select class="st-pf-select" id="stPortfolio" onchange="_stOnPortfolio(this.value)">${opts}</select>
                <span class="st-pf-meta" id="stPfMeta">${_stPfMetaHTML()}</span>
            </div>` : `<div class="st-empty">אין תיקים לבדיקה — הוסף תיק כדי להריץ סימולציית קיצון.</div>`}

            ${hasPortfolios ? `
            <div class="st-section-title">1 · בחירת תרחיש</div>
            <div class="st-scenarios" id="stScenarios">
                ${ST_SCENARIOS.map(_stScenarioCard).join('')}
                <button class="st-scn st-scn-custom ${_stScenarioId === 'custom' ? 'active' : ''}" onclick="_stSelectScenario('custom')">
                    <span class="st-scn-icon">🎛️</span>
                    <span class="st-scn-title">תרחיש מותאם אישית</span>
                    <span class="st-scn-desc">הגדר ידנית: אינפלציה, ריבית, שער חליפין ו-VIX.</span>
                </button>
            </div>
            <div class="st-custom-wrap" id="stCustomWrap" style="display:${_stScenarioId === 'custom' ? 'block' : 'none'}">${_stCustomPanelHTML()}</div>

            <div class="st-run-row">
                <button class="st-run-btn" id="stRunBtn" onclick="_stRun()">⚡ הרצת סימולציה</button>
            </div>

            <div class="st-results" id="stResults">${_stResult ? _stResultsHTML(_stResult, _stActiveDeltas()) : ''}</div>
            ` : ''}
        </div>
    </div>`;
}
if (typeof window !== 'undefined') window._stRenderShell = _stRenderShell;

function _stPfMetaHTML() {
    const p = _stPortfolio();
    if (!p) return '';
    const hs = _stHoldings();
    const total = hs.reduce((s, h) => s + h.value, 0);
    return `${hs.length} נכסים · שווי ≈ $${Math.round(total).toLocaleString('en-US')}`;
}
function _stOnPortfolio(id) { _stPortfolioId = isNaN(+id) ? id : +id; _stResult = null; _stRenderShell(); }
if (typeof window !== 'undefined') window._stOnPortfolio = _stOnPortfolio;

function _stScenarioCard(s) {
    return `<button class="st-scn ${_stScenarioId === s.id ? 'active' : ''}" onclick="_stSelectScenario('${s.id}')">
        <span class="st-scn-icon">${s.icon}</span>
        <span class="st-scn-title">${_stEsc(s.title)}</span>
        <span class="st-scn-desc">${_stEsc(s.desc)}</span>
    </button>`;
}

function _stSelectScenario(id) {
    _stScenarioId = id;
    _stRenderShell();
}
if (typeof window !== 'undefined') window._stSelectScenario = _stSelectScenario;

// Custom-scenario sliders (inflation / rate / FX / VIX).
function _stCustomPanelHTML() {
    const sl = (key, label, min, max, step, unit, val) => `
        <div class="st-slider">
            <div class="st-slider-head"><span>${label}</span><span class="st-slider-val" id="stv-${key}">${val > 0 ? '+' : ''}${val}${unit}</span></div>
            <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" oninput="_stSetCustom('${key}', this.value)">
        </div>`;
    return `<div class="st-custom-grid">
        ${sl('infl', 'שינוי אינפלציה (CPI)', -3, 6, 0.25, '%', _stCustom.infl)}
        ${sl('rate', 'שינוי ריבית פד', -1, 3, 0.25, '%', _stCustom.rate)}
        ${sl('usd', 'שינוי שער הדולר', -10, 10, 0.5, '%', _stCustom.usd)}
        ${sl('vix', 'שינוי VIX (נקודות)', -10, 40, 1, '', _stCustom.vix)}
    </div>`;
}
function _stSetCustom(key, val) {
    _stCustom[key] = +val;
    const el = document.getElementById('stv-' + key);
    const unit = key === 'vix' ? '' : '%';
    if (el) el.textContent = (_stCustom[key] > 0 ? '+' : '') + _stCustom[key] + unit;
}
if (typeof window !== 'undefined') window._stSetCustom = _stSetCustom;

// ── Run the simulation (elegant loading → compute → render) ───────────────────
function _stRun() {
    const btn = document.getElementById('stRunBtn');
    const results = document.getElementById('stResults');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="st-spin"></span> מריץ סימולציה…'; }
    if (results) results.innerHTML = `<div class="st-loading"><span class="st-spin st-spin-lg"></span><div>מחשב את השפעת התרחיש על ${_stHoldings().length} נכסי התיק…</div></div>`;
    setTimeout(() => {
        const holdings = _stHoldings();
        const deltas = _stActiveDeltas();
        _stResult = calculateScenarioImpact(holdings, deltas);
        if (results) results.innerHTML = _stResultsHTML(_stResult, deltas);
        if (btn) { btn.disabled = false; btn.innerHTML = '⚡ הרצת סימולציה'; }
        const rc = document.getElementById('stResults');
        if (rc) rc.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 650);
}
if (typeof window !== 'undefined') window._stRun = _stRun;

// ── Results ───────────────────────────────────────────────────────────────────
function _stResultsHTML(r, deltas) {
    if (!r || !r.rows.length) return '<div class="st-empty">אין נכסים לחישוב בתיק זה.</div>';
    const scenario = _stScenarioId === 'custom' ? null : ST_SCENARIOS.find(s => s.id === _stScenarioId);
    return `
        <div class="st-section-title">2 · ניתוח השפעה על התיק</div>
        <div class="st-impact-grid">
            <div class="st-card st-gauge-card">
                <div class="st-card-h">מדד רגישות התיק</div>
                ${_stGaugeHTML(r.fragility)}
            </div>
            <div class="st-card st-pnl-card">
                <div class="st-card-h">צפי פגיעה ברווח/הפסד</div>
                ${_stPnlHTML(r)}
            </div>
        </div>
        <div class="st-card st-weak-card">
            <div class="st-card-h">החוליה החלשה — נכסים מדורגים לפי פגיעוּת לתרחיש</div>
            ${_stWeakestHTML(r.rows)}
        </div>
        <div class="st-section-title">3 · ניתוח AI והמלצות גידור</div>
        ${_stAiHTML(r, scenario, deltas)}`;
}

// Semicircular SVG fragility gauge (1-100), green → crimson.
function _stGaugeHTML(frag) {
    const lvl = frag >= 85 ? { c: '#dc2626', he: 'פגיע מאוד' } : frag >= 70 ? { c: '#ef4444', he: 'פגיע' }
        : frag >= 50 ? { c: '#f59e0b', he: 'רגישות בינונית' } : frag >= 30 ? { c: '#14b8a6', he: 'יציב יחסית' }
            : { c: '#10b981', he: 'חסין' };
    const R = 80, len = Math.PI * R;
    const filled = (Math.max(1, Math.min(100, frag)) / 100) * len;
    return `
    <div class="st-gauge">
        <svg viewBox="0 0 200 112" width="100%" preserveAspectRatio="xMidYMid meet">
            <path d="M 20 96 A 80 80 0 0 1 180 96" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="14" stroke-linecap="round"/>
            <path d="M 20 96 A 80 80 0 0 1 180 96" fill="none" stroke="${lvl.c}" stroke-width="14" stroke-linecap="round"
                  stroke-dasharray="${filled.toFixed(1)} ${len.toFixed(1)}" style="filter:drop-shadow(0 0 6px ${lvl.c}88)"/>
            <text x="100" y="84" text-anchor="middle" font-size="40" font-weight="900" fill="${lvl.c}">${frag}</text>
            <text x="100" y="104" text-anchor="middle" font-size="12" fill="#9aa3b2">מתוך 100</text>
        </svg>
        <div class="st-gauge-label" style="color:${lvl.c}">${lvl.he}</div>
    </div>`;
}

// Current vs. post-shock portfolio value (before/after bars).
function _stPnlHTML(r) {
    const before = r.totalValue, after = Math.max(0, r.newValue);
    const maxV = Math.max(before, after) || 1;
    const fmt = (v) => '$' + Math.round(v).toLocaleString('en-US');
    const lossCls = r.pnl < 0 ? 'st-neg' : 'st-pos';
    return `
    <div class="st-pnl">
        <div class="st-pnl-bars">
            <div class="st-pnl-bar">
                <div class="st-pnl-track"><div class="st-pnl-fill st-pnl-now" style="height:${(before / maxV * 100).toFixed(1)}%"></div></div>
                <div class="st-pnl-bv">${fmt(before)}</div>
                <div class="st-pnl-bl">שווי נוכחי</div>
            </div>
            <div class="st-pnl-bar">
                <div class="st-pnl-track"><div class="st-pnl-fill st-pnl-after" style="height:${(after / maxV * 100).toFixed(1)}%"></div></div>
                <div class="st-pnl-bv ${lossCls}">${fmt(after)}</div>
                <div class="st-pnl-bl">לאחר התרחיש</div>
            </div>
        </div>
        <div class="st-pnl-summary ${lossCls}">
            <span class="st-pnl-pct">${r.weightedDrop >= 0 ? '+' : ''}${r.weightedDrop.toFixed(1)}%</span>
            <span class="st-pnl-abs">${r.pnl >= 0 ? '+' : '−'}${fmt(Math.abs(r.pnl))}</span>
        </div>
    </div>`;
}

// The weakest-link table — holdings ranked by projected drop; extreme-risk rows tinted red.
function _stWeakestHTML(rows) {
    const body = rows.map(h => {
        const extreme = h.dropPct <= -18;
        const dropCls = h.dropPct < -0.5 ? 'st-neg' : h.dropPct > 0.5 ? 'st-pos' : '';
        return `<tr class="${extreme ? 'st-row-extreme' : ''}">
            <td class="st-tk">${_stEsc(String(h.ticker || '').replace(/\.TA$/, ''))}<span class="st-tk-cls">${_stEsc(h.classHe)}</span></td>
            <td>${h.weightPct.toFixed(1)}%</td>
            <td>${h.beta != null ? h.beta.toFixed(2) : '—'}</td>
            <td class="${dropCls} st-drop">${h.dropPct >= 0 ? '+' : ''}${h.dropPct.toFixed(1)}%</td>
            <td class="${dropCls}">${h.valueChange >= 0 ? '+' : '−'}$${Math.round(Math.abs(h.valueChange)).toLocaleString('en-US')}</td>
        </tr>`;
    }).join('');
    return `<div class="st-table-wrap"><table class="st-table">
        <thead><tr><th>נכס</th><th>משקל</th><th>β</th><th>פגיעה משוערת</th><th>שינוי בשווי</th></tr></thead>
        <tbody>${body}</tbody>
    </table></div>`;
}

// AI narrative (why exposed) + hedge generator (data-driven, parameterized by the real portfolio).
function _stAiHTML(r, scenario, deltas) {
    const hedge = _stHedgePlan(_stHoldings(), deltas, r);
    const cw = r.classWeight || {};
    const techW = ((cw.tech || 0) + (cw.semis || 0)) * 100;
    const bondW = ((cw.bond_long || 0) + (cw.bond_short || 0)) * 100;
    const ilW = ((cw.il_stock || 0) + (cw.il_bank || 0) + (cw.il_index || 0)) * 100;
    const topRow = r.rows[0];
    const factorHe = { rate: 'עליית הריבית', infl: 'האינפלציה', usd: 'תנועת הדולר', vix: 'זינוק התנודתיות (VIX)', tech: 'תיקון הטכנולוגיה', ils: 'פיחות השקל' }[r.dominant] || 'התרחיש';
    const base = scenario ? scenario.risk_he : 'התרחיש המותאם שהגדרת משלב את שינויי הריבית, האינפלציה, הדולר וה-VIX שבחרת.';
    const exposure = [];
    if (techW >= 12) exposure.push(`חשיפה של ${techW.toFixed(0)}% לטכנולוגיה/סמיקונדקטורס (בטא גבוהה — רגישה במיוחד ל${factorHe})`);
    if (bondW >= 12) exposure.push(`${bondW.toFixed(0)}% באג״ח (רגיש למשך/ריבית)`);
    if (ilW >= 12) exposure.push(`${ilW.toFixed(0)}% בנכסים ישראליים`);
    const exposureLine = exposure.length ? `הגורם המרכזי לפגיעוּת התיק שלך: ${exposure.join('; ')}.` : '';
    const weakLine = topRow ? `הנכס החשוף ביותר בתיק לתרחיש זה הוא ${String(topRow.ticker).replace(/\.TA$/, '')} (${topRow.dropPct.toFixed(1)}%).` : '';

    return `
    <div class="st-card st-ai-card">
        <div class="st-ai-section">
            <div class="st-ai-h">🔍 ניתוח סיכונים אקטיבי</div>
            <p class="st-ai-text">${_stEsc(base)} ${_stEsc(exposureLine)} ${_stEsc(weakLine)} בתרחיש זה צפויה ירידה של כ-${Math.abs(r.weightedDrop).toFixed(1)}% בשווי התיק, וציון הפגיעוּת עומד על <b>${r.fragility}/100</b>.</p>
        </div>
        <div class="st-ai-section st-hedge">
            <div class="st-ai-h">🛡️ מגן התיק — הצעות לגידור</div>
            <p class="st-ai-text">כדי להוריד את מדד הרגישות מ-<b>${hedge.fromFrag}</b> ל-<b>~${hedge.toFrag}</b> בתרחיש זה, מומלץ להקצות כ-<b>${hedge.pct}%</b> מהתיק ל־<b>${_stEsc(hedge.hedgeLabel)}</b> — נכס שמציג היסטורית קורלציה הפוכה ל${factorHe}${scenario ? ` (${_stEsc(scenario.hedge.reason_he)})` : ''}. הקצאה זו מקזזת חלק מהפגיעה ומקטינה את הריכוזיות בתיק.</p>
        </div>
        <div class="st-ai-foot">הערכה מבוססת על רגישויות מאקרו מכוילות־היסטורית לכל סוג נכס × המשקלים בפועל בתיק שלך, על בסיס המצב הנוכחי שהסוכנים אוספים 24/7. אינה ייעוץ השקעות.</div>
    </div>`;
}
