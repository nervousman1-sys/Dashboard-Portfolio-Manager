// ========== SUPABASE CONFIG - Client Initialization ==========

// Environment variables (injected by build.js on Vercel, fallback to defaults for local dev)
const _env = (typeof __ENV !== 'undefined') ? __ENV : {};

// Supabase credentials — Found at: https://supabase.com/dashboard → Project Settings → API
const SUPABASE_URL = _env.SUPABASE_URL || 'https://jdebxhxaiwbtgweruznd.supabase.co';
const SUPABASE_ANON_KEY = _env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpkZWJ4aHhhaXdidGd3ZXJ1em5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyMTU2NjEsImV4cCI6MjA4ODc5MTY2MX0.4TPj2h_ftWi-2fIGM1y6vrcwzk3_vheBmbat3PrgjQc';

// Financial Modeling Prep API key (free: https://site.financialmodelingprep.com/developer)
const FMP_API_KEY = _env.FMP_API_KEY || 'PNbEHsY2AO0v9ZkYh69P7nTvyUUckcpp';

// Twelve Data API key (free: https://twelvedata.com/pricing)
const TWELVE_DATA_API_KEY = _env.TWELVE_DATA_API_KEY || '02940d45b4584a37a9e1c45940b912e7';

// Finnhub API key (free: https://finnhub.io/register — 60 calls/min, all US stocks)
const FINNHUB_API_KEY = _env.FINNHUB_API_KEY || 'd6ji4k9r01qkvh5q0aa0d6ji4k9r01qkvh5q0aag';

// Initialize Supabase client (uses the CDN global: supabase)
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Connection status flag
let supabaseConnected = false;

// Test Supabase connection
async function checkSupabaseConnection() {
    try {
        // Quick health check — try to reach the DB
        const { error } = await supabaseClient.from('profiles').select('id').limit(1);

        if (error && error.code === 'PGRST301') {
            // Table doesn't exist yet — connection works, schema not set up
            console.warn('Supabase connected but tables not found. Run the SQL schema first.');
            supabaseConnected = false;
            return false;
        }

        if (error && (SUPABASE_URL.includes('YOUR_PROJECT_ID') || SUPABASE_ANON_KEY.includes('YOUR_ANON'))) {
            console.warn('Supabase not configured — using backend API. Update SUPABASE_URL and SUPABASE_ANON_KEY in supabase-config.js');
            supabaseConnected = false;
            return false;
        }

        if (error) {
            console.warn('Supabase connection error:', error.message);
            supabaseConnected = false;
            return false;
        }

        console.log('Supabase connected successfully.');
        supabaseConnected = true;
        return true;
    } catch (err) {
        console.warn('Supabase unreachable, falling back to backend API:', err.message);
        supabaseConnected = false;
        return false;
    }
}
