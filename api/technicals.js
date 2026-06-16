// ========== Vercel Serverless Function — Technical Scanner (SPY + QQQ) ==========
//
//   /api/technicals?mode=tickers
//       → { tickers: ['AAPL', ...], asOf }            (S&P 500 ∪ Nasdaq-100, cached 7d)
//   /api/technicals?mode=scan&symbols=A,B,C           (≤60 per call — client batches)
//       → { results: { AAPL: {price, rsiD, rsiW, ma:{d200,d300,w200,w300}, atr,
//                              atrPct, vol, volAvg, fvgM, fvgQ, ...flags}, ... } }
//
// Indicators (server-side, from Yahoo daily-2y + weekly-10y bars):
//   • RSI(14) Wilder — daily + weekly
//   • SMA 200/300 days and 200/300 weeks + % distance from price
//   • ATR(14) daily + as % of price
//   • Volume (last day) + 20-day average
//   • FVG (3-candle fair-value gaps) on MONTHLY and QUARTERLY bars (derived from
//     weekly), unfilled gaps only — flags whether the price is INSIDE one now.

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' };

// ── Constituents from Wikipedia (stable tables, server-side fetch) ──
async function fetchSP500() {
    const r = await fetch('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', { headers: { ...UA, Accept: 'text/html' } });
    const html = await r.text();
    const sect = html.split('id="constituents"')[1] || html;
    const out = new Set();
    const re = /<td>(?:<a[^>]*>)?([A-Z]{1,5}(?:\.[A-Z])?)(?:<\/a>)?<\/td>/g;
    // Symbols live in the first cell of each row; rows start after <tr>
    const rowRe = /<tr>\s*<td[^>]*>\s*(?:<a [^>]*>)?([A-Z][A-Z0-9.\-]{0,6})(?:<\/a>)?\s*<\/td>/g;
    let m;
    while ((m = rowRe.exec(sect)) !== null) out.add(m[1].replace('.', '-')); // BRK.B → BRK-B (Yahoo)
    return [...out];
}

async function fetchNasdaq100() {
    const r = await fetch('https://en.wikipedia.org/wiki/Nasdaq-100', { headers: { ...UA, Accept: 'text/html' } });
    const html = await r.text();
    const sect = html.split('id="constituents"')[1] || html;
    const out = new Set();
    const rowRe = /<tr>\s*<td[^>]*>\s*(?:<a [^>]*>)?([A-Z][A-Z0-9.\-]{0,6})(?:<\/a>)?\s*<\/td>/g;
    let m;
    while ((m = rowRe.exec(sect)) !== null) out.add(m[1].replace('.', '-'));
    return [...out];
}

// ── Israeli market: TA-125 constituents (Wikipedia) + index-tracking ETFs (Yahoo search) ──
// Yahoo symbol form is SYMBOL.TA; delisted/stale rows simply fail the chart fetch and drop.
async function fetchTA125() {
    const r = await fetch('https://en.wikipedia.org/wiki/TA-125_Index', { headers: { ...UA, Accept: 'text/html' } });
    const html = await r.text();
    const sect = (html.split(/id="Constituents"/)[1] || '').split('</table>')[0];
    const out = new Set();
    // Symbol cell sits between the name cell and the market-cap cell (starts with a digit)
    const re = /<\/td>\s*<td>([A-Z][A-Z0-9.]{1,9})\s*<\/td>\s*<td>[\d,]/g;
    let m;
    while ((m = re.exec(sect)) !== null) out.add(m[1] + '.TA');
    return [...out];
}

async function fetchILETFs() {
    const queries = ['TA-125', 'TA-35', 'TA-90', 'TA-Banks'];
    const out = new Set();
    for (const q of queries) {
        try {
            const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8`, { headers: UA });
            const j = await r.json();
            (j.quotes || [])
                .filter(x => x.exchange === 'TLV' && x.quoteType === 'ETF' && x.symbol)
                .slice(0, 4)
                .forEach(x => out.add(x.symbol));
        } catch (e) { /* skip query */ }
    }
    return [...out];
}

// ── Yahoo bars ──
async function yahooBars(symbol, range, interval) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp, q = res?.indicators?.quote?.[0];
    if (!ts || !q) return null;
    // TASE quotes arrive in agorot (ILA) — scale to shekels so prices read naturally
    const k = res?.meta?.currency === 'ILA' ? 0.01 : 1;
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
        const c = q.close[i], h = q.high[i], l = q.low[i], o = q.open[i], v = q.volume[i];
        if (c != null && h != null && l != null && isFinite(c)) {
            bars.push({ t: ts[i] * 1000, o: (o ?? c) * k, h: h * k, l: l * k, c: c * k, v: v || 0 });
        }
    }
    return bars.length ? bars : null;
}

// ── Indicator math ──
function sma(closes, n) {
    if (closes.length < n) return null;
    let s = 0;
    for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
    return s / n;
}

function rsi14(closes) {
    const n = 14;
    if (closes.length < n + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgG = gain / n, avgL = loss / n;
    for (let i = n + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgG = (avgG * (n - 1) + Math.max(d, 0)) / n;
        avgL = (avgL * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (avgL === 0) return 100;
    return 100 - 100 / (1 + avgG / avgL);
}

function atr14(bars) {
    const n = 14;
    if (bars.length < n + 1) return null;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i], pc = bars[i - 1].c;
        trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
    }
    let atr = trs.slice(0, n).reduce((s, x) => s + x, 0) / n;
    for (let i = n; i < trs.length; i++) atr = (atr * (n - 1) + trs[i]) / n;
    return atr;
}

// Aggregate weekly bars into calendar-month / quarter bars
function aggregate(bars, keyFn) {
    const map = new Map();
    for (const b of bars) {
        const k = keyFn(new Date(b.t));
        if (!map.has(k)) map.set(k, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
        else {
            const a = map.get(k);
            a.h = Math.max(a.h, b.h); a.l = Math.min(a.l, b.l); a.c = b.c;
        }
    }
    return [...map.values()];
}

// FVG: 3-candle gaps. Bullish gap = low[i] > high[i-2] → zone [high[i-2], low[i]];
// bearish = high[i] < low[i-2] → zone [high[i], low[i-2]].
// Fill rule (matches TradingView FVG indicators): a bullish gap is filled once a
// later candle trades DOWN through the whole zone (low ≤ zone bottom); a bearish
// gap once a later candle trades UP through it (high ≥ zone top). The previous
// rule demanded one candle covering the entire zone in both directions, which
// kept long-dead gaps "open" and flagged stocks that had no live FVG.
function fvgInside(bars, price) {
    const zones = [];
    for (let i = 2; i < bars.length; i++) {
        if (bars[i].l > bars[i - 2].h) zones.push({ lo: bars[i - 2].h, hi: bars[i].l, i, dir: 'bull' });
        else if (bars[i].h < bars[i - 2].l) zones.push({ lo: bars[i].h, hi: bars[i - 2].l, i, dir: 'bear' });
    }
    for (let z = zones.length - 1; z >= 0; z--) {
        const g = zones[z];
        let filled = false;
        for (let j = g.i + 1; j < bars.length; j++) {
            if (g.dir === 'bull' ? bars[j].l <= g.lo : bars[j].h >= g.hi) { filled = true; break; }
        }
        if (!filled && price >= g.lo && price <= g.hi) {
            return { inside: true, lo: +g.lo.toFixed(2), hi: +g.hi.toFixed(2), dir: g.dir };
        }
    }
    return { inside: false };
}

async function scanOne(sym) {
    const [daily, weekly, monthlyBars] = await Promise.all([
        yahooBars(sym, '2y', '1d'),
        yahooBars(sym, '10y', '1wk'),
        yahooBars(sym, '10y', '1mo'),
    ]);
    if (!daily || daily.length < 30) return null;
    const dCloses = daily.map(b => b.c);
    const price = dCloses[dCloses.length - 1];
    const wCloses = weekly ? weekly.map(b => b.c) : [];

    const d200 = sma(dCloses, 200), d300 = sma(dCloses, 300);
    const w200 = wCloses.length ? sma(wCloses, 200) : null;
    const w300 = wCloses.length ? sma(wCloses, 300) : null;
    const dist = (ma) => ma ? +(((price - ma) / ma) * 100).toFixed(2) : null;

    // TRUE monthly candles from Yahoo (exact OHLC, like TradingView); quarters are
    // exact 3-month aggregates of those. Weekly-derived bars distorted boundary
    // weeks' highs/lows → phantom FVG zones.
    const monthly = monthlyBars && monthlyBars.length
        ? monthlyBars
        : (weekly ? aggregate(weekly, d => `${d.getUTCFullYear()}-${d.getUTCMonth()}`) : []);
    const quarterly = monthly.length ? aggregate(monthly, d => `${d.getUTCFullYear()}-q${Math.floor(d.getUTCMonth() / 3)}`) : [];

    const atr = atr14(daily.slice(-120));
    const vols = daily.map(b => b.v).filter(v => v > 0);
    const volAvg = vols.length >= 20 ? vols.slice(-20).reduce((s, x) => s + x, 0) / 20 : null;

    return {
        price: +price.toFixed(2),
        rsiD: rsi14(dCloses.slice(-200)) != null ? +rsi14(dCloses.slice(-200)).toFixed(1) : null,
        rsiW: wCloses.length ? +(rsi14(wCloses.slice(-200)) ?? 0).toFixed(1) : null,
        ma: {
            d200: d200 ? +d200.toFixed(2) : null, d200dist: dist(d200),
            d300: d300 ? +d300.toFixed(2) : null, d300dist: dist(d300),
            w200: w200 ? +w200.toFixed(2) : null, w200dist: dist(w200),
            w300: w300 ? +w300.toFixed(2) : null, w300dist: dist(w300),
        },
        atr: atr ? +atr.toFixed(2) : null,
        atrPct: atr && price ? +((atr / price) * 100).toFixed(2) : null,
        vol: vols.length ? vols[vols.length - 1] : null,
        volAvg: volAvg ? Math.round(volAvg) : null,
        fvgM: fvgInside(monthly, price),
        fvgQ: fvgInside(quarterly, price),
    };
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const mode = req.query.mode || 'tickers';

        // mode=report — financial-statement report (delegated to shared lib so it
        // doesn't need its own serverless function; the project is at the 12-fn cap).
        if (mode === 'report') {
            const { fetchReport } = require('../lib/reports-data.js');
            const symbol = String(req.query.symbol || '').trim().toUpperCase();
            const market = (req.query.market || (symbol.endsWith('.TA') ? 'il' : 'us')).toLowerCase();
            if (!symbol) { res.status(400).json({ error: 'symbol required' }); return; }
            const yahooFirst = req.query.fast === '1' || req.query.src === 'yahoo';
            try {
                const data = await fetchReport(symbol, market, { yahooFirst });
                if (!data.quarters || !data.quarters.length) { res.status(404).json({ error: 'no data', symbol }); return; }
                res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
                res.status(200).json(data);
            } catch (e) {
                const kind = e.kind || 'error';
                const status = kind === 'limit' ? 429 : kind === 'nodata' ? 404 : 502;
                res.setHeader('Cache-Control', 's-maxage=60');
                res.status(status).json({ error: kind, message: String(e.message || e), symbol, market });
            }
            return;
        }

        if (mode === 'tickers') {
            const market = (req.query.market || 'us').toLowerCase();
            if (market === 'il') {
                const [stocks, etfs] = await Promise.all([fetchTA125(), fetchILETFs()]);
                const all = [...new Set([...stocks, ...etfs])].filter(t => /^[A-Z][A-Z0-9.\-]{2,14}$/.test(t)).sort();
                if (all.length < 50) throw new Error(`IL constituent parse too small: ${all.length}`);
                res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
                res.status(200).json({ tickers: all, ta125: stocks.length, etfs: etfs.length, asOf: new Date().toISOString().slice(0, 10) });
                return;
            }
            const [sp, ndx] = await Promise.all([fetchSP500(), fetchNasdaq100()]);
            const all = [...new Set([...sp, ...ndx])].filter(t => /^[A-Z][A-Z0-9\-]{0,6}$/.test(t)).sort();
            if (all.length < 100) throw new Error(`constituent parse too small: ${all.length}`);
            res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=2592000');
            res.status(200).json({ tickers: all, sp500: sp.length, ndx100: ndx.length, asOf: new Date().toISOString().slice(0, 10) });
            return;
        }

        // mode=scan
        const syms = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
        if (!syms.length) { res.status(400).json({ error: 'missing symbols' }); return; }
        const results = {};
        const CONC = 12;
        for (let i = 0; i < syms.length; i += CONC) {
            const chunk = syms.slice(i, i + CONC);
            const vals = await Promise.all(chunk.map(s => scanOne(s).catch(() => null)));
            chunk.forEach((s, j) => { if (vals[j]) results[s] = vals[j]; });
        }
        // Technicals move on daily bars — cache each batch for 6h
        res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
        res.status(200).json({ results, asOf: new Date().toISOString() });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'technicals_failed', message: e.message });
    }
};
