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

// FRED API key — free registration at https://fred.stlouisfed.org/docs/api/api_key.html
// Used for US macro indicators: CPI, Core CPI, Fed Funds Rate, GDP, Unemployment
const FRED_API_KEY = _env.FRED_API_KEY || 'f568440cde5cb64b20cd92e80292fbac';

// Initialize Supabase client (uses the CDN global: supabase)
//
// WHY implicit flow:
//   The default PKCE flow requires a server-side code-exchange request back to Supabase
//   after Google redirects the user to the app. If the redirectTo URL doesn't pass
//   Supabase's server-side allowlist validation (exact-match, case-sensitive), Supabase
//   silently falls back to the Site URL. With implicit flow, tokens are placed directly
//   in the URL hash (#access_token=...) — no server round-trip, no allowlist validation
//   for the final redirect step. The SDK reads the hash automatically on page load.
let supabaseClient;
try {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            flowType:         'implicit',
            detectSessionInUrl: true,
            persistSession:   true,
            autoRefreshToken: true,
        }
    });
    console.log('[Supabase] init | origin:', window.location.origin, '| flow: implicit');
} catch (e) {
    console.error('[Supabase] createClient failed:', e.message);
}

// ========== AUTH STATE CHANGE LISTENER ==========
// Handles three cases:
//   INITIAL_SESSION  — existing localStorage session on a normal page load
//   SIGNED_IN        — OAuth return (implicit flow puts tokens in hash; SDK fires this
//                      automatically when detectSessionInUrl:true reads #access_token)
//   TOKEN_REFRESHED  — silent token refresh
//   SIGNED_OUT       — explicit logout
//
// The _dashboardBooted flag prevents double-init when email/password login calls
// onAuthSuccess() directly and the SDK also fires SIGNED_IN simultaneously.
if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        console.log('[Auth] onAuthStateChange:', event, '| user:', session?.user?.email ?? 'none');

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            if (!session?.user) return;

            const username = session.user.user_metadata?.full_name
                || session.user.user_metadata?.username
                || session.user.email;

            localStorage.setItem('authToken', session.access_token);
            localStorage.setItem('authUser', JSON.stringify({ id: session.user.id, username }));

            // SIGNED_IN fires for OAuth return-from-Google AND for email/password login.
            // Only bootstrap the dashboard here for the OAuth path (where _dashboardBooted
            // is still false). Email/password calls onAuthSuccess() itself, which sets the flag.
            if (event === 'SIGNED_IN' && !window._dashboardBooted) {
                window._dashboardBooted = true;
                console.log('[Auth] OAuth sign-in complete — bootstrapping dashboard');
                setTimeout(() => {
                    if (typeof onAuthSuccess === 'function') onAuthSuccess();
                }, 0);
            } else if (typeof updateUserDisplay === 'function') {
                updateUserDisplay();
            } else {
                const ua = document.getElementById('userArea');
                if (ua) ua.style.cssText = 'display: flex !important;';
            }

        } else if (event === 'SIGNED_OUT') {
            localStorage.removeItem('authToken');
            localStorage.removeItem('authUser');
            window._dashboardBooted = false;
            if (typeof clearAllAppData === 'function') clearAllAppData();
            if (typeof updateUserDisplay === 'function') updateUserDisplay();
            else {
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
