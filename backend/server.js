// ========== SERVER - Express Entry Point ==========

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const holdingRoutes = require('./routes/holdings');
const priceRoutes = require('./routes/prices');
const { authenticateToken } = require('./middleware/auth');
const { updatePricesForClients } = require('./services/priceService');
const prisma = require('./services/db');

// ========== ENV VALIDATION ==========
if (!process.env.DATABASE_URL) {
    console.error('FATAL: Missing DATABASE_URL in .env');
    process.exit(1);
}
if (process.env.JWT_SECRET === 'your-secret-key-change-in-production') {
    console.warn('⚠  WARNING: Using default JWT_SECRET — change this in production!');
}

const app = express();

// ========== SECURITY MIDDLEWARE ==========

// Helmet - security headers (CSP relaxed for CDN scripts/styles)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// CORS - restrict origins
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
    credentials: true
}));

// Rate limiting - general API (100 requests per 15 min)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'יותר מדי בקשות, נסה שוב מאוחר יותר' }
});

// Rate limiting - auth routes (20 requests per 15 min)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'יותר מדי ניסיונות התחברות, נסה שוב מאוחר יותר' }
});

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Serve frontend static files from parent directory
app.use(express.static(path.join(__dirname, '..')));

// ========== ROUTES ==========

// Public routes (no auth required) — with stricter rate limit
app.use('/api/auth', authLimiter, authRoutes);

// Protected routes (JWT required)
app.use('/api/clients', apiLimiter, authenticateToken, clientRoutes);
app.use('/api/clients', apiLimiter, authenticateToken, holdingRoutes);
app.use('/api/prices', apiLimiter, authenticateToken, priceRoutes);

// ========== GLOBAL ERROR HANDLER ==========
// Must be defined AFTER all routes
app.use((err, req, res, next) => {
    // Log full error for server-side debugging
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
    }

    // Send clean error to client — never expose DB details or stack traces
    const status = err.status || 500;
    const clientMessage = status === 500
        ? 'שגיאת שרת פנימית'
        : err.message;

    res.status(status).json({ error: clientMessage });
});

// ========== STARTUP ==========
async function startup() {
    // Connect to database
    await prisma.$connect();
    console.log('Connected to PostgreSQL database.');

    const clientCount = await prisma.client.count();
    console.log(`${clientCount} clients in database.`);

    if (clientCount > 0) {
        console.log('Fetching initial prices...');
        await updatePricesForClients();
        console.log('Prices updated.');
    } else {
        console.log('No clients yet — they will be seeded when the first user registers.');
    }

    // Auto-refresh prices every 60 seconds
    setInterval(async () => {
        try {
            const count = await prisma.client.count();
            if (count > 0) {
                console.log('Auto-refreshing prices...');
                await updatePricesForClients();
                console.log('Prices refreshed at', new Date().toLocaleTimeString());
            }
        } catch (e) {
            console.error('Auto-refresh failed:', e.message);
        }
    }, 60000);
}

const PORT = process.env.PORT || 3001;

startup().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Dashboard available at http://localhost:${PORT}/index.html`);
    });
}).catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
});
