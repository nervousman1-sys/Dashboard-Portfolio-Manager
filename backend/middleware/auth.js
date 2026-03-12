// ========== AUTH MIDDLEWARE - JWT Verification ==========

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../controllers/authController');

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

    if (!token) {
        return res.status(401).json({ error: 'אין הרשאה - נדרשת התחברות' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { id: decoded.id, username: decoded.username };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'טוקן לא תקין או פג תוקף' });
    }
}

module.exports = { authenticateToken };
