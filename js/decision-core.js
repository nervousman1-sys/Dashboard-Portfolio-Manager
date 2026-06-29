// ========== DECISION CORE — Stress-Test Engine (מנוע מבחני קיצון) ==========
//
// A self-contained feature for Finextium: stress-tests the SELECTED portfolio against real
// historical crises, surfaces concrete de-risking actions, and shows a market "crisis proximity"
// gauge built from real macro signals. Vanilla JS + the platform's Cyber-Noir CSS (no frameworks,
// no chart libraries — structural metric cards + progress bars only). All user text is Hebrew.
//
// Modeling note: crisis shocks are per-ASSET-CLASS drawdowns calibrated to the ACTUAL peak-to-
// trough moves of each crisis (e.g. financials −82% in 2008; energy +45% during the 2022 selloff;
// bonds FELL in 2022 as rates rose). The portfolio impact is the value-weighted sum — grounded
// estimation, not a guess.

// ── State ──
let _dcClientId = null;       // selected portfolio
let _dcScenario = 'gfc';      // selected crisis
let _dcProximity = null;      // cached proximity result { score, parts, partial }

// ── Crypto-equity proxies (move with crypto in a crash, not with their nominal sector) ──
const _DC_CRYPTO_EQ = new Set(['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'CIFR', 'WULF', 'MTPLF', 'BTBT', 'IREN']);

// ── Historical crisis scenarios — per-asset-class peak-to-trough shock (fraction; + = gain) ──
const _DC_SCENARIOS = {
    dotcom: {
        he: 'בועת הדוט-קום', years: '2000–2002', vix: 45,
        desc: 'התרסקות מניות הטכנולוגיה והאינטרנט. נאסד"ק צנח כ-78%, בעוד אג"ח ממשלתי וזהב שימשו מפלט.',
        shock: { crypto: -0.65, bond: 0.18, commodity: 0.12, cash: 0, broad_market: -0.45, tech_growth: -0.78, financials: -0.30, energy: -0.15, reit: 0.10, defensive: -0.12, cyclical: -0.35 },
    },
    gfc: {
        he: 'המשבר הפיננסי הגדול', years: '2007–2009', vix: 80,
        desc: 'משבר הסאב-פריים. S&P 500 איבד כ-57%, המגזר הפיננסי קרס (−82%) והנדל"ן נמחק. אג"ח ממשלתי וזהב עלו.',
        shock: { crypto: -0.70, bond: 0.10, commodity: 0.04, cash: 0, broad_market: -0.55, tech_growth: -0.55, financials: -0.82, energy: -0.50, reit: -0.68, defensive: -0.28, cyclical: -0.50 },
    },
    crypto: {
        he: 'קריסת הקריפטו', years: '2021–2022', vix: 38,
        desc: 'התפוצצות בועת הקריפטו לצד עליית ריבית. ביטקוין צנח כ-77%, אג"ח דווקא ירד (הריבית עלתה) ואנרגיה זינקה.',
        shock: { crypto: -0.77, bond: -0.15, commodity: -0.03, cash: 0, broad_market: -0.20, tech_growth: -0.35, financials: -0.16, energy: 0.45, reit: -0.26, defensive: -0.06, cyclical: -0.18 },
    },
};

// Hebrew labels for each asset class in the breakdown.
const _DC_CLASS_HE = {
    crypto: 'קריפטו', bond: 'אג"ח', commodity: 'סחורות/זהב', cash: 'מזומן',
    broad_market: 'מדדי שוק רחבים', tech_growth: 'טכנולוגיה/צמיחה', financials: 'פיננסים',
    energy: 'אנרגיה', reit: 'נדל"ן (REIT)', defensive: 'מניות דפנסיביות', cyclical: 'מניות מחזוריות',
};

// ── Concrete defensive assets per scenario, with their ACTUAL behavior in that crisis ──
// Research-grounded (real peak-to-trough/period moves) so the investor gets specific, actionable
// hedges — not generic advice. Scenario-aware: long bonds shine in deflationary crashes (2000/2008)
// but were a TRAP in the 2022 inflation crash, where short T-bills, gold and energy held up.
const _DC_DEFENSIVE = {
    dotcom: [
        { t: 'TLT', he: 'אג"ח ממשלתי ארוך', note: 'הריבית ירדה בחדות 2000–2002 → אג"ח ארוך זינק (~+30%+).' },
        { t: 'GLD', he: 'זהב', note: 'עלה כ-+12% בתקופה ושימש מפלט מהתרסקות הטכנולוגיה.' },
        { t: 'XLU', he: 'תשתיות וחשמל', note: 'סקטור דפנסיבי שירד הרבה פחות מהשוק הרחב.' },
        { t: 'XLP', he: 'מוצרי צריכה בסיסיים', note: 'ביקוש קשיח → ירידה מתונה בלבד.' },
        { t: 'VNQ', he: 'נדל"ן מניב (REIT)', note: 'הנדל"ן דווקא עלה 2000–2002 בזכות הריבית היורדת.' },
    ],
    gfc: [
        { t: 'TLT', he: 'אג"ח ממשלתי ארוך', note: 'זינק כ-+34% ב-2008 בבריחה לאיכות — הגידור הטוב ביותר.' },
        { t: 'GLD', he: 'זהב', note: 'עלה כ-+5% ב-2008 כשהמניות קרסו.' },
        { t: 'SHV', he: 'מק"ם דולרי קצר', note: 'שמירת ערך מלאה + נזילות לקנייה בתחתית.' },
        { t: 'XLP', he: 'מוצרי צריכה בסיסיים', note: 'ירד רק כ-28% מול −57% ב-S&P 500.' },
        { t: 'XLV', he: 'בריאות', note: 'ביקוש לא-מחזורי → ירידה ממותנת.' },
    ],
    crypto: [
        { t: 'SGOV', he: 'מק"ם דולרי קצר', note: 'נהנה ישירות מהריבית הגבוהה של 2022 — הניב תשואה חיובית.' },
        { t: 'GLD', he: 'זהב', note: 'נשאר כמעט ללא שינוי (~0%) בעוד נכסי סיכון קרסו.' },
        { t: 'XLE', he: 'אנרגיה', note: 'זינק כ-+45% ב-2022 — נהנה מהאינפלציה.' },
        { t: 'TIP', he: 'אג"ח צמוד מדד', note: 'הגנה ישירה מפני אינפלציה (עדיף על אג"ח נומינלי ארוך).' },
        { t: 'XLP', he: 'מוצרי צריכה בסיסיים', note: 'יציב יחסית — ירד רק אחוזים בודדים.' },
    ],
};

// ── Asset-class resolver ──
function _dcAssetClass(h) {
    const t = String(h.ticker || '').replace(/\.TA$/i, '').toUpperCase();
    if ((typeof CRYPTO_ETF_SET !== 'undefined' && CRYPTO_ETF_SET.has(t)) || _DC_CRYPTO_EQ.has(t)) return 'crypto';
    if (h.type === 'bond' || (typeof BOND_ETF_SET !== 'undefined' && BOND_ETF_SET.has(t))) return 'bond';
    if (typeof COMMODITY_ETF_SET !== 'undefined' && COMMODITY_ETF_SET.has(t)) return 'commodity';
    const sec = (typeof resolveHoldingSector === 'function') ? resolveHoldingSector(h) : (h.sector || 'Other');
    switch (sec) {
        case 'Crypto': return 'crypto';
        case 'Bonds': return 'bond';
        case 'סחורות': return 'commodity';
        case 'תעודות סל עוקבות מדד': return 'broad_market';
        case 'Information Technology': case 'Communication Services': case 'טכנולוגיית מידע': case 'שירותי תקשורת': return 'tech_growth';
        case 'Financials': case 'פיננסים': case 'בנקים': case 'ביטוח': return 'financials';
        case 'Energy': case 'אנרגיה': return 'energy';
        case 'Real Estate': case 'נדל"ן': return 'reit';
        case 'Health Care': case 'Consumer Staples': case 'Utilities': case 'בריאות': case 'מוצרי צריכה בסיסיים': case 'תשתיות וחשמל': return 'defensive';
        case 'Consumer Discretionary': case 'Industrials': case 'Materials': case 'צריכה מחזורית': case 'תעשייה': case 'חומרי גלם': return 'cyclical';
        default: return 'broad_market';
    }
}

function _dcFx() { return (typeof USD_ILS_RATE !== 'undefined' && USD_ILS_RATE > 0) ? USD_ILS_RATE : 3.7; }
function _dcIlsToUsd() { return (typeof getFxRate === 'function') ? getFxRate('ILS', 'USD') : (1 / _dcFx()); }

// Portfolio composition in USD, bucketed by asset class (+ cash).
function _dcBreakdown(client) {
    const byClass = {};
    let totalUsd = 0;
    for (const h of (client.holdings || [])) {
        const valUsd = (h.value != null ? h.value : (h.shares || 0) * (h.price || 0)) *
            ((typeof getFxRate === 'function') ? getFxRate(h.currency || 'USD', 'USD') : 1);
        if (!(valUsd > 0)) continue;
        const cls = _dcAssetClass(h);
        byClass[cls] = (byClass[cls] || 0) + valUsd;
        totalUsd += valUsd;
    }
    const cashUsd = client.cash ? ((client.cash.usd || 0) + (client.cash.ils || 0) * _dcIlsToUsd()) : (client.cashBalance || 0);
    if (cashUsd > 0) { byClass.cash = (byClass.cash || 0) + cashUsd; totalUsd += cashUsd; }
    return { byClass, totalUsd };
}

// Run the stress test for a portfolio against a scenario.
function _dcSimulate(client, scenarioKey) {
    const sc = _DC_SCENARIOS[scenarioKey];
    const { byClass, totalUsd } = _dcBreakdown(client);
    if (!(totalUsd > 0)) return null;
    let impactUsd = 0;
    const rows = [];
    for (const cls of Object.keys(byClass)) {
        const value = byClass[cls];
        const shock = sc.shock[cls] != null ? sc.shock[cls] : 0;
        const cls_impact = value * shock;
        impactUsd += cls_impact;
        rows.push({ cls, value, shock, impact: cls_impact, weight: value / totalUsd });
    }
    rows.sort((a, b) => a.impact - b.impact); // worst hit first
    const drawdownPct = impactUsd / totalUsd; // negative = loss
    // Effective volatility spike: the crisis VIX peak, scaled by how exposed THIS portfolio is to
    // risk assets (a mostly-cash portfolio feels far less of the spike).
    const riskExposure = 1 - ((byClass.cash || 0) + (byClass.bond || 0) * 0.5) / totalUsd;
    const baseVix = 16;
    const effVix = Math.round(baseVix + (sc.vix - baseVix) * Math.max(0.25, riskExposure));
    return {
        scenarioKey, totalUsd, impactUsd, drawdownPct, rows,
        valueAfterUsd: totalUsd + impactUsd, vixPeak: sc.vix, effVix, riskExposure,
    };
}

// ── Crisis-proximity gauge (0–100) from REAL macro signals ──
async function _dcComputeProximity() {
    // PRIMARY: the 24/7 crisis agent's latest reading (deterministic score from real signals + an AI
    // Hebrew assessment), persisted in Supabase. FALLBACK: compute live client-side (below).
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

    const parts = [];
    let missing = 0;
    // 1. Valuation / complacency — CNN Fear & Greed (extreme greed → complacency → higher risk)
    let fg = null;
    try {
        const r = await fetch('/api/feargreed', { headers: { Accept: 'application/json' } });
        if (r.ok) { const j = await r.json(); fg = (j && (j.score ?? j.value)); }
    } catch (e) { }
    if (fg != null && isFinite(fg)) parts.push({ key: 'הערכות יתר ושאננות', score: Math.round(fg), w: 0.25, note: `מדד פחד/חמדנות: ${Math.round(fg)}` });
    else { missing++; parts.push({ key: 'הערכות יתר ושאננות', score: 50, w: 0.25, note: 'נתון חלקי' }); }

    // Macro block (CPI / rates / yield curve) — from the cached macro page or the aggregator.
    let macro = (typeof window !== 'undefined' && window._macroHeadUS) ? window._macroHeadUS : null;
    if (!macro || macro.cpi == null) {
        try {
            const r = await fetch(`/api/macro?d=${new Date().toISOString().slice(0, 10)}`, { headers: { Accept: 'application/json' } });
            if (r.ok) { const j = await r.json(); macro = (j && (j.us || j.US)) || macro; }
        } catch (e) { }
    }
    const num = (x) => (x && typeof x === 'object') ? (x.value ?? x.actual ?? null) : x;
    // 2. Inflation pressure
    const cpi = macro ? num(macro.cpi) : null;
    if (cpi != null && isFinite(cpi)) {
        const s = Math.max(0, Math.min(100, (cpi - 1.5) / (5.5 - 1.5) * 100));
        parts.push({ key: 'לחצי אינפלציה', score: Math.round(s), w: 0.2, note: `CPI ${cpi}%` });
    } else { missing++; parts.push({ key: 'לחצי אינפלציה', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    // 3. Monetary policy — policy-rate level
    const rate = macro ? (num(macro.fed_rate) ?? num(macro.rate) ?? num(macro.fedRate) ?? num(macro.interestRate)) : null;
    if (rate != null && isFinite(rate)) {
        const s = Math.max(0, Math.min(100, rate / 6 * 100));
        parts.push({ key: 'מדיניות מוניטרית מהדקת', score: Math.round(s), w: 0.2, note: `ריבית ${rate}%` });
    } else { missing++; parts.push({ key: 'מדיניות מוניטרית מהדקת', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    // 4. Yield-curve inversion (recession signal) — 10y minus 2y
    let spread = null;
    try {
        const r = await fetch('/api/yields', { headers: { Accept: 'application/json' } });
        if (r.ok) {
            const j = await r.json();
            const us = (j && (j.us || j.US)) || j;
            let y10 = null, y2 = null;
            if (Array.isArray(us)) {                       // [{label:'10Y', value:4.49}, …]
                const find = (lbl) => { const e = us.find(x => x && x.label === lbl); return e ? Number(e.value) : null; };
                y10 = find('10Y'); y2 = find('2Y');
            } else {
                y10 = num(us && (us.y10 || us['10Y'] || us.tenYear)); y2 = num(us && (us.y2 || us['2Y'] || us.twoYear));
            }
            if (y10 != null && y2 != null && isFinite(y10) && isFinite(y2)) spread = y10 - y2;
        }
    } catch (e) { }
    if (spread != null && isFinite(spread)) {
        const s = Math.max(0, Math.min(100, (0.8 - spread) / (0.8 - (-1.2)) * 100));
        parts.push({ key: 'היפוך עקום התשואות', score: Math.round(s), w: 0.2, note: `מרווח 10ש'−2ש' ${spread.toFixed(2)}%` });
    } else { missing++; parts.push({ key: 'היפוך עקום התשואות', score: 50, w: 0.2, note: 'נתון חלקי' }); }
    // 5. Market stress — VIX (live)
    let vix = null;
    try {
        const r = await fetch('/api/quote?symbols=%5EVIX', { headers: { Accept: 'application/json' } });
        if (r.ok) { const j = await r.json(); const v = j && (j['^VIX'] || j.VIX); vix = v && (v.price ?? v.regularMarketPrice ?? v.value); }
    } catch (e) { }
    if (vix != null && isFinite(vix)) {
        const s = Math.max(0, Math.min(100, (vix - 12) / (45 - 12) * 100));
        parts.push({ key: 'תנודתיות שוק (VIX)', score: Math.round(s), w: 0.15, note: `VIX ${Number(vix).toFixed(1)}` });
    } else { missing++; parts.push({ key: 'תנודתיות שוק (VIX)', score: 40, w: 0.15, note: 'נתון חלקי' }); }

    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const score = Math.round(parts.reduce((s, p) => s + p.score * p.w, 0) / (wsum || 1));
    return { score, parts, partial: missing >= 3 };
}

// ── De-risking strategy (deterministic, portfolio-aware) ──
function _dcReduceRisk(client, scenarioKey, sim) {
    const sc = _DC_SCENARIOS[scenarioKey];
    const total = sim.totalUsd;
    const pct = (cls) => total > 0 ? ((sim.rows.find(r => r.cls === cls)?.value || 0) / total) : 0;
    const cryptoP = pct('crypto'), cashP = pct('cash'), bondP = pct('bond'), defP = pct('defensive'), commP = pct('commodity');
    const equityP = pct('broad_market') + pct('tech_growth') + pct('financials') + pct('energy') + pct('reit') + pct('cyclical') + pct('defensive');
    const recs = [];
    const fmtP = (x) => Math.round(x * 100) + '%';

    // Target cash cushion scales with the crisis severity + the proximity gauge.
    const prox = (_dcProximity && _dcProximity.score) || 55;
    const targetCash = Math.min(0.35, 0.12 + (prox / 100) * 0.18 + cryptoP * 0.2);
    if (cashP < targetCash - 0.03) {
        recs.push({ icon: '💵', tone: 'warn', title: 'הגדלת כרית נזילות (מזומן)',
            body: `כרית המזומן הנוכחית ${fmtP(cashP)}. בתרחיש "${sc.he}" מומלץ להעלות אותה ל-${fmtP(targetCash)} — מקור "אבק יבש" שמאפשר לקנות נכסים איכותיים בזול בתחתית ומקטין את התנודתיות הכוללת.` });
    } else {
        recs.push({ icon: '✅', tone: 'pos', title: 'כרית הנזילות תקינה',
            body: `המזומן (${fmtP(cashP)}) מספק כרית הולמת לתרחיש זה. שמור עליו כ"אבק יבש".` });
    }

    // Crypto trim — the highest-beta exposure in every crisis.
    if (cryptoP > 0.10) {
        recs.push({ icon: '₿', tone: 'risk', title: 'צמצום חשיפה לקריפטו',
            body: `חשיפת הקריפטו ${fmtP(cryptoP)} היא הסיכון הגדול בתיק — בתרחיש זה היא צפויה לרדת ${fmtP(Math.abs(sc.shock.crypto))}. שקול לצמצם אותה אל מתחת ל-10% ולנעול רווחים, כדי לחתוך את עיקר הפגיעה.` });
    }

    // Defensive sector rotation.
    if (defP < 0.20 && equityP > 0.30) {
        recs.push({ icon: '🛡️', tone: 'warn', title: 'הסטה לסקטורים דפנסיביים',
            body: `רק ${fmtP(defP)} מהתיק במניות דפנסיביות. הסט חלק מהמניות המחזוריות/הטכנולוגיה לסקטורים יציבים — מוצרי צריכה בסיסיים (XLP), בריאות (XLV) ותשתיות/חשמל (XLU). אלו נפגעים פחות בכל קריסה.` });
    }

    // Safe-haven hedges — tuned to the scenario (NOT bonds in the inflation-driven crypto crash).
    if (scenarioKey === 'crypto') {
        recs.push({ icon: '🛢️', tone: 'pos', title: 'גידור מותאם-אינפלציה',
            body: `במשבר מסוג זה (ריבית עולה) אג"ח ארוך דווקא נפגע. עדיף גידור בזהב (GLD) ובאג"ח קצר-טווח / מק"ם (SGOV, SHV) ששומר על ערך, ולשקול חשיפה מתונה לאנרגיה (XLE) שנהנית מאינפלציה.` });
    } else {
        recs.push({ icon: '🏦', tone: 'pos', title: 'גידור במפלטים בטוחים',
            body: `בתרחיש זה אג"ח ממשלתי ארוך (TLT) וזהב (GLD) עלו כשהמניות צנחו. הקצאה של 10–20% למפלטים אלו מקזזת חלק ניכר מהירידה ומורידה את ה-Max Drawdown של התיק.` });
    }

    // Concentration warning.
    const worst = sim.rows[0];
    if (worst && worst.weight > 0.4 && worst.cls !== 'cash' && worst.cls !== 'bond') {
        recs.push({ icon: '⚠️', tone: 'risk', title: 'ריכוזיות יתר',
            body: `${fmtP(worst.weight)} מהתיק מרוכז ב${_DC_CLASS_HE[worst.cls]} — ריכוזיות שמגבירה את הפגיעה. פיזור על פני סקטורים וסוגי נכסים נוספים יקטין את הסיכון הספציפי.` });
    }
    return recs;
}

// ====================== RENDER ======================
// Open as a routed PAGE (not a popup) — same pattern as the reports/LHE/scanner pages.
function openDecisionCorePage() {
    const page = document.getElementById('decisionCorePage');
    if (!page) return;
    // Default to the first portfolio if none selected
    if (typeof clients !== 'undefined' && clients.length) {
        if (!_dcClientId || !clients.find(c => c.id === _dcClientId)) _dcClientId = clients[0].id;
    }
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'decisionCorePage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('decisioncore');
    if (typeof updateURLState === 'function') updateURLState({ view: 'decisioncore' });
    window.scrollTo(0, 0);
    _dcRender();
    // Proximity is async — compute then refresh that card.
    _dcComputeProximity().then(p => { _dcProximity = p; const el = document.getElementById('dcProximityCard'); if (el) el.innerHTML = _dcProximityHTML(); }).catch(() => { });
}

function closeDecisionCorePage() {
    const page = document.getElementById('decisionCorePage');
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
    window.openDecisionCorePage = openDecisionCorePage; window.closeDecisionCorePage = closeDecisionCorePage;
    window.openDecisionCore = openDecisionCorePage; window.closeDecisionCore = closeDecisionCorePage;
}

function setDcScenario(key) { _dcScenario = key; _dcRender(); }
function setDcClient(id) { _dcClientId = Number(id); _dcRender(); }

// ── Searchable portfolio picker ──
function _dcPpOpen(open) { const l = document.getElementById('dcPpList'); if (l) l.classList.toggle('open', open !== false); }
function _dcPpFilter(q) {
    q = String(q || '').toLowerCase().trim();
    document.querySelectorAll('#dcPpList .dc-pp-item').forEach(it => {
        it.style.display = (!q || (it.dataset.name || '').includes(q)) ? '' : 'none';
    });
    _dcPpOpen(true);
}
// Close the dropdown when clicking outside it (registered once).
if (typeof window !== 'undefined' && !window._dcPpBound) {
    window._dcPpBound = true;
    document.addEventListener('click', (e) => {
        const box = document.getElementById('dcPpBox');
        if (box && !box.contains(e.target)) _dcPpOpen(false);
    });
}
function _dcPortfolioPickerHTML(list, client) {
    const items = list.map(c => {
        const nm = (c.name || 'תיק');
        const val = _dcMoney(_dcBreakdown(c).totalUsd, 'USD');
        return `<div class="dc-pp-item ${client && c.id === client.id ? 'sel' : ''}" data-name="${nm.toLowerCase().replace(/"/g, '&quot;')}" onclick="setDcClient(${c.id})">
            <span class="dc-pp-item-name">${nm.replace(/</g, '')}</span><span class="dc-pp-item-val">${val}</span></div>`;
    }).join('');
    const cur = client ? (client.name || 'תיק') : '';
    return `<div class="dc-field dc-pp">
        <label>תיק לבדיקה</label>
        <div class="dc-pp-box" id="dcPpBox">
            <input class="dc-pp-input" id="dcPpInput" autocomplete="off" placeholder="חפש תיק לפי שם…"
                value="${cur.replace(/"/g, '&quot;')}"
                onfocus="this.select(); _dcPpOpen(true)" oninput="_dcPpFilter(this.value)" onclick="_dcPpOpen(true)">
            <span class="dc-pp-caret" onclick="document.getElementById('dcPpInput').focus()">▾</span>
            <div class="dc-pp-list" id="dcPpList">${items || '<div class="dc-pp-empty">אין תיקים</div>'}</div>
        </div>
    </div>`;
}
function _dcShowReduceRisk() {
    const panel = document.getElementById('dcReducePanel');
    const btn = document.getElementById('dcReduceBtn');
    if (!panel) return;
    // Collapsible — clicking again folds it back up.
    if (panel.classList.contains('open')) {
        panel.classList.remove('open');
        panel.innerHTML = '';
        if (btn) { btn.querySelector('.dc-reduce-label').textContent = '🛡️ דרכים להקטנת סיכון'; const c = btn.querySelector('.dc-reduce-caret'); if (c) c.textContent = '▾'; }
        return;
    }
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === _dcClientId) : null;
    if (!client) return;
    const sim = _dcSimulate(client, _dcScenario);
    if (!sim) return;
    const recs = _dcReduceRisk(client, _dcScenario, sim);
    const defensive = _DC_DEFENSIVE[_dcScenario] || [];
    const sc = _DC_SCENARIOS[_dcScenario];
    const defHTML = defensive.length ? `
        <div class="dc-def-title">🛡️ נכסים הגנתיים מומלצים לתרחיש "${sc.he}"</div>
        <div class="dc-def-sub">נכסים שהוכיחו עמידות במשבר זה (לפי ביצועי-אמת היסטוריים) — הקצאה אליהם מקטינה את הנזק:</div>
        <div class="dc-def-list">${defensive.map(d => `
            <div class="dc-def-item">
                <span class="dc-def-tk">${d.t}</span>
                <div class="dc-def-txt"><div class="dc-def-name">${d.he}</div><div class="dc-def-note">${d.note}</div></div>
            </div>`).join('')}</div>` : '';
    panel.innerHTML = `<div class="dc-recs">${recs.map(r => `
        <div class="dc-rec dc-rec-${r.tone}">
            <span class="dc-rec-icon">${r.icon}</span>
            <div class="dc-rec-txt"><div class="dc-rec-title">${r.title}</div><div class="dc-rec-body">${r.body}</div></div>
        </div>`).join('')}</div>${defHTML}`;
    panel.classList.add('open');
    if (btn) { const l = btn.querySelector('.dc-reduce-label'); if (l) l.textContent = '🛡️ הסתר דרכים להקטנת סיכון'; const c = btn.querySelector('.dc-reduce-caret'); if (c) c.textContent = '▴'; }
}

function _dcMoney(usd, cur) {
    const ils = cur === 'ILS';
    const v = ils ? usd * _dcFx() : usd;
    const sym = ils ? '₪' : '$';
    const a = Math.abs(v), sign = v < 0 ? '-' : '';
    if (a >= 1e6) return `${sign}${sym}${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${sign}${sym}${(a / 1e3).toFixed(1)}K`;
    return `${sign}${sym}${Math.round(a).toLocaleString('en-US')}`;
}

function _dcAgo(ts) {
    if (!ts) return '';
    const d = new Date(ts); if (isNaN(d)) return '';
    let s = Math.round((Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 90) return 'ממש עכשיו';
    const m = Math.round(s / 60); if (m < 60) return `לפני ${m} דק׳`;
    const h = Math.round(m / 60); if (h < 24) return `לפני ${h} שע׳`;
    return `לפני ${Math.round(h / 24)} ימים`;
}
function _dcProximityHTML() {
    const p = _dcProximity;
    if (!p) return `<div class="dc-card-title">אינדיקטור לזיהוי משברים</div><div class="dc-loading">מחשב מנתוני מאקרו חיים…</div>`;
    const score = p.score;
    const col = score >= 70 ? '#ef4444' : score >= 45 ? '#f59e0b' : '#10b981';
    const label = score >= 70 ? 'סיכון גבוה' : score >= 45 ? 'סיכון בינוני' : 'יציב';
    const liveTag = p.asOf ? `<span class="dc-live-tag"><span class="dc-live-dot"></span>סוכן 24/7 · עודכן ${_dcAgo(p.asOf)}</span>` : '';
    return `<div class="dc-card-title">אינדיקטור לזיהוי משברים${p.partial ? ' <span class="dc-partial">(נתונים חלקיים)</span>' : ''}${liveTag}</div>
        <div class="dc-gauge">
            <div class="dc-gauge-num" style="color:${col}">${score}<span class="dc-gauge-max">/100</span></div>
            <div class="dc-gauge-label" style="color:${col}">${label}</div>
        </div>
        <div class="dc-gauge-bar"><div class="dc-gauge-fill" style="width:${score}%;background:linear-gradient(90deg,#10b981,#f59e0b,#ef4444)"></div><div class="dc-gauge-marker" style="inset-inline-start:${score}%"></div></div>
        <div class="dc-prox-parts">
            ${p.parts.map(part => {
        const c = part.score >= 70 ? '#ef4444' : part.score >= 45 ? '#f59e0b' : '#10b981';
        return `<div class="dc-prox-row">
                    <span class="dc-prox-key">${part.key}</span>
                    <div class="dc-prox-track"><span class="dc-prox-fill" style="width:${part.score}%;background:${c}"></span></div>
                    <span class="dc-prox-val" style="color:${c}">${part.score} <small>${part.note}</small></span>
                </div>`;
    }).join('')}
        </div>
        <div class="dc-card-foot">מבוסס על הערכות-שווי ושאננות שוק, לחצי אינפלציה, מדיניות מוניטרית, היפוך עקום התשואות, תנודתיות (VIX) ורמות המינוף בשוק (NFCI) — נתוני אמת. סוכן ייעודי סורק את המצב בשוק ומעדכן את האינדיקטור באופן שוטף 24/7.</div>`;
}

function _dcRender() {
    const page = document.getElementById('decisionCorePage');
    if (!page) return;
    const list = (typeof clients !== 'undefined') ? clients : [];
    const client = list.find(c => c.id === _dcClientId) || list[0];

    const scenarioCards = Object.keys(_DC_SCENARIOS).map(k => {
        const sc = _DC_SCENARIOS[k];
        const active = k === _dcScenario;
        return `<button class="dc-scenario ${active ? 'active' : ''}" onclick="setDcScenario('${k}')">
            <span class="dc-scenario-name">${sc.he}</span>
            <span class="dc-scenario-years">${sc.years}</span>
            <span class="dc-scenario-vix">VIX שיא ≈ ${sc.vix}</span>
        </button>`;
    }).join('');

    let simHTML = '';
    if (!client) {
        simHTML = `<div class="dc-empty">אין תיקים להצגה. צור תיק כדי להריץ מבחני קיצון.</div>`;
    } else {
        const sim = _dcSimulate(client, _dcScenario);
        const sc = _DC_SCENARIOS[_dcScenario];
        if (!sim) {
            simHTML = `<div class="dc-empty">לתיק "${client.name}" אין נכסים מסוכנים לסימולציה.</div>`;
        } else {
            const ddPct = (sim.drawdownPct * 100);
            const ddCol = ddPct <= -40 ? '#ef4444' : ddPct <= -20 ? '#f59e0b' : '#10b981';
            const rows = sim.rows.filter(r => r.value > 0).map(r => {
                const ip = r.shock * 100;
                const c = ip < 0 ? '#ef4444' : ip > 0 ? '#10b981' : 'var(--text-muted)';
                const w = Math.round(Math.abs(r.shock) / 0.85 * 100);
                return `<div class="dc-cls-row">
                    <span class="dc-cls-name">${_DC_CLASS_HE[r.cls] || r.cls}<small>${Math.round(r.weight * 100)}% מהתיק</small></span>
                    <div class="dc-cls-track"><span class="dc-cls-fill" style="width:${Math.min(100, w)}%;background:${c}"></span></div>
                    <span class="dc-cls-val" style="color:${c}">${ip >= 0 ? '+' : ''}${ip.toFixed(0)}% · ${_dcMoney(r.impact, 'USD')}</span>
                </div>`;
            }).join('');
            simHTML = `
                <div class="dc-sim-metrics">
                    <div class="dc-metric"><span class="dc-metric-label">ירידה משוערת (Max Drawdown)</span><span class="dc-metric-value" style="color:${ddCol}">${ddPct.toFixed(1)}%</span></div>
                    <div class="dc-metric"><span class="dc-metric-label">השפעה כספית</span><span class="dc-metric-value" style="color:${ddCol}">${_dcMoney(sim.impactUsd, 'USD')} <small>(${_dcMoney(sim.impactUsd, 'ILS')})</small></span></div>
                    <div class="dc-metric"><span class="dc-metric-label">שווי תיק לאחר המשבר</span><span class="dc-metric-value">${_dcMoney(sim.valueAfterUsd, 'USD')}</span></div>
                    <div class="dc-metric"><span class="dc-metric-label">זינוק תנודתיות (VIX)</span><span class="dc-metric-value" style="color:#f59e0b">${sim.effVix} <small>שיא היסטורי ${sim.vixPeak}</small></span></div>
                </div>
                <div class="dc-sub">${sc.desc}</div>
                <div class="dc-cls-title">פירוק ההשפעה לפי סוג נכס</div>
                <div class="dc-cls-list">${rows}</div>
                <button class="dc-reduce-btn" id="dcReduceBtn" onclick="_dcShowReduceRisk()"><span class="dc-reduce-label">🛡️ דרכים להקטנת סיכון</span><span class="dc-reduce-caret">▾</span></button>
                <div class="dc-reduce-panel" id="dcReducePanel"></div>`;
        }
    }

    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">Decision Core — מנוע מבחני קיצון</h1>
            <button class="macro-back-btn" onclick="closeDecisionCorePage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <p class="dc-subtitle">סימולציית עמידות התיק במשברים היסטוריים + אינדיקטור לזיהוי משברים בזמן אמת (מבוסס סוכן)</p>
            <div class="dc-body">
                <div class="dc-card glass-card" id="dcProximityCard">${_dcProximityHTML()}</div>

                <div class="dc-card glass-card">
                    <div class="dc-card-title">סימולציית קריסה</div>
                    <div class="dc-controls">
                        ${_dcPortfolioPickerHTML(list, client)}
                        <div class="dc-scenarios">${scenarioCards}</div>
                    </div>
                    ${simHTML}
                </div>
            </div>
        </div>
    </div>`;
}
