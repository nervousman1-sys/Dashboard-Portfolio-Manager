// ============================================================================
// Finextium — Reports Agent (24/7 earnings-report puller)
// ----------------------------------------------------------------------------
// Sibling of scanner.js / macro-feed.js. Continuously sweeps EVERY company on the
// platform (US: S&P 500 ∪ Nasdaq-100, IL: TA-125), pulls each one's latest
// normalized financial report (Yahoo-first → no FMP quota burn), computes the same
// score the UI shows (ReportsEngine.buildReport), and upserts it into Supabase
// `company_reports`. The reports page reads that table, so a freshly-released report
// lands on the platform automatically — no one has to open the company first.
//
// New report detection: when a company's `asOf` (latest period end) advances past
// what we last stored, it's a fresh report → logged and counted in the heartbeat.
//
// Run:  node reports-agent.js          (daemon)
//       node reports-agent.js --once   (single full sweep, then exit)
// ============================================================================

require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

// Reuse the EXACT same report builder + scorer the website uses (no logic drift).
const { fetchReport, fetchYahooStats } = require(path.join(__dirname, '..', 'lib', 'reports-data.js'));
const ReportsEngine = require(path.join(__dirname, '..', 'js', 'reports-engine.js'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
const SITE = (process.env.SITE_URL || 'https://finextium-dashboard.vercel.app').replace(/\/+$/, '');
const BATCH = parseInt(process.env.REPORTS_BATCH || '5', 10);          // concurrent fetches per wave
const GAP_MS = parseInt(process.env.REPORTS_GAP_MS || '1100', 10);     // pause between waves (gentle on Yahoo)
const REST_MIN = parseFloat(process.env.REPORTS_REST_MIN || '8');      // rest between full sweeps
const HEARTBEAT_EVERY = parseInt(process.env.REPORTS_HEARTBEAT_EVERY || '40', 10); // heartbeat every N companies
const RUN_ONCE = process.argv.includes('--once');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Universe: same source the reports page uses (tickers + GICS sectors) ──────
async function loadUniverse() {
    const out = [];
    for (const market of ['us', 'il']) {
        try {
            const url = `${SITE}/api/technicals?mode=tickers&market=${market}&sv=3` + (market === 'il' ? '&stocksOnly=1' : '');
            const r = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!r.ok) { log(`universe ${market}: HTTP ${r.status}`); continue; }
            const j = await r.json();
            const tickers = Array.isArray(j.tickers) ? j.tickers : [];
            const sectors = j.sectors || {};
            for (const t of tickers) out.push({ symbol: t, market, sector: sectors[t] || null });
        } catch (e) { log(`universe ${market} failed:`, e.message); }
    }
    return out;
}

// ── Refresh one company → upsert its latest report + score ────────────────────
async function refreshOne(item, lastSeen, nextEarn) {
    const { symbol, market } = item;
    let report;
    try {
        // yahooFirst keeps us off the FMP daily quota — Yahoo carries the quarters + price for scoring.
        report = await fetchReport(symbol, market, { yahooFirst: true });
    } catch (e) { return { ok: false }; }
    if (!report || !Array.isArray(report.quarters) || !report.quarters.length) return { ok: false };

    const model = ReportsEngine.buildReport(report);
    const score = (model.score && model.score.value != null) ? model.score.value : null;
    const improved = !!(model.beat && model.beat.improved);
    const asOf = report.asOf || (report.quarters[0] && report.quarters[0].date) || null;

    // Next earnings date — the fast (Yahoo-only) report path doesn't carry it for US, so fetch the
    // stat ONCE and reuse the stored future date on later sweeps (no extra Yahoo call until it passes).
    const todayStr = new Date().toISOString().slice(0, 10);
    let nextEarnings = report.nextEarningsDate || null;
    if (!nextEarnings || nextEarnings < todayStr) {
        const cached = nextEarn && nextEarn[symbol];
        if (cached && cached >= todayStr) nextEarnings = cached;
        else { try { const st = await fetchYahooStats(symbol); if (st && st.nextEarningsDate) nextEarnings = st.nextEarningsDate; } catch (e) { /* skip */ } }
    }
    if (nextEarn && nextEarnings) nextEarn[symbol] = nextEarnings;

    const payload = {
        symbol, market,
        company_name: report.companyName || symbol,
        sector: item.sector || report.sector || null,
        as_of: asOf,
        score, improved,
        next_earnings: nextEarnings || null,
        report,
    };
    const { error } = await supabase.rpc('upsert_company_report', { p_secret: AGENT_WRITE_SECRET, p_item: payload });
    if (error) { log(`upsert ${symbol} warn:`, error.message); return { ok: false }; }

    // Fresh report = asOf advanced past what we last stored for this symbol.
    const isNew = asOf && lastSeen[symbol] && lastSeen[symbol] !== asOf;
    if (asOf) lastSeen[symbol] = asOf;
    return { ok: true, isNew, symbol, asOf };
}

async function heartbeat(nextRunMs, result) {
    try {
        const next = new Date(Date.now() + nextRunMs).toISOString();
        await supabase.rpc('upsert_agent_status', { p_secret: AGENT_WRITE_SECRET, p_agent: 'reports', p_next_run: next, p_result: result });
    } catch (e) { log('heartbeat warn:', e.message); }
}

// ── One full sweep over the whole universe ────────────────────────────────────
async function sweep(universe, lastSeen, nextEarn) {
    let ok = 0, fresh = 0, done = 0;
    const freshNames = [];
    // Process in small concurrent waves with a gentle gap so we don't hammer Yahoo.
    for (let i = 0; i < universe.length; i += BATCH) {
        const wave = universe.slice(i, i + BATCH);
        const results = await Promise.all(wave.map(it => refreshOne(it, lastSeen, nextEarn)));
        for (const r of results) {
            done++;
            if (r.ok) ok++;
            if (r.ok && r.isNew) { fresh++; if (freshNames.length < 8) freshNames.push(r.symbol); }
        }
        if (done % HEARTBEAT_EVERY < BATCH) {
            const note = `מעדכן דוחות · ${done}/${universe.length} · ${ok} נשמרו${fresh ? ` · ${fresh} דוחות חדשים (${freshNames.join(', ')})` : ''}`;
            await heartbeat(REST_MIN * 60 * 1000, note);
        }
        await sleep(GAP_MS);
    }
    return { ok, fresh, freshNames, total: universe.length };
}

async function runForever() {
    log(`Finextium Reports-Agent online · site=${SITE} · batch=${BATCH} · gap=${GAP_MS}ms · rest=${REST_MIN}min`);
    const lastSeen = Object.create(null); // symbol → last stored asOf (for fresh-report detection)
    const nextEarn = Object.create(null); // symbol → stored next-earnings date (skip re-fetch while future)
    // Seed from what's already in the table so we only flag genuinely NEW reports + skip known dates.
    try {
        const { data } = await supabase.from('company_reports').select('symbol,as_of,next_earnings');
        for (const r of (data || [])) { if (r.as_of) lastSeen[r.symbol] = r.as_of; if (r.next_earnings) nextEarn[r.symbol] = r.next_earnings; }
        log(`Seeded ${Object.keys(lastSeen).length} report dates, ${Object.keys(nextEarn).length} earnings dates.`);
    } catch (e) { log('seed warn:', e.message); }

    let cycle = 0;
    for (;;) {
        cycle++;
        let universe = [];
        try { universe = await loadUniverse(); } catch (e) { log('universe load failed:', e.message); }
        if (!universe.length) { log('Empty universe — retrying in 60s.'); await sleep(60000); continue; }
        log(`Sweep #${cycle} starting · ${universe.length} companies.`);
        const t0 = Date.now();
        const res = await sweep(universe, lastSeen, nextEarn);
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        const summary = `סריקת דוחות הושלמה · ${res.ok}/${res.total} עודכנו · ${res.fresh} דוחות חדשים${res.fresh ? ` (${res.freshNames.join(', ')})` : ''} · ${mins} דק׳`;
        log(`✓ ${summary}`);
        await heartbeat(REST_MIN * 60 * 1000, summary);
        if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
        await sleep(Math.max(1, REST_MIN) * 60 * 1000);
    }
}

runForever().catch(e => fail(e && e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
