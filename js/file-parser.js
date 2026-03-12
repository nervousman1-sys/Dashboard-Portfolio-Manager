// ========== FILE PARSER - Excel/CSV/PDF Import for Portfolio Holdings ==========

// Column name patterns for auto-detection (Hebrew + English)
const TICKER_COLUMNS = ['סימול', 'נייר ערך', 'שם נייר', 'symbol', 'ticker', 'stock', 'name', 'נכס'];
const SHARES_COLUMNS = ['כמות', 'יחידות', 'shares', 'quantity', 'qty', 'units', 'מספר יחידות'];
const PRICE_COLUMNS = ['מחיר', 'מחיר קנייה', 'עלות ממוצעת', 'מחיר ממוצע', 'price', 'avg price', 'avg cost', 'cost', 'cost basis', 'עלות'];

// ========== EXCEL / CSV PARSING ==========

async function parseExcelFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });

                // Use first sheet
                const sheetName = workbook.SheetNames[0];
                if (!sheetName) { resolve([]); return; }

                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

                if (!rows || rows.length === 0) { resolve([]); return; }

                // Auto-detect column mapping
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

                    if (shares > 0 && avgPrice > 0) {
                        result.push({ ticker, shares, avgPrice });
                    } else if (shares > 0) {
                        // Allow rows with shares but no price (user can fill later)
                        result.push({ ticker, shares, avgPrice: 0 });
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

// ========== PDF PARSING ==========

async function parsePDFFile(file) {
    if (typeof pdfjsLib === 'undefined') {
        console.warn('[FileParser] pdf.js not loaded');
        return [];
    }

    // Set worker source
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n';
        }

        return _extractHoldingsFromText(fullText);
    } catch (err) {
        console.error('[FileParser] PDF parse error:', err);
        return [];
    }
}

// Extract holdings data from raw text using regex patterns
function _extractHoldingsFromText(text) {
    const results = [];
    const lines = text.split('\n');

    // Pattern 1: "TICKER  123  $150.25" or "TICKER  123  150.25"
    const pattern1 = /\b([A-Z]{1,5})\b\s+(\d[\d,]*(?:\.\d+)?)\s+\$?([\d,]+(?:\.\d+)?)/g;

    // Pattern 2: Lines with ticker-like words followed by numbers
    const pattern2 = /\b([A-Z]{2,5})\b.*?(\d[\d,]*)\s+(?:shares?|units?)?\s*.*?\$?([\d,]+\.?\d*)/gi;

    for (const line of lines) {
        let match;

        // Try pattern 1 first
        pattern1.lastIndex = 0;
        while ((match = pattern1.exec(line)) !== null) {
            const ticker = match[1];
            const shares = _cleanNumber(match[2]);
            const price = _cleanNumber(match[3]);

            // Basic validation: ticker looks real, reasonable share count and price
            if (shares > 0 && shares < 10000000 && price > 0.01 && price < 100000) {
                // Avoid common non-ticker words
                if (!_isCommonWord(ticker)) {
                    results.push({ ticker, shares: Math.round(shares), avgPrice: price });
                }
            }
        }
    }

    // Deduplicate by ticker (keep first occurrence)
    const seen = new Set();
    return results.filter(r => {
        if (seen.has(r.ticker)) return false;
        seen.add(r.ticker);
        return true;
    });
}

// ========== HELPERS ==========

function _findMatchingColumn(headers, patterns) {
    // Exact match first
    for (const h of headers) {
        const lower = h.trim().toLowerCase();
        if (patterns.includes(lower)) return h;
    }
    // Partial match
    for (const h of headers) {
        const lower = h.trim().toLowerCase();
        for (const p of patterns) {
            if (lower.includes(p) || p.includes(lower)) return h;
        }
    }
    return null;
}

function _cleanTicker(val) {
    if (!val) return '';
    const str = String(val).trim().toUpperCase();
    // Remove common prefixes/suffixes
    const cleaned = str.replace(/[^A-Z0-9.]/g, '');
    // Must be 1-6 characters and start with a letter
    if (cleaned.length >= 1 && cleaned.length <= 6 && /^[A-Z]/.test(cleaned)) {
        return cleaned;
    }
    return '';
}

function _cleanNumber(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const str = String(val).replace(/[$₪,\s]/g, '').trim();
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
}

function _isCommonWord(word) {
    const common = ['THE', 'AND', 'FOR', 'INC', 'LTD', 'LLC', 'USD', 'ILS', 'ETF', 'NAV', 'NET', 'FEE', 'TAX', 'PCT', 'AVG', 'QTY', 'PER', 'NUM', 'TOT', 'SUM', 'MIN', 'MAX', 'YTD', 'MTD', 'ALL', 'BUY', 'SEL'];
    return common.includes(word);
}

// ========== FILE HANDLER (entry point from dropzone) ==========

async function handleImportFile(file) {
    const name = file.name.toLowerCase();
    const ext = name.split('.').pop();

    if (['xlsx', 'xls', 'csv'].includes(ext)) {
        return await parseExcelFile(file);
    } else if (ext === 'pdf') {
        return await parsePDFFile(file);
    } else {
        alert('סוג קובץ לא נתמך. יש להעלות קובץ Excel, CSV או PDF.');
        return [];
    }
}
