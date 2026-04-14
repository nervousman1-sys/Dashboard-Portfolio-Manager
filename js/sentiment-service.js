// ========== MARKET SENTIMENT SERVICE ==========
// Composite sentiment derived from REAL market data:
//   1. VIX (CBOE Volatility Index) — primary fear gauge (~40% weight)
//   2. S&P 500 daily change — market momentum (~20% weight)
//   3. CNN Fear & Greed Index via FMP — institutional composite (~40% weight)
// Falls back gracefully when any source is unavailable.
// Updates the header sentiment widget with label, bars, and color.

const _SENTIMENT_CACHE_KEY = 'finextium_sentiment_cache';
const _SENTIMENT_TTL = 15 * 60 * 1000; // 15 minutes

// ── VIX → Sentiment Score (0=extreme fear, 100=extreme greed) ──
function _vixToScore(vix) {
    // VIX thresholds (inverted — high VIX = fear):
    //   35+ → Extreme Fear (0-10)
    //   28-35 → Fear (10-25)
    //   20-28 → Neutral-Fear (25-40)
    //   15-20 → Neutral (40-60)
    //   12-15 → Greed (60-80)
    //   <12  → Extreme Greed (80-100)
    if (vix >= 40) return 0;
    if (vix >= 35) return 5 + (40 - vix) / 5 * 5;
    if (vix >= 28) return 10 + (35 - vix) / 7 * 15;
    if (vix >= 20) return 25 + (28 - vix) / 8 * 15;
    if (vix >= 15) return 40 + (20 - vix) / 5 * 20;
    if (vix >= 12) return 60 + (15 - vix) / 3 * 20;
    return 80 + Math.min((12 - vix) / 4, 1) * 20;
}

// ── S&P 500 daily change → Sentiment Score ──
function _spChangeToScore(changePct) {
    // >+2% → 90, +1% → 70, 0 → 50, -1% → 30, <-2% → 10
    const clamped = Math.max(-3, Math.min(3, changePct));
    return 50 + (clamped / 3) * 40;
}

// ── Score → Label + Config ──
function _scoreToSentiment(score) {
    if (score >= 80) return { label: 'EXTREME GREED', labelHe: 'חמדנות קיצונית', zone: 'extreme-greed', color: '#22c55e', barClass: 's-bar-green', bars: 5 };
    if (score >= 60) return { label: 'GREED',         labelHe: 'חמדנות',          zone: 'greed',         color: '#4ade80', barClass: 's-bar-green', bars: 4 };
    if (score >= 45) return { label: 'NEUTRAL',       labelHe: 'ניטרלי',          zone: 'neutral',       color: '#facc15', barClass: 's-bar-yellow', bars: 3 };
    if (score >= 25) return { label: 'FEAR',           labelHe: 'פחד',             zone: 'fear',          color: '#f87171', barClass: 's-bar-red',    bars: 2 };
    return                   { label: 'EXTREME FEAR',  labelHe: 'פחד קיצוני',      zone: 'extreme-fear',  color: '#ef4444', barClass: 's-bar-red',    bars: 1 };
}

// ── Fetch VIX quote from FMP ──
async function _fetchVIX() {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') return null;
    try {
        const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=%5EVIX&apikey=${FMP_API_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        const q = Array.isArray(data) ? data[0] : data;
        if (q && q.price > 0) {
            return { price: q.price, change: q.changesPercentage || 0, name: 'VIX' };
        }
    } catch (e) { console.warn('[Sentiment] VIX fetch failed:', e.message); }
    return null;
}

// ── Fetch S&P 500 quote from FMP ──
async function _fetchSP500() {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') return null;
    try {
        const res = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=%5EGSPC&apikey=${FMP_API_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        const q = Array.isArray(data) ? data[0] : data;
        if (q && q.price > 0) {
            return { price: q.price, change: q.changesPercentage || 0, name: 'S&P 500' };
        }
    } catch (e) { console.warn('[Sentiment] S&P 500 fetch failed:', e.message); }
    return null;
}

// ── Fetch CNN Fear & Greed from FMP (when available) ──
async function _fetchFearGreed() {
    if (!FMP_API_KEY || FMP_API_KEY === 'YOUR_FMP_API_KEY') return null;
    try {
        const res = await fetch(`https://financialmodelingprep.com/api/v4/fear-and-greed-index?apikey=${FMP_API_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        // FMP returns array with { value, valueClassification, timestamp }
        if (Array.isArray(data) && data.length > 0) {
            const latest = data[0];
            const score = parseFloat(latest.value);
            if (!isNaN(score) && score >= 0 && score <= 100) {
                return { score, classification: latest.valueClassification || '', date: latest.timestamp || '' };
            }
        }
    } catch (e) { console.warn('[Sentiment] Fear & Greed fetch failed:', e.message); }
    return null;
}

// ── Compute Composite Sentiment ──
async function computeMarketSentiment() {
    // Check cache first
    try {
        const cached = localStorage.getItem(_SENTIMENT_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (Date.now() - parsed._ts < _SENTIMENT_TTL) {
                console.log('[Sentiment] Using cached sentiment:', parsed.label, `(score: ${parsed.compositeScore})`);
                return parsed;
            }
        }
    } catch (_) {}

    // Fetch all signals in parallel
    const [vix, sp500, fearGreed] = await Promise.all([
        _fetchVIX(),
        _fetchSP500(),
        _fetchFearGreed()
    ]);

    console.log('[Sentiment] Raw signals:', {
        vix: vix ? `${vix.price} (${vix.change > 0 ? '+' : ''}${vix.change.toFixed(1)}%)` : 'unavailable',
        sp500: sp500 ? `${sp500.price.toFixed(0)} (${sp500.change > 0 ? '+' : ''}${sp500.change.toFixed(2)}%)` : 'unavailable',
        fearGreed: fearGreed ? `${fearGreed.score} (${fearGreed.classification})` : 'unavailable'
    });

    let totalWeight = 0;
    let weightedScore = 0;

    // Signal 1: VIX (weight 40%)
    if (vix) {
        const vixScore = _vixToScore(vix.price);
        weightedScore += vixScore * 0.4;
        totalWeight += 0.4;
    }

    // Signal 2: S&P 500 daily change (weight 20%)
    if (sp500) {
        const spScore = _spChangeToScore(sp500.change);
        weightedScore += spScore * 0.2;
        totalWeight += 0.2;
    }

    // Signal 3: CNN Fear & Greed via FMP (weight 40%)
    if (fearGreed) {
        weightedScore += fearGreed.score * 0.4;
        totalWeight += 0.4;
    }

    // Fallback: if no signals at all, return neutral
    if (totalWeight === 0) {
        return { compositeScore: 50, label: 'NEUTRAL', labelHe: 'ניטרלי', zone: 'neutral',
                 color: '#facc15', barClass: 's-bar-yellow', bars: 3,
                 signals: { vix: null, sp500: null, fearGreed: null },
                 source: 'fallback' };
    }

    // Normalize by actual weight collected
    const compositeScore = Math.round(weightedScore / totalWeight);
    const sentiment = _scoreToSentiment(compositeScore);

    const result = {
        compositeScore,
        ...sentiment,
        signals: {
            vix: vix ? { price: vix.price, score: Math.round(_vixToScore(vix.price)) } : null,
            sp500: sp500 ? { change: sp500.change, score: Math.round(_spChangeToScore(sp500.change)) } : null,
            fearGreed: fearGreed ? { score: fearGreed.score, classification: fearGreed.classification } : null
        },
        source: [vix && 'VIX', sp500 && 'S&P500', fearGreed && 'F&G'].filter(Boolean).join(' + '),
        _ts: Date.now()
    };

    // Cache result
    try { localStorage.setItem(_SENTIMENT_CACHE_KEY, JSON.stringify(result)); } catch (_) {}

    console.log(`[Sentiment] Composite: ${compositeScore}/100 → ${sentiment.label} (sources: ${result.source})`);
    return result;
}

// ── Update Header Widget ──
function updateSentimentWidget(sentiment) {
    const container = document.getElementById('headerSentiment');
    if (!container) return;

    const barsEl = container.querySelector('.sentiment-bars');
    const labelEl = container.querySelector('.sentiment-label');
    const subEl = container.querySelector('.sentiment-sub');

    if (!barsEl || !labelEl) return;

    // Update label
    labelEl.textContent = sentiment.label;
    labelEl.style.color = sentiment.color;

    // Update bars: show 1-5 bars depending on sentiment intensity
    // Fear = fewer bars (red), Greed = more bars (green), Neutral = medium (yellow)
    const maxBars = 5;
    let barsHTML = '';
    for (let i = 0; i < maxBars; i++) {
        const active = i < sentiment.bars;
        const barColor = active ? sentiment.barClass : 's-bar-dim';
        barsHTML += `<span class="s-bar ${barColor}"></span>`;
    }
    barsEl.innerHTML = barsHTML;

    // Update subtitle with score + source
    if (subEl) {
        const scoreText = `Score: ${sentiment.compositeScore}/100`;
        const sourceText = sentiment.source ? ` · ${sentiment.source}` : '';
        subEl.textContent = scoreText + sourceText;
    }

    // Update container border accent
    container.style.borderColor = sentiment.color + '33'; // 20% opacity
}

// ── Initialize: fetch and render ──
async function initSentiment() {
    try {
        const sentiment = await computeMarketSentiment();
        updateSentimentWidget(sentiment);

        // Store globally for other components
        window._marketSentiment = sentiment;
    } catch (e) {
        console.error('[Sentiment] Init failed:', e);
    }
}

// Auto-refresh every 15 minutes
function _startSentimentRefresh() {
    setInterval(async () => {
        try {
            // Clear cache to force fresh fetch
            localStorage.removeItem(_SENTIMENT_CACHE_KEY);
            const sentiment = await computeMarketSentiment();
            updateSentimentWidget(sentiment);
            window._marketSentiment = sentiment;
        } catch (_) {}
    }, _SENTIMENT_TTL);
}

// Boot
initSentiment().then(() => _startSentimentRefresh());
