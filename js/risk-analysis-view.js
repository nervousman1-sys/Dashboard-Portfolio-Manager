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
                <p class="risk-chart-legend">העקומה הירוקה = החזית היעילה (Markowitz). הקו הכחול = ה-CML, משיק לחזית ב<b>כוכב הזהב</b> = <b>התיק האופטימלי</b>. תיקים על/מעל ה-CML יעילים; מתחת — נחותים.</p>
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
        ${_renderCorrelationHeatmap(model)}
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
        .map(p => ({ x: p.vol * 100, y: p.expReturn * 100, name: p.name, risk: p.riskLabel }));
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

    const ptColors = pts.map(p => p.risk === 'גבוה' ? '#ef4444' : p.risk === 'בינוני' ? '#eab308' : '#22c55e');

    const datasets = [];
    for (const ds of _frontierDatasets(model.frontier)) datasets.push(ds);
    datasets.push({
        type: 'line', label: 'CML (קו אופטימלי)', data: cmlLine, borderColor: '#38bdf8', borderWidth: 2.5,
        borderDash: [7, 4], pointRadius: 0, fill: false, tension: 0, order: 2,
    });
    datasets.push({
        type: 'scatter', label: 'תיקים', data: pts, pointRadius: 7, pointHoverRadius: 9,
        backgroundColor: ptColors, borderColor: '#0b0b0f', borderWidth: 1.5, order: 1,
    });
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

function _scatterOpts(xLabel, yLabel) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#cbd5e1', font: { family: 'Assistant' }, usePointStyle: true } },
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
                 title: { display: true, text: xLabel, color: '#94a3b8' },
                 ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.12)' } },
            y: { type: 'linear',
                 title: { display: true, text: yLabel, color: '#94a3b8' },
                 ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.12)' } }
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
        return `
            <div class="adv-portfolio glass-card">
                <div class="adv-portfolio-head">
                    <span class="adv-portfolio-name">${_riskEsc(p.name)}</span>
                    <span class="risk-badge ${p.risk}">${p.riskLabel} · ${p.riskScore}</span>
                </div>
                ${body}
            </div>`;
    }).join('');

    return `
        <div class="risk-section-head">
            <h3>סקירה והמלצות לכל תיק</h3>
            <span class="risk-chart-sub">האם התיק עומד ב-CML/SML · אילו נכסים מתאימים · מה לשנות ומה לקנות</span>
        </div>
        <div class="adv-grid">${cards}</div>`;
}

// ── 5. Recommendations table ──

function _renderRecommendations(model) {
    const assets = Object.values(model.assets || {}).filter(a => a.hasData)
        .sort((a, b) => (b.alpha || 0) - (a.alpha || 0));
    if (assets.length === 0) return '';
    const body = assets.map(a => `
        <tr>
            <td class="risk-td-name">${_riskEsc(a.ticker)}</td>
            <td class="risk-td-sector">${_riskEsc(a.sector || '')}</td>
            <td>${rmFmtNum(a.beta, 2)}</td>
            <td class="${a.expReturn >= 0 ? 'pos' : 'neg'}">${rmFmtPct(a.expReturn, 1)}</td>
            <td>${rmFmtPct(a.requiredReturn, 1)}</td>
            <td class="${a.alpha >= 0 ? 'pos' : 'neg'}">${rmFmtPct(a.alpha, 1)}</td>
            <td><span class="risk-rec" style="--rec:${rmRecColor(a.recommendation)}">${rmRecLabel(a.recommendation)}</span></td>
        </tr>`).join('');
    return `
        <div class="risk-table-card glass-card">
            <div class="risk-chart-head"><h3>המלצות נכסים</h3>
                <span class="risk-chart-sub">לפי אלפא של ג'נסן — תשואה צפויה מול הנדרש ב-CAPM</span></div>
            <div class="risk-table-scroll">
            <table class="risk-table">
                <thead><tr>
                    <th>נכס</th><th>סקטור</th><th>β</th><th>תשואה צפויה</th>
                    <th>תשואה נדרשת</th><th>α</th><th>המלצה</th>
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
            </div>
        </div>`;
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
            advBox.innerHTML = renderAdvisoryHTML(adv, { clientId });
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
                borderColor: 'rgba(255,255,255,0.45)', borderWidth: 1.5, borderDash: [3, 3], pointRadius: 0, fill: false, order: 1.5,
            });
        }
    }
    if (portPt) datasets.push({ type: 'scatter', label: 'התיק שלך', data: [portPt], pointRadius: 11, pointHoverRadius: 13, backgroundColor: '#00e5ff', borderColor: '#fff', borderWidth: 2.5, order: 0 });

    const opts = _scatterOpts('סיכון כולל σ (%)', 'תשואה צפויה (%)');
    opts.scales.x.min = 0; opts.scales.x.max = maxX;
    opts.scales.y.min = byMin; opts.scales.y.max = Math.max(yTop, byMin + 10);
    _modalRiskCharts.mcml = new Chart(canvas.getContext('2d'), { data: { datasets }, options: opts });
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

    // Zoom OUT so every asset point is comfortably inside the frame (extra margin)
    const ys = holdPts.map(q => q.y).concat([marketPt.y, rfPct, portPt ? portPt.y : rfPct, smlLine[0].y, smlLine[1].y]);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const yRange = (yHi - yLo) || 50;
    const yMax = Math.min(190, yHi + yRange * 0.18 + 10);
    const yMin = Math.max(-130, yLo - yRange * 0.18 - 10);

    const datasets = [
        { type: 'line', label: 'SML', data: smlLine, borderColor: '#38bdf8', borderWidth: 2.5, borderDash: [7, 4], pointRadius: 0, fill: false, order: 3 },
        { type: 'scatter', label: 'נכסי התיק', data: holdPts, pointRadius: 6, pointHoverRadius: 8, backgroundColor: holdPts.map(q => rmRecColor(q.rec)), borderColor: '#0b0b0f', borderWidth: 1, order: 2 },
        { type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot', pointRadius: 9, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5, order: 1 },
    ];
    if (portPt) datasets.push({ type: 'scatter', label: 'התיק שלך', data: [portPt], pointRadius: 11, backgroundColor: '#00e5ff', borderColor: '#fff', borderWidth: 2.5, order: 0 });

    const opts = _scatterOpts('β (סיכון שיטתי)', 'תשואה צפויה (%)');
    opts.scales.x.min = xMin; opts.scales.x.max = xMax;
    opts.scales.y.min = yMin; opts.scales.y.max = yMax;
    _modalRiskCharts.msml = new Chart(canvas.getContext('2d'), { data: { datasets }, options: opts });
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

    try {
        const res = await fetch(`/api/news?symbols=${encodeURIComponent(tickers.join(','))}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) { box.innerHTML = '<div class="adv-empty">לא ניתן לטעון עדכונים כרגע.</div>'; return; }
        const data = await res.json();
        const items = [];
        for (const t of tickers) {
            const arr = data[t];
            if (arr && arr.length) for (const n of arr) items.push({ t, ...n });
        }
        if (!items.length) {
            box.innerHTML = '<div class="adv-empty">אין עדכונים מהותיים זמינים כרגע לנכסי התיק.</div>';
            return;
        }
        box.innerHTML = items.map(n => `
            <a class="pf-news-item" href="${n.url || '#'}" target="_blank" rel="noopener">
                <span class="pf-news-tk">${_riskEsc(n.t)}</span>
                <span class="pf-news-he">${_riskEsc(n.he || n.en || '')}</span>
                ${n.date ? `<span class="pf-news-date">${_riskEsc(n.date)}</span>` : ''}
            </a>`).join('');
    } catch (e) {
        box.innerHTML = '<div class="adv-empty">שגיאה בטעינת עדכונים.</div>';
    }
}

// Correlation matrix of THIS portfolio's own holdings (Portfolio Data tab).
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
    const seen = new Set(); const tickers = [];
    for (const h of (client.holdings || [])) {
        if (idx[h.ticker] != null && !seen.has(h.ticker)) { seen.add(h.ticker); tickers.push(h.ticker); }
    }
    if (tickers.length < 2) {
        box.innerHTML = '<div class="adv-empty">דרושים לפחות 2 נכסים סחירים עם היסטוריה כדי להציג מטריצת קורלציות.</div>';
        return;
    }

    // Auto-fit the cell/number size to the number of holdings: few assets → large &
    // readable; many assets → smaller so the whole matrix (and the news) stay visible.
    const n = tickers.length;
    const cell = n <= 5 ? 56 : n <= 8 ? 46 : n <= 11 ? 38 : n <= 14 ? 32 : n <= 18 ? 27 : n <= 24 ? 23 : 20;
    const ch = Math.round(cell * 0.8);
    const cf = n <= 5 ? 15 : n <= 8 ? 13 : n <= 11 ? 12 : n <= 14 ? 11 : n <= 18 ? 10 : n <= 24 ? 9 : 8;
    const clf = Math.max(8, cf);

    const M = model.correlation.matrix;
    const head = `<th class="risk-corr-corner"></th>` + tickers.map(t => `<th class="risk-corr-h">${_riskEsc(t)}</th>`).join('');
    const rows = tickers.map(ti => {
        const cells = tickers.map(tj => {
            const v = M[idx[ti]][idx[tj]];
            const txt = (v == null || !isFinite(v)) ? '—' : v.toFixed(2);
            return `<td class="risk-corr-cell" style="background:${_corrColor(v)}" title="${_riskEsc(ti)} ↔ ${_riskEsc(tj)}: ${txt}">${txt}</td>`;
        }).join('');
        return `<tr><th class="risk-corr-row">${_riskEsc(ti)}</th>${cells}</tr>`;
    }).join('');
    box.innerHTML = `<div class="risk-corr-scroll" style="--cc:${cell}px;--ch:${ch}px;--cf:${cf}px;--clf:${clf}px"><table class="risk-corr-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
function openStockRecommendations(clientId) {
    const client = (typeof clients !== 'undefined') ? clients.find(c => c.id === clientId) : null;
    if (!client) return;
    const model = window._lastRiskModel;
    let cands = [];
    let adv = null;
    if (model && typeof buildPortfolioAdvisory === 'function') {
        try { adv = buildPortfolioAdvisory(client, model); cands = (adv && adv.candidates) || []; } catch (e) { /* ignore */ }
    }
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

    // Rebalance-to-efficient banner: states whether the portfolio is in the optimal
    // region and the target CML allocation to get it there.
    let effHTML = '';
    const eff = adv && adv.efficiency;
    if (eff) {
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

    let ov = document.getElementById('stockRecoOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'stockRecoOverlay';
        ov.className = 'reco-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) closeStockRecommendations(); });
        document.body.appendChild(ov);
    }

    // Group candidates by sector → same-sector names play a similar role, so present
    // them as ALTERNATIVES (Option A / B): buy one OR the other.
    const _gfUrl = (typeof googleFinanceUrl === 'function') ? googleFinanceUrl : (t) => `https://www.google.com/finance/quote/${t}:NASDAQ`;
    const OPT = ['א', 'ב', 'ג', 'ד', 'ה'];
    const card = (c, i, alt) => `
        <div class="reco-card" onclick="addCandidateToPortfolio(${clientId}, '${esc(c.ticker)}'); closeStockRecommendations();">
            <div class="reco-card-top">
                <span class="reco-tk">${alt ? `אופציה ${OPT[i] || (i + 1)} · ` : ''}${esc(c.ticker)}</span>
                <a class="reco-gf" href="${_gfUrl(c.ticker)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="מידע על המנייה בגוגל פיננס">Google Finance ↗</a>
            </div>
            <div class="reco-buy">${c.shares != null ? `קנה ≈ <b>${c.shares.toLocaleString('en-US')}</b> מניות (~${c.pct.toFixed(0)}% מהתיק)` : 'הוסף לתיק'}</div>
            <div class="reco-stats">
                <span>α <b class="pos">${rmFmtPct(c.alpha, 1)}</b></span>
                <span>β <b>${rmFmtNum(c.beta, 2)}</b></span>
                <span>σ <b>${rmFmtPct(c.vol, 0)}</b></span>
                <span>ρ <b>${c.corrToPort == null ? '—' : rmFmtNum(c.corrToPort, 2)}</b></span>
            </div>
            <div class="reco-add">+ הוסף לתיק וקנה</div>
        </div>`;
    let cardsHTML;
    if (!cands.length) {
        cardsHTML = '<div class="adv-empty">אין כרגע מועמדים מתאימים — ייתכן שהמודל עדיין נטען, נסה שוב בעוד רגע.</div>';
    } else {
        const bySector = {};
        for (const c of cands) { (bySector[c.sector || 'אחר'] = bySector[c.sector || 'אחר'] || []).push(c); }
        cardsHTML = Object.entries(bySector).map(([sector, list]) => {
            const alt = list.length > 1;
            const head = alt
                ? `${esc(sector)} — בחר אופציה אחת (תפקיד דומה בתיק)`
                : esc(sector);
            return `<div class="reco-group">
                <div class="reco-group-head">${head}</div>
                <div class="reco-grid">${list.map((c, i) => card(c, i, alt)).join('')}</div>
            </div>`;
        }).join('');
    }

    ov.innerHTML = `<div class="reco-box" dir="rtl">
        <div class="reco-head">
            <div><h3>מניות מומלצות לתיק האופטימלי</h3><span class="reco-sub">${esc(client.name)} — בחר מניה להוספה</span></div>
            <button class="reco-close" onclick="closeStockRecommendations()">✕</button>
        </div>
        ${effHTML}
        <p class="reco-hint">לכל מנייה: מספר המניות לקנייה ו-% מהתיק (יעד ~10% לכל הוספה), קישור לגוגל פיננס, ומדדים. מניות באותו סקטור = אופציות חלופיות (בחר אחת).</p>
        ${cardsHTML}
    </div>`;
    ov.classList.add('active');
}

function closeStockRecommendations() {
    const ov = document.getElementById('stockRecoOverlay');
    if (ov) ov.classList.remove('active');
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
    window.closeStockRecommendations = closeStockRecommendations;
}
