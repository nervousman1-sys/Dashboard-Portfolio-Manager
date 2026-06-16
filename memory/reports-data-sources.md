---
name: reports-data-sources
description: Data sources & FMP free-tier limits behind the financial-reports analysis page
metadata:
  type: reference
---

**Vercel Hobby plan = hard 12-serverless-function cap** (every successful deploy shows `lambdaRuntimeStats {"nodejs":12}`). The project sits exactly at 12, so NO new `api/*.js` files may be added — a 13th breaks the build with no useful error. Reports therefore route through EXISTING functions: report data via `api/technicals.js?mode=report&symbol=&market=` (delegates to `lib/reports-data.js`), AI SWOT via `api/vision.js?mode=swot` POST (delegates to `lib/report-ai.js`). Shared logic lives in root `lib/` (outside `api/`, so it doesn't count as a function).

The "ניתוח דוחות כספיים" page (`js/reports-view.js` + `js/reports-engine.js` + `lib/reports-data.js` + `lib/report-ai.js`, opened via `navigateTo('reports')`) was built around these verified constraints of the runtime FMP key (free tier, fallback `PNbEHsY2AO0v9ZkYh69P7nTvyUUckcpp`):

- **Works:** FMP `/stable/income-statement`, `/balance-sheet-statement`, `/cash-flow-statement` (period=quarter), `/profile` — US stocks only.
- **Premium-locked (returns "Premium Query Parameter"):** Israeli `.TA` fundamentals, `key-metrics`/`ratios` *quarterly*, `analyst-estimates`. `earnings-surprises` returns `[]`. So all ratios (margins, P/E, P/B, D/E, working capital) are **computed in `reports-engine.js`**, not pulled.
- **~250 calls/day cap** → list view stays cheap (ticker directory from `/api/technicals?mode=tickers`, no FMP), full reports fetched **on-demand per company**, edge-cached (`s-maxage=21600`). Opened scores cached in localStorage (`rep_scores_v1`).
- **Israel (.TA) source:** Yahoo `ws/fundamentals-timeseries/v1` (quarterly* types, ILS, no auth/crumb needed — the `quoteSummary` and `v7/quote` endpoints DO need a crumb and fail). Price/market-cap from Yahoo `v8/finance/chart` meta. Coverage varies per ticker.

Because of the above: the green "השתפרה" badge means **improvement vs. prior period (YoY/QoQ)**, not vs. analyst consensus. SWOT + strategy/vision are generated in Hebrew by Gemini (`api/report-ai.js`, reuses the `GEMINI_API_KEY` + model list from `api/vision.js`). See [[architecture-vanilla-js-supabase]].
