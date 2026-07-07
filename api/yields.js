// ========== Vercel Serverless Function — Yield Curves (US + Israel) ==========
//
//   /api/yields → { us: [{label,tenor,value,date}...], il: [...], asOf }
//
// US: full Treasury curve from FRED (mirrors the official US data; updated daily).
// IL: the reliably-published Israeli points — BOI policy rate (overnight),
//     3-month TELBOR interbank, and the 10-year government yield (OECD via FRED).

const FRED_KEY = process.env.FRED_API_KEY || 'f568440cde5cb64b20cd92e80292fbac';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

async function latest(id) {
    try {
        const r = await fetch(`${FRED_BASE}?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=4`,
            { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const obs = (j.observations || []).filter(o => o.value !== '.' && o.value !== '');
        return obs.length ? { value: parseFloat(obs[0].value), date: obs[0].date } : null;
    } catch (e) { return null; }
}

// BOI policy rate — pulled LIVE from the BOI PublicApi (authoritative). FRED's series lags,
// so we override the short end of the IL curve with the real current rate.
async function boiRateLive() {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
    try {
        const r = await fetch('https://www.boi.org.il/PublicApi/GetInterest', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: ac.signal });
        if (!r.ok) return null;
        const j = await r.json();
        const v = parseFloat(j.currentInterest);
        return isFinite(v) ? { value: v, date: (j.lastPublishedDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10) } : null;
    } catch (e) { return null; } finally { clearTimeout(t); }
}
// Fallback constant if the BOI PublicApi is unreachable (kept current as a safety net).
const IL_BOI_OVERRIDE = { value: 3.5, date: '2026-07-06' };

// ── Bank of Israel zero-coupon nominal yield curve (NSS model, daily) ──
// FRED only carries the Israeli 10Y (OECD, ~2-month lag). The full long end — 2/5/7/20/30Y —
// lives in the BOI's ZCM dataflow (series DWH_ZERO_NSS_N_SPOT_D_0NN, NN = years to maturity).
// Fetched live so the IL curve matches the US curve's tenor set. Graceful: any point that
// fails to fetch is simply omitted, so the curve never breaks.
const BOI_ZCM = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/ZCM/1.0';
const IL_LONG = [ // [hebrew label, years → series suffix]
    ['שנתיים (אג"ח ממשלתי)', 2], ['5 שנים (אג"ח ממשלתי)', 5],
    ['10 שנים (אג"ח ממשלתי)', 10], ['20 שנה (אג"ח ממשלתי)', 20], ['30 שנה (אג"ח ממשלתי)', 30],
];
async function boiZero(years) {
    const code = `DWH_ZERO_NSS_N_SPOT_D_${String(years).padStart(3, '0')}`;
    const url = `${BOI_ZCM}/${code}?lastNObservations=1&format=jsondata`;
    // Hard 4s cap: the BOI data gateway is currently unreliable — a hang here must never
    // slow /api/yields (the FRED-based short curve renders regardless).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
        const r = await fetch(url, { headers: { Accept: 'application/vnd.sdmx.data+json;version=2.0.0', 'User-Agent': 'Mozilla/5.0' }, signal: ac.signal });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || '';
        if (!/json/i.test(ct)) return null;               // gateway HTML error page → skip
        const j = await r.json();
        const ds = j && j.data && j.data.dataSets && j.data.dataSets[0];
        const obsDim = j.data.structure.dimensions.observation[0].values;
        const series = ds.series;
        const k = Object.keys(series)[0];
        if (!k) return null;
        const obs = series[k].observations;
        const ok = Object.keys(obs)[0];
        const value = obs[ok][0];
        return (value != null && isFinite(value)) ? { value: +(+value).toFixed(2), date: obsDim[+ok].id } : null;
    } catch (e) { return null; }
    finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const US = [
            ['1M', 'DGS1MO'], ['3M', 'DGS3MO'], ['6M', 'DGS6MO'], ['1Y', 'DGS1'],
            ['2Y', 'DGS2'], ['5Y', 'DGS5'], ['7Y', 'DGS7'], ['10Y', 'DGS10'],
            ['20Y', 'DGS20'], ['30Y', 'DGS30'],
        ];
        const IL = [
            ['ריבית בנק ישראל', 'IRSTCI01ILM156N'],
            ['3 חודשים (TELBOR)', 'IR3TIB01ILM156N'],
            ['10 שנים (אג"ח ממשלתי)', 'IRLTLT01ILM156N'],
        ];

        const [usVals, ilVals, boiLive] = await Promise.all([
            Promise.all(US.map(([, id]) => latest(id))),
            Promise.all(IL.map(([, id]) => latest(id))),
            boiRateLive(),
        ]);

        const us = US.map(([label], i) => usVals[i] ? { label, value: usVals[i].value, date: usVals[i].date } : null)
            .filter(Boolean);

        let il = IL.map(([label], i) => ilVals[i] ? { label, value: ilVals[i].value, date: ilVals[i].date } : null)
            .filter(Boolean);
        // Short end = the REAL current BOI policy rate (live PublicApi), falling back to the
        // dated override, then FRED. FRED's IL policy series lags, so prefer the live value.
        const boi = il.find(p => p.label === 'ריבית בנק ישראל');
        const boiSrc = boiLive || IL_BOI_OVERRIDE;
        if (boi && boiSrc && String(boiSrc.date) >= String(boi.date)) {
            boi.value = boiSrc.value;
            boi.date = boiSrc.date;
        } else if (!boi && boiSrc) {
            il.unshift({ label: 'ריבית בנק ישראל', value: boiSrc.value, date: boiSrc.date });
        }
        // Extend the IL curve with the BOI zero-coupon long end (2/5/10/20/30Y). When the BOI
        // data endpoint answers, this REPLACES the short 3-point curve with a full one; when it
        // doesn't, we keep the FRED-based points (BOI rate + 3M TELBOR + 10Y).
        try {
            const longVals = await Promise.all(IL_LONG.map(([, y]) => boiZero(y)));
            const long = IL_LONG.map(([label], i) => longVals[i] ? { label, value: longVals[i].value, date: longVals[i].date, src: 'boi' } : null).filter(Boolean);
            if (long.length >= 3) {
                // Keep the short anchors (BOI rate + TELBOR) and swap in the BOI long end.
                const shortPts = il.filter(p => p.label === 'ריבית בנק ישראל' || p.label === '3 חודשים (TELBOR)');
                il = shortPts.concat(long);
            }
        } catch (e) { /* keep the FRED-based IL points */ }

        const hasData = us.length >= 5;
        res.setHeader('Cache-Control', hasData ? 's-maxage=10800, stale-while-revalidate=86400' : 's-maxage=120');
        res.status(200).json({ us, il, asOf: new Date().toISOString().slice(0, 10) });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'yields_failed', message: e.message });
    }
};
