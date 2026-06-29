// ============================================================================
// Finextium — SEC Press-Release / Material-Filing Agent (24/7)
// ----------------------------------------------------------------------------
// Source of truth = the U.S. Securities and Exchange Commission (SEC EDGAR), NOT news sites.
// Companies are legally required to file a Form 8-K ("current report") for MATERIAL events —
// CEO/officer changes (5.02), material agreements (1.01), results (2.02), impairments (2.06),
// delisting notices (3.01), restatements (4.02), unregistered equity sales (3.02), etc. — and the
// actual press release is usually attached as Exhibit 99.x. We pull those 8-Ks directly from EDGAR.
//
// Flow:
//   held_tickers() → ticker→CIK (company_tickers.json) → data.sec.gov/submissions (recent 8-K/6-K)
//   → classify by 8-K item code → pull the EX-99 press-release text → Gemini HE summary/analysis
//   (deterministic fallback) → route_portfolio_alert() fans it to every portfolio holding the ticker.
//   portfolio_alerts is Realtime-enabled → the portfolio's "הוצאות לעיתונות" tab updates live.
//
// Run:  node press-agent.js [--once] [--mock]
// Deploy: PM2 `finextium-press-agent` on the VPS (see vps-agent-deploy memory).
// SEC asks for a descriptive User-Agent with contact info (set SEC_USER_AGENT in .env).
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const AGENT_WRITE_SECRET = process.env.AGENT_WRITE_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SEC_UA = process.env.SEC_USER_AGENT || 'Finextium Research finextium.alerts@gmail.com';
const INTERVAL_MIN = parseFloat(process.env.PRESS_INTERVAL_MIN || '15');
const LOOKBACK_HRS = parseFloat(process.env.PRESS_LOOKBACK_HRS || '36');
const MAX_TICKERS = parseInt(process.env.PRESS_MAX_TICKERS || '60', 10);
const MAX_FILINGS_PER = parseInt(process.env.PRESS_MAX_FILINGS || '4', 10);
const RUN_ONCE = process.argv.includes('--once');
const MOCK = process.argv.includes('--mock');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fail(m) { console.error(`[${new Date().toISOString()}] FATAL:`, m); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) fail('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!AGENT_WRITE_SECRET) fail('Missing AGENT_WRITE_SECRET');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clampSent = (n) => Math.max(-100, Math.min(100, Math.round(Number(n) || 0)));
// Strip control chars (incl. NUL) — Postgres JSONB rejects them ("unsupported Unicode escape").
const clean = (s) => Array.from(String(s == null ? '' : s)).filter(ch => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || c >= 32; }).join('').replace(/\s+/g, ' ').trim();
const CATEGORIES = ['buyback', 'ceo_change', 'guidance_up', 'guidance_down', 'lawsuit', 'ma', 'dividend', 'offering', 'other'];

// ── 8-K item code → {category, baseline sentiment, EN title, HE title} ────────
const SEC_ITEMS = {
    '1.01': { cat: 'ma',            sent:  22, en: 'Entry into a Material Definitive Agreement',                 he: 'כניסה להסכם מהותי' },
    '1.02': { cat: 'other',         sent: -12, en: 'Termination of a Material Definitive Agreement',              he: 'סיום הסכם מהותי' },
    '1.03': { cat: 'lawsuit',       sent: -55, en: 'Bankruptcy or Receivership',                                  he: 'פשיטת רגל / כינוס נכסים' },
    '2.01': { cat: 'ma',            sent:  30, en: 'Completion of Acquisition or Disposition of Assets',          he: 'השלמת רכישה / מכירת נכסים' },
    '2.02': { cat: 'guidance_up',   sent:  10, en: 'Results of Operations and Financial Condition',               he: 'פרסום תוצאות כספיות' },
    '2.03': { cat: 'offering',      sent: -18, en: 'Creation of a Direct Financial Obligation',                   he: 'יצירת התחייבות פיננסית (חוב)' },
    '2.04': { cat: 'offering',      sent: -32, en: 'Triggering Events That Accelerate a Financial Obligation',    he: 'אירוע שמאיץ התחייבות פיננסית' },
    '2.05': { cat: 'guidance_down', sent: -22, en: 'Costs Associated with Exit or Disposal Activities',          he: 'עלויות צמצום / סגירת פעילות' },
    '2.06': { cat: 'guidance_down', sent: -28, en: 'Material Impairments',                                        he: 'ירידת ערך נכסים מהותית (Impairment)' },
    '3.01': { cat: 'lawsuit',       sent: -42, en: 'Notice of Delisting or Failure to Satisfy a Listing Rule',   he: 'אזהרת מחיקה מהמסחר (Delisting)' },
    '3.02': { cat: 'offering',      sent: -26, en: 'Unregistered Sales of Equity Securities',                     he: 'מכירת מניות לא רשומה (דילול)' },
    '3.03': { cat: 'other',         sent: -10, en: 'Material Modification to Rights of Security Holders',         he: 'שינוי בזכויות מחזיקי ניירות' },
    '4.01': { cat: 'other',         sent: -20, en: "Changes in Registrant's Certifying Accountant",              he: 'החלפת רואה החשבון המבקר' },
    '4.02': { cat: 'lawsuit',       sent: -50, en: 'Non-Reliance on Previously Issued Financial Statements',      he: 'אי-הסתמכות על דוחות קודמים (Restatement)' },
    '5.01': { cat: 'ceo_change',    sent:   0, en: 'Changes in Control of Registrant',                            he: 'שינוי שליטה בחברה' },
    '5.02': { cat: 'ceo_change',    sent: -12, en: 'Departure / Appointment of Directors or Principal Officers',  he: 'שינוי בדירקטוריון / הנהלה בכירה' },
    '5.03': { cat: 'other',         sent:   0, en: 'Amendments to Articles of Incorporation or Bylaws',          he: 'תיקון תקנון החברה' },
    '5.07': { cat: 'other',         sent:   0, en: 'Submission of Matters to a Vote of Security Holders',         he: 'תוצאות הצבעת בעלי המניות' },
    '7.01': { cat: 'other',         sent:   6, en: 'Regulation FD Disclosure',                                    he: 'גילוי Reg FD (הודעה לעיתונות)' },
    '8.01': { cat: 'other',         sent:   5, en: 'Other Events',                                                he: 'אירוע מהותי אחר' },
    '9.01': { cat: 'other',         sent:   0, en: 'Financial Statements and Exhibits',                           he: 'דוחות כספיים ונספחים' },
};

// Pick the single most impactful item the 8-K reports (largest |sentiment|).
function secEventFor(itemsStr) {
    const codes = String(itemsStr || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    let best = null;
    for (const c of codes) {
        const m = c.match(/\d\.\d{2}/);
        const e = m && SEC_ITEMS[m[0]];
        if (e && (!best || Math.abs(e.sent) > Math.abs(best.sent))) best = e;
    }
    return best || { cat: 'other', sent: 5, en: 'Material Event (Form 8-K)', he: 'אירוע מהותי (8-K)' };
}

// ── SEC HTTP (descriptive UA required; small timeout so a slow file never stalls) ──
async function secGetText(url) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 9000);
    try {
        const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json, text/html, */*' }, signal: ctrl.signal });
        if (!r.ok) return null;
        return await r.text();
    } catch (e) { return null; } finally { clearTimeout(tm); }
}
async function secGetJSON(url) { const t = await secGetText(url); if (!t) return null; try { return JSON.parse(t); } catch (e) { return null; } }

// ── ticker → CIK map (cached 24h) ────────────────────────────────────────────
let _cikCache = null, _cikAt = 0;
async function loadCikMap() {
    if (_cikCache && Date.now() - _cikAt < 24 * 3600 * 1000) return _cikCache;
    const j = await secGetJSON('https://www.sec.gov/files/company_tickers.json');
    const map = {};
    if (j) for (const k in j) { const e = j[k]; if (e && e.ticker) map[String(e.ticker).toUpperCase()] = e.cik_str; }
    if (Object.keys(map).length) { _cikCache = map; _cikAt = Date.now(); }
    return _cikCache || map;
}

// ── 1. Which tickers do users hold? (secret-gated RPC, bypasses RLS) ──────────
async function heldTickers() {
    const { data, error } = await supabase.rpc('held_tickers', { p_secret: AGENT_WRITE_SECRET });
    if (error) { log('held_tickers error:', error.message); return []; }
    return (data || []).map(r => String(r.ticker || '').toUpperCase()).filter(Boolean).slice(0, MAX_TICKERS);
}

// ── 2. Recent 8-K / 6-K filings for a CIK, within the lookback window ─────────
async function fetchSecFilings(ticker, cik) {
    const cik10 = String(cik).padStart(10, '0');
    const sub = await secGetJSON(`https://data.sec.gov/submissions/CIK${cik10}.json`);
    if (!sub || !sub.filings || !sub.filings.recent || !Array.isArray(sub.filings.recent.form)) return [];
    const r = sub.filings.recent;
    const company = sub.name || ticker;
    const cutoff = Date.now() - LOOKBACK_HRS * 3600 * 1000;
    const cikInt = parseInt(cik10, 10);
    const out = [];
    for (let i = 0; i < r.form.length && out.length < MAX_FILINGS_PER; i++) {
        if (!/^(8-K|6-K)/.test(r.form[i])) continue;
        const when = new Date(r.acceptanceDateTime?.[i] || r.filingDate[i]).getTime();
        if (!(when >= cutoff)) continue;
        const accNoDashes = String(r.accessionNumber[i] || '').replace(/-/g, '');
        out.push({
            ticker, company, form: r.form[i], items: r.items?.[i] || '',
            event: secEventFor(r.items?.[i] || ''), cikInt, accNoDashes,
            primaryDoc: r.primaryDocument?.[i] || '',
            filingDate: r.filingDate[i],
            published_at: new Date(when).toISOString(),
            source_url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/`,
        });
    }
    return out;
}

// Fetch one SEC document, strip to readable text. For the main inline-XBRL 8-K, skip the XBRL tag
// soup + the standard cover page by starting at the first "Item X.XX" (the actual disclosure).
async function fetchSecDocText(cikInt, accNoDashes, name, isMain) {
    const html = await secGetText(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/${name}`);
    if (!html || html.slice(0, 2) === 'PK') return null;                       // binary/zip guard
    if (Array.from(html.slice(0, 300)).some(ch => ch.charCodeAt(0) === 0xFFFD)) return null;
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (isMain) {
        const at = text.search(/Item\s+\d\.\d{2}/);
        if (at > 0) text = text.slice(at);                                     // drop XBRL header + cover
    }
    if (!text || text.length < 50) return null;
    const printable = (text.match(/[\x20-\x7E]/g) || []).length / text.length;
    if (printable < 0.9) return null;                                          // reject binary garbage
    return text.slice(0, 4500);
}

// ── 3. Pull the actual disclosure text: EX-99 press release if present, else the main 8-K body ──
async function fetchPressReleaseText(cikInt, accNoDashes, primaryDoc) {
    const idx = await secGetJSON(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/index.json`);
    const items = idx && idx.directory && Array.isArray(idx.directory.item) ? idx.directory.item : [];
    const htmls = items.filter(f => /\.html?$/i.test(f.name || ''));
    const ex = htmls.find(f => /ex.?99/i.test(f.name || ''))
        || htmls.find(f => /(press|release)/i.test((f.name || '') + ' ' + (f.type || '') + ' ' + (f.description || '')));
    // 1) the EX-99 press release (richest). 2) fall back to the main 8-K body (e.g. MicroStrategy's
    // Reg FD filings, where the material announcement is in the 8-K itself with no exhibit).
    if (ex) {
        const t = await fetchSecDocText(cikInt, accNoDashes, ex.name, false);
        if (t && t.length > 120) return t;
    }
    if (primaryDoc) {
        const t = await fetchSecDocText(cikInt, accNoDashes, primaryDoc, true);
        if (t) return t;
    }
    return null;
}

// ── 4. Build the alert; enrich the Hebrew with Gemini when available ──────────
async function geminiJSON(prompt) {
    if (!GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    return JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text || 'null');
}

async function buildAlert(f) {
    const ev = f.event;
    const prText = await fetchPressReleaseText(f.cikInt, f.accNoDashes, f.primaryDoc);
    const headline = `${f.company} — Form ${f.form}: ${ev.en}`;
    const body = prText || `${f.company} filed a Form ${f.form} with the SEC (Item ${f.items || '—'}: ${ev.en}) on ${f.filingDate}.`;
    const base = {
        ticker: f.ticker, company: f.company, category: ev.cat, sentiment: clampSent(ev.sent), materiality: true,
        summary_he: `${f.ticker} — ${ev.he} · דיווח 8-K שהוגש לרשות ניירות ערך (SEC).`,
        headline_en: headline, body_en: body,
        analysis_he: `החברה הגישה דיווח מיידי (Form ${f.form}) לרשות ניירות ערך האמריקאית בנושא "${ev.he}". דיווחי 8-K מוגשים על-פי חוק רק על אירועים מהותיים, ולכן רלוונטיים ישירות למחזיקים בנכס.`,
        source: 'SEC EDGAR · 8-K', source_url: f.source_url, published_at: f.published_at,
    };
    if (!GEMINI_API_KEY) return base;
    const prompt = [
        'אתה אנליסט אירועים בכיר. לפניך דיווח 8-K שחברה נסחרת הגישה לרשות ניירות ערך האמריקאית (SEC). החזר JSON בלבד.',
        `טיקר: ${f.ticker} | חברה: ${f.company}`,
        `סעיף ה-8-K: ${f.items} (${ev.en})`,
        `טקסט ההודעה לעיתונות (אנגלית, ייתכן חלקי): ${String(body).slice(0, 1200)}`,
        '',
        'החזר אובייקט JSON:',
        '{',
        `  "category": one of ${JSON.stringify(CATEGORIES)},`,
        '  "sentiment": number,        // -100 (שלילי מאוד) עד +100 (חיובי מאוד) — ההשפעה הצפויה על המניה',
        '  "summary_he": "תקציר שורה אחת בעברית פשוטה (TL;DR), כולל המספרים המהותיים אם יש",',
        '  "analysis_he": "2-3 משפטים של ניתוח פונדמנטלי בעברית: מה קרה ומדוע זה מהותי למשקיע"',
        '}',
    ].join('\n');
    try {
        const out = await geminiJSON(prompt);
        if (!out || typeof out !== 'object') return base;
        return {
            ...base,
            category: CATEGORIES.includes(out.category) ? out.category : base.category,
            sentiment: (out.sentiment != null) ? clampSent(out.sentiment) : base.sentiment,
            summary_he: String(out.summary_he || base.summary_he).trim(),
            analysis_he: String(out.analysis_he || base.analysis_he).trim(),
        };
    } catch (e) {
        if (/HTTP 429/.test(e.message)) log(`Gemini 429 on ${f.ticker} — using deterministic SEC classification`);
        else log(`Gemini error on ${f.ticker} (${e.message}) — deterministic`);
        return base;
    }
}

// ── 5. ROUTING: fan the alert out to every portfolio that holds the ticker ────
async function routeAlert(alert) {
    // Sanitize every string field — SEC press-release text can carry NUL/control bytes that
    // Postgres JSONB rejects ("unsupported Unicode escape sequence"). Numbers/booleans pass through.
    const safe = {};
    for (const k in alert) safe[k] = (typeof alert[k] === 'string') ? clean(alert[k]) : alert[k];
    const { data, error } = await supabase.rpc('route_portfolio_alert', { p_secret: AGENT_WRITE_SECRET, p_alert: safe });
    if (error) { log('route error', alert.ticker, error.message); return 0; }
    return Number(data) || 0;
}

// ── --mock smoke test (no SEC/Gemini) ────────────────────────────────────────
const MOCK_ALERTS = [
    { ticker: 'AAPL', company: 'Apple Inc.', category: 'ceo_change', sentiment: -14, summary_he: 'AAPL — שינוי בדירקטוריון / הנהלה בכירה · דיווח 8-K לרשות.', headline_en: 'Apple Inc. — Form 8-K: Departure/Appointment of Directors or Principal Officers', body_en: 'Apple filed a Form 8-K (Item 5.02) reporting an officer transition.', analysis_he: 'דיווח 8-K על שינוי הנהלה — אירוע מהותי המדווח לרשות.', source: 'SEC EDGAR · 8-K' },
    { ticker: 'NVDA', company: 'NVIDIA Corp.', category: 'guidance_up', sentiment: 18, summary_he: 'NVDA — פרסום תוצאות כספיות · דיווח 8-K לרשות.', headline_en: 'NVIDIA Corp. — Form 8-K: Results of Operations and Financial Condition', body_en: 'NVIDIA filed a Form 8-K (Item 2.02) with quarterly results.', analysis_he: 'דיווח תוצאות (8-K, סעיף 2.02) — מהותי למשקיעים.', source: 'SEC EDGAR · 8-K' },
];

async function runCycle() {
    log(`SEC press-agent cycle starting…${MOCK ? ' (MOCK)' : ''}`);
    if (MOCK) {
        for (const a of MOCK_ALERTS) { const n = await routeAlert(Object.assign({}, a, { published_at: new Date().toISOString() })); if (n > 0) log(`✓ ${a.ticker} → ${n} portfolios`); }
        log('MOCK cycle done.'); return;
    }
    const tickers = await heldTickers();
    if (!tickers.length) { log('No held tickers to scan.'); return; }
    const cikMap = await loadCikMap();
    log(`Scanning SEC EDGAR for ${tickers.length} held tickers (lookback ${LOOKBACK_HRS}h)…`);
    let scanned = 0, fired = 0, routed = 0;
    for (const tk of tickers) {
        const cik = cikMap[tk];
        if (!cik) continue;                 // not a US SEC filer (Israeli / many ETFs) → skip
        scanned++;
        const filings = await fetchSecFilings(tk, cik);
        for (const f of filings) {
            try {
                const alert = await buildAlert(f);
                const n = await routeAlert(alert);
                if (n > 0) { fired++; routed += n; log(`✓ ${tk} 8-K [${alert.category}] → ${n} portfolios · ${alert.summary_he}`); }
            } catch (e) { log(`build ${tk} soft-fail:`, e.message); }
            await sleep(350);
        }
        await sleep(250);                   // stay well under SEC's 10 req/s
    }
    log(`Cycle done · scanned ${scanned} SEC filers · ${fired} new filings · ${routed} portfolio rows written.`);
}

async function safeCycle() { try { await runCycle(); } catch (e) { log('Cycle error (retry next interval):', e.message); } }

(async () => {
    log(`Finextium SEC Press-Agent online · interval=${INTERVAL_MIN}min · lookback=${LOOKBACK_HRS}h · gemini=${GEMINI_API_KEY ? 'on' : 'off'}${MOCK ? ' · MOCK' : ''}`);
    await safeCycle();
    if (RUN_ONCE) { log('--once: done.'); process.exit(0); }
    setInterval(safeCycle, Math.max(5, INTERVAL_MIN) * 60 * 1000);
})();
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
