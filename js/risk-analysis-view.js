// ========== CML / SML RISK ANALYSIS VIEW ==========
//
// Full-page analytical workspace driven entirely by risk-models.js. Renders:
//   1. Reference panel       — Rf, market return Rm, market σ, market Sharpe
//   2. Portfolio metrics     — β, E(R), σ, Sharpe, α(vs CML), auto-risk, CML side
//   3. CML chart             — portfolios on the (σ, E(R)) plane + Capital Market Line
//   4. SML chart             — assets on the (β, E(R)) plane + Security Market Line
//   5. Recommendations       — per-asset buy / avoid / neutral from Jensen's α
//   6. Correlation heatmap   — pairwise asset correlations
//
// Mirrors the show/hide page pattern used by the macro page for visual
// consistency with the rest of the Cyber-Noir dashboard.

const _riskCharts = {}; // chartKey -> Chart instance

function _destroyRiskCharts() {
    for (const k of Object.keys(_riskCharts)) {
        try { _riskCharts[k].destroy(); } catch { /* noop */ }
        delete _riskCharts[k];
    }
}

// ── Page open / close (mirrors toggleAlerts / closeMacroPage) ──

async function openRiskAnalysis() {
    const page = document.getElementById('riskmodelPage');
    if (!page) return;

    // Hide the dashboard chrome, same as the macro page does
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(c => {
        if (c.id !== 'riskmodelPage') c.style.display = 'none';
    });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'riskmodel' });

    // Loading state
    page.innerHTML = _riskPageShell(_riskLoadingHTML());

    try {
        const haveClients = typeof clients !== 'undefined' && clients && clients.length > 0;
        if (!haveClients) {
            _renderRiskPage(null);
            return;
        }
        const model = (window._lastRiskModel && window._lastRiskModel.portfolios)
            ? window._lastRiskModel
            : await buildRiskModel(clients);
        window._lastRiskModel = model;
        _renderRiskPage(model);
    } catch (e) {
        console.error('[RiskAnalysis] build failed:', e);
        _renderRiskPage(null, e.message);
    }
}

function closeRiskAnalysis() {
    const page = document.getElementById('riskmodelPage');
    if (!page) return;
    _destroyRiskCharts();
    page.classList.remove('active');
    page.innerHTML = '';
    const header = document.querySelector('.header');
    if (header) header.style.display = '';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(c => { c.style.display = ''; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = '';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
}

async function refreshRiskAnalysis() {
    const page = document.getElementById('riskmodelPage');
    if (!page) return;
    page.innerHTML = _riskPageShell(_riskLoadingHTML());
    _destroyRiskCharts();
    try {
        const model = await buildRiskModel(clients, { force: true });
        window._lastRiskModel = model;
        _renderRiskPage(model);
        // Propagate refreshed auto-risk to the dashboard too
        if (typeof applyModelRiskToClients === 'function') applyModelRiskToClients({ force: false });
    } catch (e) {
        _renderRiskPage(null, e.message);
    }
}

// ── Shell / chrome ──

function _riskPageShell(inner) {
    return `
        <div class="macro-page-header">
            <h1 class="macro-main-title">ניתוח סיכון — CML / SML</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="macro-back-btn" onclick="refreshRiskAnalysis()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    רענן ניתוח
                </button>
                <button class="macro-back-btn" onclick="closeRiskAnalysis()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">${inner}</div>
    `;
}

function _riskLoadingHTML() {
    return `<div class="risk-loading">
        <div class="spinner"></div>
        <div class="risk-loading-text">בונה מודל CML/SML — מושך היסטוריית מחירים ומחשב β, σ וקורלציות…</div>
    </div>`;
}

// ── Master render ──

function _renderRiskPage(model, errMsg) {
    const page = document.getElementById('riskmodelPage');
    if (!page) return;

    if (!model) {
        const msg = errMsg
            ? `שגיאה בבניית המודל: ${_riskEsc(errMsg)}`
            : 'אין תיקים להצגה. הוסף תיק עם נכסים סחירים (מניות/קרנות) כדי לקבל ניתוח CML/SML.';
        page.innerHTML = _riskPageShell(`<div class="risk-empty">${msg}</div>`);
        return;
    }

    const inner = `
        ${_renderRefPanel(model)}
        ${_renderPortfolioTable(model)}
        <div class="risk-charts-grid">
            <div class="risk-chart-card glass-card">
                <div class="risk-chart-head">
                    <h3>קו שוק ההון (CML)</h3>
                    <span class="risk-chart-sub">תשואה צפויה מול סיכון כולל (σ) — לכל תיק</span>
                </div>
                <div class="risk-chart-canvas-wrap"><canvas id="cmlChart"></canvas></div>
                <p class="risk-chart-legend"><b>כל נקודה בגרף היא תיק</b>, צבועה לפי <b>ציון המודל</b> — בדיוק כפי שמופיע בתג "מודל" של אותו תיק בדאשבורד: <b style="color:#22c55e">ירוק = עומד במודל (≥75)</b>, <b style="color:#eab308">צהוב = עמידה חלקית (50–74)</b>, <b style="color:#ef4444">אדום = לא עומד (&lt;50)</b>. ציון המודל משקלל יעילות CML (40%), בחירת נכסים SML (40%) ופיזור (20%). העקומה הירוקה = החזית היעילה (Markowitz); הקו הכחול = ה-CML, משיק לחזית ב<b>כוכב הזהב</b> = <b>התיק האופטימלי</b>.</p>
            </div>
            <div class="risk-chart-card glass-card">
                <div class="risk-chart-head">
                    <h3>קו שוק נייר הערך (SML)</h3>
                    <span class="risk-chart-sub">תשואה צפויה מול סיכון שיטתי (β) — לכל נכס</span>
                </div>
                <div class="risk-chart-canvas-wrap"><canvas id="smlChart"></canvas></div>
                <p class="risk-chart-legend">מעל הקו = מתומחר בחסר (מומלץ) · מתחת = מתומחר ביתר (לא מומלץ).</p>
            </div>
        </div>
        ${_renderAdvisorySection(model)}
        ${_renderRecommendations(model)}
    `;
    page.innerHTML = _riskPageShell(inner);

    // Charts must be drawn after the canvases are in the DOM
    requestAnimationFrame(() => {
        _drawCMLChart(model);
        _drawSMLChart(model);
    });
}

// ── 1. Reference panel ──

function _renderRefPanel(model) {
    const cell = (label, val, sub) => `
        <div class="risk-ref-cell">
            <span class="risk-ref-label">${label}</span>
            <span class="risk-ref-val">${val}</span>
            ${sub ? `<span class="risk-ref-sub">${sub}</span>` : ''}
        </div>`;
    const cov = model.coverage ? `${model.coverage.resolved}/${model.coverage.requested}` : '—';
    return `
        <div class="risk-ref-panel glass-card">
            ${cell('ריבית חסרת-סיכון (Rf)', rmFmtPct(model.rf, 2), 'אג"ח ארה"ב 3 ח׳')}
            ${cell('תשואת שוק (Rm)', rmFmtPct(model.rm, 1), model.marketLabel)}
            ${cell('סיכון שוק (σ)', rmFmtPct(model.marketVol, 1), 'סטיית תקן שנתית')}
            ${cell('Sharpe שוק', rmFmtNum(model.marketSharpe, 2), 'שיפוע ה-CML')}
            ${cell('כיסוי נתונים', cov, 'נכסים עם היסטוריה')}
        </div>`;
}

// ── 2. Portfolio metrics table ──

function _renderPortfolioTable(model) {
    const rows = (model.portfolios || []).filter(p => p.totalValue > 0);
    if (rows.length === 0) return '';
    const body = rows.map(p => {
        const riskCls = p.risk === 'high' ? 'high' : p.risk === 'medium' ? 'medium' : 'low';
        const cml = p.aboveCML
            ? '<span class="risk-pill ok">מעל ה-CML</span>'
            : '<span class="risk-pill bad">מתחת ל-CML</span>';
        return `
            <tr>
                <td class="risk-td-name">${_riskEsc(p.name)}</td>
                <td>${rmFmtNum(p.beta, 2)}</td>
                <td class="${p.expReturn >= 0 ? 'pos' : 'neg'}">${rmFmtPct(p.expReturn, 1)}</td>
                <td>${rmFmtPct(p.vol, 1)}</td>
                <td class="${p.sharpe >= 0 ? 'pos' : 'neg'}">${rmFmtNum(p.sharpe, 2)}</td>
                <td class="${p.alpha >= 0 ? 'pos' : 'neg'}">${rmFmtPct(p.alpha, 1)}</td>
                <td><span class="risk-badge ${riskCls}">${p.riskLabel} · ${p.riskScore}</span></td>
                <td>${cml}</td>
            </tr>`;
    }).join('');
    return `
        <div class="risk-table-card glass-card">
            <div class="risk-chart-head"><h3>סיכון לפי תיק</h3>
                <span class="risk-chart-sub">סיווג אוטומטי לפי β ו-σ ביחס לשוק</span></div>
            <div class="risk-table-scroll">
            <table class="risk-table">
                <thead><tr>
                    <th>תיק</th><th>β</th><th>תשואה צפויה</th><th>σ (סיכון)</th>
                    <th>Sharpe</th><th>α מול CML</th><th>רמת סיכון</th><th>מיקום</th>
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
            </div>
        </div>`;
}

// ── 3. CML chart ──

function _drawCMLChart(model) {
    const canvas = document.getElementById('cmlChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const rfPct = model.rf * 100;
    const pts = (model.portfolios || []).filter(p => p.hasData && p.totalValue > 0)
        // eff = the SAME model-compliance band the dashboard "מודל" chip uses
        // (complianceScore: ≥75 green, ≥50 yellow, <50 red — see render.js). So a dot's
        // colour here is identical to that portfolio's badge on the dashboard.
        .map(p => {
            const mc = p.complianceScore;
            return {
                x: p.vol * 100, y: p.expReturn * 100, name: p.name, risk: p.riskLabel, mc,
                eff: mc == null ? 'on' : (mc >= 75 ? 'above' : mc >= 50 ? 'on' : 'below'),
            };
        });
    const marketPt = { x: model.marketVol * 100, y: model.rm * 100, name: model.marketLabel };

    // Efficient frontier curve + tangency (optimal risky portfolio)
    const fr = model.frontier;
    const tang = (fr && fr.tangency) ? { x: fr.tangency.x * 100, y: fr.tangency.y * 100, name: 'תיק אופטימלי (משיק)' } : null;

    // The CML is tangent to the frontier at the tangency portfolio (fallback: market)
    const anchor = tang || marketPt;
    const slope = anchor.x > 0 ? (anchor.y - rfPct) / anchor.x : 0;
    // Sane axis ceilings from the frontier (keeps the chart textbook-clean even when
    // a few estimates are extreme); fall back to data-derived bounds.
    const bx = (fr && fr.bounds) ? fr.bounds.sigMax * 100 : 0;
    const by = (fr && fr.bounds) ? fr.bounds.retMax * 100 : 0;
    const byMin = (fr && fr.bounds) ? fr.bounds.retMin * 100 : Math.min(0, rfPct - 2);
    // Axes must contain EVERY portfolio dot (not just the frontier) so no portfolio
    // is clipped off the edge.
    const portMaxX = pts.length ? Math.max(...pts.map(p => p.x)) : 0;
    const portMaxY = pts.length ? Math.max(...pts.map(p => p.y)) : 0;
    const portMinY = pts.length ? Math.min(...pts.map(p => p.y)) : rfPct;
    const maxX = Math.max(bx, portMaxX * 1.1, marketPt.x * 1.2, 6);
    const yMax = Math.max(by, portMaxY * 1.12, marketPt.y * 1.2, 10);
    const yMin = Math.min(byMin, portMinY - 5);
    const cmlLine = [{ x: 0, y: rfPct }, { x: maxX, y: rfPct + slope * maxX }];

    const datasets = [];
    for (const ds of _frontierDatasets(model.frontier)) datasets.push(ds);
    datasets.push({
        type: 'line', label: 'CML (קו אופטימלי)', data: cmlLine, borderColor: '#38bdf8', borderWidth: 2.5,
        borderDash: [7, 4], pointRadius: 0, fill: false, tension: 0, order: 2,
    });
    // Portfolios, colored by the SAME model-compliance band as the dashboard "מודל" chip
    // (not by raw CML position — that mismatched the dashboard score the user reads).
    // Split into up to three labelled groups so the legend itself tells the user every
    // dot is a תיק, and the colour equals its dashboard model badge.
    const EFF_STYLE = {
        above: { color: '#22c55e', label: 'תיק עומד במודל (ציון ≥75)' },
        on: { color: '#eab308', label: 'עמידה חלקית (50–74)' },
        below: { color: '#ef4444', label: 'לא עומד במודל (<50)' },
    };
    for (const key of ['above', 'on', 'below']) {
        const grp = pts.filter(p => p.eff === key);
        if (!grp.length) continue;
        datasets.push({
            type: 'scatter', label: EFF_STYLE[key].label, data: grp, pointRadius: 7, pointHoverRadius: 9,
            backgroundColor: EFF_STYLE[key].color, borderColor: '#0b0b0f', borderWidth: 1.5, order: 1,
        });
    }
    datasets.push({
        type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot',
        pointRadius: 9, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5, order: 1,
    });
    if (tang) {
        datasets.push({
            type: 'scatter', label: 'תיק אופטימלי', data: [tang], pointStyle: 'star',
            pointRadius: 13, pointHoverRadius: 15, backgroundColor: '#facc15', borderColor: '#fff', borderWidth: 1.5, order: 0,
        });
    }

    const opts = _scatterOpts('סיכון כולל σ (%)', 'תשואה צפויה (%)');
    opts.scales.x.min = 0;
    opts.scales.x.max = maxX;
    opts.scales.y.min = yMin;
    opts.scales.y.max = yMax;

    _riskCharts.cml = new Chart(canvas.getContext('2d'), { data: { datasets }, options: opts });
}

// ── 4. SML chart ──

function _drawSMLChart(model) {
    const canvas = document.getElementById('smlChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const rfPct = model.rf * 100;
    const assets = Object.values(model.assets || {}).filter(a => a.hasData);
    // Clamp β to a sane display window so one glitchy outlier can't squish the axis
    const pts = assets.map(a => ({
        x: Math.max(-0.5, Math.min(3.0, a.beta)), y: a.expReturn * 100, name: a.ticker, rec: a.recommendation
    }));
    const marketPt = { x: 1, y: model.rm * 100, name: model.marketLabel };

    const betas = pts.map(p => p.x);
    // Axis is wider than the data so EVERY asset (incl. edge ones) is fully visible.
    const axisMin = Math.min(0, ...betas) - 0.25;
    const axisMax = Math.min(3.2, Math.max(1.6, ...betas)) + 0.25;
    const smlAt = (b) => rfPct + b * (model.rm * 100 - rfPct);
    const smlLine = [{ x: axisMin, y: smlAt(axisMin) }, { x: axisMax, y: smlAt(axisMax) }];

    // Return-axis window with margin so no asset point is clipped (zoom out)
    const rets = pts.map(p => p.y).concat([model.rm * 100, rfPct, smlAt(axisMax)]);
    const yLo = Math.min(...rets), yHi = Math.max(...rets);
    const yRange = (yHi - yLo) || 50;
    const yMax = Math.min(190, yHi + yRange * 0.14 + 8);
    const yMin = Math.max(-130, yLo - yRange * 0.14 - 8);

    const ptColors = pts.map(p => rmRecColor(p.rec));

    const opts = _scatterOpts('β (סיכון שיטתי)', 'תשואה צפויה (%)');
    opts.scales.x.min = axisMin;
    opts.scales.x.max = axisMax;
    opts.scales.y.min = yMin;
    opts.scales.y.max = yMax;

    _riskCharts.sml = new Chart(canvas.getContext('2d'), {
        data: {
            datasets: [
                { type: 'line', label: 'SML', data: smlLine, borderColor: '#38bdf8', borderWidth: 2.5,
                  borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0 },
                { type: 'scatter', label: 'נכסים', data: pts, pointRadius: 6, pointHoverRadius: 8,
                  backgroundColor: ptColors, borderColor: '#0b0b0f', borderWidth: 1 },
                { type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot',
                  pointRadius: 9, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5 },
            ]
        },
        options: opts
    });
}

// Splits the Markowitz frontier into the EFFICIENT branch (GMV upward — the
// optimal region, drawn bright/thick) and the INEFFICIENT branch (below GMV —
// dim/dashed). Returns ready-to-use Chart.js datasets (values already ×100).
function _frontierDatasets(fr) {
    if (!fr || !fr.points || fr.points.length < 5) return [];
    const pts = fr.points.map(p => ({ x: p.x * 100, y: p.y * 100 }));
    const gmvY = fr.gmv ? fr.gmv.y * 100 : null;
    if (gmvY == null) {
        return [{ type: 'line', label: 'חזית יעילה', data: pts, borderColor: '#22ff88', borderWidth: 3, pointRadius: 0, fill: false, tension: 0.4, order: 5 }];
    }
    const lower = pts.filter(p => p.y <= gmvY + 1e-6);
    const upper = pts.filter(p => p.y >= gmvY - 1e-6);
    const out = [];
    if (lower.length > 1) out.push({
        type: 'line', label: 'חזית — לא יעיל', data: lower,
        borderColor: 'rgba(148,163,184,0.45)', borderWidth: 2, borderDash: [4, 3],
        pointRadius: 0, fill: false, tension: 0.4, order: 6,
    });
    if (upper.length > 1) out.push({
        type: 'line', label: 'אזור אופטימלי (חזית יעילה)', data: upper,
        borderColor: '#22ff88', borderWidth: 4, pointRadius: 0, fill: false, tension: 0.4,
        borderCapStyle: 'round', order: 5,
    });
    return out;
}

// Projects a portfolio onto the EFFICIENT frontier at its expected return:
// returns the {x:σ, y:return} point on the green region for that return level
// (clamped to the efficient range). Lets the portfolio dot slide along the curve.
function _projectOntoEfficient(fr, retPct) {
    if (!fr || !fr.points || fr.points.length < 3) return null;
    const gmvY = fr.gmv ? fr.gmv.y * 100 : -Infinity;
    const eff = fr.points.map(p => ({ x: p.x * 100, y: p.y * 100 }))
        .filter(p => p.y >= gmvY - 1e-6)
        .sort((a, b) => a.y - b.y);
    if (eff.length < 2) return null;
    const r = Math.max(eff[0].y, Math.min(eff[eff.length - 1].y, retPct));
    for (let i = 1; i < eff.length; i++) {
        if (eff[i].y >= r) {
            const a = eff[i - 1], b = eff[i];
            const t = (b.y - a.y) ? (r - a.y) / (b.y - a.y) : 0;
            return { x: a.x + t * (b.x - a.x), y: r };
        }
    }
    return eff[eff.length - 1];
}

// Day-mode aware chart inks: light charts get BLACK numbers/labels, night keeps
// the existing light ink. Charts are re-rendered on theme toggle.
function _chartDay() {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('day-mode');
}

// Forces the legend to reserve at least TWO rows of height. CML's legend (6 items)
// naturally wraps to 2 rows while SML's (≤5) fits in 1 — which left the two chart
// panels' plot areas (and their points) at different heights. Pinning a minimum
// legend height on BOTH makes them align, so the SML icons sit at the CML height.
const _minLegendHeightPlugin = {
    id: 'minLegendHeight',
    beforeInit(chart) {
        const legend = chart.legend;
        if (!legend || legend.__pinned) return;
        legend.__pinned = true;
        const origFit = legend.fit;
        legend.fit = function () {
            origFit.call(this);
            this.height = Math.max(this.height, 54); // ≈ two legend rows
        };
    }
};

function _scatterOpts(xLabel, yLabel) {
    const day = _chartDay();
    const tick = day ? '#0f172a' : '#64748b';
    const axisTitle = day ? '#334155' : '#94a3b8';
    const grid = day ? 'rgba(15,23,42,0.1)' : 'rgba(148,163,184,0.12)';
    const legend = day ? '#0f172a' : '#cbd5e1';
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: legend, font: { family: 'Assistant' }, usePointStyle: true } },
            tooltip: {
                callbacks: {
                    label: (ctx) => {
                        const d = ctx.raw || {};
                        const name = d.name != null ? d.name : ctx.dataset.label;
                        const x = typeof d.x === 'number' ? d.x.toFixed(2) : d.x;
                        const y = typeof d.y === 'number' ? d.y.toFixed(1) : d.y;
                        return `${name}:  ${x} , ${y}%`;
                    }
                }
            }
        },
        scales: {
            // type:'linear' is ESSENTIAL — without it, a chart that mixes a 'line'
            // dataset (the SML/CML/frontier) with 'scatter' points defaults the
            // x-axis to 'category', which drops every point onto index 0 and renders
            // the whole thing as a meaningless vertical line. Forcing linear axes is
            // what makes the points spread by their real β / σ values.
            x: { type: 'linear', position: 'bottom', bounds: 'data', offset: false,
                 title: { display: true, text: xLabel, color: axisTitle },
                 ticks: { color: tick }, grid: { color: grid } },
            y: { type: 'linear',
                 title: { display: true, text: yLabel, color: axisTitle },
                 ticks: { color: tick }, grid: { color: grid } }
        }
    };
}

// ── 4b. Per-portfolio CML/SML advisory ──

function _renderAdvisorySection(model) {
    const rows = (model.portfolios || []).filter(p => p.totalValue > 0);
    if (rows.length === 0) return '';
    const clientsList = (typeof clients !== 'undefined') ? clients : [];

    const cards = rows.map(p => {
        const client = clientsList.find(c => c.id === p.id);
        if (!client) return '';
        let adv = null;
        try { adv = buildPortfolioAdvisory(client, model); } catch (e) { /* skip */ }
        const body = (typeof renderAdvisoryHTML === 'function') ? renderAdvisoryHTML(adv, { clientId: p.id }) : '';
        // Collapsed by default; native <details> expands downward in place on click and
        // collapses on a second click — no pop-up window.
        return `
            <details class="adv-portfolio glass-card">
                <summary class="adv-portfolio-head">
                    <span class="adv-portfolio-chevron" aria-hidden="true">▾</span>
                    <span class="adv-portfolio-name">${_riskEsc(p.name)}</span>
                    <span class="risk-badge ${p.risk}">${p.riskLabel} · ${p.riskScore}</span>
                </summary>
                <div class="adv-portfolio-body">${body}</div>
            </details>`;
    }).join('');

    return `
        <div class="risk-section-head">
            <h3>סקירה והמלצות לכל תיק</h3>
            <span class="risk-chart-sub">לחץ על תיק כדי לפתוח את הפרטים המלאים (לחיצה נוספת תסגור)</span>
        </div>
        <div class="adv-accordion">${cards}</div>`;
}

// ── 5. Recommendations table ──

// For an asset, score EVERY portfolio it could be added to:
// fit = α − 0.4·max(0, avg correlation to that portfolio's current holdings).
// Portfolios already holding the asset are skipped. Returns a sorted (best-first)
// array of { id, name, fit, avgCorr } — used by the table cell and the fit popup.
function _portfolioFitsFor(asset, model) {
    if (!asset || !asset.hasData || asset.alpha == null || asset.recommendation === 'avoid') return [];
    const clientsList = (typeof clients !== 'undefined') ? clients : [];
    const corr = model.correlation;
    const idx = {}; (corr?.tickers || []).forEach((t, i) => { idx[t] = i; });
    const ai = idx[asset.ticker];
    const fits = [];
    for (const p of (model.portfolios || [])) {
        if (!p.hasData || !(p.totalValue > 0)) continue;
        const client = clientsList.find(c => c.id === p.id);
        if (!client) continue;
        const held = (client.holdings || []).map(h => h.ticker).filter(Boolean);
        if (held.includes(asset.ticker)) continue;       // already held — not an addition
        let avgCorr = null;
        if (ai != null && held.length) {
            let s = 0, k = 0;
            for (const t of held) {
                const hi = idx[t];
                if (hi != null && hi !== ai) { s += corr.matrix[ai][hi]; k++; }
            }
            if (k) avgCorr = s / k;
        }
        const corrForFit = (avgCorr == null) ? 0.4 : avgCorr; // conservative default
        fits.push({ id: p.id, name: p.name, avgCorr, fit: asset.alpha - 0.4 * Math.max(0, corrForFit) });
    }
    fits.sort((a, b) => b.fit - a.fit);
    return fits;
}

// Small popup listing every portfolio the asset fits, best first, each with a very
// short WHY (α + correlation to that portfolio) and an open-portfolio action.
function openAssetFitPopup(ticker) {
    const model = window._lastRiskModel;
    const asset = model && model.assets ? model.assets[ticker] : null;
    if (!asset) return;
    const fits = _portfolioFitsFor(asset, model);

    let ov = document.getElementById('assetFitOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'assetFitOverlay';
        ov.className = 'reco-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) closeAssetFitPopup(); });
        document.body.appendChild(ov);
    }

    const reason = (f) => {
        const corrTxt = f.avgCorr == null ? '' :
            f.avgCorr <= 0.25 ? `קורלציה נמוכה (ρ̄ ${f.avgCorr.toFixed(2)}) — מוסיף פיזור אמיתי`
            : f.avgCorr <= 0.5 ? `קורלציה מתונה (ρ̄ ${f.avgCorr.toFixed(2)}) — משלים את ההרכב`
            : `קורלציה גבוהה (ρ̄ ${f.avgCorr.toFixed(2)}) — חופף להחזקות`;
        return `α ${rmFmtPct(asset.alpha, 1)} מעל ה-SML${corrTxt ? ' · ' + corrTxt : ''}`;
    };
    const rows = fits.length ? fits.map((f, i) => `
        <div class="fit-row${i === 0 ? ' fit-best' : ''}">
            <div class="fit-row-main">
                <span class="fit-name">${i === 0 ? '★ ' : ''}${_riskEsc(f.name)}</span>
                <span class="fit-why">${reason(f)}</span>
            </div>
            <button class="rec-fit-btn" onclick="closeAssetFitPopup(); openModal(${f.id})">פתח תיק</button>
        </div>`).join('')
        : '<div class="adv-empty">כל התיקים כבר מחזיקים את הנכס, או שאין תיקים מתאימים.</div>';

    ov.innerHTML = `<div class="reco-box fit-box" dir="rtl">
        <div class="reco-head">
            <div><h3>התאמת ${_riskEsc(ticker)} לתיקים</h3><span class="reco-sub">מדורג לפי תרומה: אלפא גבוה + קורלציה נמוכה להחזקות הקיימות</span></div>
            <button class="reco-close" onclick="closeAssetFitPopup()">✕</button>
        </div>
        ${rows}
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    try { history.pushState({ popup: 'fit' }, '', location.href); } catch (e) { /* ignore */ }
}

function closeAssetFitPopup() {
    const ov = document.getElementById('assetFitOverlay');
    if (ov) ov.classList.remove('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}

function _renderRecommendations(model) {
    const assets = Object.values(model.assets || {}).filter(a => a.hasData)
        .sort((a, b) => (b.alpha || 0) - (a.alpha || 0));
    if (assets.length === 0) return '';
    const body = assets.map(a => {
        const fits = _portfolioFitsFor(a, model);
        const fitCell = fits.length
            ? `<button class="rec-fit-btn" onclick="event.stopPropagation(); openAssetFitPopup('${_riskEsc(a.ticker)}')" title="לאילו תיקים הנכס מתאים — ולמה">${_riskEsc(fits[0].name)}${fits.length > 1 ? ` <span class="fit-more">+${fits.length - 1}</span>` : ''}</button>`
            : '<span class="adv-dim">—</span>';
        return `
        <tr>
            <td class="risk-td-name">${_riskEsc(a.ticker)}</td>
            <td class="risk-td-sector">${_riskEsc(a.sector || '')}</td>
            <td>${rmFmtNum(a.beta, 2)}</td>
            <td class="${a.expReturn >= 0 ? 'pos' : 'neg'}">${rmFmtPct(a.expReturn, 1)}</td>
            <td>${rmFmtPct(a.requiredReturn, 1)}</td>
            <td class="${a.alpha >= 0 ? 'pos' : 'neg'}">${rmFmtPct(a.alpha, 1)}</td>
            <td><span class="risk-rec" style="--rec:${rmRecColor(a.recommendation)}">${rmRecLabel(a.recommendation)}</span></td>
            <td>${fitCell}</td>
        </tr>`;
    }).join('');
    // Collapsible <details>: click the header to fold/unfold (collapsed by default)
    return `
        <details class="risk-table-card glass-card recs-details">
            <summary class="risk-chart-head recs-summary">
                <span class="adv-portfolio-chevron" aria-hidden="true">▾</span>
                <span class="recs-summary-txt"><h3>המלצות נכסים</h3>
                <span class="risk-chart-sub">לפי אלפא של ג'נסן — לחץ על הכותרת לקיפול/פתיחה · "מתאים לתיק" = התיק שבו ההוספה תורמת הכי הרבה (α גבוה + קורלציה נמוכה)</span></span>
            </summary>
            <div class="risk-table-scroll">
            <table class="risk-table">
                <thead><tr>
                    <th>נכס</th><th>סקטור</th><th>β</th><th>תשואה צפויה</th>
                    <th>תשואה נדרשת</th><th>α</th><th>המלצה</th><th>מתאים לתיק</th>
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
            </div>
        </details>`;
}

// ── 6. Correlation heatmap ──

function _corrColor(rho) {
    // Diverging scale: −1 blue → 0 slate → +1 red
    if (rho == null || !isFinite(rho)) return 'rgba(100,116,139,0.2)';
    const t = Math.max(-1, Math.min(1, rho));
    if (t >= 0) {
        const a = 0.12 + 0.72 * t;
        return `rgba(239,68,68,${a.toFixed(2)})`;      // positive → red (move together)
    } else {
        const a = 0.12 + 0.72 * (-t);
        return `rgba(56,189,248,${a.toFixed(2)})`;     // negative → cyan (diversifying)
    }
}

function _renderCorrelationHeatmap(model) {
    const c = model.correlation;
    if (!c || !c.tickers || c.tickers.length < 2) return '';
    const tickers = c.tickers;
    const head = `<th class="risk-corr-corner"></th>` +
        tickers.map(t => `<th class="risk-corr-h">${_riskEsc(t)}</th>`).join('');
    const rows = tickers.map((t, i) => {
        const cells = tickers.map((_, j) => {
            const v = c.matrix[i][j];
            const txt = (v == null || !isFinite(v)) ? '—' : v.toFixed(2);
            return `<td class="risk-corr-cell" style="background:${_corrColor(v)}" title="${_riskEsc(tickers[i])} ↔ ${_riskEsc(tickers[j])}: ${txt}">${txt}</td>`;
        }).join('');
        return `<tr><th class="risk-corr-row">${_riskEsc(t)}</th>${cells}</tr>`;
    }).join('');
    return `
        <div class="risk-table-card glass-card">
            <div class="risk-chart-head"><h3>מטריצת קורלציות</h3>
                <span class="risk-chart-sub">אדום = נעים יחד (סיכון ריכוז) · תכלת = מגוון (פיזור סיכון)</span></div>
            <div class="risk-corr-scroll">
                <table class="risk-corr-table">
                    <thead><tr>${head}</tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

// ── util ──
function _riskEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ════════ PER-PORTFOLIO CML/SML (client modal tab) ════════
const _modalRiskCharts = {};

async function _renderModalRiskCharts(clientId) {
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client) return;
    const advBox = document.getElementById('modalCmlSmlAdvisory');

    // Always (re)build — buildRiskModel is cached by a holdings signature, so this is
    // instant when nothing changed, but rebuilds (and moves the dot) after any
    // buy/sell. This is what makes holdings changes reflect directly on the curve.
    let model = null;
    try { model = await buildRiskModel(clients); } catch (e) { model = window._lastRiskModel; }
    if (!model) {
        if (advBox) advBox.innerHTML = '<div class="adv-empty">לא ניתן לבנות ניתוח כרגע — נסה לרענן.</div>';
        return;
    }
    window._lastRiskModel = model;

    for (const k of Object.keys(_modalRiskCharts)) {
        try { _modalRiskCharts[k].destroy(); } catch (e) { /* noop */ }
        delete _modalRiskCharts[k];
    }
    requestAnimationFrame(() => {
        _drawModalCML(model, client);
        _drawModalSML(model, client);
    });

    if (advBox && typeof buildPortfolioAdvisory === 'function' && typeof renderAdvisoryHTML === 'function') {
        try {
            const adv = buildPortfolioAdvisory(client, model);
            // The candidate grid is reachable via the "המלצות מניות לאיזון התיק" button
            // above — don't duplicate it inline in this tab.
            advBox.innerHTML = renderAdvisoryHTML(adv, { clientId, noCandidates: true });
        } catch (e) {
            advBox.innerHTML = '<div class="adv-empty">לא ניתן לבנות ניתוח כרגע.</div>';
        }
    }
}

function _drawModalCML(model, client) {
    const canvas = document.getElementById('modal-cml-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const rfPct = model.rf * 100;
    const fr = model.frontier;
    const tang = (fr && fr.tangency) ? { x: fr.tangency.x * 100, y: fr.tangency.y * 100, name: 'תיק אופטימלי' } : null;
    const marketPt = { x: model.marketVol * 100, y: model.rm * 100, name: model.marketLabel };
    const p = model.portfolios.find(x => x.id === client.id);

    // Plot THE PORTFOLIO at its TRUE position (σ, expected return). If it's efficient
    // it lands on/above the CML line near the frontier; if not, it sits below/right —
    // which matches the verdict (no contradiction) and moves directly with holdings.
    const portPt = (p && p.hasData) ? { x: p.vol * 100, y: p.expReturn * 100, name: 'התיק שלך' } : null;

    const anchor = tang || marketPt;
    const slope = anchor.x > 0 ? (anchor.y - rfPct) / anchor.x : 0;
    // Axes from the global frontier, but always wide/tall enough to show the
    // portfolio dot at its true position.
    const bx = (fr && fr.bounds) ? fr.bounds.sigMax * 100 : Math.max(marketPt.x, 20) * 1.2;
    const by = (fr && fr.bounds) ? fr.bounds.retMax * 100 : null;
    const byMin = (fr && fr.bounds) ? fr.bounds.retMin * 100 : Math.min(0, rfPct - 2);
    const maxX = Math.max(bx, portPt ? portPt.x * 1.12 : 0, marketPt.x * 1.2);
    const yTop = Math.max(by || 0, portPt ? portPt.y * 1.12 : 0, marketPt.y * 1.2);
    const cmlLine = [{ x: 0, y: rfPct }, { x: maxX, y: rfPct + slope * maxX }];

    const datasets = [];
    for (const ds of _frontierDatasets(fr)) datasets.push(ds);
    datasets.push({ type: 'line', label: 'CML', data: cmlLine, borderColor: '#38bdf8', borderWidth: 2.5, borderDash: [7, 4], pointRadius: 0, fill: false, order: 3 });
    datasets.push({ type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot', pointRadius: 9, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5, order: 2 });
    if (tang) datasets.push({ type: 'scatter', label: 'תיק אופטימלי', data: [tang], pointStyle: 'star', pointRadius: 12, backgroundColor: '#facc15', borderColor: '#fff', borderWidth: 1.5, order: 1 });
    // Connector: from the portfolio to the efficient frontier at the SAME return —
    // visualizes the gap to the optimum (how much risk could be cut by rebalancing).
    if (portPt) {
        const effPoint = (typeof _projectOntoEfficient === 'function') ? _projectOntoEfficient(fr, portPt.y) : null;
        if (effPoint && Math.abs(effPoint.x - portPt.x) > 0.4) {
            datasets.push({
                type: 'line', label: 'פער מהחזית', data: [{ x: effPoint.x, y: effPoint.y }, { x: portPt.x, y: portPt.y }],
                borderColor: _chartDay() ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.45)',
                borderWidth: 1.5, borderDash: [3, 3], pointRadius: 0, fill: false, order: 1.5,
            });
        }
    }
    if (portPt) datasets.push({ type: 'scatter', label: 'התיק שלך', data: [portPt], pointRadius: 8, pointHoverRadius: 10, backgroundColor: '#00e5ff', borderColor: '#fff', borderWidth: 2.5, order: 0 });

    const opts = _scatterOpts('סיכון כולל σ (%)', 'תשואה צפויה (%)');
    opts.scales.x.min = 0; opts.scales.x.max = maxX;
    opts.scales.y.min = byMin; opts.scales.y.max = Math.max(yTop, byMin + 10);
    _modalRiskCharts.mcml = new Chart(canvas.getContext('2d'), { data: { datasets }, options: opts, plugins: [_minLegendHeightPlugin] });
}

function _drawModalSML(model, client) {
    const canvas = document.getElementById('modal-sml-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const rfPct = model.rf * 100;
    const rmPct = model.rm * 100;
    const clampB = (b) => Math.max(-0.5, Math.min(2.5, (b == null || !isFinite(b)) ? 1 : b));

    const held = (client.holdings || []).filter(h => model.assets[h.ticker] && model.assets[h.ticker].hasData);
    const holdPts = held.map(h => { const a = model.assets[h.ticker]; return { x: clampB(a.beta), y: a.expReturn * 100, name: h.ticker, rec: a.recommendation }; });
    const p = model.portfolios.find(x => x.id === client.id);
    const portPt = (p && p.hasData) ? { x: clampB(p.beta), y: p.expReturn * 100, name: 'התיק שלך' } : null;
    const marketPt = { x: 1, y: rmPct, name: model.marketLabel };

    // FIXED β axis, but the AXIS is wider than the β clamp so points clamped to the
    // edges (β=2.5 / −0.5) still have margin and are fully visible (not half-cut).
    const xMin = -0.8, xMax = 2.8;
    const smlLine = [{ x: xMin, y: rfPct + xMin * (rmPct - rfPct) }, { x: xMax, y: rfPct + xMax * (rmPct - rfPct) }];

    // Auto-fit the frame with generous headroom — SAME positioning style as the CML
    // chart: every point sits in the lower-middle with clear space above, so the
    // portfolio dot (and the legend) never crowd the top axis number.
    const ys = holdPts.map(q => q.y).concat([marketPt.y, rfPct, portPt ? portPt.y : rfPct, smlLine[0].y, smlLine[1].y]);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const yHiPt = Math.max(yHi, portPt ? portPt.y : 0, marketPt.y);
    const yMax = Math.max(yHiPt * 1.2, marketPt.y * 1.25, 25);   // ~20% headroom above the top point
    const yMin = Math.min(yLo - Math.abs(yLo) * 0.15 - 6, -8);

    // Portfolio holdings, split by SML verdict into THREE legend entries (green =
    // suitable, yellow = neutral, red = unsuitable) so it's clear the red dots are
    // ALSO portfolio assets — not a different series.
    const _smlGroups = [
        { key: 'buy', label: 'נכס מתאים (מעל/על SML)', color: '#22c55e' },
        { key: 'neutral', label: 'נכס ניטרלי (על SML)', color: '#eab308' },
        { key: 'avoid', label: 'נכס לא מתאים (מתחת SML)', color: '#ef4444' },
    ];
    const datasets = [
        { type: 'line', label: 'SML', data: smlLine, borderColor: '#38bdf8', borderWidth: 2.5, borderDash: [7, 4], pointRadius: 0, fill: false, order: 3 },
    ];
    for (const g of _smlGroups) {
        const pts = holdPts.filter(q => q.rec === g.key);
        if (pts.length) datasets.push({ type: 'scatter', label: g.label, data: pts, pointRadius: 6, pointHoverRadius: 8, backgroundColor: g.color, borderColor: '#0b0b0f', borderWidth: 1, order: 2 });
    }
    const _smlOther = holdPts.filter(q => !['buy', 'neutral', 'avoid'].includes(q.rec));
    if (_smlOther.length) datasets.push({ type: 'scatter', label: 'נכס בתיק (ללא דירוג)', data: _smlOther, pointRadius: 6, pointHoverRadius: 8, backgroundColor: '#64748b', borderColor: '#0b0b0f', borderWidth: 1, order: 2 });
    datasets.push({ type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot', pointRadius: 9, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5, order: 1 });
    // Semi-transparent fill so an asset point sitting under the big portfolio dot
    // still shows through (the dot no longer hides data).
    if (portPt) datasets.push({ type: 'scatter', label: 'התיק שלך', data: [portPt], pointRadius: 8, pointHoverRadius: 10, backgroundColor: '#00e5ff', borderColor: '#fff', borderWidth: 2.5, order: 0 });

    const opts = _scatterOpts('β (סיכון שיטתי)', 'תשואה צפויה (%)');
    opts.scales.x.min = xMin; opts.scales.x.max = xMax;
    opts.scales.y.min = yMin; opts.scales.y.max = yMax;
    _modalRiskCharts.msml = new Chart(canvas.getContext('2d'), { data: { datasets }, options: opts, plugins: [_minLegendHeightPlugin] });
}

// ── News relevance profiles ──
// To keep the "עדכונים מהותיים" column tight, a headline is shown ONLY if it actually
// names the company — its ticker, a company-name alias, or its CEO. This drops generic
// market roundups and multi-company pieces that merely brush past the holding.
// names = English aliases, he = Hebrew aliases (apostrophe-stripped to match any geresh),
// ceo = executive names (matched in either language when present in the headline).
const _NEWS_PROFILE = {
    NVDA: { names: ['nvidia'], he: ['אנבידיה', 'נבידיה'], ceo: ['jensen huang', 'huang', 'הואנג'] },
    AAPL: { names: ['apple'], he: ['אפל'], ceo: ['tim cook', 'טים קוק'] },
    GOOGL: { names: ['google', 'alphabet'], he: ['גוגל', 'אלפאבית', 'אלפבית'], ceo: ['sundar pichai', 'pichai', 'פיצאי'] },
    GOOG: { names: ['google', 'alphabet'], he: ['גוגל', 'אלפאבית', 'אלפבית'], ceo: ['pichai', 'פיצאי'] },
    AMD: { names: ['advanced micro'], he: ['איי.אם.די'], ceo: ['lisa su', 'ליסה סו'] },
    AVGO: { names: ['broadcom'], he: ['ברודקום'], ceo: ['hock tan'] },
    APP: { names: ['applovin'], he: ['אפלוביין'], ceo: [] },
    MSFT: { names: ['microsoft'], he: ['מיקרוסופט'], ceo: ['satya nadella', 'nadella', 'נאדלה'] },
    META: { names: ['meta platforms', 'facebook', 'instagram'], he: ['מטא', 'פייסבוק', 'אינסטגרם'], ceo: ['mark zuckerberg', 'zuckerberg', 'צוקרברג'] },
    AMZN: { names: ['amazon'], he: ['אמזון'], ceo: ['andy jassy', 'jassy'] },
    TSLA: { names: ['tesla'], he: ['טסלה'], ceo: ['elon musk', 'musk', 'מאסק'] },
    JPM: { names: ['jpmorgan', 'jp morgan'], he: ['גיי.פי מורגן', 'מורגן'], ceo: ['jamie dimon', 'dimon', 'דיימון'] },
    XOM: { names: ['exxon'], he: ['אקסון'], ceo: ['darren woods'] },
    CVX: { names: ['chevron'], he: ['שברון'], ceo: [] },
    LLY: { names: ['eli lilly', 'lilly'], he: ['אלי לילי', 'לילי'], ceo: [] },
    JNJ: { names: ['johnson & johnson'], he: ['גונסון אנד גונסון', 'גונסון'], ceo: [] },
    UNH: { names: ['unitedhealth'], he: ['יונייטדהלת'], ceo: [] },
    CSCO: { names: ['cisco'], he: ['סיסקו'], ceo: ['chuck robbins'] },
    MSTR: { names: ['microstrategy'], he: ['מיקרוסטרטגי', 'סטרטגי'], ceo: ['michael saylor', 'saylor', 'סיילור'] },
    V: { names: ['visa inc'], he: ['ויזה'], ceo: [] },
    INTC: { names: ['intel'], he: ['אינטל'], ceo: ['lip-bu tan', 'gelsinger'] },
    NFLX: { names: ['netflix'], he: ['נטפליקס'], ceo: [] },
    CAT: { names: ['caterpillar'], he: ['קטרפילר'], ceo: [] },
    ORCL: { names: ['oracle'], he: ['אורקל'], ceo: ['safra catz'] },
    CRM: { names: ['salesforce'], he: ['סיילספורס'], ceo: ['marc benioff', 'benioff'] },
    PLTR: { names: ['palantir'], he: ['פלנטיר'], ceo: ['alex karp', 'karp'] },
    COIN: { names: ['coinbase'], he: ['קוינבייס'], ceo: ['brian armstrong'] },
    // ETFs / funds — match the ticker and the fund/theme name only.
    GLD: { names: ['gold'], he: ['זהב'], ceo: [] }, SCHD: { names: ['schwab dividend'], he: [], ceo: [] },
    VOO: { names: ['vanguard s&p', 's&p 500'], he: [], ceo: [] }, VNQ: { names: ['vanguard real estate', 'reit'], he: [], ceo: [] },
    XLE: { names: ['energy select', 'energy sector'], he: [], ceo: [] }, SMH: { names: ['semiconductor'], he: ['שבבים', 'מוליכים למחצה'], ceo: [] },
    SOXX: { names: ['semiconductor'], he: ['שבבים', 'מוליכים למחצה'], ceo: [] }, TLT: { names: ['treasury'], he: [], ceo: [] }, IEF: { names: ['treasury'], he: [], ceo: [] },
};
// Strip apostrophes/geresh so "מיקרוסטרטג׳י" / "ג'ונסון" match their stripped aliases.
const _newsNorm = (s) => String(s || '').toLowerCase().replace(/['׳’‘"״“”]/g, '');
// Build the match terms for a ticker: the ticker itself (word-boundary), any profile
// aliases (EN + HE) + CEO, and the significant words of the stored company name.
function _newsMatchTerms(ticker, heldName) {
    const T = String(ticker || '').toUpperCase();
    const terms = [{ s: T, word: true }];
    const prof = _NEWS_PROFILE[T];
    if (prof) {
        for (const n of prof.names) terms.push({ s: _newsNorm(n), word: false });
        for (const h of (prof.he || [])) terms.push({ s: _newsNorm(h), word: false });
        for (const c of prof.ceo) terms.push({ s: _newsNorm(c), word: false });
    }
    // Significant words from the stored holding name (e.g. "NVIDIA Corp" → "nvidia").
    const STOP = new Set(['inc', 'corp', 'co', 'ltd', 'plc', 'the', 'group', 'holdings', 'company', 'class', 'etf', 'fund', 'trust', 'index']);
    for (const w of _newsNorm(heldName).split(/[^a-z0-9]+/)) {
        if (w.length >= 4 && !STOP.has(w)) terms.push({ s: w, word: false });
    }
    return terms;
}
function _newsIsRelevant(item, terms) {
    const hay = _newsNorm(`${item.en || ''} ${item.he || ''}`);
    if (!hay.trim()) return false;
    for (const t of terms) {
        if (!t.s) continue;
        if (t.word) { if (new RegExp(`(^|[^a-z0-9])${t.s.toLowerCase()}([^a-z0-9]|$)`, 'i').test(hay)) return true; }
        else if (hay.includes(t.s)) return true;
    }
    return false;
}

// Daily Hebrew news headlines for the portfolio's HELD US tickers. Because it reads
// the current holdings, a sold ticker is simply not requested → its news disappears.
async function _renderPortfolioNews(clientId) {
    const box = document.getElementById('modalPortfolioNews');
    if (!box) return;
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client) return;

    // Any US-listed holding (stocks AND ETFs) — not bonds/cash/TASE. Built from the
    // CURRENT holdings, so a sold ticker is dropped automatically.
    const tickers = [...new Set((client.holdings || [])
        .filter(h => h.ticker && h.type !== 'bond' && h.type !== 'cash' && !/\.TA$/i.test(h.ticker))
        .map(h => h.ticker.toUpperCase()))].slice(0, 12);
    if (!tickers.length) {
        box.innerHTML = '<div class="adv-empty">אין נכסים סחירים אמריקאים בתיק להצגת עדכונים.</div>';
        return;
    }

    if (!box.querySelector('.pf-news-item')) box.innerHTML = '<div class="adv-empty">טוען עדכונים…</div>';

    // One news request, returning parsed {ok, data}. `bust` forces a fresh edge entry.
    const fetchNews = async (bust) => {
        // 1-hour bucket key → the edge runs a fresh scan every hour, so a new relevant
        // headline appears through the day; combined with the auto-refresh below this is
        // a continuous 24/7 hourly scan.
        const bucket = Math.floor(Date.now() / 3600000);
        const extra = bust ? `&fresh=${Date.now()}` : '';
        try {
            const res = await fetch(`/api/news?symbols=${encodeURIComponent(tickers.join(','))}&b=${bucket}&tr=2${extra}`, { headers: { Accept: 'application/json' } });
            if (!res.ok) return { ok: false, data: null };
            const data = await res.json();
            if (!data || typeof data !== 'object' || data.error) return { ok: false, data: null };
            return { ok: true, data };
        } catch (e) { return { ok: false, data: null }; }
    };

    let { ok, data } = await fetchNews(false);
    // Empty/failed? retry ONCE with a cache-busting key — recovers from a stale empty
    // edge entry or a transient upstream miss (the reason updates "never arrived").
    if (!ok || !Object.keys(data || {}).length) {
        const retry = await fetchNews(true);
        if (retry.ok) { ok = true; data = retry.data; }
    }

    if (!ok) {
        if (!box.querySelector('.pf-news-item')) box.innerHTML = '<div class="adv-empty">לא ניתן לטעון עדכונים כרגע — ננסה שוב אוטומטית בעוד מספר דקות.</div>';
    } else {
        const items = [];
        const seenHeadlines = new Set();
        let _dropped = 0;
        for (const t of tickers) {
            const arr = data[t];
            if (!arr || !arr.length) continue;
            const held = (client.holdings || []).find(h => (h.ticker || '').toUpperCase() === t.toUpperCase());
            const terms = _newsMatchTerms(t, held && held.name);
            for (const n of arr) {
                const key = (n.he || n.en || '').trim();
                if (key && seenHeadlines.has(key)) continue; // skip market-wide dupes
                // STRICT relevance: keep only headlines that actually name THIS company
                // (ticker / alias / CEO). Drops generic market & multi-company roundups.
                if (!_newsIsRelevant(n, terms)) { _dropped++; continue; }
                if (key) seenHeadlines.add(key);
                items.push({ t, ...n });
            }
        }
        console.log(`[PortfolioNews] ${tickers.length} tickers → ${Object.keys(data || {}).length} with news, ${items.length} relevant headlines (${_dropped} generic dropped)`);
        if (items.length) {
            box.innerHTML = items.map(n => `
                <a class="pf-news-item" href="${n.url || '#'}" target="_blank" rel="noopener">
                    <span class="pf-news-tk">${_riskEsc(n.t)}</span>
                    <span class="pf-news-he">${_riskEsc(n.he || n.en || '')}</span>
                    ${n.date ? `<span class="pf-news-date">${_riskEsc(n.date)}</span>` : ''}
                </a>`).join('');
        } else if (!box.querySelector('.pf-news-item')) {
            box.innerHTML = '<div class="adv-empty">אין כרגע עדכונים זמינים לנכסי התיק — הסריקה ממשיכה ברקע.</div>';
        }
    }

    // 24/7 scanning: while the Portfolio Data tab stays open, re-scan every 10 min.
    // The interval kills itself once the news box leaves the DOM (modal closed).
    if (window._pfNewsTimer) clearInterval(window._pfNewsTimer);
    window._pfNewsTimer = setInterval(() => {
        const el = document.getElementById('modalPortfolioNews');
        if (!el || !document.body.contains(el)) {
            clearInterval(window._pfNewsTimer);
            window._pfNewsTimer = null;
            return;
        }
        _renderPortfolioNews(clientId);
    }, 10 * 60 * 1000);
}

// Correlation table for THIS portfolio: per-asset average correlation to the rest,
// a level column (high/mid/low), a diversification score, and a concrete recommendation
// (sell the most-correlated holding / add a low-correlation diversifier). A compact,
// fixed-column table that never gets clipped — replaces the old N×N heatmap.
async function _renderModalCorrelation(clientId) {
    const box = document.getElementById('modalCorrMatrix');
    if (!box) return;
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client) return;

    let model = window._lastRiskModel;
    if (!model || !model.correlation) {
        try { model = await buildRiskModel(clients); } catch (e) { /* ignore */ }
    }
    if (!model || !model.correlation) { box.innerHTML = '<div class="adv-empty">אין נתוני קורלציה כרגע.</div>'; return; }
    window._lastRiskModel = model;

    const idx = {}; model.correlation.tickers.forEach((t, i) => { idx[t] = i; });
    const M = model.correlation.matrix;
    const seen = new Set(); const tickers = [];
    for (const h of (client.holdings || [])) {
        if (idx[h.ticker] != null && !seen.has(h.ticker)) { seen.add(h.ticker); tickers.push(h.ticker); }
    }
    if (tickers.length < 2) {
        box.innerHTML = '<div class="adv-empty">דרושים לפחות 2 נכסים סחירים עם היסטוריה כדי לחשב קורלציות.</div>';
        return;
    }

    // Per-asset: correlation to the market (S&P 500 — the systematic tie the user
    // expects to see), average correlation to the OTHER holdings, and the single
    // most-correlated partner.
    const rows = tickers.map(ti => {
        let sum = 0, k = 0, topV = -2, topT = null;
        for (const tj of tickers) {
            if (tj === ti) continue;
            const v = M[idx[ti]][idx[tj]];
            if (v == null || !isFinite(v)) continue;
            sum += v; k++;
            if (v > topV) { topV = v; topT = tj; }
        }
        const a = model.assets ? model.assets[ti] : null;
        const mkt = (a && a.corrToMarket != null && isFinite(a.corrToMarket)) ? a.corrToMarket : null;
        return { ticker: ti, mkt, avg: k ? sum / k : 0, topT, topV };
    }).sort((a, b) => (b.mkt == null ? -1 : b.mkt) - (a.mkt == null ? -1 : a.mkt));

    // Overall average pairwise correlation → diversification score
    let pSum = 0, pK = 0;
    for (let i = 0; i < tickers.length; i++) {
        for (let j = i + 1; j < tickers.length; j++) {
            const v = M[idx[tickers[i]]][idx[tickers[j]]];
            if (v != null && isFinite(v)) { pSum += v; pK++; }
        }
    }
    const avgPair = pK ? pSum / pK : 0;
    const divScore = Math.max(0, Math.min(100, Math.round(100 * (1 - Math.max(0, avgPair)))));
    const highCount = rows.filter(r => r.avg > 0.6).length;
    const scoreColor = divScore >= 70 ? 'var(--risk-low)' : divScore >= 45 ? 'var(--accent-yellow)' : 'var(--risk-high)';

    // Recommendation: SELL the most-correlated holding; BUY the lowest-correlation candidate
    const sellX = rows[0];
    let buyY = null;
    try {
        const adv = buildPortfolioAdvisory(client, model);
        const cands = (adv && adv.candidates) ? adv.candidates.slice() : [];
        cands.sort((a, b) => ((a.corrToPort == null ? 1 : a.corrToPort) - (b.corrToPort == null ? 1 : b.corrToPort)));
        buyY = cands[0] || null;
    } catch (e) { /* ignore */ }

    const lvl = (a) => a > 0.6 ? '<span class="corr-lvl high">גבוהה</span>'
        : a > 0.35 ? '<span class="corr-lvl mid">בינונית</span>'
            : '<span class="corr-lvl low">נמוכה</span>';

    const recText = highCount > 0
        ? `כדי לצמצם קורלציה: מכור את <b>${_riskEsc(sellX.ticker)}</b> (ρ̄=${sellX.avg.toFixed(2)} — הכי מתואם)${buyY ? ` או הוסף <b>${_riskEsc(buyY.ticker)}</b> (קורלציה נמוכה ${buyY.corrToPort != null ? buyY.corrToPort.toFixed(2) : ''} — מגוון)` : ''}.`
        : `הפיזור טוב — אין נכסים בקורלציה גבוהה מדי. שמור על ההרכב.`;

    const summary = `
        <div class="corr-summary">
            <div class="corr-score" style="--c:${scoreColor}"><span>${divScore}</span><small>/100 פיזור</small></div>
            <div class="corr-rec-txt">
                <div class="corr-rec-title" style="color:${scoreColor}">${highCount > 0 ? `התיק מכיל ${highCount} נכסים בקורלציה גבוהה ביניהם` : 'פיזור טוב'} · קורלציה ממוצעת ${avgPair.toFixed(2)}</div>
                <div class="corr-rec-sub">${recText}</div>
            </div>
        </div>`;

    const tableRows = rows.map(r => `
        <tr>
            <td class="corr-td-tk">${_riskEsc(r.ticker)}</td>
            <td class="corr-td-num">${r.mkt != null ? r.mkt.toFixed(2) : '—'}</td>
            <td class="corr-td-num">${r.avg.toFixed(2)}</td>
            <td>${lvl(r.mkt != null ? r.mkt : r.avg)}</td>
            <td class="corr-td-partner">${r.topT ? `${_riskEsc(r.topT)} (${r.topV.toFixed(2)})` : '—'}</td>
        </tr>`).join('');

    // Transparency: how many trading days the statistics are based on
    const ptsArr = tickers.map(t => (model.assets && model.assets[t] && model.assets[t].points) ? model.assets[t].points : 0).filter(x => x > 0);
    const minPts = ptsArr.length ? Math.min(...ptsArr) : 0;
    const foot = minPts ? `<div class="corr-foot">מחושב על כל ימי המסחר בשנה האחרונה (~${minPts} ימי מסחר), נתוני מחירים יומיים אמיתיים.</div>` : '';

    box.innerHTML = `${summary}
        <div class="corr-table-wrap">
            <table class="corr-table">
                <thead><tr><th>נכס</th><th>ρ לשוק (S&P 500)</th><th>ρ ממוצע לתיק</th><th>רמת קורלציה</th><th>הכי מתואם עם</th></tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
        ${foot}`;
}

// Land DIRECTLY on the stock ready to buy: open the buy form, SELECT the chosen
// ticker (fills the security field + shows its badge), auto-fill the live market
// price, and focus the quantity — so the user only enters the amount and confirms.
function addCandidateToPortfolio(clientId, ticker) {
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client || typeof openMgmtModal !== 'function') return;
    openMgmtModal('addHolding', client);
    const trySelect = (attempt) => {
        const searchEl = document.getElementById('mgmt-ticker-search');
        if (searchEl && typeof selectSearchResult === 'function') {
            // Select the ticker in the buy form (fills hidden fields, shows the badge,
            // fetches the market-price preview).
            selectSearchResult(ticker, ticker, 'USD', 'NASDAQ');
            // Auto-fill the buy price with the live price and focus the quantity field.
            if (typeof fetchSingleTickerPrice === 'function') {
                fetchSingleTickerPrice(ticker, 'USD').then((r) => {
                    const priceEl = document.getElementById('mgmt-price');
                    if (priceEl && r && r.price > 0 && !priceEl.value) {
                        priceEl.value = r.price.toFixed(2);
                        if (typeof updateBuyCost === 'function') updateBuyCost();
                    }
                    const qtyEl = document.getElementById('mgmt-qty');
                    if (qtyEl) qtyEl.focus();
                }).catch(() => {});
            }
        } else if (attempt < 14) {
            setTimeout(() => trySelect(attempt + 1), 60);
        }
    };
    requestAnimationFrame(() => trySelect(0));
}

// ════════ Recommended-stocks popup dialog ════════
async function openStockRecommendations(clientId, _fromHistory) {
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client) return;
    const model = window._lastRiskModel;
    let cands = [];
    let adv = null;
    if (model && typeof buildPortfolioAdvisory === 'function') {
        try { adv = buildPortfolioAdvisory(client, model); cands = (adv && adv.candidates) || []; } catch (e) { /* ignore */ }
    }

    let ov = document.getElementById('stockRecoOverlay');
    if (!ov) {
        ov = document.createElement('div'); ov.id = 'stockRecoOverlay'; ov.className = 'reco-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) closeStockRecommendations(); });
        document.body.appendChild(ov);
    }

    // PAINT IMMEDIATELY using whatever technical data is already cached (today's localStorage
    // cache, or neutral 50 on the very first open). No blocking network wait — the score is
    // 80% fundamental+SML which we have synchronously. Real technical scores are then filled
    // in the BACKGROUND (see _recoEnrichAndRepaint) so the user never waits on a 130-ticker scan.
    if (cands.length && typeof _rmApplyFinalScore === 'function') {
        _rmApplyFinalScore(cands, _recoCachedTechMap());
        cands.sort((x, y) => (y.finalScore - x.finalScore) || (y.fit - x.fit));
    }
    _recoPaint(clientId, client, cands, adv, ov);
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    // Tag this history entry so browser Back FROM a technical/reports deep-link returns here.
    if (!_fromHistory) { try { history.pushState({ popup: 'reco', recoClient: clientId }, '', location.href); } catch (e) { /* ignore */ } }

    _recoEnrichAndRepaint(clientId, client, cands, adv, ov);
}

// Background: fetch real technical readings for the candidates, re-score, and repaint
// once — only if some tickers weren't already in the (daily) cache, and the overlay is
// still showing this client. Keeps the first paint instant.
async function _recoEnrichAndRepaint(clientId, client, cands, adv, ov) {
    if (!cands.length || typeof _rmApplyFinalScore !== 'function') return;
    _recoHydrateTechCache();
    const need = [...new Set(cands.map(c => c.ticker))].filter(t => !_recoTechCache[t]);
    if (!need.length) return;                       // first paint already had real scores
    let techMap;
    try { techMap = await _recoFetchTechMap(cands.map(c => c.ticker)); } catch (e) { return; }
    _rmApplyFinalScore(cands, techMap);
    cands.sort((x, y) => (y.finalScore - x.finalScore) || (y.fit - x.fit));
    if (ov && ov.classList.contains('active') && window._recoState && window._recoState.clientId === clientId) {
        _recoPaint(clientId, client, cands, adv, ov);
    }
}

// Render the recommendations overlay body (efficiency banner + sector-grouped cards) into
// `ov`. Pure paint — called for the instant first render AND the background re-render.
function _recoPaint(clientId, client, cands, adv, ov) {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

    // Rebalance-to-efficient banner.
    let effHTML = '';
    const eff = adv && adv.efficiency;
    if (adv && adv.p && adv.p.partial) {
        effHTML = `<div class="reco-eff">
            <div class="reco-eff-title">מחשב את עמידת התיק במודל…</div>
            <div class="reco-eff-sub">ממתין לטעינת נתוני השוק לכל אחזקות התיק. הניתוח יוצג ברגע שהנתונים מלאים — כדי שהקביעה תהיה יציבה ולא תשתנה ללא שינוי בתיק.</div>
        </div>`;
    } else if (eff) {
        if (eff.isEfficient) {
            effHTML = `<div class="reco-eff reco-eff-ok">
                <div class="reco-eff-title">התיק כבר באיזור היעיל (על/מעל קו ה-CML) ✓</div>
                <div class="reco-eff-sub">Sharpe ${rmFmtNum(eff.sharpe, 2)} מול ${rmFmtNum(eff.marketSharpe, 2)} של השוק — תשואה מרבית לרמת הסיכון. ההוספות למטה ישמרו/ישפרו את הפיזור.</div>
            </div>`;
        } else {
            const wm = eff.wMarket != null ? Math.round(Math.max(0, Math.min(1, eff.wMarket)) * 100) : null;
            const mix = (wm != null) ? `<div class="reco-eff-mix">יעד איזון (CML): <b>${wm}%</b> ${esc(adv.marketSymbol)} + <b>${100 - wm}%</b> אג"ח קצר/מזומן</div>` : '';
            effHTML = `<div class="reco-eff reco-eff-bad">
                <div class="reco-eff-title">התיק מתחת לקו ה-CML — לא יעיל</div>
                <div class="reco-eff-sub">בסיכון σ=${rmFmtPct(eff.portfolioSigma, 1)} התשואה ${rmFmtPct(eff.portfolioReturn, 1)}, בעוד שעל הקו ניתן ${rmFmtPct(eff.cmlReturn, 1)} (פער ${rmFmtPct(eff.returnGap, 1)}). הוסף מהנכסים הבאים — מתומחרים בחסר ובקורלציה נמוכה — כדי לאזן את התיק לאיזור היעיל.</div>
                ${mix}
            </div>`;
        }
    }

    const OPT = ['א', 'ב', 'ג', 'ד', 'ה'];
    let cardsHTML;
    if (!cands.length) {
        cardsHTML = '<div class="adv-empty">אין כרגע מועמדים מתאימים — ייתכן שהמודל עדיין נטען, נסה שוב בעוד רגע.</div>';
        window._recoState = null;
    } else {
        const bySector = {};
        for (const c of cands) { (bySector[c.sector || 'אחר'] = bySector[c.sector || 'אחר'] || []).push(c); }
        const state = { clientId, bySector, slots: {}, cards: {}, allCands: cands };
        let seq = 0;
        // ETFs ("תעודות סל") always render as the LAST group, after the stock sectors.
        cardsHTML = Object.entries(bySector)
            .sort((a, b) => (a[0] === 'תעודות סל' ? 1 : 0) - (b[0] === 'תעודות סל' ? 1 : 0))
            .map(([sector, list]) => {
                const slots = Math.min(list.length, 3);
                state.slots[sector] = slots;
                const multi = slots > 1;
                const hasAlt = list.length > 1;
                const head = list.length > 1 ? `${_riskEsc(sector)} — ${list.length} אופציות (לחץ "בדוק אופציה חלופית" לעוד)` : _riskEsc(sector);
                let grid = '';
                for (let slot = 0; slot < slots; slot++) {
                    const cardId = `recoCard_${seq++}`;
                    const optLetter = multi ? `${OPT[slot] || (slot + 1)}'` : '';
                    state.cards[cardId] = { sector, shownIdx: slot, optLetter, ticker: list[slot].ticker };
                    grid += `<div class="reco-card" id="${cardId}" onclick="addCandidateToPortfolio(${clientId}, '${_riskEsc(list[slot].ticker)}'); closeStockRecommendations();">${_recoCardInner(list[slot], cardId, optLetter, hasAlt)}</div>`;
                }
                return `<div class="reco-group"><div class="reco-group-head">${head}</div><div class="reco-grid">${grid}</div></div>`;
            }).join('');
        window._recoState = state;
    }

    ov.innerHTML = `<div class="reco-box" dir="rtl">
        <div class="reco-head">
            <div><h3>המלצות לאיזון התיק וייעולו</h3><span class="reco-sub">${esc(client.name)} — בחר מניה להוספה</span></div>
            <button class="reco-close" onclick="closeStockRecommendations()">✕</button>
        </div>
        ${effHTML}
        <p class="reco-hint">לכל מנייה: מספר המניות לקנייה ו-% מהתיק (יעד ~10% לכל הוספה), קישור לגוגל פיננס, ומדדים. לא מאמין בחברה? לחץ <b>"↻ בדוק אופציה חלופית"</b> כדי לראות מנייה אחרת מאותו סקטור.</p>
        ${cardsHTML}
    </div>`;
}

// Fetch MA200/WMA200/Weekly-RSI/FVG for the candidate tickers and return them as a
// { ticker -> scanResult } map. Cached in-session AND in localStorage (daily) so the
// second open of recommendations — even in a new session the same day — is instant.
const _recoTechCache = {};
let _recoTechCacheHydrated = false;
function _recoHydrateTechCache() {
    if (_recoTechCacheHydrated) return;
    _recoTechCacheHydrated = true;
    try {
        const c = JSON.parse(localStorage.getItem('reco_tech_v1') || '{}');
        if (c && c.day === new Date().toISOString().slice(0, 10) && c.data) Object.assign(_recoTechCache, c.data);
    } catch (e) { /* ignore */ }
}
function _recoPersistTechCache() {
    try { localStorage.setItem('reco_tech_v1', JSON.stringify({ day: new Date().toISOString().slice(0, 10), data: _recoTechCache })); } catch (e) { /* quota — session cache still serves */ }
}
// Synchronous cached technical map (no network) for the instant first paint.
function _recoCachedTechMap() { _recoHydrateTechCache(); return _recoTechCache; }
async function _recoFetchTechMap(tickers) {
    _recoHydrateTechCache();
    const out = {};
    const need = [];
    for (const t of [...new Set(tickers)]) {
        if (_recoTechCache[t]) out[t] = _recoTechCache[t]; else need.push(t);
    }
    if (need.length) {
        const today = new Date().toISOString().slice(0, 10);
        const BATCH = 45;
        for (let i = 0; i < need.length; i += BATCH) {
            const b = need.slice(i, i + BATCH);
            try {
                const r = await fetch(`/api/technicals?mode=scan&symbols=${b.map(encodeURIComponent).join(',')}&d=${today}&v=2`, { headers: { Accept: 'application/json' } });
                const j = await r.json();
                if (j && j.results) for (const [k, v] of Object.entries(j.results)) { _recoTechCache[k] = v; out[k] = v; }
            } catch (e) { /* skip batch */ }
        }
        _recoPersistTechCache();
    }
    return out;
}

function closeStockRecommendations() {
    const ov = document.getElementById('stockRecoOverlay');
    if (ov) ov.classList.remove('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}

// Inner HTML of a recommendation card (so a card can be re-rendered in place when the
// user asks for an alternative). `optLetter` is e.g. "א'" (empty for a single option).
// The letter + ticker are kept on ONE line (nowrap). The Google Finance link, the alt
// button and the buy CTA all live in a footer pinned to the bottom — fixed positions
// that never move when the card is swapped, regardless of ticker-name length.
// One short technical line on the card: 1–2 of the platform's technical-table params
// (weekly RSI + distance above the 200-week MA) + a near-ATH warning when relevant.
function _recoTechLine(c) {
    if (!c.hasTech) return '';
    const bits = [];
    if (c.techRsiW != null) bits.push(`RSI שבועי <b>${Math.round(c.techRsiW)}</b>`);
    if (c.techDistW != null) bits.push(`<b>${c.techDistW >= 0 ? '+' : ''}${Math.round(c.techDistW)}%</b> מול ממוצע 200ש׳`);
    else if (c.techDistD != null) bits.push(`<b>${c.techDistD >= 0 ? '+' : ''}${Math.round(c.techDistD)}%</b> מול ממוצע 200י׳`);
    if (!bits.length) return '';
    const warn = c.nearATH ? '<span class="reco-tech-warn">⚠ קרוב לשיא</span>' : '';
    return `<div class="reco-tech">${bits.join(' · ')} ${warn}</div>`;
}

function _recoCardInner(c, cardId, optLetter, hasAlt) {
    const gf = (typeof googleFinanceUrl === 'function') ? googleFinanceUrl(c.ticker) : `https://www.google.com/finance/quote/${c.ticker}:NASDAQ`;
    const buy = c.shares != null ? `קנה ≈ <b>${c.shares.toLocaleString('en-US')}</b> מניות (~${c.pct.toFixed(0)}% מהתיק)` : 'הוסף לתיק';
    const altBtn = hasAlt ? `<button class="reco-alt" onclick="event.stopPropagation(); swapRecommendation('${cardId}')" title="הצג מנייה חלופית מאותו סקטור">↻ בדוק אופציה חלופית</button>` : '';
    const heading = optLetter
        ? `<span class="reco-opt-lead">אופציה</span> <span class="reco-opt">${_riskEsc(optLetter)} · ${_riskEsc(c.ticker)}</span>`
        : `<span class="reco-opt">${_riskEsc(c.ticker)}</span>`;
    // Final Score (40% דוחות · 40% SML/CML · 20% טכני) — the headline ranking number.
    const fs = (c.finalScore != null) ? c.finalScore : null;
    const fsCol = fs == null ? 'var(--text-muted)' : fs >= 65 ? 'var(--risk-low)' : fs >= 45 ? 'var(--accent-yellow)' : 'var(--risk-high)';
    const scoreHtml = fs == null ? '' : `
            <div class="reco-score" style="--fsc:${fsCol}" title="ציון משוקלל: 40% דוחות · 40% SML/CML · 20% טכני">
                <span class="reco-score-num">${fs}<small>/100</small></span>
                <span class="reco-score-brk">דוחות ${c.fundScore ?? '—'} · מודל ${c.smlScore ?? '—'} · טכני ${c.techScore ?? '—'}</span>
            </div>`;
    return `
            <div class="reco-card-top">
                <span class="reco-tk">${heading}</span>
            </div>
            ${scoreHtml}
            <div class="reco-buy">${buy}</div>
            <div class="reco-stats">
                <span>α <b class="pos">${rmFmtPct(c.alpha, 1)}</b></span>
                <span>β <b>${rmFmtNum(c.beta, 2)}</b></span>
                <span>σ <b>${rmFmtPct(c.vol, 0)}</b></span>
                <span>ρ <b>${c.corrToPort == null ? '—' : rmFmtNum(c.corrToPort, 2)}</b></span>
            </div>
            ${_recoTechLine(c)}
            <div class="reco-links">
                <a class="reco-gf" href="${gf}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="מידע על המנייה בגוגל פיננס">גוגל פיננס ↗</a>
                <a class="reco-gf" href="javascript:void(0)" onclick="event.stopPropagation(); openTechnicalForTicker('${_riskEsc(c.ticker)}')" title="ניתוח טכני ואינדיקטורים בפלטפורמה">ניתוח טכני ↗</a>
                <a class="reco-gf" href="javascript:void(0)" onclick="event.stopPropagation(); openReportForTicker('${_riskEsc(c.ticker)}')" title="ניתוח דוחות כספיים של החברה">דוחות ↗</a>
            </div>
            <div class="reco-foot">
                ${altBtn}
                <div class="reco-add">+ הוסף לתיק וקנה</div>
            </div>`;
}

// Cycle a card to the next candidate FROM THE SAME SECTOR ONLY — so the alternative is
// always a real peer (never a cross-sector name like MU under "Crypto"). Prefers a name
// not currently on another card; if the small sector is exhausted it still rotates
// through the sector's own list, so several clicks reveal several same-sector options.
function swapRecommendation(cardId) {
    const st = window._recoState;
    if (!st || !st.cards || !st.cards[cardId]) return;
    const cs = st.cards[cardId];
    const list = st.bySector[cs.sector] || [];   // STRICT same sector
    if (list.length < 2) return;
    const curIdx = Math.max(0, list.findIndex(c => c.ticker === cs.ticker));
    const othersShown = new Set(
        Object.entries(st.cards).filter(([id, s]) => id !== cardId && s.sector === cs.sector).map(([, s]) => s.ticker)
    );
    let pick = null, fallback = null;
    for (let step = 1; step <= list.length; step++) {
        const c = list[(curIdx + step) % list.length];
        if (c.ticker === cs.ticker) continue;
        if (!fallback) fallback = c;                       // next same-sector name (allows a dup if needed)
        if (!othersShown.has(c.ticker)) { pick = c; break; } // prefer one not shown elsewhere
    }
    pick = pick || fallback;
    if (!pick) return;
    cs.ticker = pick.ticker;
    const el = document.getElementById(cardId);
    if (!el) return;
    el.setAttribute('onclick', `addCandidateToPortfolio(${st.clientId}, '${_riskEsc(pick.ticker)}'); closeStockRecommendations();`);
    el.innerHTML = _recoCardInner(pick, cardId, cs.optLetter, true);
}

if (typeof window !== 'undefined') {
    window.openRiskAnalysis = openRiskAnalysis;
    window.closeRiskAnalysis = closeRiskAnalysis;
    window.refreshRiskAnalysis = refreshRiskAnalysis;
    window.addCandidateToPortfolio = addCandidateToPortfolio;
    window._renderModalRiskCharts = _renderModalRiskCharts;
    window._renderModalCorrelation = _renderModalCorrelation;
    window._renderPortfolioNews = _renderPortfolioNews;
    window.openStockRecommendations = openStockRecommendations;
    window.swapRecommendation = swapRecommendation;
    window.openAssetFitPopup = openAssetFitPopup;
    window.closeAssetFitPopup = closeAssetFitPopup;
    window.closeStockRecommendations = closeStockRecommendations;
}
