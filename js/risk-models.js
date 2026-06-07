// ========== RISK MODELS — CML / SML / Correlation / Auto-Risk Engine ==========
//
// This module is the analytical core of the platform. Everything the app
// classifies, charts, and recommends flows from the Modern Portfolio Theory /
// CAPM math implemented here.
//
// ── WHAT IT COMPUTES ──
//
//  Per asset (from ~1Y of daily closes):
//    • Expected return  E(R)   = mean(daily returns) × 252            (annualized)
//    • Volatility       σ       = std(daily returns) × √252           (annualized)
//    • Beta             β       = cov(asset, market) / var(market)    (systematic risk)
//    • Correlation      ρ       = cov(a,b) / (σa·σb)                   (vs market & pairwise)
//    • Required return  (SML)   = Rf + β·(Rm − Rf)                     (CAPM)
//    • Jensen's alpha   α       = E(R) − requiredReturn               (mis-pricing signal)
//    • Recommendation           = α above/below thresholds → buy / avoid / neutral
//
//  Per portfolio:
//    • Portfolio beta   βp      = Σ wᵢ·βᵢ
//    • Expected return  E(Rp)   = Σ wᵢ·E(Rᵢ)
//    • Volatility       σp      = √(wᵀ Σ w)   (full covariance matrix of risky holdings)
//    • Sharpe ratio             = (E(Rp) − Rf) / σp
//    • Position vs CML          = E(Rp) vs [Rf + Sharpe_market·σp]
//    • Auto risk level          = low / medium / high   (from βp and σp vs the market)
//
// ── REFERENCE ANCHORS (per product decision) ──
//    Market proxy        : S&P 500   (SPY)
//    Risk-free rate (Rf) : US 3-Month T-Bill (FRED DGS3MO), via /api/fred proxy,
//                          with a sane fallback if the proxy is unavailable.
//
// The module is intentionally dependency-light: it reuses the existing
// `_fetchTickerTimeSeries(ticker, currency, outputSize)` from synthetic-history.js
// for all price history (shared cache + provider waterfall + rate-limit guards).

// ========== CONFIG ==========

const RISK_MODEL = {
    MARKET_SYMBOL: 'SPY',          // S&P 500 ETF — broad, liquid, FMP/TwelveData friendly
    MARKET_CURRENCY: 'USD',
    MARKET_LABEL: 'S&P 500',
    LOOKBACK_DAYS: 260,            // ~1 trading year of daily closes
    TRADING_DAYS: 252,            // annualization factor
    RF_FALLBACK: 0.0435,          // 4.35% — used only if DGS3MO proxy is unreachable
    RF_SERIES: 'DGS3MO',          // FRED series: 3-Month Treasury (secondary market rate)
    // Jensen alpha thresholds (annualized) for the recommendation engine
    ALPHA_BUY: 0.02,             // α ≥ +2%  → undervalued (above SML) → recommend
    ALPHA_AVOID: -0.02,           // α ≤ −2%  → overvalued  (below SML) → not recommended
    MIN_POINTS: 30,               // minimum aligned observations to trust a statistic
    CACHE_TTL: 30 * 60 * 1000,    // 30 min model cache
};

// In-memory cache of the last computed model (keyed by a holdings signature)
let _riskModelCache = { sig: null, ts: 0, model: null };
let _riskModelInflight = null; // de-dupes concurrent builds

// Cached risk-free rate (resolved once per session unless forced)
let _cachedRf = null;
let _cachedRfTs = 0;

// ========== STATISTICS PRIMITIVES ==========

function _rmMean(arr) {
    if (!arr || arr.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

// Sample variance (n−1) — unbiased estimator for a return series
function _rmVariance(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    const m = _rmMean(arr);
    let s = 0;
    for (let i = 0; i < n; i++) { const d = arr[i] - m; s += d * d; }
    return s / (n - 1);
}

function _rmStd(arr) {
    return Math.sqrt(_rmVariance(arr));
}

// Sample covariance of two equal-length, date-aligned arrays
function _rmCovariance(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const ma = _rmMean(a), mb = _rmMean(b);
    let s = 0;
    for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
    return s / (n - 1);
}

function _rmCorrelation(a, b) {
    const sa = _rmStd(a), sb = _rmStd(b);
    if (sa === 0 || sb === 0) return 0;
    return _rmCovariance(a, b) / (sa * sb);
}

// Convert a chronological close vector → simple daily returns
function _rmClosesToReturns(closes) {
    const out = [];
    for (let i = 1; i < closes.length; i++) {
        const p0 = closes[i - 1], p1 = closes[i];
        if (p0 > 0 && p1 > 0) out.push(p1 / p0 - 1);
    }
    return out;
}

// ========== DATE ALIGNMENT ==========
// Two assets rarely share identical trading calendars (TASE vs NYSE, holidays,
// IPO dates). For any pairwise statistic (β, ρ, covariance) we must compare
// returns on the SAME days. We intersect dates, then compute returns over the
// common ordered date axis.

function _rmSeriesToMap(series) {
    const m = new Map();
    if (series) for (const p of series) {
        if (p && p.date && isFinite(p.close) && p.close > 0) m.set(p.date, p.close);
    }
    return m;
}

// Returns { ra, rb } — date-aligned return vectors for two close-maps.
function _rmAlignedReturns(mapA, mapB) {
    const common = [];
    for (const d of mapA.keys()) if (mapB.has(d)) common.push(d);
    common.sort(); // ISO dates sort chronologically as strings
    if (common.length < 2) return { ra: [], rb: [] };
    const ca = new Array(common.length), cb = new Array(common.length);
    for (let i = 0; i < common.length; i++) { ca[i] = mapA.get(common[i]); cb[i] = mapB.get(common[i]); }
    return { ra: _rmClosesToReturns(ca), rb: _rmClosesToReturns(cb) };
}

// ========== RISK-FREE RATE (Rf) ==========
// Source of truth: FRED DGS3MO (3-Month Treasury) via the /api/fred serverless
// proxy. FRED blocks browser CORS, so a same-origin proxy is required. If the
// proxy is unreachable (e.g. running the static site without the Vercel
// functions), we fall back to a recent realistic value so the model still runs.

async function getRiskFreeRate(forceRefresh = false) {
    // Manual override (settings / power users) takes precedence
    try {
        const override = parseFloat(localStorage.getItem('rf_override'));
        if (isFinite(override) && override > 0) return override / 100;
    } catch { /* ignore */ }

    if (!forceRefresh && _cachedRf !== null && (Date.now() - _cachedRfTs) < 6 * 60 * 60 * 1000) {
        return _cachedRf;
    }

    try {
        const res = await fetch(`/api/fred?series_id=${RISK_MODEL.RF_SERIES}&latest=1`, {
            headers: { 'Accept': 'application/json' }
        });
        if (res.ok) {
            const json = await res.json();
            // Proxy returns { value: <percent>, date: 'YYYY-MM-DD' } or FRED-native shape
            let pct = null;
            if (json && isFinite(json.value)) pct = parseFloat(json.value);
            else if (json && Array.isArray(json.observations)) {
                const valid = json.observations.filter(o => o.value !== '.' && o.value !== '');
                if (valid.length) pct = parseFloat(valid[valid.length - 1].value);
            }
            if (pct !== null && isFinite(pct) && pct >= 0 && pct < 25) {
                _cachedRf = pct / 100;
                _cachedRfTs = Date.now();
                console.log(`[RiskModel] Risk-free rate (DGS3MO) = ${pct}%`);
                return _cachedRf;
            }
        } else {
            console.warn(`[RiskModel] /api/fred returned HTTP ${res.status} — using fallback Rf`);
        }
    } catch (e) {
        console.warn('[RiskModel] Rf proxy unreachable — using fallback:', e.message);
    }

    _cachedRf = RISK_MODEL.RF_FALLBACK;
    _cachedRfTs = Date.now();
    return _cachedRf;
}

// ========== HOLDINGS COLLECTION ==========
// Eligible "risky" holdings are those with a ticker and price history: stocks,
// funds/ETFs, and index positions. Bonds and cash are treated as ~risk-free
// (β ≈ 0, return ≈ Rf, σ ≈ 0) when aggregating a portfolio.

function _rmIsRiskyHolding(h) {
    if (!h || !h.ticker) return false;
    if (h.type === 'stock' || h.type === 'fund' || h.type === 'index') return (h.shares || 0) > 0 || (h.value || 0) > 0;
    return false;
}

// Signature is based on portfolio STRUCTURE (tickers + share counts), not live
// value — so routine price ticks don't force an expensive model rebuild. The
// underlying price history is cached anyway; only buys/sells change the model.
function _rmHoldingsSignature(clientsList) {
    const parts = [];
    for (const c of clientsList) {
        const tk = (c.holdings || []).filter(_rmIsRiskyHolding).map(h => `${h.ticker}:${h.shares || 0}`);
        parts.push(`${c.id}=${tk.sort().join(',')}`);
    }
    return parts.sort().join('|');
}

// ========== CORE: BUILD THE FULL RISK MODEL ==========
//
// Fetches ~1Y of daily closes for every unique risky ticker across all
// portfolios plus the market proxy, then derives all per-asset and
// per-portfolio statistics in a single coherent pass.
//
// Returns a rich model object (see header) or a structured "empty" result.

async function buildRiskModel(clientsList, opts = {}) {
    const clients_ = clientsList || (typeof clients !== 'undefined' ? clients : []);
    const force = !!opts.force;

    const sig = _rmHoldingsSignature(clients_);
    if (!force && _riskModelCache.model && _riskModelCache.sig === sig
        && (Date.now() - _riskModelCache.ts) < RISK_MODEL.CACHE_TTL) {
        return _riskModelCache.model;
    }
    // De-dupe concurrent callers (e.g. dashboard + analysis page both trigger a build)
    if (_riskModelInflight && _riskModelCache.sig === sig) return _riskModelInflight;

    const build = (async () => {
        const rf = await getRiskFreeRate(force);

        // ── 1. Collect unique risky tickers across all portfolios ──
        const tickerMeta = {}; // ticker -> { currency, name, sector }
        for (const c of clients_) {
            for (const h of (c.holdings || [])) {
                if (!_rmIsRiskyHolding(h)) continue;
                if (!tickerMeta[h.ticker]) {
                    tickerMeta[h.ticker] = {
                        currency: h.currency || 'USD',
                        name: h.name || h.ticker,
                        sector: h.sector || (typeof SECTOR_MAP !== 'undefined' ? SECTOR_MAP[h.ticker] : null) || 'Other',
                    };
                }
            }
        }
        const tickers = Object.keys(tickerMeta);

        // ── 2. Fetch daily history for market + every ticker (batched, cached) ──
        const out = RISK_MODEL.LOOKBACK_DAYS;
        const marketSeries = await _fetchTickerTimeSeries(RISK_MODEL.MARKET_SYMBOL, RISK_MODEL.MARKET_CURRENCY, out);
        const marketMap = _rmSeriesToMap(marketSeries);
        const marketReturns = _rmClosesToReturns(
            [...marketMap.keys()].sort().map(d => marketMap.get(d))
        );
        const marketVar = _rmVariance(marketReturns);
        const rm = _rmMean(marketReturns) * RISK_MODEL.TRADING_DAYS;   // annualized market return
        const marketVol = _rmStd(marketReturns) * Math.sqrt(RISK_MODEL.TRADING_DAYS);

        const seriesMap = {};      // ticker -> [{date,close}]
        const closeMaps = {};      // ticker -> Map(date->close)
        const BATCH = 5;
        for (let i = 0; i < tickers.length; i += BATCH) {
            const batch = tickers.slice(i, i + BATCH);
            const results = await Promise.allSettled(
                batch.map(t => _fetchTickerTimeSeries(t, tickerMeta[t].currency, out))
            );
            for (let j = 0; j < results.length; j++) {
                if (results[j].status === 'fulfilled' && results[j].value && results[j].value.length > RISK_MODEL.MIN_POINTS) {
                    seriesMap[batch[j]] = results[j].value;
                    closeMaps[batch[j]] = _rmSeriesToMap(results[j].value);
                }
            }
            if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 250));
        }

        const marketOk = marketReturns.length > RISK_MODEL.MIN_POINTS && marketVar > 0;

        // ── 3. Per-asset statistics ──
        const assets = {};
        for (const t of tickers) {
            const cm = closeMaps[t];
            if (!cm) { assets[t] = _rmEmptyAsset(t, tickerMeta[t]); continue; }

            const ownReturns = _rmClosesToReturns([...cm.keys()].sort().map(d => cm.get(d)));
            const expReturn = _rmMean(ownReturns) * RISK_MODEL.TRADING_DAYS;
            const vol = _rmStd(ownReturns) * Math.sqrt(RISK_MODEL.TRADING_DAYS);

            let beta = 1, corrToMarket = 0;
            if (marketOk) {
                const { ra, rb } = _rmAlignedReturns(cm, marketMap); // ra=asset, rb=market
                if (ra.length > RISK_MODEL.MIN_POINTS) {
                    const cov = _rmCovariance(ra, rb);
                    const mv = _rmVariance(rb);
                    beta = mv > 0 ? cov / mv : 1;
                    corrToMarket = _rmCorrelation(ra, rb);
                }
            }

            const requiredReturn = rf + beta * (rm - rf);       // SML / CAPM
            const alpha = expReturn - requiredReturn;            // Jensen's alpha
            const sharpe = vol > 0 ? (expReturn - rf) / vol : 0;

            let recommendation = 'neutral';
            if (alpha >= RISK_MODEL.ALPHA_BUY) recommendation = 'buy';
            else if (alpha <= RISK_MODEL.ALPHA_AVOID) recommendation = 'avoid';

            assets[t] = {
                ticker: t,
                name: tickerMeta[t].name,
                sector: tickerMeta[t].sector,
                hasData: true,
                expReturn, vol, beta, corrToMarket,
                requiredReturn, alpha, sharpe, recommendation,
                points: ownReturns.length,
            };
        }

        // ── 4. Pairwise correlation matrix (assets with data only) ──
        const corrTickers = tickers.filter(t => closeMaps[t]);
        const matrix = corrTickers.map(() => new Array(corrTickers.length).fill(0));
        for (let i = 0; i < corrTickers.length; i++) {
            matrix[i][i] = 1;
            for (let j = i + 1; j < corrTickers.length; j++) {
                const { ra, rb } = _rmAlignedReturns(closeMaps[corrTickers[i]], closeMaps[corrTickers[j]]);
                const rho = ra.length > RISK_MODEL.MIN_POINTS ? _rmCorrelation(ra, rb) : 0;
                matrix[i][j] = rho;
                matrix[j][i] = rho;
            }
        }

        // ── 5. Per-portfolio aggregation ──
        const portfolios = clients_.map(c => _rmComputePortfolio(c, assets, closeMaps, { rf, rm, marketVol }));

        const model = {
            rf, rm, marketVol,
            marketSymbol: RISK_MODEL.MARKET_SYMBOL,
            marketLabel: RISK_MODEL.MARKET_LABEL,
            marketSharpe: marketVol > 0 ? (rm - rf) / marketVol : 0,
            asOf: new Date().toISOString(),
            assets,
            correlation: { tickers: corrTickers, matrix },
            portfolios,
            coverage: { requested: tickers.length, resolved: corrTickers.length },
            marketOk,
        };

        _riskModelCache = { sig, ts: Date.now(), model };
        return model;
    })();

    _riskModelInflight = build;
    try { return await build; }
    finally { if (_riskModelInflight === build) _riskModelInflight = null; }
}

function _rmEmptyAsset(ticker, meta) {
    return {
        ticker, name: meta.name, sector: meta.sector, hasData: false,
        expReturn: null, vol: null, beta: null, corrToMarket: null,
        requiredReturn: null, alpha: null, sharpe: null, recommendation: 'unknown', points: 0,
    };
}

// ========== PORTFOLIO AGGREGATION ==========
// Weights are over the FULL portfolio value (risky holdings + bonds + cash).
// Bonds & cash are modeled as the risk-free leg (β=0, return=Rf, σ=0), which is
// the standard CML treatment of a risk-free asset blended with the risky book.

function _rmComputePortfolio(client, assets, closeMaps, ctx) {
    const { rf, rm, marketVol } = ctx;
    const holdings = client.holdings || [];

    // Total value (display currency) — reuse FX-converted value if present
    let totalValue = 0;
    const riskyPositions = []; // { ticker, weight, beta, expReturn }
    let riskFreeWeightValue = 0; // value of bonds + cash treated as risk-free

    for (const h of holdings) {
        const v = h._valueInDisplayCurrency != null ? h._valueInDisplayCurrency : (h.value || 0);
        totalValue += v;
        if (_rmIsRiskyHolding(h) && assets[h.ticker] && assets[h.ticker].hasData) {
            riskyPositions.push({ ticker: h.ticker, value: v, a: assets[h.ticker] });
        } else {
            riskFreeWeightValue += v; // bond / cash / data-less position → risk-free leg
        }
    }
    // Client-level cash buckets (stored outside holdings)
    const cashUsd = client.cash?.usd || (client.cashBalance && !client.cash?.ils ? client.cashBalance : 0) || 0;
    const cashIls = client.cash?.ils || 0;
    const ilsRate = (typeof USD_ILS_RATE !== 'undefined' && USD_ILS_RATE > 0) ? USD_ILS_RATE : 3.7;
    const cashUsdEq = cashUsd + cashIls / ilsRate;
    totalValue += cashUsdEq;
    riskFreeWeightValue += cashUsdEq;

    const base = { id: client.id, name: client.name, totalValue };

    if (totalValue <= 0 || riskyPositions.length === 0) {
        // No risky exposure → effectively a cash/bond book: low risk, returns ≈ Rf
        return {
            ...base, hasData: riskyPositions.length > 0,
            beta: 0, expReturn: rf, vol: 0, sharpe: 0, alpha: 0,
            riskyPct: 0, aboveCML: false, riskScore: 0, risk: 'low', riskLabel: 'נמוך',
        };
    }

    // Weights over the full book
    let beta = 0, expReturn = 0;
    for (const p of riskyPositions) {
        const w = p.value / totalValue;
        beta += w * (p.a.beta != null ? p.a.beta : 1);
        expReturn += w * (p.a.expReturn != null ? p.a.expReturn : rf);
    }
    // Risk-free leg contributes weight×Rf to expected return, 0 to beta
    const rfWeight = riskFreeWeightValue / totalValue;
    expReturn += rfWeight * rf;

    // Portfolio variance via covariance matrix of the RISKY positions.
    // σ_ij = ρ_ij · σ_i · σ_j ; weights are the risky positions' share of total book.
    let variance = 0;
    for (let i = 0; i < riskyPositions.length; i++) {
        const pi = riskyPositions[i];
        const wi = pi.value / totalValue;
        const si = pi.a.vol != null ? pi.a.vol : 0;
        for (let j = 0; j < riskyPositions.length; j++) {
            const pj = riskyPositions[j];
            const wj = pj.value / totalValue;
            const sj = pj.a.vol != null ? pj.a.vol : 0;
            let rho;
            if (i === j) rho = 1;
            else {
                const { ra, rb } = _rmAlignedReturns(closeMaps[pi.ticker], closeMaps[pj.ticker]);
                rho = ra.length > RISK_MODEL.MIN_POINTS ? _rmCorrelation(ra, rb) : 0;
            }
            variance += wi * wj * si * sj * rho;
        }
    }
    const vol = Math.sqrt(Math.max(0, variance));
    const sharpe = vol > 0 ? (expReturn - rf) / vol : 0;
    const cmlReturn = rf + (marketVol > 0 ? (rm - rf) / marketVol : 0) * vol; // CML at σp
    const alpha = expReturn - cmlReturn; // distance above/below the CML
    const riskyPct = (1 - rfWeight) * 100;

    const { risk, riskLabel, riskScore } = classifyRisk(beta, vol, marketVol);

    return {
        ...base, hasData: true,
        beta, expReturn, vol, sharpe, alpha,
        riskyPct, aboveCML: expReturn >= cmlReturn,
        riskScore, risk, riskLabel,
    };
}

// ========== AUTO RISK CLASSIFICATION ==========
// Blends systematic risk (β vs the market) with total risk (σp vs market σ) into
// a 0–100 score, then buckets into low / medium / high. This REPLACES the old
// naive "% in stocks" heuristic with a model-grounded measure.
//
//   betaRatio = βp                (1.0 == market systematic risk)
//   volRatio  = σp / σ_market     (1.0 == market total risk)
//   score     = 50 · (0.55·betaRatio + 0.45·volRatio)   → ~50 means "market-like"
//
//   score < 38  → low      (clearly defensive vs the market)
//   score < 70  → medium
//   else        → high

function classifyRisk(beta, vol, marketVol) {
    const b = isFinite(beta) ? Math.max(0, beta) : 1;
    const vr = (marketVol > 0 && isFinite(vol)) ? vol / marketVol : 1;
    const raw = 50 * (0.55 * b + 0.45 * vr);
    const riskScore = Math.max(0, Math.min(100, Math.round(raw)));

    let risk, riskLabel;
    if (riskScore < 38) { risk = 'low'; riskLabel = 'נמוך'; }
    else if (riskScore < 70) { risk = 'medium'; riskLabel = 'בינוני'; }
    else { risk = 'high'; riskLabel = 'גבוה'; }
    return { risk, riskLabel, riskScore };
}

// ========== APPLY MODEL RISK TO CLIENTS (progressive enhancement) ==========
// Runs the async model in the background and upgrades each client's risk fields
// from the naive heuristic to the model-based classification, then re-renders.
// Safe to call repeatedly; cached + de-duped.

let _modelRiskApplying = false;
async function applyModelRiskToClients(opts = {}) {
    if (_modelRiskApplying && !opts.force) return;
    if (typeof clients === 'undefined' || !clients || clients.length === 0) return;
    _modelRiskApplying = true;
    try {
        const model = await buildRiskModel(clients, opts);
        if (!model || !model.portfolios) return;
        const byId = {};
        for (const p of model.portfolios) byId[p.id] = p;

        for (const c of clients) {
            const p = byId[c.id];
            if (!p || !p.hasData) continue;
            c.risk = p.risk;
            c.riskLabel = p.riskLabel;
            c.riskScore = p.riskScore;
            c.modelBeta = p.beta;
            c.modelExpReturn = p.expReturn;
            c.modelVol = p.vol;
            c.modelSharpe = p.sharpe;
            c.modelAlpha = p.alpha;
            c.aboveCML = p.aboveCML;
        }
        window._lastRiskModel = model;
        if (typeof refreshDashboard === 'function') refreshDashboard();
        else {
            if (typeof renderSummaryBar === 'function') renderSummaryBar();
            if (typeof renderClientCards === 'function') renderClientCards();
        }
        return model;
    } catch (e) {
        console.warn('[RiskModel] applyModelRiskToClients failed:', e.message);
    } finally {
        _modelRiskApplying = false;
    }
}

// ========== FORMAT HELPERS (shared by the analysis view) ==========

function rmFmtPct(v, digits = 1) {
    if (v == null || !isFinite(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${(v * 100).toFixed(digits)}%`;
}
function rmFmtNum(v, digits = 2) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(digits);
}
function rmRecLabel(rec) {
    switch (rec) {
        case 'buy': return 'מומלץ';
        case 'avoid': return 'לא מומלץ';
        case 'neutral': return 'ניטרלי';
        default: return 'אין נתונים';
    }
}
function rmRecColor(rec) {
    switch (rec) {
        case 'buy': return '#22c55e';
        case 'avoid': return '#ef4444';
        case 'neutral': return '#eab308';
        default: return '#64748b';
    }
}

// Expose for non-module consumers / debugging
if (typeof window !== 'undefined') {
    window.buildRiskModel = buildRiskModel;
    window.applyModelRiskToClients = applyModelRiskToClients;
    window.getRiskFreeRate = getRiskFreeRate;
    window.classifyRisk = classifyRisk;
    window.RISK_MODEL = RISK_MODEL;
}
