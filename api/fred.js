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

// ── BLS API: the ORIGINAL release source for CPI / PPI / jobs. BLS publishes at
// 8:30 AM ET on release day; FRED ingests ~1h later. Pulling BLS directly means a
// print shows the moment it's official — the release-day flip no longer waits on FRED.
// Returned as FRED-shaped obs (newest first, values ALREADY in display units:
// YoY % for CPI/PPI, MoM thousands for jobs) so it drops straight into the calendar.
const BLS_KEY = process.env.BLS_API_KEY || '';
const BLS_SERIES = {
    CPI: { id: 'CUUR0000SA0', tf: 'yoy' },       // CPI-U all items (NSA index) → YoY %
    PPI: { id: 'WPSFD4', tf: 'yoy' },            // PPI final demand (index) → YoY %
    NFP: { id: 'CES0000000001', tf: 'momk' },    // total nonfarm (thousands) → MoM change
};
async function fetchBls(key) {
    const cfg = BLS_SERIES[key];
    if (!cfg) return [];
    const yr = new Date().getFullYear();
    const body = { seriesid: [cfg.id], startyear: String(yr - 1), endyear: String(yr) };
    if (BLS_KEY) body.registrationkey = BLS_KEY;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    try {
        const r = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body), signal: ac.signal,
        });
        if (!r.ok) return [];
        const j = await r.json();
        const raw = j && j.Results && j.Results.series && j.Results.series[0] && j.Results.series[0].data;
        if (!Array.isArray(raw) || !raw.length) return [];
        // Monthly points only (skip M13 = annual avg); newest first, numeric.
        const pts = raw
            .filter(d => /^M\d\d$/.test(d.period) && d.period !== 'M13' && d.value !== '' && d.value !== '-')
            .map(d => ({ date: `${d.year}-${d.period.slice(1)}-01`, level: parseFloat(d.value) }))
            .filter(d => isFinite(d.level))
            .sort((a, b) => b.date.localeCompare(a.date));
        const out = [];
        if (cfg.tf === 'yoy') {
            // YoY needs the same month a year earlier (index 12 back).
            for (let i = 0; i + 12 < pts.length; i++) {
                const v = (pts[i].level / pts[i + 12].level - 1) * 100;
                out.push({ date: pts[i].date, value: (+v.toFixed(5)).toString() });
            }
        } else { // momk — month-over-month change in thousands
            for (let i = 0; i + 1 < pts.length; i++) {
                out.push({ date: pts[i].date, value: (+(pts[i].level - pts[i + 1].level).toFixed(1)).toString() });
            }
        }
        return out; // newest first, display units
    } catch (e) { return []; } finally { clearTimeout(t); }
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
            const past = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);  // ~last month back
            const end = new Date(Date.now() + 95 * 86400000).toISOString().slice(0, 10);
            const all = await Promise.all(RELEASES.map(async (rel) => {
                try {
                    // Window the realtime period back 45 days so we also get the PAST month's release dates.
                    const url = `https://api.stlouisfed.org/fred/release/dates?release_id=${rel.id}` +
                        `&api_key=${FRED_KEY}&file_type=json&include_release_dates_with_no_data=true` +
                        `&sort_order=asc&realtime_start=${past}&realtime_end=${end}`;
                    const r = await fetch(url, { headers: { Accept: 'application/json' } });
                    if (!r.ok) return [];
                    const j = await r.json();
                    const seen = new Set();
                    return (j.release_dates || [])
                        .filter(d => d.date >= past && d.date <= end && !seen.has(d.date) && seen.add(d.date))
                        .map(d => ({ date: d.date, key: rel.key, he: rel.he, imp: rel.imp, country: 'US' }));
                } catch (e) { return []; }
            }));
            const allEvents = all.flat();
            const events = allEvents.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
            const pastRaw = allEvents.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date)); // newest first

            // Latest RELEASED values per key indicator (actual + previous) → result analysis.
            // betterLower=true for inflation gauges (lower reading is the "good" outcome).
            const SERIES = {
                CPI: { he: 'מדד המחירים לצרכן (CPI)', series: 'CPIAUCNS', units: 'pc1', unit: '%', betterLower: true, kind: 'inflation' },
                PCE: { he: 'הוצאה אישית (PCE)', series: 'PCEPI', units: 'pc1', unit: '%', betterLower: true, kind: 'inflation' },
                NFP: { he: 'תעסוקה — משרות שנוספו (NFP)', series: 'PAYEMS', units: 'chg', unit: 'K', betterLower: false, kind: 'jobs' },
                GDP: { he: 'תוצר מקומי גולמי (GDP)', series: 'A191RL1Q225SBEA', units: 'lin', unit: '%', betterLower: false, kind: 'growth' },
                PPI: { he: 'מדד המחירים ליצרן (PPI)', series: 'PPIFIS', units: 'pc1', unit: '%', betterLower: true, kind: 'inflation' },
                RETAIL: { he: 'מכירות קמעונאיות', series: 'RSAFS', units: 'pc1', unit: '%', betterLower: false, kind: 'growth' },
            };
            // Pull ~1 year of prints per indicator → `results` (latest, shown inline) and
            // `history` (the earlier prints — the collapsible historical archive in the calendar).
            const HIST_N = 13; // ~12 monthly prints + 1 (GDP is quarterly → naturally fewer)
            const sentimentOf = (value, previous, betterLower) => {
                if (previous == null) return { dir: 'flat', sentiment: 'neutral' };
                const dir = value > previous ? 'up' : value < previous ? 'down' : 'flat';
                const sentiment = dir === 'flat' ? 'neutral'
                    : (betterLower ? (dir === 'down' ? 'good' : 'bad') : (dir === 'up' ? 'good' : 'bad'));
                return { dir, sentiment };
            };
            const perSeries = await Promise.all(Object.entries(SERIES).map(async ([key, s]) => {
                try {
                    // BLS + FRED in parallel; use whichever carries the NEWER print (BLS leads
                    // FRED by ~1h on release day, so this is what makes a fresh CPI show at once).
                    const [fredObs, blsObs] = await Promise.all([
                        fetchSeries(s.series, s.units, HIST_N).catch(() => []),
                        BLS_SERIES[key] ? fetchBls(key).catch(() => []) : Promise.resolve([]),
                    ]);
                    const obs = (blsObs.length && (!fredObs.length || blsObs[0].date > fredObs[0].date))
                        ? blsObs : fredObs; // newest first
                    const pts = [];
                    for (let i = 0; i < obs.length; i++) {
                        const value = parseFloat(obs[i].value);
                        if (isNaN(value)) continue;
                        const previous = obs[i + 1] ? parseFloat(obs[i + 1].value) : null;
                        const { dir, sentiment } = sentimentOf(value, previous, s.betterLower);
                        pts.push({ key, he: s.he, kind: s.kind, unit: s.unit, value, previous, date: obs[i].date, dir, sentiment, betterLower: s.betterLower });
                    }
                    return pts;
                } catch (e) { return []; }
            }));
            const results = perSeries.map(pts => pts[0]).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
            const history = perSeries.flatMap(pts => pts.slice(1)).sort((a, b) => b.date.localeCompare(a.date));

            // PAST month's release events, each carrying the actual figure it published (the most recent
            // indicator reading on/before that release date) → "what came out" for every recent report.
            const byKey = {};
            for (const pts of perSeries) if (pts && pts.length) byKey[pts[0].key] = pts;
            const pastEvents = pastRaw.map(e => {
                const pts = byKey[e.key];
                const hit = pts ? pts.find(p => p.date <= e.date) : null;
                return hit
                    ? { ...e, value: hit.value, previous: hit.previous, dir: hit.dir, sentiment: hit.sentiment, unit: hit.unit, kind: hit.kind, refDate: hit.date, released: true }
                    : { ...e, released: false };
            });

            // ── RELEASE-DAY STATUS per upcoming event ─────────────────────────────────────
            // A release "landed" when FRED already carries the observation for the period the
            // event publishes: monthlies (CPI/PPI/PCE/NFP/RETAIL) publish the PREVIOUS month,
            // GDP publishes the last COMPLETE quarter (advance/2nd/3rd estimates all cover it).
            // FRED updates within ~1h of the official print, so on release day the row flips to
            // released + carries the freshly published figure.
            const expPeriod = (key, d) => {
                const y = parseInt(d.slice(0, 4), 10), m = parseInt(d.slice(5, 7), 10);
                if (key === 'GDP') {
                    const done = Math.floor((m - 1) / 3) * 3;         // months of completed quarters this year
                    if (done === 0) return `${y - 1}-10-01`;          // last complete quarter = Q4 previous year
                    return `${y}-${String(done - 2).padStart(2, '0')}-01`;
                }
                return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
            };
            for (const e of events) {
                const latest = byKey[e.key] && byKey[e.key][0];
                e.released = !!(latest && e.date <= today && latest.date >= expPeriod(e.key, e.date));
                if (e.released) {
                    e.value = latest.value; e.previous = latest.previous; e.dir = latest.dir;
                    e.sentiment = latest.sentiment; e.unit = latest.unit; e.kind = latest.kind; e.refDate = latest.date;
                }
            }

            // Short CDN cache: on release day the flip from "טרם התקבל" to the published figure
            // must show within minutes, not after a 6-hour edge cache.
            // Short edge cache so a fresh print (BLS on release day) shows within ~2-3 min.
            res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=1800');
            res.status(200).json({ events, results, history, pastEvents, asOf: new Date().toISOString() });
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
