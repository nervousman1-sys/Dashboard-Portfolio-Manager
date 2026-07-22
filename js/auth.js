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
    // SECURITY: wipe any portfolio data/DOM that Phase-0 may have rendered, so the login
    // screen never sits on top of (or briefly flashes) the previous session's portfolio.
    if (typeof clearAllAppData === 'function') clearAllAppData();
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

// Race an auth call against a hard timeout so a saturated backend (e.g. the Postgres
// connection pool exhausted by the 24/7 agents) can never leave the login button stuck
// on "מתחבר..." forever. On timeout the user gets a clear, actionable error and the form
// is re-enabled. If the call resolves LATE (after the timeout), onAuthStateChange(SIGNED_IN)
// still bootstraps the dashboard — so a late success is never lost.
function _authWithTimeout(promise, ms = 15000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('AUTH_TIMEOUT')), ms))
    ]);
}

// Human-readable auth error. AUTH_TIMEOUT → "server busy"; a missing client (SDK/CDN failed
// to load) → "refresh"; anything else → the raw message.
function _authErrorText(e) {
    if (e && e.message === 'AUTH_TIMEOUT') return 'השרת עמוס כרגע וההתחברות נתקעה — נסה שוב בעוד רגע.';
    return 'שגיאת חיבור לשרת: ' + ((e && e.message) || e);
}

// ========== GOOGLE LOGIN (Supabase OAuth) ==========

async function handleGoogleLogin() {
    // Reset boot flag so onAuthStateChange(SIGNED_IN) can bootstrap the dashboard
    // after Google redirects the user back here with #access_token in the URL hash.
    window._dashboardBooted = false;

    const redirectTo = window.location.origin;
    console.log('[Auth] Google OAuth start | redirectTo:', redirectTo);

    if (!supabaseClient) {
        showAuthError('שירות ההזדהות לא נטען. רענן את הדף (Ctrl+Shift+R) ונסה שוב.');
        return;
    }

    try {
        const { error } = await _authWithTimeout(supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo,
                queryParams: { prompt: 'select_account' }
            }
        }));
        if (error) {
            showAuthError('שגיאה בהתחברות עם Google');
            console.error('[Auth] OAuth error:', error.message);
        }
    } catch (e) {
        console.error('[Auth] Google login exception:', e);
        showAuthError(_authErrorText(e));
    }
}

// ========== LOGIN (Supabase Auth) ==========

async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const btn = document.getElementById('authSubmitBtn');

    hideAuthError();
    if (!email || !password) { showAuthError('נא למלא את כל השדות'); return; }
    if (!supabaseClient) { showAuthError('שירות ההזדהות לא נטען. רענן את הדף (Ctrl+Shift+R) ונסה שוב.'); return; }

    btn.disabled = true;
    btn.textContent = 'מתחבר...';

    try {
        const { data, error } = await _authWithTimeout(supabaseClient.auth.signInWithPassword({ email, password }));

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
        showAuthError(_authErrorText(e));
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
    if (!supabaseClient) { showAuthError('שירות ההזדהות לא נטען. רענן את הדף (Ctrl+Shift+R) ונסה שוב.'); return; }

    btn.disabled = true;
    btn.textContent = 'נרשם...';

    try {
        const { data, error } = await _authWithTimeout(supabaseClient.auth.signUp({
            email,
            password,
            options: { data: { username } }
        }));

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
        showAuthError(_authErrorText(e));
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

    // Populate mobile bottom nav menu label with user name. An email-as-username used to
    // render the FULL address into the 5-button bar ("finextium.qa.tester@gmail.com") and
    // blow its layout — show only a short, human first-name-like token (≤10 chars).
    const mobileMenuLabel = document.getElementById('mobileMenuLabel');
    if (mobileMenuLabel && user?.username) {
        const first = String(user.username).split(/[\s@]/)[0].split(/[._-]/)[0];
        mobileMenuLabel.textContent = (first && first.length <= 10) ? first : 'תפריט';
    } else if (mobileMenuLabel) {
        mobileMenuLabel.textContent = 'תפריט';
    }

    if (!userArea) return;
    if (user) {
        const uInitials = String(user.username || '?').split(/[\s@._-]/).filter(Boolean).map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('') || '?';
        const uShort = String(user.username || '').split(/[\s@]/)[0];
        const spn = document.getElementById('sidebarProfileName'); if (spn) spn.textContent = uShort || 'הפרופיל שלי';
        userArea.innerHTML = `
            <div class="user-display">
                <button class="user-chip" onclick="openProfileModal()" title="הפרופיל שלי — פרטים והגדרות">
                    <span class="user-chip-av">${uInitials}</span>
                    <span class="username">${uShort}</span>
                </button>
                <button class="logout-btn" onclick="logout()">התנתק</button>
            </div>
        `;
        userArea.style.cssText = 'display: flex !important;';
    } else {
        userArea.innerHTML = '';
        userArea.style.cssText = 'display: none !important;';
    }
}

// ========== PROFILE — account panel: identity + inline-edit username / email / password ==========
function _pfEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const _PF_PENCIL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
let _pfState = {};   // { username, email } current values, for cancel/reset
function closeProfileModal() { const ov = document.getElementById('profileOverlay'); if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; } if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock(); }

// One editable row: label + value + pencil → expands to input + save/cancel (inline).
function _pfRow(field, label, value, opts) {
    opts = opts || {};
    const mask = !!opts.mask;
    const disp = mask ? '••••••••' : (value || '—');
    const inputAttrs = mask
        ? `type="password" placeholder="סיסמה חדשה (6+ תווים)" autocomplete="new-password"`
        : `type="${opts.type || 'text'}" value="${_pfEsc(value || '')}"`;
    return `<div class="pf-row" id="pfRow-${field}">
        <div class="pf-row-main">
            <span class="pf-row-label">${label}</span>
            <span class="pf-row-value" id="pfVal-${field}">${_pfEsc(disp)}</span>
            <button class="pf-edit" onclick="_pfEdit('${field}')" aria-label="עריכת ${label}">${_PF_PENCIL}</button>
        </div>
        <div class="pf-row-form">
            <input class="pf-input" id="pfIn-${field}" ${inputAttrs}>
            <div class="pf-row-act">
                <button class="pf-save" onclick="_pfSave('${field}')">שמירה</button>
                <button class="pf-cancel" onclick="_pfCancel('${field}')">ביטול</button>
            </div>
            <div class="pf-row-msg" id="pfMsg-${field}"></div>
        </div>
    </div>`;
}

async function openProfileModal() {
    let ov = document.getElementById('profileOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'profileOverlay'; ov.className = 'wl-overlay'; ov.addEventListener('click', (e) => { if (e.target === ov) closeProfileModal(); }); document.body.appendChild(ov); }
    const u = (typeof getUser === 'function' && getUser()) || {};
    let email = u.username || '', name = u.username || '', created = '';
    try {
        const { data } = await supabaseClient.auth.getUser();
        if (data && data.user) {
            email = data.user.email || email;
            name = (data.user.user_metadata && data.user.user_metadata.username) || (data.user.email ? data.user.email.split('@')[0] : '') || name;
            if (data.user.created_at) { const d = new Date(data.user.created_at); created = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; }
        }
    } catch (e) { }
    _pfState = { username: name, email };
    const initials = String(name || email || '?').split(/[\s@._-]/).filter(Boolean).map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('') || '?';
    ov.innerHTML = `<div class="wl-box pf-box" dir="rtl">
        <button class="pf-x" onclick="closeProfileModal()" aria-label="סגירה">✕</button>
        <div class="pf-hero">
            <div class="pf-avatar"><span>${_pfEsc(initials)}</span></div>
            <div class="pf-hero-txt">
                <div class="pf-name" id="pfHeroName">${_pfEsc(name || '—')}</div>
                <div class="pf-email" id="pfHeroEmail">${_pfEsc(email || '—')}</div>
            </div>
        </div>
        <div class="pf-body">
            <div class="pf-sec">חשבון</div>
            ${_pfRow('username', 'שם משתמש', name)}
            ${_pfRow('email', 'אימייל', email, { type: 'email' })}
            ${created ? `<div class="pf-row pf-row--ro"><div class="pf-row-main"><span class="pf-row-label">חבר/ה מאז</span><span class="pf-row-value">${_pfEsc(created)}</span></div></div>` : ''}
            <div class="pf-sec">אבטחה</div>
            ${_pfRow('password', 'סיסמה', '', { mask: true })}
            <button class="pf-logout" onclick="closeProfileModal(); logout()">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                <span>התנתקות מהחשבון</span>
            </button>
        </div>
    </div>`;
    ov.classList.add('active');
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
}

function _pfEdit(field) {
    const row = document.getElementById('pfRow-' + field); if (!row) return;
    document.querySelectorAll('.pf-row--editing').forEach(r => { if (r !== row) r.classList.remove('editing'); });
    row.classList.add('editing');
    const inp = document.getElementById('pfIn-' + field);
    if (inp) { if (field !== 'password') inp.value = _pfState[field] || ''; setTimeout(() => inp.focus(), 30); }
    const msg = document.getElementById('pfMsg-' + field); if (msg) { msg.textContent = ''; msg.className = 'pf-row-msg'; }
}
function _pfCancel(field) { const row = document.getElementById('pfRow-' + field); if (row) row.classList.remove('editing'); }
function _pfRowMsg(field, text, ok) { const el = document.getElementById('pfMsg-' + field); if (el) { el.textContent = text; el.className = 'pf-row-msg ' + (ok ? 'pf-ok' : 'pf-err'); } }

async function _pfSave(field) {
    const inp = document.getElementById('pfIn-' + field); if (!inp) return;
    const val = String(inp.value || '').trim();
    if (field === 'password') {
        if (val.length < 6) { _pfRowMsg(field, 'סיסמה חייבת להכיל לפחות 6 תווים', false); return; }
    } else if (field === 'email') {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) { _pfRowMsg(field, 'הזן כתובת אימייל תקינה', false); return; }
        if (val === _pfState.email) { _pfCancel(field); return; }
    } else if (field === 'username') {
        if (val.length < 2) { _pfRowMsg(field, 'שם משתמש קצר מדי', false); return; }
        if (val === _pfState.username) { _pfCancel(field); return; }
    }
    _pfRowMsg(field, 'שומר…', true);
    try {
        let payload;
        if (field === 'password') payload = { password: val };
        else if (field === 'email') payload = { email: val };
        else payload = { data: { username: val } };
        const { error } = await supabaseClient.auth.updateUser(payload);
        if (error) { _pfRowMsg(field, 'שגיאה: ' + error.message, false); return; }

        if (field === 'password') {
            inp.value = ''; _pfRowMsg(field, 'הסיסמה עודכנה ✓', true);
            setTimeout(() => _pfCancel(field), 1400);
        } else if (field === 'email') {
            _pfRowMsg(field, 'שלחנו מייל אישור לכתובת החדשה — האימייל יתחלף לאחר האישור.', true);
        } else { // username — takes effect immediately
            _pfState.username = val;
            const vEl = document.getElementById('pfVal-username'); if (vEl) vEl.textContent = val;
            const hn = document.getElementById('pfHeroName'); if (hn) hn.textContent = val;
            // reflect in the header chip + sidebar + local user record
            try { const cur = getUser() || {}; if (typeof saveUser === 'function') saveUser({ ...cur, username: val }); } catch (e) { }
            if (typeof updateUserDisplay === 'function') updateUserDisplay();
            _pfRowMsg(field, 'שם המשתמש עודכן ✓', true);
            setTimeout(() => _pfCancel(field), 1200);
        }
    } catch (e) { _pfRowMsg(field, 'שגיאת חיבור — נסה שוב בעוד רגע.', false); }
}

if (typeof window !== 'undefined') {
    window.openProfileModal = openProfileModal; window.closeProfileModal = closeProfileModal;
    window._pfEdit = _pfEdit; window._pfCancel = _pfCancel; window._pfSave = _pfSave;
}

// Immediately show user area if a session exists in localStorage.
// The onAuthStateChange(INITIAL_SESSION) in supabase-config.js fires BEFORE
// this script loads, so updateUserDisplay() was skipped. Call it now.
updateUserDisplay();
