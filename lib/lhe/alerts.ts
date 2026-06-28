// ============================================================================
// LHE · Proactive Alert Generator (מחולל התרעות)
// ----------------------------------------------------------------------------
// ממיר את פלט המנוע (LHEResult) להתרעה פיננסית מנומקת בשפה מקצועית, המתאימה
// ליועצי השקעות ומנהלי תיקים ולתצוגת ה-UI של Finextium (עברית, RTL).
//
// ההתרעה דטרמיניסטית ומבוססת-תבנית (אין כאן LLM): היא "מתרגמת" את ההתלכדות
// המספרית למשפטים — זיהוי התלכדות לחץ-מאקרו עם FVG ספציפי בגרף, ההסתברות,
// והזמן המוערך. שכבת ה-Gemini הקיימת יכולה לבוא אחר-כך ולשפר ניסוח בלבד.
// ============================================================================

import type {
  AlertSeverity,
  LHEAlert,
  LHEResult,
  LiquidityRegime,
} from './types';

/** תיאור מילולי של משטר הנזילות. */
const REGIME_HE: Record<LiquidityRegime, string> = {
  flood: 'הצפת נזילות',
  expansion: 'התרחבות נזילות',
  neutral: 'נזילות מאוזנת',
  drain: 'ניקוז נזילות',
  drought: 'בצורת נזילות',
};

/** עוצמת ההתרעה לפי ציון ההתלכדות. */
function severityFromScore(score: number): AlertSeverity {
  if (score >= 80) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 50) return 'elevated';
  return 'info';
}

/** מנסח את כיוון ההטיה. */
function biasPhrase(bias: LHEResult['confluence']['bias']): string {
  if (bias === 'bullish') return 'תרחיש עולה';
  if (bias === 'bearish') return 'תרחיש יורד';
  return 'איזון/ללא הכרעה';
}

/**
 * מייצר את אובייקט ההתרעה.
 * @param result פלט runLHE.
 * @returns LHEAlert מוכן לתצוגה.
 */
export function generateLHEAlert(result: LHEResult): LHEAlert {
  const { hpi, conduit, confluence, microstructure } = result;
  const score = confluence.score;
  const severity = severityFromScore(score);
  const target = confluence.primaryTarget;
  const ticker = conduit.ticker;
  const regimeHe = REGIME_HE[hpi.regime];

  // ── כותרת קצרה (chip) ────────────────────────────────────────────────
  const title =
    confluence.flags.includes('MACRO_FVG_CONFLUENCE')
      ? `התלכדות מאקרו–מיקרו · ${ticker}`
      : `${regimeHe} · ${ticker}`;

  // ── שורת פתיח חדה ────────────────────────────────────────────────────
  const dirArrow = confluence.bias === 'bullish' ? '▲' : confluence.bias === 'bearish' ? '▼' : '◆';
  const headline =
    `${dirArrow} ${biasPhrase(confluence.bias)} · שכנוע ${Math.round(score)}/100 · ` +
    `HPI ${Math.round(hpi.score)} (${hpi.delta >= 0 ? '+' : ''}${hpi.delta} מומנטום)`;

  // ── גוף ההתרעה — נימוק תלת-שכבתי ────────────────────────────────────
  const lines: string[] = [];

  // שכבה 1 — מאקרו.
  const flowSign = hpi.netLiquidityFlow >= 0 ? 'הזרמה' : 'משיכה';
  lines.push(
    `מאקרו: ${regimeHe} (HPI ${Math.round(hpi.score)}/100). ` +
      `זרימת נזילות-נטו של ${flowSign} ~$${Math.abs(hpi.netLiquidityFlow).toFixed(0)} מיליארד ` +
      `(בנקים מרכזיים מול ניקוז TGA/RRP), על רקע ${describeYields(hpi.components.yieldImpulse)}.`,
  );

  // שכבה 2 — תעלת ההולכה.
  lines.push(
    `גישור: ${ticker} מתפקד כתעלת הולכה ${conduit.attractionScore >= 60 ? 'רחבה' : conduit.attractionScore <= 40 ? 'צרה' : 'בינונית'} ` +
      `(Liquidity-β אפקטיבי ≈ ${conduit.liquidityBeta}, ציון משיכת הון ${conduit.attractionScore}/100)` +
      describeLeverage(conduit) +
      `. מכאן שלכל יחידת לחץ מאקרו, הנכס מגיב ב×${conduit.liquidityBeta.toFixed(1)} עוצמה.`,
  );

  // שכבה 3 — מיקרו / כבידה.
  if (target) {
    const [zLo, zHi] = [target.fvg.bottom, target.fvg.top];
    const pull = target.direction === 'bullish' ? 'מעל ה' : 'מתחת ל';
    lines.push(
      `מיקרו: זוהה FVG פתוח ${pull}מחיר הנוכחי (${microstructure.currentPrice}) באזור ` +
        `${zLo}–${zHi}. ציון מגנטיות ${target.gravityScore}/100 — ` +
        `המאקרו "מטעין" את הפער: הסתברות שאיבה/מילוי ${(target.fillProbability * 100).toFixed(0)}%, ` +
        `זמן מוערך ~${target.expectedBarsToFill} ברים (מרחק ${target.distancePct}%).`,
    );
  } else {
    lines.push(
      `מיקרו: אין FVG פתוח מובהק בכיוון ההטיה כרגע — ` +
        `הלחץ המאקרו קיים אך חסר "עוגן" מבני קונקרטי לשאיבה. יש להמתין לפתיחת אי-יעילות חדשה.`,
    );
  }

  // אישור מבני.
  if (microstructure.structureShift.detected) {
    const ss = microstructure.structureShift;
    lines.push(
      `מבנה: ${ss.type === 'MSS' ? 'היפוך מבנה שוק (MSS)' : 'פריצת מבנה (BOS)'} ` +
        `${ss.direction === 'bullish' ? 'כלפי מעלה' : 'כלפי מטה'} מעבר לרמה ${ss.brokenLevel} — ` +
        `${ss.type === 'MSS' ? 'מחזק את ההטיה כנגד המגמה הקודמת.' : 'תומך בהמשך המגמה.'}`,
    );
  }

  // שורת סיכום פעולה.
  lines.push(actionLine(result));

  const body = lines.join('\n');

  // ── תגיות ────────────────────────────────────────────────────────────
  const tags = [
    'LHE',
    `regime:${hpi.regime}`,
    `bias:${confluence.bias}`,
    ...confluence.flags,
  ];

  return {
    id: `lhe_${ticker}_${result.asOf}`,
    severity,
    title,
    headline,
    body,
    bias: confluence.bias,
    confidence: Math.round(score),
    tags,
    target: target
      ? {
          ticker,
          zone: [target.fvg.bottom, target.fvg.top],
          fillProbability: target.fillProbability,
          expectedBarsToFill: target.expectedBarsToFill,
        }
      : undefined,
    asOf: result.asOf,
  };
}

// ── עזרי ניסוח ─────────────────────────────────────────────────────────

function describeYields(yieldImpulse: number): string {
  if (yieldImpulse > 0.2) return 'תשואות מתרככות (רוח גבית)';
  if (yieldImpulse < -0.2) return 'תשואות נוקשות (רוח נגדית)';
  return 'תשואות יציבות';
}

function describeLeverage(conduit: LHEResult['conduit']): string {
  const d = conduit.drivers;
  if (d.leverageAmplifier > 1.4) {
    return `, מוגבר ע"י מבנה הון רפלקסיבי (×${d.leverageAmplifier.toFixed(2)} מינוף/mNAV)`;
  }
  if (d.supplyTightnessAmplifier > 1.3) {
    return `, מוגבר ע"י הידוק היצע On-Chain (×${d.supplyTightnessAmplifier.toFixed(2)})`;
  }
  return '';
}

/** שורת מסקנה אופרטיבית (ללא המלצת קנייה/מכירה — מסגור סיכון). */
function actionLine(result: LHEResult): string {
  const { confluence, hpi, conduit } = result;
  const t = confluence.primaryTarget;
  if (confluence.bias === 'neutral' || confluence.score < 50) {
    return `מסקנה: התלכדות חלשה — לנטר, ללא טריגר ברור. עדכון יתקבל עם שינוי במשטר הנזילות.`;
  }
  if (confluence.bias === 'bullish' && t) {
    return (
      `מסקנה: התלכדות ${confluence.score >= 65 ? 'חזקה' : 'מתפתחת'} — לחץ נזילות מתרחב ` +
      `+ תעלת ${conduit.ticker} פתוחה + יעד שאיבה עליון. לנטר תגובה באזור ` +
      `${t.fvg.bottom}–${t.fvg.top} כאישור; היפוך משטר ה-HPI מתחת ל-50 מבטל את התזה.`
    );
  }
  if (confluence.bias === 'bearish') {
    return (
      `מסקנה: סיכון מוגבר — ${hpi.regime === 'drain' || hpi.regime === 'drought' ? 'ניקוז נזילות' : 'מבנה שלילי'} ` +
      `מול נכס בעל Beta גבוה (${conduit.liquidityBeta}). חשיפה ממונפת רגישה במיוחד לתנועה זו.`
    );
  }
  return `מסקנה: לעקוב אחר התפתחות ההתלכדות.`;
}
