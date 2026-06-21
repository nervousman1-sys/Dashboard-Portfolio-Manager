// ========== DISCORD NEWS PAGE — חדשות כלכלה ושוק ההון ==========
//
// A dedicated page (sidebar) streaming the user's Discord server (where agents
// post market updates) into the platform, grouped by channel. While the page is
// open it polls /api/discord every 20s — a new Discord message shows up here
// within seconds.

let _dnTimer = null;
let _dnActiveChannel = 'all';
let _dnLastData = null;
let _dnLastSig = null; // signature of the last rendered feed — skips no-op re-renders
let _dnInsiderQuery = ''; // ticker filter for the insider-buys tab

// ── Insider-buys persistent history ──────────────────────────────────────────
// The feed API only returns recent messages; we accumulate insider posts locally
// (deduped by id, capped) so the tab keeps the FULL history across sessions.
const _DN_INSIDER_LS = 'dn_insider_hist_v1';
const _DN_INSIDER_CAP = 1500;
function _dnInsiderLabel(name) { return _dnLabelOf(name) === 'קניות פנימיות'; }
function _dnMergeInsiderHistory(data) {
    try {
        const ch = (data.channels || []).find(c => _dnInsiderLabel(c.name));
        if (!ch) return;
        const store = JSON.parse(localStorage.getItem(_DN_INSIDER_LS) || '{}');
        const byId = store.byId || {};
        (ch.messages || []).forEach(m => { const k = m.id || m.ts; if (k) byId[k] = m; });
        // Cap: keep the newest _DN_INSIDER_CAP by timestamp.
        let all = Object.values(byId).sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (all.length > _DN_INSIDER_CAP) all = all.slice(0, _DN_INSIDER_CAP);
        const capped = {}; all.forEach(m => { capped[m.id || m.ts] = m; });
        localStorage.setItem(_DN_INSIDER_LS, JSON.stringify({ byId: capped }));
        // Replace the channel's messages with the full merged history (newest-first).
        ch.messages = all;
    } catch (e) { /* keep API messages as-is on any storage error */ }
}
function _dnInsiderHistory() {
    try { const s = JSON.parse(localStorage.getItem(_DN_INSIDER_LS) || '{}'); return Object.values(s.byId || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0)); } catch (e) { return []; }
}
// Extract the stock ticker from an insider post (it appears as "(EQPT)").
function _dnTickerOf(m) {
    const txt = (m.embeds || []).map(e => `${e.title || ''} ${e.description || ''} ${(e.fields || []).map(f => f.name + ' ' + f.value).join(' ')}`).join(' ') + ' ' + (m.content || '');
    const mt = txt.match(/\(([A-Z]{1,5}(?:\.[A-Z])?)\)/);
    return mt ? mt[1] : '';
}
// Technical-analysis (TradingView) + in-app financial-reports links for an insider post.
function _dnInsiderLinks(tk) {
    if (!tk) return '';
    return `<div class="dn-insider-links">
        <a class="reco-gf" href="javascript:void(0)" onclick="openTechnicalForTicker('${tk}')">📈 ניתוח טכני ↗</a>
        <a class="reco-gf" href="javascript:void(0)" onclick="openReportForTicker('${tk}')">📄 דוחות החברה ↗</a>
    </div>`;
}
function setDnInsiderQuery(v) {
    _dnInsiderQuery = String(v || '').toUpperCase().trim();
    _dnRender();
    // keep focus in the search box after the re-render
    const el = document.getElementById('dnInsiderSearch');
    if (el) { el.value = _dnInsiderQuery; el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
}

function openDiscordNews() {
    const page = document.getElementById('discordNewsPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => {
        if (el.id !== 'discordNewsPage') el.style.display = 'none';
    });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof updateURLState === 'function') updateURLState({ view: 'disconews' });
    if (typeof _setActiveNav === 'function') _setActiveNav('disconews');

    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">חדשות כלכלה ושוק ההון</h1>
            <div style="display:flex;gap:8px;align-items:center">
                <span class="dn-live" id="dnLive"><span class="dn-live-dot"></span> עדכון חי</span>
                <button class="macro-back-btn" onclick="closeDiscordNews()">חזור לדשבורד</button>
            </div>
        </div>
        <div class="macro-content">
            <div class="dn-tabs" id="dnTabs"></div>
            <div id="dnFeed"><div class="adv-empty">טוען עדכונים מהדיסקורד…</div></div>
        </div>
    </div>`;
    window.scrollTo(0, 0);

    _dnFetchAndRender();
    if (_dnTimer) clearInterval(_dnTimer);
    _dnTimer = setInterval(() => {
        const el = document.getElementById('discordNewsPage');
        if (!el || !el.classList.contains('active')) { clearInterval(_dnTimer); _dnTimer = null; return; }
        _dnFetchAndRender(true);
    }, 20000);
}

function closeDiscordNews() {
    const page = document.getElementById('discordNewsPage');
    if (!page) return;
    if (_dnTimer) { clearInterval(_dnTimer); _dnTimer = null; }
    page.classList.remove('active');
    page.innerHTML = '';
    const header = document.querySelector('.header');
    if (header) header.style.display = '';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { el.style.display = ''; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = '';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = '';
    if (typeof clearURLState === 'function') clearURLState();
    if (typeof _setActiveNav === 'function') _setActiveNav('dashboard');
}

function _dnEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Category label for a Discord channel name (module-scope so setDnChannel + _dnRender share it)
function _dnLabelOf(name) {
    const n = String(name || '');
    if (n.includes('חדשות')) return 'חדשות';
    if (n.includes('קטליסט')) return 'קטליסט';
    if (n.includes('תנועות-הון')) return 'תנועות הון';
    if (n.includes('קניות-פנימיות')) return 'קניות פנימיות';
    if (n.includes('אופציות')) return 'ניתוח תנועת אופציות';
    return _dnCleanName(n);
}

// Extract image URLs from a slimmed Discord message (content links, embeds, attachments).
function _dnImgsOf(m) {
    const isImg = (u) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u || '') || /(cdn|media)\.discordapp\.|hcti\.io/.test(u || '');
    const out = [];
    const urls = (m.content || '').match(/https?:\/\/\S+/g) || [];
    for (const u of urls) if (isImg(u)) out.push(u);
    for (const e of (m.embeds || [])) if (e && e.image) out.push(e.image);
    for (const a of (m.attachments || [])) if (a && (isImg(a.url) || /\.(png|jpe?g|webp|gif)/i.test(a.name || ''))) out.push(a.url);
    return out;
}
// Pre-transcribe the latest day's flows + headlines images in the background so opening the
// panel is instant. Only the heavy daily channels; fire-and-forget (cache + dedup handle it).
function _dnPrefetchLatestVision(data) {
    try {
        for (const ch of (data.channels || [])) {
            const name = String(ch.name || '');
            const mode = name.includes('תנועות-הון') ? 'flows' : name.includes('חדשות') ? 'headlines' : null;
            if (!mode) continue;
            const imgs = [];
            for (const m of (ch.messages || []).slice(0, 3)) for (const u of _dnImgsOf(m)) imgs.push(u);
            [...new Set(imgs)].slice(0, 2).forEach((img, i) => setTimeout(() => { try { _dnVisionText(img, mode); } catch (e) { } }, 400 + i * 600));
        }
    } catch (e) { /* non-fatal */ }
}

async function _dnFetchAndRender(silent) {
    const feedEl = document.getElementById('dnFeed');
    if (!feedEl) return;
    try {
        const res = await fetch(`/api/discord?mode=feed&t=${Math.floor(Date.now() / 15000)}`, { headers: { Accept: 'application/json' } });
        const data = await res.json();

        if (data && data.error === 'not_configured') {
            feedEl.innerHTML = `
            <div class="risk-table-card glass-card dn-setup">
                <h3>החיבור לדיסקורד ממתין להגדרה</h3>
                <p>כדי שהפלטפורמה תוכל לקרוא את ערוצי הדיסקורד, יש ליצור Bot ולהזין את הטוקן שלו (DISCORD_BOT_TOKEN) בהגדרות השרת. ההוראות המלאות אצל המפתח.</p>
            </div>`;
            return;
        }
        if (!data || !Array.isArray(data.channels)) {
            if (!silent) feedEl.innerHTML = '<div class="adv-empty">לא ניתן לטעון את הפיד כרגע — ננסה שוב אוטומטית.</div>';
            return;
        }
        // Change-detection: a silent auto-refresh must NOT rebuild the DOM when the
        // content is identical — that re-render is what caused the recurring "jump"
        // every refresh. Only re-render when messages actually changed.
        const sig = data.channels.map(c => `${c.id}:${(c.messages || []).map(m => m.id || m.ts || '').join(',')}`).join('|');
        if (silent && sig === _dnLastSig && document.getElementById('dnFeed')?.childElementCount) {
            const live = document.getElementById('dnLive'); if (live) live.classList.add('on');
            return;
        }
        _dnLastSig = sig;
        _dnMergeInsiderHistory(data); // accumulate full insider history locally
        _dnLastData = data;
        _dnRender();
        const live = document.getElementById('dnLive');
        if (live) live.classList.add('on');
        // Warm the heavy daily transcriptions (flows + headlines) in the BACKGROUND so the
        // panel opens instantly — and the result is shared via the edge/localStorage cache.
        _dnPrefetchLatestVision(data);
    } catch (e) {
        if (!silent && feedEl) feedEl.innerHTML = '<div class="adv-empty">שגיאה בטעינת הפיד — ננסה שוב אוטומטית.</div>';
    }
}

function setDnChannel(id) {
    _dnActiveChannel = id;
    // Persist the chosen category (by label) so a page refresh stays on it
    try {
        const c = (_dnLastData?.channels || []).find(x => x.id === id);
        if (c) localStorage.setItem('dn_active_cat', _dnLabelOf(c.name));
    } catch (e) { /* ignore */ }
    _dnRender();
}

// Per-channel display rules:
//   hidden   — not shown at all (הודעות-מיוחדות, ניתוח-חברות-יומי)
//   collapse — image-heavy daily posts (חדשות, תנועות-הון): a textual headline line
//              collapsed by DATE; the image opens only on click
//   options  — תנועת אופציות: clearer/larger tabular font, collapsed by date
function _dnChannelKind(name) {
    const n = String(name || '');
    if (n.includes('הודעות-מיוחדות') || n.includes('ניתוח-חברות')) return 'hidden';
    if (n.includes('חדשות') || n.includes('תנועות-הון')) return 'collapse';
    if (n.includes('אופציות')) return 'options';
    return 'normal';
}

function _dnDateOf(m) {
    const d = m.ts ? new Date(m.ts) : null;
    return d ? d.toLocaleDateString('he-IL') : '';
}

// Keep only the most recent N calendar days of updates (חדשות / תנועות הון /
// אופציות). Counts DISTINCT dates that actually have posts — so a weekend gap
// doesn't shrink the window — and drops everything older than the Nth day.
const _DN_HISTORY_DAYS = 3;
function _dnLastNDays(messages, n = _DN_HISTORY_DAYS) {
    if (!Array.isArray(messages) || !messages.length) return messages || [];
    const keyOf = (m) => {
        const d = m.ts ? new Date(m.ts) : null;
        return d ? d.toISOString().slice(0, 10) : ''; // sortable YYYY-MM-DD
    };
    const distinct = [...new Set(messages.map(keyOf).filter(Boolean))].sort().reverse();
    const keep = new Set(distinct.slice(0, n));
    return messages.filter(m => keep.has(keyOf(m)));
}

// Clean channel name for display: no '#', no emojis/symbols, dashes → spaces
function _dnCleanName(name) {
    return String(name || '')
        .replace(/#/g, '')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Lazy vision load: when a collapsed daily post is expanded, transcribe/summarize
// the image into Hebrew TEXT via /api/vision. Result cached in localStorage —
// each image is read exactly once per browser (and once globally at the edge).
// Image list of a .dn-vision box (JSON in data-imgs, legacy single data-img)
function _dnBoxImgs(box) {
    try {
        const arr = JSON.parse(decodeURIComponent(box.dataset.imgs || ''));
        if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* legacy */ }
    return box.dataset.img ? [box.dataset.img] : [];
}

// Fetch + cache ONE image's Hebrew text (localStorage → edge → Gemini).
// In-flight dedup so prefetch and an expanded post never double-call Gemini.
const _dnVisionInflight = {};
async function _dnVisionText(img, mode) {
    // v6: coherence/OCR self-check pass (fixes garbled Hebrew like "חולות נפש"→"חולות נפט")
    const cacheKey = 'dn_vision8_' + mode + '_' + (img.split('?')[0].split('/').slice(-2).join('_'));
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) return cached;
    } catch (e) { /* ignore */ }
    if (_dnVisionInflight[cacheKey]) return _dnVisionInflight[cacheKey];
    _dnVisionInflight[cacheKey] = (async () => {
        // Retry transient failures (cold serverless / Gemini quota / slow image fetch) —
        // the #1 reason a fresh machine "can't read the image" while a cached one shows it.
        const attempts = 3;
        try {
            for (let i = 0; i < attempts; i++) {
                try {
                    const res = await fetch(`/api/vision?img=${encodeURIComponent(img)}&mode=${mode}&pv=8`, { headers: { Accept: 'application/json' } });
                    const j = await res.json().catch(() => null);
                    if (j && j.text) {
                        try { localStorage.setItem(cacheKey, j.text); } catch (e) { /* full */ }
                        return j.text;
                    }
                } catch (e) { /* network — retry */ }
                if (i < attempts - 1) await new Promise(r => setTimeout(r, 1200 * (i + 1)));
            }
            return null;
        } finally {
            setTimeout(() => { delete _dnVisionInflight[cacheKey]; }, 0);
        }
    })();
    return _dnVisionInflight[cacheKey];
}

async function _dnLoadVision(det) {
    if (!det || !det.open) return;
    const box = det.querySelector('.dn-vision');
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const mode = box.dataset.mode || 'transcribe';
    const imgs = _dnBoxImgs(box);
    if (!imgs.length) { box.innerHTML = '<div class="adv-empty">אין תוכן נוסף.</div>'; return; }
    box.innerHTML = '<div class="adv-empty">קורא את התוכן מהתמונה…</div>';
    // ALL the post's images in parallel — flows posts split the data across
    // several images; reading only the first one showed a partial picture.
    const texts = await Promise.all(imgs.map(u => _dnVisionText(u, mode)));
    const ok = texts.filter(Boolean);
    if (ok.length) {
        box.innerHTML = _dnVisionHTML(ok.join('\n'), imgs[0], mode);
        if (mode === 'flows') {
            _dnFillFlowsNews(box); // pull real headlines for the side
            // Warm the risk model in the background (de-duped/persisted) so a sector-stock
            // popup opens with CML/SML verdicts already computed — no slow "ממתין" wait.
            if (typeof buildRiskModel === 'function' && typeof clients !== 'undefined' && clients.length && !window._secModelWarmed) {
                window._secModelWarmed = true;
                setTimeout(() => { try { buildRiskModel(clients); } catch (e) { window._secModelWarmed = false; } }, 200);
            }
        }
    } else {
        box.dataset.loaded = '';
        box.innerHTML = `<div class="adv-empty">לא הצלחנו לקרוא את התמונה כרגע — <a href="${_dnEsc(imgs[0])}" target="_blank" rel="noopener" style="color:var(--accent-blue)">פתח את התמונה</a></div>`;
    }
}

// Background warm-up: pre-read the visible category's images right after render,
// so expanding any day is instant instead of waiting on Gemini per click.
let _dnPrefetchRun = 0;
async function _dnPrefetchVisions() {
    const run = ++_dnPrefetchRun;
    const boxes = Array.from(document.querySelectorAll('#dnFeed .dn-vision')).slice(0, 10);
    const jobs = [];
    for (const b of boxes) {
        const mode = b.dataset.mode || 'transcribe';
        for (const u of _dnBoxImgs(b)) jobs.push({ u, mode });
    }
    for (let i = 0; i < jobs.length; i += 3) {
        if (run !== _dnPrefetchRun) return; // a newer render superseded this pass
        await Promise.all(jobs.slice(i, i + 3).map(j => _dnVisionText(j.u, j.mode)));
    }
}

function _dnVisionHTML(text, img, mode) {
    const srcLink = `<a class="dn-att" href="${_dnEsc(img)}" target="_blank" rel="noopener">פתח את התמונה המקורית</a>`;
    const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);

    // FLOWS: structured "סקטור | כיוון | היקף" lines → a clean two-group histogram
    // (inflows then outflows, each sorted by magnitude, bar width = |%| relative to
    // the largest move). Same data as the image — nothing added, nothing dropped.
    if (mode === 'flows') {
        const rows = [];
        let conclusion = '';
        const analysis = [];     // "ניתוח:" lines — the reasoning shown in the empty space
        const institutions = []; // "מוסדי:" lines — named movers, if the image had any
        for (const l of lines) {
            const mC = l.match(/^מסקנה\s*:\s*(.+)$/);
            if (mC) { conclusion = mC[1].trim(); continue; }
            const mA = l.match(/^ניתוח\s*:\s*(.+)$/);
            if (mA) { analysis.push(mA[1].trim()); continue; }
            const mI = l.match(/^מוסדי\s*:\s*(.+)$/);
            if (mI) { institutions.push(mI[1].trim()); continue; }
            // Tolerate BOTH the labeled form ("סקטור: X | כיוון: כניסה | היקף: 4.3%")
            // and the short form the model sometimes emits ("סקטור: X | כניסה | 4.3%").
            // Direction and amount are detected by CONTENT, not by their label/position —
            // so a dropped "כיוון:"/"היקף:" label no longer breaks the whole histogram
            // (which then fell back to dumping raw lines as plain text).
            const mS = l.match(/^סקטור\s*:\s*(.+)$/);
            if (mS) {
                const segs = mS[1].split('|').map(x => x.replace(/^\s*(כיוון|היקף|כיוּן)\s*:\s*/, '').trim()).filter(Boolean);
                const raw = (segs[0] || '').trim();
                let dirStr = '', amount = '';
                for (let i = 1; i < segs.length; i++) {
                    const p = segs[i];
                    if (!dirStr && /כניס|יציא|נכנס|יוצא/.test(p)) { dirStr = p; continue; }
                    if (!amount && /\d/.test(p) && p.includes('%')) { amount = p; continue; }
                }
                if (!amount || !amount.includes('%')) continue; // percentages only — no $B ETF rows
                // Drop rows whose "sector" is actually a direction/summary word the transcription
                // mistook for a sector name (e.g. "עולה"/"יורד" = rising/falling, "כניסה"/"יציאה",
                // a bare total/header). These are noise, not real sectors.
                if (/^(עולה|יורד|עולים|יורדים|עליי?ה|ירידה|כניסה|יציאה|נכנס|יוצא|סקטור|נכס|שינוי|תשואה|סך\s*הכל|סה["״]?כ|כולל|כללי|total|net|inflow|outflow)$/i.test((segs[0] || '').trim())) continue;
                // Split a sector label into a clean name + the tickers in its parens.
                // "מניות בולטות (NVDA, AMD, AVGO)" → base="מניות בולטות", tickers=[NVDA,AMD,AVGO]
                let base = raw, tickers = [];
                const pm = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
                if (pm) {
                    const inside = pm[2].split(/[,\s]+/).map(t => t.replace(/[^A-Za-z.]/g, '').toUpperCase())
                        .filter(t => /^[A-Z]{1,5}(\.[A-Z]+)?$/.test(t));
                    if (inside.length) { tickers = inside; base = (pm[1].trim() || raw); }
                }
                rows.push({
                    name: base, tickers,
                    inflow: /כניס|נכנס/.test(dirStr),
                    amount,
                    mag: Math.abs(parseFloat(String(amount).replace(/[^\d.\-]/g, ''))) || 0,
                });
            }
        }
        if (rows.length) {
            // Multi-image posts can repeat a sector — keep one row per sector+direction
            const _seen = new Map();
            for (const r of rows) {
                const k = r.name + '|' + r.inflow;
                const ex = _seen.get(k);
                if (!ex || r.mag > ex.mag) _seen.set(k, r);
            }
            rows.length = 0;
            rows.push(..._seen.values());
            const maxN = Math.max(...rows.map(r => r.mag), 0.001);
            let axisMax = Math.max(5, Math.ceil(maxN / 5) * 5);
            if (axisMax - maxN < maxN * 0.05) axisMax += 5;
            window._dnFlowSectors = window._dnFlowSectors || {};
            const bar = (r) => {
                // The sector name itself is the click target — opens its stock list
                // (no extra button → cleaner, more compact histogram).
                let nameHtml = `<span class="dn-flow-secname">${_dnEsc(r.name)}</span>`;
                const sid = 'fs_' + Math.random().toString(36).slice(2, 9);
                window._dnFlowSectors[sid] = { sector: r.name, tickers: r.tickers || [] };
                nameHtml = `<span class="dn-flow-secname clickable" onclick="openSectorStocks('${sid}')" title="לחץ לרשימת המניות בסקטור">${_dnEsc(r.name)} <span class="dn-flow-secname-ind">▾</span></span>`;
                return `
                <div class="dn-flow-row">
                    <span class="dn-flow-name">${nameHtml}</span>
                    <div class="dn-flow-track"><div class="dn-flow-bar ${r.inflow ? 'in' : 'out'}" style="width:${Math.max(4, r.mag / axisMax * 100).toFixed(1)}%"></div></div>
                    <span class="dn-flow-amt ${r.inflow ? 'in' : 'out'}">${_dnEsc(r.amount)}</span>
                </div>`;
            };
            const axisNote = `<div class="dn-flow-axis">סקאלה: 0% – ${axisMax}%</div>`;
            const ins = rows.filter(r => r.inflow).sort((a, b) => b.mag - a.mag);
            const outs = rows.filter(r => !r.inflow).sort((a, b) => b.mag - a.mag);
            const insHTML = ins.length ? `<div class="dn-flow-group in">▲ כניסת כסף</div>${ins.map(bar).join('')}` : '';
            const outsHTML = outs.length ? `<div class="dn-flow-group out">▼ יציאת כסף</div>${outs.map(bar).join('')}` : '';
            const barsCol = `<div class="dn-flow-bars">${insHTML}${outsHTML}${axisNote}</div>`;

            // LEFT column — the words: conclusion, named institutions (if shown), and
            // the reasoning for the rotation.
            const conc = conclusion ? `<div class="dn-flow-conc" dir="rtl"><b>לאן זורם הכסף:</b> ${_dnEsc(conclusion)}</div>` : '';
            // FACTUAL institutional attribution: for each moving sector, list the major
            // ETFs ACROSS asset managers (State Street, Vanguard, BlackRock, VanEck,
            // Fidelity…) — each linking to its live fund page where the actual flows
            // and performance are shown. Real, verifiable, multi-issuer.
            const flowEtfs = [];
            const seenInst = new Set();
            for (const r of [...rows].sort((a, b) => b.mag - a.mag)) {
                const key = (r.tickers || []).map(t => t.toUpperCase()).find(t => SECTOR_ETF_GROUP[t]);
                if (!key) continue;
                for (const [t, issuer] of SECTOR_ETF_GROUP[key]) {
                    if (seenInst.has(t)) continue;
                    seenInst.add(t);
                    flowEtfs.push({ t, issuer, dir: r.inflow, sector: r.name });
                }
                if (flowEtfs.length >= 18) break;
            }
            // (a) NAMED movers the image itself called out (BlackRock, Vanguard…) —
            // structured into direction · name · destination · amount, each with an SEC
            // 13F source so the reader can verify who bought and (via the filing) into what.
            const rawMovers = institutions.map(_dnParseInstMover);
            // ── NET consolidation ──
            // The same body+asset can appear as both a buy (▲) and a sell (▼) — reading as
            // "bought SOXX then sold it?". Consolidate each institution+destination to its
            // NET flow (bought − sold) so the list shows ONE clear position change, with the
            // gross detail kept transparent. Movers with no $ size (e.g. "2.6%") pass through.
            const _netMap = new Map();   // key → { name, dest, inMag, outMag }
            const _passMovers = [];
            for (const m of rawMovers) {
                const mag = _dnAmtMag(m.amount);
                if (!(mag > 0) || !m.dir) { _passMovers.push(m); continue; }
                const key = m.name + '' + (m.dest || '');
                let g = _netMap.get(key);
                if (!g) { g = { name: m.name, dest: m.dest || '', inMag: 0, outMag: 0 }; _netMap.set(key, g); }
                if (m.dir === 'in') g.inMag += mag; else g.outMag += mag;
            }
            const moverObjs = [];
            for (const g of _netMap.values()) {
                const net = g.inMag - g.outMag, gross = g.inMag + g.outMag;
                if (gross <= 0) continue;
                const balanced = Math.abs(net) < 0.05 * gross;   // equal buy+sell → churn, not a net move
                const grossNote = (g.inMag > 0 && g.outMag > 0)
                    ? `נטו · קנו $${_dnFmtMag(g.inMag)} ומכרו $${_dnFmtMag(g.outMag)}` : '';
                moverObjs.push({
                    name: g.name, dest: g.dest,
                    dir: balanced ? '' : (net > 0 ? 'in' : 'out'),
                    amount: balanced ? 'מאוזן' : '$' + _dnFmtMag(Math.abs(net)),
                    netMag: Math.abs(net), grossNote, balanced,
                });
            }
            moverObjs.sort((a, b) => (b.netMag || 0) - (a.netMag || 0));
            for (const m of _passMovers) moverObjs.push(m);
            // REAL-DATA highlight: the sector that received the most institutional money.
            // Prefer the actual per-institution NET destinations the image named (sum the
            // net $ by destination); when none are given, fall back to the top INFLOW sector
            // from the histogram — both are real figures parsed from the image, nothing invented.
            const destAgg = new Map();
            for (const m of moverObjs) {
                const mag = m.netMag != null ? m.netMag : _dnAmtMag(m.amount);
                if (m.dir === 'in' && m.dest && !_dnGenericDest(m.dest) && mag > 0) destAgg.set(m.dest, (destAgg.get(m.dest) || 0) + mag);
            }
            let topDest = '', topDestNote = '';
            if (destAgg.size) {
                const e = [...destAgg.entries()].sort((a, b) => b[1] - a[1])[0];
                topDest = e[0]; topDestNote = 'לפי דיווחי הגופים';
            } else if (ins[0]) {
                // Refine the broad sector to its specific sub-industry using the image's tickers.
                const sub = _dnSubSector(ins[0].name, ins[0].tickers);
                let label = ins[0].name;
                if (sub) {
                    if (sub.includes(ins[0].name)) label = sub;                       // sub already richer
                    else if (!ins[0].name.includes(sub)) label = `${ins[0].name} — ${sub}`;
                }
                topDest = label;
                topDestNote = ins[0].amount;
            }
            // Per-institution dominant destination: when the same body appears more than
            // once with named destinations, compute where IT moved the most (real summed $).
            const perInst = new Map();   // name → Map(dest → net $mag)
            for (const m of moverObjs) {
                const mag = m.netMag != null ? m.netMag : _dnAmtMag(m.amount);
                if (m.dir === 'in' && m.dest && !_dnGenericDest(m.dest) && mag > 0) {
                    if (!perInst.has(m.name)) perInst.set(m.name, new Map());
                    const d = perInst.get(m.name);
                    d.set(m.dest, (d.get(m.dest) || 0) + mag);
                }
            }
            const instTopDest = (name) => {
                const d = perInst.get(name);
                if (!d || d.size < 2) return '';
                return [...d.entries()].sort((a, b) => b[1] - a[1])[0][0];
            };
            // Biggest single institutional NET inflow (real, consolidated amounts).
            const biggestIn = moverObjs.filter(m => m.dir === 'in' && (m.netMag != null ? m.netMag : _dnAmtMag(m.amount)) > 0)
                .sort((a, b) => (b.netMag != null ? b.netMag : _dnAmtMag(b.amount)) - (a.netMag != null ? a.netMag : _dnAmtMag(a.amount)))[0];
            let bigMoveHTML = '';
            if (topDest || biggestIn) {
                const bits = [];
                if (topDest) bits.push(`הכי הרבה כסף נכנס אל <b>${_dnEsc(topDest)}</b>${topDestNote ? ` (<span dir="auto">${_dnEsc(topDestNote)}</span>)` : ''}`);
                if (biggestIn) bits.push(`ההעברה המוסדית הבולטת: <b>${_dnEsc(biggestIn.name)}</b> <span dir="ltr">${_dnEsc(biggestIn.amount)}</span>${(biggestIn.dest && !_dnGenericDest(biggestIn.dest)) ? ` אל ${_dnEsc(biggestIn.dest)}` : ''}`);
                bigMoveHTML = `<div class="dn-flow-bigmove" dir="rtl"><span class="dn-bigmove-ic">▲</span> ${bits.join(' · ')}</div>`;
            }
            const _domShown = new Set();   // show an institution's dominant destination once
            const moversHTML = institutions.length
                ? `<div class="dn-flow-inst dn-flow-movers"><div class="dn-flow-inst-h">גופים מוסדיים בולטים · נטו (קנייה פחות מכירה)</div><div class="dn-flow-inst-sub">★ ליד הנכס = הנכס שאליו הגוף הזרים את הזרימה הנטו הגדולה ביותר · כל שורה מציינת את הנכס המדויק שהועבר</div>${bigMoveHTML}${moverObjs.map(m => {
                    const cls = m.dir === 'in' ? 'in' : (m.dir === 'out' ? 'out' : 'flat');
                    const arrow = m.dir === 'in' ? '▲' : (m.dir === 'out' ? '▼' : '◼');
                    const dirWord = m.dir === 'in' ? 'נטו קנייה' : (m.dir === 'out' ? 'נטו מכירה' : 'מאוזן (קנייה≈מכירה)');
                    // ★ marks the ASSET that received this institution's largest net flow —
                    // placed next to the ASSET itself. Once per institution; its top row
                    // (rows are sorted by net size), and only for a real net move.
                    const isTopRow = !_domShown.has(m.name);
                    if (isTopRow) _domShown.add(m.name);
                    const starOnAsset = (isTopRow && m.dest && m.dir)
                        ? ` <span class="dn-mover-star" title="הנכס שאליו ${_dnEsc(m.name)} הזרים את הזרימה הנטו הגדולה ביותר">★</span>` : '';
                    // The EXACT asset the flow went to: its central ticker (always shown
                    // when resolvable), the name, and its sub-sector.
                    const subLabel = _dnDestSubLabel(m.dest);
                    const destTk = _dnDestTicker(m.dest);
                    const tkBadge = (destTk && destTk.toUpperCase() !== String(m.dest).trim().toUpperCase())
                        ? `<span class="dn-mover-tk">${_dnEsc(destTk)}</span> ` : '';
                    // A generic "ETF"/"מניות" target with no specific ticker is a dead-end —
                    // show the actual holdings live (the institution's positions) instead of
                    // a meaningless label.
                    const specificDest = m.dest && (!_dnGenericDest(m.dest) || destTk);
                    const destHtml = specificDest
                        ? `<span class="dn-mover-dest">${m.dir === 'out' ? 'מ־' : (m.dir === 'in' ? 'אל ' : '')}${tkBadge}${_dnEsc(m.dest)}${subLabel ? ` <span class="dn-mover-sub">· ${_dnEsc(subLabel)}</span>` : ''}${starOnAsset}</span>`
                        : `<a class="dn-mover-dest dn-mover-holdings" href="${institutionSourceUrl(m.name)}" target="_blank" rel="noopener" title="האחזקות בפועל של ${_dnEsc(m.name)} מתוך דיווח 13F">לאילו ניירות? · פירוט אחזקות ↗</a>`;
                    const amtHtml = m.amount
                        ? `<span class="dn-mover-amt ${cls}" dir="ltr" title="${m.grossNote ? _dnEsc(m.grossNote) : _dnEsc(dirWord)}">${_dnEsc(m.amount)}</span>`
                        : '<span class="dn-mover-amt">—</span>';
                    const grossHtml = m.grossNote ? `<span class="dn-mover-gross">${_dnEsc(m.grossNote)}</span>` : '';
                    return `<div class="dn-mover-row ${cls}" dir="rtl">
                        <span class="dn-mover-dir ${cls}" title="${dirWord}">${arrow}</span>
                        <span class="dn-mover-name">${_dnEsc(m.name)}</span>
                        ${destHtml}
                        ${amtHtml}
                        <a class="dn-inst-src" href="${institutionSourceUrl(m.name)}" target="_blank" rel="noopener" title="דיווחי 13F של הגוף ב-SEC — האחזקות והקניות/מכירות בפועל, ולאן הכסף נכנס">מקור 13F ↗</a>
                        ${grossHtml}
                    </div>`;
                  }).join('')}</div>`
                : '';
            // (b) FACTUAL asset-manager attribution — the ETFs behind each moving sector,
            // each linking to the live holders + flows pages. Shown alongside (a).
            const factualHTML = flowEtfs.length
                ? `<div class="dn-flow-inst"><div class="dn-flow-inst-h">מנהלי הנכסים מאחורי התנועות (נתוני אמת · מעודכן יומית)</div>${flowEtfs.map(e => `
                    <div class="dn-flow-inst-row" dir="rtl">
                        <span class="dn-inst-dir ${e.dir ? 'in' : 'out'}">${e.dir ? '▲' : '▼'}</span>
                        <span class="dn-inst-tk">${_dnEsc(e.t)}</span>
                        <span class="dn-inst-sector">${_dnEsc(e.sector)}</span>
                        <span class="dn-inst-name">${_dnEsc(e.issuer)}</span>
                        <a class="dn-inst-src" href="${holdersUrl(e.t)}" target="_blank" rel="noopener" title="המוסדיים שמחזיקים בקרן והקניות/מכירות האחרונות שלהם">מי קנה (מוסדיים) ↗</a>
                        <a class="dn-inst-src dn-inst-src2" href="${fundFlowsUrl(e.t)}" target="_blank" rel="noopener" title="זרימת ההון נטו לקרן">זרימות ↗</a>
                    </div>`).join('')}</div>`
                : '';
            const instHTML = moversHTML + factualHTML;
            const analHTML = analysis.length
                ? `<div class="dn-flow-analysis"><div class="dn-flow-analysis-h">למה הכסף זורם כך — ניתוח</div>${analysis.map(s => `<div class="dn-flow-analysis-row" dir="rtl">${_dnEsc(s)}</div>`).join('')}</div>`
                : '<div class="dn-flow-analysis"><div class="adv-empty">הניתוח ייטען עם קריאת התמונה…</div></div>';

            // Real news symbols: the ETF/leading stock of the top in/out sectors —
            // used to pull ACTUAL recent headlines (Finnhub/Yahoo) as live evidence.
            const newsSyms = [];
            for (const r of [...ins.slice(0, 3), ...outs.slice(0, 3)]) {
                let t = (r.tickers || []).find(x => /^[A-Z]{2,5}$/.test(x));
                if (!t) { const tops = _sectorTopStocks(r.name, r.tickers); t = tops[0]; }
                if (t && !newsSyms.includes(t)) newsSyms.push(t);
            }
            const newsBox = newsSyms.length
                ? `<div class="dn-flow-news" data-syms="${newsSyms.join(',')}"><div class="dn-flow-news-h">רקע חדשותי — נתוני אמת מהשוק</div><div class="dn-flow-news-list"><div class="adv-empty">טוען חדשות עדכניות…</div></div></div>`
                : '';
            // RIGHT column: the histogram + the asset-manager attribution below it
            // (fills the space under the bars, balancing the two column heights).
            // LEFT column: conclusion + analysis + real news.
            const rightCol = `<div class="dn-flow-bars">${insHTML}${outsHTML}${axisNote}${instHTML}</div>`;
            const sideCol = `<div class="dn-flow-side">${conc}${analHTML}${newsBox}</div>`;
            return `<div class="dn-flow-2col">${rightCol}${sideCol}</div>`;
        }
        // fall through to plain lines if parsing failed
    }

    // HEADLINES / default: clean lines; "ישראל:"/"עולם:" become section headers
    return lines.map(l => {
        const isHead = /^\*\*.+\*\*:?$/.test(l) || /^---.*---$/.test(l) || /^(ישראל|עולם|חדשות ישראל|חדשות עולם)\s*:?\s*$/.test(l.replace(/\*\*/g, ''));
        const clean = l.replace(/\*\*/g, '').replace(/^\*\s*/, '• ').replace(/^---\s*|\s*---$/g, '').replace(/^[-•]\s*/, '• ').trim();
        return `<div class="dn-vline${isHead ? ' dn-vhead' : ''}">${_dnEsc(clean)}</div>`;
    }).join('') + srcLink;
}

// ── STRUCTURED capital flows: real sector-rotation money-flow from sector-ETF performance ──
// Each sector's RELATIVE STRENGTH vs the S&P 500 over the last ~21 trading days = where money is
// actually rotating (outperformers = inflows, underperformers = outflows). Uses real daily prices
// via /api/history (Yahoo) — verified market data, not a transcribed image. Cached for the day.
const _DN_SECTOR_ETFS = [
    ['טכנולוגיה', 'XLK'], ['מוליכים למחצה', 'SOXX'], ['פיננסים', 'XLF'], ['אנרגיה', 'XLE'],
    ['בריאות', 'XLV'], ['תעשייה', 'XLI'], ['צריכה מחזורית', 'XLY'], ['צריכה בסיסית', 'XLP'],
    ['תקשורת', 'XLC'], ['חומרי גלם', 'XLB'], ['תשתיות וחשמל', 'XLU'], ['נדל"ן', 'XLRE'],
];
let _dnMarketFlowsCache = null; // { day, data }
async function _dnComputeMarketFlows() {
    const today = new Date().toISOString().slice(0, 10);
    if (_dnMarketFlowsCache && _dnMarketFlowsCache.day === today) return _dnMarketFlowsCache.data;
    if (typeof _fetchTickerTimeSeries !== 'function') return null;
    const need = ['SPY', ..._DN_SECTOR_ETFS.map(s => s[1])];
    const series = {};
    await Promise.all(need.map(async (t) => { try { series[t] = await _fetchTickerTimeSeries(t, 'USD', 400); } catch (e) { } }));
    const retOver = (pts, days) => {
        if (!pts || pts.length < days + 1) return null;
        const last = pts[pts.length - 1].close, prev = pts[pts.length - 1 - days].close;
        return (prev > 0 && last > 0) ? (last / prev - 1) : null;
    };
    const spy1m = retOver(series['SPY'], 21), spy1w = retOver(series['SPY'], 5);
    if (spy1m == null) return null;
    const rows = _DN_SECTOR_ETFS.map(([name, etf]) => {
        const r1m = retOver(series[etf], 21), r1w = retOver(series[etf], 5);
        return { name, etf, r1w, r1m, rel: (r1m != null) ? r1m - spy1m : null };
    }).filter(r => r.rel != null).sort((a, b) => b.rel - a.rel);
    const data = { rows, spy1m, spy1w, asOf: today };
    _dnMarketFlowsCache = { day: today, data };
    return data;
}
async function _dnRenderMarketFlows() {
    const box = document.getElementById('dnMarketFlows');
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    let f;
    try { f = await _dnComputeMarketFlows(); } catch (e) { box.innerHTML = ''; return; }
    if (!f || !f.rows.length) { box.innerHTML = ''; return; }
    const maxAbs = Math.max(...f.rows.map(r => Math.abs(r.rel)), 0.001);
    const ins = f.rows.filter(r => r.rel > 0);
    const outs = f.rows.filter(r => r.rel < 0).reverse();
    const pct = (x) => x == null ? '—' : ((x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
    const bar = (r) => {
        const w = Math.round(Math.abs(r.rel) / maxAbs * 100);
        const col = r.rel >= 0 ? '#22c55e' : '#ef4444';
        return `<div class="dn-mflow-row" onclick="openSectorStocks('mflow_${_dnEsc(r.etf)}')">
            <span class="dn-mflow-name">${_dnEsc(r.name)} <small>${_dnEsc(r.etf)}</small></span>
            <div class="dn-mflow-track"><span class="dn-mflow-fill" style="width:${w}%;background:${col}"></span></div>
            <span class="dn-mflow-val" style="color:${col}">${pct(r.rel)} <small>(שבוע ${pct(r.r1w)} · חודש ${pct(r.r1m)})</small></span>
        </div>`;
    };
    // Register each sector so the existing "מניות בסקטור" drill-down works on these rows too.
    window._dnFlowSectors = window._dnFlowSectors || {};
    f.rows.forEach(r => { window._dnFlowSectors['mflow_' + r.etf] = { sector: r.name, tickers: [r.etf] }; });
    box.innerHTML = `<div class="dn-mflow-card">
        <div class="dn-mflow-head">📊 תנועות הון — נתוני שוק אמיתיים (רוטציה סקטוריאלית)</div>
        <div class="dn-mflow-sub">חוזק יחסי של כל סקטור מול S&P 500 ב-21 ימי מסחר (ביצועי תעודות-הסל הסקטוריאליות — מחירי סגירה אמיתיים, מאומת). ירוק = כסף נכנס (סקטור מנצח את השוק) · אדום = יוצא.</div>
        ${ins.length ? `<div class="dn-flow-group in">▲ כניסת כסף (מנצח את השוק)</div>${ins.map(bar).join('')}` : ''}
        ${outs.length ? `<div class="dn-flow-group out">▼ יציאת כסף (חלש מהשוק)</div>${outs.map(bar).join('')}` : ''}
        <div class="dn-mflow-foot">S&P 500: ${pct(f.spy1m)} בחודש · עודכן ${f.asOf} · לחץ על סקטור לרשימת המניות</div>
    </div>`;
}

function _dnRender() {
    const data = _dnLastData;
    const tabsEl = document.getElementById('dnTabs');
    const feedEl = document.getElementById('dnFeed');
    if (!data || !tabsEl || !feedEl) return;

    const visible = data.channels.filter(c => _dnChannelKind(c.name) !== 'hidden');

    // Fixed category labels, in the user's order — no 'all' tab, no message counts
    const CAT_ORDER = ['חדשות', 'קטליסט', 'תנועות הון', 'קניות פנימיות', 'ניתוח תנועת אופציות'];
    const labelOf = _dnLabelOf;
    const ordered = visible.slice().sort((a, b) => {
        const ia = CAT_ORDER.indexOf(labelOf(a.name)), ib = CAT_ORDER.indexOf(labelOf(b.name));
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    // Everything is categorized — no merged view. Restore the LAST-VIEWED category
    // (persisted by label, so a refresh keeps you on e.g. "תנועות הון" instead of
    // bouncing back to the default "חדשות"). Falls back to the first category.
    if (_dnActiveChannel === 'all' || !ordered.some(c => c.id === _dnActiveChannel)) {
        let restored = null;
        try {
            const savedCat = localStorage.getItem('dn_active_cat');
            if (savedCat) { const m = ordered.find(c => labelOf(c.name) === savedCat); if (m) restored = m.id; }
        } catch (e) { /* ignore */ }
        _dnActiveChannel = restored || (ordered.length ? ordered[0].id : null);
    }

    tabsEl.innerHTML = ordered.map(c =>
        `<button class="dn-tab ${_dnActiveChannel === c.id ? 'active' : ''}" onclick="setDnChannel('${c.id}')">${_dnEsc(labelOf(c.name))}</button>`
    ).join('');

    const isImgUrl = (u) => /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(u) || /hcti\.io\/v1\/image\//i.test(u);
    const renderMsg = (m, chName) => {
        const d = m.ts ? new Date(m.ts) : null;
        const when = d ? `${d.toLocaleDateString('he-IL')} ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}` : '';
        const embeds = (m.embeds || []).map(e => `
            <div class="dn-embed">
                ${e.title ? `<div class="dn-embed-title">${e.url ? `<a href="${_dnEsc(e.url)}" target="_blank" rel="noopener">${_dnEsc(e.title)} ↗</a>` : _dnEsc(e.title)}</div>` : ''}
                ${e.description ? `<div class="dn-embed-desc">${_dnEsc(e.description)}</div>` : ''}
                ${(e.fields || []).map(f => `<div class="dn-embed-field"><b>${_dnEsc(f.name)}:</b> ${_dnEsc(f.value)}</div>`).join('')}
                ${e.image ? `<a href="${_dnEsc(e.image)}" target="_blank" rel="noopener"><img class="dn-img" src="${_dnEsc(e.image)}" loading="lazy" alt="" /></a>` : ''}
            </div>`).join('');
        // Agents often post chart IMAGES as bare URLs (e.g. hcti.io) — render inline
        let content = m.content || '';
        let contentImgs = '';
        if (content) {
            const urls = content.match(/https?:\/\/\S+/g) || [];
            for (const u of urls) {
                if (isImgUrl(u)) {
                    contentImgs += `<a href="${_dnEsc(u)}" target="_blank" rel="noopener"><img class="dn-img" src="${_dnEsc(u)}" loading="lazy" alt="" /></a>`;
                    content = content.replace(u, '').trim();
                }
            }
        }
        const atts = (m.attachments || []).map(a => isImgUrl(a.url) || /\.(png|jpe?g|webp|gif)$/i.test(a.name || '')
            ? `<a href="${_dnEsc(a.url)}" target="_blank" rel="noopener"><img class="dn-img" src="${_dnEsc(a.url)}" loading="lazy" alt="${_dnEsc(a.name)}" /></a>`
            : `<a class="dn-att" href="${_dnEsc(a.url)}" target="_blank" rel="noopener">📎 ${_dnEsc(a.name)}</a>`).join('');
        return `
        <div class="dn-msg">
            <div class="dn-msg-head">
                <span class="dn-author">${_dnEsc(m.author)}${m.bot ? ' <span class="dn-bot">BOT</span>' : ''}</span>
                ${chName ? `<span class="dn-ch">${_dnEsc(_dnCleanName(chName))}</span>` : ''}
                <span class="dn-when">${when}</span>
            </div>
            ${content ? `<div class="dn-content">${_dnEsc(content)}</div>` : ''}
            ${contentImgs}${embeds}${atts}
        </div>`;
    };

    // Row title for a collapsed daily post. News rows get the requested fixed title
    // "כותרות מרכזיות להיום" (todays post) / "כותרות מרכזיות" (older), flows rows get
    // a money-flow title; otherwise fall back to the message's own text.
    const headlineOf = (m, chName, kindName) => {
        const n = String(kindName || chName || '');
        if (n.includes('חדשות')) return 'חדשות הבוקר';
        if (n.includes('תנועות-הון')) return 'לאן זורם הכסף — תנועות מוסדיות';
        const t = (m.content || '').replace(/https?:\/\/\S+/g, '').trim();
        if (t) return t;
        const et = (m.embeds || []).map(e => e.title || e.description).find(Boolean);
        if (et) return et;
        return 'עדכון';
    };

    // A collapsed-by-date item: textual headline; on expand the images are READ into
    // Hebrew text (vision). Takes ALL the day's messages — agents sometimes split one
    // update (e.g. inflows / outflows / conclusion) across several posts and images.
    const _msgImgs = (m) => {
        const imgs = [];
        const urls = (m.content || '').match(/https?:\/\/\S+/g) || [];
        for (const u of urls) if (isImgUrl(u)) imgs.push(u);
        for (const e of (m.embeds || [])) if (e.image) imgs.push(e.image);
        for (const a of (m.attachments || [])) if (isImgUrl(a.url) || /\.(png|jpe?g|webp|gif)/i.test(a.name || '')) imgs.push(a.url);
        return imgs;
    };
    const renderCollapsed = (msgs, chName, open, visionMode) => {
        const m = msgs[0];
        // Oldest-first within the day so inflows render before outflows;
        // the same image often appears as both content-URL and embed — dedupe.
        const imgs = [...new Set([...msgs].reverse().flatMap(_msgImgs))];
        const body = imgs.length
            ? `<div class="dn-vision" data-imgs="${encodeURIComponent(JSON.stringify(imgs.slice(0, 6)))}" data-mode="${visionMode || 'transcribe'}"></div>`
            : '<div class="adv-empty">אין תוכן נוסף.</div>';
        const dkey = `${_dnActiveChannel}|${_dnDateOf(m)}`;
        return `
        <details class="dn-day" data-dkey="${_dnEsc(dkey)}" ${open ? 'open' : ''} ontoggle="_dnLoadVision(this)">
            <summary class="dn-day-head">
                <span class="adv-portfolio-chevron" aria-hidden="true">▾</span>
                <span class="dn-day-title">${_dnEsc(headlineOf(m, chName, visionMode === 'flows' ? 'תנועות-הון' : visionMode === 'headlines' ? 'חדשות' : ''))}</span>
                ${chName ? `<span class="dn-ch">${_dnEsc(_dnCleanName(chName))}</span>` : ''}
                <span class="dn-when">${_dnDateOf(m)}</span>
            </summary>
            <div class="dn-day-body">${body}</div>
        </details>`;
    };
    // vision mode by channel: חדשות → headlines only; תנועות-הון → structured flows
    const visionModeOf = (name) => String(name || '').includes('תנועות-הון') ? 'flows' : 'headlines';

    // Options analysis: parse the agent's rich embed into a clean VISUAL card —
    // verdict banner with score gauge, Put/Call gauges, key metrics, support/
    // resistance chips. All emojis/markdown stripped.
    const stripJunk = (s) => String(s || '')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '')
        .replace(/\*\*/g, '').replace(/[ \t]+/g, ' ').trim();
    const fieldOf = (e, key) => {
        const f = (e.fields || []).find(f => stripJunk(f.name).includes(key));
        return f ? stripJunk(f.value) : '';
    };
    const renderOption = (m) => {
        const e = (m.embeds || [])[0];
        if (!e) return m.content ? `<div class="dn-opt-line">${_dnEsc(stripJunk(m.content))}</div>` : '';

        // Header: "QQQ | $693.69 | 11/06/2026"
        const tparts = stripJunk(e.title).split('|').map(x => x.trim()).filter(Boolean);
        const ticker = tparts[0] || '', price = tparts[1] || '', tdate = tparts[2] || '';

        // Verdict + score
        const concl = fieldOf(e, 'מסקנה');
        const scoreM = concl.match(/([\d.]+)\s*\/\s*100/);
        const score = scoreM ? parseFloat(scoreM[1]) : null;
        const verdictTxt = concl.replace(/\|.*$/, '').replace(/[↘↗→➡️]+/g, '').trim();
        const dir = /ירידה/.test(concl) ? 'down' : /עלי/.test(concl) ? 'up' : 'side';
        const dirIcon = dir === 'down' ? '▼' : dir === 'up' ? '▲' : '◄►';
        const scoreColor = score == null ? '#facc15' : score >= 55 ? '#22c55e' : score >= 45 ? '#facc15' : '#ef4444';

        // Put/Call gauges (scale 0.4 → 1.6; >1 = bearish side)
        const pcGauge = (label, raw) => {
            const vM = raw.match(/([\d.]+)/);
            if (!vM) return '';
            const v = parseFloat(vM[1]);
            const pos = Math.max(0, Math.min(100, (v - 0.4) / 1.2 * 100));
            const cls = v < 0.85 ? 'bull' : v <= 1.15 ? 'neut' : 'bear';
            const tag = v < 0.85 ? 'נטייה שורית' : v <= 1.15 ? 'ניטרלי' : 'נטייה דובית';
            return `
            <div class="dn-pc-row">
                <span class="dn-pc-label">${_dnEsc(label)}</span>
                <div class="dn-pc-track"><span class="dn-pc-zones"></span><span class="dn-pc-marker ${cls}" style="right:${pos.toFixed(0)}%"></span></div>
                <span class="dn-pc-val ${cls}">${v.toFixed(2)} · ${tag}</span>
            </div>`;
        };
        const pcVol = pcGauge('Put/Call נפח מסחר', fieldOf(e, 'נפח מסחר'));
        const pcOI = pcGauge('Put/Call פוזיציות', fieldOf(e, 'פוזיציות פתוחות'));

        // Key metrics — first line only (the value), without the explainer text below it
        const firstLine = (s) => String(s).split('\n')[0].trim();
        const metric = (label, key) => {
            const v = fieldOf(e, key);
            return v ? `<div class="dn-opt-metric"><span class="dn-opt-mlabel">${label}</span><span class="dn-opt-mval">${_dnEsc(firstLine(v))}</span></div>` : '';
        };
        const metrics = [
            metric('Max Pain — נקודת משיכה', 'Max Pain'),
            metric('תנועה צפויה לפקיעה', 'תנועה צפויה'),
            metric('לחץ גידור (GEX)', 'GEX'),
            metric('לחץ כיווני (DEX)', 'DEX'),
            metric('פעילות חריגה', 'חריגה'),
        ].filter(Boolean).join('');

        // Support / resistance chips, sorted ascending
        const levels = (key, cls) => {
            const v = fieldOf(e, key);
            const nums = (v.match(/\$?([\d,]+\.?\d*)/g) || []).map(x => parseFloat(x.replace(/[$,]/g, ''))).filter(n => n > 0);
            if (!nums.length) return '';
            nums.sort((a, b) => a - b);
            return `<div class="dn-opt-levels"><span class="dn-opt-mlabel">${cls === 'sup' ? 'רמות תמיכה' : 'רמות התנגדות'}</span>
                ${nums.map(n => `<span class="dn-lvl ${cls}">$${n.toLocaleString('en-US')}</span>`).join('')}</div>`;
        };

        return `
        <div class="dn-opt-card">
            <div class="dn-opt-head">
                <span class="dn-opt-ticker">${_dnEsc(ticker)}</span>
                <span class="dn-opt-price">${_dnEsc(price)}</span>
                <span class="dn-when">${_dnEsc(tdate)}</span>
            </div>
            <div class="dn-opt-verdict" style="--vc:${scoreColor}">
                <span class="dn-opt-dir">${dirIcon}</span>
                <span class="dn-opt-vtxt">${_dnEsc(verdictTxt)}</span>
                ${score != null ? `<span class="dn-opt-score">ציון ${score.toFixed(0)}/100</span>
                <div class="dn-opt-scorebar"><div style="width:${score}%;background:${scoreColor}"></div></div>` : ''}
            </div>
            ${pcVol}${pcOI}
            <div class="dn-opt-metrics">${metrics}</div>
            ${levels('תמיכה', 'sup')}${levels('התנגדות', 'res')}
        </div>`;
    };

    // Group a channel's messages into collapsed date sections (latest date open)
    const renderByDate = (msgs, inner) => {
        const groups = new Map();
        for (const m of msgs) {
            const d = _dnDateOf(m);
            if (!groups.has(d)) groups.set(d, []);
            groups.get(d).push(m);
        }
        let first = true;
        let out = '';
        for (const [date, list] of groups) {
            out += `
            <details class="dn-day" data-dkey="${_dnEsc(`${_dnActiveChannel}|${date}`)}" ${first ? 'open' : ''}>
                <summary class="dn-day-head">
                    <span class="adv-portfolio-chevron" aria-hidden="true">▾</span>
                    <span class="dn-day-title">📅 ${_dnEsc(date)}</span>
                    <span class="dn-when">${list.length} עדכונים</span>
                </summary>
                <div class="dn-day-body">${list.map(inner).join('')}</div>
            </details>`;
            first = false;
        }
        return out || '<div class="adv-empty">אין הודעות בערוץ הזה עדיין.</div>';
    };

    // Single-category view only — every update lives under its category tab
    let html = '';
    {
        const c = data.channels.find(x => x.id === _dnActiveChannel);
        if (!c || !c.messages.length) {
            html = '<div class="adv-empty">אין הודעות בקטגוריה הזאת עדיין.</div>';
        } else {
            const kind = _dnChannelKind(c.name);
            if (kind === 'collapse') {
                // Keep only the last 3 days of updates, then ONE collapsed row per
                // DATE (latest open) — all of that day's posts merged
                const recent = _dnLastNDays(c.messages);
                const byDate = new Map();
                for (const m of recent) {
                    const d = _dnDateOf(m);
                    if (!byDate.has(d)) byDate.set(d, []);
                    byDate.get(d).push(m);
                }
                html = [...byDate.values()].map((msgs, i) => renderCollapsed(msgs, null, i === 0, visionModeOf(c.name))).join('');
                // Capital-flows channel: prepend a STRUCTURED, verified money-flow computed from
                // real sector-ETF performance (not the agent's image) — see _dnRenderMarketFlows.
                if (/תנועות-?הון/.test(c.name || '')) {
                    html = '<div id="dnMarketFlows" class="dn-mflows"><div class="adv-empty">מחשב תנועות הון מנתוני שוק אמיתיים…</div></div>' + html;
                }
            } else if (kind === 'options') {
                html = renderByDate(_dnLastNDays(c.messages), (m) => `<div class="dn-msg dn-msg-opt">${renderOption(m)}</div>`);
            } else if (_dnInsiderLabel(c.name)) {
                // Insider buys: full saved history, searchable by ticker, with a
                // technical-analysis + company-reports link on every post.
                const q = _dnInsiderQuery;
                let msgs = c.messages;
                if (q) msgs = msgs.filter(m => {
                    const tk = _dnTickerOf(m);
                    const blob = `${tk} ${m.content || ''} ${(m.embeds || []).map(e => e.title || '').join(' ')}`.toUpperCase();
                    return blob.includes(q);
                });
                const CAP = 400;
                const total = msgs.length;
                const shown = msgs.slice(0, CAP);
                const searchBox = `<div class="dn-insider-search-wrap">
                    <input id="dnInsiderSearch" class="tech-search" placeholder="חיפוש לפי טיקר (למשל: NVDA)…" value="${_dnEsc(q)}" oninput="setDnInsiderQuery(this.value)" autocomplete="off" />
                    <span class="dn-insider-count">${total} קניות פנימיות${q ? ` · סינון: ${_dnEsc(q)}` : ' · היסטוריה מלאה'}${total > CAP ? ` · מוצגות ${CAP}` : ''}</span>
                </div>`;
                const items = shown.length
                    ? shown.map(m => `<div class="dn-insider-item">${renderMsg(m, null)}${_dnInsiderLinks(_dnTickerOf(m))}</div>`).join('')
                    : `<div class="adv-empty">לא נמצאו קניות פנימיות${q ? ` עבור "${_dnEsc(q)}"` : ''}.</div>`;
                html = searchBox + items;
            } else {
                html = c.messages.map(m => renderMsg(m, null)).join('');
            }
        }
    }
    // Auto-refresh must NOT touch what the user opened/closed by hand:
    // remember each day's state before the re-render and restore it after.
    const prevState = new Map();
    feedEl.querySelectorAll('details.dn-day[data-dkey]').forEach(d => prevState.set(d.dataset.dkey, d.open));

    feedEl.innerHTML = html;
    if (document.getElementById('dnMarketFlows') && typeof _dnRenderMarketFlows === 'function') _dnRenderMarketFlows();

    if (prevState.size) {
        feedEl.querySelectorAll('details.dn-day[data-dkey]').forEach(d => {
            const was = prevState.get(d.dataset.dkey);
            if (was !== undefined && was !== d.open) d.open = was;
        });
    }

    // The open post loads itself via ontoggle; warm the rest in the background
    document.querySelectorAll('#dnFeed details.dn-day[open]').forEach(d => _dnLoadVision(d));
    _dnPrefetchVisions();
}

// For each sector, the major ETFs across DIFFERENT asset managers (real products),
// so the flows show more than just State Street. Keyed by the SPDR/primary ticker
// that appears in the data. Each links to its live fund page (performance + flows).
const SECTOR_ETF_GROUP = {
    XLK: [['XLK', 'SPDR · State Street'], ['VGT', 'Vanguard'], ['IYW', 'iShares · BlackRock'], ['FTEC', 'Fidelity']],
    XLF: [['XLF', 'SPDR · State Street'], ['VFH', 'Vanguard'], ['IYF', 'iShares · BlackRock']],
    XLV: [['XLV', 'SPDR · State Street'], ['VHT', 'Vanguard'], ['IYH', 'iShares · BlackRock']],
    XLE: [['XLE', 'SPDR · State Street'], ['VDE', 'Vanguard'], ['IYE', 'iShares · BlackRock']],
    XLY: [['XLY', 'SPDR · State Street'], ['VCR', 'Vanguard'], ['IYC', 'iShares · BlackRock']],
    XLP: [['XLP', 'SPDR · State Street'], ['VDC', 'Vanguard'], ['KXI', 'iShares · BlackRock']],
    XLI: [['XLI', 'SPDR · State Street'], ['VIS', 'Vanguard'], ['IYJ', 'iShares · BlackRock']],
    XLC: [['XLC', 'SPDR · State Street'], ['VOX', 'Vanguard'], ['IYZ', 'iShares · BlackRock']],
    XLB: [['XLB', 'SPDR · State Street'], ['VAW', 'Vanguard'], ['IYM', 'iShares · BlackRock']],
    XLU: [['XLU', 'SPDR · State Street'], ['VPU', 'Vanguard'], ['IDU', 'iShares · BlackRock']],
    XLRE: [['XLRE', 'SPDR · State Street'], ['VNQ', 'Vanguard'], ['IYR', 'iShares · BlackRock']],
    SOXX: [['SOXX', 'iShares · BlackRock'], ['SMH', 'VanEck'], ['XSD', 'SPDR · State Street'], ['FTXL', 'First Trust']],
    SMH: [['SMH', 'VanEck'], ['SOXX', 'iShares · BlackRock'], ['XSD', 'SPDR · State Street']],
    GLD: [['GLD', 'SPDR · State Street'], ['IAU', 'iShares · BlackRock'], ['SGOL', 'abrdn'], ['GLDM', 'SPDR · State Street']],
    IBIT: [['IBIT', 'iShares · BlackRock'], ['FBTC', 'Fidelity'], ['GBTC', 'Grayscale'], ['ARKB', 'ARK · 21Shares']],
    TLT: [['TLT', 'iShares · BlackRock'], ['VGLT', 'Vanguard'], ['GOVT', 'iShares · BlackRock']],
    IEF: [['IEF', 'iShares · BlackRock'], ['VGIT', 'Vanguard']],
    SHV: [['SHV', 'iShares · BlackRock'], ['BIL', 'SPDR · State Street'], ['SGOV', 'iShares · BlackRock']],
    AIQ: [['AIQ', 'Global X'], ['BOTZ', 'Global X'], ['IRBO', 'iShares · BlackRock'], ['ROBT', 'First Trust']],
    QQQ: [['QQQ', 'Invesco'], ['QQQM', 'Invesco'], ['ONEQ', 'Fidelity']],
    SPY: [['SPY', 'SPDR · State Street'], ['VOO', 'Vanguard'], ['IVV', 'iShares · BlackRock']],
};
// Lands on the ETF's Fund Flows page — etfdb (THE fund-flows database) renders the
// real net creation/redemption flow figures server-side (1-week / 1-month / etc.),
// unlike etf.com's SPA which opens on Overview. Anchored to the flows section.
const fundFlowsUrl = (t) => `https://etfdb.com/etf/${String(t).toUpperCase()}/#fund-flows`;
// The actual INSTITUTIONS holding the fund (13F filers) WITH NAMES + their recent
// buys/sells — i.e. WHO put money in (e.g. BlackRock, Morgan Stanley…). Fintel's
// per-ticker ownership page (ticker-only, no exchange guesswork; loads in-browser).
const holdersUrl = (t) => `https://fintel.io/so/us/${String(t).toLowerCase()}`;

// Authoritative source for a NAMED institutional mover (BlackRock, Vanguard, Morgan
// Stanley…): its 13F-HR filings on SEC EDGAR — the legally-filed quarterly holdings
// where its actual buys and sells are public. Company-name search, so it works for any
// manager the image names without us hard-coding CIKs.
const institutionSourceUrl = (name) => {
    const q = encodeURIComponent(String(name || '').replace(/[^\w\s&.-]/g, ' ').replace(/\s+/g, ' ').trim());
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${q}&type=13F&dateb=&owner=include&count=40`;
};

// Parse a parsed "מוסדי:" line into structured fields. Accepts, in order of richness:
//   "<גוף> | <כניסה/יציאה> | <יעד/נכס> | <היקף>"   (new, with destination)
//   "<גוף> | <כניסה/יציאה> | <היקף>"                (legacy)
//   freeform text                                    (best-effort)
// The direction and amount tokens are detected by content (not position), so a missing
// destination never shifts the amount into the wrong slot.
// True when a "destination" is just a generic asset-class word (no specific ticker) —
// such targets ("ETF", "מניות") lead nowhere, so we link to the real 13F holdings instead.
function _dnGenericDest(d) {
    return /^(etfs?|stocks?|funds?|equit(y|ies)|מניה|מניות|קרן|קרנות|תעוד(ת|ות)\s*סל|נכסים)\.?$/i.test(String(d || '').trim());
}
function _dnParseInstMover(s) {
    const parts = String(s).split('|').map(x => x.trim()).filter(Boolean);
    const name = parts[0] || String(s).trim();
    let dir = '', dest = '', amount = '';
    const hasLetters = (x) => /[A-Za-z֐-׿]/.test(x);   // Latin or Hebrew letters
    const isDir = (x) => /כניס|נכנס|יציא|יוצא|קנ|מכ(ר|ירה)|הגדל|הקטנ|inflow|outflow|buy|sell/i.test(x);
    // An amount is anything numeric: a magnitude/currency token ($, ₪, %, B/M/K, מיליארד…)
    // OR a bare number like "110.20". A destination must contain letters — so bare values
    // (State Street's 110.20 / 89.97) land in the AMOUNT column, never the destination.
    const isAmt = (x) => /\d/.test(x) && (
        /[$₪%]|[\d.](\s?)(b|m|k|bn|mn)\b|מיליארד|מיליון|מיל'|אלף/i.test(x) ||
        /^[\d.,\s]+$/.test(x)
    );
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (!dir && isDir(p)) { dir = /כניס|נכנס|קנ|הגדל|inflow|buy/i.test(p) ? 'in' : 'out'; continue; }
        if (!amount && isAmt(p)) { amount = p; continue; }
        if (hasLetters(p)) { dest = dest ? `${dest} ${p}` : p; }
        else if (!amount) { amount = p; }                        // leftover bare value → amount
    }
    return { name, dir, dest, amount };
}

// Ticker → specific sub-sector (Hebrew). Lets the "where the money went" highlight name
// the precise sub-industry (e.g. "מוליכים למחצה") instead of the broad sector
// ("טכנולוגיה"), derived ONLY from tickers the image actually listed — a factual
// classification, nothing invented.
const _DN_SUBSECTOR = {
    NVDA: 'מוליכים למחצה', AMD: 'מוליכים למחצה', AVGO: 'מוליכים למחצה', SMH: 'מוליכים למחצה',
    SOXX: 'מוליכים למחצה', TSM: 'מוליכים למחצה', MU: 'מוליכים למחצה', INTC: 'מוליכים למחצה',
    QCOM: 'מוליכים למחצה', ASML: 'ציוד לייצור שבבים', ARM: 'מוליכים למחצה',
    MSFT: 'תוכנה וענן', ORCL: 'תוכנה וענן', CRM: 'תוכנה וענן', ADBE: 'תוכנה', NOW: 'תוכנה וענן',
    PLTR: 'תוכנה / AI', SNOW: 'תוכנה ונתונים', AIQ: 'בינה מלאכותית', BOTZ: 'רובוטיקה ו-AI',
    AAPL: 'חומרה ומכשירים', GOOGL: 'אינטרנט ופרסום', GOOG: 'אינטרנט ופרסום', META: 'אינטרנט ופרסום',
    AMZN: 'מסחר אלקטרוני וענן', NFLX: 'מדיה ובידור', TSLA: 'רכב חשמלי',
    XOM: 'נפט וגז', CVX: 'נפט וגז', COP: 'נפט וגז', XLE: 'אנרגיה', OXY: 'נפט וגז',
    JPM: 'בנקים', BAC: 'בנקים', WFC: 'בנקים', GS: 'בנקאות השקעות', XLF: 'פיננסים',
    IBIT: 'קריפטו — ביטקוין', FBTC: 'קריפטו — ביטקוין', MSTR: 'קריפטו', COIN: 'קריפטו',
    TLT: 'אג"ח ממשלתי ארוך', IEF: 'אג"ח ממשלתי בינוני', SHV: 'אג"ח קצר', GOVT: 'אג"ח ממשלתי',
    GLD: 'זהב', IAU: 'זהב', SLV: 'כסף (מתכת)',
    LLY: 'פארמה', UNH: 'ביטוח בריאות', XLV: 'בריאות', NVO: 'פארמה',
};
function _dnSubSector(name, tickers) {
    for (const t of (tickers || [])) { const k = String(t).toUpperCase(); if (_DN_SUBSECTOR[k]) return _DN_SUBSECTOR[k]; }
    return '';
}

// Broad Hebrew sector → the sub-sectors that typically absorb the flow within it. Used
// to label, next to each institution, the sub-sector its money went into.
const _DN_HE_SUBSECTORS = [
    ['מוליכים למחצה', 'מוליכים למחצה'], ['שבב', 'מוליכים למחצה'], ['בינה מלאכותית', 'AI ושבבים'], [' AI', 'AI ושבבים'],
    ['טכנולוג', 'שבבים · תוכנה · ענן'], ['תוכנה', 'תוכנה וענן'], ['ענן', 'תוכנה וענן'],
    ['אנרגיה', 'נפט, גז ותשתיות'], ['נפט', 'נפט וגז'], ['גז', 'נפט וגז'],
    ['פיננס', 'בנקים וביטוח'], ['בנק', 'בנקים'], ['ביטוח', 'ביטוח'],
    ['בריאות', 'פארמה ומכשור רפואי'], ['פארמ', 'פארמה'], ['תרופ', 'פארמה'],
    ['תקשורת', 'אינטרנט ומדיה'], ['מדיה', 'מדיה ובידור'], ['אינטרנט', 'אינטרנט ופרסום'],
    ['צריכה', 'קמעונאות ומותגים'], ['קמעונ', 'קמעונאות'], ['רכב', 'רכב חשמלי'],
    ['נדל', 'קרנות REIT'], ['ריט', 'קרנות REIT'],
    ['אג"ח', 'אג"ח ממשלתי וקונצרני'], ['אגח', 'אג"ח ממשלתי וקונצרני'], ['ממשלת', 'אג"ח ממשלתי'],
    ['קריפט', 'ביטקוין ומטבעות'], ['ביטקוין', 'ביטקוין'], ['זהב', 'מתכות יקרות'],
    ['תעשי', 'מכונות ותעופה'], ['חומרי גלם', 'מתכות וכימיקלים'],
];
// Best sub-sector label for a destination string: prefer a ticker it names, else map the
// broad Hebrew sector to its representative sub-sectors. Returns '' when nothing matches.
function _dnDestSubLabel(dest) {
    if (!dest) return '';
    const s = String(dest);
    const tk = s.toUpperCase().match(/[A-Z]{2,5}/);
    if (tk) { const sub = _dnSubSector('', [tk[0]]); if (sub) return sub; }
    for (const [needle, label] of _DN_HE_SUBSECTORS) { if (s.includes(needle.trim())) return label; }
    return '';
}

// The TICKER of the central asset a flow went to. If the destination already names a
// known ticker use it; otherwise resolve the asset/sub-sector name to its representative
// ETF ticker. Returns '' only when nothing recognisable is present.
const _DN_KNOWN_TK = new Set(['SOXX', 'SMH', 'AIQ', 'IBIT', 'FBTC', 'GLD', 'SLV', 'TLT', 'IEF', 'SHV', 'SGOV', 'XLE', 'XLF', 'XLV', 'XLK', 'XLC', 'XLP', 'XLY', 'XLI', 'XLB', 'XLU', 'XLRE', 'SPY', 'VOO', 'QQQ', 'VNQ', 'BOTZ']);
const _DN_DEST_TK = [
    [/מוליכים|שבב|semicon|chips?/i, 'SOXX'],
    [/בינה\s*מלאכותית|רובוטיק|\bA\.?I\b|genai/i, 'AIQ'],
    [/ביטקוין|קריפט|bitcoin|crypto/i, 'IBIT'],
    [/זהב|gold/i, 'GLD'], [/כסף\b|silver/i, 'SLV'],
    [/אג["״']?ח\s*ממשלתי\s*ארוך|treasury\s*20|long\s*treasur/i, 'TLT'],
    [/אג["״']?ח\s*ממשלתי\s*בינוני|7-?10|intermediate\s*treasur/i, 'IEF'],
    [/אג["״']?ח\s*קצר|short\s*treasur|t-?bill/i, 'SHV'],
    [/אג["״']?ח|bond|treasur/i, 'TLT'],
    [/נפט|גז|אנרגיה|energy|oil/i, 'XLE'],
    [/בנק|פיננס|financ/i, 'XLF'],
    [/בריאות|פארמ|תרופ|health|pharma|biotech|ביוטכ/i, 'XLV'],
    [/תקשורת|communicat|מדיה|media/i, 'XLC'],
    [/צריכה\s*בסיסית|staples/i, 'XLP'],
    [/צריכה|discretionary/i, 'XLY'],
    [/תעשיי|industrial/i, 'XLI'],
    [/חומרי\s*גלם|materials/i, 'XLB'],
    [/תשתיות|utilit/i, 'XLU'],
    [/נדל|real\s*estate|reit/i, 'XLRE'],
    [/טכנולוג|tech/i, 'XLK'],
    [/s&p|מדד\s*הרחב|broad\s*market/i, 'SPY'],
];
function _dnDestTicker(dest) {
    if (!dest) return '';
    const s = String(dest);
    // A known ticker already written in the destination wins (most precise).
    for (const m of (s.toUpperCase().match(/[A-Z]{2,5}/g) || [])) { if (_DN_KNOWN_TK.has(m)) return m; }
    for (const [re, tk] of _DN_DEST_TK) { if (re.test(s)) return tk; }
    // Last resort: any uppercase token that looks like a ticker.
    const any = s.toUpperCase().match(/\b[A-Z]{2,5}\b/);
    return (any && any[0] !== 'ETF') ? any[0] : '';
}

// Convert a parsed amount string to a comparable USD magnitude (for "biggest transfer").
// Percentages return 0 — they are not a dollar size and must not win the comparison.
function _dnAmtMag(a) {
    if (!a) return 0;
    const s = String(a).trim();
    if (/%/.test(s) && !/[$₪]/.test(s)) return 0;
    const m = s.match(/([\d,.]+)\s*(b|bn|מיליארד|m|mn|מיליון|k|אלף)?/i);
    if (!m) return 0;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) return 0;
    const u = (m[2] || '').toLowerCase();
    if (/b|bn|מיליארד/.test(u)) n *= 1e9;
    else if (/m|mn|מיליון/.test(u)) n *= 1e6;
    else if (/k|אלף/.test(u)) n *= 1e3;
    return n;
}
// Format a USD magnitude back to a compact label (e.g. 4.16e9 → "4.16B").
function _dnFmtMag(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (a >= 1e6) return Math.round(n / 1e6) + 'M';
    if (a >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(Math.round(n));
}

// Factual ETF → issuer (asset manager) + official product page. Used to attribute
// each flow to the REAL institution behind it, with a verifiable source link.
const ETF_ISSUER = {
    SOXX: { issuer: 'iShares · BlackRock', url: 'https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf' },
    SMH: { issuer: 'VanEck', url: 'https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/' },
    GLD: { issuer: 'SPDR · State Street', url: 'https://www.spdrgoldshares.com/' },
    QQQ: { issuer: 'Invesco', url: 'https://www.invesco.com/qqq-etf/en/home.html' },
    SPY: { issuer: 'SPDR · State Street', url: 'https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy' },
    IBIT: { issuer: 'iShares · BlackRock', url: 'https://www.ishares.com/us/products/333011/ishares-bitcoin-trust' },
    TLT: { issuer: 'iShares · BlackRock', url: 'https://www.ishares.com/us/products/239454/' },
    IEF: { issuer: 'iShares · BlackRock', url: 'https://www.ishares.com/us/products/239456/' },
    SHV: { issuer: 'iShares · BlackRock', url: 'https://www.ishares.com/us/products/239466/' },
    AIQ: { issuer: 'Global X', url: 'https://www.globalxetfs.com/funds/aiq/' },
    XLF: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlf' },
    XLV: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlv' },
    XLE: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xle' },
    XLK: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlk' },
    XLI: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xli' },
    XLP: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlp' },
    XLY: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xly' },
    XLC: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlc' },
    XLB: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlb' },
    XLU: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlu' },
    XLRE: { issuer: 'SPDR Select Sector · State Street', url: 'https://www.sectorspdrs.com/mainfund/xlre' },
};

// Largest real constituents per sector (top names in each sector's leading ETF),
// keyed by the ETF ticker and by the Hebrew sector keyword. Used to enrich the
// stock list beyond the single ETF the image lists.
const SECTOR_TOP_STOCKS = {
    XLK: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL'],
    XLV: ['LLY', 'UNH', 'JNJ', 'MRK', 'ABBV'],
    XLF: ['BRK-B', 'JPM', 'V', 'MA', 'BAC'],
    XLE: ['XOM', 'CVX', 'COP', 'EOG', 'SLB'],
    XLY: ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE'],
    XLP: ['PG', 'COST', 'KO', 'WMT', 'PEP'],
    XLI: ['GE', 'CAT', 'RTX', 'HON', 'UNP'],
    XLC: ['META', 'GOOGL', 'NFLX', 'DIS', 'TMUS'],
    XLB: ['LIN', 'SHW', 'FCX', 'ECL', 'NEM'],
    XLU: ['NEE', 'SO', 'DUK', 'CEG', 'AEP'],
    XLRE: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG'],
    SOXX: ['NVDA', 'AVGO', 'AMD', 'TSM', 'ASML', 'QCOM', 'MU', 'LRCX', 'AMAT', 'ARM'],
    SMH: ['NVDA', 'TSM', 'AVGO', 'AMD', 'ASML', 'QCOM', 'MU', 'INTC', 'AMAT', 'KLAC'],
    AIQ: ['NVDA', 'MSFT', 'GOOGL', 'META', 'AVGO', 'PLTR', 'AMD', 'CRM'],
    CRYPTO: ['COIN', 'MARA', 'RIOT', 'MSTR', 'CLSK', 'HOOD'],
};
const SECTOR_HE_TO_ETF = [
    // Crypto FIRST — so "תשתיות קריפטו" (crypto infra) doesn't fall into the תשתיות=utilities rule.
    [/קריפטו|crypto|ביטקוין|bitcoin|בלוקצ|blockchain|מטבעות?\s*דיגיטל|כריית/i, 'CRYPTO'],
    [/שבב|מוליכים\s*למחצה|מוליכ|סמיקונדקטור|semicon/i, 'SOXX'],
    [/בינה\s*מלאכותית|\bai\b|genai|רובוטיק/i, 'AIQ'],
    [/בריאות|פארמה|תרופ/i, 'XLV'],
    [/ביוטכ|biotech/i, 'XLV'],
    [/פיננס|בנק|ביטוח/i, 'XLF'],
    [/אנרגי|נפט|גז/i, 'XLE'],
    [/טכנולוגי|tech/i, 'XLK'],
    [/בינה מלאכותית|\bai\b|genai/i, 'XLK'],
    [/צרכנות בסיסית|staples/i, 'XLP'],
    [/צרכנות מחזורית|צרכנות|discretionary/i, 'XLY'],
    [/תעשיי|industrial/i, 'XLI'],
    [/תקשורת|communication/i, 'XLC'],
    [/חומרי גלם|materials/i, 'XLB'],
    [/תשתיות|utilit/i, 'XLU'],
    [/נדל|real estate/i, 'XLRE'],
];
function _sectorTopStocks(sectorName, tickers) {
    // Prefer the ETF ticker present in the row; else map the Hebrew sector name
    let etf = (tickers || []).find(t => SECTOR_TOP_STOCKS[t.toUpperCase()]);
    if (!etf) { const hit = SECTOR_HE_TO_ETF.find(([re]) => re.test(sectorName || '')); if (hit) etf = hit[1]; }
    return etf ? (SECTOR_TOP_STOCKS[etf.toUpperCase()] || []) : [];
}

// ── Sector stock-list popup: GF links + CML/SML compliance + buy into a portfolio ──
function openSectorStocks(sid, _skipEnsure) {
    const data = (window._dnFlowSectors || {})[sid];
    if (!data) return;
    // Merge the image's tickers (ETF) with the sector's largest real constituents
    const etfTickers = (data.tickers || []).map(t => t.toUpperCase());
    const tops = _sectorTopStocks(data.sector, etfTickers);
    const allTickers = [...new Set([...etfTickers, ...tops])];
    const sectorName = data.sector;
    const model = window._lastRiskModel;
    const recOf = (t) => {
        const a = model && model.assets ? model.assets[t.toUpperCase()] : null;
        if (!a || !a.hasData || a.recommendation === 'unknown') return { label: 'ממתין לסריקת המודל', color: '#94a3b8' };
        const label = (typeof rmRecLabel === 'function') ? rmRecLabel(a.recommendation) : a.recommendation;
        const color = (typeof rmRecColor === 'function') ? rmRecColor(a.recommendation) : '#64748b';
        const tip = `β=${a.beta != null ? a.beta.toFixed(2) : '—'} · α=${a.alpha != null ? (a.alpha * 100).toFixed(1) + '%' : '—'}`;
        return { label: label + (a.recommendation === 'buy' ? ' (עומד ב-SML)' : a.recommendation === 'avoid' ? ' (מתחת ל-SML)' : ''), color, tip };
    };
    const gf = (t) => (typeof googleFinanceUrl === 'function') ? googleFinanceUrl(t) : `https://www.google.com/search?q=${encodeURIComponent(t + ' stock')}`;

    const isEtf = (t) => etfTickers.includes(t);
    const rows = allTickers.map(t => {
        const r = recOf(t);
        const tag = isEtf(t) ? ' <span class="secst-etf-tag">תעודת סל</span>' : '';
        return `
        <div class="secst-row">
            <span class="secst-tk">${_dnEsc(t)}</span>
            <span class="secst-rec" style="--rc:${r.color}" title="${r.tip || ''}">${_dnEsc(r.label)}${tag}</span>
            <a class="secst-gf" href="${gf(t)}" target="_blank" rel="noopener">Google Finance ↗</a>
            <button class="secst-buy" onclick="_sectorBuyPick('${_dnEsc(t)}', this)">קנה לתיק ▾</button>
        </div>`;
    }).join('');

    let ov = document.getElementById('secStockOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'secStockOverlay';
        ov.className = 'chart-info-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('active'); });
        document.body.appendChild(ov);
    }
    ov.innerHTML = `
        <div class="chart-info-dialog" dir="rtl">
            <div class="chart-info-head">
                <h3>מניות בסקטור: ${_dnEsc(sectorName)}</h3>
                <button class="chart-info-close" onclick="document.getElementById('secStockOverlay').classList.remove('active')">&times;</button>
            </div>
            <div class="chart-info-body">
                <p style="margin-bottom:10px">תעודת הסל של הסקטור לצד המניות הגדולות בו. לחץ על Google Finance לבדיקה, או "קנה לתיק" להוספה לאחד התיקים. הסימון מציין אם המנייה עומדת במודל ה-CML/SML.</p>
                <div class="secst-list">${rows}</div>
            </div>
        </div>`;
    ov.classList.add('active');

    // If the model is missing a verdict for any displayed ticker, build/refresh it in the
    // background (histories are cached, so it's fast on repeat) and re-render once — so the
    // "ממתין לסריקת המודל" rows resolve to a real, accurate CML/SML verdict.
    if (!_skipEnsure) _ensureSectorModel(allTickers, sid);
}

let _secModelEnsuring = false;
async function _ensureSectorModel(tickers, sid) {
    if (_secModelEnsuring) return;
    const m = window._lastRiskModel;
    const missing = tickers.some(t => {
        const a = m && m.assets ? m.assets[t.toUpperCase()] : null;
        return !(a && a.hasData);
    });
    if (!missing || typeof buildRiskModel !== 'function' || typeof clients === 'undefined') return;
    _secModelEnsuring = true;
    try {
        await buildRiskModel(clients);
        const ov = document.getElementById('secStockOverlay');
        if (ov && ov.classList.contains('active')) openSectorStocks(sid, true); // re-render, no re-ensure
    } catch (e) { /* keep the "ממתין" labels */ }
    finally { _secModelEnsuring = false; }
}

// Reveal an inline portfolio picker under the clicked stock's buy button: up to 5
// portfolios, plus a button that expands to the FULL searchable client list.
function _sectorBuyPick(ticker, btn) {
    const existing = btn.parentElement.querySelector('.secst-pick');
    if (existing) { existing.remove(); return; }
    const list = (typeof clients !== 'undefined' ? clients : []);
    if (!list.length) return;
    const opts = list.slice(0, 5).map(c => `<button class="secst-pick-opt" onclick="_sectorBuy('${ticker}', ${c.id})">${(c.name || '').replace(/"/g, '')}</button>`).join('');
    const more = list.length > 5
        ? `<button class="secst-pick-more" onclick="_sectorBuyPickAll('${ticker}', this)">רשימת התיקים המלאה (${list.length}) ↗</button>` : '';
    const box = document.createElement('div');
    box.className = 'secst-pick';
    box.innerHTML = `<div class="secst-pick-h">בחר תיק לקנייה:</div>${opts}${more}`;
    btn.parentElement.appendChild(box);
}
function _secPickRows(ticker, list) {
    return list.length
        ? list.map(c => `<button class="secst-pick-opt" onclick="_sectorBuy('${ticker}', ${c.id})">${(c.name || '').replace(/"/g, '')}</button>`).join('')
        : '<div class="adv-empty" style="padding:6px">לא נמצאו תיקים</div>';
}
// Open the FULL client list in its own modal window (scales to 100s of portfolios),
// with a search box. Separate overlay so the sector popup stays put behind it.
function _sectorBuyPickAll(ticker, btn) {
    const inline = btn && btn.closest('.secst-pick'); if (inline) inline.remove();
    let ov = document.getElementById('secPickAllOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'secPickAllOverlay';
        ov.className = 'chart-info-overlay';
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('active'); });
        document.body.appendChild(ov);
    }
    const list = (typeof clients !== 'undefined' ? clients : []);
    ov.innerHTML = `
        <div class="chart-info-dialog secpick-dialog" dir="rtl">
            <div class="chart-info-head">
                <h3>בחר תיק לקנייה — ${_dnEsc(ticker)}</h3>
                <button class="chart-info-close" onclick="document.getElementById('secPickAllOverlay').classList.remove('active')">&times;</button>
            </div>
            <div class="chart-info-body">
                <input class="secpick-search" type="text" placeholder="חיפוש שם תיק לקוח…" oninput="_sectorBuyPickFilter('${ticker}', this)" />
                <div class="secpick-count" id="secPickAllCount">${list.length} תיקים</div>
                <div class="secpick-results" id="secPickAllResults">${_secPickAllRows(ticker, list)}</div>
            </div>
        </div>`;
    ov.classList.add('active');
    const inp = ov.querySelector('.secpick-search'); if (inp) setTimeout(() => inp.focus(), 60);
}
function _secPickAllRows(ticker, list) {
    return list.length
        ? list.map(c => `<button class="secpick-row" onclick="_secPickAllBuy('${ticker}', ${c.id})">${(c.name || '').replace(/"/g, '')}</button>`).join('')
        : '<div class="adv-empty" style="padding:16px">לא נמצאו תיקים</div>';
}
function _sectorBuyPickFilter(ticker, inp) {
    const q = inp.value.trim().toLowerCase();
    const list = (typeof clients !== 'undefined' ? clients : []).filter(c => (c.name || '').toLowerCase().includes(q));
    const res = document.getElementById('secPickAllResults');
    const cnt = document.getElementById('secPickAllCount');
    if (res) res.innerHTML = _secPickAllRows(ticker, list);
    if (cnt) cnt.textContent = `${list.length} תיקים`;
}
function _secPickAllBuy(ticker, clientId) {
    document.getElementById('secPickAllOverlay')?.classList.remove('active');
    _sectorBuy(ticker, clientId);
}

async function _sectorBuy(ticker, clientId) {
    const client = (typeof clients !== 'undefined' ? clients : []).find(c => c.id === clientId);
    if (!client) return;
    document.getElementById('secStockOverlay')?.classList.remove('active');
    // Pre-fetch a live price so the buy modal opens ready to confirm
    let price = 0;
    try {
        const r = await fetch(`/api/quote?symbols=${encodeURIComponent(ticker)}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (j && j[ticker] && j[ticker].price > 0) price = j[ticker].price;
    } catch (e) { /* user can type it */ }
    if (typeof openModal === 'function') openModal(clientId);
    setTimeout(() => {
        if (typeof openMgmtModal === 'function') {
            openMgmtModal('buyHolding', { client, holding: { ticker, name: ticker, type: 'stock', currency: 'USD', price } });
        }
    }, 120);
}

// Fetch REAL recent headlines for the flow's leading sectors and render them as
// live supporting evidence under the analysis. Source: /api/news (Finnhub→Yahoo),
// already translated to Hebrew — no fabricated content.
async function _dnFillFlowsNews(scope) {
    const root = scope || document;
    const box = root.querySelector('.dn-flow-news[data-syms]');
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const list = box.querySelector('.dn-flow-news-list');
    const syms = (box.dataset.syms || '').split(',').filter(Boolean);
    const _ph = (msg) => { if (list) list.innerHTML = `<div class="adv-empty">${_dnEsc(msg)}</div>`; };
    if (!syms.length) { _ph('סורק חדשות לסקטורים שבתנועה…'); return; }
    try {
        // Hourly bucket → the edge runs a fresh scan every hour, so the headlines update
        // through the day instead of being frozen for the session.
        const bucket = Math.floor(Date.now() / 3600000);
        const r = await fetch(`/api/news?symbols=${encodeURIComponent(syms.join(','))}&b=${bucket}&tr=2`, { headers: { Accept: 'application/json' } });
        const data = await r.json();
        // Headlines for the sectors that moved. PREFER ones that name the sector's stock
        // (ticker/alias/CEO); if too few pass, top up with the latest sector headlines so
        // this box ALWAYS shows live news tied to the capital flows — never empties.
        const relevant = [], fallback = [];
        const seen = new Set();
        const _rel = (typeof _newsIsRelevant === 'function' && typeof _newsMatchTerms === 'function');
        for (const s of syms) {
            const terms = _rel ? _newsMatchTerms(s, null) : null;
            for (const n of (data[s] || [])) {
                const t = (n.he || n.en || '').trim();
                if (!t || seen.has(t)) continue;
                seen.add(t);
                const item = { t, sym: s, date: n.date || '', url: n.url || '', source: n.source || '' };
                if (_rel && terms && _newsIsRelevant(n, terms)) relevant.push(item);
                else fallback.push(item);
            }
        }
        const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
        relevant.sort(byDate); fallback.sort(byDate);
        let top = relevant.slice(0, 5);
        if (top.length < 3) top = top.concat(fallback.slice(0, 5 - top.length));
        if (!top.length) { _ph('סורק חדשות עדכניות לסקטורים שבתנועה…'); return; }
        if (list) list.innerHTML = top.map(n => `
            <a class="dn-flow-news-item" href="${_dnEsc(n.url)}" target="_blank" rel="noopener" dir="rtl">
                <span class="dn-flow-news-txt">${_dnEsc(n.t)}</span>
                <span class="dn-flow-news-meta">${_dnEsc(n.sym)}${n.source ? ' · ' + _dnEsc(n.source) : ''}${n.date ? ' · ' + _dnEsc(n.date) : ''}</span>
            </a>`).join('');
    } catch (e) {
        _ph('לא ניתן לטעון חדשות כרגע — ננסה שוב.');
    }
}

if (typeof window !== 'undefined') {
    window.openDiscordNews = openDiscordNews;
    window.closeDiscordNews = closeDiscordNews;
    window.setDnChannel = setDnChannel;
    window.openSectorStocks = openSectorStocks;
    window._sectorBuyPick = _sectorBuyPick;
    window._sectorBuyPickAll = _sectorBuyPickAll;
    window._sectorBuyPickFilter = _sectorBuyPickFilter;
    window._secPickAllBuy = _secPickAllBuy;
    window._sectorBuy = _sectorBuy;
}
