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
        if (cached) { box.innerHTML = _dnVisionHTML(cached, img); return; }
    } catch (e) { /* ignore */ }
    box.innerHTML = '<div class="adv-empty">קורא את התוכן מהתמונה…</div>';
    try {
        const res = await fetch(`/api/vision?img=${encodeURIComponent(img)}&mode=${mode}`, { headers: { Accept: 'application/json' } });
        const j = await res.json();
        if (j && j.text) {
            try { localStorage.setItem(cacheKey, j.text); } catch (e) { /* full */ }
            box.innerHTML = _dnVisionHTML(j.text, img);
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

function _dnVisionHTML(text, img) {
    const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
    return lines.map(l => {
        // Strip markdown markers; render **headers** / --- sections --- as emphasized lines
        const isHead = /^\*\*.+\*\*:?$/.test(l) || /^---.*---$/.test(l);
        const clean = l.replace(/\*\*/g, '').replace(/^\*\s*/, '• ').replace(/^---\s*|\s*---$/g, '').trim();
        return `<div class="dn-vline${isHead ? ' dn-vhead' : ''}">${_dnEsc(clean)}</div>`;
    }).join('')
        + `<a class="dn-att" href="${_dnEsc(img)}" target="_blank" rel="noopener">🖼 פתח את התמונה המקורית</a>`;
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

    // Headline line for an image-only daily post (the text headline replaces the image)
    const headlineOf = (m, chName) => {
        const t = (m.content || '').replace(/https?:\/\/\S+/g, '').trim();
        if (t) return t;
        const et = (m.embeds || []).map(e => e.title || e.description).find(Boolean);
        if (et) return et;
        return chName ? `עדכון ${chName.replace(/-/g, ' ').replace(/[^֐-׿\w ]/g, '').trim()}` : 'עדכון';
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
                <span class="dn-day-title">${_dnEsc(headlineOf(m, chName))}</span>
                ${chName ? `<span class="dn-ch">${_dnEsc(_dnCleanName(chName))}</span>` : ''}
                <span class="dn-when">${_dnDateOf(m)}</span>
            </summary>
            <div class="dn-day-body">${body}</div>
        </details>`;
    };
    // vision mode by channel: חדשות → full transcription; תנועות-הון → short summary
    const visionModeOf = (name) => String(name || '').includes('תנועות-הון') ? 'summary' : 'transcribe';

    // Options-flow message: clear, large tabular line(s)
    const renderOption = (m) => {
        const lines = [];
        if (m.content) lines.push(m.content);
        for (const e of (m.embeds || [])) {
            if (e.title) lines.push(e.title);
            if (e.description) lines.push(e.description);
            for (const f of (e.fields || [])) lines.push(`${f.name}: ${f.value}`);
        }
        return lines.map(l => `<div class="dn-opt-line">${_dnEsc(l)}</div>`).join('');
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
