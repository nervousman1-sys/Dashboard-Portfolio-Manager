// ========== DATA - Constants & Static Data ==========

// ========== HEBREW NAME MAPPING FOR TASE ASSETS ==========
const HEBREW_NAMES = {
    'TEVA': 'טבע', 'NICE': 'נייס', 'LUMI': 'לאומי', 'BEZQ': 'בזק',
    'ICL': 'כיל', 'HARL': 'הראל', 'DSCT': 'דיסקונט', 'POLI': 'פולי',
    'MZTF': 'מזרחי טפחות', 'TASE': 'הבורסה', 'ELCO': 'אלקו', 'ORA': 'אורה',
    'AMOT': 'אמות', 'AZRG': 'עזריאלי', 'ILDC': 'כלל', 'FIBI': 'הבינלאומי',
    'PHOE': 'הפניקס', 'MGDL': 'מגדל', 'BIMB': 'בנק ירושלים',
    'CEL': 'סלקום', 'PTNR': 'פרטנר', 'ESLT': 'אלביט', 'BIRG': 'ברג',
    'ALHE': 'אלון רבוע כחול', 'SHPG': 'שופרסל', 'AFRE': 'אפריקה ישראל',
    'ARPT': 'ארפט', 'SPNS': 'ספאנס', 'GZIT': 'גזית גלוב',
};

function getHebrewName(holding) {
    if (!holding) return '';
    if (holding.type === 'bond') return holding.name;
    const ticker = (holding.ticker || '').replace('.TA', '').toUpperCase();
    return HEBREW_NAMES[ticker] || '';
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
    'XOM': 'Energy', 'CVX': 'Energy', 'CEG': 'Energy',
    'HON': 'Industrials', 'CTAS': 'Industrials', 'RTX': 'Industrials', 'UPS': 'Industrials',
    'CAT': 'Industrials', 'DE': 'Industrials', 'BA': 'Industrials', 'GE': 'Industrials', 'MMM': 'Industrials',
    'NEE': 'Utilities', 'SO': 'Utilities',
    'PLD': 'Real Estate',
    'MSTR': 'Crypto', 'IBIT': 'Crypto', 'BITO': 'Crypto', 'GBTC': 'Crypto',
    'COIN': 'Crypto', 'MARA': 'Crypto', 'RIOT': 'Crypto', 'CLSK': 'Crypto'
};

const SECTOR_COLORS = {
    'Technology': '#3b82f6', 'Communication': '#06b6d4', 'Consumer Disc.': '#f97316',
    'Consumer Staples': '#84cc16', 'Healthcare': '#ec4899', 'Financials': '#eab308',
    'Energy': '#ef4444', 'Industrials': '#8b5cf6', 'Utilities': '#14b8a6',
    'Real Estate': '#f43f5e', 'Crypto': '#f7931a', 'Bonds': '#a855f7', 'Other': '#64748b'
};

const COLORS = { profit: '#22c55e', loss: '#ef4444', neutral: '#3b82f6', bonds: '#a855f7' };

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
    { id: 'IL_CPI_1', name: 'אג"ח ממשלתי צמוד 0523', type: 'il_cpi', basePrice: 112.5 },
    { id: 'IL_CPI_2', name: 'אג"ח ממשלתי צמוד 0825', type: 'il_cpi', basePrice: 105.8 },
    { id: 'IL_CPI_3', name: 'אג"ח ממשלתי צמוד 1127', type: 'il_cpi', basePrice: 98.3 },
    { id: 'IL_CPI_4', name: 'גליל צמוד 0530', type: 'il_cpi', basePrice: 101.2 },
    { id: 'US_30Y', name: 'US Treasury 30Y (TLT)', type: 'us_30y', ticker: 'TLT', basePrice: 92.0 },
    { id: 'US_30Y_2', name: 'US Treasury Bond ETF (VGLT)', type: 'us_30y', ticker: 'VGLT', basePrice: 58.0 },
];
