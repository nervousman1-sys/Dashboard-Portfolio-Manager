// ============================================================================
// Finextium · Liquidity Hydrodynamic Engine (LHE) — Type System
// ----------------------------------------------------------------------------
// "הסימולטור ההידרודינמי של השוק". מודל תלת-שכבתי שמתאר את השוק כמערכת
// הידראולית: נזילות מאקרו (לחץ) → תעלות הולכה לנכסים (רגישות) → שאיבה לתוך
// אזורי חוסר-יעילות בגרף (כבידה במיקרו).
//
// קובץ זה מגדיר את כל חוזי-הנתונים (Interfaces) בצורה קשיחה. אין כאן לוגיקה —
// רק הטיפוסים שכל שאר השכבות נשענות עליהם.
//
// מודולרי לחלוטין: אפס תלויות חיצוניות, pure-types. ניתן לייבא ל-Next.js,
// ל-Worker, או להידר ל-JS עבור האפליקציה ה-vanilla הקיימת — בלי לדרוס דבר.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────
// SHARED PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────

/** כיוון מבני: ביקוש (עולה) מול היצע (יורד). */
export type Direction = 'bullish' | 'bearish';

/** מצב הנזילות הגלובלי הנגזר מציון ה-HPI. */
export type LiquidityRegime =
  | 'flood'      // הצפה — עודף נזילות אגרסיבי (>80)
  | 'expansion'  // התרחבות — נזילות נכנסת (60-80)
  | 'neutral'    // ניטרלי (40-60)
  | 'drain'      // ניקוז — נזילות יוצאת (20-40)
  | 'drought';   // בצורת — משיכת נזילות חדה (<20)

/** סוג הנכס — קובע את ה-Beta הבסיסי וצורת ההגברה בשכבת הגישור. */
export type AssetClass =
  | 'equity'          // מניה רגילה
  | 'levered_equity'  // מבנה הון ממונף / מאזן אגרסיבי (כדוגמת Strategy Inc / MSTR)
  | 'crypto'          // קריפטו (BTC ועוד)
  | 'etf'
  | 'commodity';

// ─────────────────────────────────────────────────────────────────────────
// LAYER 1 — MACRO INPUTS  (מדד הלחץ ההידראולי)
// ─────────────────────────────────────────────────────────────────────────

/** מאזן בנק מרכזי. delta חיובי = הרחבה כמותית = הזרמת נזילות. */
export interface CentralBankBalance {
  /** סך נכסי המאזן (במטבע המקומי, מיליארדים). */
  totalAssets: number;
  /** שינוי המאזן בחלון התצפית (אותן יחידות). חיובי = QE, שלילי = QT. */
  delta: number;
}

/** מאגר נזילות ממשלתי (TGA / RRP). ירידה ברמה = שחרור נזילות לשוק. */
export interface LiquidityReservoir {
  /** רמה נוכחית (מיליארדי USD). */
  level: number;
  /** שינוי בחלון התצפית. ירידה (delta שלילי) = הזרמה לשוק. */
  delta: number;
}

/** מתחם התשואות — מרווחים, אינפלציה גלומה וריבית ריאלית. */
export interface YieldComplex {
  /** תשואת אג"ח ממשלתי אמריקאי לשנתיים (%). */
  ust2y: number;
  /** תשואת אג"ח ממשלתי אמריקאי ל-10 שנים (%). */
  ust10y: number;
  /** אינפלציה גלומה (breakeven) ל-10 שנים (%). */
  breakeven10y: number;
  /** ריבית ריאלית ל-10 שנים (TIPS, %). אופציונלי — תיגזר כ-ust10y − breakeven אם חסר. */
  real10y?: number;
  /** תצפית קודמת לחישוב deltas (מומנטום). אופציונלי. */
  prev?: { ust2y: number; ust10y: number; breakeven10y: number };
}

/** קלט המאקרו המלא — תמונת מצב נזילות גלובלית בנקודת זמן. */
export interface MacroLiquidityInput {
  fed: CentralBankBalance;
  ecb: CentralBankBalance;
  /** בנק ישראל. */
  boi: CentralBankBalance;
  /** חשבון האוצר האמריקאי (Treasury General Account). */
  tga: LiquidityReservoir;
  /** ריפו הפוך (Reverse Repo facility). */
  rrp: LiquidityReservoir;
  yields: YieldComplex;
  /** שערי חליפין לנרמול ECB/BoI ל-USD. ברירות מחדל סבירות אם חסר. */
  fx?: { eurusd?: number; usdils?: number };
  /** חותמת זמן של צילום המאקרו (ISO). */
  asOf: string;
}

/** פירוק שקוף של תרומות ה-HPI — לתצוגת UI ול-debug. כל ערך מנורמל ל-[-1, +1]. */
export interface HPIComponents {
  /** תרומת מאזני הבנקים המרכזיים (משולב). */
  centralBankFlow: number;
  /** תרומת ניקוז ה-TGA (ירידה = חיובי). */
  treasuryDrain: number;
  /** תרומת ניקוז ה-RRP (ירידה = חיובי). */
  repoDrain: number;
  /** דחף התשואות (תשואות יורדות = חיובי). */
  yieldImpulse: number;
  /** בלם אינפלציוני (אינפלציה גבוהה/עולה = שלילי). */
  inflationDrag: number;
}

/** פלט שכבה 1 — מדד הלחץ ההידראולי. */
export interface HPIResult {
  /** ציון 0..100 — עוצמת לחץ הנזילות הנוכחית (50 = ניטרלי). */
  score: number;
  /** קצב שינוי (מומנטום) -100..+100 — לאן הלחץ נע. */
  delta: number;
  regime: LiquidityRegime;
  /** זרימת הנזילות הנטו הגולמית (מיליארדי USD, חתום) = ΔCB − ΔTGA − ΔRRP. */
  netLiquidityFlow: number;
  components: HPIComponents;
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────
// LAYER 2 — ASSET CONDUITS INPUTS  (תעלות ההולכה)
// ─────────────────────────────────────────────────────────────────────────

/** פרופיל מינוף מאזני — עבור נכסי levered_equity (כמו Strategy Inc). */
export interface LeverageProfile {
  /** חוב כולל / הון עצמי. */
  debtToEquity: number;
  /** אג"ח להמרה במחזור כאחוז משווי השוק (0..1). */
  convertiblePctOfCap: number;
  /** פרמיית שווי שוק על ה-NAV של נכס הבסיס שהחברה מחזיקה (mNAV). 1.0 = פארי, >1 = פרמיה. */
  navPremium: number;
  /** ה-Beta של נכס הבסיס שהחברה מחזיקה במאזן (למשל BTC עבור MSTR). */
  baseAssetBeta: number;
}

/** צילום נתוני On-Chain — עבור נכסי קריפטו. */
export interface OnChainSnapshot {
  /** זרימת מטבעות נטו אל מחוץ לבורסות (מטבעות). חיובי = צבירה לאחסון קר = הידוק היצע. */
  exchangeNetflow: number;
  /** אחוז ההיצע המוחזק ע"י מחזיקים ארוכי-טווח / לא-נזיל (0..1). */
  illiquidSupplyPct: number;
  /** ציון צבירת לווייתנים (תנועות >$10m), חתום -1..+1 (צבירה = חיובי). */
  whaleAccumulationScore: number;
  /** יחס רזרבות בבורסות מול ארנקים קרים. נמוך = float מהודק. */
  exchangeReserveRatio: number;
}

/** מבנה הנכס — הקלט לשכבת הגישור עבור נכס בודד. */
export interface AssetStructure {
  ticker: string;
  name: string;
  assetClass: AssetClass;
  /**
   * Beta נמדד אמפירית (שיפוע רגרסיה של תשואות הנכס על שינוי הנזילות-נטו).
   * אם ידוע — מנצח. אם לא, מחושב proxy מבני מהשדות שלהלן.
   */
  measuredLiquidityBeta?: number;
  /** מגברי מינוף מאזני (ל-levered_equity). */
  leverage?: LeverageProfile;
  /** אותות On-Chain (לקריפטו). */
  onChain?: OnChainSnapshot;
  /** מומנטום מחיר אחרון, % (למשל 20 ימים) — קלט רפלקסיביות. */
  momentum20d?: number;
  /** תנודתיות ריאליזציה שנתית, %. */
  realizedVol?: number;
}

/** פירוק שקוף של מגברי הרגישות. */
export interface ConduitDrivers {
  /** ה-Beta הבסיסי לפני הגברה. */
  baseBeta: number;
  /** מגבר המינוף המאזני (×). */
  leverageAmplifier: number;
  /** מגבר הרפלקסיביות מהמומנטום (×). */
  reflexivityAmplifier: number;
  /** מגבר הידוק ההיצע (On-Chain, ×). */
  supplyTightnessAmplifier: number;
}

/** פלט שכבה 2 — רגישות הנכס ותעדוף משיכת ההון. */
export interface AssetConduitResult {
  ticker: string;
  /** ה-Beta האפקטיבי לנזילות לאחר כל ההגברות. */
  liquidityBeta: number;
  /** 0..100 — לאן ההון יזרום קודם (גבוה = "תעלה רחבה" בכיוון הנזילות). */
  attractionScore: number;
  /** דירוג בתוך סל (מוקצה ע"י rankConduits). */
  rank?: number;
  drivers: ConduitDrivers;
}

// ─────────────────────────────────────────────────────────────────────────
// LAYER 3 — MICROSTRUCTURE INPUTS  (כבידת זרימת הפקודות)
// ─────────────────────────────────────────────────────────────────────────

/** נר בודד (OHLCV). time יכול להיות epoch-ms או אינדקס-בר. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Fair Value Gap — חור נזילות / אזור חוסר-יעילות שהשוק נוטה למלא. */
export interface FairValueGap {
  id: string;
  /** bullish = פער ביקוש מתחת (נוטה להישאב כלפי מעלה); bearish = ההפך. */
  direction: Direction;
  /** הגבול העליון של אי-האיזון. */
  top: number;
  /** הגבול התחתון. */
  bottom: number;
  /** אמצע הפער (Consequent Encroachment — 50%). */
  midpoint: number;
  /** זמן יצירת הפער (time של הנר האמצעי). */
  createdAt: number;
  /** גודל הפער כאחוז מהמחיר. */
  sizePct: number;
  /** האם מולא במלואו. */
  filled: boolean;
  /** 0..1 — כמה מהפער כבר מותך (mitigated). */
  fillRatio: number;
}

/** Order Block — נר ההיצע/ביקוש האחרון לפני תנועה אימפולסיבית. */
export interface OrderBlock {
  id: string;
  direction: Direction;
  top: number;
  bottom: number;
  createdAt: number;
  /** עוצמת התזוזה (displacement) שמקורה בבלוק — כמדד לחוזק. */
  displacement: number;
}

/** היפוך/פריצת מבנה שוק. */
export interface StructureShift {
  detected: boolean;
  /** MSS = היפוך מגמה; BOS = המשך מגמה. */
  type?: 'MSS' | 'BOS';
  direction?: Direction;
  /** הרמה (swing) שנפרצה. */
  brokenLevel?: number;
  at?: number;
}

/** ספר פקודות — אופציונלי, מחדד את הערכת ה-Time-to-Fill. */
export interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

/** פלט שכבה 3 (לכל FVG) — ציון מגנטיות והסתברות שאיבה. */
export interface GravityTarget {
  fvg: FairValueGap;
  /** 0..100 — עוצמת המגנטיות (כבידה) של הפער. */
  gravityScore: number;
  /** 0..1 — הסתברות מילוי בחלון הצפוי. */
  fillProbability: number;
  /** הזמן המוערך למילוי, ביחידות ברים. */
  expectedBarsToFill: number;
  /** מרחק הפער מהמחיר הנוכחי (%). */
  distancePct: number;
  /** כיוון השאיבה הצפוי (מעל המחיר = bullish pull). */
  direction: Direction;
}

// ─────────────────────────────────────────────────────────────────────────
// ENGINE — COMBINED I/O
// ─────────────────────────────────────────────────────────────────────────

/** משקלים וכיוונונים — ניתנים לדריסה דרך LHEInput.config. */
export interface LHEConfig {
  /** משקלי רכיבי ה-HPI (סכומם ~1). */
  hpiWeights: {
    centralBank: number;
    treasury: number;
    repo: number;
    yields: number;
    inflation: number;
  };
  /** כמה מיליארדי USD של זרימת-נטו שווים "יחידת לחץ" מלאה (לנרמול tanh). */
  netLiquidityScaleBn: number;
  /** כמה מטבעות exchange-netflow שווים יחידת הידוק היצע מלאה. */
  onChainNetflowScale: number;
  /** חלון אחורה לסריקת FVG. */
  fvgLookback: number;
  /** חלון אחורה לזיהוי swing-points (מבנה). */
  swingLookback: number;
  /** סינון פערים זעירים (אחוז מינימלי). */
  minFvgSizePct: number;
  /** מכפיל displacement (ב-ATR) שמגדיר תנועה "אימפולסיבית" ל-Order Block / MSS. */
  displacementAtrMult: number;
}

/** הקלט המאוחד למנוע. */
export interface LHEInput {
  macro: MacroLiquidityInput;
  asset: AssetStructure;
  /** היסטוריית נרות (ישן→חדש). האחרון הוא הנוכחי. */
  candles: Candle[];
  orderBook?: OrderBook;
  /** סל עמיתים אופציונלי לדירוג תעלות הולכה. */
  peers?: AssetStructure[];
  config?: Partial<LHEConfig>;
}

/** הערכת ההתלכדות (Confluence) — התובנה המשולבת משכבה 1 עד 3. */
export interface ConfluenceAssessment {
  /** 0..100 — עוצמת השכנוע הכוללת. */
  score: number;
  bias: Direction | 'neutral';
  /** ה-FVG בעל המגנטיות הגבוהה ביותר בכיוון ההטיה. */
  primaryTarget?: GravityTarget;
  /** סיכום מכונה תמציתי (מחולל ההתרעות מרחיב עליו). */
  narrative: string;
  /** דגלים בולטים (למשל "MSS_CONFIRMED", "MACRO_FVG_CONFLUENCE"). */
  flags: string[];
}

/** פלט המנוע המלא. */
export interface LHEResult {
  hpi: HPIResult;
  conduit: AssetConduitResult;
  /** דירוג העמיתים (אם סופק peers). ממוין מהגבוה לנמוך. */
  peerRanking?: AssetConduitResult[];
  microstructure: {
    fvgs: FairValueGap[];
    orderBlocks: OrderBlock[];
    structureShift: StructureShift;
    currentPrice: number;
    atr: number;
  };
  /** יעדי הכבידה (FVGs פתוחים), ממוינים לפי gravityScore. */
  gravityTargets: GravityTarget[];
  confluence: ConfluenceAssessment;
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'critical' | 'high' | 'elevated' | 'info';

/** התרעת LHE מובנית — מותאמת לתצוגת ה-UI של Finextium. */
export interface LHEAlert {
  id: string;
  severity: AlertSeverity;
  /** כותרת קצרה (chip). */
  title: string;
  /** שורת פתיח חדה. */
  headline: string;
  /** גוף ההתרעה — נימוק מקצועי מלא (עברית, RTL). */
  body: string;
  bias: Direction | 'neutral';
  /** 0..100 — רמת ביטחון. */
  confidence: number;
  /** תגיות לסינון/קיבוץ ב-UI. */
  tags: string[];
  /** היעד התפעולי (אזור ה-FVG + הסתברות + זמן). */
  target?: {
    ticker: string;
    zone: [number, number];
    fillProbability: number;
    expectedBarsToFill: number;
  };
  asOf: string;
}
