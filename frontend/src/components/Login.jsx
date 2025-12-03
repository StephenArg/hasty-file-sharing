import React, { useState, useEffect } from 'react';
import './Login.css';

const Login = ({ onLogin }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check if already authenticated
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch('/api/auth/status', {
        credentials: 'include'
      });
      const data = await response.json();
      
      if (data.authenticated) {
        onLogin();
      }
      setChecking(false);
    } catch (err) {
      console.error('Error checking auth status:', err);
      setChecking(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        onLogin();
      } else {
        setError(data.error || 'Invalid password');
      }
    } catch (err) {
      setError('Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="login-container">
        <div className="login-box">
          <div className="login-loading">Checking authentication...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>🚀 Hasty File Send</h1>
        <p className="login-subtitle">Please enter the password to continue</p>
        
        {error && <div className="login-error">{error}</div>}
        
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="login-input"
            autoFocus
            disabled={loading}
          />
          <button
            type="submit"
            className="login-button"
            disabled={loading || !password}
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
        
        <p className="login-note">You'll stay logged in for 30 days</p>
      </div>
    </div>
  );
};

export default Login;

