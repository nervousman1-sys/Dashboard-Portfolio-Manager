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
    RF_FALLBACK: 0.038,           // ~3.8% — used only if DGS3MO proxy + CORS are unreachable
    RF_SERIES: 'DGS3MO',          // FRED series: 3-Month Treasury (secondary market rate)
    // Shrinkage of the raw 1-year mean toward CAPM (0=full CAPM, 1=raw history).
    // 0.5 halves the overfit so the frontier is realistic and consistent with the
    // portfolio's own position.
    RETURN_SHRINK: 0.5,
    // Jensen alpha thresholds (annualized) for the recommendation engine. Lower than
    // before because the shrunk alpha is ~half the raw alpha.
    ALPHA_BUY: 0.012,            // α ≥ +1.2% → undervalued (above SML) → recommend
    ALPHA_AVOID: -0.012,          // α ≤ −1.2% → overvalued  (below SML) → not recommended
    MIN_POINTS: 30,               // minimum aligned observations to trust a statistic
    CACHE_TTL: 30 * 60 * 1000,    // 30 min model cache
    // Liquid, diversified names always analyzed so the "add to portfolio" picker
    // has real, ranked candidates to choose from (across sectors).
    CANDIDATE_UNIVERSE: [
        'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'JPM', 'V', 'MA',
        'UNH', 'JNJ', 'LLY', 'XOM', 'CVX', 'PG', 'KO', 'COST', 'HD', 'WMT',
        'NFLX', 'AMD', 'QQQ', 'SPY', 'GLD', 'TLT', 'XLF', 'XLV', 'XLE', 'XLK',
    ],
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

// Convert a chronological close vector → simple daily returns.
// Daily returns are WINSORIZED to ±25%: a single-day move larger than that is
// almost always a stock split, an agurot/redenomination jump, or a data glitch —
// not a real return. Left unclipped, one such point makes the annualized mean and
// beta explode (e.g. 600% returns, squished axes). Clipping keeps the statistics
// — and therefore the CML/SML charts — sane and textbook-clean.
const _RM_RET_CLIP = 0.25;
function _rmClosesToReturns(closes) {
    const out = [];
    for (let i = 1; i < closes.length; i++) {
        const p0 = closes[i - 1], p1 = closes[i];
        if (p0 > 0 && p1 > 0) {
            let r = p1 / p0 - 1;
            if (r > _RM_RET_CLIP) r = _RM_RET_CLIP;
            else if (r < -_RM_RET_CLIP) r = -_RM_RET_CLIP;
            out.push(r);
        }
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

    const accept = (pct) => {
        if (pct !== null && isFinite(pct) && pct >= 0 && pct < 25) {
            _cachedRf = pct / 100;
            _cachedRfTs = Date.now();
            console.log(`[RiskModel] Risk-free rate (DGS3MO) = ${pct}%`);
            return true;
        }
        return false;
    };

    // Path 1: same-origin serverless proxy (Vercel)
    try {
        const res = await fetch(`/api/fred?series_id=${RISK_MODEL.RF_SERIES}&latest=1`, {
            headers: { 'Accept': 'application/json' }
        });
        if (res.ok) {
            const json = await res.json();
            let pct = null;
            if (json && isFinite(json.value)) pct = parseFloat(json.value);
            else if (json && Array.isArray(json.observations)) {
                const valid = json.observations.filter(o => o.value !== '.' && o.value !== '');
                if (valid.length) pct = parseFloat(valid[valid.length - 1].value);
            }
            if (accept(pct)) return _cachedRf;
        }
    } catch { /* try CORS fallback */ }

    // Path 2: direct FRED via public CORS proxy (works locally / pre-deploy)
    const key = (typeof FRED_API_KEY !== 'undefined') ? FRED_API_KEY : '';
    if (key) {
        const fredUrl = `https://api.stlouisfed.org/fred/series/observations` +
            `?series_id=${RISK_MODEL.RF_SERIES}&api_key=${key}&file_type=json&sort_order=desc&limit=1`;
        const wrappers = [
            (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
            (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        ];
        for (const wrap of wrappers) {
            try {
                const res = await fetch(wrap(fredUrl));
                if (!res.ok) continue;
                const json = await res.json();
                const obs = (json?.observations || []).filter(o => o.value !== '.' && o.value !== '');
                if (obs.length && accept(parseFloat(obs[0].value))) return _cachedRf;
            } catch { /* try next */ }
        }
    }

    console.warn('[RiskModel] Rf unreachable (proxy + CORS) — using fallback');
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
        // Always analyze a curated universe of liquid, diversified names so the
        // "suitable assets to add" picker is never empty — even for a single
        // portfolio. These are fetched + scored just like holdings; the advisory
        // surfaces the ones NOT already held with positive alpha.
        const _sectorOf = (t) => (typeof SECTOR_MAP !== 'undefined' && SECTOR_MAP[t]) ? SECTOR_MAP[t] : 'Other';
        for (const t of RISK_MODEL.CANDIDATE_UNIVERSE) {
            if (!tickerMeta[t]) tickerMeta[t] = { currency: 'USD', name: t, sector: _sectorOf(t) };
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
        // Yahoo (the primary history source) has no rate limit, so fetch in larger,
        // faster batches — the analysis loads noticeably quicker.
        const BATCH = 12;
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
            if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 60));
        }

        const marketOk = marketReturns.length > RISK_MODEL.MIN_POINTS && marketVar > 0;

        // ── 3. Per-asset statistics ──
        const assets = {};
        for (const t of tickers) {
            const cm = closeMaps[t];
            if (!cm) { assets[t] = _rmEmptyAsset(t, tickerMeta[t]); continue; }

            const _sortedDates = [...cm.keys()].sort();
            const ownReturns = _rmClosesToReturns(_sortedDates.map(d => cm.get(d)));
            const lastClose = _sortedDates.length ? cm.get(_sortedDates[_sortedDates.length - 1]) : null;
            const rawExpReturn = _rmMean(ownReturns) * RISK_MODEL.TRADING_DAYS;
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
            // Shrink the noisy 1-year mean halfway toward its CAPM-required return.
            // Raw historical means overfit (a winner looks like it returns 200%/yr),
            // which produces an unrealistically good frontier and pushes every real
            // portfolio far off the curve. Shrinking toward CAPM keeps the analysis
            // realistic and consistent (the market, β=1, is unchanged: CAPM = Rm).
            const expReturn = RISK_MODEL.RETURN_SHRINK * rawExpReturn + (1 - RISK_MODEL.RETURN_SHRINK) * requiredReturn;
            const alpha = expReturn - requiredReturn;            // Jensen's alpha (on the shrunk return)
            const sharpe = vol > 0 ? (expReturn - rf) / vol : 0;

            let recommendation = 'neutral';
            if (alpha >= RISK_MODEL.ALPHA_BUY) recommendation = 'buy';
            else if (alpha <= RISK_MODEL.ALPHA_AVOID) recommendation = 'avoid';

            assets[t] = {
                ticker: t,
                name: tickerMeta[t].name,
                sector: tickerMeta[t].sector,
                hasData: true,
                expReturn, rawExpReturn, vol, beta, corrToMarket, lastClose,
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

        // ── 6. Efficient frontier + tangency (the curve for the CML chart) ──
        let frontier = null;
        try { frontier = _rmBuildFrontier(assets, corrTickers, matrix, rf, rm); }
        catch (e) { console.warn('[RiskModel] frontier build failed:', e.message); }

        const model = {
            rf, rm, marketVol,
            marketSymbol: RISK_MODEL.MARKET_SYMBOL,
            marketLabel: RISK_MODEL.MARKET_LABEL,
            marketSharpe: marketVol > 0 ? (rm - rf) / marketVol : 0,
            asOf: new Date().toISOString(),
            assets,
            correlation: { tickers: corrTickers, matrix },
            frontier,
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
    let variance = 0, corrSum = 0, corrCount = 0;
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
                if (i < j) { corrSum += rho; corrCount++; }
            }
            variance += wi * wj * si * sj * rho;
        }
    }
    const vol = Math.sqrt(Math.max(0, variance));
    const sharpe = vol > 0 ? (expReturn - rf) / vol : 0;
    const cmlReturn = rf + (marketVol > 0 ? (rm - rf) / marketVol : 0) * vol; // CML at σp
    const alpha = expReturn - cmlReturn; // distance above/below the CML
    const riskyPct = (1 - rfWeight) * 100;
    const avgCorr = corrCount > 0 ? corrSum / corrCount : null;

    const { risk, riskLabel, riskScore } = classifyRisk(beta, vol, marketVol);

    // ── MODEL COMPLIANCE SCORE (0–100): how well the portfolio conforms to CML/SML ──
    const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
    const riskyWeightTotal = riskyPositions.reduce((s, p) => s + p.value, 0) / totalValue;

    // CML sub-score: portfolio Sharpe relative to the market Sharpe (the CML slope)
    const mSharpe = marketVol > 0 ? (rm - rf) / marketVol : 0;
    let cmlScore;
    if (mSharpe > 0) cmlScore = clamp((sharpe / mSharpe) * 100);
    else cmlScore = sharpe > 0 ? 100 : 0;

    // SML sub-score: value-weighted "fairness" of holdings (α≥0 good, far below = bad)
    let qSum = 0, wSum = 0;
    for (const p of riskyPositions) {
        const w = p.value / totalValue;
        const a = p.a.alpha != null ? p.a.alpha : 0;
        const q = Math.max(0, Math.min(1, 0.5 + a / 0.20)); // α=+10% → 1.0, α=−10% → 0
        qSum += w * q; wSum += w;
    }
    const smlScore = wSum > 0 ? clamp(100 * qSum / wSum) : 50;

    // Diversification sub-score: penalize concentration + high average correlation
    let hhi = 0;
    for (const p of riskyPositions) { const w = riskyWeightTotal > 0 ? (p.value / totalValue) / riskyWeightTotal : 0; hhi += w * w; }
    const topWeight = riskyPositions.length ? Math.max(...riskyPositions.map(p => p.value / totalValue)) : 0;
    const concScore = clamp(100 - Math.max(0, topWeight - 0.25) / 0.75 * 100);      // top holding >25% penalized
    const corrScore = avgCorr == null ? 70 : clamp(100 - Math.max(0, avgCorr - 0.3) / 0.7 * 100);
    const divScore = clamp(0.6 * concScore + 0.4 * corrScore);

    const complianceScore = clamp(0.40 * cmlScore + 0.40 * smlScore + 0.20 * divScore);
    const complianceLabel = complianceScore >= 75 ? 'עומד היטב' : complianceScore >= 50 ? 'עמידה חלקית' : 'לא עומד';

    return {
        ...base, hasData: true,
        beta, expReturn, vol, sharpe, alpha,
        riskyPct, aboveCML: expReturn >= cmlReturn,
        riskScore, risk, riskLabel,
        avgCorr, topWeight, hhi,
        complianceScore, complianceLabel, cmlScore, smlScore, divScore,
    };
}

// ========== EFFICIENT FRONTIER (Markowitz) ==========
// Builds the risky-asset efficient frontier (the curved "Markowitz bullet"), the
// global-minimum-variance point, and the tangency portfolio (where the CML touches
// the frontier — the optimal risky portfolio). Uses the closed-form solution with
// light covariance shrinkage for numerical stability.

function _matInverse(M) {
    const n = M.length;
    const A = M.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        if (Math.abs(A[piv][col]) < 1e-12) return null;
        const tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
        const d = A[col][col];
        for (let j = 0; j < 2 * n; j++) A[col][j] /= d;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = A[r][col];
            for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[col][j];
        }
    }
    return A.map(row => row.slice(n));
}
function _matVec(M, v) { return M.map(row => row.reduce((s, x, j) => s + x * v[j], 0)); }
function _vecDot(a, b) { return a.reduce((s, x, i) => s + x * b[i], 0); }

function _rmBuildFrontier(assets, tickers, matrix, rf, rm) {
    const usable = tickers.filter(t => assets[t] && assets[t].hasData && isFinite(assets[t].vol) && assets[t].vol > 0);
    if (usable.length < 2) return null;
    const idx = {}; tickers.forEach((t, i) => { idx[t] = i; });
    const n = usable.length;
    const E = usable.map(t => assets[t].expReturn);
    const sig = usable.map(t => assets[t].vol);

    // Covariance with shrinkage toward the diagonal (δ) → stable, invertible Σ
    const delta = 0.30;
    const S = [];
    for (let i = 0; i < n; i++) {
        S[i] = [];
        for (let j = 0; j < n; j++) {
            const rho = i === j ? 1 : (matrix[idx[usable[i]]][idx[usable[j]]] || 0) * (1 - delta);
            S[i][j] = rho * sig[i] * sig[j];
        }
    }
    const inv = _matInverse(S);
    if (!inv) return null;
    const ones = Array(n).fill(1);
    const Zi = _matVec(inv, ones);
    const Ze = _matVec(inv, E);
    const A = _vecDot(ones, Zi);
    const B = _vecDot(ones, Ze);
    const C = _vecDot(E, Ze);
    const D = A * C - B * B;
    if (!(A > 0) || !(D > 0)) return null;

    const muGmv = B / A, varGmv = 1 / A;

    // Tangency portfolio: w ∝ Σ⁻¹ (E − Rf·1)
    let tangency = null;
    const excess = E.map(e => e - rf);
    const Zt = _matVec(inv, excess);
    const denom = _vecDot(ones, Zt);
    if (Math.abs(denom) > 1e-9) {
        const w = Zt.map(x => x / denom);
        const muT = _vecDot(w, E);
        const varT = _vecDot(w, _matVec(S, w));
        if (varT > 0 && isFinite(muT)) tangency = { x: Math.sqrt(varT), y: muT };
    }

    // Sweep μ across BOTH branches around the GMV vertex → the textbook "bullet"
    // (a sideways parabola opening right). Span is bounded by the asset return
    // range and capped so noisy estimates can't produce an absurd curve.
    const minE = Math.min(...E), maxE = Math.max(...E, rm);
    const spanUp = Math.max(maxE - muGmv, 0.05);
    const spanDn = Math.max(muGmv - Math.min(minE, rf), 0.05);
    const span = Math.min(Math.max(spanUp, spanDn), 0.55); // cap at ±55%
    const lo = muGmv - span, hi = muGmv + span;
    const pts = [];
    const N = 60;
    for (let k = 0; k <= N; k++) {
        const mu = lo + (hi - lo) * (k / N);
        const v = (A * mu * mu - 2 * B * mu + C) / D;
        if (v > 0) {
            const s = Math.sqrt(v);
            if (s < 1.5) pts.push({ x: s, y: mu }); // ordered by μ → traces the bullet
        }
    }
    if (pts.length < 6) return null;

    // Keep tangency only if it sits in a sane region (else the optimizer chased noise)
    if (tangency && (tangency.x > 1.2 || tangency.y > hi * 1.2 || tangency.y < rf)) tangency = null;

    // Axis bounds derived from the FRONTIER itself (not the single most-volatile
    // asset) so the curve fills the chart width instead of being squished left.
    const maxPtX = Math.max(...pts.map(p => p.x));
    const bounds = {
        sigMax: Math.min(Math.max(maxPtX * 1.12, 0.15), 0.6),
        retMax: Math.min(Math.max(maxE * 1.12, hi * 1.04, 0.1), 1.2),
        retMin: Math.max(-0.55, Math.min(0, rf - 0.01, lo)),
    };

    return { points: pts, gmv: { x: Math.sqrt(varGmv), y: muGmv }, tangency, bounds };
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

// Drop the cached model so the next build is fresh. MUST be called after any change
// to holdings or cash (buy/sell/deposit/withdraw) — otherwise the CML/SML dot keeps
// showing the OLD portfolio because buildRiskModel returns the cached result.
function invalidateRiskModel() {
    _riskModelCache = { sig: null, ts: 0, model: null };
    _riskModelInflight = null;
    if (typeof window !== 'undefined') window._lastRiskModel = null;
}

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
            c.complianceScore = p.complianceScore;
            c.complianceLabel = p.complianceLabel;
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
// Google Finance deep-link for a ticker (so a manager can read up on a stock they
// don't know). Exchange map covers the recommendation universe; TASE → :TLV.
const _GF_EXCHANGE = {
    AAPL: 'NASDAQ', MSFT: 'NASDAQ', NVDA: 'NASDAQ', GOOGL: 'NASDAQ', AMZN: 'NASDAQ', META: 'NASDAQ',
    AVGO: 'NASDAQ', NFLX: 'NASDAQ', AMD: 'NASDAQ', COST: 'NASDAQ', QQQ: 'NASDAQ', TSLA: 'NASDAQ', PEP: 'NASDAQ', TLT: 'NASDAQ',
    JPM: 'NYSE', V: 'NYSE', MA: 'NYSE', UNH: 'NYSE', JNJ: 'NYSE', LLY: 'NYSE', XOM: 'NYSE', CVX: 'NYSE', PG: 'NYSE', KO: 'NYSE', HD: 'NYSE', WMT: 'NYSE',
    SPY: 'NYSEARCA', GLD: 'NYSEARCA', XLF: 'NYSEARCA', XLV: 'NYSEARCA', XLE: 'NYSEARCA', XLK: 'NYSEARCA',
};
function googleFinanceUrl(ticker) {
    const t = String(ticker || '').toUpperCase().trim();
    if (!t) return 'https://www.google.com/finance';
    if (/\.TA$/.test(t)) return `https://www.google.com/finance/quote/${t.replace(/\.TA$/, '')}:TLV`;
    const ex = _GF_EXCHANGE[t] || 'NASDAQ';
    return `https://www.google.com/finance/quote/${encodeURIComponent(t)}:${ex}`;
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

// ========== PER-PORTFOLIO ADVISORY (CML/SML review + actions) ==========
// Produces a structured, human-readable verdict for ONE portfolio:
//   • Does it sit on / above / below the CML (return per unit of total risk)?
//   • Which holdings fit the SML (fairly/under-priced) and which don't (over-priced)?
//   • What to REDUCE/SELL and what to BUY/ADD so the portfolio conforms to the models.

// Efficient-frontier σ (decimal) at a target return — the MINIMUM risk needed for
// that return. Interpolated along the efficient (upper) branch. Used to measure how
// far the portfolio is from the efficient region.
function _rmEfficientSigmaAt(fr, ret) {
    if (!fr || !fr.points || fr.points.length < 3) return null;
    const gmvY = fr.gmv ? fr.gmv.y : -Infinity;
    const eff = fr.points.filter(p => p.y >= gmvY - 1e-9).slice().sort((a, b) => a.y - b.y);
    if (eff.length < 2) return null;
    const r = Math.max(eff[0].y, Math.min(eff[eff.length - 1].y, ret));
    for (let i = 1; i < eff.length; i++) {
        if (eff[i].y >= r) {
            const a = eff[i - 1], b = eff[i];
            const t = (b.y - a.y) ? (r - a.y) / (b.y - a.y) : 0;
            return a.x + t * (b.x - a.x);
        }
    }
    return eff[eff.length - 1].x;
}

function _rmAvgPairwiseCorr(tickers, model) {
    const idx = {};
    (model.correlation?.tickers || []).forEach((t, i) => { idx[t] = i; });
    let sum = 0, n = 0;
    for (let i = 0; i < tickers.length; i++) {
        for (let j = i + 1; j < tickers.length; j++) {
            const a = idx[tickers[i]], b = idx[tickers[j]];
            if (a != null && b != null) { sum += model.correlation.matrix[a][b]; n++; }
        }
    }
    return n ? sum / n : null;
}

function buildPortfolioAdvisory(client, model) {
    if (!model || !model.portfolios) return null;
    const p = model.portfolios.find(x => x.id === client.id);
    if (!p) return null;

    const total = p.totalValue || 0;
    const positions = (client.holdings || [])
        .filter(h => _rmIsRiskyHolding(h) && model.assets[h.ticker] && model.assets[h.ticker].hasData)
        .map(h => {
            const a = model.assets[h.ticker];
            const v = h._valueInDisplayCurrency != null ? h._valueInDisplayCurrency : (h.value || 0);
            return {
                ticker: h.ticker, name: a.name, sector: a.sector,
                weight: total > 0 ? v / total : 0, value: v,
                beta: a.beta, expReturn: a.expReturn, alpha: a.alpha,
                recommendation: a.recommendation, corrToMarket: a.corrToMarket,
            };
        })
        .sort((x, y) => y.weight - x.weight);

    if (positions.length === 0) {
        return { hasRisky: false, p };
    }

    const cmlStatus = p.aboveCML ? (p.alpha >= 0.01 ? 'above' : 'on') : 'below';
    const fit = positions.filter(x => x.recommendation === 'buy');
    const notFit = positions.filter(x => x.recommendation === 'avoid');
    const neutral = positions.filter(x => x.recommendation === 'neutral');

    const topWeight = p.topWeight != null ? p.topWeight : positions[0].weight;
    const avgCorr = p.avgCorr != null ? p.avgCorr : _rmAvgPairwiseCorr(positions.map(x => x.ticker), model);
    const concentrated = topWeight > 0.30 || positions.length < 4;
    const highCorr = avgCorr != null && avgCorr > 0.55;

    // What to REDUCE — holdings below the SML (over-priced), worst first by impact
    const reduce = notFit.slice()
        .sort((a, b) => (b.weight * -b.alpha) - (a.weight * -a.alpha))
        .map(x => ({ ticker: x.ticker, name: x.name, weight: x.weight, alpha: x.alpha, beta: x.beta }));

    // What to ADD — suitable assets not already held, ranked by a FIT score that
    // rewards positive alpha (above SML) AND low correlation to the current book
    // (genuine diversification). Returns a selectable shortlist, not just 2 names.
    const held = new Set(positions.map(x => x.ticker));
    const corrIdx = {}; (model.correlation?.tickers || []).forEach((t, i) => { corrIdx[t] = i; });
    const heldTickers = positions.map(p => p.ticker);
    const _avgCorrTo = (ticker) => {
        const ti = corrIdx[ticker]; if (ti == null) return null;
        let s = 0, k = 0;
        for (const h of heldTickers) {
            const hi = corrIdx[h];
            if (hi != null && hi !== ti) { s += model.correlation.matrix[ti][hi]; k++; }
        }
        return k ? s / k : null;
    };
    const TARGET_ADD = 0.10; // size each suggested addition to ~10% of the portfolio
    const candidates = Object.values(model.assets)
        .filter(a => a.hasData && !held.has(a.ticker) && a.alpha != null && a.alpha > 0 && a.recommendation !== 'avoid')
        .map(a => {
            const c = _avgCorrTo(a.ticker);
            const price = (a.lastClose != null && a.lastClose > 0) ? a.lastClose : null;
            const shares = (price && total > 0) ? Math.max(1, Math.round((TARGET_ADD * total) / price)) : null;
            const pct = (shares && price && total > 0) ? (shares * price / total) * 100 : null;
            return {
                ticker: a.ticker, name: a.name, sector: a.sector,
                alpha: a.alpha, beta: a.beta, vol: a.vol, corrToPort: c,
                price, shares, pct,
                fit: a.alpha - 0.4 * (c == null ? 0.4 : Math.max(0, c)),
            };
        })
        .sort((x, y) => y.fit - x.fit)
        .slice(0, 6);

    // ── PRIORITIZED, QUANTIFIED ACTION PLAN (specific to THIS portfolio) ──
    const actions = [];
    const pct = (w) => Math.round(w * 100);

    // 1. Sell/trim each over-priced (below-SML) holding — highest priority
    reduce.forEach((x) => {
        const target = x.weight > 0.08 ? '≤5%' : 'מכירה מלאה';
        actions.push({
            priority: 1, kind: 'sell',
            text: `מכור/צמצם <b>${x.ticker}</b> — מתחת ל-SML (α=${rmFmtPct(x.alpha, 1)}, מתומחר ביתר). הקטן מ-${pct(x.weight)}% ל-${target}.`
        });
    });

    // 2. CML efficiency gap — add the market index building block
    if (p.cmlScore != null && p.cmlScore < 70) {
        const addW = p.cmlScore < 40 ? '25–30%' : '15–20%';
        actions.push({
            priority: 2, kind: 'buy',
            text: `הוסף <b>${model.marketLabel} (${model.marketSymbol})</b> כ-${addW} מהתיק — מקרב את התיק לקו ה-CML (Sharpe ${rmFmtNum(p.sharpe, 2)} מול ${rmFmtNum(model.marketSharpe, 2)} של השוק) ומפזר סיכון ספציפי.`
        });
    }

    // 3. Diversification — concentration / correlation
    if (concentrated) {
        actions.push({
            priority: 3, kind: 'diversify',
            text: `פזר ריכוזיות: האחזקה הגדולה (<b>${positions[0].ticker}</b>, ${pct(topWeight)}%) חורגת — הקטן ל-≤25% והוסף 2–3 נכסים נוספים.`
        });
    }
    if (highCorr) {
        actions.push({
            priority: 3, kind: 'diversify',
            text: `הקורלציה הממוצעת בין האחזקות גבוהה (ρ̄=${rmFmtNum(avgCorr, 2)}) — הוסף נכסים בקורלציה נמוכה/שלילית להקטנת σ ללא פגיעה בתשואה.`
        });
    }

    // 4. Quality upgrades — top 2 best-fit names (full list shown separately)
    candidates.slice(0, 2).forEach((c) => {
        actions.push({
            priority: 4, kind: 'buy',
            text: `שקול הוספת <b>${c.ticker}</b> — מעל ה-SML (α=${rmFmtPct(c.alpha, 1)}, β=${rmFmtNum(c.beta, 2)}), מועמד איכותי.`
        });
    });

    // 0. EFFICIENCY — measured against the CML (the efficient set). A portfolio is
    //    efficient iff it sits ON or ABOVE the CML, i.e. its return ≥ the CML return
    //    at its own σ. This is ONE coherent criterion that matches the chart (the
    //    dot is plotted at its true σ/return, so above-the-blue-line = efficient).
    let efficiency = null;
    if (p.vol != null && isFinite(p.vol)) {
        const mSharpe = model.marketSharpe || 0;
        const cmlReturn = model.rf + mSharpe * p.vol;          // CML return at σ_p
        const returnGap = cmlReturn - p.expReturn;             // >0 ⇒ below CML (inefficient)
        const isEfficient = returnGap <= 0.005;
        const wM = (model.rm - model.rf) !== 0 ? (p.expReturn - model.rf) / (model.rm - model.rf) : null;
        const wMarket = (wM != null) ? Math.max(0, Math.min(1.3, wM)) : null;
        efficiency = { isEfficient, portfolioSigma: p.vol, portfolioReturn: p.expReturn, cmlReturn, returnGap, sharpe: p.sharpe, marketSharpe: mSharpe, wMarket };
        if (!isEfficient) {
            actions.push({
                priority: 0, kind: 'efficient',
                text: `התיק <b>מתחת לקו ה-CML</b> (לא יעיל) — בסיכון σ=${rmFmtPct(p.vol, 1)} מקבל תשואה ${rmFmtPct(p.expReturn, 1)}, בעוד שעל הקו ניתן ${rmFmtPct(cmlReturn, 1)} באותו סיכון (פער ${rmFmtPct(returnGap, 1)}). יש להזיזו לאיזור היעיל.`
            });
            if (wMarket != null && wMarket > 0.02) {
                actions.push({
                    priority: 0, kind: 'efficient',
                    text: `איזון יעיל (CML) לאותה תשואה: כ-<b>${Math.round(wMarket * 100)}%</b> מדד שוק (${model.marketSymbol}) + <b>${Math.round(Math.max(0, 1 - wMarket) * 100)}%</b> אג"ח קצר/מזומן — אותה תשואה בסיכון נמוך יותר.`
                });
            }
        }
    }

    // 5. If already compliant — maintenance note
    if (actions.length === 0) {
        actions.push({
            priority: 5, kind: 'hold',
            text: `התיק עומד היטב במודל ונמצא באיזור היעיל — שמור על ההרכב, אזן תקופתית כדי לשמר את ה-β והפיזור.`
        });
    }
    actions.sort((a, b) => a.priority - b.priority);

    return {
        hasRisky: true, p, cmlStatus, efficiency,
        fit, notFit, neutral, reduce, candidates, actions,
        topWeight, avgCorr, concentrated, highCorr,
        complianceScore: p.complianceScore, complianceLabel: p.complianceLabel,
        cmlScore: p.cmlScore, smlScore: p.smlScore, divScore: p.divScore,
        rf: model.rf, rm: model.rm, marketSharpe: model.marketSharpe,
        marketSymbol: model.marketSymbol, marketLabel: model.marketLabel,
    };
}

// Renders the advisory object to HTML. `compact` trims it for the portfolio modal.
function renderAdvisoryHTML(adv, opts = {}) {
    if (!adv) return '<div class="adv-empty">אין מספיק נתונים לניתוח CML/SML עבור תיק זה.</div>';
    const compact = !!opts.compact; // modal view — trims to fit one screen (no candidate grid)
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (!adv.hasRisky) {
        return `<div class="adv-block"><div class="adv-verdict adv-low">
            <span class="adv-verdict-dot"></span>תיק מזומן/אג"ח — סיכון נמוך (β≈0), אין חשיפה מנייתית לניתוח SML.</div>
            <p class="adv-note">כדי שהתיק יעמוד על קו ה-CML עם תשואה גבוהה יותר, יש לשלב חשיפה למדד השוק (${esc(adv.marketLabel || 'S&P 500')}) בהתאם לרמת הסיכון הרצויה.</p></div>`;
    }

    const p = adv.p;
    const score = adv.complianceScore != null ? adv.complianceScore : 0;
    const scoreColor = score >= 75 ? 'var(--risk-low)' : score >= 50 ? 'var(--accent-yellow)' : 'var(--risk-high)';
    const list = (arr) => arr.length
        ? arr.map(x => `<span class="adv-chip" title="β=${rmFmtNum(x.beta,2)} · α=${rmFmtPct(x.alpha,1)}">${esc(x.ticker)}</span>`).join(' ')
        : '<span class="adv-dim">—</span>';

    const subBar = (label, val) => {
        const c = val >= 75 ? 'var(--risk-low)' : val >= 50 ? 'var(--accent-yellow)' : 'var(--risk-high)';
        return `<div class="adv-sub"><span class="adv-sub-label">${label}</span>
            <div class="adv-sub-track"><div class="adv-sub-fill" style="width:${val}%;background:${c}"></div></div>
            <span class="adv-sub-val">${val}</span></div>`;
    };

    const kindIcon = (k) => k === 'sell' ? '🔻' : k === 'buy' ? '🟢' : k === 'diversify' ? '🧩' : k === 'efficient' ? '◎' : k === 'hold' ? '✓' : '•';
    const actionsHTML = (adv.actions || []).map(a =>
        `<li class="adv-act adv-act-${a.kind}"><span class="adv-act-ic">${kindIcon(a.kind)}</span><span>${a.text}</span></li>`
    ).join('');

    // Efficiency verdict — ONE coherent message (CML-based), consistent with the
    // chart (the dot is at its true σ/return → above the CML line = efficient).
    const eff = adv.efficiency;
    const effBlock = eff ? `
        <div class="adv-eff ${eff.isEfficient ? 'eff-ok' : 'eff-bad'}">
            <span class="adv-eff-dot"></span>
            <div class="adv-eff-txt">
                <div class="adv-eff-title">${eff.isEfficient ? 'התיק על/מעל קו ה-CML — באיזור היעיל ✓' : 'התיק מתחת לקו ה-CML — לא יעיל ✗'}</div>
                <div class="adv-eff-sub">${eff.isEfficient
                    ? `יחס תשואה/סיכון עדיף או שווה לשוק: Sharpe ${rmFmtNum(eff.sharpe, 2)} מול ${rmFmtNum(eff.marketSharpe, 2)}. זהו האיזור האופטימלי — תשואה מרבית לרמת הסיכון.`
                    : `בסיכון σ=${rmFmtPct(eff.portfolioSigma, 1)} מתקבלת תשואה ${rmFmtPct(eff.portfolioReturn, 1)}, בעוד שעל קו ה-CML ניתן ${rmFmtPct(eff.cmlReturn, 1)} (פער ${rmFmtPct(eff.returnGap, 1)}). Sharpe ${rmFmtNum(eff.sharpe, 2)} מול ${rmFmtNum(eff.marketSharpe, 2)} של השוק — ראה תוכנית האיזון למטה.`}</div>
            </div>
        </div>` : '';

    return `
    <div class="adv-block">
        <div class="adv-scorebar">
            <div class="adv-score-ring" style="--c:${scoreColor};--c-pct:${score}">
                <div class="adv-score-inner">
                    <span class="adv-score-num">${score}</span>
                    <span class="adv-score-den">מתוך 100</span>
                </div>
            </div>
            <div class="adv-score-meta">
                <div class="adv-score-title" style="color:${scoreColor}">עמידה במודל: ${esc(adv.complianceLabel || '')}</div>
                ${subBar('CML (יעילות)', adv.cmlScore != null ? adv.cmlScore : 0)}
                ${subBar('SML (איכות נכסים)', adv.smlScore != null ? adv.smlScore : 0)}
                ${subBar('פיזור', adv.divScore != null ? adv.divScore : 0)}
            </div>
        </div>

        ${effBlock}

        <div class="adv-metaline">
            <span>β=<b>${rmFmtNum(p.beta,2)}</b></span>
            <span>תשואה צפויה=<b>${rmFmtPct(p.expReturn,1)}</b></span>
            <span>σ=<b>${rmFmtPct(p.vol,1)}</b></span>
            <span>Sharpe=<b>${rmFmtNum(p.sharpe,2)}</b></span>
            <span>רמת סיכון=<b>${p.riskLabel}</b></span>
        </div>
        <div class="adv-fitrow">
            <div class="adv-fit"><span class="adv-fit-h adv-fit-good">מתאימים (מעל/על SML)</span>${list(adv.fit.concat(adv.neutral))}</div>
            <div class="adv-fit"><span class="adv-fit-h adv-fit-bad">לא מתאימים (מתחת ל-SML)</span>${list(adv.notFit)}</div>
        </div>
        <div class="adv-plan">
            <div class="adv-action-h">תוכנית פעולה — מה לשנות כדי לעמוד במודל</div>
            <ol class="adv-act-list">${actionsHTML}</ol>
        </div>
        ${(adv.candidates && adv.candidates.length && !opts.noCandidates)
            ? (compact
                ? `<details class="adv-cands-details"><summary>מניות מומלצות להוספה לתיק האופטימלי (${adv.candidates.length})</summary>${_rmRenderCandidates(adv, opts.clientId)}</details>`
                : _rmRenderCandidates(adv, opts.clientId))
            : ''}
    </div>`;
}

// Selectable shortlist of suitable assets to ADD to the portfolio (ranked by fit:
// positive alpha + low correlation to current holdings). Lets the user choose.
function _rmRenderCandidates(adv, clientId) {
    const list = adv.candidates || [];
    if (!list.length) return '';
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
    const clickable = clientId != null;
    const rows = list.map(c => {
        const onclick = clickable
            ? `onclick="addCandidateToPortfolio(${clientId}, '${esc(c.ticker)}')" role="button" tabindex="0"`
            : '';
        const buyLine = (c.shares != null)
            ? `<div class="adv-cand-buy">קנה ≈ <b>${c.shares.toLocaleString('en-US')}</b> מניות (~${c.pct.toFixed(0)}%)</div>`
            : '';
        return `
        <div class="adv-cand${clickable ? ' adv-cand-click' : ''}" ${onclick}>
            <div class="adv-cand-top">
                <span class="adv-cand-tk">${esc(c.ticker)}</span>
                <a class="adv-cand-gf" href="${googleFinanceUrl(c.ticker)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="מידע על המנייה בגוגל פיננס">Google Finance ↗</a>
            </div>
            <div class="adv-cand-sector">${esc(c.sector || '')}</div>
            ${buyLine}
            <div class="adv-cand-stats">
                <span title="אלפא">α <b class="pos">${rmFmtPct(c.alpha, 1)}</b></span>
                <span title="ביטא">β <b>${rmFmtNum(c.beta, 2)}</b></span>
                <span title="סטיית תקן">σ <b>${rmFmtPct(c.vol, 0)}</b></span>
                <span title="קורלציה לתיק">ρ <b>${c.corrToPort == null ? '—' : rmFmtNum(c.corrToPort, 2)}</b></span>
            </div>
            ${clickable ? '<div class="adv-cand-add">+ הוסף לתיק</div>' : ''}
        </div>`;
    }).join('');
    return `
        <div class="adv-plan adv-cands">
            <div class="adv-action-h">נכסים מתאימים להוספה — בחר להוספה לתיק</div>
            <p class="adv-cands-hint">מדורג לפי אלפא (מעל ה-SML) + קורלציה נמוכה לתיק (פיזור) — מקרב את התיק לחלק האופטימלי בעקומה. ρ נמוך = מגוון יותר.</p>
            <div class="adv-cand-grid">${rows}</div>
        </div>`;
}

// Expose for non-module consumers / debugging
if (typeof window !== 'undefined') {
    window.buildRiskModel = buildRiskModel;
    window.applyModelRiskToClients = applyModelRiskToClients;
    window.invalidateRiskModel = invalidateRiskModel;
    window.getRiskFreeRate = getRiskFreeRate;
    window.classifyRisk = classifyRisk;
    window.buildPortfolioAdvisory = buildPortfolioAdvisory;
    window.renderAdvisoryHTML = renderAdvisoryHTML;
    window.googleFinanceUrl = googleFinanceUrl;
    window.RISK_MODEL = RISK_MODEL;
}
