const express = require('express');
const router = express.Router();
const { generateToken, APP_PASSWORD, JWT_EXPIRY, isAuthRequired } = require('../middleware/auth');

/**
 * Check authentication status
 */
router.get('/status', (req, res) => {
  const { checkAuth } = require('../middleware/auth');
  checkAuth(req, res);
});

/**
 * Login endpoint
 */
router.post('/login', (req, res) => {
  const { password } = req.body;

  if (!isAuthRequired()) {
    return res.json({ success: true, authenticated: true });
  }

  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Generate token
  const token = generateToken();

  // Set cookie (30 days)
  res.cookie('authToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: JWT_EXPIRY
  });

  res.json({ success: true, authenticated: true });
});

/**
 * Logout endpoint
 */
router.post('/logout', (req, res) => {
  res.clearCookie('authToken');
  res.json({ success: true });
});

module.exports = router;

