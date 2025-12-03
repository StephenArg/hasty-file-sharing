const jwt = require('jsonwebtoken');

const REQUIRE_PASSWORD = process.env.REQUIRE_PASSWORD === 'true';
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET || APP_PASSWORD; // Use password as secret
const JWT_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

/**
 * Check if authentication is required
 */
function isAuthRequired() {
  return REQUIRE_PASSWORD;
}

/**
 * Generate JWT token
 */
function generateToken() {
  return jwt.sign(
    { authenticated: true, timestamp: Date.now() },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Authentication middleware
 */
function requireAuth(req, res, next) {
  // If password is not required, allow access
  if (!REQUIRE_PASSWORD) {
    return next();
  }

  // Check for token in cookie or Authorization header
  const token = req.cookies?.authToken || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required', requiresAuth: true });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token', requiresAuth: true });
  }

  // Token is valid
  next();
}

/**
 * Check authentication status (for frontend)
 */
function checkAuth(req, res) {
  if (!REQUIRE_PASSWORD) {
    return res.json({ requiresAuth: false, authenticated: true });
  }

  const token = req.cookies?.authToken || req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.json({ requiresAuth: true, authenticated: false });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.json({ requiresAuth: true, authenticated: false });
  }

  return res.json({ requiresAuth: true, authenticated: true });
}

module.exports = {
  isAuthRequired,
  generateToken,
  verifyToken,
  requireAuth,
  checkAuth,
  APP_PASSWORD,
  JWT_EXPIRY
};

