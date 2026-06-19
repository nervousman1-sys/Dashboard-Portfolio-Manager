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

**US detail view now MERGES both sources (2026-06):** `fetchReport` (non-fast) fetches FMP **and** Yahoo `fundamentals-timeseries` IN PARALLEL and merges via `mergeReports` (FMP primary, Yahoo fills any null per-quarter field by matching `YYYY-MM`, and fills profile sector/beta/price) — so a single source's missing line items no longer leave blank cells/charts. `source` becomes `fmp+yahoo` when both succeed, else the one that did. The fast bulk-prefetch path still uses Yahoo-only. R&D (`rd`) is mapped on BOTH paths (FMP `researchAndDevelopmentExpenses`, Yahoo `ResearchAndDevelopment`), so R&D works even when FMP is quota-capped (verified NVDA $6.3B via Yahoo). `sector`/`beta` still null when ONLY Yahoo succeeds.

**Recent insider transactions:** `fetchFmpInsiders` (FMP `/stable/insider-trading/search`) is best-effort, US detail only — feeds the report summary's "עסקאות בעלי עניין" row. Returns null when FMP is quota-capped, in which case the AI summary cites notable insider activity from public knowledge instead. The report business **summary** (Gemini) has rows: activity sector, growth division, hurt division, decline reasons, investments, **rdFocus** (which division R&D targets), **partnerships**, key customers, recent deals, insider activity — rendered by `_repSummaryHtml` in `reports-view.js`; AI `maxOutputTokens` raised to 4096 for it.

**Beta source:** the Yahoo fundamentals path has no beta (FMP carries it in its profile but is quota-limited), so `fetchReport` enriches beta from **Finnhub** `stock/metric?metric=all` (`metric.beta`) when missing — US only, skipped on the fast bulk-prefetch path to save calls. Needs a clean `FINNHUB_API_KEY` (see prefix bug below).

**Completeness / empty rows:** verified empirically (14 tickers across sectors) that non-financials come back fully populated; only **banks/financials (JPM, GS, BAC…)** lack gross profit / operating income / EBITDA / current assets-liabilities / capex — these don't exist for banks. The view (`reports-view.js`) therefore **hides any metric row or key-figure card that is empty across all shown quarters**, so every visible table is full rather than dotted with "—". EPS/EBITDA/gross-profit are also derived in `reports-engine.js` (`fillDerived`) when a source omits them but the components exist.

**ENV-VAR PREFIX BUG (bit us hard):** On the Vercel projects, several env-var *values* were saved with the var name prefixed in (e.g. `FMP_API_KEY` value = `"FMP_API_KEY=<realkey>"`). `build.js` strips this for the client bundle, but server-side code reading `process.env.*` directly gets the broken value → FMP returned "Invalid API KEY". Affected vars seen: FMP, FINNHUB, TWELVE_DATA, SUPABASE_URL, SUPABASE_ANON_KEY (GEMINI + DISCORD were clean). `lib/reports-data.js` now strips a leading `FMP_API_KEY=` defensively. If other server-side features misbehave, suspect the same prefix bug in their key. See [[vercel-deploy-branch]].

Because of the above: the green "השתפרה" badge means **improvement vs. prior period (YoY/QoQ)**, not vs. analyst consensus. SWOT + strategy/vision are generated in Hebrew by Gemini (`api/report-ai.js`, reuses the `GEMINI_API_KEY` + model list from `api/vision.js`). See [[architecture-vanilla-js-supabase]].
