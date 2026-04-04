// ========== SIDEBAR - Navigation & Layout Logic ==========
//
// Manages the collapsible sidebar (desktop) and slide-in overlay (mobile).
// Maps sidebar nav items to existing view-toggling functions.
// Zero changes to existing JS modules — this file only reads/calls them.

// ── State ──
let _sidebarExpanded = false;
let _mobileSidebarOpen = false;
let _currentNav = 'dashboard';

// ── Desktop: Toggle sidebar collapsed (72px) ↔ expanded (256px) ──
function toggleSidebar() {
    const shell = document.getElementById('appShell');
    const sidebar = document.getElementById('appSidebar');
    if (!shell || !sidebar) return;

    _sidebarExpanded = !_sidebarExpanded;

    if (_sidebarExpanded) {
        sidebar.classList.add('expanded');
        shell.classList.add('sidebar-expanded');
    } else {
        sidebar.classList.remove('expanded');
        shell.classList.remove('sidebar-expanded');
    }
}

// ── Mobile: Toggle sidebar overlay open/close ──
function toggleMobileSidebar() {
    const sidebar = document.getElementById('appSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sidebar || !overlay) return;

    _mobileSidebarOpen = !_mobileSidebarOpen;

    if (_mobileSidebarOpen) {
        sidebar.classList.add('mobile-open');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden'; // prevent scroll behind
    } else {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// ── Close mobile sidebar (one-way — used by nav items) ──
function _closeMobileSidebar() {
    if (!_mobileSidebarOpen) return;
    const sidebar = document.getElementById('appSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
    _mobileSidebarOpen = false;
}

// ── Navigate to a section ──
// Maps sidebar buttons to existing view-toggling logic.
function navigateTo(section) {
    // Close mobile sidebar first (if open)
    _closeMobileSidebar();

    // Determine if we need to close macro page first
    const macroPage = document.getElementById('macroPage');
    const macroIsActive = macroPage && macroPage.classList.contains('active');

    switch (section) {
        case 'dashboard':
        case 'portfolio':
            // Both point to main dashboard — portfolio grid IS the dashboard
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            // Scroll to portfolio grid if coming from "portfolio" link
            if (section === 'portfolio') {
                const grid = document.getElementById('clientsGrid');
                if (grid) {
                    setTimeout(() => grid.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                }
            }
            break;

        case 'macro':
            // Open macro indicators page
            if (!macroIsActive && typeof toggleAlerts === 'function') {
                toggleAlerts();
            }
            break;

        case 'markets':
        case 'flows':
        case 'news':
        case 'analysis':
        case 'settings':
            // Future sections — close macro if active, show placeholder
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            // These sections are not yet implemented — stay on dashboard
            break;

        default:
            break;
    }

    // Update active states
    _setActiveNav(section);
}

// ── Update active CSS class on sidebar items + mobile bottom nav ──
function _setActiveNav(section) {
    _currentNav = section;

    // Sidebar items
    document.querySelectorAll('.sidebar-item').forEach(item => {
        const nav = item.getAttribute('data-nav');
        if (nav === section || (section === 'portfolio' && nav === 'dashboard')) {
            // portfolio highlights the dashboard item too (same view)
            item.classList.toggle('active', nav === section);
        } else {
            item.classList.remove('active');
        }
    });

    // Ensure the clicked section is active
    const activeItem = document.querySelector(`.sidebar-item[data-nav="${section}"]`);
    if (activeItem) activeItem.classList.add('active');

    // Mobile bottom nav — dashboard button active state
    document.querySelectorAll('.mobile-nav-btn[data-nav]').forEach(btn => {
        const nav = btn.getAttribute('data-nav');
        btn.classList.toggle('active', nav === section || (section === 'portfolio' && nav === 'dashboard'));
    });
}

// ── Sync sidebar active state when macro page is opened/closed externally ──
// The existing toggleAlerts() and closeMacroPage() in macro.js don't know about
// the sidebar. We observe the macroPage class to keep the active state in sync.
(function _observeMacroState() {
    const macroPage = document.getElementById('macroPage');
    if (!macroPage) return;

    const observer = new MutationObserver(() => {
        if (macroPage.classList.contains('active')) {
            _setActiveNav('macro');
        } else if (_currentNav === 'macro') {
            _setActiveNav('dashboard');
        }
    });

    observer.observe(macroPage, { attributes: true, attributeFilter: ['class'] });
})();

// ── Keyboard: Escape closes mobile sidebar ──
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _mobileSidebarOpen) {
        _closeMobileSidebar();
    }
});
