// ========== REPORTS ENGINE — מנוע ניתוח דוחות כספיים (פונקציות טהורות) ==========
//
// Pure, DOM-free analysis over the normalized report from /api/reports:
//   • per-quarter derived metrics (margins, working capital, leverage, FCF, OCF/NI)
//     + YoY (same quarter last year) and QoQ deltas
//   • deterministic risk flags (red/warn) with Hebrew explanations
//   • a green "השתפרה" verdict (improvement vs. prior period — not vs. analyst
//     consensus, which is Premium-locked on the FMP key)
//   • a weighted 0–100 report score across 5 pillars
//   • a compact context object for the AI SWOT/strategy call
//
// Unit-verifiable with node `vm` like js/risk-models.js — no globals required.

(function (root) {
    'use strict';

    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const div = (a, b) => (isNum(a) && isNum(b) && b !== 0) ? a / b : null;
    const pct = (curr, prev) => (isNum(curr) && isNum(prev) && prev !== 0) ? (curr - prev) / Math.abs(prev) : null;
    const clamp01 = (x) => Math.max(0, Math.min(1, x));

    // ── Per-quarter derived metrics ──
    function quarterMetrics(q) {
        const grossMargin = div(q.grossProfit, q.revenue);
        const operatingMargin = div(q.operatingIncome, q.revenue);
        const netMargin = div(q.netIncome, q.revenue);
        const workingCapital = (isNum(q.currentAssets) && isNum(q.currentLiabilities)) ? q.currentAssets - q.currentLiabilities : null;
        const currentRatio = div(q.currentAssets, q.currentLiabilities);
        const debtToEquity = div(q.totalDebt, q.totalEquity);
        const fcf = (isNum(q.operatingCashFlow)) ? q.operatingCashFlow - Math.abs(isNum(q.capex) ? q.capex : 0) : null;
        const fcfMargin = div(fcf, q.revenue);
        const ocfToNI = div(q.operatingCashFlow, q.netIncome);
        // EBITDA = reported, else operating income + D&A. EBITDA margin off revenue.
        const ebitda = isNum(q.ebitda) ? q.ebitda
            : ((isNum(q.operatingIncome) && isNum(q.dna)) ? q.operatingIncome + q.dna : null);
        const ebitdaMargin = div(ebitda, q.revenue);
        // Net debt = total debt − cash (a negative value means net cash).
        const netDebt = isNum(q.totalDebt) ? q.totalDebt - (isNum(q.cash) ? q.cash : 0) : null;
        // Return on equity for the quarter (annualized ≈ ×4 at model level).
        const roe = div(q.netIncome, q.totalEquity);
        return { grossMargin, operatingMargin, netMargin, workingCapital, currentRatio, debtToEquity, fcf, fcfMargin, ocfToNI, ebitda, ebitdaMargin, netDebt, roe };
    }

    // Fill cells that a data source left blank but which are derivable from siblings,
    // so the table isn't peppered with "—" for values we can reconstruct.
    function fillDerived(q) {
        const out = { ...q };
        if (!isNum(out.eps) && isNum(out.netIncome) && isNum(out.sharesOut) && out.sharesOut > 0) out.eps = out.netIncome / out.sharesOut;
        if (!isNum(out.ebitda) && isNum(out.operatingIncome) && isNum(out.dna)) out.ebitda = out.operatingIncome + out.dna;
        if (!isNum(out.grossProfit) && isNum(out.revenue) && isNum(out.costOfRevenue)) out.grossProfit = out.revenue - out.costOfRevenue;
        return out;
    }

    // Build the full enriched model from a normalized report (quarters newest-first).
    function buildReport(report) {
        const quarters = (report && Array.isArray(report.quarters)) ? report.quarters.slice(0, 8).map(fillDerived) : [];
        const rows = quarters.map((q, i) => {
            const m = quarterMetrics(q);
            const yoy = quarters[i + 4]; // same quarter last year
            const qoq = quarters[i + 1];
            const ym = yoy ? quarterMetrics(yoy) : null;
            return {
                ...q,
                ...m,
                yoyRevenue: yoy ? pct(q.revenue, yoy.revenue) : null,
                yoyNetIncome: yoy ? pct(q.netIncome, yoy.netIncome) : null,
                yoyEps: yoy ? pct(q.eps, yoy.eps) : null,
                yoyGrossMargin: ym ? (isNum(m.grossMargin) && isNum(ym.grossMargin) ? m.grossMargin - ym.grossMargin : null) : null,
                qoqRevenue: qoq ? pct(q.revenue, qoq.revenue) : null,
                qoqNetIncome: qoq ? pct(q.netIncome, qoq.netIncome) : null,
                qoqEps: qoq ? pct(q.eps, qoq.eps) : null,
            };
        });

        const latest = rows[0] || null;
        // Trailing-twelve-month aggregates (sum of last 4 quarters) for valuation multiples.
        const ttm = rows.slice(0, 4);
        const sumTTM = (key) => ttm.reduce((s, r) => s + (isNum(r[key]) ? r[key] : 0), 0);
        const ttmNetIncome = sumTTM('netIncome');
        const ttmHasFull = ttm.length === 4 && ttm.every(r => isNum(r.netIncome));
        const ttmRevenue = sumTTM('revenue');
        const ttmFcf = sumTTM('fcf');
        const ttmEbitda = sumTTM('ebitda');
        const peTrailing = (ttmHasFull && isNum(report.marketCap)) ? div(report.marketCap, ttmNetIncome) : null;
        const pb = (latest && isNum(report.marketCap)) ? div(report.marketCap, latest.totalEquity) : null;
        const roeTTM = (ttmHasFull && latest) ? div(ttmNetIncome, latest.totalEquity) : null;
        const fcfYield = (ttmHasFull && isNum(report.marketCap)) ? div(ttmFcf, report.marketCap) : null;
        const evToEbitda = (isNum(report.marketCap) && latest && isNum(latest.netDebt) && ttm.length === 4 && ttmEbitda)
            ? div(report.marketCap + latest.netDebt, ttmEbitda) : null;

        const flags = computeFlags(rows);
        const beat = computeBeat(latest);
        const score = computeScore(rows, { peTrailing, pb, beat, flags });
        const valuation = { peTrailing, pb, roeTTM, fcfYield, evToEbitda, ttmNetIncome: ttmHasFull ? ttmNetIncome : null, ttmRevenue: ttmHasFull ? ttmRevenue : null };
        const keyPoints = computeKeyPoints(rows, { beat, valuation, currency: report.currency });
        const attentionNotes = computeAttentionNotes(rows);

        return {
            symbol: report.symbol,
            market: report.market,
            source: report.source,
            companyName: report.companyName,
            sector: report.sector,
            industry: report.industry,
            currency: report.currency,
            price: report.price,
            marketCap: report.marketCap,
            beta: report.beta,
            asOf: report.asOf,
            rows,
            latest,
            valuation,
            flags,
            beat,
            score,
            keyPoints,
            attentionNotes,
        };
    }

    // ── Attention notes — sharp deteriorations worth flagging in the table area.
    // Compares the latest quarter vs the prior quarter (QoQ) and the same quarter
    // last year (YoY). severity: 'high' (steep) | 'warn'. Deterministic, no API cost.
    function computeAttentionNotes(rows) {
        const a = rows[0], qoq = rows[1], yoy = rows[4];
        if (!a) return [];
        const notes = [];
        const pp = (x) => (x * 100).toFixed(1);
        // For each absolute metric vs a reference period: build the right Hebrew phrasing.
        const absDrop = (m, cur, prev, when) => {
            if (!isNum(cur) || !isNum(prev) || prev <= 0) return;
            if (cur < 0) { notes.push({ he: `${m.subject} ${m.neg} ${when}.`, severity: 'high' }); return; }
            const d = (cur - prev) / prev;
            if (d <= -0.10) notes.push({ he: `${m.subject} ${m.down} ב-${pp(-d)}% ${when}.`, severity: d <= -0.25 ? 'high' : 'warn' });
        };
        const QoQ = 'לעומת הרבעון הקודם', YoY = 'לעומת הרבעון המקביל אשתקד';
        [{ k: 'revenue', subject: 'ההכנסות', down: 'ירדו', neg: 'הפכו לשליליות' },
         { k: 'ebitda', subject: 'ה-EBITDA', down: 'ירד', neg: 'הפך לשלילי' },
         { k: 'operatingIncome', subject: 'הרווח התפעולי', down: 'ירד', neg: 'הפך להפסד תפעולי' },
         { k: 'netIncome', subject: 'הרווח הנקי', down: 'ירד', neg: 'הפך להפסד נקי' },
         { k: 'fcf', subject: 'התזרים החופשי (FCF)', down: 'ירד', neg: 'הפך לשלילי' }].forEach(m => {
            absDrop(m, a[m.k], qoq && qoq[m.k], QoQ);
            absDrop(m, a[m.k], yoy && yoy[m.k], YoY);
        });
        [{ k: 'grossMargin', he: 'שיעור הרווח הגולמי' }, { k: 'operatingMargin', he: 'שיעור הרווח התפעולי' },
         { k: 'ebitdaMargin', he: 'שיעור ה-EBITDA' }, { k: 'netMargin', he: 'שיעור הרווח הנקי' }].forEach(({ k, he }) => {
            const dq = (isNum(a[k]) && qoq && isNum(qoq[k])) ? a[k] - qoq[k] : null;
            const dy = (isNum(a[k]) && yoy && isNum(yoy[k])) ? a[k] - yoy[k] : null;
            if (isNum(dq) && dq <= -0.03) notes.push({ he: `${he} ירד בכ-${pp(-dq)} נק׳ אחוז ${QoQ}.`, severity: dq <= -0.06 ? 'high' : 'warn' });
            if (isNum(dy) && dy <= -0.03) notes.push({ he: `${he} ירד בכ-${pp(-dy)} נק׳ אחוז לעומת אשתקד.`, severity: dy <= -0.06 ? 'high' : 'warn' });
        });
        return notes;
    }

    // ── Key points — deterministic, plain-Hebrew highlights pulled from the numbers.
    // tone: 'pos' | 'neg' | 'neutral' (the view colors them). No API cost.
    function computeKeyPoints(rows, ctx) {
        const a = rows[0];
        if (!a) return [];
        const pts = [];
        const cur = ctx.currency === 'ILS' ? '₪' : (ctx.currency === 'USD' ? '$' : '');
        const money = (v) => {
            if (!isNum(v)) return '—';
            const abs = Math.abs(v), sign = v < 0 ? '-' : '';
            if (abs >= 1e9) return `${sign}${cur}${(abs / 1e9).toFixed(2)}B`;
            if (abs >= 1e6) return `${sign}${cur}${(abs / 1e6).toFixed(1)}M`;
            return `${sign}${cur}${abs.toFixed(0)}`;
        };
        const p1 = (x) => (x * 100).toFixed(1) + '%';
        const add = (he, tone) => pts.push({ he, tone: tone || 'neutral' });

        if (isNum(a.yoyRevenue))
            add(`ההכנסות ${a.yoyRevenue >= 0 ? 'צמחו' : 'ירדו'} ב-${p1(Math.abs(a.yoyRevenue))} מול הרבעון המקביל אשתקד.`, a.yoyRevenue >= 0 ? 'pos' : 'neg');
        if (isNum(a.yoyNetIncome))
            add(`הרווח הנקי ${a.yoyNetIncome >= 0 ? 'עלה' : 'ירד'} ב-${p1(Math.abs(a.yoyNetIncome))} מול אשתקד.`, a.yoyNetIncome >= 0 ? 'pos' : 'neg');
        if (isNum(a.netMargin))
            add(`שיעור הרווח הנקי עומד על ${p1(a.netMargin)}.`, a.netMargin >= 0.10 ? 'pos' : (a.netMargin < 0 ? 'neg' : 'neutral'));
        if (isNum(a.ebitdaMargin))
            add(`שיעור ה-EBITDA עומד על ${p1(a.ebitdaMargin)} (רווחיות תפעולית-תזרימית).`, a.ebitdaMargin >= 0.20 ? 'pos' : 'neutral');
        if (isNum(a.fcf))
            add(`תזרים מזומנים חופשי (FCF) ${a.fcf >= 0 ? 'חיובי' : 'שלילי'} של ${money(a.fcf)} ברבעון.`, a.fcf >= 0 ? 'pos' : 'neg');
        if (isNum(ctx.valuation.roeTTM))
            add(`תשואה על ההון (ROE, שנים-עשר חודשים) ${p1(ctx.valuation.roeTTM)}.`, ctx.valuation.roeTTM >= 0.15 ? 'pos' : (ctx.valuation.roeTTM < 0 ? 'neg' : 'neutral'));
        if (isNum(a.debtToEquity))
            add(`מינוף (חוב/הון) ${a.debtToEquity.toFixed(2)}${isNum(a.netDebt) ? ` · חוב נטו ${money(a.netDebt)}` : ''}.`, a.debtToEquity > 2 ? 'neg' : (a.debtToEquity <= 1 ? 'pos' : 'neutral'));
        if (isNum(a.currentRatio))
            add(`יחס שוטף ${a.currentRatio.toFixed(2)} — ${a.currentRatio >= 1.5 ? 'נזילות איתנה' : (a.currentRatio < 1 ? 'נזילות מתוחה' : 'נזילות סבירה')}.`, a.currentRatio >= 1.5 ? 'pos' : (a.currentRatio < 1 ? 'neg' : 'neutral'));
        if (isNum(ctx.valuation.peTrailing))
            add(`מכפיל רווח (P/E, 12ח') ${ctx.valuation.peTrailing.toFixed(1)}.`, 'neutral');
        if (ctx.beat && ctx.beat.label && ctx.beat.label !== 'אין נתונים')
            add(`מגמה: ${ctx.beat.label}.`, ctx.beat.improved ? 'pos' : 'neutral');
        return pts;
    }

    // ── Risk flags (deterministic). severity: 'high' (red) | 'warn' (amber) ──
    function computeFlags(rows) {
        const f = [];
        const a = rows[0], b = rows[1], c = rows[2];
        if (!a) return f;
        const push = (id, severity, he) => f.push({ id, severity, he });

        if (isNum(a.totalEquity) && a.totalEquity < 0)
            push('negEquity', 'high', 'הון עצמי שלילי — החברה ממונפת מעבר לנכסיה (סיכון סולבנטיות).');
        if (isNum(a.netIncome) && a.netIncome < 0)
            push('netLoss', 'high', 'הרבעון נסגר בהפסד נקי.');
        if (isNum(a.netIncome) && a.netIncome > 0 && isNum(a.operatingCashFlow) && a.operatingCashFlow < 0)
            push('earningsQuality', 'high', 'רווח חשבונאי חיובי אך תזרים תפעולי שלילי — איכות רווחים נמוכה (דגל אדום).');
        // Margin compression — two consecutive declines in gross or operating margin.
        if (b && c) {
            const decl = (x, y, z) => isNum(x) && isNum(y) && isNum(z) && x < y && y < z;
            if (decl(a.grossMargin, b.grossMargin, c.grossMargin))
                push('grossCompression', 'warn', 'הרווחיות הגולמית מתכווצת שני רבעונים ברציפות — לחץ על כוח התמחור.');
            else if (decl(a.operatingMargin, b.operatingMargin, c.operatingMargin))
                push('opCompression', 'warn', 'הרווחיות התפעולית מתכווצת שני רבעונים ברציפות.');
        }
        if (isNum(a.yoyRevenue) && a.yoyRevenue < 0)
            push('revDecline', 'high', `הכנסות בירידה של ${(a.yoyRevenue * 100).toFixed(1)}% מול הרבעון המקביל אשתקד.`);
        else if (isNum(a.yoyRevenue) && isNum(b?.yoyRevenue) && a.yoyRevenue < b.yoyRevenue && a.yoyRevenue < 0.05)
            push('growthDecel', 'warn', 'קצב צמיחת ההכנסות מאט — מומנטום עסקי נחלש.');
        if (isNum(a.yoyEps) && a.yoyEps < 0)
            push('epsDecline', 'warn', 'רווח למניה (EPS) נמוך מהרבעון המקביל אשתקד.');
        if (isNum(a.debtToEquity) && a.debtToEquity > 2)
            push('highLeverage', 'high', `מינוף גבוה — יחס חוב/הון של ${a.debtToEquity.toFixed(2)} (מעל 2).`);
        else if (isNum(a.debtToEquity) && isNum(b?.debtToEquity) && a.debtToEquity > 1 && a.debtToEquity > b.debtToEquity * 1.3)
            push('risingLeverage', 'warn', 'המינוף עולה במהירות מול הרבעון הקודם.');
        if (isNum(a.currentRatio) && a.currentRatio < 1)
            push('liquidity', 'high', `יחס שוטף מתחת ל-1 (${a.currentRatio.toFixed(2)}) — הון חוזר שלילי, סיכון נזילות.`);
        if (isNum(a.fcf) && a.fcf < 0)
            push('fcfNeg', 'warn', 'תזרים מזומנים חופשי (FCF) שלילי ברבעון האחרון.');
        if (isNum(a.operatingMargin) && a.operatingMargin > 0 && isNum(a.netMargin) && a.netMargin < a.operatingMargin * 0.4)
            push('netVsOp', 'warn', 'הרווח הנקי נמוך משמעותית מהתפעולי — נטל ריבית/מס או הוצאות חד-פעמיות.');
        return f;
    }

    // ── Green "השתפרה" verdict — improvement vs. prior period ──
    function computeBeat(latest) {
        if (!latest) return { improved: false, yoy: false, qoq: false, label: 'אין נתונים' };
        const up = (x) => isNum(x) && x > 0;
        const yoy = up(latest.yoyRevenue) && up(latest.yoyNetIncome) && (latest.yoyEps == null || up(latest.yoyEps));
        const qoq = up(latest.qoqRevenue) && up(latest.qoqNetIncome);
        const improved = yoy || qoq;
        let label = 'ללא שיפור מובהק';
        if (yoy && qoq) label = 'שיפור מול אשתקד וגם מול הרבעון הקודם';
        else if (yoy) label = 'שיפור מול הרבעון המקביל אשתקד';
        else if (qoq) label = 'שיפור מול הרבעון הקודם';
        return { improved, yoy, qoq, label };
    }

    // ── Weighted 0–100 score across 5 pillars. Missing pillars renormalize the weight. ──
    function computeScore(rows, ctx) {
        const a = rows[0];
        if (!a) return { value: null, verdict: 'אין נתונים', pillars: {} };
        const pillars = {};

        // Profitability (25) — margin levels.
        pillars.profitability = scorePillar([
            band(a.netMargin, 0, 0.20),
            band(a.operatingMargin, 0, 0.25),
            band(a.grossMargin, 0.10, 0.60),
        ]);
        // Growth (20) — revenue + EPS YoY, with acceleration bonus.
        pillars.growth = scorePillar([
            band(a.yoyRevenue, -0.05, 0.25),
            band(a.yoyEps, -0.10, 0.30),
        ]);
        // Financial health (25) — leverage + liquidity + solvency.
        pillars.health = scorePillar([
            (isNum(a.debtToEquity) ? clamp01(1 - a.debtToEquity / 2.5) : null),
            band(a.currentRatio, 1, 2.5),
            (isNum(a.totalEquity) ? (a.totalEquity > 0 ? 1 : 0) : null),
        ]);
        // Cash-flow quality (15) — OCF backing earnings + positive FCF.
        pillars.cash = scorePillar([
            band(a.ocfToNI, 0.6, 1.3),
            (isNum(a.fcf) ? (a.fcf > 0 ? 1 : 0.2) : null),
        ]);
        // Momentum / improvement (15).
        pillars.momentum = scorePillar([
            ctx.beat.yoy ? 1 : (ctx.beat.qoq ? 0.6 : 0.2),
            band(a.yoyGrossMargin, -0.03, 0.03),
        ]);

        const weights = { profitability: 25, growth: 20, health: 25, cash: 15, momentum: 15 };
        let acc = 0, wsum = 0;
        for (const k of Object.keys(weights)) {
            if (pillars[k] != null) { acc += pillars[k] * weights[k]; wsum += weights[k]; }
        }
        let value = wsum > 0 ? Math.round(acc / wsum * 100) : null;
        // Hard penalty for severe red flags so a single strong pillar can't mask insolvency risk.
        const highFlags = (ctx.flags || []).filter(x => x.severity === 'high').length;
        if (value != null && highFlags) value = Math.max(0, value - highFlags * 8);

        return { value, verdict: verdictFor(value), pillars };
    }

    // Linear band: <lo → 0, >hi → 1, linear between. Null-safe.
    function band(v, lo, hi) {
        if (!isNum(v) || hi === lo) return null;
        return clamp01((v - lo) / (hi - lo));
    }
    // Average the non-null sub-scores of a pillar; null if none available.
    function scorePillar(parts) {
        const vals = parts.filter(p => p != null);
        if (!vals.length) return null;
        return vals.reduce((s, x) => s + x, 0) / vals.length;
    }
    function verdictFor(v) {
        if (v == null) return 'אין נתונים';
        if (v >= 80) return 'מצוין';
        if (v >= 65) return 'טוב';
        if (v >= 50) return 'בינוני';
        if (v >= 35) return 'חלש';
        return 'מסוכן';
    }

    // ── Compact context for the AI SWOT/strategy prompt (small, numbers only) ──
    function aiContext(model) {
        const a = model.latest || {};
        const fmtP = (x) => isNum(x) ? (x * 100).toFixed(1) + '%' : 'n/a';
        return {
            company: model.companyName,
            symbol: model.symbol,
            sector: model.sector,
            score: model.score?.value,
            verdict: model.score?.verdict,
            grossMargin: fmtP(a.grossMargin),
            operatingMargin: fmtP(a.operatingMargin),
            ebitdaMargin: fmtP(a.ebitdaMargin),
            netMargin: fmtP(a.netMargin),
            roeTTM: fmtP(model.valuation?.roeTTM),
            revenueYoY: fmtP(a.yoyRevenue),
            epsYoY: fmtP(a.yoyEps),
            debtToEquity: isNum(a.debtToEquity) ? a.debtToEquity.toFixed(2) : 'n/a',
            currentRatio: isNum(a.currentRatio) ? a.currentRatio.toFixed(2) : 'n/a',
            peTrailing: isNum(model.valuation?.peTrailing) ? model.valuation.peTrailing.toFixed(1) : 'n/a',
            improved: model.beat?.label,
            flags: (model.flags || []).map(x => x.he),
        };
    }

    const API = { buildReport, quarterMetrics, computeFlags, computeBeat, computeScore, computeKeyPoints, computeAttentionNotes, aiContext };
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    if (typeof root !== 'undefined') {
        root.ReportsEngine = API;
        root.buildReportModel = buildReport;
    }
})(typeof window !== 'undefined' ? window : globalThis);
