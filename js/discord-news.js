// ========== DISCORD NEWS PAGE — חדשות כלכלה ושוק ההון ==========
//
// A dedicated page (sidebar) streaming the user's Discord server (where agents
// post market updates) into the platform, grouped by channel. While the page is
// open it polls /api/discord every 20s — a new Discord message shows up here
// within seconds.

let _dnTimer = null;
let _dnActiveChannel = 'all';
let _dnLastData = null;

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
        _dnLastData = data;
        _dnRender();
        const live = document.getElementById('dnLive');
        if (live) live.classList.add('on');
    } catch (e) {
        if (!silent && feedEl) feedEl.innerHTML = '<div class="adv-empty">שגיאה בטעינת הפיד — ננסה שוב אוטומטית.</div>';
    }
}

function setDnChannel(id) {
    _dnActiveChannel = id;
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
    // v5: flows prompt now returns clean sectors + tickers + analysis + catalysts
    const cacheKey = 'dn_vision5_' + mode + '_' + (img.split('?')[0].split('/').slice(-2).join('_'));
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) return cached;
    } catch (e) { /* ignore */ }
    if (_dnVisionInflight[cacheKey]) return _dnVisionInflight[cacheKey];
    _dnVisionInflight[cacheKey] = (async () => {
        try {
            const res = await fetch(`/api/vision?img=${encodeURIComponent(img)}&mode=${mode}&pv=5`, { headers: { Accept: 'application/json' } });
            const j = await res.json();
            if (j && j.text) {
                try { localStorage.setItem(cacheKey, j.text); } catch (e) { /* full */ }
                return j.text;
            }
            return null;
        } catch (e) {
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
        if (mode === 'flows') _dnFillFlowsNews(box); // pull real headlines for the side
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
            const mS = l.match(/^סקטור\s*:\s*(.+?)\s*\|\s*כיוון\s*:\s*(.+?)\s*\|\s*היקף\s*:\s*(.+)$/);
            if (mS) {
                const amount = mS[3].trim();
                if (!amount.includes('%')) continue; // percentages only — no $B ETF rows
                // Split a sector label into a clean name + the tickers in its parens.
                // "מניות בולטות (NVDA, AMD, AVGO)" → base="מניות בולטות", tickers=[NVDA,AMD,AVGO]
                const raw = mS[1].trim();
                let base = raw, tickers = [];
                const pm = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
                if (pm) {
                    const inside = pm[2].split(/[,\s]+/).map(t => t.replace(/[^A-Za-z.]/g, '').toUpperCase())
                        .filter(t => /^[A-Z]{1,5}(\.[A-Z]+)?$/.test(t));
                    if (inside.length) { tickers = inside; base = (pm[1].trim() || raw); }
                }
                rows.push({
                    name: base, tickers,
                    inflow: /כניס/.test(mS[2]),
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
            const instHTML = institutions.length
                ? `<div class="dn-flow-inst"><div class="dn-flow-inst-h">גופים מוסדיים בולטים</div>${institutions.map(s => `<div class="dn-flow-inst-row" dir="rtl">${_dnEsc(s)}</div>`).join('')}</div>`
                : '';
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
            const sideCol = `<div class="dn-flow-side">${conc}${analHTML}${newsBox}${instHTML}</div>`;

            return `<div class="dn-flow-2col">${barsCol}${sideCol}</div>`;
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

function _dnRender() {
    const data = _dnLastData;
    const tabsEl = document.getElementById('dnTabs');
    const feedEl = document.getElementById('dnFeed');
    if (!data || !tabsEl || !feedEl) return;

    const visible = data.channels.filter(c => _dnChannelKind(c.name) !== 'hidden');

    // Fixed category labels, in the user's order — no 'all' tab, no message counts
    const CAT_ORDER = ['חדשות', 'קטליסט', 'תנועות הון', 'קניות פנימיות', 'ניתוח תנועת אופציות'];
    const labelOf = (name) => {
        const n = String(name || '');
        if (n.includes('חדשות')) return 'חדשות';
        if (n.includes('קטליסט')) return 'קטליסט';
        if (n.includes('תנועות-הון')) return 'תנועות הון';
        if (n.includes('קניות-פנימיות')) return 'קניות פנימיות';
        if (n.includes('אופציות')) return 'ניתוח תנועת אופציות';
        return _dnCleanName(n);
    };
    const ordered = visible.slice().sort((a, b) => {
        const ia = CAT_ORDER.indexOf(labelOf(a.name)), ib = CAT_ORDER.indexOf(labelOf(b.name));
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    // Everything is categorized — no merged view. Default to the first category.
    if (_dnActiveChannel === 'all' || !ordered.some(c => c.id === _dnActiveChannel)) {
        _dnActiveChannel = ordered.length ? ordered[0].id : null;
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
            } else if (kind === 'options') {
                html = renderByDate(_dnLastNDays(c.messages), (m) => `<div class="dn-msg dn-msg-opt">${renderOption(m)}</div>`);
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

// Largest real constituents per sector (top names in each sector's leading ETF),
// keyed by the ETF ticker and by the Hebrew sector keyword. Used to enrich the
// stock list beyond the single ETF the image lists.
const SECTOR_TOP_STOCKS = {
    XLK: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL'],
    XLV: ['LLY', 'UNH', 'JNJ', 'MRK', 'ABBV'],
    XLF: ['BRK.B', 'JPM', 'V', 'MA', 'BAC'],
    XLE: ['XOM', 'CVX', 'COP', 'EOG', 'SLB'],
    XLY: ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE'],
    XLP: ['PG', 'COST', 'KO', 'WMT', 'PEP'],
    XLI: ['GE', 'CAT', 'RTX', 'HON', 'UNP'],
    XLC: ['META', 'GOOGL', 'NFLX', 'DIS', 'TMUS'],
    XLB: ['LIN', 'SHW', 'FCX', 'ECL', 'NEM'],
    XLU: ['NEE', 'SO', 'DUK', 'CEG', 'AEP'],
    XLRE: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG'],
    SOXX: ['NVDA', 'AVGO', 'AMD', 'TSM', 'ASML'],
    SMH: ['NVDA', 'TSM', 'AVGO', 'AMD', 'ASML'],
};
const SECTOR_HE_TO_ETF = [
    [/שבב|סמיקונדקטור|semicon/i, 'SOXX'],
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
function openSectorStocks(sid) {
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
        if (!a || !a.hasData || a.recommendation === 'unknown') return { label: 'לא נסרק במודל', color: '#64748b' };
        const label = (typeof rmRecLabel === 'function') ? rmRecLabel(a.recommendation) : a.recommendation;
        const color = (typeof rmRecColor === 'function') ? rmRecColor(a.recommendation) : '#64748b';
        const tip = `β=${a.beta != null ? a.beta.toFixed(2) : '—'} · α=${a.alpha != null ? (a.alpha * 100).toFixed(1) + '%' : '—'}`;
        return { label: label + (a.recommendation === 'buy' ? ' (עומד ב-SML)' : a.recommendation === 'avoid' ? ' (מתחת ל-SML)' : ''), color, tip };
    };
    const gf = (t) => (typeof googleFinanceUrl === 'function') ? googleFinanceUrl(t) : `https://www.google.com/search?q=${encodeURIComponent(t + ' stock')}`;

    const isEtf = (t) => etfTickers.includes(t);
    const rows = allTickers.map(t => {
        const r = recOf(t);
        const tag = isEtf(t) ? '<span class="secst-etf-tag">תעודת סל</span>' : '';
        return `
        <div class="secst-row">
            <span class="secst-tk">${_dnEsc(t)}${tag}</span>
            <span class="secst-rec" style="--rc:${r.color}" title="${r.tip || ''}">${_dnEsc(r.label)}</span>
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
}

// Reveal an inline portfolio picker under the clicked stock's buy button.
function _sectorBuyPick(ticker, btn) {
    const existing = btn.parentElement.querySelector('.secst-pick');
    if (existing) { existing.remove(); return; }
    const list = (typeof clients !== 'undefined' ? clients : []);
    if (!list.length) return;
    const opts = list.map(c => `<button class="secst-pick-opt" onclick="_sectorBuy('${ticker}', ${c.id})">${(c.name || '').replace(/"/g, '')}</button>`).join('');
    const box = document.createElement('div');
    box.className = 'secst-pick';
    box.innerHTML = `<div class="secst-pick-h">בחר תיק לקנייה:</div>${opts}`;
    btn.parentElement.appendChild(box);
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
    if (!syms.length) { box.remove(); return; }
    try {
        const r = await fetch(`/api/news?symbols=${encodeURIComponent(syms.join(','))}`, { headers: { Accept: 'application/json' } });
        const data = await r.json();
        // Flatten to the most recent headlines across the sectors, dedup by title
        const items = [];
        const seen = new Set();
        for (const s of syms) {
            for (const n of (data[s] || [])) {
                const t = (n.he || n.en || '').trim();
                if (!t || seen.has(t)) continue;
                seen.add(t);
                items.push({ t, sym: s, date: n.date || '', url: n.url || '', source: n.source || '' });
            }
        }
        items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const top = items.slice(0, 5);
        if (!top.length) { box.remove(); return; }
        if (list) list.innerHTML = top.map(n => `
            <a class="dn-flow-news-item" href="${_dnEsc(n.url)}" target="_blank" rel="noopener" dir="rtl">
                <span class="dn-flow-news-txt">${_dnEsc(n.t)}</span>
                <span class="dn-flow-news-meta">${_dnEsc(n.sym)}${n.source ? ' · ' + _dnEsc(n.source) : ''}${n.date ? ' · ' + _dnEsc(n.date) : ''}</span>
            </a>`).join('');
    } catch (e) {
        box.remove();
    }
}

if (typeof window !== 'undefined') {
    window.openDiscordNews = openDiscordNews;
    window.closeDiscordNews = closeDiscordNews;
    window.setDnChannel = setDnChannel;
    window.openSectorStocks = openSectorStocks;
    window._sectorBuyPick = _sectorBuyPick;
    window._sectorBuy = _sectorBuy;
}
