// ========== Vercel Serverless Function — FRED Proxy ==========
//
// FRED (St. Louis Fed) does not send CORS headers, so the browser cannot call it
// directly. This same-origin function proxies FRED server-side and returns JSON
// with permissive CORS, fixing the macro-data fetch and supplying the risk-free
// rate (DGS3MO) for the CML/SML engine.
//
// Usage:
//   /api/fred?series_id=DGS3MO&latest=1
//       → { series_id, value: <number>, date: 'YYYY-MM-DD' }
//
//   /api/fred?series_id=CPIAUCSL&units=pc1&limit=2
//       → { series_id, observations: [ {date, value}, ... ] }   (newest first)
//
//   /api/fred?batch=CPIAUCSL:pc1,FEDFUNDS:lin,UNRATE:lin&limit=2
//       → { CPIAUCSL: {value, previous, date, prevDate}, ... }   (one round-trip)
//
// FRED_API_KEY is read from the Vercel environment, falling back to the project
// key so the proxy works out of the box.

const FRED_KEY = process.env.FRED_API_KEY || 'f568440cde5cb64b20cd92e80292fbac';
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    // Cache at the edge — macro data updates at most daily
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
}

async function fetchSeries(seriesId, units, limit) {
    const url = `${FRED_BASE}?series_id=${encodeURIComponent(seriesId)}` +
        `&api_key=${FRED_KEY}&file_type=json&sort_order=desc` +
        `&limit=${limit}&units=${encodeURIComponent(units || 'lin')}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
    const json = await r.json();
    const obs = (json.observations || []).filter(o => o.value !== '.' && o.value !== '');
    return obs; // newest first
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    try {
        const q = req.query || {};
        const limit = Math.min(parseInt(q.limit, 10) || 2, 24);

        // ── Economic calendar (US) — REAL upcoming release dates from FRED's release/dates API ──
        if (q.cal) {
            const RELEASES = [
                { id: 10, key: 'CPI', he: 'מדד המחירים לצרכן (CPI)', imp: 'high' },
                { id: 54, key: 'PCE', he: 'הכנסה והוצאה אישית (PCE)', imp: 'high' },
                { id: 50, key: 'NFP', he: 'דו"ח התעסוקה (NFP + אבטלה)', imp: 'high' },
                { id: 53, key: 'GDP', he: 'תוצר מקומי גולמי (GDP)', imp: 'high' },
                { id: 46, key: 'PPI', he: 'מדד המחירים ליצרן (PPI)', imp: 'med' },
                { id: 9, key: 'RETAIL', he: 'מכירות קמעונאיות', imp: 'med' },
            ];
            const today = new Date().toISOString().slice(0, 10);
            const end = new Date(Date.now() + 95 * 86400000).toISOString().slice(0, 10);
            const all = await Promise.all(RELEASES.map(async (rel) => {
                try {
                    const url = `https://api.stlouisfed.org/fred/release/dates?release_id=${rel.id}` +
                        `&api_key=${FRED_KEY}&file_type=json&include_release_dates_with_no_data=true` +
                        `&sort_order=asc&realtime_start=${today}&realtime_end=${end}`;
                    const r = await fetch(url, { headers: { Accept: 'application/json' } });
                    if (!r.ok) return [];
                    const j = await r.json();
                    return (j.release_dates || []).filter(d => d.date >= today)
                        .map(d => ({ date: d.date, key: rel.key, he: rel.he, imp: rel.imp, country: 'US' }));
                } catch (e) { return []; }
            }));
            const events = all.flat().sort((a, b) => a.date.localeCompare(b.date));

            // Latest RELEASED values per key indicator (actual + previous) → result analysis.
            // betterLower=true for inflation gauges (lower reading is the "good" outcome).
            const SERIES = {
                CPI: { he: 'מדד המחירים לצרכן (CPI)', series: 'CPIAUCSL', units: 'pc1', unit: '%', betterLower: true, kind: 'inflation' },
                PCE: { he: 'הוצאה אישית (PCE)', series: 'PCEPI', units: 'pc1', unit: '%', betterLower: true, kind: 'inflation' },
                NFP: { he: 'תעסוקה — משרות שנוספו (NFP)', series: 'PAYEMS', units: 'chg', unit: 'K', betterLower: false, kind: 'jobs' },
                GDP: { he: 'תוצר מקומי גולמי (GDP)', series: 'A191RL1Q225SBEA', units: 'lin', unit: '%', betterLower: false, kind: 'growth' },
                PPI: { he: 'מדד המחירים ליצרן (PPI)', series: 'PPIFIS', units: 'pc1', unit: '%', betterLower: true, kind: 'inflation' },
                RETAIL: { he: 'מכירות קמעונאיות', series: 'RSAFS', units: 'pc1', unit: '%', betterLower: false, kind: 'growth' },
            };
            const results = (await Promise.all(Object.entries(SERIES).map(async ([key, s]) => {
                try {
                    const obs = await fetchSeries(s.series, s.units, 2);
                    if (!obs.length) return null;
                    const value = parseFloat(obs[0].value);
                    const previous = obs[1] ? parseFloat(obs[1].value) : null;
                    const dir = previous == null ? 'flat' : (value > previous ? 'up' : value < previous ? 'down' : 'flat');
                    const sentiment = previous == null || dir === 'flat' ? 'neutral'
                        : (s.betterLower ? (dir === 'down' ? 'good' : 'bad') : (dir === 'up' ? 'good' : 'bad'));
                    return { key, he: s.he, kind: s.kind, unit: s.unit, value, previous, date: obs[0].date, dir, sentiment, betterLower: s.betterLower };
                } catch (e) { return null; }
            }))).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));

            res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
            res.status(200).json({ events, results });
            return;
        }

        // ── Batch mode ──
        if (q.batch) {
            const specs = String(q.batch).split(',').map(s => s.trim()).filter(Boolean);
            const entries = await Promise.all(specs.map(async (spec) => {
                const [id, units] = spec.split(':');
                try {
                    const obs = await fetchSeries(id, units, limit);
                    if (!obs.length) return [id, null];
                    const latest = obs[0];
                    const prev = obs[1] || null;
                    return [id, {
                        value: parseFloat(latest.value),
                        previous: prev ? parseFloat(prev.value) : null,
                        date: latest.date,
                        prevDate: prev ? prev.date : null,
                    }];
                } catch (e) {
                    return [id, null];
                }
            }));
            const out = {};
            for (const [id, v] of entries) out[id] = v;
            res.status(200).json(out);
            return;
        }

        // ── Single series ──
        const seriesId = q.series_id || q.series;
        if (!seriesId) { res.status(400).json({ error: 'missing series_id or batch' }); return; }

        const obs = await fetchSeries(seriesId, q.units, limit);

        if (q.latest) {
            if (!obs.length) { res.status(200).json({ series_id: seriesId, value: null }); return; }
            res.status(200).json({ series_id: seriesId, value: parseFloat(obs[0].value), date: obs[0].date });
            return;
        }

        res.status(200).json({
            series_id: seriesId,
            observations: obs.map(o => ({ date: o.date, value: o.value })),
        });
    } catch (e) {
        res.status(502).json({ error: 'fred_proxy_failed', message: e.message });
    }
};
