// ========== CONSTANTS - Duplicated from frontend js/data.js ==========

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
    'PLD': 'Real Estate'
};

const BONDS = [
    { id: 'IL_CPI_1', name: 'אג"ח ממשלתי צמוד 0523', type: 'il_cpi', basePrice: 112.5 },
    { id: 'IL_CPI_2', name: 'אג"ח ממשלתי צמוד 0825', type: 'il_cpi', basePrice: 105.8 },
    { id: 'IL_CPI_3', name: 'אג"ח ממשלתי צמוד 1127', type: 'il_cpi', basePrice: 98.3 },
    { id: 'IL_CPI_4', name: 'גליל צמוד 0530', type: 'il_cpi', basePrice: 101.2 },
    { id: 'US_30Y', name: 'US Treasury 30Y (TLT)', type: 'us_30y', ticker: 'TLT', basePrice: 92.0 },
    { id: 'US_30Y_2', name: 'US Treasury Bond ETF (VGLT)', type: 'us_30y', ticker: 'VGLT', basePrice: 58.0 },
];

module.exports = {
    ISRAELI_NAMES,
    NASDAQ_100_TICKERS,
    SP500_TICKERS,
    ALL_TICKERS,
    SECTOR_MAP,
    BONDS
};
