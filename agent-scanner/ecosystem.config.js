// PM2 process manager config — keeps the Agent Scanner alive 24/7 and restarts it on crash.
//   pm2 start ecosystem.config.js   # launch
//   pm2 logs finextium-agent-scanner
//   pm2 save && pm2 startup          # survive VPS reboots
const common = {
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 30,
    restart_delay: 10000,           // 10s backoff between restarts
    max_memory_restart: '300M',
    env: { NODE_ENV: 'production' },
    time: true,
};
module.exports = {
    apps: [
        {
            ...common,
            name: 'finextium-agent-scanner',     // Early-Alpha sector scanner → catalyst_cards (every 4h)
            script: 'scanner.js',
            out_file: './logs/scanner-out.log',
            error_file: './logs/scanner-err.log',
        },
        {
            ...common,
            name: 'finextium-macro-feed',        // material macro/geopolitical updates → macro_updates (every 30m)
            script: 'macro-feed.js',
            out_file: './logs/macro-out.log',
            error_file: './logs/macro-err.log',
        },
        {
            ...common,
            name: 'finextium-crisis-agent',      // crisis-detection indicator + AI assessment → crisis_indicator (every 60m)
            script: 'crisis-agent.js',
            out_file: './logs/crisis-out.log',
            error_file: './logs/crisis-err.log',
        },
        {
            ...common,
            name: 'finextium-reports-agent',     // 24/7 sweep of every company's latest earnings report → company_reports
            script: 'reports-agent.js',
            max_memory_restart: '400M',          // holds the universe + report JSON in memory mid-sweep
            out_file: './logs/reports-out.log',
            error_file: './logs/reports-err.log',
        },
    ],
};
