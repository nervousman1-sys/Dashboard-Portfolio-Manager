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
let _corrMode = 'portfolio';        // 'portfolio' | 'assets' | 'suggest'
let _corrAssets = [];               // asset-list mode: the symbols being compared
let _corrSuggestSectors = [];       // suggest mode: sectors the user wants to build from ([] = all)
let _corrSug = null;                // suggest mode retained state: { mat, meta, avail, chosen, targetN }
let _corrPinned = [];               // suggest mode: user-chosen symbols force-included in the basket
let _corrAssetsCache = '';          // between-assets: retained result HTML (survives page navigation)

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
    const tab = (m, label) => `<button class="tech-mkt-btn ${_corrMode === m ? 'active' : ''}" onclick="_corrSetMode('${m}')">${label}</button>`;
    page.innerHTML = `
    <div dir="rtl">
        <div class="macro-page-header">
            <h1 class="macro-main-title">מחשבון קורלציה</h1>
            <button class="macro-back-btn" onclick="closeCorrelationPage()">חזור לדשבורד</button>
        </div>
        <div class="macro-content">
            <div class="risk-table-card glass-card" style="padding:18px">
                <div class="tech-mkt corr-modes">
                    ${tab('portfolio', '🎯 מול תיק')}
                    ${tab('assets', '🔗 בין נכסים')}
                    ${tab('suggest', '🛡️ הצעות פיזור')}
                </div>
                <div id="corrModeBody">${_corrModeBodyHtml()}</div>
            </div>
        </div>
    </div>`;
    _corrRestoreResults();   // re-show any retained matrix/basket (survives page navigation)
}

function _corrSetMode(m) {
    if (_corrMode === m) return;
    _corrMode = m;
    document.querySelectorAll('.corr-modes .tech-mkt-btn').forEach(b => b.classList.toggle('active', b.textContent.includes({ portfolio: 'מול תיק', assets: 'בין נכסים', suggest: 'הצעות פיזור' }[m])));
    const host = document.getElementById('corrModeBody');
    if (host) host.innerHTML = _corrModeBodyHtml();
    _corrRestoreResults();
}
// Re-render retained results so leaving the page and returning keeps the built matrix/basket.
function _corrRestoreResults() {
    if (_corrMode === 'suggest' && _corrSug) { _corrRenderBasket(); }
    else if (_corrMode === 'assets' && _corrAssetsCache) { const r = document.getElementById('corrAssetsResult'); if (r) r.innerHTML = _corrAssetsCache; }
}

function _corrModeBodyHtml() {
    if (_corrMode === 'assets') return _corrAssetsBodyHtml();
    if (_corrMode === 'suggest') return _corrSuggestBodyHtml();
    return _corrBodyHtml(true);
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

// ════════════════════════════════════════════════════════════════════════════
// SHARED ENGINE — real 365d daily returns → correlation matrix (Yahoo /api/history)
// ════════════════════════════════════════════════════════════════════════════
// Fetch closes for a symbol list, align to a common trading calendar (the intersection
// of dates where every symbol has data), and return { syms, dates, levels{sym:[...] } }.
async function _corrFetchAligned(symbols) {
    const uniq = [...new Set(symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 40);
    const r = await fetch(`/api/history?symbols=${encodeURIComponent(uniq.join(','))}&range=1y`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('history HTTP ' + r.status);
    const hist = await r.json();
    // Resolve TASE fallback (.TA) and keep only symbols with a real series.
    const resolved = {};
    for (const s of uniq) {
        if (Array.isArray(hist[s]) && hist[s].length >= 120) resolved[s] = hist[s];
        else if (Array.isArray(hist[s + '.TA']) && hist[s + '.TA'].length >= 120) resolved[s] = hist[s + '.TA'];
    }
    const syms = Object.keys(resolved);
    if (syms.length < 2) return { syms, dates: [], levels: {} };
    // Common date set = intersection across all series.
    const maps = {}; syms.forEach(s => { maps[s] = {}; resolved[s].forEach(pt => maps[s][pt.date] = pt.close); });
    let dates = Object.keys(maps[syms[0]]);
    for (let i = 1; i < syms.length; i++) dates = dates.filter(d => maps[syms[i]][d] > 0);
    dates.sort();
    const levels = {}; syms.forEach(s => levels[s] = dates.map(d => maps[s][d]));
    return { syms, dates, levels };
}
// Pearson ρ between two return arrays (uses the existing _corrStats).
function _corrRho(ra, rb) { const s = _corrStats(ra, rb); return s ? s.rho : null; }
// NxN correlation matrix + each symbol's annualized σ, from aligned levels.
function _corrMatrix(aligned) {
    const { syms, levels } = aligned;
    const rets = {}; syms.forEach(s => rets[s] = _corrReturns(levels[s]));
    const M = {}, sig = {};
    syms.forEach(a => {
        M[a] = {};
        const st = _corrStats(rets[a], rets[a]);
        sig[a] = st ? st.sigA : null;
        syms.forEach(b => { M[a][b] = a === b ? 1 : _corrRho(rets[a], rets[b]); });
    });
    return { syms, M, sig, rets };
}
function _corrCellCls(r) { return r == null ? 'x' : r >= 0.6 ? 'hi' : r >= 0.3 ? 'mid' : r > -0.15 ? 'lo' : 'neg'; }
function _corrMatrixHtml(mat) {
    const { syms, M } = mat;
    const disp = s => _corrEsc(String(s).replace(/\.TA$/, ''));
    const head = `<tr><th></th>${syms.map(s => `<th>${disp(s)}</th>`).join('')}</tr>`;
    const rows = syms.map(a => `<tr><th>${disp(a)}</th>${syms.map(b => {
        const r = M[a][b];
        return `<td class="corr-cell corr-cell-${_corrCellCls(r)}">${r == null ? '—' : (a === b ? '1.00' : (r >= 0 ? '+' : '') + r.toFixed(2))}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="corr-matrix-wrap"><table class="corr-matrix">${head}${rows}</table></div>`;
}
// Best diversifier pairs = the most-negative / lowest ρ off-diagonal pairs.
function _corrBestPairs(mat, n) {
    const { syms, M } = mat; const out = [];
    for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
        const r = M[syms[i]][syms[j]];
        if (r != null) out.push({ a: syms[i], b: syms[j], rho: r });
    }
    return out.sort((x, y) => x.rho - y.rho).slice(0, n || 6);
}
// ════════════════════ MODE 2 — בין נכסים (asset-vs-asset matrix + sim) ════════════════════
function _corrAssetsBodyHtml() {
    if (typeof _wlPrimeUniverse === 'function') { try { _wlPrimeUniverse(); } catch (e) { } } // fill the ticker pool for autocomplete
    const chips = _corrAssets.map(s => `<span class="corr-chip-tag">${_corrEsc(s)}<button onclick="_corrRemoveAsset('${s}')" aria-label="הסר">✕</button></span>`).join('');
    return `
        <div class="corr-note">בדיקת קורלציה בין נכסים — ללא קשר לתיק קיים. הוסף 2–10 סימבולים (מניות, אג"ח, זהב…), קבל מטריצת מתאם, סיכום מילולי וסימולציית תיק שווה-משקל שמראה את תועלת הפיזור.</div>
        <div class="corr-search-wrap">
            <label class="st-pf-label">חיפוש נייר ערך:</label>
            <div class="ticker-search-wrapper" style="flex:1;position:relative">
                <input type="text" id="corrTickerSearch" class="corr-input" style="width:100%" autocomplete="off"
                    placeholder="חפש: AAPL, טבע, GLD…" oninput="_corrTickerSearch()" />
                <div id="corrTickerDropdown" class="ticker-search-dropdown"></div>
            </div>
        </div>
        <div class="corr-chips">${chips || '<span class="corr-chip-empty">אין נכסים עדיין — הוסף לפחות שניים.</span>'}</div>
        <div class="st-portfolio-row" style="margin-top:6px">
            <button class="corr-run-btn corr-run-primary" id="corrMatrixBtn" onclick="_corrRunMatrix()" ${_corrAssets.length < 2 ? 'disabled' : ''}>חשב מטריצת קורלציה</button>
            <button class="corr-reset-btn" onclick="_corrResetAssets()">✕ איפוס</button>
        </div>
        <div id="corrAssetsResult"></div>`;
}
// Full ticker search — mirrors the add-holding modal's box (local Hebrew/bond matches +
// Twelve Data API + live prices) so the correlation input behaves like every other search.
let _corrSearchTimer = null;
function _corrTickerSearch() {
    clearTimeout(_corrSearchTimer);
    const q = (document.getElementById('corrTickerSearch') || {}).value?.trim();
    const dd = document.getElementById('corrTickerDropdown');
    if (!dd) return;
    if (!q || q.length < 1) { dd.innerHTML = ''; dd.style.display = 'none'; return; }
    const local = (typeof _sortSearchResults === 'function')
        ? _sortSearchResults([...(typeof searchHebrewNames === 'function' ? searchHebrewNames(q) : []), ...(typeof searchLocalBonds === 'function' ? searchLocalBonds(q) : [])], q) : [];
    dd.style.display = 'block';
    if (local.length) _corrRenderSearch(local, dd); else dd.innerHTML = '<div class="ticker-search-loading">מחפש…</div>';
    _corrSearchTimer = setTimeout(async () => {
        try {
            const api = (typeof searchTwelveDataSymbols === 'function') ? await searchTwelveDataSymbols(q) : [];
            const merged = (typeof _mergeLocalAndApiResults === 'function') ? _sortSearchResults(_mergeLocalAndApiResults(local, api), q) : local;
            _corrRenderSearch(merged, dd);
        } catch (e) { if (!local.length) dd.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>'; }
    }, 300);
}
function _corrRenderSearch(results, dd) {
    if (!results.length) { dd.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>'; return; }
    dd.innerHTML = results.slice(0, 8).map((r, i) => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[(r.symbol || '').replace('.TA', '').toUpperCase()] : '');
        const isBond = r.type === 'Bond';
        const primary = isBond ? (r.name || r.symbol) : (heName || r.name || r.symbol);
        const secondary = isBond ? (heName && heName !== r.name ? heName : '') : (heName && r.name && heName !== r.name ? r.name : '');
        const disp = (r.exchange === 'TASE' && !String(r.symbol).includes('.TA')) ? r.symbol + '.TA' : r.symbol;
        const safe = String(r.symbol).replace(/'/g, "\\'");
        return `<div class="ticker-search-item" onclick="_corrPickSearch('${safe}')">
            <div class="search-row-grid">
                <div class="search-col-name"><span class="search-name-primary">${isBond ? '<span class="search-bond-tag">אג"ח</span>' : ''}${primary}</span>${secondary ? `<span class="search-name-secondary">${secondary}</span>` : ''}</div>
                <div class="search-col-ticker">${disp}</div>
                <div class="search-col-exchange">${r.exchange || ''}</div>
                <div class="search-col-price" id="slp_corr_${i}"><span class="price-loading">···</span></div>
            </div>
        </div>`;
    }).join('');
    if (typeof _fetchSearchResultPrices === 'function') _fetchSearchResultPrices(results.slice(0, 8), 'corr');
}
function _corrPickSearch(sym) {
    _corrAddAsset(sym);
    const dd = document.getElementById('corrTickerDropdown'); if (dd) { dd.innerHTML = ''; dd.style.display = 'none'; }
    const inp = document.getElementById('corrTickerSearch'); if (inp) inp.value = '';
}
// One-click reset: clear all chosen assets AND the computed matrix/summary.
function _corrResetAssets() {
    _corrAssets = []; _corrAssetsCache = '';
    const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrAssetsBodyHtml();
    const inp = document.getElementById('corrTickerSearch'); if (inp) inp.focus();
}
function _corrAddAsset(v) {
    const sym = String(v || '').trim().toUpperCase();
    if (!sym || /^\d+$/.test(sym) || _corrAssets.includes(sym) || _corrAssets.length >= 10) return;
    _corrAssets.push(sym);
    const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrAssetsBodyHtml();
    const inp = document.getElementById('corrAssetInput'); if (inp) inp.focus();
}
function _corrRemoveAsset(s) {
    _corrAssets = _corrAssets.filter(x => x !== s);
    const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrAssetsBodyHtml();
}
async function _corrRunMatrix() {
    if (_corrBusy || _corrAssets.length < 2) return;
    const res = document.getElementById('corrAssetsResult');
    if (!res) return;
    _corrBusy = true;
    const btn = document.getElementById('corrMatrixBtn'); if (btn) { btn.disabled = true; btn.textContent = 'מחשב…'; }
    res.innerHTML = '<div class="rep-loading"><div class="rep-spinner"></div>מושך 365 ימי מחירים אמיתיים לכל הנכסים…</div>';
    try {
        const aligned = await _corrFetchAligned(_corrAssets);
        if (aligned.syms.length < 2 || aligned.dates.length < 40) {
            res.innerHTML = '<div class="st-empty">אין מספיק נתונים חופפים — ודא שלכל הסימבולים יש היסטוריית מחירים של שנה.</div>'; return;
        }
        const mat = _corrMatrix(aligned);
        const pairs = _corrBestPairs(mat, 6);
        // Equal-weight portfolio simulation: risk of the basket vs the naive weighted-avg risk.
        const n = mat.syms.length;
        const combo = aligned.dates.map((_, t) => mat.syms.reduce((s, sym) => s + (aligned.levels[sym][t] / aligned.levels[sym][0]) / n, 0));
        const comboSig = (_corrStats(_corrReturns(combo), _corrReturns(combo)) || {}).sigA || 0;
        const avgSig = mat.syms.reduce((s, sym) => s + (mat.sig[sym] || 0), 0) / n;
        const cut = avgSig > 0 ? (1 - comboSig / avgSig) * 100 : 0;
        const pct = x => (x * 100).toFixed(1) + '%';
        // Verbal summary of the OVERALL relationship (average off-diagonal ρ).
        let ps = 0, pc = 0;
        for (let i = 0; i < mat.syms.length; i++) for (let j = i + 1; j < mat.syms.length; j++) { const r = mat.M[mat.syms[i]][mat.syms[j]]; if (r != null) { ps += r; pc++; } }
        const avgRho = pc ? ps / pc : 0;
        const disp = s => _corrEsc(String(s).replace(/\.TA$/, ''));
        const worst = pairs[pairs.length - 1], best = pairs[0];
        let sumTxt, sumCls;
        if (avgRho >= 0.6) { sumCls = 'neg'; sumTxt = `הנכסים שבחרת מתואמים <b>חיובית וחזק</b> (ρ ממוצע ${'+' + avgRho.toFixed(2)}) — הם נעים כמעט יחד, כך שהחזקתם יחד <b>מגדילה ריכוזיות ולא מפזרת סיכון</b>. שקול להחליף חלק בנכסים ממתאם נמוך.`; }
        else if (avgRho >= 0.3) { sumCls = 'warn'; sumTxt = `בין הנכסים <b>מתאם חיובי בינוני</b> (ρ ממוצע ${'+' + avgRho.toFixed(2)}) — הם נוטים לנוע יחד, ותרומת הפיזור מוגבלת. ${worst && worst.rho > 0.5 ? `הזוג ${disp(worst.a)}↔${disp(worst.b)} מתואם במיוחד (${'+' + worst.rho.toFixed(2)}).` : ''}`; }
        else if (avgRho >= 0.1) { sumCls = 'info'; sumTxt = `מתאם חיובי <b>חלש</b> בממוצע (ρ ${'+' + avgRho.toFixed(2)}) — הנכסים מספקים פיזור סביר. ${best ? `הזוג ${disp(best.a)}↔${disp(best.b)} הכי מפזר (${best.rho >= 0 ? '+' : ''}${best.rho.toFixed(2)}).` : ''}`; }
        else if (avgRho > -0.1) { sumCls = 'pos'; sumTxt = `הנכסים כמעט <b>ללא מתאם</b> ביניהם (ρ ממוצע ${avgRho >= 0 ? '+' : ''}${avgRho.toFixed(2)}) — פיזור <b>מצוין</b>: כל נכס זז באופן עצמאי, מה שמקטין את תנודתיות התיק המשולב.`; }
        else { sumCls = 'pos'; sumTxt = `בין הנכסים <b>מתאם שלילי</b> בממוצע (ρ ${avgRho.toFixed(2)}) — הם נוטים לנוע <b>הפוך</b> זה מזה, גידור מצוין שמרכך ירידות. ${best ? `${disp(best.a)}↔${disp(best.b)} הכי הפוך (${best.rho.toFixed(2)}).` : ''}`; }
        res.innerHTML = `
            <div class="corr-verdict corr-${sumCls}">
                <div class="corr-verdict-head"><span class="corr-rho">ρ ממוצע = ${avgRho >= 0 ? '+' : ''}${avgRho.toFixed(2)}</span><span class="corr-chip">📝 סיכום הקורלציה</span></div>
                <p class="corr-verdict-txt">${sumTxt}</p>
            </div>
            <div class="st-section-title">מטריצת קורלציה (ρ על תשואות יומיות)</div>
            ${_corrMatrixHtml(mat)}
            <div class="corr-legend"><span class="corr-cell corr-cell-neg">שלילי</span> מפזר · <span class="corr-cell corr-cell-lo">≈0</span> · <span class="corr-cell corr-cell-mid">בינוני</span> · <span class="corr-cell corr-cell-hi">גבוה</span> ריכוזיות</div>
            <div class="st-section-title">הזוגות בעלי הפיזור הטוב ביותר</div>
            <div class="corr-holds">${pairs.map(p => {
            const c = _corrClass(p.rho);
            return `<div class="corr-hold-row">
                    <span class="corr-hold-tk">${_corrEsc(p.a.replace(/\.TA$/, ''))} ↔ ${_corrEsc(p.b.replace(/\.TA$/, ''))}</span>
                    <div class="corr-hold-bar"><span class="corr-hold-fill ${p.rho >= 0 ? 'p' : 'n'}" style="width:${Math.min(100, Math.abs(p.rho) * 100).toFixed(0)}%"></span></div>
                    <span class="corr-hold-rho corr-t-${c.cls}">${(p.rho >= 0 ? '+' : '') + p.rho.toFixed(2)}</span>
                </div>`;
        }).join('')}</div>
            <div class="st-section-title">סימולציית תיק שווה-משקל (${n} נכסים)</div>
            <div class="corr-metrics">
                <div class="corr-m"><span class="corr-m-l">סטיית תקן ממוצעת של הנכסים</span><b>${pct(avgSig)}</b></div>
                <div class="corr-m"><span class="corr-m-l">סטיית תקן התיק המשולב</span><b>${pct(comboSig)}</b></div>
                <div class="corr-m corr-m-hl"><span class="corr-m-l">הפחתת סיכון מפיזור</span><b>${cut > 0 ? '−' + cut.toFixed(1) + '%' : '≈0'}</b></div>
            </div>
            <div class="corr-note">ככל שהמתאם בין הנכסים נמוך/שלילי — תנודתיות התיק המשולב נמוכה מהממוצע הפשוט של הנכסים. זהו בדיוק "הצ'ופר החינמי" של הפיזור. חלון: ${_corrEsc(aligned.dates[0])} → ${_corrEsc(aligned.dates[aligned.dates.length - 1])}.</div>`;
        _corrAssetsCache = res.innerHTML;   // retain so returning to the page keeps the result
    } catch (e) {
        res.innerHTML = '<div class="st-empty">החישוב נכשל — נסה שוב בעוד רגע.</div>';
    } finally {
        _corrBusy = false;
        const b = document.getElementById('corrMatrixBtn'); if (b) { b.disabled = _corrAssets.length < 2; b.textContent = 'חשב מטריצת קורלציה'; }
    }
}

// ════════════════════ MODE 3 — הצעות פיזור (diversification suggestions) ════════════════════
// High-grade defensive anchors (rating ABOVE A — the user's bond condition). US Treasuries
// are AAA/AA; gold is the classic negative-correlation diversifier (not a bond, labeled so).
const CORR_ANCHORS = [
    { sym: 'TLT', name: 'אג"ח ממשלת ארה"ב 20+ שנה', grade: 'AAA', kind: 'bond' },
    { sym: 'IEF', name: 'אג"ח ממשלת ארה"ב 7–10 שנה', grade: 'AAA', kind: 'bond' },
    { sym: 'GOVT', name: 'אג"ח ממשלת ארה"ב (כל הטווחים)', grade: 'AAA', kind: 'bond' },
    { sym: 'GLD', name: 'זהב (SPDR Gold)', grade: '—', kind: 'gold' },
];
const CORR_MIN_SCORE = 68;   // "דוחות טובים" gate
const CORR_SECTORS = ['Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Industrials', 'Materials', 'Utilities', 'Real Estate', 'Communication Services'];
// GICS sector → its sector ETF, for reading real relative momentum (money-flow tilt).
const CORR_SECTOR_ETF = { 'Information Technology': 'XLK', 'Financials': 'XLF', 'Energy': 'XLE', 'Health Care': 'XLV', 'Industrials': 'XLI', 'Consumer Discretionary': 'XLY', 'Consumer Staples': 'XLP', 'Communication Services': 'XLC', 'Materials': 'XLB', 'Utilities': 'XLU', 'Real Estate': 'XLRE' };
function _corrSuggestBodyHtml() {
    if (typeof _wlPrimeUniverse === 'function') { try { _wlPrimeUniverse(); } catch (e) { } }
    const secChips = CORR_SECTORS.map(s => `<button class="corr-sec-chip ${_corrSuggestSectors.includes(s) ? 'on' : ''}" onclick="_corrToggleSector('${s}')">${_corrHeSector(s)}</button>`).join('');
    const selTxt = _corrSuggestSectors.length ? `נבחרו ${_corrSuggestSectors.length} סקטורים` : 'כל הסקטורים';
    const pins = _corrPinned.map(s => `<span class="corr-chip-tag">${_corrEsc(s)}<button onclick="_corrUnpin('${s}')" aria-label="הסר">✕</button></span>`).join('');
    return `
        <div class="corr-note">בונה הצעה לתיק מפוזר: מניות מובילות בסקטור שלהן עם <b>דוחות טובים (ציון ≥ ${CORR_MIN_SCORE})</b>, בשילוב עוגני הגנה בדירוג <b>מעל A</b> (אג"ח ממשלתי AAA) וזהב — ובוחר את הנכסים שמוציאים את הקורלציה ההדדית הנמוכה ביותר, כך שהם מקזזים סיכון זה של זה.</div>
        <div class="corr-sec-row">
            <label class="st-pf-label">בנה לפי סקטורים <span class="corr-sec-sel">(${selTxt})</span>:</label>
            <div class="corr-sec-chips">${secChips}</div>
        </div>
        <div class="corr-search-wrap" style="margin-top:8px">
            <label class="st-pf-label">הוסף נכס משלך לסל:</label>
            <div class="ticker-search-wrapper" style="flex:1;position:relative">
                <input type="text" id="corrPinSearch" class="corr-input" style="width:100%" autocomplete="off" placeholder="חפש והוסף נכס לכלול בסל…" oninput="_corrPinSearch()" />
                <div id="corrPinDropdown" class="ticker-search-dropdown"></div>
            </div>
        </div>
        ${pins ? `<div class="corr-chips">${pins}</div>` : ''}
        <div class="st-portfolio-row" style="margin-top:8px">
            <label class="st-pf-label">גודל הסל:</label>
            <select class="st-pf-select" id="corrBasketN" style="min-width:130px" onchange="document.getElementById('corrBasketCustom').style.display = this.value==='custom' ? '' : 'none';">
                <option value="5">5 נכסים</option><option value="6" selected>6 נכסים</option><option value="7">7 נכסים</option><option value="8">8 נכסים</option><option value="custom">מותאם אישית…</option>
            </select>
            <input type="number" id="corrBasketCustom" class="corr-input" min="3" max="20" step="1" value="10" placeholder="מס' נכסים" style="display:none;width:110px" title="3 עד 20 נכסים" />
            <button class="corr-run-btn corr-run-primary" id="corrSuggestBtn" onclick="_corrRunSuggest()">בנה הצעת פיזור</button>
            <button class="corr-reset-btn" onclick="_corrResetSuggest()">✕ איפוס</button>
        </div>
        <div id="corrSuggestResult"></div>`;
}
// Pinned-asset search (own picks force-included in the basket) — reuses the app search box.
let _corrPinTimer = null;
function _corrPinSearch() {
    clearTimeout(_corrPinTimer);
    const q = (document.getElementById('corrPinSearch') || {}).value?.trim();
    const dd = document.getElementById('corrPinDropdown');
    if (!dd) return;
    if (!q || q.length < 1) { dd.innerHTML = ''; dd.style.display = 'none'; return; }
    const local = (typeof _sortSearchResults === 'function') ? _sortSearchResults([...(typeof searchHebrewNames === 'function' ? searchHebrewNames(q) : []), ...(typeof searchLocalBonds === 'function' ? searchLocalBonds(q) : [])], q) : [];
    dd.style.display = 'block';
    if (local.length) _corrRenderPinSearch(local, dd); else dd.innerHTML = '<div class="ticker-search-loading">מחפש…</div>';
    _corrPinTimer = setTimeout(async () => {
        try { const api = (typeof searchTwelveDataSymbols === 'function') ? await searchTwelveDataSymbols(q) : []; _corrRenderPinSearch(_sortSearchResults(_mergeLocalAndApiResults(local, api), q), dd); }
        catch (e) { if (!local.length) dd.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>'; }
    }, 300);
}
function _corrRenderPinSearch(results, dd) {
    if (!results.length) { dd.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>'; return; }
    dd.innerHTML = results.slice(0, 8).map((r, i) => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[(r.symbol || '').replace('.TA', '').toUpperCase()] : '');
        const isBond = r.type === 'Bond';
        const primary = isBond ? (r.name || r.symbol) : (heName || r.name || r.symbol);
        const disp = (r.exchange === 'TASE' && !String(r.symbol).includes('.TA')) ? r.symbol + '.TA' : r.symbol;
        return `<div class="ticker-search-item" onclick="_corrPin('${String(r.symbol).replace(/'/g, "\\'")}')">
            <div class="search-row-grid"><div class="search-col-name"><span class="search-name-primary">${isBond ? '<span class="search-bond-tag">אג"ח</span>' : ''}${primary}</span></div>
            <div class="search-col-ticker">${disp}</div><div class="search-col-exchange">${r.exchange || ''}</div>
            <div class="search-col-price" id="slp_corrpin_${i}"><span class="price-loading">···</span></div></div></div>`;
    }).join('');
    if (typeof _fetchSearchResultPrices === 'function') _fetchSearchResultPrices(results.slice(0, 8), 'corrpin');
}
function _corrPin(sym) {
    const s = String(sym).toUpperCase().replace(/\.TA$/, '');
    if (s && !_corrPinned.includes(s) && _corrPinned.length < 15) _corrPinned.push(s);
    const dd = document.getElementById('corrPinDropdown'); if (dd) { dd.innerHTML = ''; dd.style.display = 'none'; }
    const inp = document.getElementById('corrPinSearch'); if (inp) inp.value = '';
    const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrSuggestBodyHtml();
}
function _corrUnpin(s) { _corrPinned = _corrPinned.filter(x => x !== s); const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrSuggestBodyHtml(); }
function _corrResetSuggest() {
    _corrSuggestSectors = []; _corrPinned = []; _corrSug = null;
    const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrSuggestBodyHtml();
}
function _corrToggleSector(s) {
    if (_corrSuggestSectors.includes(s)) _corrSuggestSectors = _corrSuggestSectors.filter(x => x !== s);
    else _corrSuggestSectors.push(s);
    const host = document.getElementById('corrModeBody'); if (host) host.innerHTML = _corrSuggestBodyHtml();
}
async function _corrRunSuggest() {
    if (_corrBusy) return;
    const res = document.getElementById('corrSuggestResult');
    if (!res || typeof supabaseClient === 'undefined' || !supabaseClient) return;
    _corrBusy = true;
    const btn = document.getElementById('corrSuggestBtn'); if (btn) { btn.disabled = true; btn.textContent = 'בונה…'; }
    const sizeSel = (document.getElementById('corrBasketN') || {}).value;
    const targetN = sizeSel === 'custom'
        ? Math.max(3, Math.min(20, parseInt((document.getElementById('corrBasketCustom') || {}).value, 10) || 10))
        : (parseInt(sizeSel, 10) || 6);
    res.innerHTML = '<div class="rep-loading"><div class="rep-spinner"></div>בוחר מניות איכותיות מובילות-סקטור ומחשב מתאמים אמיתיים…</div>';
    try {
        // 1) Sector-leading quality stocks: top scorers per sector (good reports + sector standing).
        //    When the user picked sectors, restrict to them (and take more leaders per sector so a
        //    single-sector build still has enough names to diversify within it).
        const { data } = await supabaseClient.from('company_reports')
            .select('symbol,company_name,score,sector')
            .eq('market', 'us').gte('score', CORR_MIN_SCORE)
            .order('score', { ascending: false }).limit(500);
        const wantSectors = _corrSuggestSectors.length ? _corrSuggestSectors : null;
        const perSector = wantSectors && wantSectors.length <= 2 ? 6 : 2;   // narrow pick → more within-sector names
        const bySector = {};
        (data || []).forEach(r => {
            const sec = r.sector || 'Other';
            if (wantSectors && !wantSectors.includes(sec)) return;
            if (!bySector[sec]) bySector[sec] = [];
            if (bySector[sec].length < perSector) bySector[sec].push(r);
        });
        const stockCands = Object.values(bySector).flat();
        if (stockCands.length < 3) { res.innerHTML = '<div class="st-empty">אין מספיק מניות בציון גבוה בסקטורים שנבחרו — בחר סקטורים נוספים או הסר את הסינון.</div>'; return; }
        // 2) Candidate universe = quality stocks + defensive anchors + the user's OWN pinned picks.
        const anchors = CORR_ANCHORS;
        const pinned = _corrPinned.map(s => s.toUpperCase());
        const universe = [...new Set([...stockCands.map(s => s.symbol.toUpperCase()), ...anchors.map(a => a.sym), ...pinned])].slice(0, 40);
        const aligned = await _corrFetchAligned(universe);
        if (aligned.syms.length < 4) { res.innerHTML = '<div class="st-empty">משיכת המחירים נכשלה — נסה שוב בעוד רגע.</div>'; return; }
        const mat = _corrMatrix(aligned);
        const meta = {};
        stockCands.forEach(s => meta[s.symbol.toUpperCase()] = { name: s.company_name, score: s.score, sector: s.sector, kind: 'stock' });
        anchors.forEach(a => meta[a.sym] = { name: a.name, grade: a.grade, kind: a.kind });
        // Pinned picks not already known — give them minimal meta (fill score/sector after).
        pinned.forEach(s => { if (!meta[s]) meta[s] = { name: s, score: null, sector: null, kind: 'stock' }; });
        if (pinned.length) { try { const { data: pd } = await supabaseClient.from('company_reports').select('symbol,company_name,score,sector').in('symbol', pinned); (pd || []).forEach(r => { meta[r.symbol.toUpperCase()] = { name: r.company_name, score: r.score, sector: r.sector, kind: 'stock' }; }); } catch (e) { } }
        const avail = mat.syms.filter(s => meta[s]);

        // 3) Force-include the user's pinned picks FIRST, then greedy-fill: repeatedly add the
        //    candidate with the LOWEST average correlation to the chosen set. Reserve a hedge and
        //    keep one leader per sector for real diversification.
        const chosen = [];
        pinned.forEach(s => { if (avail.includes(s) && !chosen.includes(s)) chosen.push(s); });
        if (!chosen.length) {
            const seed = avail.filter(s => meta[s].kind === 'stock').sort((a, b) => (meta[b].score || 0) - (meta[a].score || 0))[0];
            if (seed) chosen.push(seed);
        }
        const usedSectors = new Set(chosen.filter(s => meta[s].kind === 'stock').map(s => meta[s].sector));
        while (chosen.length < targetN) {
            let best = null, bestAvg = 2;
            const needAnchor = chosen.length === targetN - 1 && !chosen.some(s => meta[s].kind !== 'stock');
            for (const s of avail) {
                if (chosen.includes(s)) continue;
                if (needAnchor && meta[s].kind === 'stock') continue;                 // last slot reserved for a hedge
                if (meta[s].kind === 'stock' && usedSectors.has(meta[s].sector)) continue; // one leader per sector
                const avg = chosen.reduce((acc, c) => acc + (mat.M[s][c] ?? 0), 0) / chosen.length;
                if (avg < bestAvg) { bestAvg = avg; best = s; }
            }
            if (!best) {                                                             // relax the sector rule if stuck
                for (const s of avail) { if (chosen.includes(s)) continue; const avg = chosen.reduce((acc, c) => acc + (mat.M[s][c] ?? 0), 0) / chosen.length; if (avg < bestAvg) { bestAvg = avg; best = s; } }
            }
            if (!best) break;
            chosen.push(best); if (meta[best].kind === 'stock') usedSectors.add(meta[best].sector);
        }

        // Sector momentum (REAL): each sector-ETF's 21-day return relative to SPY — the tilt
        // signal for exposure (money flowing IN → the sector leads → higher weight).
        let mom = {};
        try {
            const mf = (typeof _dnComputeMarketFlows === 'function') ? await _dnComputeMarketFlows() : null;
            if (mf && mf.rows) { const byEtf = {}; mf.rows.forEach(r => byEtf[r.etf] = r.rel); for (const [sec, etf] of Object.entries(CORR_SECTOR_ETF)) if (byEtf[etf] != null) mom[sec] = byEtf[etf]; }
        } catch (e) { }
        // Retain everything so "החלף" (swap) can re-pick without re-fetching, and render.
        _corrSug = { mat, meta, avail, chosen, targetN, mom, prices: {} };
        _corrRenderBasket();
    } catch (e) {
        res.innerHTML = '<div class="st-empty">בניית ההצעה נכשלה — נסה שוב בעוד רגע.</div>';
    } finally {
        _corrBusy = false;
        const b = document.getElementById('corrSuggestBtn'); if (b) { b.disabled = false; b.textContent = 'בנה הצעת פיזור'; }
    }
}

// Suggested EXPOSURE weights: risk-parity base (wᵢ ∝ 1/σᵢ, so the low-vol hedges anchor the
// basket and no single name dominates the risk) TILTED by real sector momentum — sectors whose
// ETF leads SPY get more weight, laggards less. Anchors (bonds/gold) keep their risk-parity
// weight. Normalized to 100%. This is what turns low pairwise correlation into the lowest
// portfolio risk while leaning into where money is actually flowing.
function _corrWeights() {
    const { mat, meta, chosen, mom } = _corrSug;
    const raw = {};
    chosen.forEach(s => {
        const sig = mat.sig[s] || 0.2;
        let w = 1 / Math.max(sig, 0.03);                 // inverse-vol (risk parity)
        if (meta[s].kind === 'stock') {
            const rel = (mom && meta[s].sector != null) ? mom[meta[s].sector] : 0;
            const tilt = Math.max(0.6, Math.min(1.5, 1 + (rel || 0) * 4));  // ±rel → 0.6…1.5×
            w *= tilt;
        }
        raw[s] = w;
    });
    const tot = chosen.reduce((a, s) => a + raw[s], 0) || 1;
    const out = {}; chosen.forEach(s => out[s] = raw[s] / tot);
    return out;
}
// Render the current suggested basket (re-callable after a swap). Reads _corrSug.
function _corrRenderBasket() {
    const res = document.getElementById('corrSuggestResult');
    if (!res || !_corrSug) return;
    const { mat, meta, chosen, mom } = _corrSug;
    let sum = 0, cnt = 0;
    for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) { sum += mat.M[chosen[i]][chosen[j]] ?? 0; cnt++; }
    const avgPair = cnt ? sum / cnt : 0;
    const weights = _corrWeights();
    const roleOf = (s) => {
        const m = meta[s];
        if (m.kind === 'bond') return `אג"ח ${m.grade} · עוגן הגנה`;
        if (m.kind === 'gold') return 'זהב · גידור אינפלציה/משבר';
        const sec = _corrHeSector(m.sector);
        const rel = mom && m.sector != null ? mom[m.sector] : null;
        const tag = rel != null ? (rel > 0.005 ? ' · מומנטום חיובי' : rel < -0.005 ? ' · מומנטום שלילי' : '') : '';
        return `מניה${sec ? ' · ' + sec : ''} · ציון ${m.score}${tag}`;
    };
    const pfList = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : [];
    const pfOpts = pfList.map(c => `<option value="${c.id}">${_corrEsc(c.name)}</option>`).join('');
    const anyMom = mom && Object.keys(mom).length;
    res.innerHTML = `
        <div class="corr-verdict corr-pos">
            <div class="corr-verdict-head">
                <span class="corr-rho">מתאם הדדי ממוצע: ${(avgPair >= 0 ? '+' : '') + avgPair.toFixed(2)}</span>
                <span class="corr-chip">🛡️ סל מפוזר</span>
            </div>
            <p class="corr-verdict-txt">כל נכס נבחר כי הוא מקזז את התנועה של האחרים (מתאם נמוך/שלילי). <b>אחוזי החשיפה המוצעים</b> בונים מינימום-סיכון (risk parity — נכס תנודתי מקבל פחות)${anyMom ? ' ומוטים לפי <b>מומנטום הסקטורים</b> בפועל — סקטור שמוביל את השוק מקבל חשיפה גבוהה יותר' : ''}. לחץ "🔄 החלף" לקבלת עד 10 חלופות לכל נכס.</p>
        </div>
        <div class="st-section-title">הסל המוצע — נכסים ואחוזי חשיפה מוצעים (${chosen.length} נכסים)</div>
        <div class="corr-holds">${chosen.map(s => {
        const m = meta[s]; const disp = s.replace(/\.TA$/, '');
        const scoreChip = m.kind === 'stock' ? `<span class="rep-card-score ${typeof _repScoreClass === 'function' ? _repScoreClass(m.score) : ''}">${m.score}</span>` : `<span class="er-beat er-beat-yes" style="border:none;background:none">${m.grade || ''}</span>`;
        return `<div class="wl-row"><div class="wl-main">
                <span class="corr-weight" title="חשיפה מוצעת">${(weights[s] * 100).toFixed(0)}%</span>
                <div class="wl-id"><span class="wl-tk">${_corrEsc(disp)}</span><span class="wl-co">${_corrEsc(m.name || '')} · ${roleOf(s)}</span></div>
                <span class="wl-priceblock" id="corrPx-${disp}"><span class="wl-price wl-dim">—</span></span>
                ${scoreChip}
                <button class="corr-mini-btn" onclick="_corrSwapAsset('${s}')" title="הצג עד 10 חלופות">🔄 החלף</button>
                <button class="wl-report" onclick="if(typeof openReportForTicker==='function'){openReportForTicker('${s}');}">📊 דוח</button>
                <button class="corr-mini-btn corr-buy" onclick="_corrBuyAsset('${s}')" title="הוסף לתיק / קנה">➕ קנה</button>
                <button class="corr-mini-btn corr-remove" onclick="_corrRemoveFromBasket('${s}')" title="הסר מהסל">✕ הסר</button>
            </div><div id="corrAlts-${disp}" class="corr-alts"></div></div>`;
    }).join('')}</div>
        <div class="corr-basket-add">
            <label class="st-pf-label">➕ הוסף מניה לסל:</label>
            <div class="ticker-search-wrapper" style="flex:1;position:relative;min-width:200px">
                <input type="text" id="corrBasketAdd" class="corr-input" style="width:100%" autocomplete="off" placeholder="חפש והוסף מניה לסל המוצע…" oninput="_corrBasketAddSearch()" />
                <div id="corrBasketAddDD" class="ticker-search-dropdown"></div>
            </div>
        </div>
        <div class="corr-basket-actions">
            <label class="st-pf-label">קנה את כל הסל:</label>
            ${pfOpts ? `<select class="st-pf-select" id="corrBuyPf" style="min-width:180px">${pfOpts}</select>
            <button class="corr-run-btn" onclick="_corrAddBasketToPortfolio()">🛒 קנה הכל לתיק שנבחר</button>` : ''}
            <button class="corr-run-btn corr-run-primary" onclick="_corrCreatePortfolio()">➕ פתח תיק חדש עם הסל</button>
            <button class="corr-run-btn" onclick="_corrShowMatrixModal()">📊 הצג מטריצת קורלציה</button>
        </div>
        <div class="corr-basket-actions corr-watch-row">
            <label class="st-pf-label">⭐ שמור כתעודת סל בהתאמה אישית:</label>
            <input type="text" id="corrWatchName" class="corr-input" style="min-width:200px" maxlength="40" placeholder="תן שם לרשימה (למשל: סל פיזור יולי)" />
            <button class="corr-run-btn" id="corrWatchBtn" onclick="_corrBasketToWatchlist()">⭐ הוסף לרשימת המעקב</button>
        </div>
        <div class="corr-note">תנאי הסינון: מניות בציון דוחות ≥ ${CORR_MIN_SCORE} ומובילות בסקטור שלהן · עוגני הגנה בדירוג מעל A (אג"ח ממשלת ארה"ב AAA) + זהב · אחוזי חשיפה = risk-parity ${anyMom ? '× מומנטום סקטורים (21 יום מול S&P)' : ''} · מתאמים ומחירים אמיתיים על 365 ימי מסחר. ההצעה אינה ייעוץ השקעות.</div>`;
    _corrLoadBasketPrices();
}
// The basket correlation matrix opens in its own window (per request — no inline clutter).
function _corrShowMatrixModal() {
    if (!_corrSug) return;
    let ov = document.getElementById('corrMatrixOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'corrMatrixOverlay'; ov.className = 'wl-overlay'; ov.addEventListener('click', e => { if (e.target === ov) _corrCloseMatrix(); }); document.body.appendChild(ov); }
    ov.innerHTML = `<div class="wl-box er-box" dir="rtl" style="max-width:760px">
        <div class="wl-head"><span class="wl-title">📊 מטריצת קורלציה של הסל</span><button class="wl-close" onclick="_corrCloseMatrix()">✕</button></div>
        <div style="padding:14px 18px">${_corrMatrixHtml({ syms: _corrSug.chosen, M: _corrSug.mat.M })}
        <div class="corr-legend" style="margin-top:12px"><span class="corr-cell corr-cell-neg">שלילי</span> מפזר · <span class="corr-cell corr-cell-lo">≈0</span> · <span class="corr-cell corr-cell-mid">בינוני</span> · <span class="corr-cell corr-cell-hi">גבוה</span> ריכוזיות</div></div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}
function _corrCloseMatrix() { const ov = document.getElementById('corrMatrixOverlay'); if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; } if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock(); }
// Add the whole basket to the watchlist under a user-named custom-ETF group label.
async function _corrBasketToWatchlist() {
    if (!_corrSug || typeof _repAddWatchGroup !== 'function') { if (typeof showToast === 'function') showToast('בנה קודם סל מוצע', 'info'); return; }
    const inp = document.getElementById('corrWatchName');
    const label = ((inp && inp.value.trim()) || 'תעודת סל בהתאמה אישית').slice(0, 40);
    const btn = document.getElementById('corrWatchBtn');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'שומר…'; }
    try {
        const r = await _repAddWatchGroup(_corrSug.chosen, label);
        if (typeof showToast === 'function') {
            if (r.added) showToast(`✅ ${r.added} נכסים נשמרו לרשימת המעקב תחת "${label}"`, 'success');
            else showToast('כל נכסי הסל כבר קיימים במעקב (או שאינך מחובר)', 'info');
        }
        if (btn) { btn.textContent = r.added ? '✓ נשמר למעקב' : orig; setTimeout(() => { if (btn) { btn.textContent = orig; btn.disabled = false; } }, r.added ? 1600 : 0); if (!r.added) btn.disabled = false; }
        if (inp && r.added) inp.value = '';
    } catch (e) {
        if (typeof showToast === 'function') showToast('שמירה לרשימת המעקב נכשלה', 'error');
        if (btn) { btn.textContent = orig; btn.disabled = false; }
    }
}
// Remove one asset from the suggested basket, then recompute the matrix/weights.
function _corrRemoveFromBasket(sym) {
    if (!_corrSug) return;
    if (_corrSug.chosen.length <= 2) { if (typeof showToast === 'function') showToast('נדרשים לפחות 2 נכסים בסל', 'info'); return; }
    _corrSug.chosen = _corrSug.chosen.filter(x => x !== String(sym));
    _corrRecomputeBasket();
}
// Add-to-basket search (after a suggestion is built) — reuses the app search infra.
let _corrBasketAddTimer = null;
function _corrBasketAddSearch() {
    clearTimeout(_corrBasketAddTimer);
    const q = (document.getElementById('corrBasketAdd') || {}).value?.trim();
    const dd = document.getElementById('corrBasketAddDD');
    if (!dd) return;
    if (!q || q.length < 1) { dd.innerHTML = ''; dd.style.display = 'none'; return; }
    const local = (typeof _sortSearchResults === 'function') ? _sortSearchResults([...(typeof searchHebrewNames === 'function' ? searchHebrewNames(q) : []), ...(typeof searchLocalBonds === 'function' ? searchLocalBonds(q) : [])], q) : [];
    dd.style.display = 'block';
    if (local.length) _corrRenderBasketAddSearch(local, dd); else dd.innerHTML = '<div class="ticker-search-loading">מחפש…</div>';
    _corrBasketAddTimer = setTimeout(async () => {
        try { const api = (typeof searchTwelveDataSymbols === 'function') ? await searchTwelveDataSymbols(q) : []; _corrRenderBasketAddSearch(_sortSearchResults(_mergeLocalAndApiResults(local, api), q), dd); }
        catch (e) { if (!local.length) dd.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>'; }
    }, 300);
}
function _corrRenderBasketAddSearch(results, dd) {
    if (!results.length) { dd.innerHTML = '<div class="ticker-search-empty">לא נמצאו תוצאות</div>'; return; }
    dd.innerHTML = results.slice(0, 8).map((r, i) => {
        const heName = r.hebrewName || ((typeof HEBREW_NAMES !== 'undefined') ? HEBREW_NAMES[(r.symbol || '').replace('.TA', '').toUpperCase()] : '');
        const isBond = r.type === 'Bond';
        const primary = isBond ? (r.name || r.symbol) : (heName || r.name || r.symbol);
        const disp = (r.exchange === 'TASE' && !String(r.symbol).includes('.TA')) ? r.symbol + '.TA' : r.symbol;
        return `<div class="ticker-search-item" onclick="_corrBasketPick('${String(disp).replace(/'/g, "\\'")}')">
            <div class="search-row-grid"><div class="search-col-name"><span class="search-name-primary">${isBond ? '<span class="search-bond-tag">אג"ח</span>' : ''}${primary}</span></div>
            <div class="search-col-ticker">${disp}</div><div class="search-col-exchange">${r.exchange || ''}</div>
            <div class="search-col-price" id="slp_corradd_${i}"><span class="price-loading">···</span></div></div></div>`;
    }).join('');
    if (typeof _fetchSearchResultPrices === 'function') _fetchSearchResultPrices(results.slice(0, 8), 'corradd');
}
function _corrBasketPick(sym) {
    const s = String(sym).toUpperCase();
    const dd = document.getElementById('corrBasketAddDD'); if (dd) { dd.innerHTML = ''; dd.style.display = 'none'; }
    const inp = document.getElementById('corrBasketAdd'); if (inp) inp.value = '';
    if (!_corrSug) return;
    if (_corrSug.chosen.includes(s)) { if (typeof showToast === 'function') showToast('הנכס כבר בסל', 'info'); return; }
    if (_corrSug.chosen.length >= 20) { if (typeof showToast === 'function') showToast('הסל הגיע ל-20 נכסים', 'info'); return; }
    // Minimal meta; _corrRecomputeBasket() fills score/name/sector from company_reports and refetches histories.
    _corrSug.meta[s] = _corrSug.meta[s] || { name: s.replace(/\.TA$/, ''), score: null, kind: 'stock', sector: null };
    _corrSug.chosen.push(s);
    if (typeof showToast === 'function') showToast(`מוסיף את ${s.replace(/\.TA$/, '')} לסל…`, 'info');
    _corrRecomputeBasket();
}
// Live price per basket asset (real quote), patched into each row.
async function _corrLoadBasketPrices() {
    if (!_corrSug || typeof _wlFetchPrices !== 'function') return;
    try {
        const syms = _corrSug.chosen;
        const prices = await _wlFetchPrices(syms.slice(0, 40));
        _corrSug.prices = prices;
        for (const s of syms) {
            const disp = s.replace(/\.TA$/, '');
            const q = prices[s] || prices[disp] || {};
            const price = q.price != null ? q.price : null;
            const el = document.getElementById('corrPx-' + disp);
            if (el && price != null) el.innerHTML = `<span class="wl-price">${/\.TA$/.test(s) ? '₪' : '$'}${Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>`;
        }
    } catch (e) { /* prices best-effort */ }
}

// ── Alternatives: show up to 10 like-for-like substitutes for a basket asset ──
// Stocks → more top-scored names from the SAME sector (fetched on demand), ranked by how low
// their average correlation to the rest of the basket is. Anchors → the other AAA/gold anchors
// (few substitutes — that's the "commodity" case, shown as-is).
let _corrAltsBusy = false;
async function _corrSwapAsset(sym) {
    if (!_corrSug || _corrAltsBusy) return;
    const disp = sym.replace(/\.TA$/, '');
    const box = document.getElementById('corrAlts-' + disp);
    if (!box) return;
    if (box.dataset.open === '1') { _corrCloseAlts(disp); return; }
    const { meta, chosen } = _corrSug;
    box.dataset.open = '1';
    box.innerHTML = '<div class="corr-alts-load"><div class="rep-spinner"></div>מחפש חלופות…</div>';
    const rest = chosen.filter(x => x !== sym);
    try {
        let alts = [];
        if (meta[sym].kind !== 'stock') {
            // Bond/gold — few substitutes: the other anchors not already in the basket.
            alts = CORR_ANCHORS.filter(a => a.kind === meta[sym].kind && !chosen.includes(a.sym))
                .map(a => ({ sym: a.sym, name: a.name, grade: a.grade, kind: a.kind }));
            if (!alts.length) { box.innerHTML = '<div class="corr-alts-empty">לנכס מסוג זה אין תחליפים נוספים בדירוג הנדרש (סחורה/אג"ח ממשלתי).</div>'; box.dataset.open = ''; return; }
        } else {
            // More same-sector quality leaders (on-demand), ranked by correlation to the rest.
            const { data } = await supabaseClient.from('company_reports')
                .select('symbol,company_name,score,sector').eq('market', 'us')
                .eq('sector', meta[sym].sector).gte('score', CORR_MIN_SCORE)
                .order('score', { ascending: false }).limit(14);
            const cands = (data || []).map(r => r.symbol.toUpperCase()).filter(s => !chosen.includes(s) && s !== sym);
            if (!cands.length) { box.innerHTML = '<div class="corr-alts-empty">אין מניות נוספות בציון גבוה בסקטור זה.</div>'; box.dataset.open = ''; return; }
            const aligned = await _corrFetchAligned([...cands, ...rest]);
            const mat2 = _corrMatrix(aligned);
            const metaC = {}; (data || []).forEach(r => metaC[r.symbol.toUpperCase()] = { name: r.company_name, score: r.score, sector: r.sector });
            alts = cands.filter(c => mat2.M[c]).map(c => ({
                sym: c, name: (metaC[c] || {}).name, score: (metaC[c] || {}).score, kind: 'stock',
                avg: rest.reduce((a, x) => a + (mat2.M[c][x] ?? 0), 0) / (rest.length || 1),
            })).sort((a, b) => a.avg - b.avg).slice(0, 10);
            if (!alts.length) { box.innerHTML = '<div class="corr-alts-empty">לא נמצאו חלופות עם נתוני מחיר מספקים.</div>'; box.dataset.open = ''; return; }
        }
        box.innerHTML = `<div class="corr-alts-inner"><div class="corr-alts-h">חלופות ל-${_corrEsc(disp)} (מסודר לפי פיזור) <button class="corr-alts-x" onclick="_corrCloseAlts('${disp}')">✕</button></div>${alts.map(a => `
            <button class="corr-alt-row" onclick="_corrPickAlternative('${sym}','${a.sym}')">
                <span class="corr-alt-tk">${_corrEsc(a.sym.replace(/\.TA$/, ''))}</span>
                <span class="corr-alt-co">${_corrEsc(a.name || '')}</span>
                ${a.kind === 'stock' ? `<span class="corr-alt-rho ${a.avg < 0 ? 'corr-t-pos' : a.avg < 0.3 ? 'corr-t-info' : 'corr-t-warn'}">ρ ${(a.avg >= 0 ? '+' : '') + a.avg.toFixed(2)}</span><span class="rep-card-score ${typeof _repScoreClass === 'function' ? _repScoreClass(a.score) : ''}">${a.score}</span>` : `<span class="corr-alt-rho corr-t-pos">${a.grade}</span>`}
            </button>`).join('')}</div>`;
    } catch (e) { box.innerHTML = '<div class="corr-alts-empty">טעינת החלופות נכשלה.</div>'; box.dataset.open = ''; }
}
function _corrCloseAlts(disp) { const b = document.getElementById('corrAlts-' + disp); if (b) { b.innerHTML = ''; b.dataset.open = ''; } }
function _corrPickAlternative(oldSym, newSym) {
    if (!_corrSug) return;
    const nu = String(newSym).toUpperCase();
    // The alternative may not be in the original matrix — its row is only needed for display;
    // rebuild the basket matrix from the retained aligned data on the next full recompute. For
    // now, add minimal meta and re-run the correlation for the new set so the matrix is exact.
    _corrSug.meta[nu] = _corrSug.meta[nu] || { name: nu, score: null, kind: 'stock', sector: (_corrSug.meta[oldSym] || {}).sector };
    _corrSug.chosen = _corrSug.chosen.map(x => x === oldSym ? nu : x);
    _corrRecomputeBasket();
}
// After a swap to a name outside the original matrix, refetch the basket's histories so the
// matrix/weights are exact for the new set.
async function _corrRecomputeBasket() {
    const res = document.getElementById('corrSuggestResult');
    if (!res || !_corrSug) return;
    res.querySelectorAll('.corr-mini-btn').forEach(b => b.disabled = true);
    try {
        const aligned = await _corrFetchAligned(_corrSug.chosen);
        if (aligned.syms.length >= 2) {
            const mat = _corrMatrix(aligned);
            // Preserve meta; fill any missing score/name for the new name from company_reports.
            const need = _corrSug.chosen.filter(s => !_corrSug.meta[s] || _corrSug.meta[s].score == null);
            if (need.length && typeof supabaseClient !== 'undefined') {
                try { const { data } = await supabaseClient.from('company_reports').select('symbol,company_name,score,sector').in('symbol', need); (data || []).forEach(r => { _corrSug.meta[r.symbol.toUpperCase()] = { name: r.company_name, score: r.score, sector: r.sector, kind: 'stock' }; }); } catch (e) { }
            }
            _corrSug.mat = mat;
        }
    } catch (e) { }
    _corrRenderBasket();
}

// ── Buy / add-to-portfolio actions ──
function _corrBuyAsset(sym) {
    const s = String(sym).replace(/\.TA$/, '');
    const meta = _corrSug && _corrSug.meta[sym];
    const name = (meta && meta.name) || s;
    const client = _corrPortfolio() || (typeof clients !== 'undefined' && clients[0]);
    if (!client) { if (typeof openMgmtModal === 'function') openMgmtModal('addClient'); return; }
    if (typeof openMgmtModal === 'function') openMgmtModal('addHolding', client);
    // Prefill the ticker into the just-opened add-holding modal.
    setTimeout(() => { if (typeof selectSearchResult === 'function') selectSearchResult(s, name, 'USD', 'NASDAQ'); }, 120);
}
function _corrAddBasketToPortfolio() {
    const sel = document.getElementById('corrBuyPf');
    const id = sel ? +sel.value : null;
    const client = (typeof clients !== 'undefined' && clients.find(c => c.id === id)) || _corrPortfolio();
    if (!client || !_corrSug) return;
    // Open the add-holding modal on the chosen portfolio, prefilled with the first asset; the
    // manager confirms quantity/price per name (we never write trades silently).
    if (typeof openMgmtModal === 'function') openMgmtModal('addHolding', client);
    const first = _corrSug.chosen[0];
    setTimeout(() => { if (first && typeof selectSearchResult === 'function') selectSearchResult(String(first).replace(/\.TA$/, ''), (_corrSug.meta[first] || {}).name || '', 'USD', 'NASDAQ'); }, 120);
    if (typeof showToast === 'function') showToast('נפתחה הוספת נכס — הוסף כל מניה מהסל בתורה', 'info');
}
function _corrCreatePortfolio() {
    // Open the standard new-portfolio flow; the manager then adds the basket names.
    if (typeof openMgmtModal === 'function') openMgmtModal('addClient');
    if (typeof showToast === 'function') showToast('צור את התיק, ואז הוסף את מניות הסל המוצע', 'info');
}
function _corrHeSector(s) {
    const M = { 'Information Technology': 'טכנולוגיה', 'Financials': 'פיננסים', 'Health Care': 'בריאות', 'Consumer Discretionary': 'צריכה מחזורית', 'Consumer Staples': 'צריכה בסיסית', 'Energy': 'אנרגיה', 'Industrials': 'תעשייה', 'Materials': 'חומרים', 'Utilities': 'תשתיות', 'Real Estate': 'נדל"ן', 'Communication Services': 'תקשורת', 'Crypto': 'קריפטו' };
    return M[s] || s || '';
}

if (typeof window !== 'undefined') {
    window.openCorrelationPage = openCorrelationPage;
    window.closeCorrelationPage = closeCorrelationPage;
    window._corrRun = _corrRun;
    window._corrMountInModal = _corrMountInModal;
    window._corrSetMode = _corrSetMode;
    window._corrAddAsset = _corrAddAsset; window._corrRemoveAsset = _corrRemoveAsset; window._corrRunMatrix = _corrRunMatrix;
    window._corrTickerSearch = _corrTickerSearch; window._corrPickSearch = _corrPickSearch; window._corrResetAssets = _corrResetAssets;
    window._corrRunSuggest = _corrRunSuggest; window._corrToggleSector = _corrToggleSector;
    window._corrSwapAsset = _corrSwapAsset; window._corrPickAlternative = _corrPickAlternative; window._corrCloseAlts = _corrCloseAlts;
    window._corrBuyAsset = _corrBuyAsset;
    window._corrAddBasketToPortfolio = _corrAddBasketToPortfolio; window._corrCreatePortfolio = _corrCreatePortfolio;
    window._corrPinSearch = _corrPinSearch; window._corrPin = _corrPin; window._corrUnpin = _corrUnpin; window._corrResetSuggest = _corrResetSuggest;
    window._corrShowMatrixModal = _corrShowMatrixModal; window._corrCloseMatrix = _corrCloseMatrix; window._corrBasketToWatchlist = _corrBasketToWatchlist;
    window._corrRemoveFromBasket = _corrRemoveFromBasket; window._corrBasketAddSearch = _corrBasketAddSearch; window._corrBasketPick = _corrBasketPick;
}
