---
name: product-pivot-cml-sml
description: The app is being repurposed into a CML/SML-based portfolio risk system
metadata:
  type: project
---

As of 2026-06-07 the user pivoted Finextium away from the broad "financial analysis platform" vision in CLAUDE.md toward a focused **portfolio-management system built on CAPM/MPT**: CML, SML, asset correlation, and automatic per-portfolio risk classification.

Implemented:
- `js/risk-models.js` — engine: per-asset E(R)/σ/β/correlation, CML/SML, Jensen's alpha, auto-risk score, buy/avoid/neutral recommendations. `applyModelRiskToClients()` upgrades each portfolio's `risk` from the provisional allocation heuristic (in `_recalcPortfolioWithFx`, price-service.js) to the model-based classification.
- `js/risk-analysis-view.js` + `#riskmodelPage` — the "ניתוח CML/SML" page (CML chart, SML chart, correlation heatmap, per-portfolio metrics, recommendations). Opened via `navigateTo('riskmodel')`.
- Sidebar reduced to: דאשבורד, ניהול תיקים, ניתוח CML/SML, נתוני מאקרו (removed שווקים/תנועות הון/חדשות/הגדרות).
- Recommendation chips per holding in the modal holdings table (modals.js).

See [[risk-model-anchors]] for the model's reference inputs. Core math is unit-verified (β/correlation/risk/recommendation) via a vm test.
