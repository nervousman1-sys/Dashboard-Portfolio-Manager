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
// NOTE: finextium-dashboard.vercel.app is a STALE alias pinned to an old deployment
// (no r2k branch, pre-Parsoid Wikipedia parsers) — always use the production domain.
const SITE = (process.env.SITE_URL || 'https://www.finextium.com').replace(/\/+$/, '');
// GENTLE defaults — the upserts share Supabase's 60-connection pool with the AUTH service. Too much
// concurrency/frequency here once exhausted the pool and locked everyone out of login. Keep BATCH low.
const BATCH = parseInt(process.env.REPORTS_BATCH || '2', 10);          // concurrent fetches per wave (low → few DB conns)
const GAP_MS = parseInt(process.env.REPORTS_GAP_MS || '2500', 10);     // pause between waves (gentle on Yahoo + DB)
const REST_MIN = parseFloat(process.env.REPORTS_REST_MIN || '30');     // rest between full sweeps
const HEARTBEAT_EVERY = parseInt(process.env.REPORTS_HEARTBEAT_EVERY || '80', 10); // heartbeat every N companies
const RUN_ONCE = process.argv.includes('--once');

// ── Freshness reconciliation ──────────────────────────────────────────────────
// Yahoo's fundamentals-timeseries (the free/unlimited source the sweep uses) lags a just-FILED
// quarter by days-to-weeks — e.g. NVDA reported late-Aug but Yahoo still served as_of Apr-30. When
// a name's latest quarter looks stale (a newer one is almost certainly filed) we reconcile it from
// the SITE's own report endpoint (${SITE}/api/technicals?mode=report), which runs on Vercel where
// FMP works (FMP reflects the filing within a day) — the VPS itself can't reach FMP directly
// ("fetch failed" from the datacenter IP), and Vercel's response is CDN-cached 6h so this is cheap
// on FMP no matter how often the sweep asks. A name is only ever reconciled UP: once its fresh
// quarter is stored, the lagging Yahoo value can't overwrite it (priorAsOf>asOf ⇒ skip). The daily
// cap is a loose safety net (the CDN cache is the real FMP limiter); it's high enough to never
// starve a stale name in the ~100-name NDX sweep.
const FMP_RECON_CAP = parseInt(process.env.REPORTS_FMP_CAP || '150', 10);        // recon fetches/day (safety net)
const FMP_STALE_DAYS = parseInt(process.env.REPORTS_FMP_STALE_DAYS || '95', 10); // latest quarter older than this ⇒ suspect a newer filing
let _fmpRecon = { day: '', n: 0 };
function _fmpReconBudget() {
    const d = new Date().toISOString().slice(0, 10);
    if (_fmpRecon.day !== d) _fmpRecon = { day: d, n: 0 };
    if (_fmpRecon.n >= FMP_RECON_CAP) return false;
    _fmpRecon.n++;
    return true;
}
// Pull the FMP-merged report from the site API (Vercel does the FMP fetch the VPS can't). Returns a
// report object shaped exactly like fetchReport's output, or null. No cache-buster on purpose — the
// 6h CDN cache keeps FMP usage tiny; a freshly-filed quarter lands within that window.
async function fetchMergedReportViaSite(symbol) {
    try {
        const r = await fetch(`${SITE}/api/technicals?mode=report&symbol=${encodeURIComponent(symbol)}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        return (j && Array.isArray(j.quarters) && j.quarters.length) ? j : null;
    } catch (e) { return null; }
}

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Universe: same source the reports page uses (tickers + GICS sectors) ──────
// r2k (Russell 2000, ~2000 small/mid-caps) is OPT-IN (SWEEP_R2K=1). It quadrupled the
// table to ~2500 JSONB rows, whose autovacuum/checkpoint pegged the free-tier compute
// and starved the AUTH service's DB connection ("dial tcp 5432: i/o timeout" → login
// 504s). Default: sweep us+il only (~700 companies); r2k board scores load on-demand
// client-side, so nothing user-facing is lost.
const SWEEP_R2K = process.env.SWEEP_R2K === '1';
// REPORTS_MARKETS (comma-separated) scopes the sweep to specific index universes, e.g.
//   REPORTS_MARKETS=ndx     → only the ~100 Nasdaq-100 names (far lighter on the disk-I/O budget)
//   REPORTS_MARKETS=us,il   → the historical full sweep (also the default when unset)
// Valid codes map to /api/technicals?market=<code>: ndx, sp500, us, il, r2k.
const REPORTS_MARKETS = String(process.env.REPORTS_MARKETS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// The DB `market` column groups rows the way the board + trading-agent expect (us / il / r2k).
// ndx and sp500 are US large-cap SUBSETS, so their rows must stay market='us' — otherwise
// anything that filters market='us' (e.g. the AI trading-agent's top-scored-US-stocks context)
// would stop seeing them. Fetch from the ndx/sp500 list, but store under 'us'.
const STORE_MARKET = { ndx: 'us', sp500: 'us', us: 'us', il: 'il', r2k: 'r2k' };
async function loadUniverse() {
    const out = [];
    const markets = REPORTS_MARKETS.length
        ? REPORTS_MARKETS
        : (SWEEP_R2K ? ['us', 'il', 'r2k'] : ['us', 'il']);
    for (const market of markets) {
        try {
            const url = `${SITE}/api/technicals?mode=tickers&market=${market}&sv=3` + (market === 'il' ? '&stocksOnly=1' : '');
            const r = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!r.ok) { log(`universe ${market}: HTTP ${r.status}`); continue; }
            const j = await r.json();
            const tickers = Array.isArray(j.tickers) ? j.tickers : [];
            const sectors = j.sectors || {};
            const storeMkt = STORE_MARKET[market] || market;
            for (const t of tickers) out.push({ symbol: t, market: storeMkt, sector: sectors[t] || null });
        } catch (e) { log(`universe ${market} failed:`, e.message); }
    }
    // WATCHED symbols (any user's watchlist) always join the sweep — so a starred
    // Russell name gets 24/7 score/next-earnings updates even though the full ~2000-name
    // r2k sweep is opt-in. A handful of extra names can't re-bloat the table.
    if (!SWEEP_R2K) {
        try {
            const { data, error } = await supabase.rpc('get_tracked_symbols', { p_secret: AGENT_WRITE_SECRET });
            if (error) log('tracked-symbols warn:', error.message);
            else if (Array.isArray(data)) {
                const have = new Set(out.map(x => x.symbol));
                let added = 0;
                for (const row of data) {
                    const sym = String(row.symbol || '').toUpperCase().trim();
                    if (!sym || have.has(sym)) continue;
                    out.push({ symbol: sym, market: row.market || 'r2k', sector: null });
                    have.add(sym); added++;
                }
                if (added) log(`universe: +${added} watched symbols (outside the base sweep)`);
            }
        } catch (e) { log('tracked-symbols warn:', e.message); }
    }
    return out;
}

// ── Refresh one company → upsert its latest report + score ────────────────────
async function refreshOne(item, lastSeen, nextEarn, lastSig) {
    const { symbol, market } = item;
    let report;
    try {
        // yahooFirst keeps us off the FMP daily quota — Yahoo carries the quarters + price for scoring.
        report = await fetchReport(symbol, market, { yahooFirst: true });
    } catch (e) { return { ok: false }; }
    if (!report || !Array.isArray(report.quarters) || !report.quarters.length) return { ok: false };
    let asOf = report.asOf || (report.quarters[0] && report.quarters[0].date) || null;

    // FRESHNESS RECONCILE (see FMP_RECON_CAP note above) — keep the board on the LATEST filed quarter
    // despite Yahoo's fundamentals lag.
    const priorAsOf = lastSeen[symbol] || null;
    if (priorAsOf && asOf && priorAsOf > asOf) {
        // We already stored a NEWER quarter than Yahoo's (still-lagging) fast path now returns — don't
        // downgrade the row, and don't spend FMP budget re-checking. The fresh quarter we have stands.
        return { ok: true, skipped: true, symbol };
    }
    const ageDays = asOf ? Math.floor((Date.now() - Date.parse(asOf)) / 864e5) : 999;
    if (ageDays > FMP_STALE_DAYS && _fmpReconBudget()) {
        const merged = await fetchMergedReportViaSite(symbol);   // Vercel FMP+Yahoo union (fresh quarter)
        if (merged && merged.asOf && merged.asOf > asOf) {
            report = merged; asOf = merged.asOf;
        }
    }

    const model = ReportsEngine.buildReport(report);
    const score = (model.score && model.score.value != null) ? model.score.value : null;
    const improved = !!(model.beat && model.beat.improved);

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

    // CHANGE DETECTION — the board only reads score/improved/as_of/next_earnings, so when none
    // of them moved there is NOTHING to write. Rewriting the full report JSONB for every company
    // every sweep flooded Postgres with WAL/TOAST writes, drained the disk-I/O budget, and made
    // the whole platform (incl. login) hang intermittently. Skip unchanged rows entirely.
    const sig = `${asOf}|${score}|${improved ? 1 : 0}|${nextEarnings || ''}`;
    if (lastSig && lastSig[symbol] === sig) return { ok: true, skipped: true, symbol };

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
    if (lastSig) lastSig[symbol] = sig;

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
async function sweep(universe, lastSeen, nextEarn, lastSig) {
    let ok = 0, fresh = 0, done = 0, skipped = 0;
    const freshNames = [];
    // Process in small concurrent waves with a gentle gap so we don't hammer Yahoo.
    for (let i = 0; i < universe.length; i += BATCH) {
        const wave = universe.slice(i, i + BATCH);
        const results = await Promise.all(wave.map(it => refreshOne(it, lastSeen, nextEarn, lastSig)));
        for (const r of results) {
            done++;
            if (r.ok) ok++;
            if (r.skipped) skipped++;
            if (r.ok && r.isNew) { fresh++; if (freshNames.length < 8) freshNames.push(r.symbol); }
        }
        if (done % HEARTBEAT_EVERY < BATCH) {
            const note = `מעדכן דוחות · ${done}/${universe.length} · ${ok - skipped} נכתבו · ${skipped} ללא שינוי${fresh ? ` · ${fresh} דוחות חדשים (${freshNames.join(', ')})` : ''}`;
            await heartbeat(REST_MIN * 60 * 1000, note);
        }
        await sleep(GAP_MS);
    }
    return { ok, fresh, freshNames, skipped, total: universe.length };
}

async function runForever() {
    const _mkts = REPORTS_MARKETS.length ? REPORTS_MARKETS.join('+') : (SWEEP_R2K ? 'us+il+r2k' : 'us+il');
    log(`Finextium Reports-Agent online · site=${SITE} · markets=${_mkts} · batch=${BATCH} · gap=${GAP_MS}ms · rest=${REST_MIN}min`);
    const lastSeen = Object.create(null); // symbol → last stored asOf (for fresh-report detection)
    const nextEarn = Object.create(null); // symbol → stored next-earnings date (skip re-fetch while future)
    const lastSig = Object.create(null);  // symbol → asOf|score|improved|nextEarnings — skip unchanged upserts
    // Seed from what's already in the table so we only flag genuinely NEW reports + skip known dates.
    try {
        // Page through — PostgREST caps a select at 1000 rows and the table now holds ~2600+ (incl. r2k).
        for (let from = 0; ; from += 1000) {
            const { data } = await supabase.from('company_reports').select('symbol,as_of,next_earnings,score,improved').range(from, from + 999);
            for (const r of (data || [])) {
                if (r.as_of) lastSeen[r.symbol] = r.as_of;
                if (r.next_earnings) nextEarn[r.symbol] = r.next_earnings;
                lastSig[r.symbol] = `${r.as_of}|${r.score != null ? r.score : null}|${r.improved ? 1 : 0}|${r.next_earnings || ''}`;
            }
            if (!data || data.length < 1000) break;
        }
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
        const res = await sweep(universe, lastSeen, nextEarn, lastSig);
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        const summary = `סריקת דוחות הושלמה · ${res.ok}/${res.total} עודכנו · ${res.skipped} ללא שינוי (לא נכתבו) · ${res.fresh} דוחות חדשים${res.fresh ? ` (${res.freshNames.join(', ')})` : ''} · ${mins} דק׳`;
        log(`✓ ${summary}`);
        await heartbeat(REST_MIN * 60 * 1000, summary);
        if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
        await sleep(Math.max(1, REST_MIN) * 60 * 1000);
    }
}

runForever().catch(e => fail(e && e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
