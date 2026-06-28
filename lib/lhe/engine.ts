// ============================================================================
// LHE · Core Engine (Orchestrator)
// ----------------------------------------------------------------------------
// מחבר את שלוש השכבות לכדי תובנה אחת:
//   1. computeHPI            → מצב הנזילות הגלובלי (לחץ + מומנטום).
//   2. computeAssetConduit   → רגישות הנכס (לאן הנוזל זורם).
//   3. detect* + computeGravity → לאן בדיוק בגרף הוא נשאב.
//   → ConfluenceAssessment   → ההטיה, היעד העיקרי, ועוצמת השכנוע.
//
// פונקציה טהורה אחת: runLHE(input) → LHEResult. דטרמיניסטית, ללא side-effects,
// ללא קריאות רשת — כל הנתונים מגיעים מבחוץ (modular, testable, portable).
// ============================================================================

import type {
  LHEInput,
  LHEResult,
  ConfluenceAssessment,
  GravityTarget,
  HPIResult,
  AssetConduitResult,
  StructureShift,
  Direction,
} from './types';
import { resolveConfig } from './config';
import { clamp, round, weightedSum } from './math';
import { computeHPI } from './layer1-macro';
import { computeAssetConduit, rankConduits } from './layer2-conduits';
import {
  computeATR,
  computeGravity,
  detectFVGs,
  detectOrderBlocks,
  detectStructureShift,
} from './layer3-microstructure';

/**
 * בונה את הערכת ההתלכדות — היכן שלוש השכבות "מסכימות".
 *
 * ההטיה (bias) נקבעת ע"י הצבעה משוקללת:
 *   • כיוון הנזילות (HPI)  • משיכת ההון לנכס (Attraction)  • היפוך המבנה (MSS/BOS).
 * היעד העיקרי הוא ה-FVG בעל הכבידה הגבוהה ביותר התואם להטיה.
 */
function assessConfluence(
  hpi: HPIResult,
  conduit: AssetConduitResult,
  structure: StructureShift,
  gravityTargets: GravityTarget[],
): ConfluenceAssessment {
  const flags: string[] = [];

  // ── 1. הצבעות כיוון, כל אחת ב-[-1, +1] (חיובי = bullish) ─────────────
  const liquidityVote = clamp((hpi.score - 50) / 50 + hpi.delta / 200, -1, 1);
  const attractionVote = clamp((conduit.attractionScore - 50) / 50, -1, 1);
  const structureVote = structure.detected
    ? structure.direction === 'bullish'
      ? structure.type === 'MSS'
        ? 1
        : 0.6
      : structure.type === 'MSS'
        ? -1
        : -0.6
    : 0;

  const directional = weightedSum([
    { value: liquidityVote, weight: 0.4 },
    { value: attractionVote, weight: 0.3 },
    { value: structureVote, weight: 0.3 },
  ]);

  const bias: Direction | 'neutral' =
    directional > 0.15 ? 'bullish' : directional < -0.15 ? 'bearish' : 'neutral';

  // ── 2. היעד העיקרי: ה-FVG הפתוח החזק ביותר בכיוון ההטיה ─────────────
  const openTargets = gravityTargets.filter((t) => !t.fvg.filled);
  const aligned = openTargets.filter((t) =>
    bias === 'neutral' ? true : t.direction === bias,
  );
  const pool = aligned.length ? aligned : openTargets;
  const primaryTarget = pool.length
    ? pool.reduce((best, t) => (t.gravityScore > best.gravityScore ? t : best))
    : undefined;

  // ── 3. ציון השכנוע: יישור-כיוון × עוצמת היעד × אישור מבני ───────────
  const alignment = Math.abs(directional); // 0..1
  const targetStrength = primaryTarget ? primaryTarget.gravityScore / 100 : 0;
  let score = clamp(
    100 *
      weightedSum([
        { value: alignment, weight: 0.45 },
        { value: targetStrength, weight: 0.35 },
        { value: structure.detected ? 1 : 0, weight: 0.2 },
      ]),
    0,
    100,
  );

  // ── 4. דגלים בולטים (להזנת מחולל ההתרעות) ───────────────────────────
  if (structure.detected && structure.type === 'MSS') {
    flags.push(`MSS_${structure.direction?.toUpperCase()}`);
    score = clamp(score + 6, 0, 100); // היפוך מבנה מחזק שכנוע
  }
  if (hpi.regime === 'flood' || hpi.regime === 'drought') flags.push(`MACRO_${hpi.regime.toUpperCase()}`);
  if (conduit.attractionScore >= 70) flags.push('HIGH_CONDUIT_ATTRACTION');
  if (conduit.liquidityBeta >= 2.5) flags.push('HIGH_LIQUIDITY_BETA');
  if (
    primaryTarget &&
    primaryTarget.gravityScore >= 65 &&
    (hpi.regime === 'flood' || hpi.regime === 'expansion') &&
    primaryTarget.direction === 'bullish'
  ) {
    flags.push('MACRO_FVG_CONFLUENCE');
    score = clamp(score + 5, 0, 100);
  }

  // ── 5. נרטיב-מכונה תמציתי ────────────────────────────────────────────
  const dirHe = bias === 'bullish' ? 'עולה' : bias === 'bearish' ? 'יורד' : 'ניטרלי';
  const narrative = primaryTarget
    ? `הטיה ${dirHe} (${Math.round(score)}/100): נזילות ${hpi.regime} מול ${conduit.ticker} ` +
      `(β≈${conduit.liquidityBeta}, משיכה ${conduit.attractionScore}). יעד שאיבה ` +
      `${round(primaryTarget.fvg.bottom, 2)}–${round(primaryTarget.fvg.top, 2)} ` +
      `(כבידה ${primaryTarget.gravityScore}, מילוי ${(primaryTarget.fillProbability * 100).toFixed(0)}%).`
    : `הטיה ${dirHe} (${Math.round(score)}/100): נזילות ${hpi.regime}, ללא FVG פתוח מובהק.`;

  return { score: round(score, 1), bias, primaryTarget, narrative, flags };
}

/**
 * נקודת הכניסה היחידה למנוע.
 * @param input מאקרו + מבנה נכס + נרות (+ ספר/עמיתים אופציונליים).
 * @returns תמונת LHE מלאה: HPI, תעלת הולכה, מיקרו-מבנה, יעדי כבידה, התלכדות.
 */
export function runLHE(input: LHEInput): LHEResult {
  const cfg = resolveConfig(input.config);
  const candles = input.candles;
  if (!candles?.length) {
    throw new Error('LHE: candles are required to evaluate microstructure');
  }
  const currentPrice = candles[candles.length - 1].close;
  const atr = computeATR(candles);

  // שכבה 1 — מאקרו.
  const hpi = computeHPI(input.macro, cfg);

  // שכבה 2 — תעלת ההולכה של הנכס + דירוג עמיתים (אם סופק סל).
  const conduit = computeAssetConduit(input.asset, hpi, cfg);
  const peerRanking = input.peers?.length
    ? rankConduits([input.asset, ...input.peers], hpi, cfg)
    : undefined;

  // שכבה 3 — מבנה מיקרו.
  const fvgs = detectFVGs(candles, cfg);
  const orderBlocks = detectOrderBlocks(candles, atr, cfg);
  const structureShift = detectStructureShift(candles, cfg);

  // שילוב: כבידה לכל FVG פתוח, ממוין מהחזק לחלש.
  const gravityTargets = fvgs
    .filter((f) => !f.filled)
    .map((f) => computeGravity(f, currentPrice, hpi, conduit, atr, cfg, input.orderBook))
    .sort((a, b) => b.gravityScore - a.gravityScore);

  const confluence = assessConfluence(hpi, conduit, structureShift, gravityTargets);

  return {
    hpi,
    conduit,
    peerRanking,
    microstructure: {
      fvgs,
      orderBlocks,
      structureShift,
      currentPrice: round(currentPrice, 4),
      atr: round(atr, 4),
    },
    gravityTargets,
    confluence,
    asOf: input.macro.asOf,
  };
}
