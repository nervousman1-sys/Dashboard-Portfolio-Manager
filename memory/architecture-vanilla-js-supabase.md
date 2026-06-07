---
name: architecture-vanilla-js-supabase
description: Real architecture is vanilla JS + Supabase, despite CLAUDE.md saying Next.js
metadata:
  type: reference
---

CLAUDE.md describes a Next.js/TypeScript/Neon/Drizzle stack, but the actual running app is a **static vanilla-JS SPA**:
- `index.html` + `js/*.js` (global functions, ordered `<script>` tags, no bundler) + `css/main.css`.
- Backend/data: **Supabase** (client-side SDK; `js/supabase-api.js`, `js/portfolio.js`). The `backend/` Express folder and `js/api.js` (localhost:3001) are legacy/unused in the Supabase path.
- Build: `node build.js` only generates `js/env-config.js` from env vars. Deploy: Vercel (`vercel.json`, outputDirectory `.`).
- Prices: multi-provider waterfall in `js/price-service.js` (FMP batch primary, then Twelve Data for misses, Finnhub/Yahoo fallback). History per ticker: `_fetchTickerTimeSeries` in `js/synthetic-history.js` (cached) — reused by the risk engine.

**How to apply:** treat this as a no-framework static app — add features as new `js/*.js` files + a `<script>` tag in index.html + (if cached) entries in `service-worker.js` and a CACHE_NAME bump.
