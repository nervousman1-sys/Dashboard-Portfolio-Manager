# Claude Instructions -- Portfolio Management Platform

## Project Overview

This project is a portfolio management dashboard for tracking and
analyzing investment portfolios.

The platform includes: - Portfolio tracking - Financial news -
Performance analytics - Risk metrics - Portfolio statistics

The interface language of the platform is Hebrew.

------------------------------------------------------------------------

# Critical Rules (Do Not Break)

1.  Do NOT change the existing UI design unless explicitly requested.
2.  Do NOT remove existing features or functions.
3.  Do NOT refactor or restructure code unless explicitly asked.
4.  Always maintain compatibility with the existing codebase.
5.  Do not rename existing variables or functions unless required for a
    bug fix.
6.  Never rewrite an entire file unless explicitly requested.

------------------------------------------------------------------------

# Code Organization Rules

When adding new features:

-   Prefer separate JavaScript files for new functionality.
-   Keep the code modular and clean.
-   Avoid placing large amounts of new code inside index.html.

Suggested structure:

project/ │ ├── index.html ├── css/ │ └── styles.css │ ├── js/ │ ├──
app.js │ ├── portfolio.js │ ├── analytics.js │ └── news.js │ └──
claude.md

------------------------------------------------------------------------

# UI and Language Rules

-   All visible UI text must be in Hebrew.
-   Code comments should be in English.
-   Financial terms may remain in English when appropriate (Sharpe
    Ratio, Beta, etc.).

------------------------------------------------------------------------

# Financial Metrics to Support

The platform may include the following analytics:

-   Portfolio Return
-   Volatility
-   Sharpe Ratio
-   Beta
-   Correlation between assets
-   Risk exposure
-   Asset allocation

Claude should implement calculations accurately and efficiently.

------------------------------------------------------------------------

# Performance Rules

-   Avoid unnecessary API calls.
-   Keep calculations efficient for large portfolios.
-   Use caching when appropriate.

------------------------------------------------------------------------

# Safety Rules

Before modifying any code:

1.  Read the existing code carefully.
2.  Avoid breaking existing functionality.
3.  Preserve current UI behavior.
4.  Ask before making major structural changes.

------------------------------------------------------------------------

# Development Philosophy

This platform should remain:

-   Fast
-   Clean
-   Modular
-   Easy to maintain
-   Expandable for future financial analytics
