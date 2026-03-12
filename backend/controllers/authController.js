// ========== AUTH CONTROLLER - Register & Login ==========

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../services/db');

const JWT_SECRET = process.env.JWT_SECRET || 'portfolio-dashboard-secret-key-dev';
const JWT_EXPIRES_IN = '24h';

// POST /api/auth/register  { username, password }
async function register(req, res, next) {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });
        }
        if (username.length < 3) {
            return res.status(400).json({ error: 'שם משתמש חייב להכיל לפחות 3 תווים' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'סיסמה חייבת להכיל לפחות 6 תווים' });
        }

        // Check if username already exists
        const existing = await prisma.user.findUnique({ where: { username } });
        if (existing) {
            return res.status(409).json({ error: 'שם משתמש כבר קיים במערכת' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: { username, passwordHash }
        });

        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        res.status(201).json({
            token,
            user: { id: user.id, username: user.username }
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/auth/login  { username, password }
async function login(req, res, next) {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });
        }

        // Find user
        const user = await prisma.user.findUnique({ where: { username } });
        if (!user) {
            return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
        }

        // Compare password
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
        }

        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        res.json({
            token,
            user: { id: user.id, username: user.username }
        });
    } catch (err) {
        next(err);
    }
}

module.exports = { register, login, JWT_SECRET };
