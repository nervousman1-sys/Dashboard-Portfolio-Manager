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
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin + window.location.pathname
            }
        });
        if (error) {
            showAuthError('שגיאה בהתחברות עם Google');
            console.error('Google OAuth error:', error.message);
        }
    } catch (e) {
        showAuthError('שגיאת חיבור לשרת');
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
        showAuthError('שגיאת חיבור לשרת');
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
    document.getElementById('authOverlay').classList.add('hidden');
    updateUserDisplay();
    init();
}

// ========== LOGOUT ==========

async function logout() {
    await supabaseClient.auth.signOut();
    clearToken();
    clients = [];
    document.getElementById('summaryBar').innerHTML = '';
    document.getElementById('exposureSection').innerHTML = '';
    document.getElementById('clientsGrid').innerHTML = '';
    document.getElementById('modalOverlay').classList.remove('active');
    showLoginForm();
    updateUserDisplay();
}

// ========== USER DISPLAY ==========

function updateUserDisplay() {
    const userArea = document.getElementById('userArea');
    if (!userArea) return;

    const user = getUser();
    if (user) {
        userArea.innerHTML = `
            <div class="user-display">
                <span class="username">${user.username}</span>
                <button class="logout-btn" onclick="logout()">התנתק</button>
            </div>
        `;
        userArea.style.display = '';
    } else {
        userArea.innerHTML = '';
        userArea.style.display = 'none';
    }
}
