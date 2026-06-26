---
name: vercel-deploy-branch
description: TWO Vercel projects — the live finextium.com domain is on dashboard-portfolio-manager, NOT the finextium-dashboard project the repo is linked to
metadata:
  type: project
---

**There are TWO Vercel projects under team_ZrM8Y9cMIOyQwxVoOgnZjdJW. The public domain finextium.com is on `dashboard-portfolio-manager`.**

1. `finextium-dashboard` (prj_U8pyMsPUobZrUA8K77ypsGttcJkt) — domains: `*.vercel.app` only. Auto-deploys from branch `design-update-google`. **The user does NOT visit this one** (it's effectively staging).
2. `dashboard-portfolio-manager` (prj_mmW5dTSRKrI8Nk0hk60lCCX32vL3) — owns the **real public domain `finextium.com` + `www.finextium.com`** (apex 308-redirects to www). Git-integration deploys from `main` (stale) — IGNORE that; deploy via CLI.

**FIXED 2026-06-26:** `.vercel/project.json` (gitignored, local) was repointed to `dashboard-portfolio-manager`, so a plain **`npx vercel --prod --yes` from the repo now deploys straight to finextium.com** and auto-aliases www.finextium.com. No env-var prefix needed anymore. This is the standard deploy command for shipping to the live site.

**Cache:** `vercel.json` sets `no-store` (+ `Vercel-CDN-Cache-Control: no-store`) on `/`, `/index.html`, `/service-worker.js` so the CDN never serves a stale shell; changed JS/CSS get a `?v=NNN` bump in index.html. After deploy, a single hard refresh is enough.

**Still TODO (needs Vercel dashboard, not CLI):** for true git-push-to-live, either move the finextium.com domain onto `finextium-dashboard`, or set `dashboard-portfolio-manager`'s production branch to `design-update-google`. Until then, ship via the CLI deploy above.

Vercel Hobby caps serverless functions at 12 — `api/` currently holds exactly 12 files, so adding a new `api/*.js` breaks the build. Merge new endpoints into existing functions via `?mode=` params instead (see [[reports-data-sources]]).
