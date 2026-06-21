// ========== FILE PARSER - Excel/CSV/PDF Import for Portfolio Holdings ==========

// Lazy-load xlsx and pdf.js only when needed (not at startup)
let _xlsxLoaded = false;
let _pdfjsLoaded = false;

async function _ensureXLSX() {
    if (_xlsxLoaded || typeof XLSX !== 'undefined') { _xlsxLoaded = true; return true; }
    try {
        await _loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        _xlsxLoaded = true;
        return true;
    } catch (e) {
        console.error('[FileParser] Failed to load xlsx library:', e);
        return false;
    }
}

async function _ensurePDFJS() {
    if (_pdfjsLoaded || typeof pdfjsLib !== 'undefined') { _pdfjsLoaded = true; return true; }
    try {
        await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
        _pdfjsLoaded = true;
        return true;
    } catch (e) {
        console.error('[FileParser] Failed to load pdf.js library:', e);
        return false;
    }
}

function _loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// Column name patterns for auto-detection (Hebrew + English). Ordered most-specific first so the
// matcher prefers an exact concept (e.g. "שם נייר" as a name, "סימול" as a symbol). Kept broad on
// purpose — the goal is to read a holdings table from ANY broker/bank, in any column order, HE/EN.
const TICKER_COLUMNS = ['סימול', 'סימבול', 'symbol', 'ticker', 'סימול (ticker)', 'stock symbol', 'security symbol', 'symbol/cusip', 'מסחר'];
const NAME_COLUMNS = ['שם נייר', 'שם הנייר', 'שם המוצר', 'שם המכשיר', 'שם', 'נייר ערך', 'נכס', 'name', 'security name', 'security description', 'description', 'instrument', 'holding', 'asset name', 'fund name', 'תיאור', 'שם נייר ערך'];
const SHARES_COLUMNS = ['כמות בתיק', 'כמות', 'יחידות', 'כמות יחידות', 'מספר יחידות', "כמות יח'", 'יח\'', 'shares', 'quantity', 'qty', 'units', 'no. of shares', 'number of shares', 'share count', 'position', 'נצבר', 'יתרה', 'ערך נקוב', 'ע.נ.', 'ע"נ', 'par value', 'nominal'];
const PRICE_COLUMNS = ['שער עלות', 'מחיר עלות', 'עלות ממוצעת', 'מחיר ממוצע', 'מחיר קנייה', 'שער קנייה', 'שער רכישה', 'מחיר רכישה', 'עלות', 'avg price', 'average price', 'avg cost', 'average cost', 'cost basis', 'unit cost', 'purchase price', 'book cost', 'price paid', 'מחיר', 'price', 'שער', 'מחיר שוק', 'cost'];
const VALUE_COLUMNS = ['שווי אחזקה', 'שווי אחזקה (₪)', 'שווי אחזקה בש"ח', 'שווי אחזקה במטבע הנייר', 'שווי בש"ח', 'שווי שוק', 'שווי נוכחי', 'שווי', 'market value', 'mkt value', 'market val', 'current value', 'holding value', 'position value', 'total value', 'value', 'שווי כולל'];
const CURRENCY_COLUMNS = ['מטבע הנייר', 'מטבע מסחר', 'מטבע', 'currency', 'ccy', 'curr'];
// Statements that identify a security by a numeric id / ISIN rather than a Latin ticker.
const SECURITY_ID_COLUMNS = ['מספר נייר', 'מספר ני"ע', 'מספר ני״ע', 'מס\' נייר', 'מספר נייר ערך', 'security number', 'security no', 'security id', 'sec id', 'cusip', 'isin', 'sedol', 'wkn', 'valoren', 'מספר'];
const DATE_COLUMNS = ['תאריך קנייה', 'תאריך רכישה', 'תאריך עסקה', 'תאריך ביצוע', 'תאריך פתיחה', 'תאריך', 'purchase date', 'buy date', 'trade date', 'open date', 'value date', 'settlement date', 'date', 'acquired'];

// dd/mm/yyyy · dd.mm.yyyy · dd-mm-yyyy · yyyy-mm-dd (Israeli files are day-first)
const _DATE_TOKEN_RE = /\b(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})\b/;

// Normalizes any cell/token to ISO 'YYYY-MM-DD' (or null).
// Handles Excel serial numbers, Date objects and day-first strings.
function _cleanDate(val) {
    if (val == null || val === '') return null;
    let d = null;
    if (val instanceof Date) d = val;
    else if (typeof val === 'number' && val > 20000 && val < 60000) {
        d = new Date(Math.round((val - 25569) * 86400000)); // Excel serial → epoch
    } else {
        const m = String(val).trim().match(_DATE_TOKEN_RE);
        if (m) {
            let [, a, b, c] = m.map(Number);
            let day, mon, yr;
            if (a > 1900) { yr = a; mon = b; day = c; }          // yyyy-mm-dd
            else {
                day = a; mon = b; yr = c < 100 ? 2000 + c : c;   // dd/mm/yyyy
                if (mon > 12 && day <= 12) { const t = day; day = mon; mon = t; } // mm/dd fallback
            }
            if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) d = new Date(yr, mon - 1, day, 12);
        }
    }
    if (!d || isNaN(d.getTime())) return null;
    const now = new Date();
    if (d > now || d.getFullYear() < 1990) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Finds a purchase-date token among a PDF row's text items
function _findDateInRow(row) {
    for (const item of row) {
        const iso = _cleanDate(item.text);
        if (iso) return iso;
    }
    return null;
}

// ========== EXCEL / CSV PARSING ==========

// Raw sheet rows (header-keyed objects) — shared by the generic and broker parsers
async function _readExcelRows(file) {
    if (!await _ensureXLSX()) { return []; }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                if (!sheetName) { resolve([]); return; }
                resolve(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }) || []);
            } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

async function parseExcelFile(file) {
    if (!await _ensureXLSX()) { return []; }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });

                const sheetName = workbook.SheetNames[0];
                if (!sheetName) { resolve([]); return; }

                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

                if (!rows || rows.length === 0) { resolve([]); return; }

                resolve(_extractHoldingsFromRows(rows));
            } catch (err) {
                console.error('[FileParser] Excel parse error:', err);
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

// ── Universal tabular holdings extractor (Excel/CSV rows → holdings) ──
// Works for ANY broker/bank export, any column order, Hebrew or English. A security is identified
// by whichever of {symbol, security-id/ISIN/CUSIP, name} the file provides; quantity/price are
// taken from their columns and CROSS-FILLED from a market-value column when one is missing; the
// currency is detected (column → symbols → Hebrew-name default) and TASE agorot are auto-converted
// to shekels by checking shares×price/100 ≈ value. Returns [{ticker, stockName, shares, avgPrice,
// currency, buyDate}]. Cash rows are dropped here (separateCashFromHoldings handles cash balance).
function _extractHoldingsFromRows(rows) {
    if (!rows || !rows.length) return [];
    const headers = Object.keys(rows[0]);
    const used = new Set();
    // Resolve dedicated concepts first so one physical column isn't claimed by two roles.
    const symCol = _findMatchingColumn(headers, TICKER_COLUMNS, used);
    const idCol = _findMatchingColumn(headers, SECURITY_ID_COLUMNS, used);
    const nameCol = _findMatchingColumn(headers, NAME_COLUMNS, used);
    const sharesCol = _findMatchingColumn(headers, SHARES_COLUMNS, used);
    const priceCol = _findMatchingColumn(headers, PRICE_COLUMNS, used);
    const valueCol = _findMatchingColumn(headers, VALUE_COLUMNS, used);
    const currCol = _findMatchingColumn(headers, CURRENCY_COLUMNS, used);
    const dateCol = _findMatchingColumn(headers, DATE_COLUMNS, used);

    // Must have at least one identifier column and something quantitative.
    if (!(symCol || idCol || nameCol) || !(sharesCol || valueCol)) {
        console.warn('[FileParser] Not a recognizable holdings table. headers:', headers);
        return [];
    }

    const out = [];
    for (const row of rows) {
        const symRaw = symCol ? String(row[symCol] ?? '').trim() : '';
        const nameRaw = nameCol ? String(row[nameCol] ?? '').trim() : '';
        const idRaw = idCol ? String(row[idCol] ?? '').trim() : '';

        // Cash line → skip (so it isn't added as a bogus security).
        if (_isCashRow(symRaw) || _isCashRow(nameRaw)) continue;

        // Identifier priority: a clean Latin ticker → numeric/ISIN/CUSIP security id → the name.
        let ticker = _cleanTicker(symRaw);
        const idClean = idRaw.replace(/[\s,]/g, '');
        if (!ticker && /^\d{4,}$/.test(idClean)) ticker = idClean;                          // numeric TASE id
        if (!ticker && /^[A-Z]{2}[A-Z0-9]{9,10}$/i.test(idClean)) ticker = idClean.toUpperCase(); // ISIN
        if (!ticker && idClean && /^[A-Z0-9]{5,12}$/i.test(idClean)) ticker = idClean.toUpperCase(); // CUSIP/SEDOL
        const name = nameRaw || symRaw || ticker;
        if (!ticker && name) ticker = name;        // last resort: the name is the identifier
        if (!ticker) continue;

        let shares = _cleanNumber(sharesCol ? row[sharesCol] : 0);
        let price = _cleanNumber(priceCol ? row[priceCol] : 0);
        const value = _cleanNumber(valueCol ? row[valueCol] : 0);

        // Cross-fill missing quantity/price from the market-value column.
        if (!(shares > 0) && value > 0 && price > 0) shares = value / price;
        if (!(price > 0) && value > 0 && shares > 0) price = value / shares;
        if (!(shares > 0)) continue;

        let currency = _detectCurrency(currCol ? row[currCol] : '', name, symRaw, priceCol ? row[priceCol] : '', valueCol ? row[valueCol] : '');
        // Auto-detect agorot (TASE quotes in 1/100 ₪): if shares×price/100 fits the value better.
        if (price > 0 && value > 0) {
            const asWhole = Math.abs(shares * price - value);
            const asAgorot = Math.abs(shares * price / 100 - value);
            if (asAgorot < asWhole) { price = price / 100; currency = 'ILS'; }
        } else if (currency === 'ILS' && /[֐-׿]/.test(name) && price > 200) {
            price = price / 100; // Israeli security, no value to cross-check, price looks like agorot
        }

        out.push({
            ticker: _resolveBrokerTicker(ticker, name, currency === 'ILS'),
            stockName: String(name || ticker).replace(/\s+(INC|LTD|CORP|PLC|בע"מ)\.?$/i, '').trim() || String(name || ticker),
            shares: +(+shares).toFixed(4),
            avgPrice: price > 0 ? +(+price).toFixed(4) : 0,
            currency,
            buyDate: dateCol ? _cleanDate(row[dateCol]) : null,
        });
    }
    return _deduplicateResults(out);
}

// ========== PDF PARSING (position-based row reconstruction) ==========

async function parsePDFFile(file) {
    if (!await _ensurePDFJS()) { return []; }
    if (typeof pdfjsLib === 'undefined') {
        console.warn('[FileParser] pdf.js not loaded');
        return [];
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

        // Collect all text items with positions from all pages
        const allItems = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            for (const item of textContent.items) {
                if (!item.str || !item.str.trim()) continue;
                // transform[5] = y position, transform[4] = x position
                allItems.push({
                    text: item.str.trim(),
                    x: Math.round(item.transform[4]),
                    y: Math.round(item.transform[5]),
                    page: i
                });
            }
        }

        if (allItems.length === 0) return [];

        // Strategy 0: Israeli broker holdings statement (Bank Hapoalim MyTrade, Leumi, …) — these
        // identify securities by a numeric TASE id + Hebrew/Latin name (no Latin ticker), so the
        // generic strategies below find nothing. Try this first when the format is detected.
        const israeliResult = _extractIsraeliBroker(allItems);
        if (israeliResult.length > 0) return israeliResult;

        // Strategy 1: Position-based row reconstruction
        const positionResult = _extractFromPositionedItems(allItems);
        if (positionResult.length > 0) return positionResult;

        // Strategy 2: Flat text fallback (join all text, scan for patterns)
        const flatText = allItems.map(it => it.text).join(' ');
        const flatResult = _extractFromFlatText(flatText);
        if (flatResult.length > 0) return flatResult;

        // Strategy 3: Scan individual text items for tickers and nearby numbers
        return _extractFromScatteredItems(allItems);
    } catch (err) {
        console.error('[FileParser] PDF parse error:', err);
        return [];
    }
}

// Strategy 0: Israeli broker holdings statement (Bank Hapoalim MyTrade etc.).
// Securities are identified by a numeric TASE id ("מספר נייר") + a Hebrew/Latin name, with the
// quantity ("כמות בתיק") and cost rate ("שער עלות") in their own columns. We anchor each row on the
// 6–9 digit security id, read the name, and pick quantity/cost by nearest-X to the detected header
// columns. TASE cost rates are quoted in AGOROT → converted to shekels. Rows stay editable so the
// user confirms before saving — we never invent data we can't read.
function _extractIsraeliBroker(items) {
    const flat = items.map(it => it.text).join(' ');
    // Trigger for any statement that identifies securities by a numeric id (TASE) or carries
    // holdings keywords in Hebrew OR English — the row anchor (6–9 digit id) keeps it precise.
    const idRowCount = items.filter(it => /^\d{6,9}$/.test(String(it.text).replace(/[,\s]/g, ''))).length;
    const looksTabular = /מספר\s*נייר/.test(flat) || /שער\s*עלות/.test(flat) || /תיק עדכני/.test(flat)
        || /MyTrade/i.test(flat) || /כמות בתיק/.test(flat) || /שווי אחזקה/.test(flat)
        || /\b(security number|holdings?|market value|quantity|cusip|isin)\b/i.test(flat)
        || idRowCount >= 2;
    if (!looksTabular) return [];

    // Group items into rows by Y, each sorted left-to-right by X.
    const rowMap = new Map();
    for (const item of items) {
        const yKey = Math.round(item.y / 4) * 4;
        if (!rowMap.has(yKey)) rowMap.set(yKey, []);
        rowMap.get(yKey).push(item);
    }
    const rows = [...rowMap.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => { r.sort((a, b) => a.x - b.x); return r; });

    // Detect the holdings header row → X positions of the quantity and cost columns.
    const cols = { qty: null, cost: null };
    for (const row of rows) {
        const joined = row.map(it => it.text).join(' ');
        const isHeader = SECURITY_ID_COLUMNS.some(h => joined.includes(h)) && (joined.includes('כמות') || joined.includes('שער'));
        if (!isHeader) continue;
        for (const it of row) {
            if (cols.qty == null && /כמות/.test(it.text)) cols.qty = it.x;
            if (cols.cost == null && /עלות/.test(it.text)) cols.cost = it.x;
        }
        break;
    }

    const results = [];
    for (const row of rows) {
        // Anchor: a 6–9 digit security id token.
        const idItem = row.find(it => /^\d{6,9}$/.test(it.text.replace(/[,\s]/g, '')));
        if (!idItem) continue;
        const secId = idItem.text.replace(/[,\s]/g, '');

        // Name: the longest token containing letters (Hebrew or Latin), minus a leading ellipsis.
        let name = '';
        for (const it of row) {
            if (it === idItem) continue;
            const t = it.text.trim().replace(/^[.…]+/, '').trim();
            if (!/[A-Za-z֐-׿]/.test(t)) continue;        // must contain a letter
            if (t.length > name.length) name = t;
        }
        if (!name) continue;

        // Numeric tokens in the row (excluding the id). Keep zeros and strip %/₪/$ so column
        // POSITIONS are preserved — the day-change columns can be 0 and must still hold their slot.
        const nums = row
            .filter(it => it !== idItem)
            .map(it => ({ v: parseFloat(it.text.replace(/[,\s₪$%]/g, '')), x: it.x }))
            .filter(n => isFinite(n.v));
        if (nums.length < 3) continue;

        // Canonical column order (RTL): sort by X DESCENDING → rightmost (first column) first.
        // Bank Hapoalim MyTrade layout:
        //   [שער אחרון, שינוי-יומי-%, שינוי-יומי-מטבע, כמות-בתיק, שווי-במטבע, שווי-בש"ח, שער-עלות]
        const ordered = [...nums].sort((a, b) => b.x - a.x);

        const nearest = (targetX) => {
            if (targetX == null) return null;
            let best = null, bestD = Infinity;
            for (const n of ordered) { const d = Math.abs(n.x - targetX); if (d < bestD) { bestD = d; best = n; } }
            return best ? best.v : null;
        };

        // Prefer header-X mapping (single-line headers); else fall back to the fixed layout indices.
        let qty = nearest(cols.qty);
        let cost = nearest(cols.cost);
        let lastPrice = ordered.length ? ordered[0].v : null;        // first column = שער אחרון
        let valNative = null;
        if (ordered.length >= 7) {
            if (qty == null) qty = ordered[3].v;                     // כמות בתיק
            if (cost == null) cost = ordered[ordered.length - 1].v;  // שער עלות (last column)
            valNative = ordered[ordered.length - 3].v;               // שווי אחזקה במטבע הנייר
        }
        // Last-resort qty: the smallest positive integer in the row (share counts ≪ rates/values).
        if (!(qty > 0)) {
            const ints = ordered.filter(n => Number.isInteger(n.v) && n.v > 0 && n.v < 100000).sort((a, b) => a.v - b.v);
            qty = ints.length ? ints[0].v : 0;
        }
        if (!(qty > 0)) continue;

        // Auto-detect AGOROT vs whole units (currency) WITHOUT guessing from the name:
        // a TASE quote is in agorot iff qty × price/100 ≈ holding value (not qty × price).
        // Hebrew name is the secondary hint when we can't cross-check against a value column.
        let agorot = false;
        if (lastPrice > 0 && valNative > 0) {
            const asWhole = Math.abs(qty * lastPrice - valNative);
            const asAgorot = Math.abs(qty * lastPrice / 100 - valNative);
            agorot = asAgorot < asWhole;
        } else {
            agorot = /[֐-׿]/.test(name);   // fallback: Hebrew security → agorot/shekels
        }
        const factor = agorot ? 100 : 1;
        if (cost != null && cost > 0) cost = cost / factor;          // agorot → shekels
        // Never drop a real holding for a missing cost — fall back to the current rate so it
        // imports (the row stays editable for the user to correct the purchase price).
        if (!(cost > 0) && lastPrice > 0) cost = lastPrice / factor;

        results.push({
            ticker: _resolveBrokerTicker(secId, name, agorot),
            stockName: name.replace(/\s+(INC|LTD|CORP|PLC|בע"מ)\.?$/i, '').trim() || name,
            shares: Math.round(qty),
            avgPrice: cost > 0 ? +cost.toFixed(4) : 0,
            currency: agorot ? 'ILS' : 'USD',
        });
    }
    return _deduplicateResults(results);
}

// Map a broker security (numeric TASE id + name) to a tradable ticker where we confidently can,
// so live pricing works. Israeli securities (agorot) keep their numeric id (resolved downstream /
// editable); for US dual-listed names we map a few well-known ones, else fall back to the id.
const _BROKER_NAME_TICKER = {
    'TERAWULF': 'WULF', 'TERAWULF INC': 'WULF',
    'NVIDIA': 'NVDA', 'APPLE': 'AAPL', 'MICROSOFT': 'MSFT', 'TESLA': 'TSLA', 'AMAZON': 'AMZN',
    'ALPHABET': 'GOOGL', 'META': 'META', 'MICROSTRATEGY': 'MSTR', 'STRATEGY': 'MSTR',
};
function _resolveBrokerTicker(secId, name, agorot) {
    if (!agorot) {  // US/foreign security — try to map the name to a real ticker for live pricing
        const key = String(name || '').toUpperCase().replace(/[.,]/g, '').trim();
        if (_BROKER_NAME_TICKER[key]) return _BROKER_NAME_TICKER[key];
        const firstWord = key.split(/\s+/)[0];
        if (_BROKER_NAME_TICKER[firstWord]) return _BROKER_NAME_TICKER[firstWord];
    }
    return secId;  // TASE numeric id (Israeli securities resolve via the price service)
}

// Strategy 1: Group items into rows by Y position, then parse each row
function _extractFromPositionedItems(items) {
    // Group items by Y position (items within 5px vertically = same row)
    const rowMap = new Map();
    for (const item of items) {
        // Create a rounded Y key (group items within 5px)
        const yKey = Math.round(item.y / 5) * 5;
        if (!rowMap.has(yKey)) rowMap.set(yKey, []);
        rowMap.get(yKey).push(item);
    }

    // Sort rows by Y descending (PDF y=0 is bottom, so top rows have higher Y)
    const sortedRows = [...rowMap.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => {
            // Sort items within row by X position (left to right)
            items.sort((a, b) => a.x - b.x);
            return items;
        });

    // Try to detect header row to understand column positions
    const headerInfo = _detectHeaderRow(sortedRows);

    const results = [];

    for (const row of sortedRows) {
        // Look for ticker pattern in this row
        const tickerMatch = _findTickerInRow(row);
        if (!tickerMatch) continue;

        // Find numbers in this row
        const numbers = _findNumbersInRow(row, tickerMatch.itemIndex);

        if (numbers.length >= 1) {
            // Determine which number is shares and which is price
            const { shares, price } = _classifyNumbers(numbers, headerInfo);
            if (shares > 0) {
                results.push({
                    ticker: tickerMatch.ticker,
                    shares: Math.round(shares),
                    avgPrice: price || 0,
                    buyDate: _findDateInRow(row)
                });
            }
        }
    }

    return _deduplicateResults(results);
}

// Detect header row to understand column mapping
function _detectHeaderRow(sortedRows) {
    const info = { tickerX: null, sharesX: null, priceX: null };

    for (const row of sortedRows) {
        const rowText = row.map(it => it.text).join(' ').toLowerCase();

        // Check if this looks like a header row
        const hasTickerHeader = TICKER_COLUMNS.some(h => rowText.includes(h));
        const hasSharesHeader = SHARES_COLUMNS.some(h => rowText.includes(h));
        const hasPriceHeader = PRICE_COLUMNS.some(h => rowText.includes(h));

        if (hasTickerHeader && (hasSharesHeader || hasPriceHeader)) {
            // Found header row — map column X positions
            for (const item of row) {
                const lower = item.text.toLowerCase();
                if (TICKER_COLUMNS.some(h => lower.includes(h))) info.tickerX = item.x;
                if (SHARES_COLUMNS.some(h => lower.includes(h))) info.sharesX = item.x;
                if (PRICE_COLUMNS.some(h => lower.includes(h))) info.priceX = item.x;
            }
            break;
        }
    }

    return info;
}

// Find a ticker symbol in a row of text items
function _findTickerInRow(row) {
    for (let i = 0; i < row.length; i++) {
        const text = row[i].text.trim();

        // Check for cash/liquidity identifiers (Hebrew or English) before ticker regex
        if (_isCashRow(text)) {
            return { ticker: text, itemIndex: i, x: row[i].x };
        }

        // Match common ticker patterns: AAPL, BRK.B, GOOGL, META
        const tickerPattern = /^([A-Z]{1,6}(?:.[A-Z]{1,2})?)$/;
        const match = text.match(tickerPattern);
        if (match && !_isCommonWord(match[1])) {
            return { ticker: match[1], itemIndex: i, x: row[i].x };
        }
    }
    return null;
}

// Find numeric values in a row (excluding the ticker item and date tokens)
function _findNumbersInRow(row, tickerIndex) {
    const numbers = [];
    for (let i = 0; i < row.length; i++) {
        if (i === tickerIndex) continue;
        if (_DATE_TOKEN_RE.test(row[i].text)) continue; // "12/05/2023" is a date, not shares=12
        const cleaned = row[i].text.replace(/[$₪,\s%]/g, '');
        const num = parseFloat(cleaned);
        if (!isNaN(num) && num > 0) {
            numbers.push({ value: num, x: row[i].x, index: i, raw: row[i].text });
        }
    }
    return numbers;
}

// Classify numbers into shares and price based on column position or heuristics
function _classifyNumbers(numbers, headerInfo) {
    // If we have header position info, use closest X match
    if (headerInfo.sharesX !== null && headerInfo.priceX !== null) {
        let shares = 0, price = 0;
        let bestSharesDist = Infinity, bestPriceDist = Infinity;

        for (const n of numbers) {
            const sharesDist = Math.abs(n.x - headerInfo.sharesX);
            const priceDist = Math.abs(n.x - headerInfo.priceX);

            if (sharesDist < bestSharesDist) {
                bestSharesDist = sharesDist;
                shares = n.value;
            }
            if (priceDist < bestPriceDist) {
                bestPriceDist = priceDist;
                price = n.value;
            }
        }
        return { shares, price };
    }

    // Heuristic: First integer-like number = shares, first decimal = price
    // Or if only integers: smaller ones likely shares, larger likely price/value
    let shares = 0, price = 0;

    // Sort by position in row (left to right)
    const sorted = [...numbers].sort((a, b) => a.x - b.x);

    if (sorted.length === 1) {
        // Only one number: assume shares
        shares = sorted[0].value;
    } else if (sorted.length >= 2) {
        // Look for a whole number (shares) and a decimal number (price)
        const integers = sorted.filter(n => Number.isInteger(n.value) || n.raw.indexOf('.') === -1);
        const decimals = sorted.filter(n => !Number.isInteger(n.value) && n.raw.indexOf('.') !== -1);

        if (integers.length > 0 && decimals.length > 0) {
            // First integer = shares, first decimal = price
            shares = integers[0].value;
            price = decimals[0].value;
        } else {
            // All same type: first = shares (quantity), second = price
            shares = sorted[0].value;
            price = sorted[1].value;
        }
    }

    // Sanity: if shares looks like a price (e.g. 185.2) and price looks like count (e.g. 150), swap
    if (price > 0 && shares > 0 && Number.isInteger(price) && !Number.isInteger(shares) && shares < price) {
        const tmp = shares;
        shares = price;
        price = tmp;
    }

    return { shares, price };
}

// Strategy 2: Extract from flat text using regex
function _extractFromFlatText(text) {
    const results = [];

    // Pattern: TICKER followed by numbers anywhere nearby
    // Handles: "AAPL 150 185.2 27,780 12.50%" or "AAPL אפל 150 185.2"
    const tickerRegex = /\b([A-Z]{1,6}(?:\.[A-Z]{1,2})?)\b/g;
    let match;

    while ((match = tickerRegex.exec(text)) !== null) {
        const ticker = match[1];
        if (_isCommonWord(ticker)) continue;

        // Look at text after the ticker (up to 200 chars or next ticker)
        const afterText = text.substring(match.index + match[0].length, match.index + 200);

        // Find numbers in the following text
        const numMatches = [];
        const numRegex = /(\d[\d,]*(?:\.\d+)?)/g;
        let numMatch;
        while ((numMatch = numRegex.exec(afterText)) !== null) {
            const val = parseFloat(numMatch[1].replace(/,/g, ''));
            if (!isNaN(val) && val > 0 && val < 100000000) {
                numMatches.push(val);
            }
            if (numMatches.length >= 4) break; // enough numbers
        }

        if (numMatches.length >= 2) {
            // Heuristic: first integer-like = shares, first decimal-like = price
            let shares = 0, price = 0;

            for (const n of numMatches) {
                if (shares === 0 && Number.isInteger(n) && n < 1000000) {
                    shares = n;
                } else if (price === 0 && !Number.isInteger(n)) {
                    price = n;
                }
            }

            // Fallback: first = shares, second = price
            if (shares === 0 && numMatches.length >= 1) shares = numMatches[0];
            if (price === 0 && numMatches.length >= 2) price = numMatches[1];

            if (shares > 0) {
                results.push({ ticker, shares: Math.round(shares), avgPrice: price || 0 });
            }
        }
    }

    return _deduplicateResults(results);
}

// Strategy 3: Scan items for tickers, then find nearby numbers
function _extractFromScatteredItems(items) {
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const text = items[i].text.trim();

        // Check for cash/liquidity identifiers first
        let ticker;
        if (_isCashRow(text)) {
            ticker = text;
        } else {
            const tickerPattern = /^([A-Z]{1,6}(?:.[A-Z]{1,2})?)$/;
            const match = text.match(tickerPattern);
            if (!match || _isCommonWord(match[1])) continue;
            ticker = match[1];
        }

        const y = items[i].y;

        // Find numbers on the same line (within 5px Y)
        const nearbyNumbers = [];
        for (let j = 0; j < items.length; j++) {
            if (j === i) continue;
            if (Math.abs(items[j].y - y) > 5) continue;
            const cleaned = items[j].text.replace(/[$₪,\s%]/g, '');
            const num = parseFloat(cleaned);
            if (!isNaN(num) && num > 0) {
                nearbyNumbers.push({ value: num, x: items[j].x, raw: items[j].text });
            }
        }

        nearbyNumbers.sort((a, b) => a.x - b.x);

        if (nearbyNumbers.length >= 2) {
            const integers = nearbyNumbers.filter(n => Number.isInteger(n.value));
            const decimals = nearbyNumbers.filter(n => !Number.isInteger(n.value));

            let shares = integers.length > 0 ? integers[0].value : nearbyNumbers[0].value;
            let price = decimals.length > 0 ? decimals[0].value : nearbyNumbers[1].value;

            results.push({ ticker, shares: Math.round(shares), avgPrice: price || 0 });
        } else if (nearbyNumbers.length === 1) {
            results.push({ ticker, shares: Math.round(nearbyNumbers[0].value), avgPrice: 0 });
        }
    }

    return _deduplicateResults(results);
}

// ========== HELPERS ==========

function _deduplicateResults(results) {
    const seen = new Set();
    return results.filter(r => {
        if (seen.has(r.ticker)) return false;
        seen.add(r.ticker);
        return true;
    });
}

// Normalize a header for tolerant matching: lowercase, strip quotes/punctuation/whitespace runs.
function _normHeader(h) {
    return String(h == null ? '' : h).toLowerCase()
        .replace(/["'`׳״.()\[\]:/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function _findMatchingColumn(headers, patterns, used) {
    const norm = headers.map(h => ({ h, n: _normHeader(h) }));
    const pats = patterns.map(p => _normHeader(p));
    const free = (h) => !used || !used.has(h);
    // 1) exact normalized match
    for (const { h, n } of norm) if (free(h) && pats.includes(n)) { used && used.add(h); return h; }
    // 2) header contains a pattern as a whole word/phrase (pattern length ≥ 2)
    for (const { h, n } of norm) {
        for (const p of pats) {
            if (p.length < 2) continue;
            if (n === p || n.startsWith(p + ' ') || n.endsWith(' ' + p) || n.includes(' ' + p + ' ') || n.includes(p)) { used && used.add(h); return h; }
        }
    }
    // 3) pattern contains the header (header length ≥ 3) — handles abbreviated headers
    for (const { h, n } of norm) {
        if (n.length < 3) continue;
        for (const p of pats) if (p.includes(n)) { used && used.add(h); return h; }
    }
    return null;
}

// Best-effort currency detection from a dedicated cell and/or surrounding text/symbols.
function _detectCurrency(currCell, name, ...textCells) {
    const c = String(currCell == null ? '' : currCell).toUpperCase();
    if (/ILS|NIS|ILA|₪|ש"?ח|שקל|אגור/.test(c) || /\bאג\b/.test(c)) return 'ILS';
    if (/USD|\$|דולר/.test(c)) return 'USD';
    if (/EUR|€|אירו|יורו/.test(c)) return 'EUR';
    if (/GBP|£|ליש"?ט/.test(c)) return 'GBP';
    const blob = [name, ...textCells].map(x => String(x == null ? '' : x)).join(' ');
    if (/₪|ש"?ח|שקל/.test(blob)) return 'ILS';
    if (/€/.test(blob)) return 'EUR';
    if (/£/.test(blob)) return 'GBP';
    if (/\$|USD/.test(blob)) return 'USD';
    return /[֐-׿]/.test(String(name || '')) ? 'ILS' : 'USD'; // Hebrew name → default shekels
}

function _cleanTicker(val) {
    if (!val) return '';
    const str = String(val).trim();

    // Preserve cash/liquidity identifiers (may contain Hebrew or spaces)
    if (_isCashRow(str)) return str;

    const upper = str.toUpperCase();
    const cleaned = upper.replace(/[^A-Z0-9.]/g, '');
    // Allow real tickers up to 10 chars (e.g. TERAWULF, BRK.B, class-share suffixes).
    if (cleaned.length >= 1 && cleaned.length <= 10 && /^[A-Z]/.test(cleaned)) {
        return cleaned;
    }
    return '';
}

function _cleanNumber(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const str = String(val).replace(/[$₪,\s%]/g, '').trim();
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
}

function _isCommonWord(word) {
    const common = ['THE', 'AND', 'FOR', 'INC', 'LTD', 'LLC', 'USD', 'ILS', 'ETF', 'NAV', 'NET', 'FEE', 'TAX', 'PCT', 'AVG', 'QTY', 'PER', 'NUM', 'TOT', 'SUM', 'MIN', 'MAX', 'YTD', 'MTD', 'ALL', 'BUY', 'SEL', 'PDF', 'CSV'];
    return common.includes(word);
}

// ========== CASH ROW DETECTION ==========
// Identifies rows that represent cash/liquidity, not tradable securities.
// These should be added to the portfolio's cash balance, not as holdings.

const CASH_IDENTIFIERS = [
    'cash', 'מזומן', 'מזומנים', 'liquidity', 'נזילות', 'כסף מזומן',
    'cash & equivalents', 'money market', 'פיקדון', 'עו"ש'
];

function _isCashRow(ticker) {
    if (!ticker) return false;
    const lower = ticker.toLowerCase().trim();
    return CASH_IDENTIFIERS.some(id => lower === id || lower.includes(id));
}

// Separates parsed rows into holdings and cash amounts.
// Returns { holdings: Array<{ticker, shares, avgPrice}>, cashTotal: number }
function separateCashFromHoldings(parsedRows) {
    const holdings = [];
    let cashTotal = 0;

    for (const row of parsedRows) {
        if (_isCashRow(row.ticker)) {
            // Cash row: value = shares * avgPrice (or just shares if avgPrice is 0/1)
            const cashValue = row.avgPrice > 0 ? row.shares * row.avgPrice : row.shares;
            cashTotal += cashValue;
        } else {
            holdings.push(row);
        }
    }

    return { holdings, cashTotal };
}

// ========== BROKER STATEMENT PARSER (מיטב טרייד / Israeli broker exports) ==========
//
// Detects a raw broker activity export (תאריך / סוג פעולה / שער ביצוע …) and
// reconstructs the WHOLE portfolio from it:
//   • trades (קניה/מכירה, שח + חו"ל) → current holdings (net shares, true avg
//     cost incl. fees, per-ticker first-buy date) + full trade history
//   • FX conversions (B USD/ILS), deposits/withdrawals/transfers, tax ops
//     (מגן מס / מס עתידי / מס לשלם), and special perks (מבצע חבר מביא חבר —
//     marked as a bonus) → the "extra operations" history
//   • cash: ILS = the latest running balance (יתרה שקלית); USD = Σ converted
//     dollars + Σ foreign-currency cashflows
//
// Israeli securities quote in AGOROT (שער 273.53 = ₪2.7353); US legs are in $.

const _BROKER_HEADERS = ['תאריך', 'סוג פעולה', 'שער ביצוע'];

function _isBrokerExport(headers) {
    const hs = headers.map(h => String(h).trim());
    return _BROKER_HEADERS.every(req => hs.some(h => h.includes(req)));
}

function _brokerNum(v) {
    if (typeof v === 'number') return v;
    if (!v) return 0;
    const n = parseFloat(String(v).replace(/[₪$,\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

function parseBrokerStatement(rows) {
    const col = (r, name) => {
        const k = Object.keys(r).find(h => String(h).includes(name));
        return k !== undefined ? r[k] : '';
    };

    const txs = [];
    for (const r of rows) {
        const date = _cleanDate(col(r, 'תאריך'));
        const action = String(col(r, 'סוג פעולה')).trim();
        const name = String(col(r, 'שם נייר')).trim();
        const symRaw = col(r, 'סימבול') !== '' ? col(r, 'סימבול') : col(r, "מס' נייר");
        const sym = String(symRaw).trim();
        const qty = _brokerNum(col(r, 'כמות'));
        const rate = _brokerNum(col(r, 'שער ביצוע'));
        const isUsd = String(col(r, 'מטבע')).includes('$');
        const fee = _brokerNum(col(r, 'עמלת פעולה')) + _brokerNum(col(r, 'עמלות נלוות'));
        const fxAmt = _brokerNum(col(r, 'תמורה במט'));
        const ilsAmt = _brokerNum(col(r, 'תמורה בשקל'));
        const ilsBal = _brokerNum(col(r, 'יתרה שקלית'));
        if (!date || !action) continue;

        const isTaxName = /מגן מס|מס עתידי|מס לשלם/.test(name);
        const isFxName = /^B\s+(USD|EUR|GBP)/i.test(name);
        const isAlphaSym = /^[A-Z][A-Z0-9.]{0,6}$/i.test(sym) && !/^\d+$/.test(sym);
        const isSecNum = /^\d{5,9}$/.test(sym) && !/^999\d+$/.test(sym) && sym !== '900';

        const base = { date, action, name, sym, qty, rate, fee, fxAmt, ilsAmt, ilsBal, currency: isUsd ? 'USD' : 'ILS' };

        if (isFxName) {
            // המרת מט"ח: qty = הדולרים שנקנו, התמורה בשקלים = העלות
            txs.push({ ...base, kind: 'fx', usd: qty, ils: Math.abs(ilsAmt), fxRate: rate / 100 });
        } else if (isTaxName) {
            const out = /משיכה/.test(action);
            txs.push({ ...base, kind: 'tax', dirOut: out, amount: qty });
        } else if (/קניה|מכירה/.test(action) && (isAlphaSym || isSecNum)) {
            const sell = /מכירה/.test(action);
            const ticker = isAlphaSym ? sym.toUpperCase() : sym;
            const price = isUsd ? rate : rate / 100; // אגורות → ש"ח
            // עלות יחידה אמיתית כולל עמלות — מתוך התמורה בפועל
            const gross = isUsd ? Math.abs(fxAmt) : Math.abs(ilsAmt);
            const unitCost = qty > 0 && gross > 0 ? gross / qty : price;
            txs.push({ ...base, kind: sell ? 'sell' : 'buy', ticker, shares: qty, price, unitCost, stockName: name });
        } else if (/הפקדה/.test(action) && isSecNum && qty > 0) {
            // העברת נייר ערך לתיק (יחידות, לא מזומן) — נספרת כקנייה לצורך האחזקות
            const price = isUsd ? rate : rate / 100;
            txs.push({ ...base, kind: 'secdeposit', ticker: sym, shares: qty, price, unitCost: price, stockName: name });
        } else if (/שונות מזומן/.test(action) || /מבצע/.test(name)) {
            txs.push({ ...base, kind: 'bonus', amount: ilsAmt, special: true });
        } else if (/העברה|הפקדה/.test(action)) {
            txs.push({ ...base, kind: 'deposit', amount: ilsAmt || qty });
        } else if (/משיכה/.test(action)) {
            txs.push({ ...base, kind: 'withdraw', amount: Math.abs(ilsAmt || qty) });
        } else {
            txs.push({ ...base, kind: 'other' });
        }
    }
    if (!txs.length) return null;

    // ── Holdings: net positions from the trade history (oldest first) ──
    const chron = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const pos = new Map(); // ticker → {bought, cost, sold, currency, name, firstBuy}
    for (const t of chron) {
        if (t.kind !== 'buy' && t.kind !== 'sell' && t.kind !== 'secdeposit') continue;
        if (!pos.has(t.ticker)) pos.set(t.ticker, { bought: 0, cost: 0, sold: 0, currency: t.currency, name: t.stockName || t.ticker, firstBuy: t.date });
        const p = pos.get(t.ticker);
        if (t.kind === 'sell') p.sold += t.shares;
        else { p.bought += t.shares; p.cost += t.shares * (t.unitCost || t.price); }
    }
    const holdings = [];
    for (const [ticker, p] of pos) {
        const net = +(p.bought - p.sold).toFixed(4);
        if (net <= 0.0001) continue; // נמכר במלואו — נשאר בהיסטוריה בלבד
        holdings.push({
            ticker,
            shares: net,
            avgPrice: p.bought > 0 ? +(p.cost / p.bought).toFixed(4) : 0,
            currency: p.currency,
            stockName: p.name,
            buyDate: p.firstBuy,
        });
    }

    // ── Cash ──
    // ILS: the most recent row's running balance is authoritative
    const newest = [...txs].sort((a, b) => b.date.localeCompare(a.date))[0];
    const cashIls = Math.max(0, newest ? newest.ilsBal : 0);
    // USD: dollars converted in, minus/plus every foreign-currency cashflow
    let cashUsd = 0;
    for (const t of txs) {
        if (t.kind === 'fx') cashUsd += t.usd;
        else if (t.currency === 'USD') cashUsd += t.fxAmt; // קניות שליליות, מכירות חיוביות
    }
    cashUsd = Math.max(0, +cashUsd.toFixed(2));

    const openDate = chron.length ? chron[0].date : null;
    return { broker: true, holdings, cashUsd, cashIls, openDate, txs };
}

// ========== FILE HANDLER (entry point from dropzone) ==========

async function handleImportFile(file) {
    const name = file.name.toLowerCase();
    const ext = name.split('.').pop();

    let rawRows;
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
        // Broker activity export? (raw rows keyed by the Hebrew headers)
        try {
            const sheetRows = await _readExcelRows(file);
            if (sheetRows.length && _isBrokerExport(Object.keys(sheetRows[0]))) {
                const broker = parseBrokerStatement(sheetRows);
                if (broker && (broker.holdings.length || broker.txs.length)) {
                    console.log(`[FileParser] Broker statement: ${broker.txs.length} ops → ${broker.holdings.length} holdings, ₪${broker.cashIls} + $${broker.cashUsd}`);
                    return broker;
                }
            }
        } catch (e) { console.warn('[FileParser] broker detect failed, falling back:', e.message); }
        rawRows = await parseExcelFile(file);
    } else if (ext === 'pdf') {
        rawRows = await parsePDFFile(file);
    } else {
        alert('סוג קובץ לא נתמך. יש להעלות קובץ Excel, CSV או PDF.');
        return { holdings: [], cashTotal: 0 };
    }

    return separateCashFromHoldings(rawRows);
}
