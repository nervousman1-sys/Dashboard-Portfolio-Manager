---
name: vercel-deploy-branch
description: TWO Vercel projects — the live finextium.com domain is on dashboard-portfolio-manager, NOT the finextium-dashboard project the repo is linked to
metadata:
  type: project
---

**CRITICAL: there are TWO Vercel projects under team_ZrM8Y9cMIOyQwxVoOgnZjdJW, and the public domain is on the one the repo is NOT linked to.**

1. `finextium-dashboard` (prj_U8pyMsPUobZrUA8K77ypsGttcJkt) — the repo's `.vercel/project.json` links here. Domains: `*.vercel.app` only (finextium-dashboard.vercel.app). Auto-deploys from branch `design-update-google`. **The user does NOT visit this one.**
2. `dashboard-portfolio-manager` (prj_mmW5dTSRKrI8Nk0hk60lCCX32vL3) — owns the **real public domain `finextium.com` + `www.finextium.com`** (apex 308-redirects to www). Git-integration deploys from `main`, which is ~334 commits stale (last 2026-04-09) → so finextium.com lagged far behind all real work on `design-update-google`.

**Why:** All dev happens on `design-update-google`, but that branch only auto-deploys the `*.vercel.app` project. The customer-facing finextium.com is wired to `main` on the OTHER project, so features never appeared live even though they were "deployed."

**How to apply:** When a feature "doesn't show up on finextium.com", deploy the current working tree straight to the dashboard-portfolio-manager project's production (overrides its stale-main git deploy):
`VERCEL_ORG_ID=team_ZrM8Y9cMIOyQwxVoOgnZjdJW VERCEL_PROJECT_ID=prj_mmW5dTSRKrI8Nk0hk60lCCX32vL3 npx vercel deploy --prod --yes`
This aliases the new deployment to www.finextium.com immediately. (CLI authed as nervousman1-5652.) The 06-16 reports feature (ניתוח דוחות) was invisible for exactly this reason — fixed by deploying to the correct project. **Long-term fix to suggest: either repoint dashboard-portfolio-manager's git branch to `design-update-google`, or move the finextium.com domain onto the finextium-dashboard project, so one push deploys the live site.**

Vercel Hobby caps serverless functions at 12 — `api/` currently holds exactly 12 files, so adding a new `api/*.js` breaks the build. Merge new endpoints into existing functions via `?mode=` params instead (see [[reports-data-sources]]).
