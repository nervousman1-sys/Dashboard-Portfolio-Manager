// ========== AUTH - Login/Register & Token Management ==========

// ========== TOKEN MANAGEMENT (backward compat) ==========

function getToken() {
    return localStorage.getItem('authToken');
}

function saveToken(token) {
    localStorage.setItem('authToken', token);
}

function clearToken() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
}

function saveUser(user) {
    localStorage.setItem('authUser', JSON.stringify(user));
}

function getUser() {
    try {
        return JSON.parse(localStorage.getItem('authUser'));
    } catch (e) {
        return null;
    }
}

function isLoggedIn() {
    return !!getToken();
}

// ========== LOGIN FORM ==========

function showLoginForm() {
    document.getElementById('loadingOverlay').classList.add('hidden');
    const overlay = document.getElementById('authOverlay');
    overlay.classList.remove('hidden');
    renderAuthForm('login');
}

function renderAuthForm(mode) {
    const overlay = document.getElementById('authOverlay');
    const isLogin = mode === 'login';

    overlay.innerHTML = `
        <div class="auth-box">
            <div class="auth-header">
                <h2>${isLogin ? 'התחברות למערכת' : 'הרשמה למערכת'}</h2>
                <p>Dashboard Portfolio Manager</p>
            </div>
            <div class="auth-error" id="authError"></div>
            <div class="auth-field">
                <label>אימייל</label>
                <input type="email" id="authEmail" placeholder="הזן אימייל..." autocomplete="email" style="direction:ltr;text-align:left" />
            </div>
            <div class="auth-field">
                <label>סיסמה</label>
                <input type="password" id="authPassword" placeholder="${isLogin ? 'הזן סיסמה...' : 'לפחות 6 תווים...'}" autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
            </div>
            ${!isLogin ? `
            <div class="auth-field">
                <label>שם משתמש</label>
                <input type="text" id="authUsername" placeholder="הזן שם משתמש..." autocomplete="username" />
            </div>` : ''}
            <button class="auth-btn" id="authSubmitBtn" onclick="${isLogin ? 'handleLogin()' : 'handleRegister()'}">
                ${isLogin ? 'התחבר' : 'הירשם'}
            </button>
            <div class="auth-divider"><span>או</span></div>
            <button class="auth-btn google-btn" onclick="handleGoogleLogin()">
                <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                התחבר עם Google
            </button>
            <div class="auth-toggle">
                ${isLogin
                    ? 'אין לך חשבון? <a onclick="renderAuthForm(\'register\')">הירשם כאן</a>'
                    : 'כבר יש לך חשבון? <a onclick="renderAuthForm(\'login\')">התחבר כאן</a>'
                }
            </div>
        </div>
    `;

    // Enter key handling
    const passwordField = document.getElementById('authPassword');
    const emailField = document.getElementById('authEmail');
    const submitFn = isLogin ? handleLogin : handleRegister;

    passwordField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (!isLogin) {
                const usernameField = document.getElementById('authUsername');
                if (usernameField) { usernameField.focus(); return; }
            }
            submitFn();
        }
    });
    emailField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') passwordField.focus();
    });
    if (!isLogin) {
        const usernameField = document.getElementById('authUsername');
        if (usernameField) {
            usernameField.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitFn();
            });
        }
    }

    setTimeout(() => emailField.focus(), 100);
}

function showAuthError(message) {
    const el = document.getElementById('authError');
    el.textContent = message;
    el.classList.add('visible');
}

function hideAuthError() {
    const el = document.getElementById('authError');
    if (el) el.classList.remove('visible');
}

// ========== GOOGLE LOGIN (Supabase OAuth) ==========

async function handleGoogleLogin() {
    // Reset boot flag so onAuthStateChange(SIGNED_IN) can bootstrap the dashboard
    // after Google redirects the user back here with #access_token in the URL hash.
    window._dashboardBooted = false;

    const redirectTo = window.location.origin;
    console.log('[Auth] Google OAuth start | redirectTo:', redirectTo);

    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo,
                queryParams: { prompt: 'select_account' }
            }
        });
        if (error) {
            showAuthError('שגיאה בהתחברות עם Google');
            console.error('[Auth] OAuth error:', error.message);
        }
    } catch (e) {
        console.error('[Auth] Google login exception:', e);
        showAuthError('שגיאת חיבור לשרת: ' + (e.message || e));
    }
}

// ========== LOGIN (Supabase Auth) ==========

async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const btn = document.getElementById('authSubmitBtn');

    hideAuthError();
    if (!email || !password) { showAuthError('נא למלא את כל השדות'); return; }

    btn.disabled = true;
    btn.textContent = 'מתחבר...';

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

        if (error) {
            showAuthError(error.message === 'Invalid login credentials'
                ? 'אימייל או סיסמה שגויים' : error.message);
            btn.disabled = false;
            btn.textContent = 'התחבר';
            return;
        }

        saveToken(data.session.access_token);
        saveUser({ id: data.user.id, username: data.user.user_metadata?.username || data.user.email });
        onAuthSuccess();
    } catch (e) {
        console.error('Login error:', e);
        showAuthError('שגיאת חיבור לשרת: ' + (e.message || e));
        btn.disabled = false;
        btn.textContent = 'התחבר';
    }
}

// ========== REGISTER (Supabase Auth) ==========

async function handleRegister() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const usernameField = document.getElementById('authUsername');
    const username = usernameField ? usernameField.value.trim() : email;
    const btn = document.getElementById('authSubmitBtn');

    hideAuthError();
    if (!email || !password) { showAuthError('נא למלא את כל השדות'); return; }
    if (password.length < 6) { showAuthError('סיסמה חייבת להכיל לפחות 6 תווים'); return; }

    btn.disabled = true;
    btn.textContent = 'נרשם...';

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: { data: { username } }
        });

        if (error) {
            showAuthError(error.message === 'User already registered'
                ? 'אימייל כבר קיים במערכת' : error.message);
            btn.disabled = false;
            btn.textContent = 'הירשם';
            return;
        }

        if (data.user && !data.session) {
            // Email confirmation required
            showAuthError('נשלח אימייל אימות — בדוק את תיבת הדואר שלך');
            btn.disabled = false;
            btn.textContent = 'הירשם';
            return;
        }

        saveToken(data.session.access_token);
        saveUser({ id: data.user.id, username });

        onAuthSuccess();
    } catch (e) {
        showAuthError('שגיאת חיבור לשרת');
        btn.disabled = false;
        btn.textContent = 'הירשם';
    }
}

// ========== AUTH SUCCESS ==========

function onAuthSuccess() {
    // Mark booted so onAuthStateChange(SIGNED_IN) doesn't double-call init()
    window._dashboardBooted = true;
    // Security: clear any stale data from a previous user session before loading new data
    clearAllAppData();
    document.getElementById('authOverlay').classList.add('hidden');
    // Show loading overlay while fetching new user data
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.remove('hidden');
    updateUserDisplay();
    init();
}

// ========== CLEAR ALL APP DATA (security: prevent data leakage between sessions) ==========

function clearAllAppData() {
    // 1. Clear all app-specific localStorage keys (including transactions — DB is the source of truth)
    const keysToRemove = ['portfolio_clients_cache', 'portfolio_cache_ts', 'portfolio_cache_uid', 'readMacroAlerts'];
    const dynamicPrefixes = ['ticker_hist_', 'benchmark_', 'portfolio_transactions_'];
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (keysToRemove.includes(key) || dynamicPrefixes.some(p => key.startsWith(p))) {
            localStorage.removeItem(key);
        }
    }

    // 2. Reset all global state variables
    clients = [];
    priceCache = {};
    activeFilters = { risk: 'all', asset: 'all', search: '', sector: 'all', returnMin: null, returnMax: null, sizeMin: null, sizeMax: null, sort: 'none' };
    currentModalClientId = null;
    alerts = [];
    readAlertIds = [];
    _cachedUserId = null;
    _cacheRendered = false;

    // Reset transactions probe so it re-checks on next login
    if (typeof _supaTransactionsProbed !== 'undefined') _supaTransactionsProbed = false;

    // 3. Destroy all Chart.js instances
    if (typeof charts !== 'undefined') {
        Object.keys(charts).forEach(key => {
            try { if (charts[key]) charts[key].destroy(); } catch (e) { /* silent */ }
        });
        charts = {};
    }
    if (fullscreenChartInstance) {
        try { fullscreenChartInstance.destroy(); } catch (e) { /* silent */ }
        fullscreenChartInstance = null;
    }

    // 4. Clear in-memory caches (charts.js, synthetic-history.js)
    if (typeof _benchmarkCache !== 'undefined') {
        Object.keys(_benchmarkCache).forEach(k => delete _benchmarkCache[k]);
    }
    if (typeof _intradayCache !== 'undefined') {
        Object.keys(_intradayCache).forEach(k => delete _intradayCache[k]);
    }
    if (typeof _syntheticCache !== 'undefined') {
        Object.keys(_syntheticCache).forEach(k => delete _syntheticCache[k]);
    }
    if (typeof priceCacheTimestamp !== 'undefined') {
        priceCacheTimestamp = 0;
    }

    // 5. Clear DOM sections
    const summaryBar = document.getElementById('summaryBar');
    const exposureSection = document.getElementById('exposureSection');
    const clientsGrid = document.getElementById('clientsGrid');
    if (summaryBar) summaryBar.innerHTML = '';
    if (exposureSection) exposureSection.innerHTML = '';
    if (clientsGrid) clientsGrid.innerHTML = '';
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('active');
}

// ========== LOGOUT ==========

async function logout() {
    await supabaseClient.auth.signOut({ scope: 'global' });
    clearToken();
    clearAllAppData();
    showLoginForm();
    updateUserDisplay();
}

// ========== USER DISPLAY ==========

function updateUserDisplay() {
    const userArea = document.getElementById('userArea');
    const user = getUser();

    // Populate the new header user name / avatar initials
    const nameEl = document.getElementById('headerUserName');
    const avatarEl = document.getElementById('headerAvatar');
    if (nameEl && user?.username) {
        // Show "First L." format (first word + first letter of second word)
        const parts = user.username.split(/[\s@]/);
        const display = parts.length > 1
            ? `${parts[0]} ${parts[1].charAt(0)}.`
            : parts[0];
        nameEl.textContent = display;
    }
    if (avatarEl && user?.username) {
        const initials = user.username.split(/[\s@]/).map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('');
        avatarEl.innerHTML = `<span style="font-size:13px;font-weight:900;color:var(--accent-blue)">${initials}</span>`;
    }

    // Populate mobile bottom nav menu label with user name
    const mobileMenuLabel = document.getElementById('mobileMenuLabel');
    if (mobileMenuLabel && user?.username) {
        const parts = user.username.split(/[\s@]/);
        mobileMenuLabel.textContent = parts.length > 1 ? `${parts[0]} ${parts[1].charAt(0)}.` : parts[0];
    } else if (mobileMenuLabel) {
        mobileMenuLabel.textContent = 'תפריט';
    }

    if (!userArea) return;
    if (user) {
        userArea.innerHTML = `
            <div class="user-display">
                <span class="username">${user.username}</span>
                <button class="logout-btn" onclick="logout()">התנתק</button>
            </div>
        `;
        userArea.style.cssText = 'display: flex !important;';
    } else {
        userArea.innerHTML = '';
        userArea.style.cssText = 'display: none !important;';
    }
}

// Immediately show user area if a session exists in localStorage.
// The onAuthStateChange(INITIAL_SESSION) in supabase-config.js fires BEFORE
// this script loads, so updateUserDisplay() was skipped. Call it now.
updateUserDisplay();
