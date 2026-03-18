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

// Column name patterns for auto-detection (Hebrew + English)
const TICKER_COLUMNS = ['סימול', 'נייר ערך', 'שם נייר', 'symbol', 'ticker', 'stock', 'נכס', 'סימול (ticker)'];
const SHARES_COLUMNS = ['כמות', 'יחידות', 'shares', 'quantity', 'qty', 'units', 'מספר יחידות', 'כמות יחידות'];
const PRICE_COLUMNS = ['מחיר', 'מחיר קנייה', 'עלות ממוצעת', 'מחיר ממוצע', 'price', 'avg price', 'avg cost', 'cost', 'cost basis', 'עלות', 'מחיר שוק'];

// ========== EXCEL / CSV PARSING ==========

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

                const headers = Object.keys(rows[0]);
                const tickerCol = _findMatchingColumn(headers, TICKER_COLUMNS);
                const sharesCol = _findMatchingColumn(headers, SHARES_COLUMNS);
                const priceCol = _findMatchingColumn(headers, PRICE_COLUMNS);

                if (!tickerCol) {
                    console.warn('[FileParser] Could not detect ticker column from headers:', headers);
                    resolve([]);
                    return;
                }

                const result = [];
                for (const row of rows) {
                    const ticker = _cleanTicker(row[tickerCol]);
                    if (!ticker) continue;

                    const shares = _cleanNumber(sharesCol ? row[sharesCol] : 0);
                    const avgPrice = _cleanNumber(priceCol ? row[priceCol] : 0);

                    if (shares > 0) {
                        result.push({ ticker, shares, avgPrice: avgPrice || 0 });
                    }
                }

                resolve(result);
            } catch (err) {
                console.error('[FileParser] Excel parse error:', err);
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
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
                    avgPrice: price || 0
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
        const tickerPattern = /^([A-Z]{1,5}(?:\.[A-Z]{1,2})?)$/;
        const match = text.match(tickerPattern);
        if (match && !_isCommonWord(match[1])) {
            return { ticker: match[1], itemIndex: i, x: row[i].x };
        }
    }
    return null;
}

// Find numeric values in a row (excluding the ticker item)
function _findNumbersInRow(row, tickerIndex) {
    const numbers = [];
    for (let i = 0; i < row.length; i++) {
        if (i === tickerIndex) continue;
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
    const tickerRegex = /\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/g;
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
            const tickerPattern = /^([A-Z]{1,5}(?:\.[A-Z]{1,2})?)$/;
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

function _findMatchingColumn(headers, patterns) {
    // Exact match first (case-insensitive)
    for (const h of headers) {
        const lower = h.trim().toLowerCase();
        for (const p of patterns) {
            if (lower === p.toLowerCase()) return h;
        }
    }
    // Partial match: header contains pattern or pattern contains header
    for (const h of headers) {
        const lower = h.trim().toLowerCase();
        for (const p of patterns) {
            if (lower.includes(p.toLowerCase()) || p.toLowerCase().includes(lower)) return h;
        }
    }
    return null;
}

function _cleanTicker(val) {
    if (!val) return '';
    const str = String(val).trim();

    // Preserve cash/liquidity identifiers (may contain Hebrew or spaces)
    if (_isCashRow(str)) return str;

    const upper = str.toUpperCase();
    const cleaned = upper.replace(/[^A-Z0-9.]/g, '');
    if (cleaned.length >= 1 && cleaned.length <= 6 && /^[A-Z]/.test(cleaned)) {
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

// ========== FILE HANDLER (entry point from dropzone) ==========

async function handleImportFile(file) {
    const name = file.name.toLowerCase();
    const ext = name.split('.').pop();

    let rawRows;
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
        rawRows = await parseExcelFile(file);
    } else if (ext === 'pdf') {
        rawRows = await parsePDFFile(file);
    } else {
        alert('סוג קובץ לא נתמך. יש להעלות קובץ Excel, CSV או PDF.');
        return { holdings: [], cashTotal: 0 };
    }

    return separateCashFromHoldings(rawRows);
}
