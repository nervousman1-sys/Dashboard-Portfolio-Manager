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
    LOOKBACK_DAYS: 756,           // 3 trading years — a long equal-weighted base so a recent
                                  // ATH spike is only ~a few % of the sample and can't dominate
                                  // the SML/CML positioning (this is the anti-momentum lever)
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
        // Tech / Communication
        'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'NFLX', 'AMD', 'ORCL',
        'CRM', 'ADBE', 'CSCO', 'QCOM', 'TXN', 'INTC', 'T', 'VZ',
        // Financials
        'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'SCHW', 'BLK',
        // Healthcare
        'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'AMGN', 'DHR',
        // Energy
        'XOM', 'CVX', 'COP', 'SLB', 'EOG',
        // Consumer staples / discretionary
        'PG', 'KO', 'PEP', 'COST', 'WMT', 'HD', 'MCD', 'NKE', 'SBUX', 'DIS', 'LOW',
        // Industrials
        'CAT', 'BA', 'HON', 'GE', 'UPS', 'RTX', 'UNP',
        // Materials / Utilities / Real estate (sector leaders)
        'LIN', 'SHW', 'FCX', 'ECL', 'NEM', 'NEE', 'SO', 'DUK', 'CEG', 'AEP',
        'PLD', 'AMT', 'EQIX', 'WELL', 'SPG',
        // Semis / global tech leaders + crypto-exposed
        'TSM', 'ASML', 'BRK-B', 'TMUS', 'COIN', 'MARA', 'RIOT', 'MSTR',
        'MU', 'LRCX', 'AMAT', 'ARM', 'KLAC', 'PLTR',
        // Broad / sector ETFs (every sector covered so each stock list is scannable)
        'QQQ', 'SPY', 'GLD', 'TLT', 'XLF', 'XLV', 'XLE', 'XLK', 'XLI', 'XLP',
        'XLY', 'XLC', 'XLB', 'XLU', 'XLRE', 'SOXX', 'SMH',
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
    // PERSISTED model (survives reload): if a stored model matches the exact same
    // holdings signature and is fresh, return it instantly — the CML/SML page then
    // renders with zero network work. Any buy/sell changes the signature → rebuild.
    if (!force && (!_riskModelCache.model || _riskModelCache.sig !== sig)) {
        const persisted = _rmLoadPersistedModel(sig);
        if (persisted) {
            _riskModelCache = { sig, ts: Date.now(), model: persisted };
            return persisted;
        }
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
        // FAST PATH: batch-prefetch every uncached ticker in ~2 same-origin requests
        // (instead of ~70 individual ones). The per-ticker loop below then resolves
        // almost entirely from the session cache.
        if (typeof prefetchTickerHistories === 'function') {
            try {
                await prefetchTickerHistories(tickers.map(t => ({ ticker: t, currency: tickerMeta[t].currency })), out);
            } catch (e) { /* per-ticker path covers it */ }
        }
        // Larger batches + a shorter gap: after prefetchTickerHistories warms the cache
        // these mostly resolve instantly, so we can push harder and cut the wait.
        const BATCH = 24;
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
            if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 25));
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
            const rawExpReturn = _rmMean(ownReturns) * RISK_MODEL.TRADING_DAYS; // equal-weight over the 3y base
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

        // If any portfolio's risky book is still mostly market-proxy (history not yet
        // loaded), the verdicts aren't final. Cache only briefly and DON'T persist, so
        // the next load recomputes with full data — and the verdict then stays put.
        model.partial = portfolios.some(p => p && p.partial);
        _riskModelCache = { sig, ts: model.partial ? (Date.now() - RISK_MODEL.CACHE_TTL + 20000) : Date.now(), model };
        if (!model.partial) _rmPersistModel(sig, model);
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

    let riskyMissingValue = 0; // value of STOCKS whose price history hasn't loaded yet
    for (const h of holdings) {
        const v = h._valueInDisplayCurrency != null ? h._valueInDisplayCurrency : (h.value || 0);
        totalValue += v;
        if (_rmIsRiskyHolding(h)) {
            if (assets[h.ticker] && assets[h.ticker].hasData) {
                riskyPositions.push({ ticker: h.ticker, value: v, a: assets[h.ticker] });
            } else {
                // A stock whose history failed/not-yet-loaded is NOT risk-free. Model it as
                // a neutral, fairly-priced market proxy (β=1, E[r]=Rm, α=0). This keeps the
                // verdict STABLE — a holding no longer flips between risk-free and risky
                // depending on whether a network fetch happened to succeed this run.
                riskyMissingValue += v;
                riskyPositions.push({ ticker: h.ticker, value: v, _proxy: true, a: { beta: 1, expReturn: rm, vol: marketVol, alpha: 0, requiredReturn: rm, hasData: false } });
            }
        } else {
            riskFreeWeightValue += v; // bond / cash → true risk-free leg
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
            else if (!closeMaps[pi.ticker] || !closeMaps[pj.ticker]) {
                rho = 0; // a proxy (data-less) position — assume uncorrelated for now
            } else {
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

    // Data coverage of the risky book. When too much of it is still market-proxy
    // (history not loaded), the verdict isn't final — flag it so the UI shows
    // "מחשב…" instead of a value that would later change with no portfolio change.
    const riskyTotalVal = riskyPositions.reduce((s, p) => s + p.value, 0);
    const coverage = riskyTotalVal > 0 ? (riskyTotalVal - riskyMissingValue) / riskyTotalVal : 1;
    const partial = coverage < 0.85;

    return {
        ...base, hasData: true, partial, coverage,
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

// ── Persisted model (localStorage) — instant CML/SML after a page reload ──
const _RM_PERSIST_KEY = 'risk_model_persist_v2'; // v2: expanded scan universe (sector leaders)
const _RM_PERSIST_TTL = 6 * 60 * 60 * 1000; // 6h — stats are 1Y dailies, intraday drift is negligible

function _rmPersistModel(sig, model) {
    const entry = { sig, ts: Date.now(), model };
    try {
        localStorage.setItem(_RM_PERSIST_KEY, JSON.stringify(entry));
    } catch (e) { /* localStorage full — skip persistence */ }
    // Cross-device: mirror to Supabase so a NEW computer gets the model instantly
    // instead of refetching ~70 ticker-years and recomputing (fire-and-forget).
    try {
        if (typeof supabaseClient !== 'undefined' && typeof supabaseConnected !== 'undefined' && supabaseConnected) {
            supabaseClient.auth.getUser().then(({ data: { user } }) => {
                if (!user) return;
                return supabaseClient.from('user_cache').upsert(
                    { user_id: user.id, key: 'risk_model', value: entry, updated_at: new Date().toISOString() },
                    { onConflict: 'user_id,key' });
            }).then(r => { if (r && r.error) console.warn('[RiskModel] cloud persist:', r.error.message); })
                .catch(() => { /* table missing / offline — local cache still works */ });
        }
    } catch (e) { /* non-fatal */ }
}

// Boot-time hydration: if this browser has no fresh local model, pull the one the
// user's other device computed today and seed localStorage BEFORE the first build.
async function rmHydrateModelFromCloud() {
    try {
        if (typeof supabaseClient === 'undefined') return;
        const raw = localStorage.getItem(_RM_PERSIST_KEY);
        if (raw) {
            const e = JSON.parse(raw);
            if (e && Date.now() - e.ts < _RM_PERSIST_TTL) return; // local is fresh
        }
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return;
        const { data, error } = await supabaseClient
            .from('user_cache').select('value').eq('user_id', user.id).eq('key', 'risk_model').maybeSingle();
        if (error || !data || !data.value) return;
        const entry = data.value;
        if (!entry.sig || !entry.model || Date.now() - entry.ts > _RM_PERSIST_TTL) return;
        localStorage.setItem(_RM_PERSIST_KEY, JSON.stringify(entry));
        console.log('[RiskModel] Hydrated model from cloud cache (cross-device)');
    } catch (e) { /* silent — model will just build normally */ }
}
if (typeof window !== 'undefined') window.rmHydrateModelFromCloud = rmHydrateModelFromCloud;

function _rmLoadPersistedModel(sig) {
    try {
        const raw = localStorage.getItem(_RM_PERSIST_KEY);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || entry.sig !== sig || !entry.model) return null;
        if (Date.now() - entry.ts > _RM_PERSIST_TTL) return null;
        console.log('[RiskModel] Instant model from persisted cache');
        return entry.model;
    } catch (e) { return null; }
}

// Drop the cached model so the next build is fresh. MUST be called after any change
// to holdings or cash (buy/sell/deposit/withdraw) — otherwise the CML/SML dot keeps
// showing the OLD portfolio because buildRiskModel returns the cached result.
function invalidateRiskModel() {
    _riskModelCache = { sig: null, ts: 0, model: null };
    _riskModelInflight = null;
    try { localStorage.removeItem(_RM_PERSIST_KEY); } catch (e) { /* ignore */ }
    if (typeof window !== 'undefined') window._lastRiskModel = null;
    // Drop the cloud mirror too — holdings changed, other devices must not rehydrate it
    try {
        if (typeof supabaseClient !== 'undefined' && typeof supabaseConnected !== 'undefined' && supabaseConnected) {
            supabaseClient.auth.getUser().then(({ data: { user } }) => {
                if (user) return supabaseClient.from('user_cache').delete().eq('user_id', user.id).eq('key', 'risk_model');
            }).catch(() => { });
        }
    } catch (e) { /* non-fatal */ }
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
            c.compliancePartial = p.partial;
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
// don't know). The exchange map covers the ENTIRE recommendation universe with the
// correct listing venue (a wrong venue shows Google's "no results" page). Anything
// NOT in the map falls back to the Google Finance SEARCH url (?q=) — Google then
// resolves the right quote page itself, so the link never dead-ends.
function googleFinanceUrl(ticker) {
    const t = String(ticker || '').toUpperCase().trim();
    if (!t) return 'https://www.google.com/finance';
    // Server-side smart redirect: Google Finance's beta UI no longer matches a static
    // exchange map (its own resolver maps e.g. WMT→WMT:NASDAQ), so /api/gf resolves
    // the working page via Google's resolver (map + search as fallbacks) and 302s.
    return `/api/gf?t=${encodeURIComponent(t)}`;
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

// ETFs / index funds — recommended in their OWN "תעודות סל" category, not among stocks.
const _RM_ETF_SET = new Set([
    'QQQ', 'QQQM', 'ONEQ', 'SPY', 'VOO', 'IVV', 'GLD', 'IAU', 'SGOL', 'GLDM', 'TLT', 'IEF', 'VGLT', 'GOVT', 'VGIT',
    'SHV', 'BIL', 'SGOV', 'IBIT', 'FBTC', 'GBTC', 'ARKB', 'SOXX', 'SMH', 'XSD', 'FTXL', 'AIQ', 'BOTZ', 'IRBO', 'ROBT',
    'VGT', 'IYW', 'FTEC', 'VFH', 'IYF', 'VHT', 'IYH', 'VDE', 'IYE', 'VCR', 'IYC', 'VDC', 'KXI', 'VIS', 'IYJ', 'VOX',
    'IYZ', 'VAW', 'IYM', 'VPU', 'IDU', 'VNQ', 'IYR',
]);

// Attach Fund/SML-CML/Technical sub-scores + the weighted Final Score (0–100) to each
// candidate, in place. Reads the platform's existing client-side caches:
//   • rep_scores_v1   → the financial-report score (0–100)  → Fundamental (40%)
//   • tech_scan_v3/il → MA200/WMA200 distance + weekly RSI  → Technical entry timing (20%)
//   • cross-sectional percentile of the de-biased α          → SML/CML (40%)
function _rmApplyFinalScore(cands, techOverride) {
    if (!cands || !cands.length) return cands;
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    let fund = {}, tech = {};
    try { fund = JSON.parse(localStorage.getItem('rep_scores_v1') || '{}'); } catch (e) { }
    try {
        const us = JSON.parse(localStorage.getItem('tech_scan_v3') || '{}');
        const il = JSON.parse(localStorage.getItem('tech_scan_il_v2') || '{}');
        tech = Object.assign({}, (us && us.data) || {}, (il && il.data) || {});
    } catch (e) { }
    // Freshly-fetched technicals (passed straight in) take priority over the cache —
    // avoids relying on a localStorage write that can silently fail when storage is full.
    if (techOverride) tech = Object.assign(tech, techOverride);

    // Cross-sectional percentile of α across the candidate pool (bounds any peak's
    // inflated reading and judges it RELATIVE to the rest of the universe).
    const sorted = cands.map(c => (c.alpha != null && isFinite(c.alpha)) ? c.alpha : 0).sort((a, b) => a - b);
    const n = sorted.length;
    const pctOf = (v) => {
        let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; }
        return n > 1 ? (lo - 1) / (n - 1) : 0.5;
    };

    for (const c of cands) {
        // SML/CML (40%) — de-biased α, ranked cross-sectionally
        const smlScore = 100 * clamp01(pctOf(c.alpha != null ? c.alpha : 0));
        // Fundamental (40%) — platform report score, neutral 50 if not yet cached
        const f = fund[c.ticker];
        const fundScore = (f && f.score != null && isFinite(f.score)) ? f.score : 50;
        // Technical (20%) — high = comfortable entry; penalise extension above the long-term
        // MAs and a hot weekly RSI (the direct ATH guard). Neutral 50 if no scan data.
        const t = tech[c.ticker];
        let techScore = 50, hasTech = false;
        if (t) {
            hasTech = true;
            const ma = t.ma || {};
            const dD = ma.d200dist != null ? ma.d200dist : null;   // % vs 200-day MA  (short res)
            const dW = ma.w200dist != null ? ma.w200dist : null;   // % vs 200-WEEK MA (long base — primary)
            const rsiW = t.rsiW != null ? t.rsiW : null;           // weekly RSI       (long res)
            const inFvg = !!((t.fvgM && t.fvgM.inside) || (t.fvgQ && t.fvgQ.inside)); // monthly/quarterly FVG
            const extW = clamp01((dW != null ? dW : 0) / 50);      // +50% above 200-week → full
            const rsiPen = clamp01(((rsiW != null ? rsiW : 50) - 65) / 20);  // weekly RSI 65→85
            const extD = clamp01((dD != null ? dD : 0) / 30);
            // WEIGHTED penalty — the high-resolution signals dominate (200-week MA 55%,
            // weekly RSI 30%, 200-day MA only 15%).
            let penalty = 0.55 * extW + 0.30 * rsiPen + 0.15 * extD;
            // Inside a monthly/quarterly fair-value gap = a recognised higher-TF support
            // zone → a better entry → ease the penalty.
            if (inFvg) penalty = Math.max(0, penalty - 0.20);
            techScore = (1 - clamp01(penalty)) * 100;
            c.techRsiW = rsiW; c.techDistD = dD; c.techDistW = dW; c.techFvg = inFvg;
            // Near-ATH = stretched far above the long-term base AND/OR hot weekly RSI.
            c.nearATH = (dW != null && dW >= 40) || (rsiW != null && rsiW >= 75);
        }
        c.hasTech = hasTech;
        // ETFs go in their OWN category, never mixed among the stocks.
        if (_RM_ETF_SET.has(c.ticker) || /^XL[A-Z]{1,3}$/.test(c.ticker)) { c.isETF = true; c.sector = 'תעודות סל'; }
        c.fundScore = Math.round(fundScore);
        c.smlScore = Math.round(smlScore);
        c.techScore = Math.round(techScore);
        let finalScore = 0.40 * fundScore + 0.40 * smlScore + 0.20 * techScore;
        // Hard ATH guard: actively push peak / near-peak names DOWN the list (not just a
        // soft 20% nudge) so they don't sit at the top even with a strong α.
        if (c.nearATH) finalScore -= 12;
        if (techScore <= 25) finalScore -= 8;
        c.finalScore = Math.round(Math.max(0, finalScore));
    }
    return cands;
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

    // ── PORTFOLIO-SPECIFIC FIT ──
    // The recommendations must differ per portfolio — not just "any name above the SML".
    // We score each candidate against THIS book: its sector gaps, its correlation to the
    // current holdings, and the beta move that brings IT toward the CML.
    const sectorWeights = {};
    for (const pos of positions) { const s = pos.sector || 'Other'; sectorWeights[s] = (sectorWeights[s] || 0) + pos.weight; }
    // Beta to ADD so the portfolio drifts toward the market/CML (β≈1): an aggressive
    // high-β book is balanced by lower-β names; an under-invested low-β book by names
    // with more market exposure. Direction is specific to each portfolio's own beta.
    const portBeta = (p.beta != null && isFinite(p.beta)) ? p.beta : 1;
    const desiredAddBeta = Math.max(0.5, Math.min(1.35, 2 - portBeta));

    const candidatesRanked = Object.values(model.assets)
        // Include every non-held name that isn't clearly over-priced (recommendation
        // !== 'avoid' already excludes α ≤ −1.2%). This gives a DEEP bench of options
        // per sector for the "בדוק אופציה חלופית" cycler; the fit-ranking still surfaces
        // the best first.
        .filter(a => a.hasData && !held.has(a.ticker) && a.alpha != null && a.recommendation !== 'avoid')
        .map(a => {
            const c = _avgCorrTo(a.ticker);
            const corr = (c == null) ? 0.35 : c;     // unknown correlation → assume mildly positive
            const price = (a.lastClose != null && a.lastClose > 0) ? a.lastClose : null;
            const shares = (price && total > 0) ? Math.max(1, Math.round((TARGET_ADD * total) / price)) : null;
            const pct = (shares && price && total > 0) ? (shares * price / total) * 100 : null;
            const secW = sectorWeights[a.sector] || 0;
            const sectorGap = Math.max(0, 0.18 - secW);   // reward sectors THIS book lacks
            const sectorOver = Math.max(0, secW - 0.22);  // penalty once a sector exceeds ~22%
            const betaMismatch = Math.abs((a.beta != null ? a.beta : 1) - desiredAddBeta);
            // Saturate alpha: past ~15% the marginal quality flattens. Without this, ONE
            // freak-alpha name (INTC showed +79.7%) dominates the linear score and wins
            // EVERY portfolio's list. Capped, the portfolio's own gaps decide instead.
            const alphaSat = Math.max(-0.02, Math.min(0.15, a.alpha));
            const fit =
                  0.60 * alphaSat                // SML quality — above the line (bounded)
                + 0.90 * sectorGap               // PRIMARY driver: fills a gap in THIS book
                - 0.70 * Math.max(0, corr)       // genuine diversification (low correlation)
                - 0.80 * sectorOver              // never pile into an already-heavy sector
                - 0.10 * betaMismatch;           // nudge the portfolio toward the CML (β≈1)
            return {
                ticker: a.ticker, name: a.name, sector: a.sector,
                alpha: a.alpha, beta: a.beta, vol: a.vol, corrToPort: c,
                price, shares, pct, sectorGap, betaMismatch, fit,
            };
        });
    // ── FINAL SCORE (40% fundamentals · 40% SML/CML · 20% technical) ──
    // Blends the de-biased SML α (cross-sectional) with the platform's fundamental
    // report score and a technical entry-timing score, so a name at its ATH (stretched
    // above MA200/WMA200 or hot weekly RSI, or richly valued) is pushed DOWN the list.
    _rmApplyFinalScore(candidatesRanked);
    candidatesRanked.sort((x, y) => (y.finalScore - x.finalScore) || (y.fit - x.fit));

    // Spread the shortlist across sectors (cap per sector) so every portfolio gets names
    // matched to ITS gaps, rather than 10 clones from the single highest-alpha sector.
    const _PER_SECTOR_CAP = 15;   // deep bench per sector → the swap button has many to cycle
    const _secCount = {};
    const candidates = [];
    for (const c of candidatesRanked) {
        const s = c.sector || 'Other';
        if ((_secCount[s] || 0) >= _PER_SECTOR_CAP) continue;
        _secCount[s] = (_secCount[s] || 0) + 1;
        candidates.push(c);
        if (candidates.length >= 150) break;
    }
    if (candidates.length < 6) { candidates.length = 0; candidates.push(...candidatesRanked.slice(0, 150)); }

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

    // 4. Quality upgrades — top best-fit names from DISTINCT sectors, with the reason
    //    THEY fit THIS book. Distinct sectors so the two picks aren't near-duplicates.
    const _planSectors = new Set();
    const planPicks = [];
    for (const c of candidates) {
        const s = c.sector || 'Other';
        if (_planSectors.has(s)) continue;
        _planSectors.add(s);
        planPicks.push(c);
        if (planPicks.length >= 2) break;
    }
    planPicks.forEach((c) => {
        const reasons = [];
        if (c.sectorGap > 0.05) reasons.push(`משלים חשיפה לסקטור <b>${c.sector || 'חדש'}</b> שחסר בתיק`);
        if (c.corrToPort != null && c.corrToPort < 0.4) reasons.push(`קורלציה נמוכה לאחזקות (ρ=${rmFmtNum(c.corrToPort, 2)}) — פיזור אמיתי`);
        if (c.betaMismatch < 0.25) reasons.push(`β=${rmFmtNum(c.beta, 2)} מקרב את התיק לקו ה-CML`);
        const why = reasons.length ? ` — ${reasons.join(', ')}` : '';
        actions.push({
            priority: 4, kind: 'buy',
            text: `שקול הוספת <b>${c.ticker}</b> (מעל ה-SML, α=${rmFmtPct(c.alpha, 1)})${why}.`
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
    const list = (adv.candidates || []).slice(0, 6); // inline preview; the popup uses the full bench
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
    window._rmApplyFinalScore = _rmApplyFinalScore;
    window.renderAdvisoryHTML = renderAdvisoryHTML;
    window.googleFinanceUrl = googleFinanceUrl;
    window.RISK_MODEL = RISK_MODEL;
}
