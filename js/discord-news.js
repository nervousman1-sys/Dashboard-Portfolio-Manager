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
async function _dnLoadVision(det) {
    if (!det || !det.open) return;
    const box = det.querySelector('.dn-vision');
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const img = box.dataset.img, mode = box.dataset.mode || 'transcribe';
    const cacheKey = 'dn_vision_' + mode + '_' + (img.split('?')[0].split('/').slice(-2).join('_'));
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) { box.innerHTML = _dnVisionHTML(cached, img, mode); return; }
    } catch (e) { /* ignore */ }
    box.innerHTML = '<div class="adv-empty">קורא את התוכן מהתמונה…</div>';
    try {
        const res = await fetch(`/api/vision?img=${encodeURIComponent(img)}&mode=${mode}`, { headers: { Accept: 'application/json' } });
        const j = await res.json();
        if (j && j.text) {
            try { localStorage.setItem(cacheKey, j.text); } catch (e) { /* full */ }
            box.innerHTML = _dnVisionHTML(j.text, img, mode);
        } else if (j && j.error === 'not_configured') {
            box.innerHTML = `<div class="adv-empty">תמלול אוטומטי טרם הוגדר (GEMINI_API_KEY).</div>
                <a href="${_dnEsc(img)}" target="_blank" rel="noopener"><img class="dn-img" src="${_dnEsc(img)}" loading="lazy" alt="" /></a>`;
        } else {
            throw new Error((j && j.message) || 'vision failed');
        }
    } catch (e) {
        box.dataset.loaded = '';
        box.innerHTML = `<div class="adv-empty">לא הצלחנו לקרוא את התמונה כרגע — <a href="${_dnEsc(img)}" target="_blank" rel="noopener" style="color:var(--accent-blue)">פתח את התמונה</a></div>`;
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
        for (const l of lines) {
            const mC = l.match(/^מסקנה\s*:\s*(.+)$/);
            if (mC) { conclusion = mC[1].trim(); continue; }
            const mS = l.match(/^סקטור\s*:\s*(.+?)\s*\|\s*כיוון\s*:\s*(.+?)\s*\|\s*היקף\s*:\s*(.+)$/);
            if (mS) {
                const amount = mS[3].trim();
                rows.push({
                    name: mS[1].trim(),
                    inflow: /כניס/.test(mS[2]),
                    amount,
                    mag: Math.abs(parseFloat(String(amount).replace(/[^\d.\-]/g, ''))) || 0,
                });
            }
        }
        if (rows.length) {
            // Adaptive proportional scale: the axis follows the LARGEST move in the
            // list, rounded up to the next 5% step (16%→20, 22%→25, 38%→40). Never a
            // fixed cap — bigger data automatically widens the axis.
            const maxN = Math.max(...rows.map(r => r.mag), 0.001);
            let axisMax = Math.max(5, Math.ceil(maxN / 5) * 5);
            if (axisMax - maxN < maxN * 0.05) axisMax += 5; // keep a sliver of headroom
            const bar = (r) => `
                <div class="dn-flow-row">
                    <span class="dn-flow-name">${_dnEsc(r.name)}</span>
                    <div class="dn-flow-track"><div class="dn-flow-bar ${r.inflow ? 'in' : 'out'}" style="width:${Math.max(4, r.mag / axisMax * 100).toFixed(1)}%"></div></div>
                    <span class="dn-flow-amt ${r.inflow ? 'in' : 'out'}">${_dnEsc(r.amount)}</span>
                </div>`;
            const axisNote = `<div class="dn-flow-axis">סקאלה: 0% – ${axisMax}%</div>`;
            const ins = rows.filter(r => r.inflow).sort((a, b) => b.mag - a.mag);
            const outs = rows.filter(r => !r.inflow).sort((a, b) => b.mag - a.mag);
            const insHTML = ins.length ? `<div class="dn-flow-group in">▲ כניסת כסף</div>${ins.map(bar).join('')}` : '';
            const outsHTML = outs.length ? `<div class="dn-flow-group out">▼ יציאת כסף</div>${outs.map(bar).join('')}` : '';
            const conc = conclusion ? `<div class="dn-flow-conc"><b>לאן זורם הכסף:</b> ${_dnEsc(conclusion)}</div>` : '';
            return `${insHTML}${outsHTML}${axisNote}${conc}`;
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

    // A collapsed-by-date item: textual headline; on expand the image is READ into
    // Hebrew text (vision) — transcription for חדשות, short summary for תנועות-הון.
    const renderCollapsed = (m, chName, open, visionMode) => {
        const imgs = [];
        const urls = (m.content || '').match(/https?:\/\/\S+/g) || [];
        for (const u of urls) if (isImgUrl(u)) imgs.push(u);
        for (const e of (m.embeds || [])) if (e.image) imgs.push(e.image);
        for (const a of (m.attachments || [])) if (isImgUrl(a.url) || /\.(png|jpe?g|webp|gif)/i.test(a.name || '')) imgs.push(a.url);
        const body = imgs.length
            ? `<div class="dn-vision" data-img="${_dnEsc(imgs[0])}" data-mode="${visionMode || 'transcribe'}"></div>`
            : '<div class="adv-empty">אין תוכן נוסף.</div>';
        return `
        <details class="dn-day" ${open ? 'open' : ''} ontoggle="_dnLoadVision(this)">
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
            <details class="dn-day" ${first ? 'open' : ''}>
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
                // Each daily post = its own date-collapsed headline (latest open)
                html = c.messages.map((m, i) => renderCollapsed(m, null, i === 0, visionModeOf(c.name))).join('');
            } else if (kind === 'options') {
                html = renderByDate(c.messages, (m) => `<div class="dn-msg dn-msg-opt">${renderOption(m)}</div>`);
            } else {
                html = c.messages.map(m => renderMsg(m, null)).join('');
            }
        }
    }
    feedEl.innerHTML = html;
}

if (typeof window !== 'undefined') {
    window.openDiscordNews = openDiscordNews;
    window.closeDiscordNews = closeDiscordNews;
    window.setDnChannel = setDnChannel;
}
