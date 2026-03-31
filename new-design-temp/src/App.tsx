/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  PieChart as PieChartIcon, 
  RefreshCw, 
  Settings, 
  Edit3,
  Lock,
  Bell, 
  Search, 
  Plus, 
  MoreVertical,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  BarChart3,
  Users,
  ArrowLeftRight,
  FileText,
  Filter,
  Maximize2,
  X,
  TrendingUp,
  History,
  CheckCircle2,
  AlertCircle,
  LayoutGrid,
  List as ListIcon,
  Check,
  LogOut,
  Cpu,
  Brain,
  LineChart,
  ShieldCheck,
  MessageSquare,
  Globe
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  Tooltip, 
  Cell, 
  PieChart as RePieChart, 
  Pie,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';

// --- Mock Data ---

const SECTOR_ALLOCATION = [
  { name: 'טכנולוגיה', value: 35, color: '#00e5ff' },
  { name: 'פיננסים', value: 25, color: '#00FF94' },
  { name: 'קריפטו', value: 20, color: '#C084FC' },
  { name: 'תקשורת', value: 10, color: '#F87171' },
  { name: 'אחר', value: 10, color: '#FACC15' },
];

const ANALYTICS_DATA = [
  { name: 'Jan', value: 400, benchmark: 380 },
  { name: 'Feb', value: 450, benchmark: 410 },
  { name: 'Mar', value: 420, benchmark: 400 },
  { name: 'Apr', value: 500, benchmark: 440 },
  { name: 'May', value: 580, benchmark: 480 },
  { name: 'Jun', value: 620, benchmark: 510 },
];

const RISK_DISTRIBUTION = [
  { name: 'נמוך', value: 45, color: '#00FF94' },
  { name: 'בינוני', value: 35, color: '#F59E0B' },
  { name: 'גבוה', value: 20, color: '#FF4D4D' },
];

const CLIENTS = [
  {
    id: 1,
    name: 'תיק סיימון',
    risk: 'סיכון גבוה',
    riskColor: 'text-danger bg-danger/10',
    yield: '+17.06%',
    profit: '₪1,752+',
    value: '₪17,964',
    allocation: [
      { name: 'Stocks', value: 100, color: '#00e5ff' },
    ],
    holdings: [
      { name: 'NVDA', weight: '100.0%' }
    ],
    chartData: [
      { x: 1, y: 10 }, { x: 2, y: 12 }, { x: 3, y: 11 }, { x: 4, y: 15 }, { x: 5, y: 14 }, { x: 6, y: 18 }
    ]
  },
  {
    id: 2,
    name: 'תיק שרון אלימלך',
    risk: 'סיכון גבוה',
    riskColor: 'text-danger bg-danger/10',
    yield: '+10.60%',
    profit: '₪4,654+',
    value: '₪163,500',
    allocation: [
      { name: 'Stocks', value: 70, color: '#00e5ff' },
      { name: 'Bonds', value: 20, color: '#627b7f' },
      { name: 'Cash', value: 10, color: '#5a7a9a' },
    ],
    holdings: [
      { name: 'AAPL', weight: '33.0%' },
      { name: 'TSLA', weight: '3.6%' },
      { name: 'MSTR', weight: '9.2%' },
    ],
    dividend: '₪1,240',
    chartData: [
      { x: 1, y: 5 }, { x: 2, y: 8 }, { x: 3, y: 15 }, { x: 4, y: 12 }, { x: 5, y: 18 }, { x: 6, y: 22 }
    ]
  },
  {
    id: 3,
    name: 'תיק חן עובדיה',
    risk: 'סיכון גבוה',
    riskColor: 'text-danger bg-danger/10',
    yield: '-8.76%',
    profit: '₪1,464-',
    value: '₪20,593',
    allocation: [
      { name: 'Stocks', value: 95, color: '#00e5ff' },
      { name: 'Bonds', value: 2, color: '#627b7f' },
      { name: 'Cash', value: 3, color: '#5a7a9a' },
    ],
    holdings: [
      { name: 'AAPL', weight: '62.1%' },
      { name: 'NSPT', weight: '9.3%' },
      { name: 'NVDA', weight: '1.7%' },
    ],
    dividend: '₪450',
    chartData: [
      { x: 1, y: 10 }, { x: 2, y: 15 }, { x: 3, y: 25 }, { x: 4, y: 22 }, { x: 5, y: 30 }, { x: 6, y: 28 }
    ]
  },
  {
    id: 4,
    name: 'תיק שי מידן',
    risk: 'סיכון גבוה',
    riskColor: 'text-danger bg-danger/10',
    yield: '+10.50%',
    profit: '₪26,230+',
    value: '₪252,431',
    allocation: [
      { name: 'Stocks', value: 90, color: '#00e5ff' },
      { name: 'Bonds', value: 5, color: '#627b7f' },
      { name: 'Cash', value: 5, color: '#5a7a9a' },
    ],
    holdings: [
      { name: 'MSFT', weight: '0.3%' },
      { name: 'NVGA', weight: '1.7%' },
      { name: 'TLT', weight: '0.8%' },
    ],
    dividend: '₪2,100',
    chartData: [
      { x: 1, y: 20 }, { x: 2, y: 18 }, { x: 3, y: 22 }, { x: 4, y: 15 }, { x: 5, y: 18 }, { x: 6, y: 12 }
    ]
  },
  {
    id: 5,
    name: 'תיק יהב',
    risk: 'סיכון נמוך',
    riskColor: 'text-success bg-success/10',
    yield: '+18.75%',
    profit: '₪86,798+',
    value: '₪3,300,071',
    allocation: [
      { name: 'Stocks', value: 85, color: '#00e5ff' },
      { name: 'Bonds', value: 10, color: '#627b7f' },
      { name: 'Cash', value: 5, color: '#5a7a9a' },
    ],
    holdings: [
      { name: 'VOO', weight: '1.7%' },
      { name: 'QQQ', weight: '1.4%' },
      { name: 'AAPL', weight: '1.4%' },
    ],
    dividend: '₪12,850',
    chartData: [
      { x: 1, y: 10 }, { x: 2, y: 12 }, { x: 3, y: 18 }, { x: 4, y: 25 }, { x: 5, y: 35 }, { x: 6, y: 40 }
    ]
  }
];

const RECENT_ACTIVITY = [
  { id: 1, type: 'deposit', client: 'יהב', amount: '$50,000', date: 'לפני 2 דקות', icon: ArrowUpRight, color: 'text-success' },
  { id: 2, type: 'trade', client: 'שי מידן', amount: 'NVDA Buy', date: 'לפני 15 דקות', icon: RefreshCw, color: 'text-primary' },
  { id: 3, type: 'withdrawal', client: 'חן עובדיה', amount: '$1,200', date: 'לפני שעה', icon: ArrowDownRight, color: 'text-danger' },
  { id: 4, type: 'alert', client: 'שרון אמסלם', amount: 'Risk Alert', date: 'לפני שעתיים', icon: AlertCircle, color: 'text-orange-500' },
];

const MARKET_DATA = [
  { symbol: 'S&P 500', price: '5,123.42', change: '+0.45%', up: true },
  { symbol: 'NASDAQ', price: '16,274.94', change: '+1.12%', up: true },
  { symbol: 'BTC', price: '$68,432', change: '-2.34%', up: false },
  { symbol: 'ETH', price: '$3,842', change: '-1.21%', up: false },
  { symbol: 'GOLD', price: '$2,154', change: '+0.12%', up: true },
  { symbol: 'USD/ILS', price: '3.62', change: '-0.05%', up: false },
];

const AI_AGENTS = [
  { 
    id: 1, 
    name: 'Macro Economist', 
    role: 'התשתית הכלכלית', 
    description: 'ניתוח מגמות מאקרו, ריבית, אינפלציה ומדיניות מוניטרית.',
    icon: Globe,
    color: 'text-blue-400',
    bg: 'bg-blue-400/10'
  },
  { 
    id: 2, 
    name: 'Market Analyst', 
    role: 'הסנטימנט והחדשות', 
    description: 'ניטור חדשות בזמן אמת, סנטימנט משקיעים ואירועים גיאופוליטיים.',
    icon: MessageSquare,
    color: 'text-green-400',
    bg: 'bg-green-400/10'
  },
  { 
    id: 3, 
    name: 'Fundamental Analyst', 
    role: 'הערך הפנימי של הנכס', 
    description: 'ניתוח דוחות כספיים, מכפילים, תזרים מזומנים ושווי הוגן.',
    icon: BarChart3,
    color: 'text-purple-400',
    bg: 'bg-purple-400/10'
  },
  { 
    id: 4, 
    name: 'Technical Analyst', 
    role: 'תזמון ומחיר בגרף', 
    description: 'ניתוח טכני, רמות תמיכה והתנגדות, מתנדים ותבניות מחיר.',
    icon: LineChart,
    color: 'text-orange-400',
    bg: 'bg-orange-400/10'
  },
  { 
    id: 5, 
    name: 'Risk Manager', 
    role: 'הגנות ותרחישי אימה', 
    description: 'ניהול סיכונים, אסטרטגיות גידור וניתוח תרחישי קיצון.',
    icon: ShieldCheck,
    color: 'text-red-400',
    bg: 'bg-red-400/10'
  },
  { 
    id: 6, 
    name: 'Debate Agent', 
    role: 'מפרק את כולם', 
    description: 'מאתגר את כל ההנחות, מוצא נקודות תורפה ומספק פרספקטיבה נגדית.',
    icon: Brain,
    color: 'text-pink-400',
    bg: 'bg-pink-400/10'
  },
];

const WATCHLIST_STOCKS = [
  { symbol: 'AAPL', name: 'Apple Inc.', price: '172.62', change: '+0.86%', isPositive: true },
  { symbol: 'TSLA', name: 'Tesla, Inc.', price: '175.22', change: '-1.12%', isPositive: false },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', price: '894.52', change: '+2.45%', isPositive: true },
  { symbol: 'MSFT', name: 'Microsoft Corp.', price: '420.72', change: '+0.12%', isPositive: true },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', price: '178.12', change: '-0.45%', isPositive: false },
  { symbol: 'META', name: 'Meta Platforms', price: '496.22', change: '+1.20%', isPositive: true },
];

const NEWS_ITEMS = [
  { id: 1, title: 'הפדרל ריזרב צפוי להותיר את הריבית ללא שינוי; השוק ממתין לרמזים על העתיד', source: 'כלכליסט', time: 'לפני שעה', category: 'מאקרו' },
  { id: 2, title: 'אנבידיה (NVDA) ממשיכה לשבור שיאים: האם מדובר בבועה או במהפכה אמיתית?', source: 'TheMarker', time: 'לפני שעתיים', category: 'טכנולוגיה' },
  { id: 3, title: 'בורסת תל אביב ננעלה בעליות שערים; מדד ת"א 35 עלה ב-0.8%', source: 'גלובס', time: 'לפני 3 שעות', category: 'ישראל' },
  { id: 4, title: 'דוחות חזקים לאפל (AAPL) ברבעון האחרון; המניה מזנקת במסחר המאוחר', source: 'Bizportal', time: 'לפני 5 שעות', category: 'מניות' },
  { id: 5, title: 'מחירי הנפט יורדים בעקבות חששות מהאטה בביקוש העולמי', source: 'וואלה! כסף', time: 'לפני 6 שעות', category: 'סחורות' },
];

const MARKET_CATEGORIES = {
  leaders: {
    title: 'מובילי תשואה',
    daily: [
      { symbol: 'NVDA', name: 'NVIDIA', change: '+4.2%', isPositive: true, market: 'US' },
      { symbol: 'אלביט מערכות', name: 'Elbit Systems', change: '+3.1%', isPositive: true, market: 'IL' },
      { symbol: 'TSLA', name: 'Tesla', change: '+2.8%', isPositive: true, market: 'US' },
      { symbol: 'נייס', name: 'NICE', change: '+2.5%', isPositive: true, market: 'IL' },
    ],
    monthly: [
      { symbol: 'META', name: 'Meta', change: '+12.5%', isPositive: true, market: 'US' },
      { symbol: 'בנק לאומי', name: 'Leumi', change: '+8.2%', isPositive: true, market: 'IL' },
      { symbol: 'AMZN', name: 'Amazon', change: '+7.8%', isPositive: true, market: 'US' },
      { symbol: 'איי.סי.אל', name: 'ICL', change: '+6.4%', isPositive: true, market: 'IL' },
    ],
    annual: [
      { symbol: 'NVDA', name: 'NVIDIA', change: '+245%', isPositive: true, market: 'US' },
      { symbol: 'קמטק', name: 'Camtek', change: '+112%', isPositive: true, market: 'IL' },
      { symbol: 'MSFT', name: 'Microsoft', change: '+54%', isPositive: true, market: 'US' },
      { symbol: 'נובה', name: 'Nova', change: '+48%', isPositive: true, market: 'IL' },
    ]
  },
  indices: {
    title: 'מדדים מרכזיים',
    items: [
      { symbol: 'S&P 500', name: 'ארה"ב - 500 החברות הגדולות', price: '5,241.53', change: '+0.86%', isPositive: true, market: 'US' },
      { symbol: 'NASDAQ 100', name: 'ארה"ב - טכנולוגיה', price: '18,339.44', change: '+1.12%', isPositive: true, market: 'US' },
      { symbol: 'ת"א 35', name: 'ישראל - 35 הגדולות', price: '2,045.12', change: '+0.34%', isPositive: true, market: 'IL' },
      { symbol: 'ת"א 125', name: 'ישראל - מדד רחב', price: '2,112.45', change: '+0.28%', isPositive: true, market: 'IL' },
      { symbol: 'Dow Jones', name: 'ארה"ב - תעשייה', price: '39,123.42', change: '+0.45%', isPositive: true, market: 'US' },
    ]
  },
  bonds: {
    title: 'אג"ח ממשלתי',
    items: [
      { symbol: 'US 10Y', name: 'אג"ח ארה"ב ל-10 שנים', price: '4.23%', change: '+0.02%', isPositive: false, market: 'US' },
      { symbol: 'US 2Y', name: 'אג"ח ארה"ב ל-2 שנים', price: '4.58%', change: '-0.01%', isPositive: true, market: 'US' },
      { symbol: 'IL 10Y', name: 'אג"ח ישראל ל-10 שנים', price: '4.82%', change: '+0.05%', isPositive: false, market: 'IL' },
      { symbol: 'IL 2Y', name: 'אג"ח ישראל ל-2 שנים', price: '4.15%', change: '+0.01%', isPositive: false, market: 'IL' },
      { symbol: 'US 30Y', name: 'אג"ח ארה"ב ל-30 שנה', price: '4.38%', change: '+0.03%', isPositive: false, market: 'US' },
    ]
  },
  dividends: {
    title: 'מניות דיבידנד גבוה',
    items: [
      { symbol: 'T', name: 'AT&T Inc.', price: '17.24', change: '6.45%', isPositive: true, market: 'US' },
      { symbol: 'VZ', name: 'Verizon', price: '40.12', change: '6.28%', isPositive: true, market: 'US' },
      { symbol: 'MO', name: 'Altria Group', price: '43.52', change: '8.92%', isPositive: true, market: 'US' },
      { symbol: 'ICL', name: 'איי.סי.אל', price: '1,842', change: '5.42%', isPositive: true, market: 'IL' },
      { symbol: 'PFE', name: 'Pfizer Inc.', price: '27.82', change: '6.02%', isPositive: true, market: 'US' },
    ]
  },
  sectors: {
    title: 'מדדי סקטורים',
    items: [
      { symbol: 'XLK', name: 'טכנולוגיה - ארה"ב', price: '208.42', change: '+1.42%', isPositive: true, market: 'US' },
      { symbol: 'XLF', name: 'פיננסים - ארה"ב', price: '41.12', change: '+0.25%', isPositive: true, market: 'US' },
      { symbol: 'XLE', name: 'אנרגיה - ארה"ב', price: '92.35', change: '-0.45%', isPositive: false, market: 'US' },
      { symbol: 'ת"א בנקים', name: 'בנקים - ישראל', price: '3,842', change: '+0.82%', isPositive: true, market: 'IL' },
      { symbol: 'ת"א נדל"ן', name: 'נדל"ן - ישראל', price: '1,124', change: '-0.12%', isPositive: false, market: 'IL' },
    ]
  }
};

const MarketsModal = ({ isOpen, onClose, period, setPeriod }: any) => {
  const [activeCategory, setActiveCategory] = useState<keyof typeof MARKET_CATEGORIES>('leaders');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="מרכז נתוני שוק גלובלי">
      <div className="flex flex-col gap-6 min-w-[700px] max-h-[80vh] overflow-hidden">
        {/* Main Category Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar no-scrollbar">
          {Object.entries(MARKET_CATEGORIES).map(([key, cat]) => (
            <button
              key={key}
              onClick={() => setActiveCategory(key as any)}
              className={cn(
                "px-4 py-2 text-[10px] font-black rounded-xl transition-all uppercase tracking-widest whitespace-nowrap border",
                activeCategory === key 
                  ? "bg-primary border-primary text-background shadow-lg shadow-primary/20" 
                  : "bg-white/5 border-white/10 text-neutral hover:text-white hover:bg-white/10"
              )}
            >
              {cat.title}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
          {activeCategory === 'leaders' ? (
            <div className="flex flex-col gap-6">
              <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10">
                {(['daily', 'monthly', 'annual'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={cn(
                      "flex-1 py-2 text-xs font-black rounded-xl transition-all uppercase tracking-widest",
                      period === p ? "bg-primary text-background shadow-lg" : "text-neutral hover:text-white"
                    )}
                  >
                    {p === 'daily' ? 'יומי' : p === 'monthly' ? 'חודשי' : 'שנתי'}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2">
                {(MARKET_CATEGORIES.leaders[period as 'daily' | 'monthly' | 'annual'] as any[]).map((stock: any, idx: number) => (
                  <MarketItem key={idx} item={stock} />
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {((MARKET_CATEGORIES[activeCategory] as any).items as any[]).map((item: any, idx: number) => (
                <MarketItem key={idx} item={item} isBond={activeCategory === 'bonds'} isDiv={activeCategory === 'dividends'} />
              ))}
            </div>
          )}
        </div>
        
        <div className="p-4 bg-primary/5 rounded-2xl border border-primary/10 mt-auto">
          <p className="text-[10px] text-primary/80 font-bold text-center leading-relaxed">
            * נתוני שוק בזמן אמת ממקורות FINEXTIUM. אג"ח ממשלתי מוצג לפי תשואה לפדיון.
          </p>
        </div>
      </div>
    </Modal>
  );
};

const MarketItem = ({ item, isBond, isDiv }: any) => (
  <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 hover:border-primary/30 transition-all group">
    <div className="flex items-center gap-3">
      <div className={cn(
        "w-10 h-10 rounded-xl flex items-center justify-center text-[10px] font-black",
        item.market === 'US' ? "bg-blue-500/10 text-blue-400" : "bg-green-500/10 text-green-400"
      )}>
        {item.market}
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-bold text-white">{item.symbol}</span>
        <span className="text-[10px] text-neutral/60">{item.name}</span>
      </div>
    </div>
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-end">
        <span className="text-sm font-black text-white">{item.price || ''}</span>
        <span className={cn(
          "text-xs font-bold", 
          item.isPositive ? "text-success" : "text-danger"
        )}>
          {isDiv ? `תשואת דיבידנד: ${item.change}` : item.change}
        </span>
      </div>
      <ArrowUpRight size={14} className="text-neutral/40 group-hover:text-primary transition-colors" />
    </div>
  </div>
);

const StrategicAnalysis = () => {
  const [assetInput, setAssetInput] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);

  const runAnalysis = () => {
    setIsAnalyzing(true);
    // Simulate analysis delay
    setTimeout(() => {
      setAnalysisResult({
        marketState: assetInput ? `ניתוח מקיף עבור ${assetInput}` : 'ניתוח מגמות שוק כולל',
        allocation: 'מומלץ להעביר 15% מהחשיפה המנייתית לאג"ח קונצרני בדירוג גבוה ולסחורות (זהב).',
        sectors: 'סקטורים רלוונטיים: אנרגיה מתחדשת, תשתיות וטכנולוגיה ביטחונית.',
        conclusion: 'הדיבייט אג\'נט מסכם: למרות התנודתיות בטווח הקצר, תנועות ההון מצביעות על כניסת כסף מוסדי לנכסי ערך. מומלץ לשמור על חשיפה מתונה ולהתמקד בנכסים עם תזרים מזומנים חזק.'
      });
      setIsAnalyzing(false);
    }, 2000);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Analysis Controls */}
      <div className="bg-surface/40 border border-white/5 p-8 rounded-3xl backdrop-blur-xl flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 flex flex-col gap-2 w-full">
          <label className="text-xs font-bold text-neutral/60 uppercase tracking-widest">ניתוח נכס ספציפי (אופציונלי)</label>
          <input 
            type="text" 
            value={assetInput}
            onChange={(e) => setAssetInput(e.target.value)}
            placeholder="הכנס סימול מניה או שם נכס..."
            className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-3 px-5 text-sm focus:outline-none focus:border-primary/40 transition-all"
          />
        </div>
        <button 
          onClick={runAnalysis}
          disabled={isAnalyzing}
          className="bg-primary text-background font-black px-8 py-3.5 rounded-2xl hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg shadow-primary/20 flex items-center gap-3 disabled:opacity-50 min-w-[200px] justify-center"
        >
          {isAnalyzing ? <RefreshCw size={18} className="animate-spin" /> : <Cpu size={18} />}
          <span>הפעל ניתוח מקיף</span>
        </button>
      </div>

      {/* Agents Team */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {AI_AGENTS.map((agent) => (
          <div 
            key={agent.id}
            className="bg-surface/20 border border-white/5 p-4 rounded-2xl flex flex-col items-center text-center gap-3"
          >
            <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", agent.bg)}>
              <agent.icon className={agent.color} size={20} />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-white uppercase tracking-tighter">{agent.name}</span>
              <span className="text-[9px] font-bold text-neutral/40 leading-none">{agent.role}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Analysis Result */}
      <AnimatePresence>
        {analysisResult && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-surface/60 border border-primary/20 p-8 rounded-3xl backdrop-blur-2xl flex flex-col gap-6 relative overflow-hidden"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 blur-3xl rounded-full" />
            
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-pink-400/10 flex items-center justify-center">
                <Brain className="text-pink-400" size={24} />
              </div>
              <div className="flex flex-col">
                <h4 className="text-lg font-black text-white">{analysisResult.marketState}</h4>
                <span className="text-xs font-bold text-pink-400 uppercase tracking-widest">מסקנת הדיבייט אג'נט</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-primary">
                  <ArrowLeftRight size={16} />
                  <span className="text-xs font-bold uppercase tracking-widest">המלצת הקצאה</span>
                </div>
                <p className="text-sm text-neutral/80 leading-relaxed">{analysisResult.allocation}</p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-success">
                  <LayoutGrid size={16} />
                  <span className="text-xs font-bold uppercase tracking-widest">סקטורים רלוונטיים</span>
                </div>
                <p className="text-sm text-neutral/80 leading-relaxed">{analysisResult.sectors}</p>
              </div>
            </div>

            <div className="bg-white/5 p-6 rounded-2xl border border-white/5 mt-4">
              <p className="text-sm text-white font-medium italic leading-relaxed">"{analysisResult.conclusion}"</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Watchlist = () => {
  const [isAlertModalOpen, setIsAlertModalOpen] = useState(false);
  const [selectedStock, setSelectedStock] = useState<any>(null);
  const [watchlistSearch, setWatchlistSearch] = useState('');

  const filteredWatchlist = WATCHLIST_STOCKS.filter(stock => 
    stock.symbol.toLowerCase().includes(watchlistSearch.toLowerCase()) ||
    stock.name.toLowerCase().includes(watchlistSearch.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Watchlist Search */}
      <div className="relative max-w-md">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral/60" size={16} />
        <input 
          type="text" 
          placeholder="חיפוש נכס ברשימה..." 
          value={watchlistSearch}
          onChange={(e) => setWatchlistSearch(e.target.value)}
          className="w-full bg-surface/40 border border-white/10 rounded-2xl py-3 pr-12 pl-5 text-sm focus:outline-none focus:border-primary/40 transition-all"
        />
      </div>

      <div className="bg-surface/40 border border-white/5 rounded-3xl overflow-hidden">
        <table className="w-full text-right">
          <thead>
            <tr className="border-b border-white/5">
              <th className="px-6 py-4 text-xs font-bold text-neutral/60 uppercase tracking-widest">נכס</th>
              <th className="px-6 py-4 text-xs font-bold text-neutral/60 uppercase tracking-widest">מחיר</th>
              <th className="px-6 py-4 text-xs font-bold text-neutral/60 uppercase tracking-widest">שינוי</th>
              <th className="px-6 py-4 text-xs font-bold text-neutral/60 uppercase tracking-widest text-left">פעולות</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredWatchlist.map((stock) => (
              <tr key={stock.symbol} className="group hover:bg-white/[0.02] transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-xs font-bold">
                      {stock.symbol[0]}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-white">{stock.symbol}</span>
                      <span className="text-[10px] text-neutral/60">{stock.name}</span>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm font-black text-white">${stock.price}</span>
                </td>
                <td className="px-6 py-4">
                  <span className={cn("text-xs font-bold px-2 py-1 rounded", stock.isPositive ? "text-success bg-success/10" : "text-danger bg-danger/10")}>
                    {stock.change}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2 justify-end">
                    <button 
                      onClick={() => {
                        setSelectedStock(stock);
                        setIsAlertModalOpen(true);
                      }}
                      className="p-2.5 bg-white/5 hover:bg-primary/20 hover:text-primary border border-white/5 rounded-xl text-neutral transition-all"
                      title="הגדר התראה"
                    >
                      <Bell size={16} />
                    </button>
                    <button className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-neutral transition-all">
                      <TrendingUp size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal 
        isOpen={isAlertModalOpen} 
        onClose={() => setIsAlertModalOpen(false)} 
        title={`הגדר התראה עבור ${selectedStock?.symbol}`}
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <label className="text-xs font-bold text-neutral/60 uppercase tracking-widest">סוג התראה</label>
            <div className="grid grid-cols-3 gap-2">
              {['מחיר', 'טכני', 'פיננסי'].map(type => (
                <button key={type} className="px-3 py-3 bg-white/5 border border-white/10 rounded-xl text-xs font-bold hover:bg-primary/20 hover:text-primary transition-all">
                  {type}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <label className="text-xs font-bold text-neutral/60 uppercase tracking-widest">תנאי</label>
            <div className="flex gap-2">
              <select className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/40">
                <option>גדול מ-</option>
                <option>קטן מ-</option>
                <option>שווה ל-</option>
              </select>
              <input 
                type="number" 
                placeholder="ערך..."
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/40"
              />
            </div>
          </div>
          <button className="w-full bg-primary text-background font-black py-4 rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg shadow-primary/20">
            צור התראה
          </button>
        </div>
      </Modal>
    </div>
  );
};

// --- Components ---

const CurrencyToggle = ({ currency, setCurrency }: { currency: 'ILS' | 'USD', setCurrency: (c: 'ILS' | 'USD') => void }) => (
  <div className="flex bg-white/5 p-0.5 rounded-lg border border-white/10 shadow-inner">
    <button 
      onClick={() => setCurrency('ILS')}
      className={cn(
        "px-2 py-0.5 text-[9px] font-black rounded-md transition-all uppercase tracking-tighter",
        currency === 'ILS' ? "bg-primary text-background shadow-md" : "text-neutral hover:text-white"
      )}
    >
      ₪ ILS
    </button>
    <button 
      onClick={() => setCurrency('USD')}
      className={cn(
        "px-2 py-0.5 text-[9px] font-black rounded-md transition-all uppercase tracking-tighter",
        currency === 'USD' ? "bg-primary text-background shadow-md" : "text-neutral hover:text-white"
      )}
    >
      $ USD
    </button>
  </div>
);

const convertCurrency = (valStr: string, toCurrency: 'ILS' | 'USD', rate: number = 3.65) => {
  if (!valStr || typeof valStr !== 'string' || !valStr.includes('₪')) return valStr;
  
  const isPositive = valStr.includes('+');
  const isNegative = valStr.includes('-');
  const cleanVal = valStr.replace(/[₪,+-]/g, '').trim();
  let num = parseFloat(cleanVal);
  
  if (isNaN(num)) return valStr;
  
  if (toCurrency === 'USD') {
    num = num / rate;
  }
  
  const formatted = num.toLocaleString(undefined, { 
    maximumFractionDigits: toCurrency === 'USD' ? 0 : 0 
  });
  const symbol = toCurrency === 'USD' ? '$' : '₪';
  const sign = isPositive ? '+' : isNegative ? '-' : '';
  
  // Handle cases like "₪5 רווח יומי"
  if (valStr.includes(' ')) {
    const parts = valStr.split(' ');
    return parts.map(p => p.includes('₪') ? convertCurrency(p, toCurrency, rate) : p).join(' ');
  }

  return `${symbol}${formatted}${sign}`;
};

const Modal = ({ isOpen, onClose, title, children }: { isOpen: boolean, onClose: () => void, title: string, children: React.ReactNode }) => (
  <AnimatePresence>
    {isOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        />
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 20 }} 
          animate={{ opacity: 1, scale: 1, y: 0 }} 
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="relative w-full max-w-lg bg-surface border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between p-6 border-b border-white/5">
            <h3 className="text-xl font-bold">{title}</h3>
            <button onClick={onClose} className="text-neutral hover:text-white transition-colors">
              <X size={20} />
            </button>
          </div>
          <div className="p-6">
            {children}
          </div>
        </motion.div>
      </div>
    )}
  </AnimatePresence>
);

const SidebarItem = ({ icon: Icon, label, active = false, onClick }: { icon: any, label: string, active?: boolean, onClick?: () => void }) => (
  <div 
    onClick={onClick}
    className={cn(
      "flex items-center gap-4 px-6 py-4 cursor-pointer transition-all duration-200 border-r-4 text-sm tracking-tight",
      active ? "bg-primary/10 border-primary text-primary font-bold" : "border-transparent text-neutral/70 hover:bg-white/5 hover:text-white font-medium"
    )}
  >
    <Icon size={20} />
    <span>{label}</span>
  </div>
);

const StatCard = ({ title, value, subValue, color = "text-white", onClick }: { title: string, value: string, subValue: string, color?: string, onClick?: () => void }) => (
  <div 
    onClick={onClick}
    className={cn(
      "bg-surface/50 backdrop-blur-md border border-white/5 p-6 rounded-2xl flex flex-col items-center text-center gap-1.5 flex-1 transition-all duration-300",
      onClick ? "cursor-pointer hover:bg-white/10 hover:scale-[1.02] active:scale-[0.98] group" : ""
    )}
  >
    <span className="text-xs font-bold text-neutral/80 uppercase tracking-widest group-hover:text-primary transition-colors">{title}</span>
    <span className={cn("text-3xl font-black tracking-tighter drop-shadow-2xl", color)}>{value}</span>
    {subValue && <span className="text-xs font-bold text-neutral/60 tracking-tight">{subValue}</span>}
  </div>
);

const RiskCounter = ({ label, count, color, subValue }: { label: string, count: string, color: string, subValue: string }) => (
  <div className="bg-surface/30 border border-white/5 p-4 rounded-2xl flex justify-between items-center flex-1">
    <div className="flex flex-col">
      <span className="text-xs font-bold text-neutral/80 uppercase">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-2xl font-black", color)}>{count}</span>
      </div>
    </div>
    <div className="flex flex-col items-end">
      <span className={cn("text-xs font-bold", color)}>{subValue}</span>
    </div>
  </div>
);

interface Client {
  id: number;
  name: string;
  risk: string;
  riskColor: string;
  yield: string;
  profit: string;
  value: string;
  allocation: { name: string; value: number; color: string; }[];
  holdings: { name: string; weight: string; }[];
  chartData: { x: number; y: number; }[];
}

const ClientCard = ({ client, onClick, currency, rate }: any) => (
  <div 
    onClick={onClick}
    className="bg-surface/40 rounded-2xl border border-white/5 flex flex-col p-5 group hover:border-primary/30 transition-all duration-300 hover:shadow-2xl hover:shadow-primary/5 cursor-pointer relative"
  >
    <div className="flex justify-between items-start mb-4">
      <button className="text-neutral/60 hover:text-white transition-colors"><MoreVertical size={18} /></button>
      <div className="flex flex-col items-end">
        <h3 className="font-bold text-lg tracking-tight text-white">{client.name}</h3>
        <span className={cn("text-xs font-bold px-2 py-0.5 rounded mt-1 uppercase tracking-wide", client.riskColor)}>
          {client.risk}
        </span>
      </div>
    </div>

    <div className="flex-1 flex items-center justify-center py-4">
      {client.id === 5 || client.id === 1 ? (
        <div className="w-24 h-24 relative">
          <ResponsiveContainer width="100%" height="100%">
            <RePieChart>
              <Pie
                data={client.allocation}
                cx="50%"
                cy="50%"
                innerRadius={35}
                outerRadius={45}
                paddingAngle={2}
                dataKey="value"
              >
                {client.allocation.map((entry: any, index: number) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
            </RePieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-primary">
            {client.id === 5 ? '80%' : ''}
          </div>
        </div>
      ) : (
        <div className="w-full h-20">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={client.chartData}>
              <defs>
                <linearGradient id={`grad-${client.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={client.yield.includes('+') ? "#00FF94" : "#FF4D4D"} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={client.yield.includes('+') ? "#00FF94" : "#FF4D4D"} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <Area 
                type="monotone" 
                dataKey="y" 
                stroke={client.yield.includes('+') ? "#00FF94" : "#FF4D4D"} 
                strokeWidth={2} 
                fill={`url(#grad-${client.id})`} 
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>

    <div className="flex justify-between items-end mt-4">
      <div className="flex flex-col">
        <span className="text-xs text-neutral/80 font-bold uppercase">תשואה</span>
        <span className={cn("text-base font-bold", client.yield.includes('+') ? "text-success" : "text-danger")}>
          {client.yield}
        </span>
      </div>
      <div className="flex flex-col items-end">
        <div className="flex flex-col gap-0.5 items-end mb-2">
          {client.holdings.map((h: any, i: number) => (
            <span key={i} className="text-[11px] text-neutral/60 font-mono">{h.name}</span>
          ))}
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs text-neutral/80 font-bold uppercase">שווי תיק</span>
          <span className="text-base font-bold text-white">{convertCurrency(client.value, currency, rate)}</span>
        </div>
      </div>
    </div>
  </div>
);

export default function App() {
  const [currentTab, setCurrentTab] = useState('דאשבורד');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState('הכל');
  const [isMoreFiltersOpen, setIsMoreFiltersOpen] = useState(false);
  const [selectedMarketAssets, setSelectedMarketAssets] = useState(['S&P 500', 'NASDAQ 100', 'BTC', 'TA-35']);
  const [isMarketSettingsOpen, setIsMarketSettingsOpen] = useState(false);
  const [currency, setCurrency] = useState<'ILS' | 'USD'>('ILS');
  const USD_RATE = 3.65;

  const marketData: Record<string, { price: string, change: string, isPositive: boolean }> = {
    'S&P 500': { price: '5,241.53', change: '+0.86%', isPositive: true },
    'NASDAQ 100': { price: '18,339.44', change: '+1.12%', isPositive: true },
    'BTC': { price: '$70,241', change: '-2.45%', isPositive: false },
    'TA-35': { price: '2,045.12', change: '+0.34%', isPositive: true },
    'ETH': { price: '$3,542', change: '+1.20%', isPositive: true },
    'Gold': { price: '$2,174', change: '+0.15%', isPositive: true },
    'Oil': { price: '$81.35', change: '-0.45%', isPositive: false },
    'USD/ILS': { price: '3.65', change: '-0.12%', isPositive: false },
  };

  const allAvailableAssets = Object.keys(marketData);

  const toggleMarketAsset = (asset: string) => {
    if (selectedMarketAssets.includes(asset)) {
      if (selectedMarketAssets.length > 1) {
        setSelectedMarketAssets(selectedMarketAssets.filter(a => a !== asset));
      }
    } else {
      if (selectedMarketAssets.length < 6) {
        setSelectedMarketAssets([...selectedMarketAssets, asset]);
      }
    }
  };
  const [marketPeriod, setMarketPeriod] = useState<'daily' | 'monthly' | 'annual'>('daily');
  const [isAddClientOpen, setIsAddClientOpen] = useState(false);
  const [isDividendModalOpen, setIsDividendModalOpen] = useState(false);
  const [dividendRiskFilter, setDividendRiskFilter] = useState('הכל');
  const [selectedClient, setSelectedClient] = useState<typeof CLIENTS[0] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [newClient, setNewClient] = useState({ name: '', risk: 'בינוני', deposit: '' });

  const handleAddClient = (e: React.FormEvent) => {
    e.preventDefault();
    // In a real app, we'd add to state/DB
    setIsAddClientOpen(false);
    setNewClient({ name: '', risk: 'בינוני', deposit: '' });
  };

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 1500);
  };

  const filteredClients = CLIENTS.filter(client => {
    const matchesSearch = client.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                         client.holdings.some(h => h.name.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesRisk = riskFilter === 'הכל' || client.risk.includes(riskFilter);
    return matchesSearch && matchesRisk;
  });

  const riskCounts = React.useMemo(() => {
    const counts = { גבוה: 0, בינוני: 0, נמוך: 0 };
    CLIENTS.forEach(c => {
      if (c.risk.includes('גבוה')) counts.גבוה++;
      if (c.risk.includes('בינוני')) counts.בינוני++;
      if (c.risk.includes('נמוך')) counts.נמוך++;
    });
    return counts;
  }, []);

  const riskGroupStats = React.useMemo(() => {
    const groups = {
      נמוך: { count: 0, totalYield: 0, totalValue: 0 },
      בינוני: { count: 0, totalYield: 0, totalValue: 0 },
      גבוה: { count: 0, totalYield: 0, totalValue: 0 },
    };

    CLIENTS.forEach(client => {
      const riskKey = client.risk.includes('גבוה') ? 'גבוה' : client.risk.includes('בינוני') ? 'בינוני' : 'נמוך';
      const val = parseFloat(client.value.replace(/[₪,]/g, '')) || 0;
      const yldStr = client.yield.replace(/[%]/g, '');
      const yld = parseFloat(yldStr) * (yldStr.includes('-') ? -1 : 1) || 0;

      groups[riskKey].count++;
      groups[riskKey].totalYield += (yld * val);
      groups[riskKey].totalValue += val;
    });

    return {
      נמוך: { count: groups.נמוך.count, avgYield: groups.נמוך.totalValue > 0 ? groups.נמוך.totalYield / groups.נמוך.totalValue : 0 },
      בינוני: { count: groups.בינוני.count, avgYield: groups.בינוני.totalValue > 0 ? groups.בינוני.totalYield / groups.בינוני.totalValue : 0 },
      גבוה: { count: groups.גבוה.count, avgYield: groups.גבוה.totalValue > 0 ? groups.גבוה.totalYield / groups.גבוה.totalValue : 0 },
    };
  }, []);

  const stats = React.useMemo(() => {
    let totalValue = 0;
    let totalProfit = 0;
    let totalDividend = 0;
    let weightedYieldSum = 0;
    
    filteredClients.forEach(client => {
      const val = parseFloat(client.value.replace(/[₪,]/g, '')) || 0;
      const profStr = client.profit.replace(/[₪,]/g, '');
      const prof = parseFloat(profStr) * (profStr.includes('-') ? -1 : 1) || 0;
      const div = client.dividend ? parseFloat(client.dividend.replace(/[₪,]/g, '')) : 0;
      const yldStr = client.yield.replace(/[%]/g, '');
      const yld = parseFloat(yldStr) * (yldStr.includes('-') ? -1 : 1) || 0;
      
      totalValue += val;
      totalProfit += prof;
      totalDividend += div;
      weightedYieldSum += (yld * val);
    });
    
    const weightedYield = totalValue > 0 ? (weightedYieldSum / totalValue) : 0;
    const dividendYield = totalValue > 0 ? (totalDividend / totalValue) * 100 : 0;
    
    return {
      totalValue,
      totalProfit,
      totalDividend,
      weightedYield,
      dividendYield,
      count: filteredClients.length
    };
  }, [filteredClients]);

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans text-white selection:bg-primary/30" dir="rtl">
      {/* Sidebar (Right Side) */}
      <aside className="w-72 bg-surface border-l border-white/5 flex flex-col">
        <div className="flex flex-col items-center justify-center pt-5 pb-8 border-b border-white/5 bg-surface/30">
          <div className="flex justify-center items-center mb-3">
            <svg 
              viewBox="0 0 100 100" 
              fill="none" 
              xmlns="http://www.w3.org/2000/svg" 
              className="drop-shadow-xl"
              style={{ 
                maxHeight: '50px', 
                width: 'auto',
                aspectRatio: '1 / 1', 
                objectFit: 'contain'
              }}
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <linearGradient id="mainGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#061E33" />
                  <stop offset="30%" stopColor="#0061FF" />
                  <stop offset="60%" stopColor="#00D4FF" />
                  <stop offset="100%" stopColor="#24FF72" />
                </linearGradient>
                <linearGradient id="bevelGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="white" stopOpacity="0.3" />
                  <stop offset="50%" stopColor="white" stopOpacity="0" />
                  <stop offset="100%" stopColor="black" stopOpacity="0.2" />
                </linearGradient>
              </defs>
              
              {/* Background Shadow/Depth Layer */}
              <path 
                d="M22 78C22 45 38 25 82 22C70 32 62 52 62 78H22Z" 
                fill="#061E33" 
                opacity="0.4"
                transform="translate(1, 1)"
              />

              {/* Main "F" Body */}
              <path 
                d="M20 80C20 35 45 20 85 20V35C55 35 45 50 45 80H20Z" 
                fill="url(#mainGrad)" 
              />
              <path 
                d="M20 80C20 35 45 20 85 20V35C55 35 45 50 45 80H20Z" 
                fill="url(#bevelGrad)" 
              />

              {/* The Zigzag Graph Line / "X" Part */}
              <path 
                d="M20 88L45 60L55 70L90 15L90 35L55 80L45 70L20 98V88Z" 
                fill="url(#mainGrad)"
              />
              <path 
                d="M20 88L45 60L55 70L90 15L90 35L55 80L45 70L20 98V88Z" 
                fill="url(#bevelGrad)" 
              />

              {/* Arrow Head */}
              <path 
                d="M90 15L72 20L85 35L90 15Z" 
                fill="url(#mainGrad)" 
              />
              <path 
                d="M90 15L72 20L85 35L90 15Z" 
                fill="url(#bevelGrad)" 
              />
            </svg>
          </div>
          <h1 className="text-sm font-black tracking-[0.4em] text-white drop-shadow-md uppercase">FINEXTIUM</h1>
        </div>

        <nav className="py-8 flex flex-col gap-1">
          <SidebarItem icon={LayoutGrid} label="דאשבורד" active={currentTab === 'דאשבורד'} onClick={() => setCurrentTab('דאשבורד')} />
          <SidebarItem icon={ArrowLeftRight} label="תנועות הון בין ענפים" active={currentTab === 'תנועות הון בין ענפים'} onClick={() => setCurrentTab('תנועות הון בין ענפים')} />
          <SidebarItem icon={ListIcon} label="רשימת מעקב" active={currentTab === 'רשימת מעקב'} onClick={() => setCurrentTab('רשימת מעקב')} />
          <SidebarItem icon={Cpu} label="ניתוח אסטרטגי" active={currentTab === 'ניתוח אסטרטגי'} onClick={() => setCurrentTab('ניתוח אסטרטגי')} />
          <SidebarItem icon={RefreshCw} label="איזון מחדש" active={currentTab === 'איזון מחדש'} onClick={() => setCurrentTab('איזון מחדש')} />
          <SidebarItem icon={FileText} label="חדשות שוק ההון" active={currentTab === 'חדשות שוק ההון'} onClick={() => setCurrentTab('חדשות שוק ההון')} />
        </nav>

        <div className="flex-1" />

        <div className="p-4 border-t border-white/5">
          <button 
            className="flex items-center gap-4 px-6 py-4 w-full text-neutral/70 hover:bg-danger/10 hover:text-danger transition-all duration-200 rounded-xl text-sm font-medium"
            onClick={() => console.log('Logout')}
          >
            <LogOut size={20} />
            <span>התנתק</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-20 border-b border-white/5 flex items-center px-8 bg-surface/50 backdrop-blur-md z-10">
          <div className="flex-1 flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/10 overflow-hidden border border-white/10">
                <img src="https://picsum.photos/seed/user/100/100" alt="User" referrerPolicy="no-referrer" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-bold">אלון כהן</span>
              </div>
              <button className="text-neutral hover:text-white transition-colors ml-2"><Settings size={18} /></button>
              <button className="text-neutral hover:text-white transition-colors relative">
                <Bell size={18} />
                <span className="absolute top-0 right-0 w-1.5 h-1.5 bg-danger rounded-full" />
              </button>
            </div>
          </div>

          <div className="flex-[2] flex items-center justify-center gap-4">
            {/* נתוני מאקרו */}
            <button className="flex items-center gap-3 px-4 py-2 rounded-xl border border-white/10 bg-surface/30 hover:bg-white/5 transition-colors group">
              <div className="w-5 h-5 bg-danger rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-lg shadow-danger/20 group-hover:scale-110 transition-transform">4</div>
              <span className="text-sm font-bold text-white/80 tracking-tight">נתוני מאקרו</span>
            </button>

            {/* הוסף תיק */}
            <button 
              onClick={() => setIsAddClientOpen(true)}
              className="bg-surface border border-white/10 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-white/5 transition-colors"
            >
              <Plus size={18} className="text-primary" />
              <span className="tracking-tight">הוסף תיק</span>
            </button>

            {/* שווקים */}
            <button 
              onClick={() => setCurrentTab('שווקים')}
              className={cn(
                "px-4 py-2 rounded-xl border transition-all text-sm font-bold tracking-tight",
                currentTab === 'שווקים' 
                  ? "bg-primary border-primary text-background shadow-lg shadow-primary/20" 
                  : "border-white/10 bg-surface/30 hover:bg-white/5 text-white/80"
              )}
            >
              שווקים
            </button>
          </div>

          <div className="flex-1 flex items-center justify-end gap-4">
            {/* Currency Toggle */}
            <div className="flex flex-col items-center gap-1">
              <span className="text-[9px] font-bold text-neutral/60 uppercase tracking-widest">מטבע תצוגה</span>
              <CurrencyToggle currency={currency} setCurrency={setCurrency} />
            </div>

            {/* הפקת דוח */}
            <button className="flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 bg-surface/30 hover:bg-white/5 transition-colors text-sm font-bold text-white/80 tracking-tight">
              <FileText size={18} className="text-primary" />
              <span>הפקת דוח</span>
            </button>

            {/* רענן נתונים */}
            <button 
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="px-4 py-2 rounded-xl border border-white/10 bg-surface/30 hover:bg-white/5 transition-all hover:scale-[1.02] active:scale-[0.98] text-sm font-bold text-white/80 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRefreshing ? <RefreshCw size={16} className="animate-spin text-primary" /> : null}
              <span className="tracking-tight">רענן נתונים</span>
            </button>

            {/* עודכן */}
            <div className="flex items-center gap-2 mr-2">
              <span className="text-sm font-bold text-neutral/60">עודכן: 22:58:52</span>
              <div className="w-2.5 h-2.5 bg-success rounded-full shadow-lg shadow-success/20 animate-pulse" />
            </div>
          </div>
        </header>

        {/* Dashboard Content */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          <AnimatePresence mode="wait">
            {currentTab === 'דאשבורד' ? (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                {/* Market Ticker */}
                <div className="flex items-center justify-center gap-12 overflow-x-auto no-scrollbar py-2">
                  {selectedMarketAssets.map(asset => (
                    <div key={asset} className="flex items-center gap-3 whitespace-nowrap">
                      <span className="text-[10px] font-bold text-neutral uppercase tracking-wider">{asset}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black">{marketData[asset].price}</span>
                        <span className={cn(
                          "text-[10px] font-bold px-1.5 py-0.5 rounded",
                          marketData[asset].isPositive ? "text-success bg-success/10" : "text-danger bg-danger/10"
                        )}>
                          {marketData[asset].change}
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="relative">
                    <button 
                      onClick={() => setIsMarketSettingsOpen(!isMarketSettingsOpen)}
                      className="p-2 hover:bg-white/5 rounded-lg text-neutral transition-colors"
                    >
                      <Settings size={16} />
                    </button>
                    {isMarketSettingsOpen && (
                      <div className="absolute left-0 top-full mt-2 w-48 bg-surface border border-white/10 rounded-xl shadow-2xl z-50 p-3 flex flex-col gap-2">
                        <span className="text-[10px] font-bold text-neutral px-2 mb-1">בחר נכסים להצגה</span>
                        {allAvailableAssets.map(asset => (
                          <button
                            key={asset}
                            onClick={() => toggleMarketAsset(asset)}
                            className={cn(
                              "flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors",
                              selectedMarketAssets.includes(asset) ? "bg-primary/20 text-primary" : "hover:bg-white/5 text-neutral"
                            )}
                          >
                            <span>{asset}</span>
                            {selectedMarketAssets.includes(asset) && <Check size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Top Stats Row */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
                  <StatCard 
                    title="סך נכסים מנוהלים" 
                    value={convertCurrency(`₪${stats.totalValue.toLocaleString()}`, currency, USD_RATE)} 
                    subValue={convertCurrency(`₪${Math.round(stats.totalValue * 0.0001).toLocaleString()} רווח יומי`, currency, USD_RATE)} 
                  />
                  <StatCard 
                    title="רווח / הפסד כולל" 
                    value={convertCurrency(`₪${Math.abs(stats.totalProfit).toLocaleString()}${stats.totalProfit >= 0 ? '+' : '-'}`, currency, USD_RATE)} 
                    subValue={`תשואה: ${stats.weightedYield >= 0 ? '+' : ''}${stats.weightedYield.toFixed(2)}%`} 
                    color={stats.totalProfit >= 0 ? "text-success" : "text-danger"} 
                  />
                  <StatCard 
                    title="רווח / הפסד ממומש" 
                    value={convertCurrency(`₪${Math.round(Math.abs(stats.totalProfit) * 0.37).toLocaleString()}+`, currency, USD_RATE)} 
                    subValue="מחילת שנה" 
                    color="text-success" 
                  />
                  <StatCard 
                    title="תשואת דיבידנד" 
                    value={`${stats.dividendYield.toFixed(2)}%`} 
                    subValue="על נכסים מנוהלים" 
                    color="text-primary" 
                    onClick={() => setIsDividendModalOpen(true)}
                  />
                  <StatCard 
                    title="תשואה משוקללת" 
                    value={`${stats.weightedYield >= 0 ? '+' : ''}${stats.weightedYield.toFixed(2)}%`} 
                    subValue="תשואה שנתית" 
                    color="text-primary" 
                  />
                  <StatCard 
                    title="תיקים פעילים" 
                    value={stats.count.toString()} 
                    subValue={`סיכון: ${riskCounts.גבוה} גבוה | ${riskCounts.בינוני} בינוני | ${riskCounts.נמוך} נמוך`} 
                  />
                </div>

                {/* Filter Bar */}
                <div className="flex items-center justify-between bg-surface/40 p-2 rounded-2xl border border-white/5 backdrop-blur-xl shadow-2xl relative overflow-hidden gap-4">
                  {/* Subtle background glow */}
                  <div className="absolute -top-24 -right-24 w-64 h-64 bg-primary/5 blur-[120px] rounded-full pointer-events-none" />
                  
                  {/* Right Side: Market Sentiment (Fear & Greed) */}
                  <div className="flex items-center gap-4 px-4 border-l border-white/10 min-w-[200px]">
                    <div className="flex flex-col items-start gap-1">
                      <div className="flex items-center gap-3">
                        <div className="flex gap-1">
                          {[...Array(10)].map((_, i) => (
                            <div 
                              key={i} 
                              className={cn(
                                "w-1.5 h-4 rounded-sm transition-all duration-700",
                                i < 2 ? "bg-danger shadow-[0_0_12px_rgba(255,71,87,0.6)]" : "bg-white/10"
                              )} 
                            />
                          ))}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[11px] font-black text-danger uppercase tracking-widest leading-none">Bearish</span>
                          <span className="text-[10px] font-bold text-neutral/60 uppercase tracking-tighter">Sentiment</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] font-medium text-neutral/50">
                        <div className="w-1.5 h-1.5 rounded-full bg-danger/50 animate-pulse" />
                        <span>Markets Closed</span>
                        <span className="opacity-20">•</span>
                        <span>Mar 29, 2026</span>
                      </div>
                    </div>
                  </div>

                  {/* Center: Search Bar */}
                  <div className="flex-1 flex justify-center max-w-sm ml-64">
                    <div className="relative w-full group">
                      <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral/60 group-focus-within:text-primary transition-all duration-300" size={16} />
                      <input 
                        type="text" 
                        placeholder="חיפוש לקוח, נייר ערך או סקטור..." 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-2.5 pr-12 pl-5 text-xs font-medium placeholder:text-neutral/40 focus:outline-none focus:border-primary/40 focus:bg-white/[0.06] transition-all duration-300 shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]"
                      />
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-1 bg-white/5 rounded-md border border-white/10 opacity-0 group-focus-within:opacity-100 transition-opacity">
                        <span className="text-[10px] text-neutral/60 font-mono">ESC</span>
                      </div>
                    </div>
                  </div>

                  {/* Left Side: Filters Group */}
                  <div className="flex items-center gap-3 px-4 border-r border-white/10 min-w-[300px] justify-end">
                    {/* More Filters Button */}
                    <div className="relative">
                      <button 
                        onClick={() => setIsMoreFiltersOpen(!isMoreFiltersOpen)}
                        className={cn(
                          "flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border whitespace-nowrap shadow-sm",
                          isMoreFiltersOpen 
                            ? "bg-primary/10 border-primary/30 text-primary shadow-[0_0_15px_rgba(0,255,240,0.1)]" 
                            : "bg-white/5 border-white/10 text-neutral hover:text-white hover:bg-white/10"
                        )}
                      >
                        <Filter size={14} className={isMoreFiltersOpen ? "text-primary" : "text-neutral"} />
                        <span>סינונים נוספים</span>
                      </button>
                      
                      {isMoreFiltersOpen && (
                        <div className="absolute left-0 top-full mt-3 w-80 bg-surface/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-[0_25px_60px_rgba(0,0,0,0.6)] z-50 p-6 flex flex-col gap-6 animate-in fade-in zoom-in-95 duration-200">
                          <div className="flex flex-col gap-4">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-black text-neutral/80 uppercase tracking-widest">סוג נכס</span>
                              <button className="text-[10px] text-primary/80 hover:text-primary transition-colors font-bold">נקה הכל</button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              {['מניות', 'אג"ח', 'מזומן', 'קריפטו'].map(type => (
                                <button key={type} className="px-3 py-2.5 bg-white/5 border border-white/5 rounded-xl text-xs font-bold hover:bg-primary/20 hover:text-primary transition-all text-right">
                                  {type}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="flex flex-col gap-4">
                            <span className="text-xs font-black text-neutral/80 uppercase tracking-widest">סקטור</span>
                            <div className="grid grid-cols-2 gap-2">
                              {['טכנולוגיה', 'פיננסים', 'אנרגיה', 'בריאות'].map(sector => (
                                <button key={sector} className="px-3 py-2.5 bg-white/5 border border-white/5 rounded-xl text-xs font-bold hover:bg-primary/20 hover:text-primary transition-all text-right">
                                  {sector}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Risk Filters */}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-neutral/60 uppercase tracking-widest">סיכון:</span>
                      <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 shadow-inner">
                        {['הכל', 'גבוה', 'בינוני', 'נמוך'].map((filter) => (
                          <button 
                            key={filter}
                            onClick={() => setRiskFilter(filter)}
                            className={cn(
                              "px-5 py-2 text-[11px] font-black rounded-lg transition-all whitespace-nowrap uppercase tracking-tighter",
                              riskFilter === filter 
                                ? "bg-primary text-background shadow-lg shadow-primary/30 scale-[1.05]" 
                                : "text-neutral hover:text-white hover:bg-white/5"
                            )}
                          >
                            {filter}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Risk Summary Bar */}
                <div className="flex items-center gap-12 bg-surface/30 p-4 rounded-2xl border border-white/5 backdrop-blur-sm px-8">
                  <div className="flex items-center gap-3 text-xs font-bold text-neutral/80">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-success shadow-[0_0_8px_rgba(0,255,148,0.4)]" />
                      <span className="text-white">סיכון נמוך:</span>
                      <span className="text-neutral-200">{riskGroupStats.נמוך.count} תיקים</span>
                    </div>
                    <span className="text-white/10">|</span>
                    <div className="flex items-center gap-2">
                      <span className="text-neutral-400">תשואה ממוצעת:</span>
                      <span className={cn("font-black", riskGroupStats.נמוך.avgYield >= 0 ? "text-success" : "text-danger")}>
                        {riskGroupStats.נמוך.avgYield >= 0 ? '+' : ''}{riskGroupStats.נמוך.avgYield.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-xs font-bold text-neutral/80">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-warning shadow-[0_0_8px_rgba(255,184,0,0.4)]" />
                      <span className="text-white">סיכון בינוני:</span>
                      <span className="text-neutral-200">{riskGroupStats.בינוני.count} תיקים</span>
                    </div>
                    <span className="text-white/10">|</span>
                    <div className="flex items-center gap-2">
                      <span className="text-neutral-400">תשואה ממוצעת:</span>
                      <span className={cn("font-black", riskGroupStats.בינוני.avgYield >= 0 ? "text-success" : "text-danger")}>
                        {riskGroupStats.בינוני.avgYield >= 0 ? '+' : ''}{riskGroupStats.בינוני.avgYield.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-xs font-bold text-neutral/80">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-danger shadow-[0_0_8px_rgba(255,77,77,0.4)]" />
                      <span className="text-white">סיכון גבוה:</span>
                      <span className="text-neutral-200">{riskGroupStats.גבוה.count} תיקים</span>
                    </div>
                    <span className="text-white/10">|</span>
                    <div className="flex items-center gap-2">
                      <span className="text-neutral-400">תשואה ממוצעת:</span>
                      <span className={cn("font-black", riskGroupStats.גבוה.avgYield >= 0 ? "text-success" : "text-danger")}>
                        {riskGroupStats.גבוה.avgYield >= 0 ? '+' : ''}{riskGroupStats.גבוה.avgYield.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Overview Section */}
                <div className="bg-surface/40 rounded-3xl border border-white/5 p-7 flex flex-col gap-6">
                  <div className="flex justify-between items-center">
                    <h2 className="text-xl font-black tracking-tight border-r-4 border-primary pr-3">סקירת חשיפה כוללת</h2>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                    {/* Sector Allocation (Right in RTL) */}
                    <div className="flex flex-col gap-5">
                      <div className="flex justify-between items-center">
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">חלוקה לפי סקטורים</h3>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="w-48 h-48 relative">
                          <ResponsiveContainer width="100%" height="100%">
                            <RePieChart>
                              <Pie
                                data={SECTOR_ALLOCATION}
                                cx="50%"
                                cy="50%"
                                innerRadius={60}
                                outerRadius={80}
                                paddingAngle={2}
                                dataKey="value"
                                stroke="none"
                              >
                                {SECTOR_ALLOCATION.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={entry.color} />
                                ))}
                              </Pie>
                            </RePieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex flex-col gap-3 min-w-[160px]">
                          {SECTOR_ALLOCATION.map((s, idx) => (
                            <div key={idx} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                                <span className="text-xs font-bold text-neutral/80">{s.name}</span>
                              </div>
                              <span className="text-sm font-black text-white">{s.value}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Asset Allocation (Left in RTL) */}
                    <div className="flex flex-col gap-5">
                      <div className="flex justify-between items-center">
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">חלוקת נכסים</h3>
                      </div>
                      <div className="flex flex-col gap-7 mt-6">
                        <div className="flex flex-col gap-2">
                          <div className="flex justify-between text-xs font-bold text-neutral/80">
                            <span>מניות</span>
                            <span className="text-white">(100.0%) {convertCurrency("₪3,754,168", currency, USD_RATE)}</span>
                          </div>
                          <div className="bg-white/5 h-7 rounded-xl overflow-hidden">
                            <div className="bg-primary h-full shadow-[0_0_20px_rgba(0,229,255,0.4)]" style={{ width: '100%' }} />
                          </div>
                        </div>
                        <div className="flex flex-col gap-2">
                          <div className="flex justify-between text-xs font-bold text-neutral/80">
                            <span>אג"ח</span>
                            <span className="text-white">(0.0%) {convertCurrency("₪0", currency, USD_RATE)}</span>
                          </div>
                          <div className="bg-white/5 h-7 rounded-xl overflow-hidden">
                            <div className="bg-white/5 h-full" style={{ width: '0%' }} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Portfolios Section */}
                <div className="flex flex-col gap-4">
                  <div className="flex justify-between items-end">
                    <h3 className="font-bold text-xl border-r-4 border-primary pr-3">ניהול תיקי השקעות</h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                    {filteredClients.map((client) => (
                      <ClientCard key={client.id} client={client} onClick={() => setSelectedClient(client)} currency={currency} rate={USD_RATE} />
                    ))}
                  </div>
                </div>
              </motion.div>
            ) : currentTab === 'חדשות שוק ההון' ? (
              <motion.div 
                key="news"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="max-w-4xl mx-auto flex flex-col gap-8"
              >
                <div className="flex flex-col gap-2">
                  <h2 className="text-3xl font-black tracking-tight">חדשות שוק ההון</h2>
                  <p className="text-neutral font-bold uppercase tracking-widest text-xs">עדכונים שוטפים, ניתוחים ואירועים מרכזיים מהבורסות בארץ ובעולם</p>
                </div>

                <div className="flex flex-col gap-4">
                  {NEWS_ITEMS.map((news) => (
                    <motion.div 
                      key={news.id}
                      whileHover={{ x: -10 }}
                      className="bg-surface/40 border border-white/5 p-6 rounded-3xl backdrop-blur-xl flex flex-col gap-4 group cursor-pointer hover:border-primary/30 transition-all"
                    >
                      <div className="flex justify-between items-start">
                        <span className="text-xs font-black text-primary bg-primary/10 px-3 py-1 rounded-full uppercase tracking-widest">
                          {news.category}
                        </span>
                        <span className="text-[10px] font-bold text-neutral/60 uppercase">{news.time} | {news.source}</span>
                      </div>
                      <h3 className="text-xl font-black text-white leading-tight group-hover:text-primary transition-colors">
                        {news.title}
                      </h3>
                      <div className="flex items-center gap-2 text-neutral/40 text-xs font-bold">
                        <span>קרא עוד</span>
                        <ArrowUpRight size={14} />
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            ) : currentTab === 'שווקים' ? (
              <motion.div 
                key="markets"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="max-w-7xl mx-auto flex flex-col gap-10 w-full"
              >
                <div className="flex flex-col gap-2">
                  <h2 className="text-4xl font-black tracking-tight">מרכז נתוני שוק גלובלי</h2>
                  <p className="text-neutral font-bold uppercase tracking-widest text-xs opacity-70">ניתוח מקיף של מדדים, אג"ח, מניות דיבידנד וסקטורים מובילים בזמן אמת</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* מדדים מרכזיים */}
                  <div className="flex flex-col gap-6">
                    <div className="flex items-center justify-between border-r-4 border-primary pr-4">
                      <h3 className="text-xl font-black tracking-tight">{MARKET_CATEGORIES.indices.title}</h3>
                      <Globe size={20} className="text-primary/40" />
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      {MARKET_CATEGORIES.indices.items.map((item: any, idx: number) => (
                        <MarketItem key={idx} item={item} />
                      ))}
                    </div>
                  </div>

                  {/* אג"ח ממשלתי */}
                  <div className="flex flex-col gap-6">
                    <div className="flex items-center justify-between border-r-4 border-primary pr-4">
                      <h3 className="text-xl font-black tracking-tight">{MARKET_CATEGORIES.bonds.title}</h3>
                      <ShieldCheck size={20} className="text-primary/40" />
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      {MARKET_CATEGORIES.bonds.items.map((item: any, idx: number) => (
                        <MarketItem key={idx} item={item} isBond />
                      ))}
                    </div>
                  </div>

                  {/* מניות דיבידנד גבוה */}
                  <div className="flex flex-col gap-6">
                    <div className="flex items-center justify-between border-r-4 border-primary pr-4">
                      <h3 className="text-xl font-black tracking-tight">{MARKET_CATEGORIES.dividends.title}</h3>
                      <TrendingUp size={20} className="text-primary/40" />
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      {MARKET_CATEGORIES.dividends.items.map((item: any, idx: number) => (
                        <MarketItem key={idx} item={item} isDiv />
                      ))}
                    </div>
                  </div>

                  {/* מדדי סקטורים */}
                  <div className="flex flex-col gap-6">
                    <div className="flex items-center justify-between border-r-4 border-primary pr-4">
                      <h3 className="text-xl font-black tracking-tight">{MARKET_CATEGORIES.sectors.title}</h3>
                      <BarChart3 size={20} className="text-primary/40" />
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      {MARKET_CATEGORIES.sectors.items.map((item: any, idx: number) => (
                        <MarketItem key={idx} item={item} />
                      ))}
                    </div>
                  </div>

                  {/* מובילי תשואה - Full Width Section */}
                  <div className="lg:col-span-2 flex flex-col gap-8 pt-8 border-t border-white/5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div className="flex items-center gap-4 border-r-4 border-primary pr-4">
                        <h3 className="text-2xl font-black tracking-tight">{MARKET_CATEGORIES.leaders.title}</h3>
                        <div className="flex bg-white/5 p-1 rounded-xl border border-white/10">
                          {(['daily', 'monthly', 'annual'] as const).map((p) => (
                            <button
                              key={p}
                              onClick={() => setMarketPeriod(p)}
                              className={cn(
                                "px-4 py-1.5 text-[10px] font-black rounded-lg transition-all uppercase tracking-widest",
                                marketPeriod === p ? "bg-primary text-background shadow-lg" : "text-neutral hover:text-white"
                              )}
                            >
                              {p === 'daily' ? 'יומי' : p === 'monthly' ? 'חודשי' : 'שנתי'}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      {(MARKET_CATEGORIES.leaders[marketPeriod] as any[]).map((stock: any, idx: number) => (
                        <div key={idx} className="bg-surface/40 border border-white/5 p-5 rounded-3xl backdrop-blur-xl hover:border-primary/30 transition-all group relative overflow-hidden">
                          <div className="absolute -right-4 -top-4 w-16 h-16 bg-primary/5 blur-2xl rounded-full group-hover:bg-primary/10 transition-colors" />
                          <div className="flex justify-between items-start mb-4">
                            <div className={cn(
                              "w-10 h-10 rounded-xl flex items-center justify-center text-[10px] font-black",
                              stock.market === 'US' ? "bg-blue-500/10 text-blue-400" : "bg-green-500/10 text-green-400"
                            )}>
                              {stock.market}
                            </div>
                            <span className={cn("text-lg font-black", stock.isPositive ? "text-success" : "text-danger")}>
                              {stock.change}
                            </span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-xl font-black text-white tracking-tight">{stock.symbol}</span>
                            <span className="text-xs font-bold text-neutral/60 uppercase tracking-widest">{stock.name}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : currentTab === 'תנועות הון בין ענפים' ? (
              <motion.div 
                key="flows"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                <div className="flex flex-col gap-2">
                  <h2 className="text-3xl font-black tracking-tight">תנועות הון בין ענפים</h2>
                  <p className="text-neutral font-bold uppercase tracking-widest text-xs">ניתוח זרימת כספים ושינויי פוזיציות בסקטורים השונים</p>
                </div>
                
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <div className="bg-surface/40 rounded-3xl border border-white/5 p-8 flex flex-col gap-6">
                    <h3 className="text-lg font-black border-r-4 border-primary pr-3">זרימת הון נטו (30 יום)</h3>
                    <div className="flex flex-col gap-4">
                      {[
                        { sector: 'טכנולוגיה', flow: '+₪1.2B', color: '#00E5FF' },
                        { sector: 'אנרגיה', flow: '-₪450M', color: '#FF3D00' },
                        { sector: 'פיננסים', flow: '+₪820M', color: '#7C4DFF' },
                        { sector: 'צריכה', flow: '-₪120M', color: '#FFC400' },
                      ].map((item, idx) => (
                        <div key={idx} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                          <div className="flex items-center gap-3">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                            <span className="font-bold">{item.sector}</span>
                          </div>
                          <span className={cn(
                            "font-black",
                            item.flow.startsWith('+') ? "text-primary" : "text-destructive"
                          )}>{item.flow}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-surface/40 rounded-3xl border border-white/5 p-8 flex flex-col gap-6">
                    <h3 className="text-lg font-black border-r-4 border-primary pr-3">שינוי חשיפה ממוצע</h3>
                    <div className="h-64 flex items-end justify-between gap-4 px-4">
                      {[45, 78, 32, 65, 89, 54].map((h, i) => (
                        <div key={i} className="flex-1 flex flex-col items-center gap-3">
                          <div 
                            className="w-full bg-primary/20 border border-primary/30 rounded-t-lg relative group transition-all hover:bg-primary/40"
                            style={{ height: `${h}%` }}
                          >
                            <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-primary text-background text-[10px] font-black px-2 py-1 rounded">
                              {h}%
                            </div>
                          </div>
                          <span className="text-[10px] font-bold text-neutral">S{i+1}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : currentTab === 'אנליטיקה' ? (
              <motion.div 
                key="analytics"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-2xl border-r-4 border-primary pr-3">אנליטיקה מתקדמת</h3>
                </div>

                <div className="flex flex-col gap-6">
                  {/* Risk Distribution - Top Row */}
                  <div className="bg-surface p-8 rounded-2xl border border-white/5 flex flex-col gap-6">
                    <div className="flex justify-between items-center">
                      <h4 className="font-bold text-lg">התפלגות סיכונים</h4>
                      <div className="flex gap-6">
                        {RISK_DISTRIBUTION.map((item, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <div className={cn("w-2 h-2 rounded-full", item.color.replace('text-', 'bg-'))} />
                            <span className="text-xs font-bold text-neutral/90">{item.name}: {item.value}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <RePieChart>
                          <Pie
                            data={RISK_DISTRIBUTION}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={80}
                            paddingAngle={5}
                            dataKey="value"
                          >
                            {RISK_DISTRIBUTION.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip 
                            contentStyle={{ backgroundColor: '#1A1D21', border: 'none', borderRadius: '12px' }}
                            itemStyle={{ color: '#fff' }}
                          />
                        </RePieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Performance Chart */}
                    <div className="lg:col-span-2 bg-surface p-8 rounded-2xl border border-white/5 flex flex-col gap-6">
                      <div className="flex justify-between items-center">
                        <h4 className="font-bold text-lg">ביצועי תיקים מצטברים</h4>
                        <div className="flex gap-4 text-[10px] font-bold">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-primary" />
                            <span>תיקי לקוחות</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-neutral" />
                            <span>מדד ייחוס (S&P 500)</span>
                          </div>
                        </div>
                      </div>
                      <div className="h-80 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={ANALYTICS_DATA}>
                            <defs>
                              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#00FF94" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#00FF94" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                            <XAxis dataKey="name" stroke="#666" fontSize={10} tickLine={false} axisLine={false} />
                            <YAxis stroke="#666" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(value) => `${currency === 'USD' ? '$' : '₪'}${value}k`} />
                            <Tooltip 
                              contentStyle={{ backgroundColor: '#1A1D21', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                              itemStyle={{ color: '#00FF94' }}
                            />
                            <Area type="monotone" dataKey="value" stroke="#00FF94" fillOpacity={1} fill="url(#colorValue)" strokeWidth={3} />
                            <Area type="monotone" dataKey="benchmark" stroke="#666" fill="transparent" strokeWidth={2} strokeDasharray="5 5" />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Side Column: Health & Top Holdings */}
                    <div className="flex flex-col gap-6">
                      <div className="bg-surface rounded-2xl border border-white/5 p-6 flex flex-col gap-4">
                        <h4 className="text-sm font-bold text-neutral uppercase tracking-wider">מדד בריאות תיק כולל</h4>
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <span className="text-3xl font-black text-success">94%</span>
                            <span className="text-[10px] text-neutral font-bold uppercase">ציון איכות</span>
                          </div>
                          <div className="w-12 h-12 rounded-full border-4 border-success/20 border-t-success flex items-center justify-center">
                            <CheckCircle2 className="text-success" size={20} />
                          </div>
                        </div>
                        <p className="text-[10px] text-neutral leading-relaxed">
                          התיקים מגוונים היטב ועומדים ביעדי התשואה. מומלץ לבחון מחדש את החשיפה לסקטור הטכנולוגיה בשבוע הבא.
                        </p>
                      </div>

                      <div className="bg-surface p-6 rounded-2xl border border-white/5 space-y-4">
                        <h4 className="text-sm font-bold text-neutral uppercase tracking-wider">אחזקות מובילות</h4>
                        <div className="space-y-3">
                          {[
                            { name: 'NVIDIA Corp', symbol: 'NVDA', weight: '12.4%', change: '+2.4%' },
                            { name: 'Apple Inc', symbol: 'AAPL', weight: '9.8%', change: '-0.5%' },
                            { name: 'Microsoft', symbol: 'MSFT', weight: '8.2%', change: '+1.2%' },
                            { name: 'S&P 500 ETF', symbol: 'VOO', weight: '7.5%', change: '+0.3%' },
                          ].map((holding, idx) => (
                            <div key={idx} className="flex items-center justify-between p-2 bg-white/[0.02] rounded-lg border border-white/5">
                              <div className="flex flex-col">
                                <span className="text-xs font-bold">{holding.symbol}</span>
                                <span className="text-[10px] text-neutral">{holding.weight}</span>
                              </div>
                              <span className={cn("text-[10px] font-bold", holding.change.includes('+') ? "text-success" : "text-danger")}>
                                {holding.change}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-surface rounded-2xl border border-white/5 p-6 space-y-4">
                    <h4 className="text-sm font-bold text-neutral uppercase tracking-wider">אחזקות מובילות (כלל הלקוחות)</h4>
                    <div className="space-y-3">
                      {[
                        { name: 'NVIDIA Corp', symbol: 'NVDA', weight: '12.4%', change: '+2.4%' },
                        { name: 'Apple Inc', symbol: 'AAPL', weight: '9.8%', change: '-0.5%' },
                        { name: 'Microsoft', symbol: 'MSFT', weight: '8.2%', change: '+1.2%' },
                        { name: 'S&P 500 ETF', symbol: 'VOO', weight: '7.5%', change: '+0.3%' },
                      ].map((holding, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-white/[0.02] rounded-xl border border-white/5">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-[10px] font-bold">
                              {holding.symbol}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-xs font-bold">{holding.name}</span>
                              <span className="text-[10px] text-neutral">{holding.symbol}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-bold">{holding.weight}</p>
                            <p className={cn("text-[10px] font-bold", holding.change.includes('+') ? "text-success" : "text-danger")}>{holding.change}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-surface rounded-2xl border border-white/5 p-6 space-y-4">
                    <h4 className="text-sm font-bold text-neutral uppercase tracking-wider">תובנות מבוססות AI</h4>
                    <div className="space-y-4">
                      <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary shrink-0">
                          <TrendingUp size={16} />
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs font-bold">הזדמנות בשוק האנרגיה</p>
                          <p className="text-[10px] text-neutral leading-relaxed">זיהינו תת-חשיפה לסקטור האנרגיה ב-65% מתיקי הלקוחות. שקול הגדלת חשיפה ל-XLE.</p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-500 shrink-0">
                          <AlertCircle size={16} />
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs font-bold">חריגת סיכון בתיקי 'בינוני'</p>
                          <p className="text-[10px] text-neutral leading-relaxed">3 תיקים ברמת סיכון בינונית חורגים מהסטייה המותרת עקב עליית שווי מניות השבבים.</p>
                        </div>
                      </div>
                      <button className="w-full py-2 border border-primary/30 text-primary text-[10px] font-bold rounded-xl hover:bg-primary/5 transition-colors">
                        צפה בכל התובנות (12)
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : currentTab === 'ניתוח אסטרטגי' ? (
              <motion.div 
                key="strategic-analysis"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                <div className="flex justify-between items-center">
                  <div className="flex flex-col gap-1">
                    <h3 className="font-bold text-2xl border-r-4 border-primary pr-3">ניתוח אסטרטגי</h3>
                    <p className="text-xs text-neutral/60 pr-3">מערכת מנוהלת על ידי 6 סוכני AI מומחים</p>
                  </div>
                </div>
                <StrategicAnalysis />
              </motion.div>
            ) : currentTab === 'רשימת מעקב' ? (
              <motion.div 
                key="watchlist"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                <div className="flex justify-between items-center">
                  <div className="flex flex-col gap-1">
                    <h3 className="font-bold text-2xl border-r-4 border-primary pr-3">רשימת מעקב</h3>
                    <p className="text-xs text-neutral/60 pr-3">עקוב אחר מניות והגדר התראות חכמות</p>
                  </div>
                  <button className="bg-primary/10 text-primary border border-primary/20 px-4 py-2 rounded-xl text-xs font-bold hover:bg-primary/20 transition-all flex items-center gap-2">
                    <Plus size={14} />
                    <span>הוסף מניה</span>
                  </button>
                </div>
                <Watchlist />
              </motion.div>
            ) : currentTab === 'איזון מחדש' ? (
              <motion.div 
                key="rebalance"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-2xl border-r-4 border-primary pr-3">איזון מחדש</h3>
                </div>
                <div className="bg-surface p-12 rounded-3xl border border-white/5 flex flex-col items-center justify-center text-center gap-6">
                  <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center text-primary">
                    <RefreshCw size={40} />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xl font-bold">אופטימיזציה של תיקי השקעות</h4>
                    <p className="text-neutral max-w-md">כאן תוכל לבצע איזון מחדש אוטומטי לתיקי הלקוחות שלך בהתאם למדיניות ההשקעה והחשיפה המוגדרת.</p>
                  </div>
                  <button className="bg-primary text-background px-8 py-3 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-primary/20">הפעל איזון מחדש</button>
                </div>
              </motion.div>
            ) : currentTab === 'חדשות שוק ההון' ? (
              <motion.div 
                key="news"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-7xl mx-auto flex flex-col gap-8"
              >
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-2xl border-r-4 border-primary pr-3">חדשות שוק ההון</h3>
                </div>
                <div className="bg-surface p-12 rounded-3xl border border-white/5 flex flex-col items-center justify-center text-center gap-6">
                  <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center text-primary">
                    <FileText size={40} />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xl font-bold">עדכוני שוק בזמן אמת</h4>
                    <p className="text-neutral max-w-md">קבל את כל החדשות, הניתוחים והאירועים הכלכליים המשפיעים על תיקי ההשקעות של הלקוחות שלך.</p>
                  </div>
                  <button className="bg-primary text-background px-8 py-3 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-primary/20">צפה בחדשות האחרונות</button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </main>

      {/* Modals */}
      <Modal isOpen={isDividendModalOpen} onClose={() => setIsDividendModalOpen(false)} title="פירוט תשואת דיבידנד">
        <div className="flex flex-col gap-8">
          {/* Summary Header */}
          <div className="bg-primary/10 border border-primary/20 p-6 rounded-2xl flex flex-col items-center text-center gap-2">
            <span className="text-xs font-bold text-primary uppercase tracking-widest">סך קבלת דיבידנד (שנתי משוער)</span>
            <span className="text-4xl font-black text-white">{convertCurrency("₪16,640", currency, USD_RATE)}</span>
            <span className="text-sm font-bold text-neutral/60">תשואה ממוצעת: 3.42%</span>
          </div>

          {/* Filters */}
          <div className="flex flex-col gap-4">
            <span className="text-xs font-bold text-neutral/80 uppercase tracking-widest">סינון לפי רמת סיכון</span>
            <div className="flex gap-2">
              {['הכל', 'סיכון גבוה', 'סיכון בינוני', 'סיכון נמוך'].map((risk) => (
                <button
                  key={risk}
                  onClick={() => setDividendRiskFilter(risk)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs font-bold transition-all border",
                    dividendRiskFilter === risk 
                      ? "bg-primary border-primary text-white shadow-lg shadow-primary/20" 
                      : "bg-white/5 border-white/10 text-neutral hover:text-white hover:bg-white/10"
                  )}
                >
                  {risk === 'הכל' ? 'הכל' : risk.replace('סיכון ', '')}
                </button>
              ))}
            </div>
          </div>

          {/* Portfolio List */}
          <div className="flex flex-col gap-4">
            <span className="text-xs font-bold text-neutral/80 uppercase tracking-widest">תיקים מזכי דיבידנד</span>
            <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {CLIENTS.filter(c => dividendRiskFilter === 'הכל' || c.risk === dividendRiskFilter).map(client => (
                <div key={client.id} className="bg-white/5 border border-white/5 p-4 rounded-xl flex justify-between items-center hover:bg-white/10 transition-colors">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-bold text-white">{client.name}</span>
                    <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full w-fit", client.riskColor)}>
                      {client.risk}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm font-black text-primary">{convertCurrency((client as any).dividend || '₪0', currency, USD_RATE)}</span>
                    <span className="text-[10px] font-bold text-neutral/60">שווי תיק: {convertCurrency(client.value, currency, USD_RATE)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <button 
            onClick={() => setIsDividendModalOpen(false)}
            className="w-full bg-white/5 hover:bg-white/10 border border-white/10 py-4 rounded-xl text-sm font-bold transition-all"
          >
            סגור
          </button>
        </div>
      </Modal>

      <Modal isOpen={isAddClientOpen} onClose={() => setIsAddClientOpen(false)} title="הוספת לקוח חדש">
        <form onSubmit={handleAddClient} className="space-y-6">
          <div className="space-y-2">
            <label className="text-xs text-neutral font-bold uppercase">שם מלא</label>
            <input 
              type="text" 
              required
              value={newClient.name}
              onChange={e => setNewClient({...newClient, name: e.target.value})}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors"
              placeholder="ישראל ישראלי"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-neutral font-bold uppercase">רמת סיכון</label>
            <div className="grid grid-cols-3 gap-3">
              {['נמוך', 'בינוני', 'גבוה'].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setNewClient({...newClient, risk: r})}
                  className={cn(
                    "py-2 rounded-xl border text-xs font-bold transition-all",
                    newClient.risk === r ? "bg-primary border-primary text-background" : "bg-white/5 border-white/10 text-neutral hover:border-white/20"
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-neutral font-bold uppercase">הפקדה ראשונית ({currency === 'USD' ? '$' : '₪'})</label>
            <input 
              type="number" 
              required
              value={newClient.deposit}
              onChange={e => setNewClient({...newClient, deposit: e.target.value})}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors"
              placeholder="50,000"
            />
          </div>
          <div className="pt-4 flex gap-3">
            <button type="submit" className="flex-1 bg-primary text-background font-bold py-3 rounded-xl hover:opacity-90 transition-opacity shadow-lg shadow-primary/20">צור תיק לקוח</button>
            <button type="button" onClick={() => setIsAddClientOpen(false)} className="flex-1 bg-white/5 text-white font-bold py-3 rounded-xl hover:bg-white/10 transition-colors">ביטול</button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!selectedClient} onClose={() => setSelectedClient(null)} title={`פרטי תיק: ${selectedClient?.name}`}>
        {selectedClient && (
          <div className="space-y-8">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 flex flex-col items-center">
                <p className="text-[10px] text-neutral font-bold uppercase mb-1">תשואה</p>
                <p className={cn("text-xl font-bold", selectedClient.yield.includes('+') ? "text-success" : "text-danger")}>{selectedClient.yield}</p>
              </div>
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 flex flex-col items-center">
                <p className="text-[10px] text-neutral font-bold uppercase mb-1">רווח/הפסד</p>
                <p className={cn("text-xl font-bold", selectedClient.profit.includes('+') ? "text-success" : "text-danger")}>{convertCurrency(selectedClient.profit, currency, USD_RATE)}</p>
              </div>
              <div className="bg-white/5 p-4 rounded-2xl border border-white/10 flex flex-col items-center">
                <p className="text-[10px] text-neutral font-bold uppercase mb-1">שווי כולל</p>
                <p className="text-xl font-bold text-success">{convertCurrency(selectedClient.value, currency, USD_RATE)}</p>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-xs font-bold text-neutral uppercase flex items-center gap-2">
                <LayoutGrid size={14} className="text-primary" />
                פירוט אחזקות
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                {selectedClient.holdings.map((h: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary font-bold text-[10px]">
                        {h.name.substring(0, 2)}
                      </div>
                      <span className="text-sm font-bold">{h.name}</span>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-bold">{h.weight}</p>
                      <p className="text-[10px] text-neutral">משקל בתיק</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-xs font-bold text-neutral uppercase flex items-center gap-2">
                <TrendingUp size={14} className="text-primary" />
                ביצועים היסטוריים
              </h4>
              <div className="h-48 w-full bg-white/[0.02] rounded-2xl border border-white/5 p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={selectedClient.chartData}>
                    <defs>
                      <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00FF94" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#00FF94" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#1A1D21', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                      itemStyle={{ color: '#00FF94' }}
                    />
                    <Area type="monotone" dataKey="y" stroke="#00FF94" fillOpacity={1} fill="url(#colorVal)" strokeWidth={3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-4">
              <button className="flex items-center justify-center gap-2 bg-primary text-background font-bold py-3 rounded-xl hover:opacity-90 transition-opacity shadow-lg shadow-primary/20">
                <ArrowLeftRight size={18} />
                הפקדה / משיכה
              </button>
              <button className="flex items-center justify-center gap-2 bg-white/5 text-white font-bold py-3 rounded-xl hover:bg-white/10 transition-colors">
                <Settings size={18} />
                שינוי הקצאה
              </button>
              <button className="col-span-2 flex items-center justify-center gap-2 border border-white/10 text-white font-bold py-3 rounded-xl hover:bg-white/5 transition-colors">
                <FileText size={18} />
                הפקת דוח מפורט
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
