// ========== CORRELATION CALCULATOR — מחשבון קורלציה לתיק ==========
//
// Measures whether a candidate asset moves WITH the selected portfolio (positive
// correlation), AGAINST it (negative — a hedge), or independently (≈0 — a true
// diversifier). All statistics are computed from REAL dividend-adjusted daily
// closes over the last 365 days (~250 trading days, Yahoo via /api/history) and
// re-fetched on every run, so the numbers track the market continuously.
//
//   • Portfolio series = value-weighted composite of the holdings' price series
//     (ILS values converted at the live USD/ILS rate; holdings without a Yahoo
//     series — e.g. numeric Israeli funds — are excluded and reported as
//     uncovered weight, never guessed).
//   • ρ (Pearson) on daily simple returns · σ annualized ×√252 · β vs the
//     portfolio = cov/var · R² = ρ².

let _corrPortfolioId = null;
let _corrBusy = false;

// ── Routed page (mirrors the stress-test page) ────────────────────────────────
function openCorrelationPage() {
    const page = document.getElementById('correlationPage');
    if (!page) return;
    const header = document.querySelector('.header');
    if (header) header.style.display = 'none';
    const heroFold = document.querySelector('.hero-above-fold');
    if (heroFold) Array.from(heroFold.children).forEach(el => { if (el.id !== 'correlationPage') el.style.display = 'none'; });
    const grid = document.getElementById('clientsGrid');
    if (grid) grid.style.display = 'none';
    const psh = document.querySelector('.portfolio-section-header');
    if (psh) psh.style.display = 'none';

    page.classList.add('active');
    if (typeof _setActiveNav === 'function') _setActiveNav('correlation');
    if (typeof updateURLState === 'function') updateURLState({ view: 'correlation' });

    if (_corrPortfolioId == null && typeof clients !== 'undefined' && Array.isArray(clients) && clients.length) {
        _corrPortfolioId = clients.slice().sort((a, b) => (b.portfolioValue || 0) - (a.portfolioValue || 0))[0].id;
    }
    _corrRenderShell();
    window.scrollTo(0, 0);
}
function closeCorrelationPage() {
    const page = document.getElementById('correlationPage');
    if (!page) return;
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

function _corrEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _corrPortfolio() {
    if (typeof clients === 'undefined' || !Array.isArray(clients)) return null;
    return clients.find(c => c.id === _corrPortfolioId) || clients[0] || null;
}

// Shared calculator body — used by BOTH the routed page (with a portfolio selector)
// and the portfolio-modal "קורלציה" tab (portfolio fixed to the open client).
function _corrBodyHtml(withSelect) {
    const list = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : [];
    const opts = list.map(c => `<option value="${c.id}" ${c.id === _corrPortfolioId ? 'selected' : ''}>${_corrEsc(c.name)}</option>`).join('');
    return `
        ${withSelect ? `<div class="st-portfolio-row">
            <label class="st-pf-label">תיק לבדיקה:</label>
            <select class="st-pf-select" onchange="_corrPortfolioId=+this.value; const r=document.getElementById('corrResult'); if(r) r.innerHTML='';">${opts}</select>
        </div>` : ''}
        <div class="st-portfolio-row">
            <label class="st-pf-label">נכס לבדיקה:</label>
            <input type="text" id="corrSymbol" class="corr-input" autocomplete="off" placeholder="למשל: NVDA, GLD, TLT, TEVA…"
                onkeydown="if(event.key==='Enter') _corrRun()" />
            <button class="corr-run-btn" id="corrRunBtn" onclick="_corrRun()">חשב קורלציה</button>
        </div>
        <div class="corr-note">מתאם פירסון (ρ) על תשואות יומיות · 365 הימים האחרונים (~250 ימי מסחר) · מחירי סגירה מתוקני-דיבידנד · הנתונים נמשכים מחדש בכל חישוב</div>
        <div id="corrResult"></div>`;
}

function _corrRenderShell() {
    const page = document.getElementById('correlationPage');
    if (!page) return;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">מחשבון קורלציה לתיק</h1>
            <button class="macro-back-btn" onclick="closeCorrelationPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="risk-table-card glass-card" style="padding:18px">
                ${_corrBodyHtml(true)}
            </div>
        </div>
    </div>`;
}

// Mount inside the portfolio modal's "קורלציה" tab — the portfolio is the open client.
function _corrMountInModal(clientId) {
    _corrPortfolioId = clientId;
    const host = document.getElementById('tab-correlation');
    if (!host) return;
    host.innerHTML = `<div dir="rtl" style="padding:4px 2px">${_corrBodyHtml(false)}</div>`;
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function _corrReturns(levels) {
    const out = [];
    for (let i = 1; i < levels.length; i++) {
        if (levels[i] > 0 && levels[i - 1] > 0) out.push(levels[i] / levels[i - 1] - 1);
        else out.push(0);
    }
    return out;
}
function _corrStats(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 30) return null;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
    cov /= (n - 1); va /= (n - 1); vb /= (n - 1);
    if (va <= 0 || vb <= 0) return null;
    return { n, rho: cov / Math.sqrt(va * vb), sigA: Math.sqrt(va * 252), sigB: Math.sqrt(vb * 252), beta: cov / vb };
}
function _corrClass(r) {
    if (r >= 0.7) return { label: 'קורלציה חיובית חזקה', cls: 'neg', emoji: '🔗', verdict: 'הנכס נע כמעט אחד-לאחד עם התיק — הוספתו מגדילה ריכוזיות, לא פיזור.' };
    if (r >= 0.3) return { label: 'קורלציה חיובית', cls: 'warn', emoji: '↗️', verdict: 'הנכס נוטה לנוע עם התיק — תרומת הפיזור מוגבלת.' };
    if (r >= 0.15) return { label: 'קורלציה חיובית חלשה', cls: 'info', emoji: '🔀', verdict: 'קשר חיובי קל בלבד — הנכס מוסיף פיזור סביר לתיק.' };
    if (r > -0.15) return { label: 'ללא מתאם (≈0)', cls: 'pos', emoji: '🎯', verdict: 'אין קשר מובהק לתיק — מפזר אמיתי: מקטין את התנודתיות הכוללת בלי לוותר על תשואה.' };
    if (r > -0.4) return { label: 'קורלציה שלילית', cls: 'pos', emoji: '🛡️', verdict: 'הנכס נוטה לנוע נגד התיק — מרכיב הגנתי שמרכך ירידות.' };
    return { label: 'קורלציה שלילית חזקה', cls: 'pos', emoji: '🛡️', verdict: 'הנכס נע באופן עקבי נגד התיק — גידור ממשי לתקופות ירידה.' };
}

// ── The run: fetch 365d closes for asset + holdings → composite → statistics ──
async function _corrRun() {
    if (_corrBusy) return;
    const inp = document.getElementById('corrSymbol');
    const res = document.getElementById('corrResult');
    if (!inp || !res) return;
    let sym = String(inp.value || '').trim().toUpperCase();
    if (!sym) { res.innerHTML = '<div class="st-empty">הקלד סימבול של נכס לבדיקה (למשל NVDA או GLD).</div>'; return; }
    if (/^\d+$/.test(sym)) { res.innerHTML = '<div class="st-empty">קרנות ישראליות במספר נייר אינן נתמכות — לרובן אין סדרת מחירים ציבורית יומית.</div>'; return; }
    const p = _corrPortfolio();
    if (!p || !Array.isArray(p.holdings) || !p.holdings.filter(h => (+h.value || 0) > 0).length) {
        res.innerHTML = '<div class="st-empty">לתיק הנבחר אין אחזקות פעילות.</div>'; return;
    }
    _corrBusy = true;
    const btn = document.getElementById('corrRunBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'מחשב…'; }
    res.innerHTML = '<div class="rep-loading"><div class="rep-spinner"></div>מושך 365 ימי מחירים אמיתיים לנכס ולכל אחזקות התיק…</div>';
    try {
        // Resolve holdings → Yahoo symbols + USD weights (live FX for ILS values).
        const fx = (typeof window !== 'undefined' && window.USD_ILS_RATE > 0) ? window.USD_ILS_RATE : 3.7;
        const holdings = p.holdings.filter(h => (+h.value || 0) > 0).map(h => {
            const ySym = (typeof _stResolveSym === 'function') ? _stResolveSym(h) : String(h.ticker || '').toUpperCase();
            const usd = (+h.value || 0) / (h.currency === 'ILS' ? fx : 1);
            return { ticker: h.ticker, name: h.name, ySym, w: usd };
        });
        const totalW = holdings.reduce((s, h) => s + h.w, 0);

        // One batched fetch: candidate (with a .TA fallback probe) + every holding.
        const wanted = [...new Set([sym, sym + '.TA', ...holdings.map(h => h.ySym).filter(Boolean)])].slice(0, 60);
        const r = await fetch(`/api/history?symbols=${encodeURIComponent(wanted.join(','))}&range=1y`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('history HTTP ' + r.status);
        const hist = await r.json();
        const seriesOf = (s) => (Array.isArray(hist[s]) && hist[s].length >= 120) ? hist[s] : null;

        // The candidate: exact symbol wins; TASE fallback if only the .TA form has data.
        let assetSeries = seriesOf(sym), assetSym = sym;
        if (!assetSeries && seriesOf(sym + '.TA')) { assetSeries = seriesOf(sym + '.TA'); assetSym = sym + '.TA'; }
        if (!assetSeries) { res.innerHTML = `<div class="st-empty">לא נמצאה היסטוריית מחירים של שנה עבור ${_corrEsc(sym)} — בדוק את הסימבול.</div>`; return; }

        // Timeline = the asset's trading days; holdings forward-fill onto it.
        const dates = assetSeries.map(pt => pt.date);
        const assetLevels = assetSeries.map(pt => pt.close);
        const covered = [];
        let coveredW = 0;
        for (const h of holdings) {
            const s = h.ySym ? seriesOf(h.ySym) : null;
            if (!s) continue;
            const m = {}; s.forEach(pt => m[pt.date] = pt.close);
            let last = null;
            const lv = dates.map(d => { if (m[d] != null) last = m[d]; return last; });
            const first = lv.findIndex(v => v != null && v > 0);
            if (first < 0 || first > dates.length * 0.25) continue;  // needs data over ≥75% of the window
            covered.push({ ...h, levels: lv, firstIdx: first });
            coveredW += h.w;
        }
        if (!covered.length || coveredW <= 0) { res.innerHTML = '<div class="st-empty">לאף אחזקה בתיק אין סדרת מחירים ציבורית — לא ניתן לחשב מתאם אמיתי.</div>'; return; }

        // Composite portfolio index: Σ wᵢ·(closeᵢ,t / closeᵢ,t₀), from the first date all covered names have data.
        const startIdx = Math.max(...covered.map(c => c.firstIdx));
        const portLevels = [];
        for (let t = startIdx; t < dates.length; t++) {
            let lvl = 0;
            for (const c of covered) lvl += (c.w / coveredW) * (c.levels[t] / c.levels[startIdx]);
            portLevels.push(lvl);
        }
        const aLv = assetLevels.slice(startIdx);
        const rA = _corrReturns(aLv), rP = _corrReturns(portLevels);
        const st = _corrStats(rA, rP);
        if (!st) { res.innerHTML = '<div class="st-empty">אין מספיק ימי מסחר חופפים לחישוב מובהק (נדרשים 30+).</div>'; return; }

        // Per-holding correlations on the same timeline (largest first).
        const perHold = covered.map(c => {
            const s = _corrStats(rA, _corrReturns(c.levels.slice(startIdx)));
            return s ? { ticker: c.ticker, name: c.name, w: c.w / coveredW, rho: s.rho } : null;
        }).filter(Boolean).sort((x, y) => y.w - x.w).slice(0, 12);

        const inPort = holdings.some(h => String(h.ticker || '').toUpperCase().replace(/\.TA$/, '') === assetSym.replace(/\.TA$/, ''));
        const cls = _corrClass(st.rho);
        const covPct = Math.round(coveredW / totalW * 100);
        const pct = (x) => (x * 100).toFixed(1) + '%';
        const rhoTxt = (st.rho >= 0 ? '+' : '') + st.rho.toFixed(2);
        const gaugePos = ((st.rho + 1) / 2 * 100).toFixed(1);
        res.innerHTML = `
            <div class="corr-verdict corr-${cls.cls}">
                <div class="corr-verdict-head">
                    <span class="corr-rho">ρ = ${rhoTxt}</span>
                    <span class="corr-chip">${cls.emoji} ${cls.label}</span>
                </div>
                <div class="corr-gauge"><div class="corr-gauge-track"><span class="corr-gauge-dot" style="left:${gaugePos}%"></span></div>
                    <div class="corr-gauge-lbls"><span>‎-1 (הפוך)</span><span>0 (ללא קשר)</span><span>‎+1 (זהה)</span></div>
                </div>
                <p class="corr-verdict-txt">${cls.verdict}${inPort ? ' <b>(הנכס כבר מוחזק בתיק זה.)</b>' : ''}</p>
            </div>
            <div class="corr-metrics">
                <div class="corr-m"><span class="corr-m-l">סטיית תקן ${_corrEsc(assetSym.replace(/\.TA$/, ''))} (שנתית)</span><b>${pct(st.sigA)}</b></div>
                <div class="corr-m"><span class="corr-m-l">סטיית תקן התיק (שנתית)</span><b>${pct(st.sigB)}</b></div>
                <div class="corr-m"><span class="corr-m-l">בטא מול התיק</span><b>${st.beta.toFixed(2)}</b></div>
                <div class="corr-m"><span class="corr-m-l">R² (הסבר משותף)</span><b>${(st.rho * st.rho * 100).toFixed(0)}%</b></div>
                <div class="corr-m"><span class="corr-m-l">ימי מסחר במדגם</span><b>${st.n}</b></div>
                <div class="corr-m"><span class="corr-m-l">כיסוי התיק בחישוב</span><b>${covPct}%</b></div>
            </div>
            <div class="st-section-title">מתאם הנכס מול כל אחזקה (לפי משקל בתיק)</div>
            <div class="corr-holds">
                ${perHold.map(h => {
            const c2 = _corrClass(h.rho);
            return `<div class="corr-hold-row">
                        <span class="corr-hold-tk">${_corrEsc(String(h.ticker || '').replace(/\.TA$/, ''))}</span>
                        <span class="corr-hold-w">${(h.w * 100).toFixed(1)}%</span>
                        <div class="corr-hold-bar"><span class="corr-hold-fill ${h.rho >= 0 ? 'p' : 'n'}" style="width:${Math.min(100, Math.abs(h.rho) * 100).toFixed(0)}%"></span></div>
                        <span class="corr-hold-rho corr-t-${c2.cls}">${(h.rho >= 0 ? '+' : '') + h.rho.toFixed(2)}</span>
                    </div>`;
        }).join('')}
            </div>
            <div class="corr-note">חלון: ${_corrEsc(dates[startIdx])} → ${_corrEsc(dates[dates.length - 1])} · ${covPct < 100 ? `אחזקות ללא סדרת מחירים ציבורית (${100 - covPct}% מהתיק) אינן בחישוב · ` : ''}מקור: Yahoo (סגירה מתוקנת-דיבידנד) · הרצה חוזרת מושכת נתונים עדכניים</div>`;
    } catch (e) {
        res.innerHTML = '<div class="st-empty">החישוב נכשל — נסה שוב בעוד רגע.</div>';
    } finally {
        _corrBusy = false;
        const b = document.getElementById('corrRunBtn');
        if (b) { b.disabled = false; b.textContent = 'חשב קורלציה'; }
    }
}

if (typeof window !== 'undefined') {
    window.openCorrelationPage = openCorrelationPage;
    window.closeCorrelationPage = closeCorrelationPage;
    window._corrRun = _corrRun;
    window._corrMountInModal = _corrMountInModal;
}
