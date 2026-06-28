// ============================================================================
// Finextium — LHE Agent (24/7 Liquidity Hydrodynamic Engine feed)
// ----------------------------------------------------------------------------
// Sibling of scanner.js / reports-agent.js. On a gentle cadence it:
//   1. Pulls LIVE macro from FRED (Fed balance sheet, TGA, RRP, ECB, yields) → HPI.
//   2. Pulls LIVE daily candles from Yahoo for a curated set of liquidity-sensitive
//      assets (MSTR, BTC, COIN, …), enriches with computed momentum/vol.
//   3. Runs the LHE engine (lib/lhe) → confluence + FVG gravity + alert.
//   4. Polishes the Hebrew narrative via Gemini (optional, falls back gracefully).
//   5. Upserts each signal into Supabase `lhe_signals` (secret-gated RPC). The
//      platform's "מנוע נזילות" page reads that table — fresh signals land 24/7.
//
// GENTLE on the DB (the auth service shares the 60-conn pool): few assets,
// sequential writes, ~20-min cadence. Never crank LHE_INTERVAL_MIN below ~10.
//
// Run:  node lhe-agent.js          (daemon)
//       node lhe-agent.js --once   (single cycle, then exit)
// ============================================================================

require('dotenv').config();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

// The compiled engine (CommonJS). scp lib/lhe/dist to the VPS alongside this file.
const { runLHE, generateLHEAlert, computeHPI, rankConduits, resolveConfig } =
  require(path.join(__dirname, '..', 'lib', 'lhe', 'dist', 'index.js'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
const FRED_KEY = process.env.FRED_API_KEY || 'f568440cde5cb64b20cd92e80292fbac';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const INTERVAL_MIN = Math.max(10, parseFloat(process.env.LHE_INTERVAL_MIN || '20'));
const RUN_ONCE = process.argv.includes('--once');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Curated universe: assets where the liquidity→price transmission is strongest.
// The structural amplifiers (leverage / on-chain) are slowly-changing priors — update
// occasionally; momentum & vol are computed LIVE from candles each cycle.
// Core GLOBAL macro asset classes — the canonical map of where global liquidity flows.
// measuredLiquidityBeta = a sensible prior for each class's sensitivity to Net-Liquidity
// (US growth > EM > credit > broad equity > bonds > gold). momentum/vol computed live.
const ASSETS = [
  { ticker: 'SPY', yahoo: 'SPY', name: 'S&P 500', assetClass: 'etf', measuredLiquidityBeta: 1.0 },
  { ticker: 'QQQ', yahoo: 'QQQ', name: 'נאסד"ק 100 (QQQ)', assetClass: 'etf', measuredLiquidityBeta: 1.25 },
  { ticker: 'GLD', yahoo: 'GLD', name: 'זהב (Gold)', assetClass: 'commodity', measuredLiquidityBeta: 0.55 },
  { ticker: 'TLT', yahoo: 'TLT', name: 'אג"ח ממשלתי ארה"ב 20Y+ (TLT)', assetClass: 'etf', measuredLiquidityBeta: 0.8 },
  { ticker: 'HYG', yahoo: 'HYG', name: 'אג"ח קונצרני High-Yield (HYG)', assetClass: 'etf', measuredLiquidityBeta: 1.1 },
  { ticker: 'BTC', yahoo: 'BTC-USD', name: 'ביטקוין (Bitcoin)', assetClass: 'crypto',
    onChain: { exchangeNetflow: 30000, illiquidSupplyPct: 0.74, whaleAccumulationScore: 0.3, exchangeReserveRatio: 0.11 } },
  { ticker: 'EEM', yahoo: 'EEM', name: 'שווקים מתעוררים (EM)', assetClass: 'etf', measuredLiquidityBeta: 1.35 },
  { ticker: 'EFA', yahoo: 'EFA', name: 'מניות מפותחות ex-US (אירופה/יפן)', assetClass: 'etf', measuredLiquidityBeta: 1.1 },
];

// ── FRED: latest + previous observation (for deltas/momentum) ─────────────────
async function fred(id, units = 'lin') {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}` +
      `&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=2&units=${units}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const obs = (j.observations || []).filter(o => o.value !== '.' && o.value !== '');
    if (!obs.length) return null;
    return { value: +obs[0].value, previous: obs[1] ? +obs[1].value : null, date: obs[0].date };
  } catch (e) { return null; }
}

// ── Fetch EVERY FRED series we use, once (parallel) ───────────────────────────
async function fetchAll() {
  const ids = {
    walcl: 'WALCL', tga: 'WTREGEN', rrp: 'RRPONTSYD', ecb: 'ECBASSETSW',
    dgs2: 'DGS2', dgs10: 'DGS10', t10yie: 'T10YIE', dfii10: 'DFII10',
    nfci: 'NFCI', hyoas: 'BAMLH0A0HYM2', vix: 'VIXCLS', usd: 'DTWEXBGS', reserves: 'WRESBAL',
    mmf: 'MMMFFAQ027S', currency: 'WCURCIR', debt: 'GFDEBTN', fedbs: 'WALCL',
  };
  const keys = Object.keys(ids);
  const [arr, m2growth] = await Promise.all([
    Promise.all(keys.map(k => fred(ids[k]))),
    fred('M2SL', 'pc1'), // M2 % YoY directly
  ]);
  const out = {};
  keys.forEach((k, i) => { out[k] = arr[i]; });
  out.m2growth = m2growth;
  return out;
}

// ── Build the macro input (live) — now incl. ALL broad liquidity factors ──────
function buildMacro(d) {
  const dlt = (s, div = 1) => (s && s.previous != null) ? (s.value - s.previous) / div : 0;
  return {
    asOf: new Date().toISOString().slice(0, 10),
    fed: { totalAssets: d.walcl ? d.walcl.value / 1000 : 0, delta: dlt(d.walcl, 1000) },  // $M → $bn
    ecb: { totalAssets: d.ecb ? d.ecb.value / 1000 : 0, delta: dlt(d.ecb, 1000) },        // €M → €bn
    boi: { totalAssets: 0, delta: 0 },                                                    // FRED lacks a timely BoI sheet
    tga: { level: d.tga ? d.tga.value / 1000 : 0, delta: dlt(d.tga, 1000) },              // WTREGEN $M → $bn
    rrp: { level: d.rrp ? d.rrp.value : 0, delta: dlt(d.rrp, 1) },                        // RRPONTSYD already $bn
    yields: {
      ust2y: d.dgs2 ? d.dgs2.value : 0,
      ust10y: d.dgs10 ? d.dgs10.value : 0,
      breakeven10y: d.t10yie ? d.t10yie.value : 2.3,
      real10y: d.dfii10 ? d.dfii10.value : undefined,
      prev: {
        ust2y: d.dgs2 && d.dgs2.previous != null ? d.dgs2.previous : (d.dgs2 ? d.dgs2.value : 0),
        ust10y: d.dgs10 && d.dgs10.previous != null ? d.dgs10.previous : (d.dgs10 ? d.dgs10.value : 0),
        breakeven10y: d.t10yie && d.t10yie.previous != null ? d.t10yie.previous : (d.t10yie ? d.t10yie.value : 2.3),
      },
    },
    // ── ALL broad liquidity factors ──
    conditions: {
      nfci: d.nfci ? d.nfci.value : undefined,         // Chicago Fed financial conditions (100+ indicators)
      hyOAS: d.hyoas ? d.hyoas.value : undefined,      // high-yield credit spread %
      vix: d.vix ? d.vix.value : undefined,            // volatility
      dollarChange: dlt(d.usd, 1),                     // broad USD change (stronger = tighter)
      m2Growth: d.m2growth ? d.m2growth.value : undefined, // M2 % YoY
      reservesDelta: dlt(d.reserves, 1000),            // bank reserves change $M → $bn
    },
    fx: { eurusd: 1.08, usdils: 3.7 },
  };
}

// Recent price direction of a candle series (for Finviz-style green/red coloring).
function candleDir(candles, lookback = 5) {
  if (!candles || candles.length < lookback + 1) return 'flat';
  const a = candles[candles.length - 1].close, b = candles[candles.length - 1 - lookback].close;
  if (!b) return 'flat';
  const pct = (a - b) / b * 100;
  return pct > 0.3 ? 'up' : pct < -0.3 ? 'down' : 'flat';
}

// ── Liquidity map: WHERE the money sits. `dirs` = live price direction per asset
// (so each tile is colored green/red by real movement, Finviz-style). ──────────
function buildLiquidityMap(d, dirs = {}) {
  const tM = (s) => (s && s.value != null) ? +(s.value / 1e6).toFixed(2) : null; // $millions → $T
  const fredDir = (s) => (s && s.previous != null) ? (s.value > s.previous ? 'up' : s.value < s.previous ? 'down' : 'flat') : 'flat';
  const pools = [];
  // label = full (tooltip), short = clean tile label (never mid-name clipped).
  const push = (label, short, valueT, group, dir, live, scope) => { if (valueT != null) pools.push({ label, short, valueT, group, dir, live, scope }); };

  // Equities (deployed) — colored by the live index price direction
  push('מניות ארה"ב (S&P 500)', 'מניות ארה״ב', 58, 'market', dirs.SPY || 'flat', false, 'us');
  push('מניות גלובליות (ex-US)', 'מניות גלובליות', 45, 'market', dirs.EFA || dirs.EEM || 'flat', false, 'global');
  // Bonds (deployed) — colored by the long-bond (TLT) / credit (HYG) price direction
  push('אג"ח ממשלתי ארה"ב', 'אג״ח ממשלתי', tM(d.debt), 'bonds', dirs.TLT || fredDir(d.debt), true, 'us');
  push('אג"ח קונצרני ארה"ב (HY)', 'אג״ח קונצרני', 11, 'bonds', dirs.HYG || 'flat', false, 'us');
  // Cash on the sidelines — US dollar plumbing, colored by the live FRED weekly flow
  push('קרנות כספיות (מזומן בצד)', 'קרנות', tM(d.mmf), 'cash', fredDir(d.mmf), true, 'us');
  push('רזרבות בנקים (הפד)', 'רזרבות', tM(d.reserves), 'cash', fredDir(d.reserves), true, 'us');
  push('מזומן במחזור', 'מזומן', tM(d.currency), 'cash', fredDir(d.currency), true, 'us');
  push('חשבון האוצר (TGA)', 'TGA', tM(d.tga), 'cash', fredDir(d.tga), true, 'us');
  push('ריפו הפוך (RRP)', 'RRP', d.rrp ? +(d.rrp.value / 1000).toFixed(3) : null, 'cash', fredDir(d.rrp), true, 'us');
  // Global stores of value — colored by gold (GLD) / crypto (BTC) price direction
  push('זהב (גלובלי)', 'זהב', 18, 'other', dirs.GLD || 'flat', false, 'global');
  push('קריפטו (גלובלי)', 'קריפטו', 2.8, 'other', dirs.BTC || 'flat', false, 'global');

  const cashT = pools.filter(p => p.group === 'cash').reduce((s, p) => s + p.valueT, 0);
  return { pools, cashSidelinesT: +cashT.toFixed(2) };
}

// ── Does the macro/liquidity backdrop FAVOR this specific asset? ───────────────
function macroFitFor(struct, conduit, hpi) {
  const expanding = (hpi.score - 50) / 50 * 0.6 + hpi.delta / 100 * 0.4; // -1..+1 (liquidity direction)
  const beta = conduit.liquidityBeta;
  const defensive = struct.assetClass === 'commodity' || beta < 0.9; // gold, long bonds
  // Risk assets like expansion; defensives are relatively favored when liquidity drains / risk-off.
  const fit = defensive ? -expanding * 0.7 : expanding;
  const regHe = { flood: 'הצפת נזילות', expansion: 'התרחבות נזילות', neutral: 'נזילות מאוזנת', drain: 'ניקוז נזילות', drought: 'בצורת נזילות' }[hpi.regime] || hpi.regime;
  let verdict, label;
  if (fit > 0.12) { verdict = 'tailwind'; label = 'המאקרו תומך בנכס'; }
  else if (fit < -0.12) { verdict = 'headwind'; label = 'המאקרו מנוגד לנכס'; }
  else { verdict = 'neutral'; label = 'המאקרו ניטרלי לנכס'; }
  const role = defensive ? `נכס מגן (β=${beta.toFixed(2)})` : `נכס סיכון (β=${beta.toFixed(2)})`;
  const because = verdict === 'tailwind'
    ? (defensive ? `סביבת ${regHe} פועלת לטובתו` : `הרחבת נזילות = רוח גבית`)
    : verdict === 'headwind'
      ? (defensive ? `נזילות מתרחבת מעדיפה נכסי סיכון על פניו` : `${regHe} = רוח נגדית`)
      : `הרקע מעורב`;
  return { verdict, label, reason: `${role}: ${because}.` };
}

// ── Yahoo daily candles (v8 chart API — no crumb needed) ──────────────────────
async function fetchCandles(yahooSym) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=6mo&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) return null;
    const q = res.indicators.quote[0];
    return res.timestamp.map((t, i) => ({
      time: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
    })).filter(c => c.open != null && c.high != null && c.low != null && c.close != null);
  } catch (e) { return null; }
}

// ── Live momentum + realized vol from candles → enriches the asset structure ──
function enrich(asset, candles) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const momentum20d = n > 21 ? ((closes[n - 1] - closes[n - 21]) / closes[n - 21]) * 100 : 0;
  const rets = [];
  for (let i = Math.max(1, n - 21); i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length || 1);
  const realizedVol = Math.sqrt(variance) * Math.sqrt(252) * 100;
  return { ...asset, momentum20d: +momentum20d.toFixed(2), realizedVol: +realizedVol.toFixed(1) };
}

// ── Gemini polish: rewrite the deterministic body to fluent analyst Hebrew. ────
// Strictly a STYLE pass — it must not invent numbers. Falls back to the original.
async function geminiPolish(body) {
  if (!GEMINI_API_KEY) return null;
  const prompt =
    'אתה עורך-אנליסט מאקרו בכיר בעברית. שכתב את גוף ההתרעה הבא לעברית מקצועית, שוטפת וברורה ' +
    'עבור מנהלי תיקים. חוקים: אל תוסיף, תשנה או תמציא אף מספר/אחוז/רמת-מחיר — שמור עליהם בדיוק. ' +
    'אל תוסיף המלצת קנייה/מכירה. שמור על מבנה הפסקאות (מאקרו/גישור/מיקרו/מבנה/מסקנה). החזר טקסט בלבד.\n\n' + body;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.25 } }) });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    return txt ? txt.trim() : null;
  } catch (e) { return null; }
}

function macroBody(hpi, macro) {
  const flow = hpi.netLiquidityFlow >= 0 ? 'הזרמה' : 'משיכה';
  const dir = hpi.delta >= 0 ? 'מתרחב' : 'מתכווץ';
  const c = (macro && macro.conditions) || {};
  const bits = [];
  if (c.nfci != null) bits.push(`תנאים פיננסיים ${c.nfci < 0 ? 'רופפים' : 'מהודקים'} (NFCI ${c.nfci.toFixed(2)})`);
  if (c.hyOAS != null) bits.push(`מרווחי אשראי ${c.hyOAS.toFixed(2)}%`);
  if (c.vix != null) bits.push(`VIX ${c.vix.toFixed(1)}`);
  if (c.m2Growth != null) bits.push(`M2 ${c.m2Growth >= 0 ? '+' : ''}${c.m2Growth.toFixed(1)}% שנתי`);
  return `מצב הנזילות הגלובלי: ${hpi.regime} (HPI ${Math.round(hpi.score)}/100, מומנטום ${hpi.delta >= 0 ? '+' : ''}${hpi.delta}). ` +
    `זרימת נזילות-נטו של ${flow} ~$${Math.abs(hpi.netLiquidityFlow).toFixed(0)} מיליארד. ` +
    (bits.length ? `גורמי נזילות: ${bits.join(' · ')}. ` : '') +
    `הלחץ ${dir}; תעלות ההון בעלות הרגישות הגבוהה ביותר נשאבות ראשונות.`;
}

async function upsertSignal(item) {
  const { error } = await supabase.rpc('upsert_lhe_signal', { p_secret: AGENT_WRITE_SECRET, p_item: item });
  if (error) log(`upsert ${item.ticker} warn:`, error.message);
  return !error;
}

async function heartbeat(note) {
  try {
    const next = new Date(Date.now() + INTERVAL_MIN * 60 * 1000).toISOString();
    await supabase.rpc('upsert_agent_status', { p_secret: AGENT_WRITE_SECRET, p_agent: 'lhe', p_next_run: next, p_result: note });
  } catch (e) { log('heartbeat warn:', e.message); }
}

// ── One full cycle ────────────────────────────────────────────────────────────
async function cycle() {
  const cfg = resolveConfig();
  const d = await fetchAll();
  const macro = buildMacro(d);
  const hpi = computeHPI(macro, cfg);
  log(`HPI ${hpi.score} (${hpi.regime}, Δ${hpi.delta}) · net-liq $${hpi.netLiquidityFlow}bn · NFCI ${macro.conditions.nfci}`);

  // Fetch + enrich candles (sequential, gentle).
  const enriched = [];
  for (const a of ASSETS) {
    const candles = await fetchCandles(a.yahoo);
    if (!candles || candles.length < 30) { log(`skip ${a.ticker}: no candles`); continue; }
    enriched.push({ a, candles, struct: enrich(a, candles) });
    await sleep(700);
  }

  // Live price direction per asset → colors the liquidity-map tiles green/red.
  const dirs = {};
  for (const e of enriched) dirs[e.a.ticker] = candleDir(e.candles, 5);
  const liquidityMap = buildLiquidityMap(d, dirs);

  const ranking = rankConduits(enriched.map(e => e.struct), hpi, cfg);

  let ok = 0, alerts = 0;
  for (const e of enriched) {
    let result;
    try { result = runLHE({ macro, asset: e.struct, candles: e.candles, config: cfg }); }
    catch (err) { log(`runLHE ${e.a.ticker} failed:`, err.message); continue; }
    const alert = generateLHEAlert(result);
    if (alert.severity === 'critical' || alert.severity === 'high') alerts++;
    const aiBody = await geminiPolish(alert.body);
    const item = {
      ticker: e.a.ticker, kind: 'asset', name: e.a.name, as_of: result.asOf,
      hpi_score: result.hpi.score, hpi_delta: result.hpi.delta, regime: result.hpi.regime,
      net_liquidity_flow: result.hpi.netLiquidityFlow,
      liquidity_beta: result.conduit.liquidityBeta, attraction_score: result.conduit.attractionScore,
      confluence_score: result.confluence.score, bias: result.confluence.bias, severity: alert.severity,
      headline: alert.headline, body: aiBody || alert.body,
      target: alert.target || null, flags: result.confluence.flags,
      payload: {
        drivers: result.conduit.drivers,
        gravityTargets: result.gravityTargets.slice(0, 3),
        structureShift: result.microstructure.structureShift,
        currentPrice: result.microstructure.currentPrice,
        fvgCount: result.microstructure.fvgs.length,
        macroFit: macroFitFor(e.struct, result.conduit, result.hpi),
        aiPolished: !!aiBody,
      },
    };
    if (await upsertSignal(item)) ok++;
    await sleep(500);
  }

  // Macro-level signal (HPI + conduit ranking).
  await upsertSignal({
    ticker: '_MACRO', kind: 'macro', name: 'מצב הנזילות הגלובלי', as_of: macro.asOf,
    hpi_score: hpi.score, hpi_delta: hpi.delta, regime: hpi.regime, net_liquidity_flow: hpi.netLiquidityFlow,
    confluence_score: null, bias: null,
    severity: (hpi.regime === 'flood' || hpi.regime === 'drought') ? 'high' : 'info',
    headline: `HPI ${Math.round(hpi.score)} · ${hpi.regime} (${hpi.delta >= 0 ? '+' : ''}${hpi.delta})`,
    body: macroBody(hpi, macro), flags: [],
    payload: {
      components: hpi.components,
      conditions: macro.conditions,
      liquidityMap,
      ranking: ranking.map(r => ({ ticker: r.ticker, rank: r.rank, attraction: r.attractionScore, beta: r.liquidityBeta })),
    },
  });

  const note = `מנוע נזילות עודכן · HPI ${Math.round(hpi.score)} (${hpi.regime}) · ${ok}/${enriched.length} נכסים · ${alerts} התלכדויות חזקות`;
  await heartbeat(note);
  log(`✓ ${note}`);
  return ok;
}

async function runForever() {
  log(`Finextium LHE-Agent online · interval=${INTERVAL_MIN}min · assets=${ASSETS.length} · gemini=${GEMINI_API_KEY ? 'on' : 'off'}`);
  for (;;) {
    try { await cycle(); } catch (e) { log('cycle error:', e && e.message); }
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    await sleep(INTERVAL_MIN * 60 * 1000);
  }
}

runForever().catch(e => fail(e && e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
