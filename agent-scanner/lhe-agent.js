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
const ASSETS = [
  { ticker: 'MSTR', yahoo: 'MSTR', name: 'Strategy (MicroStrategy)', assetClass: 'levered_equity',
    leverage: { debtToEquity: 0.7, convertiblePctOfCap: 0.30, navPremium: 1.55, baseAssetBeta: 1.5 } },
  { ticker: 'BTC', yahoo: 'BTC-USD', name: 'Bitcoin', assetClass: 'crypto',
    onChain: { exchangeNetflow: 30000, illiquidSupplyPct: 0.74, whaleAccumulationScore: 0.3, exchangeReserveRatio: 0.11 } },
  { ticker: 'COIN', yahoo: 'COIN', name: 'Coinbase', assetClass: 'levered_equity',
    leverage: { debtToEquity: 0.4, convertiblePctOfCap: 0.20, navPremium: 1.2, baseAssetBeta: 1.3 } },
  { ticker: 'MARA', yahoo: 'MARA', name: 'MARA Holdings', assetClass: 'levered_equity',
    leverage: { debtToEquity: 0.5, convertiblePctOfCap: 0.35, navPremium: 1.25, baseAssetBeta: 1.6 } },
  { ticker: 'IBIT', yahoo: 'IBIT', name: 'iShares Bitcoin Trust', assetClass: 'etf', measuredLiquidityBeta: 1.5 },
  { ticker: 'NVDA', yahoo: 'NVDA', name: 'NVIDIA', assetClass: 'equity', measuredLiquidityBeta: 1.3 },
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

// ── Build the macro input (live) ──────────────────────────────────────────────
async function buildMacro() {
  const [walcl, tga, rrp, ecb, dgs2, dgs10, t10yie, dfii10] = await Promise.all([
    fred('WALCL'), fred('WTREGEN'), fred('RRPONTSYD'), fred('ECBASSETSW'),
    fred('DGS2'), fred('DGS10'), fred('T10YIE'), fred('DFII10'),
  ]);
  const dlt = (s, div = 1) => (s && s.previous != null) ? (s.value - s.previous) / div : 0;
  return {
    asOf: new Date().toISOString().slice(0, 10),
    fed: { totalAssets: walcl ? walcl.value / 1000 : 0, delta: dlt(walcl, 1000) },  // $M → $bn
    ecb: { totalAssets: ecb ? ecb.value / 1000 : 0, delta: dlt(ecb, 1000) },        // €M → €bn
    boi: { totalAssets: 0, delta: 0 },                                              // FRED lacks a timely BoI sheet
    tga: { level: tga ? tga.value / 1000 : 0, delta: dlt(tga, 1000) },              // WTREGEN is $M → $bn
    rrp: { level: rrp ? rrp.value : 0, delta: dlt(rrp, 1) },                        // RRPONTSYD already $bn
    yields: {
      ust2y: dgs2 ? dgs2.value : 0,
      ust10y: dgs10 ? dgs10.value : 0,
      breakeven10y: t10yie ? t10yie.value : 2.3,
      real10y: dfii10 ? dfii10.value : undefined,
      prev: {
        ust2y: dgs2 && dgs2.previous != null ? dgs2.previous : (dgs2 ? dgs2.value : 0),
        ust10y: dgs10 && dgs10.previous != null ? dgs10.previous : (dgs10 ? dgs10.value : 0),
        breakeven10y: t10yie && t10yie.previous != null ? t10yie.previous : (t10yie ? t10yie.value : 2.3),
      },
    },
    fx: { eurusd: 1.08, usdils: 3.7 },
  };
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

function macroBody(hpi) {
  const flow = hpi.netLiquidityFlow >= 0 ? 'הזרמה' : 'משיכה';
  const dir = hpi.delta >= 0 ? 'מתרחב' : 'מתכווץ';
  return `מצב הנזילות הגלובלי: ${hpi.regime} (HPI ${Math.round(hpi.score)}/100, מומנטום ${hpi.delta >= 0 ? '+' : ''}${hpi.delta}). ` +
    `זרימת נזילות-נטו של ${flow} ~$${Math.abs(hpi.netLiquidityFlow).toFixed(0)} מיליארד — מאזני בנקים מרכזיים מול ניקוז TGA/RRP. ` +
    `הלחץ ${dir}. תעלות ההון בעלות הרגישות הגבוהה ביותר נשאבות ראשונות.`;
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
  const macro = await buildMacro();
  const hpi = computeHPI(macro, cfg);
  log(`HPI ${hpi.score} (${hpi.regime}, Δ${hpi.delta}) · net-liq $${hpi.netLiquidityFlow}bn`);

  // Fetch + enrich candles (sequential, gentle).
  const enriched = [];
  for (const a of ASSETS) {
    const candles = await fetchCandles(a.yahoo);
    if (!candles || candles.length < 30) { log(`skip ${a.ticker}: no candles`); continue; }
    enriched.push({ a, candles, struct: enrich(a, candles) });
    await sleep(700);
  }

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
    body: macroBody(hpi), flags: [],
    payload: {
      components: hpi.components,
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
