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
// IMPORTANT — flowType: 'implicit'
//   Supabase JS SDK v2 defaults to PKCE, which requires a server-side code-exchange call.
//   If the redirectTo URL doesn't pass Supabase's server-side allowlist validation,
//   Supabase silently falls back to the project's Site URL (www.finextium.com).
//   Switching to 'implicit' flow puts tokens directly in the URL hash (#access_token=...)
//   and skips the server-side exchange entirely — redirect matching is simpler and
//   works correctly with localhost during development.
let supabaseClient;
try {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            flowType: 'implicit',               // Hash-based tokens — no server code-exchange
            redirectTo: window.location.origin, // Default redirect for all auth operations
            detectSessionInUrl: true,           // Auto-parse #access_token from URL on load
            persistSession: true,               // Keep session in localStorage across refreshes
            autoRefreshToken: true,             // Silently refresh tokens before expiry
        }
    });
    console.log('[Supabase] Client initialized | origin:', window.location.origin, '| flow: implicit');
} catch (e) {
    console.error('Failed to create Supabase client:', e.message, '| URL:', SUPABASE_URL);
}

// ========== AUTH STATE CHANGE LISTENER ==========
// Handles session persistence across page loads, token refreshes, and OAuth redirects.
//
// CRITICAL — OAuth redirect flow:
//   After Google OAuth, Supabase redirects back with tokens in the URL hash/query.
//   The SDK processes these asynchronously (PKCE requires a network code-exchange call).
//   When complete, it fires SIGNED_IN here. checkAuthAndInit() in init.js detects the
//   OAuth callback and returns early, so this handler is the sole bootstrap path.
//   The _dashboardInitialized flag prevents double-init with the email/password path.
if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        console.log('[Auth] onAuthStateChange:', event, '| user:', session?.user?.email || 'none');

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            if (session && session.user) {
                const username = session.user.user_metadata?.full_name
                    || session.user.user_metadata?.username
                    || session.user.email;

                // Persist to localStorage so the rest of the app can read the session
                localStorage.setItem('authToken', session.access_token);
                localStorage.setItem('authUser', JSON.stringify({
                    id: session.user.id,
                    username
                }));

                // SIGNED_IN fires for both email/password AND OAuth redirect-back.
                // For email/password, onAuthSuccess() already ran from handleLogin().
                // For OAuth redirect-back, init() has NOT been called yet — do it now.
                if (event === 'SIGNED_IN' && !window._dashboardInitialized) {
                    window._dashboardInitialized = true;
                    console.log('[Auth] SIGNED_IN via OAuth — bootstrapping dashboard');
                    // Defer one tick so all scripts are guaranteed to be parsed
                    setTimeout(() => {
                        if (typeof onAuthSuccess === 'function') {
                            onAuthSuccess();
                        }
                    }, 0);
                } else if (typeof updateUserDisplay === 'function') {
                    updateUserDisplay();
                } else {
                    const ua = document.getElementById('userArea');
                    if (ua) ua.style.cssText = 'display: flex !important;';
                }
            }
        } else if (event === 'SIGNED_OUT') {
            localStorage.removeItem('authToken');
            localStorage.removeItem('authUser');
            window._dashboardInitialized = false;
            if (typeof clearAllAppData === 'function') {
                clearAllAppData();
            }
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
