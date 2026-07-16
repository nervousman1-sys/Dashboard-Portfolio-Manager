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
}

function _corrSetMode(m) {
    if (_corrMode === m) return;
    _corrMode = m;
    document.querySelectorAll('.corr-modes .tech-mkt-btn').forEach(b => b.classList.toggle('active', b.textContent.includes({ portfolio: 'מול תיק', assets: 'בין נכסים', suggest: 'הצעות פיזור' }[m])));
    const host = document.getElementById('corrModeBody');
    if (host) host.innerHTML = _corrModeBodyHtml();
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
        <div class="st-portfolio-row" style="position:relative">
            <label class="st-pf-label">הוסף נכס:</label>
            <input type="text" id="corrAssetInput" class="corr-input" autocomplete="off" placeholder="הקלד שם או טיקר: NVDA, אפל, GLD…"
                oninput="_corrAssetSuggest(this.value)"
                onkeydown="if(event.key==='Enter'){_corrAddAsset(this.value); this.value=''; _corrAssetSuggest('');}" />
            <button class="corr-run-btn" onclick="_corrAddAsset(document.getElementById('corrAssetInput').value); document.getElementById('corrAssetInput').value=''; _corrAssetSuggest('');">הוסף</button>
            <div id="corrAssetSuggest" class="corr-suggest"></div>
        </div>
        <div class="corr-chips">${chips || '<span class="corr-chip-empty">אין נכסים עדיין — הוסף לפחות שניים.</span>'}</div>
        <div class="st-portfolio-row" style="margin-top:6px">
            <button class="corr-run-btn corr-run-primary" id="corrMatrixBtn" onclick="_corrRunMatrix()" ${_corrAssets.length < 2 ? 'disabled' : ''}>חשב מטריצת קורלציה</button>
        </div>
        <div id="corrAssetsResult"></div>`;
}
// As-you-type ticker suggestions from the reports universe (any index) — click to add.
function _corrAssetSuggest(q) {
    const sg = document.getElementById('corrAssetSuggest');
    if (!sg) return;
    q = String(q || '').trim().toUpperCase();
    if (q.length < 1) { sg.innerHTML = ''; sg.style.display = 'none'; return; }
    const pool = new Set();
    try { if (typeof _repUniverse !== 'undefined') for (const m of Object.keys(_repUniverse)) (_repUniverse[m] || []).forEach(t => pool.add(t)); } catch (e) { }
    const matches = [...pool].filter(t => t.replace(/\.TA$/, '').includes(q) && !_corrAssets.includes(t.replace(/\.TA$/, ''))).slice(0, 8);
    if (!matches.length) { sg.innerHTML = ''; sg.style.display = 'none'; return; }
    sg.style.display = 'flex';
    sg.innerHTML = matches.map(t => `<button class="corr-sg-item" onclick="_corrAddAsset('${t.replace(/\.TA$/, '')}'); document.getElementById('corrAssetInput').value=''; _corrAssetSuggest('');">${t.replace(/\.TA$/, '')}</button>`).join('');
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
function _corrSuggestBodyHtml() {
    const secChips = CORR_SECTORS.map(s => `<button class="corr-sec-chip ${_corrSuggestSectors.includes(s) ? 'on' : ''}" onclick="_corrToggleSector('${s}')">${_corrHeSector(s)}</button>`).join('');
    const selTxt = _corrSuggestSectors.length ? `נבחרו ${_corrSuggestSectors.length} סקטורים` : 'כל הסקטורים';
    return `
        <div class="corr-note">בונה הצעה לתיק מפוזר: מניות מובילות בסקטור שלהן עם <b>דוחות טובים (ציון ≥ ${CORR_MIN_SCORE})</b>, בשילוב עוגני הגנה בדירוג <b>מעל A</b> (אג"ח ממשלתי AAA) וזהב — ובוחר את הנכסים שמוציאים את הקורלציה ההדדית הנמוכה ביותר, כך שהם מקזזים סיכון זה של זה.</div>
        <div class="corr-sec-row">
            <label class="st-pf-label">בנה לפי סקטורים <span class="corr-sec-sel">(${selTxt})</span>:</label>
            <div class="corr-sec-chips">${secChips}</div>
        </div>
        <div class="st-portfolio-row" style="margin-top:8px">
            <label class="st-pf-label">גודל הסל:</label>
            <select class="st-pf-select" id="corrBasketN" style="min-width:120px">
                <option value="5">5 נכסים</option><option value="6" selected>6 נכסים</option><option value="7">7 נכסים</option><option value="8">8 נכסים</option>
            </select>
            <button class="corr-run-btn corr-run-primary" id="corrSuggestBtn" onclick="_corrRunSuggest()">בנה הצעת פיזור</button>
        </div>
        <div id="corrSuggestResult"></div>`;
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
    const targetN = parseInt((document.getElementById('corrBasketN') || {}).value, 10) || 6;
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
        // 2) Candidate universe = quality stocks + defensive anchors.
        const anchors = CORR_ANCHORS;
        const universe = [...stockCands.map(s => s.symbol.toUpperCase()), ...anchors.map(a => a.sym)];
        const aligned = await _corrFetchAligned(universe);
        if (aligned.syms.length < 4) { res.innerHTML = '<div class="st-empty">משיכת המחירים נכשלה — נסה שוב בעוד רגע.</div>'; return; }
        const mat = _corrMatrix(aligned);
        const meta = {};
        stockCands.forEach(s => meta[s.symbol.toUpperCase()] = { name: s.company_name, score: s.score, sector: s.sector, kind: 'stock' });
        anchors.forEach(a => meta[a.sym] = { name: a.name, grade: a.grade, kind: a.kind });
        const avail = mat.syms.filter(s => meta[s]);

        // 3) Greedy diversification: seed with the top-scored stock, then repeatedly add the
        //    candidate with the LOWEST average correlation to the already-chosen set. Force at
        //    least one defensive anchor and avoid doubling a sector, for real diversification.
        const chosen = [];
        const seed = avail.filter(s => meta[s].kind === 'stock').sort((a, b) => meta[b].score - meta[a].score)[0];
        if (seed) chosen.push(seed);
        const usedSectors = new Set(seed ? [meta[seed].sector] : []);
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

        // Retain everything so "החלף" (swap) can re-pick without re-fetching, and render.
        _corrSug = { mat, meta, avail, chosen, targetN };
        _corrRenderBasket();
    } catch (e) {
        res.innerHTML = '<div class="st-empty">בניית ההצעה נכשלה — נסה שוב בעוד רגע.</div>';
    } finally {
        _corrBusy = false;
        const b = document.getElementById('corrSuggestBtn'); if (b) { b.disabled = false; b.textContent = 'בנה הצעת פיזור'; }
    }
}

// Render the current suggested basket (re-callable after a swap). Reads _corrSug.
function _corrRenderBasket() {
    const res = document.getElementById('corrSuggestResult');
    if (!res || !_corrSug) return;
    const { mat, meta, chosen } = _corrSug;
    let sum = 0, cnt = 0;
    for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) { sum += mat.M[chosen[i]][chosen[j]] ?? 0; cnt++; }
    const avgPair = cnt ? sum / cnt : 0;
    const roleOf = (s) => {
        const m = meta[s];
        if (m.kind === 'bond') return `אג"ח ${m.grade} · עוגן הגנה`;
        if (m.kind === 'gold') return 'זהב · גידור אינפלציה/משבר';
        const sec = _corrHeSector(m.sector);
        return `מניה${sec ? ' · ' + sec : ''} · ציון ${m.score}`;
    };
    // Portfolio picker for buying / adding the basket.
    const pfList = (typeof clients !== 'undefined' && Array.isArray(clients)) ? clients : [];
    const pfOpts = pfList.map(c => `<option value="${c.id}">${_corrEsc(c.name)}</option>`).join('');
    res.innerHTML = `
        <div class="corr-verdict corr-pos">
            <div class="corr-verdict-head">
                <span class="corr-rho">מתאם הדדי ממוצע: ${(avgPair >= 0 ? '+' : '') + avgPair.toFixed(2)}</span>
                <span class="corr-chip">🛡️ סל מפוזר</span>
            </div>
            <p class="corr-verdict-txt">כל נכס נבחר כי הוא מקזז את התנועה של האחרים (מתאם נמוך/שלילי). לחץ "🔄 החלף" על נכס כדי לקבל חלופה שיושבת על אותו קשר קורלציה. ככל שהמתאם ההדדי הממוצע נמוך יותר — הפיזור טוב יותר.</p>
        </div>
        <div class="st-section-title">הסל המוצע (${chosen.length} נכסים)</div>
        <div class="corr-holds">${chosen.map(s => {
        const m = meta[s]; const disp = s.replace(/\.TA$/, '');
        const scoreChip = m.kind === 'stock' ? `<span class="rep-card-score ${typeof _repScoreClass === 'function' ? _repScoreClass(m.score) : ''}">${m.score}</span>` : `<span class="er-beat er-beat-yes" style="border:none;background:none">${m.grade || ''}</span>`;
        return `<div class="wl-row"><div class="wl-main">
                <div class="wl-id"><span class="wl-tk">${_corrEsc(disp)}</span><span class="wl-co">${_corrEsc(m.name || '')} · ${roleOf(s)}</span></div>
                ${scoreChip}
                <button class="corr-mini-btn" onclick="_corrSwapAsset('${s}')" title="החלף בחלופה דומה">🔄 החלף</button>
                <button class="wl-report" onclick="if(typeof openReportForTicker==='function'){openReportForTicker('${s}');}">📊 דוח</button>
                <button class="corr-mini-btn corr-buy" onclick="_corrBuyAsset('${s}')" title="הוסף לתיק / קנה">➕ קנה</button>
            </div></div>`;
    }).join('')}</div>
        <div class="corr-basket-actions">
            <label class="st-pf-label">בנה תיק מההצעה:</label>
            ${pfOpts ? `<select class="st-pf-select" id="corrBuyPf" style="min-width:180px">${pfOpts}</select>
            <button class="corr-run-btn" onclick="_corrAddBasketToPortfolio()">הוסף את כל הסל לתיק</button>` : ''}
            <button class="corr-run-btn corr-run-primary" onclick="_corrCreatePortfolio()">➕ צור תיק חדש מהסל</button>
        </div>
        <div class="st-section-title">מטריצת הקורלציה של הסל</div>
        ${_corrMatrixHtml({ syms: chosen, M: mat.M })}
        <div class="corr-note">תנאי הסינון: מניות בציון דוחות ≥ ${CORR_MIN_SCORE} ומובילות בסקטור שלהן · עוגני הגנה בדירוג מעל A (אג"ח ממשלת ארה"ב AAA) + זהב · מתאמים אמיתיים על 365 ימי מסחר. ההצעה אינה ייעוץ השקעות.</div>`;
}

// Swap one basket asset for the best available ALTERNATIVE — a candidate not in the basket
// whose average correlation to the rest of the basket is the lowest (same role: a bond swaps
// for a bond, a stock for a stock in a fresh sector), preserving the diversification structure.
function _corrSwapAsset(sym) {
    if (!_corrSug) return;
    const { mat, meta, avail, chosen } = _corrSug;
    const rest = chosen.filter(x => x !== sym);
    const kind = meta[sym].kind;
    const usedSectors = new Set(rest.filter(x => meta[x].kind === 'stock').map(x => meta[x].sector));
    let best = null, bestAvg = 2;
    for (const c of avail) {
        if (chosen.includes(c)) continue;
        if (meta[c].kind !== kind) continue;                                   // like-for-like role
        if (kind === 'stock' && usedSectors.has(meta[c].sector)) continue;     // keep sector spread
        const avg = rest.reduce((a, x) => a + (mat.M[c][x] ?? 0), 0) / (rest.length || 1);
        if (avg < bestAvg) { bestAvg = avg; best = c; }
    }
    if (!best) { if (typeof showToast === 'function') showToast('אין חלופה נוספת מתאימה בסקטור זה', 'info'); return; }
    _corrSug.chosen = chosen.map(x => x === sym ? best : x);
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
    window._corrAssetSuggest = _corrAssetSuggest;
    window._corrRunSuggest = _corrRunSuggest; window._corrToggleSector = _corrToggleSector;
    window._corrSwapAsset = _corrSwapAsset; window._corrBuyAsset = _corrBuyAsset;
    window._corrAddBasketToPortfolio = _corrAddBasketToPortfolio; window._corrCreatePortfolio = _corrCreatePortfolio;
}
