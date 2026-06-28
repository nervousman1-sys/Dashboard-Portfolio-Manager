// ============================================================================
// LHE · Numeric Primitives
// ----------------------------------------------------------------------------
// פונקציות עזר מתמטיות טהורות (pure) שכל השכבות חולקות. נרמול, החלקה, שקלול.
// אין כאן לוגיקה פיננסית — רק כלי חישוב יציבים מבחינה מספרית.
// ============================================================================

/** קיבוע ערך לטווח [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** אינטרפולציה לינארית. t∈[0,1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * החלקת tanh — ממפה כל מספר ממשי ל-(-1, +1) באופן רך.
 * נותן רוויה הדרגתית: קלטים קיצוניים לא "מפוצצים" את הציון.
 */
export function tanhSquash(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  return Math.tanh(x);
}

/**
 * סיגמואיד לוגיסטי → (0, 1). k שולט בתלילות.
 * משמש להמרת "עוצמת שדה" גולמית להסתברות/ציון.
 */
export function logistic(x: number, k = 1): number {
  return 1 / (1 + Math.exp(-k * x));
}

/** ממפה ערך מנורמל ב-[-1, +1] לציון 0..100 (50 = ניטרלי). */
export function toScore100(signed: number): number {
  return clamp(50 + 50 * clamp(signed, -1, 1), 0, 100);
}

/** שינוי באחוזים בטוח (מונע חלוקה באפס). */
export function pctChange(curr: number, prev: number): number {
  if (!prev) return 0;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

/** סכום משוקלל. נורמליזציה אוטומטית של המשקלים אם סכומם ≠ 1. */
export function weightedSum(
  pairs: Array<{ value: number; weight: number }>,
): number {
  const wSum = pairs.reduce((s, p) => s + p.weight, 0);
  if (wSum === 0) return 0;
  return pairs.reduce((s, p) => s + p.value * (p.weight / wSum), 0);
}

/** ממוצע פשוט. */
export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** עיגול ל-N ספרות אחרי הנקודה. */
export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * True Range של נר בודד מול הסגירה הקודמת.
 * max( high-low, |high-prevClose|, |low-prevClose| ).
 */
export function trueRange(
  high: number,
  low: number,
  prevClose: number,
): number {
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose),
  );
}
