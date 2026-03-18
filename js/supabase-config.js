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
let supabaseClient;
try {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
    console.error('Failed to create Supabase client:', e.message, '| URL:', SUPABASE_URL);
}

// ========== AUTH STATE CHANGE LISTENER ==========
// Keeps username/logout button visible across page loads, token refreshes, and OAuth redirects.
if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        console.log('[Auth] State change:', event);

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            if (session && session.user) {
                const username = session.user.user_metadata?.full_name
                    || session.user.user_metadata?.username
                    || session.user.email;
                // Persist to localStorage so updateUserDisplay() can read it
                localStorage.setItem('authToken', session.access_token);
                localStorage.setItem('authUser', JSON.stringify({
                    id: session.user.id,
                    username
                }));
                // Update UI if auth.js has loaded
                if (typeof updateUserDisplay === 'function') {
                    updateUserDisplay();
                } else {
                    // auth.js not loaded yet — force #userArea visible directly
                    const ua = document.getElementById('userArea');
                    if (ua) ua.style.cssText = 'display: flex !important;';
                }
            }
        } else if (event === 'SIGNED_OUT') {
            localStorage.removeItem('authToken');
            localStorage.removeItem('authUser');
            if (typeof updateUserDisplay === 'function') {
                updateUserDisplay();
            } else {
                const ua = document.getElementById('userArea');
                if (ua) ua.style.cssText = 'display: none !important;';
            }
        }
    });
}

// Connection status flag
let supabaseConnected = false;

// Test Supabase connection
async function checkSupabaseConnection() {
    try {
        // Fast path: if URL is clearly not configured, skip network call
        if (SUPABASE_URL.includes('YOUR_PROJECT_ID') || SUPABASE_ANON_KEY.includes('YOUR_ANON')) {
            console.warn('Supabase not configured — using backend API.');
            supabaseConnected = false;
            return false;
        }

        // Skip the old profiles health-check query — it added 1-2s latency.
        // Instead, trust that if we have a valid session/token, Supabase is reachable.
        // The actual supaFetchClients() call will fail gracefully if DB is down.
        if (!supabaseClient) {
            supabaseConnected = false;
            return false;
        }

        console.log('Supabase configured — connection assumed OK.');
        supabaseConnected = true;
        return true;
    } catch (err) {
        console.warn('Supabase check error:', err.message);
        supabaseConnected = false;
        return false;
    }
}
