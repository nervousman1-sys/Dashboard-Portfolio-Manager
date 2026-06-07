---
name: risk-model-anchors
description: Reference inputs and macro-fetch approach chosen for the CML/SML engine
metadata:
  type: project
---

User-chosen anchors for the CML/SML engine ([[product-pivot-cml-sml]]), decided 2026-06-07:

- **Market proxy**: S&P 500 via `SPY` (`RISK_MODEL.MARKET_SYMBOL` in risk-models.js).
- **Risk-free rate (Rf)**: US 3-Month T-Bill, FRED series `DGS3MO`, fetched through the `/api/fred` proxy; falls back to `RF_FALLBACK` (~4.35%) when the proxy is unreachable (e.g. local static serving).
- **Macro fetch fix**: FRED blocks browser CORS, so a Vercel serverless proxy `api/fred.js` was added (supports `?series_id=&latest=1`, `?series_id=&units=`, and `?batch=ID:units,...`). `macro.js` now uses FRED-via-proxy as the PRIMARY US-indicator source (FMP v4 /economic is restricted on free tier → fallback only). `vercel.json` rewrite excludes `/api/` (`/((?!api/).*)`).

**Why:** classic academic CAPM setup; the proxy is the only reliable way to read FRED from the browser.
**How to apply:** macro data and Rf only work fully after a Vercel deploy; locally they degrade gracefully to baseline/fallback. To change Rf source, edit `RISK_MODEL.RF_SERIES`; an `rf_override` localStorage value (percent) forces a manual rate.
