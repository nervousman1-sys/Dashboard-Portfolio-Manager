# LHE — Liquidity Hydrodynamic Engine

**הסימולטור ההידרודינמי של השוק.** מנוע חיזוי תלת-שכבתי שמתאר את השוק כמערכת הידראולית: נזילות-מאקרו (לחץ) זורמת דרך תעלות-נכסים (רגישות) ומתנקזת לאזורי חוסר-יעילות בגרף (כבידה במיקרו).

מודול **TypeScript טהור, ללא תלויות, ללא side-effects ו-deterministic**. אינו נוגע באפליקציית ה-vanilla הקיימת — ניתן לייבא ל-Next.js / Web Worker, או להידר ל-JS ולקרוא מהדפדפן.

---

## הארכיטקטורה

| שכבה | קובץ | קלט | פלט |
|------|------|-----|-----|
| **1 · מאקרו** — מדד הלחץ ההידראולי (HPI) | `layer1-macro.ts` | מאזני בנקים מרכזיים, TGA, RRP, תשואות/אינפלציה | `HPIResult` — ציון 0–100 + מומנטום (Δ) + משטר נזילות |
| **2 · גישור** — תעלות ההולכה | `layer2-conduits.ts` | מבנה הון/מינוף, נתוני On-Chain, מומנטום | `AssetConduitResult` — Liquidity-β אפקטיבי + Attraction Score |
| **3 · מיקרו** — כבידת זרימת הפקודות | `layer3-microstructure.ts` | נרות (OHLCV), ספר פקודות | FVGs, Order Blocks, MSS/BOS + **Gravity Score** לכל פער |

`engine.ts` מתזמר את השלוש ל-`ConfluenceAssessment` (הטיה, יעד עיקרי, ציון שכנוע). `alerts.ts` ממיר זאת להתרעה מקצועית בעברית.

### עקרון הליבה (שילוב המאקרו לתוך המיקרו)
```
Net Liquidity = מאזן בנק מרכזי − TGA − RRP        (שכבה 1)
Liquidity-β   = baseβ × מינוף-רפלקסיבי × הידוק-היצע (שכבה 2)
Gravity       ∝ mass / √distance × (1 + macroEnergy)  (שכבה 3)
  כאשר  mass = גודל-הפער × (1 + log₂(1+β))   ,   macroEnergy = f(HPI, Δ)
```
ככל שה-HPI גבוה והנכס בעל β גבוה — אנרגיית המאקרו "מטעינה" את שדה הכבידה של ה-FVG: הסתברות המילוי עולה וה-Time-to-Fill מתקצר.

---

## שימוש

```ts
import { runLHE, generateLHEAlert, type LHEInput } from './lib/lhe';

const input: LHEInput = { macro, asset, candles, peers, orderBook };
const result = runLHE(input);          // LHEResult מלא (שלוש השכבות + התלכדות)
const alert  = generateLHEAlert(result); // התרעה מובנית ל-UI
```

### הרצת הדוגמה
```bash
npx -p typescript tsc -p lib/lhe/tsconfig.json   # מהדר ל-lib/lhe/dist
node lib/lhe/dist/example.js                      # מדפיס HPI / conduit / gravity / alert
```
תרחיש הדוגמה: עודף נזילות (Fed מרחיב, TGA+RRP מתנקזים) פוגש `MSTR` (levered_equity, פרמיית mNAV) עם FVG דובי פתוח מעל המחיר ו-MSS עולה → **התלכדות 73/100**.

---

## הערות הנדסיות

- **כל הקבועים** מרוכזים ב-`config.ts` (`DEFAULT_LHE_CONFIG`) וניתנים לדריסה נקודתית דרך `LHEInput.config`. אין "מספרי קסם" פזורים.
- **כיול (calibration):** ה-β הבסיסיים, משקלי ה-HPI ועוגני ה-`logistic`/`tanh` הם נקודת-מוצא סבירה — מומלץ לכייל מול נתונים היסטוריים אמיתיים (רגרסיית תשואות-נכס על Net-Liquidity עבור ה-β הנמדד).
- **מודולריות לעתיד ("Decision Core"):** המנוע מספק קלט מובנה ל-Risk Manager / Market Analyst — `HPIResult` ו-`AssetConduitResult` הם בדיוק הסיגנלים שסוכני ה-AI יצרכו.
- **אין כאן LLM.** מחולל ההתרעות דטרמיניסטי ומבוסס-תבנית; שכבת ה-Gemini הקיימת יכולה לשפר *ניסוח* בלבד מעל הנרטיב המספרי.
- **אינטגרציה ל-vanilla:** הידור עם `module: "ES2020"` ו-`export {}` → טעינה כ-`<script type="module">`, או עטיפה ב-IIFE החושפת `window.LHE`.

## מבנה הקבצים
```
lib/lhe/
├── types.ts                 כל ה-Interfaces (חוזי הנתונים)
├── math.ts                  עזרי נרמול/החלקה טהורים
├── config.ts                ברירות מחדל + resolveConfig
├── layer1-macro.ts          computeHPI
├── layer2-conduits.ts       computeAssetConduit / rankConduits
├── layer3-microstructure.ts detectFVGs / OrderBlocks / MSS / computeGravity
├── engine.ts                runLHE (orchestrator + confluence)
├── alerts.ts                generateLHEAlert (עברית)
├── index.ts                 barrel export
├── example.ts               תרחיש הרצה מלא
└── tsconfig.json            הידור מבודד (לא משפיע על הפרויקט)
```
