// ========== Vercel Serverless Function — Israeli Fund/ETF Price Resolver ==========
//
// Israeli mutual funds and קרנות סל (KTF) trade by NUMERIC security id and are
// NOT on Yahoo Finance (5122957.TA → "No data found"). Without a real source the
// client used to fall back to a bond-par simulation (~100), producing absurd
// prices for fund positions transferred in from another broker.
//
//   /api/ilfund?id=5122957
//     → { id, name, price (ILS), priceAgorot, week1Pct, year1Pct, asOf }
//
// Source: funder.co.il fund page (server-side fetch; prices quoted in agorot).

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

const UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    Referer: 'https://www.funder.co.il/',
};

async function fetchHtml(url, viaProxy) {
    const target = viaProxy ? `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` : url;
    // Per-source timeout so a hanging/blocked source (e.g. a Cloudflare 522) fails fast instead of
    // stalling the whole resolution — the next ATTEMPT (or the next id in the batch) proceeds quickly.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const r = await fetch(target, { headers: UA, signal: ctrl.signal });
        if (!r.ok) throw new Error(`http ${r.status}`);
        return await r.text();
    } finally {
        clearTimeout(timer);
    }
}

// Classify the Israeli security type (Hebrew) from its name + the source page kind.
//  • קרן סל / KTF / ETF / "מחקה" (index-tracking) → קרן סל (a tradable tracking fund)
//  • otherwise → קרן נאמנות (mutual fund)
function inferIlType(name, urlKind) {
    const n = String(name || '');
    if (/\bKTF\b|\bETF\b|קרן\s*סל|תעודת\s*סל|מחקה|סל\b/i.test(n)) return 'קרן סל';
    if (urlKind) return urlKind;
    if (/קרן/.test(n)) return 'קרן נאמנות';
    return 'קרן סל';
}

// funder embeds clean JSON; bizportal shows the same NAV in markup. Both quote agorot.
function parseFunder(html, id) {
    const buy = parseFloat((html.match(/"buyPrice"\s*:\s*"?([\d.]+)/i) || [])[1]);
    const sell = parseFloat((html.match(/"sellPrice"\s*:\s*"?([\d.]+)/i) || [])[1]);
    const agorot = buy > 0 ? buy : sell;
    if (!(agorot > 0)) return null;
    const name = ((html.match(/<title>\s*([^<]+?)\s*-\s*\d+\s*<\/title>/) || [])[1] || '').trim();
    const year1 = parseFloat((html.match(/"1year"\s*:\s*"?(-?[\d.]+)/i) || [])[1]);
    return { agorot, name, year1, source: 'funder', urlKind: null };
}

function parseBizportal(html, id, urlKind) {
    const flat = html.replace(/<[^>]+>/g, '|');
    const m = flat.match(/מחיר\s*(?:פדיון|קנייה)\|+\s*([\d,]+\.?\d*)/);
    const agorot = m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
    if (!(agorot > 0)) return null;
    const name = ((html.match(/<title>\s*([^<|]+?)\s*\|/) || [])[1] || '').trim();
    return { agorot, name, year1: null, source: 'bizportal', urlKind: urlKind || null };
}

const ATTEMPTS = [
    (id) => fetchHtml(`https://www.funder.co.il/fund/${id}`, false).then(h => parseFunder(h, id)),
    (id) => fetchHtml(`https://www.bizportal.co.il/tradedfunds/quote/generalview/${id}`, false).then(h => parseBizportal(h, id, 'קרן סל')),
    (id) => fetchHtml(`https://www.bizportal.co.il/mutualfunds/quote/generalview/${id}`, false).then(h => parseBizportal(h, id, 'קרן נאמנות')),
    (id) => fetchHtml(`https://www.funder.co.il/fund/${id}`, true).then(h => parseFunder(h, id)),
    (id) => fetchHtml(`https://www.bizportal.co.il/tradedfunds/quote/generalview/${id}`, true).then(h => parseBizportal(h, id, 'קרן סל')),
];

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const id = String(req.query.id || '').trim();
        if (!/^\d{4,9}$/.test(id)) { res.status(400).json({ error: 'bad_id' }); return; }

        let hit = null, lastErr = '';
        for (const attempt of ATTEMPTS) {
            try {
                hit = await attempt(id);
                if (hit) break;
            } catch (e) { lastErr = e.message; }
        }
        if (!hit) throw new Error(lastErr || 'no source had a price');

        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=21600');
        res.status(200).json({
            id,
            name: hit.name || null,
            type: inferIlType(hit.name, hit.urlKind),   // קרן סל / קרן נאמנות
            price: +(hit.agorot / 100).toFixed(4),   // ₪ per unit
            priceAgorot: hit.agorot,
            year1Pct: isFinite(hit.year1) ? hit.year1 : null,
            source: hit.source,
            asOf: new Date().toISOString().slice(0, 10),
        });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=120');
        res.status(404).json({ error: 'ilfund_not_found', message: e.message });
    }
};
