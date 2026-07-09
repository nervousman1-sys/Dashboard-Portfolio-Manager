// ========== Vercel Serverless Function — Macro Aggregator (US + Israel) ==========
//
// One reliable, server-side source of CURRENT macro data, so the browser never has
// to juggle flaky public CORS proxies / BOI SDMX. Everything is fetched server-side
// (no CORS) and returned as a clean keyed object the macro UI can render directly.
//
//   /api/macro
//     → { us: { fed_rate:{value,previous,trend,date,...}, cpi:{...}, ... },
//         il: { boi_rate:{...}, il_cpi:{...}, il_unemployment:{...}, il_bond10y:{...} },
//         asOf: 'YYYY-MM-DD' }
//
// Sources: FRED (St. Louis Fed) for US + Israeli rates/unemployment/yields;
//          Israel CBS (api.cbs.gov.il) for the current Israeli CPI (YoY).

const FRED_KEY = process.env.FRED_API_KEY || 'f568440cde5cb64b20cd92e80292fbac';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

async function fredSeries(id, units) {
    try {
        const url = `${FRED_BASE}?series_id=${id}&api_key=${FRED_KEY}&file_type=json` +
            `&sort_order=desc&limit=2&units=${units || 'lin'}`;
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const obs = (j.observations || []).filter(o => o.value !== '.' && o.value !== '');
        if (!obs.length) return null;
        return {
            value: parseFloat(obs[0].value),
            previous: obs[1] ? parseFloat(obs[1].value) : null,
            date: obs[0].date,
            prevDate: obs[1] ? obs[1].date : null,
        };
    } catch (e) { return null; }
}

// Israel CPI (YoY) from the Central Bureau of Statistics — current, authoritative.
async function israelCPI() {
    try {
        const r = await fetch('https://api.cbs.gov.il/index/data/price?id=120010&format=json&download=false&last=14',
            { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        const dates = (j.month && j.month[0] && j.month[0].date) || [];
        if (!dates.length) return null;
        const sorted = dates.slice().sort((a, b) => (b.year - a.year) || (b.month - a.month));
        const ymd = (o) => `${o.year}-${String(o.month).padStart(2, '0')}-01`;
        const latest = sorted[0], prev = sorted[1] || null;
        if (latest.percentYear == null) return null;
        return {
            value: latest.percentYear,
            previous: prev ? prev.percentYear : null,
            date: ymd(latest),
            prevDate: prev ? ymd(prev) : null,
        };
    } catch (e) { return null; }
}

function entry(d, label, unit) {
    if (!d || d.value == null || isNaN(d.value)) return null;
    const trend = (d.previous != null && !isNaN(d.previous))
        ? (d.value > d.previous ? 'up' : d.value < d.previous ? 'down' : 'flat')
        : 'flat';
    return { value: d.value, previous: d.previous, trend, date: d.date, prevDate: d.prevDate || null, label, unit };
}

// BOI policy rate — pulled LIVE from the BOI PublicApi (authoritative; the FRED series
// lags by months). Returns null on failure so the fallbacks below kick in.
async function boiRateLive() {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
    try {
        const r = await fetch('https://www.boi.org.il/PublicApi/GetInterest',
            { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: ac.signal });
        if (!r.ok) return null;
        const j = await r.json();
        const v = parseFloat(j.currentInterest);
        if (!isFinite(v)) return null;
        return {
            value: v,
            previous: BOI_PREV_BY_RATE[v] != null ? BOI_PREV_BY_RATE[v] : null,
            date: (j.lastPublishedDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
            prevDate: null,
            nextDate: (j.nextInterestDate || '').slice(0, 10) || null,
        };
    } catch (e) { return null; } finally { clearTimeout(t); }
}
// Real BOI decision history (previous rate per current rate): 6-Jul-2026 cut 3.75 → 3.5.
const BOI_PREV_BY_RATE = { 3.5: 3.75, 3.75: 4.0 };

// Verified CURRENT Israeli policy figures — FALLBACKS only, used while more recent than
// the matching FRED observation (once FRED catches up, FRED automatically wins). The BOI
// rate normally comes from the live PublicApi above; this covers an API outage.
// ⇢ UPDATE when the BOI changes the rate or a newer official labour print lands.
const IL_OVERRIDES = {
    boi_rate: { value: 3.5, previous: 3.75, date: '2026-07-06', prevDate: '2026-05-25' }, // BOI -25bp → 3.5%
    il_unemployment: { value: 3.2, previous: 3.1, date: '2026-04-01', prevDate: '2026-02-01' }, // CBS official
};

// Pick whichever observation is more recent (ISO dates compare lexicographically).
function pickRecent(fred, override) {
    if (!override) return fred;
    if (!fred || !fred.date) return override;
    return (String(override.date) >= String(fred.date)) ? override : fred;
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const [fed, cpi, coreCpi, ppi, corePpi, unrate, nfp, gdp, realRate,
               pce, corePce, retail, indProd, t10, sentiment,
               boi, ilUnemp, ilBond, ilShortRate, ilReer, ilExports, ilImports, ilStocks, ilCpi] = await Promise.all([
            fredSeries('FEDFUNDS', 'lin'), fredSeries('CPIAUCSL', 'pc1'), fredSeries('CPILFESL', 'pc1'),
            fredSeries('PPIFIS', 'pch'), fredSeries('PPIFES', 'pch'), fredSeries('UNRATE', 'lin'), fredSeries('PAYEMS', 'chg'),
            fredSeries('A191RL1Q225SBEA', 'lin'), fredSeries('DFII10', 'lin'),
            fredSeries('PCEPI', 'pc1'), fredSeries('PCEPILFE', 'pc1'), fredSeries('RSAFS', 'pch'),
            fredSeries('INDPRO', 'pc1'), fredSeries('DGS10', 'lin'), fredSeries('UMCSENT', 'lin'),
            fredSeries('IRSTCI01ILM156N', 'lin'), fredSeries('LRHUTTTTILM156S', 'lin'), fredSeries('IRLTLT01ILM156N', 'lin'),
            fredSeries('IR3TIB01ILM156N', 'lin'), fredSeries('RBILBIS', 'lin'), fredSeries('XTEXVA01ILM664S', 'pc1'),
            fredSeries('XTIMVA01ILM664S', 'pc1'), fredSeries('SPASTT01ILM661N', 'pc1'),
            israelCPI(),
        ]);
        const boiLive = await boiRateLive();

        const us = {};
        const add = (o, k, v) => { if (v) o[k] = v; };
        add(us, 'fed_rate', entry(fed, 'ריבית הפד (Fed Rate)', '%'));
        add(us, 'cpi', entry(cpi, 'אינפלציה שנתית (CPI YoY)', '%'));
        add(us, 'core_cpi', entry(coreCpi, 'אינפלציה ליבה (Core CPI)', '%'));
        add(us, 'ppi', entry(ppi, 'מדד מחירי יצרן (PPI MoM)', '%'));
        add(us, 'core_ppi', entry(corePpi, 'מדד יצרן ליבה (Core PPI)', '%'));
        add(us, 'unemployment', entry(unrate, 'שיעור אבטלה (Unemployment)', '%'));
        add(us, 'nfp', entry(nfp, 'משרות חדשות (NFP)', 'K'));
        add(us, 'gdp', entry(gdp, 'צמיחת תמ״ג (GDP)', '%'));
        add(us, 'real_rate', entry(realRate, 'ריבית ריאלית (Real Rate)', '%'));
        add(us, 'pce', entry(pce, 'הוצאה אישית (PCE YoY)', '%'));
        add(us, 'core_pce', entry(corePce, 'PCE ליבה (Core PCE)', '%'));
        add(us, 'retail', entry(retail, 'מכירות קמעונאיות (Retail)', '%'));
        add(us, 'ind_prod', entry(indProd, 'ייצור תעשייתי (Ind. Prod.)', '%'));
        add(us, 'treasury10', entry(t10, 'אג״ח 10 שנים (10Y)', '%'));
        add(us, 'sentiment', entry(sentiment, 'אמון הצרכן (Sentiment)', 'idx'));

        const il = {};
        // Live PublicApi first; the dated override + FRED only if the live call failed.
        const boiBest = boiLive || pickRecent(boi, IL_OVERRIDES.boi_rate);
        const boiEntry = entry(boiBest, 'ריבית בנק ישראל (BOI Rate)', '%');
        if (boiEntry && boiBest.nextDate) boiEntry.nextDate = boiBest.nextDate;
        add(il, 'boi_rate', boiEntry);
        add(il, 'il_cpi', entry(ilCpi, 'אינפלציה שנתית (CPI YoY)', '%'));
        add(il, 'il_unemployment', entry(pickRecent(ilUnemp, IL_OVERRIDES.il_unemployment), 'שיעור אבטלה (Unemployment)', '%'));
        add(il, 'il_bond10y', entry(ilBond, 'אג"ח ממשלתי 10 שנים', '%'));
        add(il, 'il_short_rate', entry(ilShortRate, 'ריבית בין-בנקאית (3M)', '%'));
        add(il, 'il_reer', entry(ilReer, 'שער חליפין ריאלי (REER)', 'idx'));
        add(il, 'il_exports', entry(ilExports, 'יצוא סחורות (YoY)', '%'));
        add(il, 'il_imports', entry(ilImports, 'יבוא סחורות (YoY)', '%'));
        add(il, 'il_stocks', entry(ilStocks, 'מדד מניות ת"א (YoY)', '%'));

        const hasData = Object.keys(us).length > 0 || Object.keys(il).length > 0;
        res.setHeader('Cache-Control', hasData
            ? 's-maxage=10800, stale-while-revalidate=86400'   // ~3h; refreshes through the day
            : 's-maxage=120');
        res.status(200).json({ us, il, asOf: new Date().toISOString().slice(0, 10) });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'macro_failed', message: e.message });
    }
};
