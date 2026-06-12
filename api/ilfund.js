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

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html' };

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
        const id = String(req.query.id || '').trim();
        if (!/^\d{4,9}$/.test(id)) { res.status(400).json({ error: 'bad_id' }); return; }

        const r = await fetch(`https://www.funder.co.il/fund/${id}`, { headers: UA });
        if (!r.ok) throw new Error(`funder ${r.status}`);
        const html = await r.text();

        const buy = parseFloat((html.match(/"buyPrice"\s*:\s*"?([\d.]+)/i) || [])[1]);
        const sell = parseFloat((html.match(/"sellPrice"\s*:\s*"?([\d.]+)/i) || [])[1]);
        const agorot = buy > 0 ? buy : sell;
        if (!(agorot > 0)) throw new Error('no price on page');

        const name = ((html.match(/<title>\s*([^<]+?)\s*-\s*\d+\s*<\/title>/) || [])[1] || '').trim();
        const week1 = parseFloat((html.match(/"7days"\s*:\s*"?(-?[\d.]+)/i) || [])[1]);
        const year1 = parseFloat((html.match(/"1year"\s*:\s*"?(-?[\d.]+)/i) || [])[1]);

        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=21600');
        res.status(200).json({
            id,
            name: name || null,
            price: +(agorot / 100).toFixed(4),   // ₪ per unit
            priceAgorot: agorot,
            week1Pct: isFinite(week1) ? week1 : null,
            year1Pct: isFinite(year1) ? year1 : null,
            source: 'funder',
            asOf: new Date().toISOString().slice(0, 10),
        });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=120');
        res.status(404).json({ error: 'ilfund_not_found', message: e.message });
    }
};
