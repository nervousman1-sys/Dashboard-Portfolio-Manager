// PM2 process manager config — keeps the Agent Scanner alive 24/7 and restarts it on crash.
//   pm2 start ecosystem.config.js   # launch
//   pm2 logs finextium-agent-scanner
//   pm2 save && pm2 startup          # survive VPS reboots
module.exports = {
    apps: [{
        name: 'finextium-agent-scanner',
        script: 'scanner.js',
        cwd: __dirname,
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        max_restarts: 30,
        restart_delay: 10000,           // 10s backoff between restarts
        max_memory_restart: '300M',
        env: { NODE_ENV: 'production' },
        out_file: './logs/scanner-out.log',
        error_file: './logs/scanner-err.log',
        time: true,
    }],
};
