---
name: vercel-deploy-branch
description: Vercel production deploys from the design-update-google branch, not main; how to deploy manually
metadata:
  type: project
---

The Vercel project `finextium-dashboard` (prj_U8pyMsPUobZrUA8K77ypsGttcJkt, team_ZrM8Y9cMIOyQwxVoOgnZjdJW) serves its **production** target from the `design-update-google` branch — NOT `main`. `main` is ~334 commits stale (last commit 2026-04-09) and effectively abandoned; all real work lives on `design-update-google`.

**Why:** All historical Vercel deployments use `githubCommitRef: design-update-google` with `target: production`, aliased to finextium-dashboard.vercel.app.

**How to apply:** When a feature "doesn't show up live", check that a Vercel deployment exists for the latest commit on `design-update-google` — the GitHub auto-deploy has lagged/not fired before. To force a production deploy: `npx vercel deploy --prod --yes` from project root (CLI authed as nervousman1-5652, project linked via `.vercel/`). The 06-16 reports feature (ניתוח דוחות) was pushed to GitHub but never auto-deployed; a manual `vercel deploy --prod` fixed it.

Vercel Hobby caps serverless functions at 12 — `api/` currently holds exactly 12 files, so adding a new `api/*.js` breaks the build. Merge new endpoints into existing functions via `?mode=` params instead (see [[reports-data-sources]]).
