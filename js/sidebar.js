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
    // Decision Core is a routed page — close it when navigating elsewhere.
    if (section !== 'decisioncore') { const _dc = document.getElementById('decisionCorePage'); if (_dc && _dc.classList.contains('active') && typeof closeDecisionCorePage === 'function') closeDecisionCorePage(); }
    // Scanner Agent + LHE are routed pages (like reports) — close when navigating elsewhere.
    if (section !== 'scanneragent') { const _sp = document.getElementById('scannerPage'); if (_sp && _sp.classList.contains('active') && typeof closeScannerAgentPage === 'function') closeScannerAgentPage(); }
    if (section !== 'lhe') { const _lp = document.getElementById('lhePage'); if (_lp && _lp.classList.contains('active') && typeof closeLHEPage === 'function') closeLHEPage(); }

    // Determine if we need to close overlay pages first
    const macroPage = document.getElementById('macroPage');
    const macroIsActive = macroPage && macroPage.classList.contains('active');
    const riskPage = document.getElementById('riskmodelPage');
    const riskIsActive = riskPage && riskPage.classList.contains('active');
    const bulkPage = document.getElementById('bulkPage');
    const bulkIsActive = bulkPage && bulkPage.classList.contains('active');
    const closeBulkIfOpen = () => { if (bulkIsActive && typeof closeBulkPage === 'function') closeBulkPage(); };
    const dnPage = document.getElementById('discordNewsPage');
    const closeDnIfOpen = () => { if (dnPage && dnPage.classList.contains('active') && typeof closeDiscordNews === 'function') closeDiscordNews(); };
    const techPage = document.getElementById('technicalPage');
    const closeTechIfOpen = () => { if (techPage && techPage.classList.contains('active') && typeof closeTechnicalPage === 'function') closeTechnicalPage(); };
    const repPage = document.getElementById('reportsPage');
    const closeRepIfOpen = () => { if (repPage && repPage.classList.contains('active') && typeof closeReportsPage === 'function') closeReportsPage(); };

    // Suppress per-page history writes during the close+open so this navigation
    // produces a SINGLE history entry (the target) — Back then returns to the page
    // you were actually on before, not an intermediate "dashboard".
    if (typeof window !== 'undefined' && typeof window._navSuppressURL === 'function') window._navSuppressURL(true);
    try {
    switch (section) {
        case 'dashboard':
        case 'portfolio':
            // Both point to main dashboard — portfolio grid IS the dashboard
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            if (riskIsActive && typeof closeRiskAnalysis === 'function') {
                closeRiskAnalysis();
            }
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
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
            if (riskIsActive && typeof closeRiskAnalysis === 'function') {
                closeRiskAnalysis();
            }
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (!macroIsActive && typeof toggleAlerts === 'function') {
                toggleAlerts();
            }
            break;

        case 'riskmodel':
            // Open CML/SML risk analysis page
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (typeof openRiskAnalysis === 'function') {
                openRiskAnalysis();
            }
            break;

        case 'bulkmgr':
            // Open the smart bulk-management page
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            if (riskIsActive && typeof closeRiskAnalysis === 'function') {
                closeRiskAnalysis();
            }
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (typeof openBulkPage === 'function') {
                openBulkPage();
            }
            break;

        case 'disconews':
            // Open the Discord economy & market news page
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            if (riskIsActive && typeof closeRiskAnalysis === 'function') {
                closeRiskAnalysis();
            }
            closeBulkIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (typeof openDiscordNews === 'function') {
                openDiscordNews();
            }
            break;

        case 'technical':
            // Open the technical-analysis scanner page
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            if (riskIsActive && typeof closeRiskAnalysis === 'function') {
                closeRiskAnalysis();
            }
            closeBulkIfOpen();
            closeDnIfOpen();
            closeRepIfOpen();
            if (typeof openTechnicalPage === 'function') {
                openTechnicalPage();
            }
            break;

        case 'reports':
            // Open the financial-reports analysis page
            if (macroIsActive && typeof closeMacroPage === 'function') {
                closeMacroPage();
            }
            if (riskIsActive && typeof closeRiskAnalysis === 'function') {
                closeRiskAnalysis();
            }
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            // If the reports page is already open (e.g. viewing a company), clicking the
            // sidebar item returns to the company list rather than re-opening the same one.
            if (repPage && repPage.classList.contains('active') && typeof _repToList === 'function') {
                _repToList();
            } else if (typeof openReportsPage === 'function') {
                openReportsPage();
            }
            break;

        case 'lhe':
            // Open the Liquidity Hydrodynamic Engine page
            if (macroIsActive && typeof closeMacroPage === 'function') closeMacroPage();
            if (riskIsActive && typeof closeRiskAnalysis === 'function') closeRiskAnalysis();
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (typeof openLHEPage === 'function') openLHEPage();
            break;

        case 'scanneragent':
            // Open the Scanner Agent intelligence page
            if (macroIsActive && typeof closeMacroPage === 'function') closeMacroPage();
            if (riskIsActive && typeof closeRiskAnalysis === 'function') closeRiskAnalysis();
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (typeof openScannerAgentPage === 'function') openScannerAgentPage();
            break;

        case 'decisioncore':
            // Open the Decision Core stress-test page
            if (macroIsActive && typeof closeMacroPage === 'function') closeMacroPage();
            if (riskIsActive && typeof closeRiskAnalysis === 'function') closeRiskAnalysis();
            closeBulkIfOpen();
            closeDnIfOpen();
            closeTechIfOpen();
            closeRepIfOpen();
            if (typeof openDecisionCorePage === 'function') openDecisionCorePage();
            break;

        default:
            break;
    }
    } finally {
        if (typeof window !== 'undefined' && typeof window._navSuppressURL === 'function') window._navSuppressURL(false);
    }

    // Push exactly one history entry for this navigation.
    if (section === 'dashboard' || section === 'portfolio') {
        if (typeof clearURLState === 'function') clearURLState();
    } else if (typeof updateURLState === 'function') {
        updateURLState({ view: section });
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

    // Sync risk-analysis page open/close with sidebar active state
    const riskPage = document.getElementById('riskmodelPage');
    if (riskPage) {
        const riskObserver = new MutationObserver(() => {
            if (riskPage.classList.contains('active')) {
                _setActiveNav('riskmodel');
            } else if (_currentNav === 'riskmodel') {
                _setActiveNav('dashboard');
            }
        });
        riskObserver.observe(riskPage, { attributes: true, attributeFilter: ['class'] });
    }

    // Sync reports-analysis page open/close with sidebar active state
    const reportsPage = document.getElementById('reportsPage');
    if (reportsPage) {
        const repObserver = new MutationObserver(() => {
            if (reportsPage.classList.contains('active')) {
                _setActiveNav('reports');
            } else if (_currentNav === 'reports') {
                _setActiveNav('dashboard');
            }
        });
        repObserver.observe(reportsPage, { attributes: true, attributeFilter: ['class'] });
    }
})();

// ── Keyboard: Escape closes mobile sidebar ──
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _mobileSidebarOpen) {
        _closeMobileSidebar();
    }
});
