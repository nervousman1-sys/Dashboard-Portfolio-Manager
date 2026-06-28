// ============================================================================
// LHE · Layer 1 — Hydraulic Pressure Index (HPI)
// ----------------------------------------------------------------------------
// "כמה נוזל יש במערכת, ולאן הוא נע."
//
// הרעיון המרכזי הוא ה-Net Liquidity הקנוני:
//     Net Liquidity = מאזן הבנק המרכזי − TGA − RRP
// כסף שיושב ב-TGA (חשבון האוצר) או ב-RRP (ריפו הפוך) הוא נזילות "כלואה" מחוץ
// לשוק; כשהם יורדים — הנזילות משתחררת אל הנכסים. אנו מרחיבים זאת גלובלית
// (Fed+ECB+BoI) ומוסיפים שכבת "חיכוך" של תשואות ואינפלציה שמתנגדת לזרימה.
//
// פלט: score (0..100, רמת הלחץ) + delta (מומנטום -100..+100) + פירוק רכיבים.
// ============================================================================

import type { HPIResult, LiquidityRegime, MacroLiquidityInput, LHEConfig } from './types';
import { clamp, tanhSquash, toScore100, round, weightedSum } from './math';

/** ממפה ציון 0..100 למשטר נזילות מילולי. */
function classifyRegime(score: number): LiquidityRegime {
  if (score >= 80) return 'flood';
  if (score >= 60) return 'expansion';
  if (score >= 40) return 'neutral';
  if (score >= 20) return 'drain';
  return 'drought';
}

/**
 * מנרמל מאזני בנקים מרכזיים זרים ל-USD.
 * ה-deltas מגיעים במטבע מקומי; ממירים לפי שער החליפין.
 */
function globalCentralBankFlowBn(macro: MacroLiquidityInput): number {
  const eurusd = macro.fx?.eurusd ?? 1.08;
  const usdils = macro.fx?.usdils ?? 3.7;
  const fedFlow = macro.fed.delta; // כבר ב-USD bn
  const ecbFlow = macro.ecb.delta * eurusd; // EUR bn → USD bn
  const boiFlow = macro.boi.delta / usdils; // ILS bn → USD bn
  return fedFlow + ecbFlow + boiFlow;
}

/**
 * מחשב את מדד הלחץ ההידראולי.
 *
 * הפרדה מושגית חשובה:
 *   • delta (מומנטום) — נגזר מ-flows (השינויים): ΔCB, −ΔTGA, −ΔRRP, −Δyield.
 *     זה "לאן הנוזל זורם עכשיו".
 *   • score (רמה) — נגזר מאותם flows אך מעוגן גם ב-levels (ריבית ריאלית, תלילות
 *     העקום, אינפלציה גלומה) כדי לשקף את "מצב המערכת", לא רק את קצב השינוי.
 */
export function computeHPI(macro: MacroLiquidityInput, cfg: LHEConfig): HPIResult {
  const scale = cfg.netLiquidityScaleBn;
  const w = cfg.hpiWeights;

  // ── 1. זרימת נזילות נטו (החלק הדומיננטי) ─────────────────────────────
  const cbFlowBn = globalCentralBankFlowBn(macro);
  // ירידה ב-TGA/RRP (delta שלילי) = הזרמה לשוק ⇒ הופכים סימן.
  const treasuryReleaseBn = -macro.tga.delta;
  const repoReleaseBn = -macro.rrp.delta;
  const netLiquidityFlow = cbFlowBn + treasuryReleaseBn + repoReleaseBn;

  // נרמול רך לכל רכיב ל-[-1, +1].
  const cCb = tanhSquash(cbFlowBn / scale);
  const cTga = tanhSquash(treasuryReleaseBn / scale);
  const cRrp = tanhSquash(repoReleaseBn / scale);

  // ── 2. דחף התשואות (תנאים פיננסיים) ──────────────────────────────────
  // תשואות ארוכות יורדות = הקלה (חיובי); עולות = הידוק (שלילי).
  const dYield10 = macro.yields.prev
    ? macro.yields.ust10y - macro.yields.prev.ust10y
    : 0;
  // 50bp תזוזה ≈ יחידה מלאה.
  const yieldMomentum = tanhSquash(-dYield10 / 0.5);

  // רמת הריבית הריאלית: גבוהה = תנאים מגבילים (שלילי). עוגן ~0.5% כ"ניטרלי".
  const real10y =
    macro.yields.real10y ?? macro.yields.ust10y - macro.yields.breakeven10y;
  const realRateLevel = tanhSquash(-(real10y - 0.5) / 1.5);

  // תלילות העקום: עקום הפוך (10y<2y) = מצוקת נזילות/סוף-מחזור (שלילי).
  const curve = macro.yields.ust10y - macro.yields.ust2y;
  const curveLevel = tanhSquash(curve / 1.0); // 100bp תלילות ≈ יחידה

  // רכיב התשואות המשולב: דחף (מומנטום) + רמה (ריאלי+עקום).
  const yieldImpulse = clamp(
    0.5 * yieldMomentum + 0.3 * realRateLevel + 0.2 * curveLevel,
    -1,
    1,
  );

  // ── 3. בלם אינפלציוני ────────────────────────────────────────────────
  // אינפלציה גלומה מעל יעד 2% מאלצת בנקים להדק = בלם על הנזילות.
  const dBreakeven = macro.yields.prev
    ? macro.yields.breakeven10y - macro.yields.prev.breakeven10y
    : 0;
  const inflationDrag = tanhSquash(
    -(Math.max(0, macro.yields.breakeven10y - 2.0) * 0.5 + dBreakeven * 2) / 1.0,
  );

  // ── 4. תנאים פיננסיים רחבים — "כל גורמי הנזילות" ─────────────────────
  // NFCI (מצרף 100+ מדדים), מרווחי אשראי, VIX, דולר, M2, רזרבות בנקים.
  // כל רכיב מנורמל כך ש"רופף/תומך" = חיובי. ממוצע רק על מה שסופק.
  const cond = macro.conditions;
  let conditionsImpulse = 0;
  if (cond) {
    const parts: number[] = [];
    if (cond.nfci != null) parts.push(tanhSquash(-cond.nfci / 0.5)); // NFCI<0 רופף → +
    if (cond.hyOAS != null) parts.push(tanhSquash((3.5 - cond.hyOAS) / 1.5)); // מרווח נמוך → +
    if (cond.vix != null) parts.push(tanhSquash((18 - cond.vix) / 8)); // VIX נמוך → +
    if (cond.dollarChange != null) parts.push(tanhSquash(-cond.dollarChange / 2)); // דולר חלש → +
    if (cond.m2Growth != null) parts.push(tanhSquash(cond.m2Growth / 4)); // M2 צומח → +
    if (cond.reservesDelta != null) parts.push(tanhSquash(cond.reservesDelta / 200)); // רזרבות עולות → +
    if (parts.length) conditionsImpulse = clamp(parts.reduce((a, b) => a + b, 0) / parts.length, -1, 1);
  }

  // ── 5. שקלול ל-pressure ∈ [-1, +1] ───────────────────────────────────
  const pressure = clamp(
    weightedSum([
      { value: cCb, weight: w.centralBank },
      { value: cTga, weight: w.treasury },
      { value: cRrp, weight: w.repo },
      { value: yieldImpulse, weight: w.yields },
      { value: inflationDrag, weight: w.inflation },
      { value: conditionsImpulse, weight: w.conditions },
    ]),
    -1,
    1,
  );

  // score (רמה) — ה-pressure המלא (כולל עוגני ה-levels בתשואות).
  const score = toScore100(pressure);

  // delta (מומנטום) — רק רכיבי ה-flow + מומנטום התשואות (השינויים הטהורים).
  const flowMomentum = clamp(
    weightedSum([
      { value: cCb, weight: w.centralBank },
      { value: cTga, weight: w.treasury },
      { value: cRrp, weight: w.repo },
      { value: yieldMomentum, weight: w.yields },
      { value: tanhSquash(-dBreakeven * 2), weight: w.inflation },
      { value: conditionsImpulse, weight: w.conditions },
    ]),
    -1,
    1,
  );
  const delta = round(100 * flowMomentum, 1);

  return {
    score: round(score, 1),
    delta,
    regime: classifyRegime(score),
    netLiquidityFlow: round(netLiquidityFlow, 1),
    components: {
      centralBankFlow: round(cCb, 3),
      treasuryDrain: round(cTga, 3),
      repoDrain: round(cRrp, 3),
      yieldImpulse: round(yieldImpulse, 3),
      inflationDrag: round(inflationDrag, 3),
      conditionsImpulse: round(conditionsImpulse, 3),
    },
    asOf: macro.asOf,
  };
}
