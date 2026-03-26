Project Context: Finextium
1. Project Vision
Finextium is a professional-grade financial analysis and portfolio management platform. It is designed for deep-dive analysis of financial robustness, sector momentum, and macroeconomic trends. The platform prioritizes high-fidelity data and professional risk metrics to provide institutional-level insights.

2. Core Analysis Pillars
Financial Resilience: Focus on Solvency, Liquidity, and balance sheet health.

Sector Analysis: Tracking money flow, sector innovation, and industry-specific strength.

Macro & Micro Context: Integrating global economic indicators with company-specific fundamental data.

Risk Assessment: Portfolio stress-testing and risk parameter modeling.

3. Current Tech Stack
Frontend & Backend: Next.js (App Router) / TypeScript.

Database: Neon (PostgreSQL) - Managed via SQL/Drizzle or Prisma.

Security: Custom JWT-based authentication for a multi-user SaaS structure.

Deployment: Vercel.

4. Data Infrastructure (APIs)
The system integrates with the following primary providers:

Financial Modeling Prep (FMP): Financial statements (Income, Balance, Cash Flow), fundamental ratios, and institutional data.

Finnhub: Market sentiment, sector news, and industry benchmarks.

Twelve Data: Real-time asset pricing and global macroeconomic indicators (GDP, CPI, etc.).

5. Planned Architecture: The "Decision Core" (Future Roadmap)
The project is moving toward an automated multi-agent AI system. While not yet fully implemented, the codebase must remain modular to support the following specialized agents:

Macro Economist: Analyzes economic regimes, GDP, inflation, and central bank policies.

Market Analyst: Monitors sector rotation, institutional money flow, and overall market sentiment.

Fundamental Analyst: Audits financial statements, solvency ratios, and long-term viability.

Technical Analyst: Evaluates price action, structural trends, and market timing (Future scope).

Risk Manager: Performs stress testing, calculates exposure, and monitors portfolio robustness.

Debate Agent: Acts as the "Decision Core" moderator, challenging the findings of other agents to eliminate bias and refine final recommendations.

6. Design & Aesthetic (Cyber-Noir)
Style: High-end, "Cyber-noir" aesthetic.

UI: Professional dark mode, high data density, clean typography, and futuristic financial visualizations.

7. Development Guidelines
Modularity: Keep API services strictly separated from UI components to allow seamless integration of future AI agents.

Typing: Use strict TypeScript definitions for all financial data structures to ensure data integrity.

Security: Ensure all data fetching and user-specific logic are protected via JWT and server-side validation.

Execution Focus: At this stage, the focus is on data infrastructure and UI, not on implementing Technical Analysis (RSI, FVG) or TradingView charts.
### UI/UX Implementation Rules
- Always use the `/plugins/frontend-design` and `/plugins/figma-code-connect-components` skills when generating, modifying, or refactoring UI components.
- The design system must be connected via `figma-create-design-system-rules`.
- Code generation must align with Figma component definitions to ensure fidelity to the Cyber-Noir aesthetic.