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

function _dnRender() {
    const data = _dnLastData;
    const tabsEl = document.getElementById('dnTabs');
    const feedEl = document.getElementById('dnFeed');
    if (!data || !tabsEl || !feedEl) return;

    const withMsgs = data.channels.filter(c => (c.messages || []).length);

    // Channel tabs (all + each channel)
    tabsEl.innerHTML = [
        `<button class="dn-tab ${_dnActiveChannel === 'all' ? 'active' : ''}" onclick="setDnChannel('all')">הכל</button>`,
        ...data.channels.map(c =>
            `<button class="dn-tab ${_dnActiveChannel === c.id ? 'active' : ''}" onclick="setDnChannel('${c.id}')"># ${_dnEsc(c.name)}${(c.messages || []).length ? ` <span class="dn-tab-n">${c.messages.length}</span>` : ''}</button>`),
    ].join('');

    const renderMsg = (m, chName) => {
        const d = m.ts ? new Date(m.ts) : null;
        const when = d ? `${d.toLocaleDateString('he-IL')} ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}` : '';
        const embeds = (m.embeds || []).map(e => `
            <div class="dn-embed">
                ${e.title ? `<div class="dn-embed-title">${e.url ? `<a href="${_dnEsc(e.url)}" target="_blank" rel="noopener">${_dnEsc(e.title)} ↗</a>` : _dnEsc(e.title)}</div>` : ''}
                ${e.description ? `<div class="dn-embed-desc">${_dnEsc(e.description)}</div>` : ''}
                ${(e.fields || []).map(f => `<div class="dn-embed-field"><b>${_dnEsc(f.name)}:</b> ${_dnEsc(f.value)}</div>`).join('')}
            </div>`).join('');
        const atts = (m.attachments || []).map(a =>
            `<a class="dn-att" href="${_dnEsc(a.url)}" target="_blank" rel="noopener">📎 ${_dnEsc(a.name)}</a>`).join('');
        return `
        <div class="dn-msg">
            <div class="dn-msg-head">
                <span class="dn-author">${_dnEsc(m.author)}${m.bot ? ' <span class="dn-bot">BOT</span>' : ''}</span>
                ${chName ? `<span class="dn-ch"># ${_dnEsc(chName)}</span>` : ''}
                <span class="dn-when">${when}</span>
            </div>
            ${m.content ? `<div class="dn-content">${_dnEsc(m.content)}</div>` : ''}
            ${embeds}${atts}
        </div>`;
    };

    let html = '';
    if (_dnActiveChannel === 'all') {
        // Merge everything, newest first
        const all = [];
        for (const c of withMsgs) for (const m of c.messages) all.push({ m, ch: c.name });
        all.sort((a, b) => new Date(b.m.ts) - new Date(a.m.ts));
        html = all.length
            ? all.slice(0, 60).map(x => renderMsg(x.m, x.ch)).join('')
            : '<div class="adv-empty">אין עדיין הודעות בערוצים.</div>';
    } else {
        const c = data.channels.find(x => x.id === _dnActiveChannel);
        html = (c && c.messages.length)
            ? c.messages.map(m => renderMsg(m, null)).join('')
            : '<div class="adv-empty">אין הודעות בערוץ הזה עדיין.</div>';
    }
    feedEl.innerHTML = html;
}

if (typeof window !== 'undefined') {
    window.openDiscordNews = openDiscordNews;
    window.closeDiscordNews = closeDiscordNews;
    window.setDnChannel = setDnChannel;
}
