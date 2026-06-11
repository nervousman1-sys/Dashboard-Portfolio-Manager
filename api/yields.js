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

// The BOI cut to 3.75% on 25-May-2026 — FRED's Israeli policy-rate series lags.
// Used only while newer than the FRED observation (FRED wins once it catches up).
const IL_BOI_OVERRIDE = { value: 3.75, date: '2026-05-25' };

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

        const [usVals, ilVals] = await Promise.all([
            Promise.all(US.map(([, id]) => latest(id))),
            Promise.all(IL.map(([, id]) => latest(id))),
        ]);

        const us = US.map(([label], i) => usVals[i] ? { label, value: usVals[i].value, date: usVals[i].date } : null)
            .filter(Boolean);

        const il = IL.map(([label], i) => ilVals[i] ? { label, value: ilVals[i].value, date: ilVals[i].date } : null)
            .filter(Boolean);
        // Apply the BOI override while it's newer than FRED's observation
        const boi = il.find(p => p.label === 'ריבית בנק ישראל');
        if (boi && String(IL_BOI_OVERRIDE.date) >= String(boi.date)) {
            boi.value = IL_BOI_OVERRIDE.value;
            boi.date = IL_BOI_OVERRIDE.date;
        }

        const hasData = us.length >= 5;
        res.setHeader('Cache-Control', hasData ? 's-maxage=10800, stale-while-revalidate=86400' : 's-maxage=120');
        res.status(200).json({ us, il, asOf: new Date().toISOString().slice(0, 10) });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(502).json({ error: 'yields_failed', message: e.message });
    }
};
