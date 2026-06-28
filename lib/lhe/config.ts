// ============================================================================
// LHE · Default Configuration
// ----------------------------------------------------------------------------
// כל קבועי הכיוונון במקום אחד. ניתן לדרוס נקודתית דרך LHEInput.config.
// הערכים נבחרו כך ש-tanh/logistic יגיעו לרוויה בסביבות "אירוע מאקרו מובהק".
// ============================================================================

import type { LHEConfig } from './types';

export const DEFAULT_LHE_CONFIG: LHEConfig = {
  // משקלי ה-HPI: זרימת הנזילות-נטו (בנקים+אוצר+ריפו) דומיננטית; התשואות והאינפלציה
  // הן ה"חיכוך" שמתנגד לה.
  hpiWeights: {
    centralBank: 0.34, // מאזני Fed/ECB/BoI — מקור הנזילות הראשי
    treasury: 0.20, // ניקוז/מילוי ה-TGA
    repo: 0.16, // ניקוז/מילוי ה-RRP
    yields: 0.18, // דחף התשואות (תנאים פיננסיים)
    inflation: 0.12, // בלם אינפלציוני (לחץ על הבנקים להדק)
  },

  // ~250 מיליארד USD זרימת-נטו ≈ יחידת לחץ מלאה (tanh≈0.76). מכויל לסקאלת
  // התנודות החודשיות של ה-Net Liquidity האמריקאי.
  netLiquidityScaleBn: 250,

  // ~50K מטבעות exchange-netflow ≈ יחידת הידוק היצע מלאה (סקאלת BTC).
  onChainNetflowScale: 50000,

  fvgLookback: 120, // נרות אחורה לסריקת פערים
  swingLookback: 10, // חצי-חלון לזיהוי swing high/low (פרקטל)
  minFvgSizePct: 0.05, // מסנן פערים < 0.05% (רעש)
  displacementAtrMult: 1.5, // תנועה > 1.5×ATR נחשבת אימפולסיבית (Order Block / MSS)
};

/** ממזג קונפיג חלקי עם ברירות המחדל (shallow + מיזוג עמוק למשקלים). */
export function resolveConfig(partial?: Partial<LHEConfig>): LHEConfig {
  if (!partial) return DEFAULT_LHE_CONFIG;
  return {
    ...DEFAULT_LHE_CONFIG,
    ...partial,
    hpiWeights: { ...DEFAULT_LHE_CONFIG.hpiWeights, ...(partial.hpiWeights || {}) },
  };
}
