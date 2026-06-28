// ============================================================================
// LHE · End-to-End Worked Example
// ----------------------------------------------------------------------------
// תרחיש הדגמה: עודף נזילות מאקרו (Fed מרחיב, TGA+RRP מתנקזים, תשואות מתרככות)
// פוגש נכס levered_equity רפלקסיבי בסגנון Strategy Inc (מחזיק BTC במאזן, פרמיית
// mNAV, אג"ח להמרה) — ובגרף יש FVG עליון פתוח. המנוע אמור לזהות התלכדות עולה
// חזקה ולהפיק התרעה.
//
// הרצה (אם מותקן ts-node):  npx ts-node lib/lhe/example.ts
// או הידור:                 npx tsc -p lib/lhe && node lib/lhe/dist/example.js
// ============================================================================

import { runLHE, generateLHEAlert } from './index';
import type { Candle, LHEInput } from './types';

// המודול אגנוסטי לסביבה (אין lib DOM/node). מצהירים console מינימלי לדוגמה בלבד.
declare const console: { log: (...args: unknown[]) => void };

// ── נרות מפורשים ודטרמיניסטיים (OHLCV) המתארים תרחיש נקי: ────────────────
//   טווח דיסטריביושן → אימפולס ירידה שמשאיר FVG דובי פתוח באזור 103.9–108
//   → התאוששות שנעצרת *מתחת* לפער (נשאר פתוח כמגנט עליון) ופורצת swing-high
//   מקומי = MSS עולה. תחת עודף נזילות + β גבוה → התלכדות עולה חזקה.
const k = (time: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({
  time, open: o, high: h, low: l, close: c, volume: v,
});
function buildCandles(): Candle[] {
  return [
    // Phase 1 — דיסטריביושן/טווח, swing-high ~117 (המגמה שתישבר אח"כ)
    k(0, 112, 113, 111, 112.5), k(1, 112.5, 114, 112, 113.5), k(2, 113.5, 115, 113, 114.5),
    k(3, 114.5, 116, 114, 115.5), k(4, 115.5, 117, 115, 116.5), k(5, 116.5, 117.2, 115.5, 116),
    k(6, 116, 116.5, 114.5, 115), k(7, 115, 115.5, 113.5, 114), k(8, 114, 114.5, 112.5, 113),
    k(9, 113, 113.5, 111, 112.5), k(10, 112.5, 113.5, 112, 113), k(11, 113, 114, 112, 112.5), // bar9 = swing-low פאזה 1
    k(12, 112.5, 113, 111.5, 112), k(13, 112, 112.5, 111, 111.5),
    // Phase 2 — אימפולס ירידה → FVG דובי [103.9, 108] (a.low 108 > c.high 103.9)
    k(14, 111.5, 112, 108, 108.2, 3000), // a
    k(15, 108.2, 108.5, 103.5, 104, 6000), // displacement
    k(16, 103.9, 103.9, 99, 100, 4000), // c
    // Phase 3 — התאוששות הנעצרת מתחת ל-103.9, פורצת swing-high מקומי (MSS עולה)
    k(17, 100, 101, 99.5, 100.8), k(18, 100.8, 101.5, 100.3, 101.2), k(19, 101.2, 101.6, 100.5, 100.9),
    k(20, 100.9, 101.4, 100.2, 101.0), k(21, 101.0, 102.2, 100.8, 101.8),
    k(22, 101.8, 103.0, 101.5, 102.6), // swing-high מקומי (103.0)
    k(23, 102.6, 102.5, 101.6, 101.9), k(24, 101.9, 102.0, 101.2, 101.6), // pullback (swing-low)
    k(25, 101.6, 102.5, 101.4, 102.4), k(26, 102.4, 103.4, 102.2, 103.2), // פריצה מעל 103.0 → MSS
    k(27, 103.2, 103.5, 102.9, 103.1), k(28, 103.1, 103.4, 102.8, 103.0), k(29, 103.0, 103.3, 102.7, 103.2),
  ];
}

const input: LHEInput = {
  macro: {
    asOf: '2026-06-28',
    fed: { totalAssets: 7200, delta: +120 }, // QE: +120bn
    ecb: { totalAssets: 6400, delta: +30 },
    boi: { totalAssets: 720, delta: +5 },
    tga: { level: 600, delta: -90 }, // ניקוז TGA → הזרמה
    rrp: { level: 350, delta: -110 }, // ניקוז RRP → הזרמה
    yields: {
      ust2y: 3.9,
      ust10y: 4.05,
      breakeven10y: 2.2,
      real10y: 1.6,
      prev: { ust2y: 4.1, ust10y: 4.35, breakeven10y: 2.3 }, // תשואות יורדות
    },
    fx: { eurusd: 1.08, usdils: 3.7 },
  },
  asset: {
    ticker: 'MSTR',
    name: 'Strategy Inc',
    assetClass: 'levered_equity',
    momentum20d: 18,
    realizedVol: 75,
    leverage: {
      debtToEquity: 0.8,
      convertiblePctOfCap: 0.25,
      navPremium: 1.7, // פרמיית mNAV — רפלקסיביות גבוהה
      baseAssetBeta: 1.6, // BTC
    },
  },
  peers: [
    { ticker: 'BTC', name: 'Bitcoin', assetClass: 'crypto', momentum20d: 9,
      onChain: { exchangeNetflow: 35000, illiquidSupplyPct: 0.74, whaleAccumulationScore: 0.5, exchangeReserveRatio: 0.11 } },
    { ticker: 'AAPL', name: 'Apple', assetClass: 'equity', momentum20d: 2 },
  ],
  candles: buildCandles(),
  config: { swingLookback: 3 }, // סדרה קצרה לדוגמה → חלון swing קצר יותר
};

const result = runLHE(input);
const alert = generateLHEAlert(result);

// eslint-disable-next-line no-console
console.log('── HPI ──', result.hpi);
// eslint-disable-next-line no-console
console.log('── Conduit ──', result.conduit);
// eslint-disable-next-line no-console
console.log('── Peer ranking ──', result.peerRanking?.map((r) => `${r.rank}. ${r.ticker} (${r.attractionScore})`));
// eslint-disable-next-line no-console
console.log('── Top gravity target ──', result.gravityTargets[0]);
// eslint-disable-next-line no-console
console.log('── Confluence ──', result.confluence);
// eslint-disable-next-line no-console
console.log('\n=== ALERT ===\n' + alert.headline + '\n\n' + alert.body);
