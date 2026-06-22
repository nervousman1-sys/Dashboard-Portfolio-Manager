# Finextium — Agent Scanner (24/7 Early-Alpha intelligence)

A long-running daemon that, on a fixed cadence, asks the core intelligence model (Gemini, with live
Google-Search grounding so signals are **real and current**) to surface the single highest-conviction
**Early-Alpha** sub-sector — cross-referencing the 4 layers (tech/science, supply chain, talent
migration, quiet VC) with the anti-FOMO filter — and writes the structured insight into the Supabase
table **`catalyst_cards`** for the Finextium UI to read.

The database table + read policy are already created in your Supabase project.

---

## 1. Fill in the secrets

```bash
cp .env.example .env
```

Edit `.env` and set the two secrets:

| Var | Where to get it |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → **Project Settings → API → `service_role`** (secret). |
| `GEMINI_API_KEY` | Google AI Studio → https://aistudio.google.com/app/apikey |

`SUPABASE_URL` is already set to your project. Tuning vars (`GEMINI_MODEL`, `SCAN_INTERVAL_HOURS`,
`DEDUP_DAYS`) have sensible defaults.

## 2. Install + test once

```bash
npm install
node scanner.js --once      # runs a single scan, inserts one card, exits — verify it works
```

## 3. Run 24/7 with PM2 (recommended on a VPS)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs finextium-agent-scanner
pm2 save && pm2 startup      # auto-start on VPS reboot (run the command PM2 prints)
```

That's it — the scanner self-schedules (default every 4h) and PM2 keeps it alive/restarts on crash.

### Alternative: systemd (instead of PM2)

`/etc/systemd/system/finextium-agent.service`:

```ini
[Unit]
Description=Finextium Agent Scanner
After=network-online.target

[Service]
WorkingDirectory=/opt/finextium/agent-scanner
ExecStart=/usr/bin/node scanner.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/finextium/agent-scanner/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now finextium-agent
journalctl -u finextium-agent -f
```

### Alternative: serverless cron (no VPS)

If you'd rather not run a VPS, the same `runCycle()` logic can be exposed as an HTTP endpoint and
triggered by a Vercel Cron (note: the Vercel project is currently at the Hobby 12-function cap, so a
slot must be freed first; Hobby cron cadence is limited). Ask and I'll wire it.

## Notes
- **Real data:** grounding gives live web signals; each card stores the source URLs (`sources`).
- **No duplicates:** a sector seen in the last `DEDUP_DAYS` is skipped; recent sectors are also fed
  back to the model so it diversifies.
- **Cost:** one grounded Gemini call per cycle (6/day at the 4h default) — negligible.
