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
                <p class="risk-chart-legend">מעל הקו = יחס תשואה/סיכון עדיף לשוק · מתחת = נחות. נקודת היהלום = ${_riskEsc(model.marketLabel)}.</p>
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
    const pts = (model.portfolios || []).filter(p => p.hasData && p.totalValue > 0)
        .map(p => ({ x: p.vol * 100, y: p.expReturn * 100, name: p.name, risk: p.riskLabel }));
    const marketPt = { x: model.marketVol * 100, y: model.rm * 100, name: model.marketLabel };

    const maxX = Math.max(model.marketVol * 100, ...pts.map(p => p.x), 5) * 1.25;
    const slope = model.marketVol > 0 ? (model.rm - model.rf) / model.marketVol : 0; // per unit σ (decimal)
    const rfPct = model.rf * 100;
    const cmlLine = [{ x: 0, y: rfPct }, { x: maxX, y: rfPct + slope * (maxX) }];

    const ptColors = pts.map(p => p.risk === 'גבוה' ? '#ef4444' : p.risk === 'בינוני' ? '#eab308' : '#22c55e');

    _riskCharts.cml = new Chart(canvas.getContext('2d'), {
        data: {
            datasets: [
                { type: 'line', label: 'CML', data: cmlLine, borderColor: '#38bdf8', borderWidth: 2,
                  borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0 },
                { type: 'scatter', label: 'תיקים', data: pts, pointRadius: 7, pointHoverRadius: 9,
                  backgroundColor: ptColors, borderColor: '#0b0b0f', borderWidth: 1.5 },
                { type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot',
                  pointRadius: 10, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5 },
            ]
        },
        options: _scatterOpts('סיכון כולל σ (%)', 'תשואה צפויה (%)')
    });
}

// ── 4. SML chart ──

function _drawSMLChart(model) {
    const canvas = document.getElementById('smlChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const assets = Object.values(model.assets || {}).filter(a => a.hasData);
    const pts = assets.map(a => ({
        x: a.beta, y: a.expReturn * 100, name: a.ticker, rec: a.recommendation
    }));
    const marketPt = { x: 1, y: model.rm * 100, name: model.marketLabel };

    const maxBeta = Math.max(1.2, ...pts.map(p => p.x)) * 1.15;
    const minBeta = Math.min(0, ...pts.map(p => p.x));
    const rfPct = model.rf * 100;
    const smlAt = (b) => rfPct + b * (model.rm * 100 - rfPct);
    const smlLine = [{ x: minBeta, y: smlAt(minBeta) }, { x: maxBeta, y: smlAt(maxBeta) }];

    const ptColors = pts.map(p => rmRecColor(p.rec));

    _riskCharts.sml = new Chart(canvas.getContext('2d'), {
        data: {
            datasets: [
                { type: 'line', label: 'SML', data: smlLine, borderColor: '#38bdf8', borderWidth: 2,
                  borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0 },
                { type: 'scatter', label: 'נכסים', data: pts, pointRadius: 6, pointHoverRadius: 8,
                  backgroundColor: ptColors, borderColor: '#0b0b0f', borderWidth: 1 },
                { type: 'scatter', label: model.marketLabel, data: [marketPt], pointStyle: 'rectRot',
                  pointRadius: 9, backgroundColor: '#a855f7', borderColor: '#fff', borderWidth: 1.5 },
            ]
        },
        options: _scatterOpts('β (סיכון שיטתי)', 'תשואה צפויה (%)')
    });
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
            x: { title: { display: true, text: xLabel, color: '#94a3b8' },
                 ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.12)' } },
            y: { title: { display: true, text: yLabel, color: '#94a3b8' },
                 ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.12)' } }
        }
    };
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

if (typeof window !== 'undefined') {
    window.openRiskAnalysis = openRiskAnalysis;
    window.closeRiskAnalysis = closeRiskAnalysis;
    window.refreshRiskAnalysis = refreshRiskAnalysis;
}
