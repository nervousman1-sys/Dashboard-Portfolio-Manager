// ============================================================================
// LHE · Layer 2 — Asset Conduits (תעלות ההולכה)
// ----------------------------------------------------------------------------
// "אם נפתח הברז (HPI עולה) — לאן הנוזל יזרום קודם, ובאיזו עוצמה?"
//
// כל נכס הוא "תעלה" ברוחב שונה. הרוחב = Liquidity Beta אפקטיבי, מורכב מ:
//   1. Beta בסיסי (נמדד אמפירית, או ברירת-מחדל לפי סוג נכס).
//   2. מגבר מינוף מאזני — מבני הון רפלקסיביים (Strategy Inc / MSTR):
//      פרמיית mNAV מאפשרת הנפקת הון ATM לרכישת עוד נכס-בסיס → לולאה רפלקסיבית.
//   3. מגבר רפלקסיביות — מומנטום מושך הון תחת התרחבות נזילות.
//   4. מגבר הידוק היצע — On-Chain: float מהודק = השפעת מחיר גדולה יותר לכל $.
//
// Attraction Score מגדיר לאן ההון נשאב קודם: גבוה כשהנזילות מתרחבת והנכס
// בעל Beta גבוה והיצע מהודק; מתהפך בניקוז (Beta גבוה הופך מהתחייבות לסיכון).
// ============================================================================

import type {
  AssetConduitResult,
  AssetStructure,
  HPIResult,
  LHEConfig,
} from './types';
import { clamp, tanhSquash, toScore100, round } from './math';

/** Beta בסיסי לנזילות לפי סוג נכס (כשאין מדידה אמפירית). */
function defaultBetaForClass(cls: AssetStructure['assetClass']): number {
  switch (cls) {
    case 'crypto':
      return 1.6; // רגישות גבוהה לנזילות גלובלית
    case 'levered_equity':
      return 1.2; // לפני הגברת המינוף המאזני
    case 'equity':
      return 0.9;
    case 'etf':
      return 0.7;
    case 'commodity':
      return 0.5;
    default:
      return 1.0;
  }
}

/**
 * מגבר המינוף המאזני — לב הרפלקסיביות של נכסי levered_equity.
 *
 * • navReflex: פרמיית mNAV מעל 1 = החברה יכולה להנפיק הון מעל השווי הנכסי
 *   ולרכוש עוד נכס-בסיס → כל דולר נזילות מוגבר. discount (<1) מדכא.
 * • debtAmp: מינוף חוב מגביר תנודתיות הון.
 * • convAmp: אג"ח להמרה = אופציונליות מובנית שמאיצה בכיוון העולה.
 * • baseAssetBeta: ה-Beta של נכס-הבסיס שהחברה מחזיקה (BTC עבור MSTR).
 */
function leverageAmplifier(asset: AssetStructure): number {
  const L = asset.leverage;
  if (!L) return 1;
  const navReflex = 1 + Math.max(0, L.navPremium - 1) * 0.8 - Math.max(0, 1 - L.navPremium) * 0.4;
  const debtAmp = 1 + clamp(L.debtToEquity, 0, 3) * 0.15;
  const convAmp = 1 + clamp(L.convertiblePctOfCap, 0, 1) * 0.5;
  const baseAmp = Math.max(1, L.baseAssetBeta);
  return clamp(navReflex, 0.5, 3) * debtAmp * convAmp * baseAmp;
}

/** מגבר רפלקסיביות מהמומנטום — הון רודף מנצחים תחת נזילות מתרחבת. */
function reflexivityAmplifier(asset: AssetStructure): number {
  const m = asset.momentum20d ?? 0;
  return 1 + clamp(m / 100, -0.3, 0.5);
}

/** מגבר הידוק היצע מנתוני On-Chain (קריפטו). */
function supplyTightnessAmplifier(asset: AssetStructure, cfg: LHEConfig): number {
  const oc = asset.onChain;
  if (!oc) return 1;
  // ככל שיותר היצע לא-נזיל, לווייתנים צוברים, ורזרבות הבורסה נמוכות — ה-float מהודק.
  const structural =
    clamp(oc.illiquidSupplyPct, 0, 1) * 0.6 +
    clamp(oc.whaleAccumulationScore, -1, 1) * 0.3 +
    clamp(1 - oc.exchangeReserveRatio, 0, 1) * 0.4;
  // זרימת מטבעות אל מחוץ לבורסות = הידוק נוסף.
  const netflow = tanhSquash(oc.exchangeNetflow / cfg.onChainNetflowScale) * 0.4;
  return clamp(1 + structural + netflow, 0.6, 2.4);
}

/**
 * מחשב את תעלת ההולכה של נכס בודד מול מצב ה-HPI.
 */
export function computeAssetConduit(
  asset: AssetStructure,
  hpi: HPIResult,
  cfg: LHEConfig,
): AssetConduitResult {
  const baseBeta = asset.measuredLiquidityBeta ?? defaultBetaForClass(asset.assetClass);
  const levAmp = leverageAmplifier(asset);
  const reflexAmp = reflexivityAmplifier(asset);
  const supplyAmp = supplyTightnessAmplifier(asset, cfg);

  const liquidityBeta = baseBeta * levAmp * reflexAmp * supplyAmp;

  // כיוון המשיכה נקבע ע"י מצב הנזילות: רמה (HPI score) + מומנטום (HPI delta).
  const hpiTilt = (hpi.score - 50) / 50; // -1..+1
  const liquidityMomentum = hpi.delta / 100; // -1..+1
  const directionalPull = 0.6 * hpiTilt + 0.4 * liquidityMomentum; // -1..+1

  // עוצמת המשיכה גדלה עם ה-Beta (log כדי למנוע שליטה של ערכים קיצוניים),
  // והסימן נקבע ע"י כיוון הנזילות. בניקוז — Beta גבוה הופך לחיסרון.
  const raw = directionalPull * Math.log2(1 + Math.max(0, liquidityBeta));
  const attractionScore = toScore100(tanhSquash(raw));

  return {
    ticker: asset.ticker,
    liquidityBeta: round(liquidityBeta, 3),
    attractionScore: round(attractionScore, 1),
    drivers: {
      baseBeta: round(baseBeta, 3),
      leverageAmplifier: round(levAmp, 3),
      reflexivityAmplifier: round(reflexAmp, 3),
      supplyTightnessAmplifier: round(supplyAmp, 3),
    },
  };
}

/**
 * מדרג סל נכסים — מי שואב הון קודם תחת מצב הנזילות הנוכחי.
 * מחזיר רשימה ממוינת (גבוה→נמוך) עם rank משובץ.
 */
export function rankConduits(
  assets: AssetStructure[],
  hpi: HPIResult,
  cfg: LHEConfig,
): AssetConduitResult[] {
  return assets
    .map((a) => computeAssetConduit(a, hpi, cfg))
    .sort((a, b) => b.attractionScore - a.attractionScore)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
