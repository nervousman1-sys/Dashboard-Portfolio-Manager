// ========== DATA - Constants & Static Data ==========

// ========== ENGLISH NAME MAPPING FOR TASE ASSETS ==========
const HEBREW_NAMES = {
    // Major Banks
    'LUMI': 'Bank Leumi', 'DSCT': 'Bank Discount', 'MZTF': 'Mizrahi Tefahot Bank',
    'FIBI': 'First International Bank', 'BIMB': 'Bank of Jerusalem', 'POLI': 'Bank Hapoalim BM',
    // Insurance & Finance
    'HARL': 'Harel Insurance', 'PHOE': 'Phoenix Holdings', 'MGDL': 'Migdal Insurance', 'ILDC': 'Clal Insurance',
    // Tech & Telecom
    'NICE': 'NICE Ltd.', 'CEL': 'Cellcom Israel', 'PTNR': 'Partner Communications', 'BEZQ': 'Bezeq',
    // Defense & Industry
    'ESLT': 'Elbit Systems', 'TEVA': 'Teva Pharmaceutical', 'ICL': 'ICL Group',
    // Real Estate
    'AZRG': 'Azrieli Group', 'AMOT': 'Amot Investments', 'GZIT': 'Gazit Globe',
    'ALHE': 'Alon Blue Square',
    // Retail & Consumer
    'SHPG': 'Shufersal', 'ORA': 'Orah', 'ELCO': 'Elco Ltd.',
    // Other
    'TASE': 'Tel Aviv Stock Exchange', 'AFRE': 'Africa Israel', 'ARPT': 'Arapat',
    'SPNS': 'Sapiens International', 'BIRG': 'B.I.R.G.',
    // Additional TA-125 Companies
    'ITMR': 'Itamar Medical', 'ENLT': 'Enlight Renewable Energy', 'DLEKG': 'Delek Group',
    'DELT': 'Delta Galil', 'OPC': 'OPC Energy', 'CRSM': 'Carmel',
    'FTAL': 'Fattal Holdings', 'MVNE': 'Mivne Real Estate', 'SPEN': 'Shapir Engineering',
    'TDRN': 'Tadiran Holdings', 'RMLI': 'Ramli', 'NAWI': 'Nawi',
};

// Hebrew → ticker reverse lookup for backward-compatible Hebrew search
const _HEBREW_TO_TICKER = {
    'לאומי': 'LUMI', 'דיסקונט': 'DSCT', 'מזרחי': 'MZTF', 'טפחות': 'MZTF',
    'בינלאומי': 'FIBI', 'ירושלים': 'BIMB', 'הפועלים': 'POLI', 'פועלים': 'POLI',
    'הראל': 'HARL', 'הפניקס': 'PHOE', 'פניקס': 'PHOE', 'מגדל': 'MGDL', 'כלל': 'ILDC',
    'נייס': 'NICE', 'סלקום': 'CEL', 'פרטנר': 'PTNR', 'בזק': 'BEZQ',
    'אלביט': 'ESLT', 'טבע': 'TEVA', 'כיל': 'ICL',
    'עזריאלי': 'AZRG', 'אמות': 'AMOT', 'גזית': 'GZIT',
    'שופרסל': 'SHPG', 'אלקו': 'ELCO',
    'הבורסה': 'TASE', 'אפריקה': 'AFRE',
    'אנלייט': 'ENLT', 'דלק': 'DLEKG', 'דלתא': 'DELT',
    'פתאל': 'FTAL', 'מבנה': 'MVNE', 'שפיר': 'SPEN',
    'תדיראן': 'TDRN',
};

function getHebrewName(holding) {
    if (!holding) return '';
    if (holding.type === 'bond') return holding.name;
    const rawTicker = (holding.ticker || '').replace('.TA', '').toUpperCase();
    // Israeli funds/ETFs trade by numeric id and aren't in HEBREW_NAMES — use the real
    // name resolved from Israeli sources (funder/bizportal via /api/ilfund), cached here.
    if (/^\d{4,9}$/.test(rawTicker) && typeof window !== 'undefined' && window._ilFundInfo && window._ilFundInfo[rawTicker] && window._ilFundInfo[rawTicker].name) {
        return window._ilFundInfo[rawTicker].name;
    }
    return HEBREW_NAMES[rawTicker] || '';
}

// Reverse lookup: search TASE names by query string (English name, Hebrew, or ticker).
// Returns array of { symbol, name, hebrewName, currency, exchange } for local matches.
function searchHebrewNames(query) {
    if (!query || query.length < 1) return [];
    const q = query.trim().toLowerCase();
    const results = [];

    // Check if query is Hebrew — find matching tickers via reverse lookup
    const hebrewMatchedTickers = new Set();
    for (const [heb, ticker] of Object.entries(_HEBREW_TO_TICKER)) {
        if (heb.includes(q)) hebrewMatchedTickers.add(ticker);
    }

    for (const [ticker, engName] of Object.entries(HEBREW_NAMES)) {
        const matchesEnglish = engName.toLowerCase().includes(q);
        const matchesTicker = ticker.toLowerCase().includes(q);
        const matchesHebrew = hebrewMatchedTickers.has(ticker);
        if (matchesEnglish || matchesTicker || matchesHebrew) {
            results.push({
                symbol: ticker + '.TA',
                name: engName,
                hebrewName: engName,
                currency: 'ILS',
                exchange: 'TASE',
                type: 'Common Stock',
                _localMatch: true
            });
        }
    }
    return results;
}

// Search local BONDS array by name or ID.
// Returns array matching the same shape as searchHebrewNames for unified merge.
function searchLocalBonds(query) {
    if (!query || query.length < 1 || typeof BONDS === 'undefined') return [];
    const q = query.trim().toLowerCase();
    // Match generic bond search terms (Hebrew and English)
    const bondSearchTerms = ['אג', 'גליל', 'שחר', 'גילון', 'מק"מ', 'מקמ',
        'bond', 'treasury', 'gov', 'cpi', 'fixed', 'variable',
        'galil', 'shahar', 'gilon', 'makam'];
    const isBondQuery = bondSearchTerms.some(term => q.includes(term));
    const results = [];
    for (const b of BONDS) {
        const matchesName = b.name.toLowerCase().includes(q);
        const matchesId = b.id.toLowerCase().includes(q);
        const matchesCategory = b.category && b.category.includes(q);
        // Also match Hebrew category name
        const catInfo = b.category && typeof BOND_CATEGORIES !== 'undefined' ? BOND_CATEGORIES[b.category] : null;
        const matchesHebrewCat = catInfo && catInfo.he && catInfo.he.includes(q);
        if (matchesName || matchesId || matchesCategory || matchesHebrewCat || isBondQuery) {
            results.push({
                symbol: b.ticker || b.id,
                name: b.name,
                hebrewName: catInfo ? `${catInfo.he}` : b.name,
                currency: b.type.startsWith('il') ? 'ILS' : 'USD',
                exchange: b.type.startsWith('il') ? 'TASE' : 'NYSE',
                type: 'Bond',
                basePrice: b.basePrice,
                _localMatch: true
            });
        }
    }
    return results;
}

const ISRAELI_NAMES = [
    'יונתן כהן', 'נועה לוי', 'אורי גולדברג', 'מיכל אברהם', 'דניאל שרון',
    'רונית פרידמן', 'עידו מזרחי', 'שירה ביטון', 'אלון דוד', 'תמר רוזנברג',
    'גיל חדד', 'ליאור אוחיון', 'הדס ברקוביץ', 'עומר נחמיאס', 'רותם קפלן',
    'אביגיל שטרן', 'איתי וקנין', 'ענבל סויסה', 'נדב פינטו', 'מאיה הרשקוביץ'
];

const NASDAQ_100_TICKERS = [
    'AAPL', 'MSFT', 'AMZN', 'NVDA', 'GOOGL', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX',
    'AMD', 'ADBE', 'PEP', 'CSCO', 'INTC', 'CMCSA', 'TMUS', 'AMGN', 'TXN', 'QCOM',
    'INTU', 'ISRG', 'AMAT', 'HON', 'BKNG', 'LRCX', 'SBUX', 'MDLZ', 'ADI', 'VRTX',
    'GILD', 'ADP', 'REGN', 'PANW', 'SNPS', 'KLAC', 'CDNS', 'MELI', 'MNST', 'PYPL',
    'CRWD', 'ORLY', 'MAR', 'ABNB', 'MRVL', 'CTAS', 'FTNT', 'CEG', 'DASH', 'NXPI'
];

const SP500_TICKERS = [
    'JPM', 'V', 'UNH', 'XOM', 'MA', 'JNJ', 'PG', 'HD', 'ABBV', 'MRK',
    'CVX', 'LLY', 'BAC', 'KO', 'PFE', 'WMT', 'TMO', 'CRM', 'DIS', 'ABT',
    'DHR', 'VZ', 'NEE', 'PM', 'RTX', 'BMY', 'SCHW', 'UPS', 'T', 'MS',
    'GS', 'BLK', 'LOW', 'SPGI', 'CAT', 'DE', 'BA', 'GE', 'MMM', 'IBM',
    'AXP', 'MDLZ', 'CB', 'CI', 'SO', 'MO', 'PLD', 'TGT', 'ZTS', 'NOW'
];

const ALL_TICKERS = [...new Set([...NASDAQ_100_TICKERS, ...SP500_TICKERS])];

const SECTOR_MAP = {
    'AAPL': 'Technology', 'MSFT': 'Technology', 'NVDA': 'Technology', 'AVGO': 'Technology', 'AMD': 'Technology',
    'ADBE': 'Technology', 'INTC': 'Technology', 'TXN': 'Technology', 'QCOM': 'Technology', 'INTU': 'Technology',
    'AMAT': 'Technology', 'LRCX': 'Technology', 'SNPS': 'Technology', 'KLAC': 'Technology', 'CDNS': 'Technology',
    'MRVL': 'Technology', 'NXPI': 'Technology', 'PANW': 'Technology', 'CRWD': 'Technology', 'FTNT': 'Technology',
    'NOW': 'Technology', 'CRM': 'Technology', 'IBM': 'Technology', 'CSCO': 'Technology', 'ADI': 'Technology', 'DASH': 'Technology',
    'GOOGL': 'Communication', 'META': 'Communication', 'NFLX': 'Communication', 'CMCSA': 'Communication',
    'TMUS': 'Communication', 'DIS': 'Communication', 'T': 'Communication', 'VZ': 'Communication',
    'AMZN': 'Consumer Disc.', 'TSLA': 'Consumer Disc.', 'COST': 'Consumer Disc.', 'SBUX': 'Consumer Disc.',
    'BKNG': 'Consumer Disc.', 'ORLY': 'Consumer Disc.', 'MAR': 'Consumer Disc.', 'ABNB': 'Consumer Disc.',
    'HD': 'Consumer Disc.', 'LOW': 'Consumer Disc.', 'TGT': 'Consumer Disc.', 'MELI': 'Consumer Disc.',
    'PEP': 'Consumer Staples', 'MDLZ': 'Consumer Staples', 'MNST': 'Consumer Staples', 'KO': 'Consumer Staples',
    'PG': 'Consumer Staples', 'WMT': 'Consumer Staples', 'PM': 'Consumer Staples', 'MO': 'Consumer Staples',
    'ISRG': 'Healthcare', 'AMGN': 'Healthcare', 'VRTX': 'Healthcare', 'GILD': 'Healthcare', 'REGN': 'Healthcare',
    'UNH': 'Healthcare', 'JNJ': 'Healthcare', 'ABBV': 'Healthcare', 'MRK': 'Healthcare', 'PFE': 'Healthcare',
    'TMO': 'Healthcare', 'ABT': 'Healthcare', 'DHR': 'Healthcare', 'BMY': 'Healthcare', 'LLY': 'Healthcare',
    'CI': 'Healthcare', 'ZTS': 'Healthcare',
    'JPM': 'Financials', 'V': 'Financials', 'MA': 'Financials', 'BAC': 'Financials', 'SCHW': 'Financials',
    'MS': 'Financials', 'GS': 'Financials', 'BLK': 'Financials', 'SPGI': 'Financials', 'AXP': 'Financials',
    'CB': 'Financials', 'ADP': 'Financials', 'PYPL': 'Financials',
    'XOM': 'Energy', 'CVX': 'Energy', 'CEG': 'Energy', 'COP': 'Energy', 'SLB': 'Energy', 'EOG': 'Energy',
    'ORCL': 'Technology', 'WFC': 'Financials', 'MCD': 'Consumer Disc.', 'NKE': 'Consumer Disc.',
    'HON': 'Industrials', 'CTAS': 'Industrials', 'RTX': 'Industrials', 'UPS': 'Industrials',
    'CAT': 'Industrials', 'DE': 'Industrials', 'BA': 'Industrials', 'GE': 'Industrials', 'MMM': 'Industrials',
    'NEE': 'Utilities', 'SO': 'Utilities',
    'PLD': 'Real Estate',
    'MSTR': 'Crypto', 'IBIT': 'Crypto', 'BITO': 'Crypto', 'GBTC': 'Crypto',
    'COIN': 'Crypto', 'MARA': 'Crypto', 'RIOT': 'Crypto', 'CLSK': 'Crypto', 'HOOD': 'Crypto', 'MTPLF': 'Crypto',
    'MU': 'Technology', 'APP': 'Technology', 'SHOP': 'Technology', 'NET': 'Technology', 'DDOG': 'Technology', 'SNOW': 'Technology', 'ZS': 'Technology',
    // ── Expanded candidate-universe coverage (so no candidate falls into "Other") ──
    'ARM': 'Technology', 'PLTR': 'Technology', 'ANET': 'Technology', 'TSM': 'Technology', 'ASML': 'Technology',
    'CHTR': 'Communication', 'EA': 'Communication', 'TTWO': 'Communication',
    'TJX': 'Consumer Disc.', 'CMG': 'Consumer Disc.',
    'CL': 'Consumer Staples', 'KMB': 'Consumer Staples',
    'C': 'Financials', 'PGR': 'Financials',
    'PSX': 'Energy', 'MPC': 'Energy', 'VLO': 'Energy', 'OXY': 'Energy', 'WMB': 'Energy', 'KMI': 'Energy',
    'UNP': 'Industrials', 'LMT': 'Industrials', 'GD': 'Industrials', 'EMR': 'Industrials', 'ETN': 'Industrials', 'FDX': 'Industrials',
    'LIN': 'Materials', 'SHW': 'Materials', 'FCX': 'Materials', 'ECL': 'Materials', 'NEM': 'Materials', 'APD': 'Materials', 'DOW': 'Materials', 'NUE': 'Materials',
    'DUK': 'Utilities', 'AEP': 'Utilities', 'D': 'Utilities', 'EXC': 'Utilities', 'SRE': 'Utilities', 'XEL': 'Utilities',
    'AMT': 'Real Estate', 'EQIX': 'Real Estate', 'WELL': 'Real Estate', 'SPG': 'Real Estate', 'O': 'Real Estate', 'PSA': 'Real Estate', 'CCI': 'Real Estate',
    // ── Deeper bench (more options per sector for the swap) ──
    'APH': 'Technology', 'OMC': 'Communication', 'WBD': 'Communication',
    'GM': 'Consumer Disc.', 'F': 'Consumer Disc.', 'ROST': 'Consumer Disc.',
    'KHC': 'Consumer Staples', 'KDP': 'Consumer Staples', 'STZ': 'Consumer Staples',
    'MDT': 'Healthcare', 'CVS': 'Healthcare', 'ELV': 'Healthcare', 'SYK': 'Healthcare',
    'USB': 'Financials', 'PNC': 'Financials', 'TFC': 'Financials', 'ICE': 'Financials', 'CME': 'Financials', 'MMC': 'Financials',
    'OKE': 'Energy', 'HES': 'Energy', 'DVN': 'Energy',
    'NOC': 'Industrials', 'CSX': 'Industrials', 'NSC': 'Industrials', 'ITW': 'Industrials',
    'CTVA': 'Materials', 'DD': 'Materials', 'VMC': 'Materials', 'MLM': 'Materials',
    'PEG': 'Utilities', 'ED': 'Utilities', 'WEC': 'Utilities',
    'DLR': 'Real Estate', 'VICI': 'Real Estate', 'AVB': 'Real Estate',
    'HUT': 'Crypto', 'BITF': 'Crypto', 'CIFR': 'Crypto', 'WULF': 'Crypto'
};

// Common Israeli (TA) stocks → their dashboard sector. Used to tag Israeli names under the
// "מניות מהשוק הישראלי" group with the real sector shown inside. (Banks/insurance → Financials.)
const IL_STOCK_SECTORS = {
    'LUMI': 'Financials', 'POLI': 'Financials', 'DSCT': 'Financials', 'FIBI': 'Financials', 'MZTF': 'Financials',
    'HARL': 'Financials', 'PHOE': 'Financials', 'MGDL': 'Financials', 'CLIS': 'Financials', 'BEZQ': 'Communication',
    'TEVA': 'Healthcare', 'NICE': 'Technology', 'CYBR': 'Technology', 'NVMI': 'Technology', 'CAMT': 'Technology',
    'TSEM': 'Technology', 'ELTR': 'Industrials', 'ESLT': 'Industrials', 'NESR': 'Energy', 'ICL': 'Materials',
    'ORA': 'Energy', 'AZRG': 'Real Estate', 'MLSR': 'Real Estate', 'BIG': 'Real Estate', 'SPEN': 'Real Estate',
    'SAE': 'Consumer Disc.', 'DELT': 'Consumer Disc.', 'FOX': 'Consumer Disc.', 'OPCE': 'Utilities', 'ENLT': 'Utilities',
};

const SECTOR_COLORS = {
    'Technology': '#3b82f6', 'Communication': '#06b6d4', 'Consumer Disc.': '#f97316',
    'Consumer Staples': '#84cc16', 'Healthcare': '#ec4899', 'Financials': '#eab308',
    'Energy': '#ef4444', 'Industrials': '#8b5cf6', 'Utilities': '#14b8a6',
    'Real Estate': '#f43f5e', 'Materials': '#10b981', 'Crypto': '#f7931a', 'Bonds': '#a855f7', 'Other': '#64748b',
    'תעודות סל עוקבות מדד': '#22d3ee', 'סחורות': '#d4af37'
};

const COLORS = { profit: '#22c55e', loss: '#ef4444', neutral: '#3b82f6', bonds: '#a855f7' };

// Known US ETFs / index funds — tagged "תעודת סל" instead of "מניה" (e.g. SPY = S&P 500 ETF).
const US_ETF_TICKERS = new Set([
    // Broad market / index
    'SPY', 'VOO', 'IVV', 'VTI', 'VT', 'QQQ', 'QQQM', 'ONEQ', 'DIA', 'IWM', 'IWB', 'IWV', 'RSP', 'MDY', 'IJH', 'IJR', 'VB', 'VO', 'VV', 'SCHX', 'SCHB', 'ITOT',
    // Style / factor
    'VUG', 'VTV', 'IWF', 'IWD', 'SCHG', 'SCHD', 'VYM', 'VIG', 'DGRO', 'MOAT', 'QUAL', 'MTUM', 'USMV', 'SPLG',
    // Income
    'JEPI', 'JEPQ', 'DIVO', 'SCHY',
    // International
    'VEA', 'VWO', 'EEM', 'EFA', 'IEFA', 'IEMG', 'VXUS', 'ACWI', 'EWJ', 'EWZ', 'FXI', 'MCHI', 'INDA', 'EWG', 'EWU', 'EWT', 'EWY',
    // Bonds
    'AGG', 'BND', 'BNDX', 'LQD', 'HYG', 'JNK', 'TLT', 'IEF', 'SHY', 'GOVT', 'TIP', 'VCIT', 'VCSH', 'MUB', 'BIL', 'SGOV', 'VGIT', 'VGLT',
    // Commodities / crypto
    'GLD', 'IAU', 'GLDM', 'SGOL', 'SLV', 'USO', 'UNG', 'DBC', 'PDBC', 'IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITO', 'ETHE',
    // Sector / industry
    'SOXX', 'SMH', 'XSD', 'VGT', 'IYW', 'FTEC', 'VHT', 'IYH', 'IBB', 'XBI', 'VFH', 'IYF', 'KRE', 'KBE', 'VDE', 'IYE', 'VCR', 'VDC', 'VIS', 'VOX', 'VAW', 'VPU', 'VNQ', 'IYR', 'ITB', 'XHB', 'JETS', 'TAN', 'ICLN', 'LIT', 'XME', 'GDX', 'GDXJ',
    // Thematic
    'ARKK', 'ARKG', 'ARKW', 'ARKF', 'BOTZ', 'ROBO', 'AIQ', 'IRBO', 'ROBT', 'HACK', 'CIBR', 'SKYY', 'FINX', 'MJ',
]);
function isUsEtf(ticker) {
    const t = String(ticker || '').replace(/\.TA$/i, '').toUpperCase();
    if (!t) return false;
    if (US_ETF_TICKERS.has(t)) return true;
    if (/^XL[A-Z]{1,2}$/.test(t)) return true;   // SPDR sector ETFs (XLF, XLK, XLRE…)
    return false;
}
// The Hebrew asset-type label for a holding's badge. ETFs (US known set + Israeli funds
// resolved from local sources) are tagged correctly instead of the default "מניה".
function assetTypeLabel(h) {
    if (!h) return '';
    const t = String(h.ticker || '').replace(/\.TA$/i, '').toUpperCase();
    if (isUsEtf(t)) return 'תעודת סל';
    if (typeof window !== 'undefined' && window._ilFundInfo && window._ilFundInfo[t] && window._ilFundInfo[t].type) return window._ilFundInfo[t].type;
    if (h.typeLabel) return h.typeLabel;
    return h.type === 'bond' ? 'אג"ח' : h.type === 'index' ? 'מדד' : h.type === 'crypto' ? 'קריפטו' : 'מניה';
}
// GICS (reports-page taxonomy) → the dashboard's sector taxonomy.
const GICS_TO_DASH = {
    'Information Technology': 'Technology', 'Health Care': 'Healthcare', 'Communication Services': 'Communication',
    'Consumer Discretionary': 'Consumer Disc.', 'Consumer Staples': 'Consumer Staples', 'Financials': 'Financials',
    'Energy': 'Energy', 'Industrials': 'Industrials', 'Utilities': 'Utilities', 'Real Estate': 'Real Estate', 'Materials': 'Materials',
};
// AUTOMATIC sector resolver for ANY ticker: dashboard map → US-ETF → the reports page's
// sector data (cached in localStorage, GICS normalised → dashboard taxonomy) → 'Other'.
// This reuses the well-organised sector classification already collected on the reports page.
function resolveSectorFor(ticker) {
    const t = String(ticker || '').replace(/\.TA$/i, '').toUpperCase();
    if (!t) return 'Other';
    if (typeof SECTOR_MAP !== 'undefined' && SECTOR_MAP[t]) return SECTOR_MAP[t];
    if (typeof IL_STOCK_SECTORS !== 'undefined' && IL_STOCK_SECTORS[t]) return IL_STOCK_SECTORS[t];
    if (typeof isUsEtf === 'function' && isUsEtf(t)) return 'תעודות סל';
    if (typeof window !== 'undefined' && window._ilFundInfo && window._ilFundInfo[t]) return 'תעודות סל';
    try {
        for (const key of ['rep_uni_us_v3', 'rep_uni_il_v3']) {
            const c = JSON.parse(localStorage.getItem(key) || 'null');
            const map = c && c.sectors;
            const g = map && (map[t] || map[t + '.TA']);   // IL reports keys carry the .TA suffix
            if (g) return GICS_TO_DASH[g] || _REP_IL_SECTOR_TO_DASH[g] || g;
        }
    } catch (e) { /* ignore */ }
    return 'Other';
}
// TA-125 (reports) sector strings → dashboard taxonomy.
const _REP_IL_SECTOR_TO_DASH = {
    'Banks': 'Financials', 'Insurance': 'Financials', 'Financial Services': 'Financials', 'Investment & Holdings': 'Financials',
    'Real-Estate & Construction': 'Real Estate', 'Construction': 'Real Estate', 'Biomed': 'Healthcare', 'Pharmaceuticals': 'Healthcare',
    'Medical Equipment': 'Healthcare', 'Internet And Software': 'Technology', 'IT Services': 'Technology', 'Semiconductors': 'Technology',
    'Electronics And Optics': 'Technology', 'Communications & Media': 'Communication', 'Energy': 'Energy', 'Cleantech': 'Utilities',
    'Food': 'Consumer Staples', 'Commerce': 'Consumer Disc.', 'Services': 'Consumer Disc.', 'Defense': 'Industrials',
};
// Dashboard sector (English) → Hebrew label, for in-card display.
const SECTOR_HE = {
    'Technology': 'טכנולוגיה', 'Communication': 'תקשורת', 'Consumer Disc.': 'צריכה מחזורית', 'Consumer Staples': 'מוצרי צריכה',
    'Healthcare': 'בריאות', 'Financials': 'פיננסים', 'Energy': 'אנרגיה', 'Industrials': 'תעשייה', 'Utilities': 'תשתיות וחשמל',
    'Real Estate': 'נדל"ן', 'Materials': 'חומרי גלם', 'Crypto': 'קריפטו', 'תעודות סל': 'תעודת סל', 'Other': 'אחר',
};

// Sector ETFs → the sector they track (folded INTO that sector in the breakdown).
const SECTOR_ETF_MAP = {
    XLF: 'Financials', VFH: 'Financials', IYF: 'Financials', KRE: 'Financials', KBE: 'Financials',
    XLK: 'Technology', VGT: 'Technology', IYW: 'Technology', FTEC: 'Technology', SOXX: 'Technology', SMH: 'Technology', XSD: 'Technology', FTXL: 'Technology',
    XLE: 'Energy', VDE: 'Energy', IYE: 'Energy', XOP: 'Energy', OIH: 'Energy',
    XLV: 'Healthcare', VHT: 'Healthcare', IYH: 'Healthcare', IBB: 'Healthcare', XBI: 'Healthcare',
    XLI: 'Industrials', VIS: 'Industrials', IYJ: 'Industrials', JETS: 'Industrials',
    XLP: 'Consumer Staples', VDC: 'Consumer Staples', KXI: 'Consumer Staples',
    XLY: 'Consumer Disc.', VCR: 'Consumer Disc.', IYC: 'Consumer Disc.', ITB: 'Consumer Disc.', XHB: 'Consumer Disc.',
    XLC: 'Communication', VOX: 'Communication',
    XLB: 'Materials', VAW: 'Materials', IYM: 'Materials', GDX: 'Materials', GDXJ: 'Materials', XME: 'Materials', LIT: 'Materials',
    XLU: 'Utilities', VPU: 'Utilities', IDU: 'Utilities', TAN: 'Utilities', ICLN: 'Utilities',
    XLRE: 'Real Estate', VNQ: 'Real Estate', IYR: 'Real Estate',
};
// Broad index-tracking ETFs → grouped together under "תעודות סל עוקבות מדד".
const INDEX_ETF_SET = new Set([
    'SPY', 'VOO', 'IVV', 'SPLG', 'VTI', 'VT', 'ITOT', 'SCHB', 'SCHX', 'QQQ', 'QQQM', 'ONEQ', 'DIA', 'IWM', 'IWB', 'IWV', 'RSP',
    'MDY', 'IJH', 'IJR', 'VB', 'VO', 'VV', 'VUG', 'VTV', 'IWF', 'IWD', 'SCHG', 'SCHD', 'VXUS', 'ACWI', 'VEA', 'VWO', 'EEM', 'EFA', 'IEFA', 'IEMG',
]);
const BOND_ETF_SET = new Set(['AGG', 'BND', 'BNDX', 'LQD', 'HYG', 'JNK', 'TLT', 'IEF', 'SHY', 'GOVT', 'TIP', 'VCIT', 'VCSH', 'MUB', 'BIL', 'SGOV', 'VGIT', 'VGLT']);
const COMMODITY_ETF_SET = new Set(['GLD', 'IAU', 'GLDM', 'SGOL', 'SLV', 'USO', 'UNG', 'DBC', 'PDBC']);
const CRYPTO_ETF_SET = new Set(['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITO', 'ETHE']);

// Resolve the SECTOR-BREAKDOWN bucket for a holding:
//  • sector ETF (XLF, SOXX…) → the sector it tracks
//  • broad index tracker (SPY, QQQ, קסם S&P 500 KTF…) → "תעודות סל עוקבות מדד"
//  • bond/commodity/crypto ETF → Bonds / סחורות / Crypto
//  • otherwise → the stock's own sector
function resolveHoldingSector(h) {
    if (!h) return 'Other';
    const t = String(h.ticker || '').replace(/\.TA$/i, '').toUpperCase();
    if (SECTOR_ETF_MAP[t]) return SECTOR_ETF_MAP[t];
    if (BOND_ETF_SET.has(t)) return 'Bonds';
    if (COMMODITY_ETF_SET.has(t)) return 'סחורות';
    if (CRYPTO_ETF_SET.has(t)) return 'Crypto';
    if (INDEX_ETF_SET.has(t)) return 'תעודות סל עוקבות מדד';
    // Israeli index-tracking funds (numeric id) — detect by the resolved fund name.
    const info = (typeof window !== 'undefined' && window._ilFundInfo) ? window._ilFundInfo[t] : null;
    if (info && /S&P|נאסד|מדד|ת["״]?א|MSCI|דאו|index|טק|נאסדק/i.test(info.name || '')) return 'תעודות סל עוקבות מדד';
    return h.sector || (typeof resolveSectorFor === 'function' ? resolveSectorFor(t) : null) || 'Other';
}

// True if a holding should be treated/styled as a fund/ETF (for the badge class).
function isFundLike(h) {
    if (!h) return false;
    const t = String(h.ticker || '').replace(/\.TA$/i, '').toUpperCase();
    return isUsEtf(t) || !!(typeof window !== 'undefined' && window._ilFundInfo && window._ilFundInfo[t]);
}

// Macro event category mapping for Hebrew labels
const MACRO_CATEGORY_MAP = {
    'Inflation Rate': 'אינפלציה', 'Core Inflation Rate': 'אינפלציה', 'CPI': 'אינפלציה',
    'Producer Prices': 'אינפלציה', 'PPI': 'אינפלציה', 'Consumer Price Index': 'אינפלציה',
    'GDP': 'צמיחה', 'GDP Growth Rate': 'צמיחה', 'GDP Annual Growth Rate': 'צמיחה',
    'Unemployment Rate': 'תעסוקה', 'Non Farm Payrolls': 'תעסוקה', 'Initial Jobless Claims': 'תעסוקה',
    'Continuing Jobless Claims': 'תעסוקה', 'ADP Employment Change': 'תעסוקה', 'Nonfarm Payrolls': 'תעסוקה',
    'Interest Rate': 'מדיניות מוניטרית', 'Interest Rate Decision': 'מדיניות מוניטרית', 'Fed Interest Rate Decision': 'מדיניות מוניטרית',
    'ISM Manufacturing PMI': 'ייצור', 'Manufacturing PMI': 'ייצור', 'ISM Services PMI': 'ייצור',
    'Retail Sales': 'צריכה', 'Retail Sales MoM': 'צריכה', 'Retail Sales YoY': 'צריכה',
    'Building Permits': 'נדל"ן', 'Housing Starts': 'נדל"ן', 'New Home Sales': 'נדל"ן', 'Existing Home Sales': 'נדל"ן',
    'Consumer Confidence': 'סנטימנט', 'Michigan Consumer Sentiment': 'סנטימנט',
    'Trade Balance': 'סחר', 'Durable Goods Orders': 'ייצור', 'Industrial Production': 'ייצור',
    'Personal Income': 'צריכה', 'Personal Spending': 'צריכה', 'PCE Price Index': 'אינפלציה',
    'Core PCE Price Index': 'אינפלציה'
};

const BONDS = [
    // --- Galil (CPI-Linked / צמוד מדד) ---
    { id: 'IL_CPI_1',  name: 'Galil 0523',  type: 'il_cpi',    category: 'galil',  basePrice: 112.5 },
    { id: 'IL_CPI_2',  name: 'Galil 0825',  type: 'il_cpi',    category: 'galil',  basePrice: 105.8 },
    { id: 'IL_CPI_3',  name: 'Galil 1127',  type: 'il_cpi',    category: 'galil',  basePrice: 98.3 },
    { id: 'IL_CPI_4',  name: 'Galil 0530',  type: 'il_cpi',    category: 'galil',  basePrice: 101.2 },
    { id: 'IL_CPI_5',  name: 'Galil 0835',  type: 'il_cpi',    category: 'galil',  basePrice: 96.7 },
    { id: 'IL_CPI_6',  name: 'Galil 1140',  type: 'il_cpi',    category: 'galil',  basePrice: 94.1 },
    { id: 'IL_CPI_7',  name: 'Galil 0545',  type: 'il_cpi',    category: 'galil',  basePrice: 91.8 },
    // --- Shahar (Fixed Rate / שקלית קבועה) ---
    { id: 'IL_SHAHAR_1', name: 'Shahar 0125', type: 'il_fixed', category: 'shahar', basePrice: 99.2 },
    { id: 'IL_SHAHAR_2', name: 'Shahar 0327', type: 'il_fixed', category: 'shahar', basePrice: 97.5 },
    { id: 'IL_SHAHAR_3', name: 'Shahar 0130', type: 'il_fixed', category: 'shahar', basePrice: 95.0 },
    { id: 'IL_SHAHAR_4', name: 'Shahar 0732', type: 'il_fixed', category: 'shahar', basePrice: 93.3 },
    { id: 'IL_SHAHAR_5', name: 'Shahar 0135', type: 'il_fixed', category: 'shahar', basePrice: 90.8 },
    { id: 'IL_SHAHAR_6', name: 'Shahar 0140', type: 'il_fixed', category: 'shahar', basePrice: 87.2 },
    { id: 'IL_SHAHAR_7', name: 'Shahar 0345', type: 'il_fixed', category: 'shahar', basePrice: 84.5 },
    // --- Gilon (Variable Rate / ריבית משתנה) ---
    { id: 'IL_GILON_1', name: 'Gilon 0225',  type: 'il_var',   category: 'gilon',  basePrice: 100.1 },
    { id: 'IL_GILON_2', name: 'Gilon 0326',  type: 'il_var',   category: 'gilon',  basePrice: 100.3 },
    { id: 'IL_GILON_3', name: 'Gilon 0627',  type: 'il_var',   category: 'gilon',  basePrice: 100.2 },
    { id: 'IL_GILON_4', name: 'Gilon 0928',  type: 'il_var',   category: 'gilon',  basePrice: 100.0 },
    // --- Makam (Short-Term / קצר מאוד, בלי ריבית) ---
    { id: 'IL_MAKAM_1', name: 'Makam 0125',  type: 'il_makam',  category: 'makam', basePrice: 99.8 },
    { id: 'IL_MAKAM_2', name: 'Makam 0425',  type: 'il_makam',  category: 'makam', basePrice: 99.5 },
    { id: 'IL_MAKAM_3', name: 'Makam 0725',  type: 'il_makam',  category: 'makam', basePrice: 99.1 },
    { id: 'IL_MAKAM_4', name: 'Makam 1025',  type: 'il_makam',  category: 'makam', basePrice: 98.9 },
    { id: 'IL_MAKAM_5', name: 'Makam 0126',  type: 'il_makam',  category: 'makam', basePrice: 98.5 },
    // --- US Treasury ---
    { id: 'US_30Y',   name: 'US Treasury 30Y (TLT)',       type: 'us_30y', ticker: 'TLT',  basePrice: 92.0 },
    { id: 'US_30Y_2', name: 'US Treasury Bond ETF (VGLT)', type: 'us_30y', ticker: 'VGLT', basePrice: 58.0 },
];

// Bond category display names — used for search and display
const BOND_CATEGORIES = {
    galil:  { en: 'Galil',  he: 'גליל (צמוד מדד)',       desc: 'CPI-Linked' },
    shahar: { en: 'Shahar', he: 'שחר (שקלית קבועה)',      desc: 'Fixed Rate' },
    gilon:  { en: 'Gilon',  he: 'גילון (ריבית משתנה)',     desc: 'Variable Rate' },
    makam:  { en: 'Makam',  he: 'מק"מ (קצר מועד)',         desc: 'Short-Term' },
};
