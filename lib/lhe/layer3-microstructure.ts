// ============================================================================
// LHE · Layer 3 — Order Flow Gravity (כבידת זרימת הפקודות)
// ----------------------------------------------------------------------------
// "הנוזל מהמאקרו והגישור מתנקז לפקודות קונקרטיות בספר."
//
// כאן משלבים מבנה (Wyckoff/SMC) עם פיזיקה: כל FVG פתוח הוא "מסה" שמייצרת שדה
// כבידה. ככל שהפער גדול וקרוב — המסה גדולה. אנרגיית המאקרו (HPI×Beta) "מטעינה"
// את השדה: בעודף נזילות ונכס בעל רגישות גבוהה, ההסתברות שהמחיר יישאב למלא פער
// עליון (או לבצע MSS) עולה — והזמן המוערך למילוי מתקצר.
//
//   Gravity ∝ mass / √distance  ·  (1 + macroEnergy)
// ============================================================================

import type {
  Candle,
  FairValueGap,
  GravityTarget,
  OrderBlock,
  OrderBook,
  StructureShift,
  HPIResult,
  AssetConduitResult,
  LHEConfig,
  Direction,
} from './types';
import { clamp, logistic, round, trueRange } from './math';

// ─────────────────────────────────────────────────────────────────────────
// ATR — תנודתיות ממוצעת (קצב "שריפת המרחק" של המחיר)
// ─────────────────────────────────────────────────────────────────────────
export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i].high, candles[i].low, candles[i - 1].close));
  }
  const span = Math.min(period, trs.length);
  const recent = trs.slice(-span);
  return recent.reduce((a, b) => a + b, 0) / span;
}

// ─────────────────────────────────────────────────────────────────────────
// FVG — Fair Value Gaps (חורי נזילות, מבנה 3-נרות)
// ─────────────────────────────────────────────────────────────────────────
/**
 * סורק FVGs ומחשב לכל אחד fillRatio (כמה מותך) מול הנרות שאחריו.
 *   • Bullish FVG: high[i-1] < low[i+1]  → אזור ביקוש [high[i-1], low[i+1]].
 *   • Bearish FVG: low[i-1]  > high[i+1] → אזור היצע  [high[i+1], low[i-1]].
 */
export function detectFVGs(candles: Candle[], cfg: LHEConfig): FairValueGap[] {
  const out: FairValueGap[] = [];
  const start = Math.max(1, candles.length - cfg.fvgLookback);

  for (let i = start; i < candles.length - 1; i++) {
    const a = candles[i - 1];
    const c = candles[i + 1];

    let direction: Direction | null = null;
    let top = 0;
    let bottom = 0;

    if (a.high < c.low) {
      direction = 'bullish';
      top = c.low;
      bottom = a.high;
    } else if (a.low > c.high) {
      direction = 'bearish';
      top = a.low;
      bottom = c.high;
    }
    if (!direction) continue;

    const midpoint = (top + bottom) / 2;
    const sizePct = ((top - bottom) / midpoint) * 100;
    if (sizePct < cfg.minFvgSizePct) continue; // סינון רעש

    // מידת המילוי ע"י הנרות שאחרי יצירת הפער.
    const after = candles.slice(i + 2);
    let fillRatio = 0;
    if (after.length) {
      if (direction === 'bullish') {
        // מולא מלמעלה כלפי מטה: עד כמה ה-low ירד לתוך הפער.
        const deepest = Math.min(...after.map((k) => k.low));
        fillRatio = clamp((top - deepest) / (top - bottom), 0, 1);
      } else {
        // מולא מלמטה כלפי מעלה: עד כמה ה-high עלה לתוך הפער.
        const highest = Math.max(...after.map((k) => k.high));
        fillRatio = clamp((highest - bottom) / (top - bottom), 0, 1);
      }
    }

    out.push({
      id: `fvg_${i}_${direction}`,
      direction,
      top: round(top, 4),
      bottom: round(bottom, 4),
      midpoint: round(midpoint, 4),
      createdAt: candles[i].time,
      sizePct: round(sizePct, 3),
      filled: fillRatio >= 0.95,
      fillRatio: round(fillRatio, 3),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// ORDER BLOCKS — הנר האחרון לפני תזוזה אימפולסיבית
// ─────────────────────────────────────────────────────────────────────────
export function detectOrderBlocks(
  candles: Candle[],
  atr: number,
  cfg: LHEConfig,
): OrderBlock[] {
  const out: OrderBlock[] = [];
  if (atr <= 0) return out;
  const threshold = cfg.displacementAtrMult * atr;
  const horizon = 3; // ברים קדימה לבדיקת התזוזה
  const start = Math.max(1, candles.length - cfg.fvgLookback);

  for (let i = start; i < candles.length - horizon; i++) {
    const ob = candles[i];
    const move = candles[i + horizon].close - ob.close;
    const isBearishCandle = ob.close < ob.open;
    const isBullishCandle = ob.close > ob.open;

    // נר ירידה אחרון לפני אימפולס עולה = Order Block של ביקוש (bullish).
    if (isBearishCandle && move > threshold) {
      out.push({
        id: `ob_${i}_bullish`,
        direction: 'bullish',
        top: round(Math.max(ob.open, ob.high), 4),
        bottom: round(Math.min(ob.close, ob.low), 4),
        createdAt: ob.time,
        displacement: round(move / atr, 2),
      });
    }
    // נר עלייה אחרון לפני אימפולס יורד = Order Block של היצע (bearish).
    if (isBullishCandle && -move > threshold) {
      out.push({
        id: `ob_${i}_bearish`,
        direction: 'bearish',
        top: round(Math.max(ob.open, ob.high), 4),
        bottom: round(Math.min(ob.close, ob.low), 4),
        createdAt: ob.time,
        displacement: round(-move / atr, 2),
      });
    }
  }
  // נשמור רק את האחרונים (הרלוונטיים) כדי לא להציף.
  return out.slice(-8);
}

// ─────────────────────────────────────────────────────────────────────────
// MARKET STRUCTURE SHIFT — זיהוי swing-points והיפוך/פריצת מבנה
// ─────────────────────────────────────────────────────────────────────────
interface Swing {
  idx: number;
  price: number;
  kind: 'high' | 'low';
}

/** מזהה swing highs/lows בעזרת פרקטל בחלון ±lookback. */
function findSwings(candles: Candle[], lookback: number): Swing[] {
  const swings: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) isHigh = false;
      if (candles[j].low <= lo) isLow = false;
    }
    if (isHigh) swings.push({ idx: i, price: hi, kind: 'high' });
    if (isLow) swings.push({ idx: i, price: lo, kind: 'low' });
  }
  return swings;
}

/**
 * MSS (היפוך) מול BOS (המשך): פריצת ה-swing האחרון בכיוון ההפוך למגמה = MSS;
 * פריצה בכיוון המגמה = BOS.
 */
export function detectStructureShift(
  candles: Candle[],
  cfg: LHEConfig,
): StructureShift {
  if (candles.length < cfg.swingLookback * 2 + 2) return { detected: false };
  const swings = findSwings(candles, cfg.swingLookback);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  if (highs.length < 2 || lows.length < 2) return { detected: false };

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  const close = candles[candles.length - 1].close;

  // מגמה קודמת מרצף ה-swings.
  const uptrend = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
  const downtrend = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

  // פריצה כלפי מעלה מעל ה-swing high האחרון.
  if (close > lastHigh.price) {
    return {
      detected: true,
      type: downtrend ? 'MSS' : 'BOS',
      direction: 'bullish',
      brokenLevel: round(lastHigh.price, 4),
      at: candles[candles.length - 1].time,
    };
  }
  // פריצה כלפי מטה מתחת ל-swing low האחרון.
  if (close < lastLow.price) {
    return {
      detected: true,
      type: uptrend ? 'MSS' : 'BOS',
      direction: 'bearish',
      brokenLevel: round(lastLow.price, 4),
      at: candles[candles.length - 1].time,
    };
  }
  return { detected: false };
}

// ─────────────────────────────────────────────────────────────────────────
// ORDER-BOOK THINNESS — דקות הספר במסדרון שבין המחיר ליעד (מאיץ מילוי)
// ─────────────────────────────────────────────────────────────────────────
function bookThinnessFactor(
  book: OrderBook | undefined,
  price: number,
  target: number,
): number {
  if (!book) return 1;
  const up = target > price;
  const levels = up ? book.asks : book.bids;
  if (!levels?.length) return 1;
  const lo = Math.min(price, target);
  const hi = Math.max(price, target);
  const inPath = levels.filter((l) => l.price >= lo && l.price <= hi);
  const pathDepth = inPath.reduce((s, l) => s + l.size, 0);
  const avgLevel = levels.reduce((s, l) => s + l.size, 0) / levels.length;
  if (avgLevel <= 0) return 1;
  const corridorAvg = inPath.length ? pathDepth / inPath.length : 0;
  // מסדרון דליל יחסית לעומק הממוצע ⇒ מילוי מהיר יותר (factor > 1).
  const thinness = (avgLevel - corridorAvg) / avgLevel; // -1..1
  return clamp(1 + thinness * 0.3, 0.8, 1.4);
}

// ─────────────────────────────────────────────────────────────────────────
// GRAVITY — שילוב המאקרו/גישור לתוך כל FVG פתוח
// ─────────────────────────────────────────────────────────────────────────
/**
 * מחשב ציון מגנטיות, הסתברות מילוי וזמן-מוערך-למילוי עבור FVG בודד.
 * זהו צומת האינטגרציה של שלוש השכבות.
 */
export function computeGravity(
  fvg: FairValueGap,
  currentPrice: number,
  hpi: HPIResult,
  conduit: AssetConduitResult,
  atr: number,
  _cfg: LHEConfig,
  orderBook?: OrderBook,
): GravityTarget {
  const distancePct = Math.abs(fvg.midpoint - currentPrice) / currentPrice;
  const safeDist = Math.max(distancePct, 0.0005);
  const above = fvg.midpoint > currentPrice;
  const pullDirection: Direction = above ? 'bullish' : 'bearish';

  // ── מסה: גודל הפער (מה שנותר לא-מולא) × רגישות הנכס ─────────────────
  const unfilled = 1 - fvg.fillRatio;
  const mass = (fvg.sizePct / 100) * unfilled * (1 + Math.log2(1 + Math.max(0, conduit.liquidityBeta)));

  // ── אנרגיית מאקרו: רמה + מומנטום של הנזילות, מיושרת לכיוון השאיבה ────
  const liquidityField = ((hpi.score - 50) / 50) * 0.5 + (hpi.delta / 100) * 0.5; // -1..+1
  // עודף נזילות (field>0) דוחף מחיר מעלה ⇒ מחזק פערים מעל; מחליש פערים מתחת.
  const directionalEnergy = (above ? 1 : -1) * liquidityField;

  // ── דקות הספר (אם קיים) ──────────────────────────────────────────────
  const bookFactor = bookThinnessFactor(orderBook, currentPrice, fvg.midpoint);

  // ── שדה הכבידה: מסה / √מרחק, מוטען באנרגיית המאקרו ──────────────────
  const fieldStrength =
    (mass / Math.sqrt(safeDist)) * (1 + clamp(directionalEnergy, -0.7, 1.2)) * bookFactor;

  // נרמול ל-0..100 (לוגיסטי; העוגן 1.2 ממקם "שדה טיפוסי" סביב 50).
  const gravityScore = clamp(100 * logistic(1.1 * (Math.log(1 + fieldStrength) - 1.2)), 0, 100);

  // הסתברות מילוי — חסומה כדי לא להבטיח ודאות.
  const fillProbability = clamp(0.12 + 0.85 * (gravityScore / 100), 0.02, 0.97);

  // זמן-מוערך-למילוי: מרחק / (תנודתיות × אנרגיה). יותר אנרגיה ⇒ מהיר יותר.
  const atrPct = currentPrice > 0 ? atr / currentPrice : 0;
  const energyFactor = Math.max(0.3, 1 + directionalEnergy);
  const barsRaw = safeDist / Math.max(atrPct * energyFactor, 1e-4);
  const expectedBarsToFill = Math.ceil(clamp(barsRaw, 1, 5000));

  return {
    fvg,
    gravityScore: round(gravityScore, 1),
    fillProbability: round(fillProbability, 3),
    expectedBarsToFill,
    distancePct: round(distancePct * 100, 3),
    direction: pullDirection,
  };
}
