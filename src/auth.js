const crypto = require('crypto');

// In-memory stores
const sessions = new Map();       // token -> { ip, createdAt }
const failedAttempts = new Map(); // ip -> { count, lockedUntil }

const SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 30 * 60 * 1000; // 30 minutes

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Check if the request originates from the host machine (loopback)
// Uses socket-level IP to prevent X-Forwarded-For spoofing
function isLocalhostSocket(socketAddress) {
  if (!socketAddress) return false;
  const addr = socketAddress.replace('::ffff:', '');
  return addr === '127.0.0.1' || addr === '::1';
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createAuthMiddleware(pinStore) {
  return (req, res, next) => {
    // Skip auth for auth endpoints and static files
    if (req.path === '/api/auth' || req.path === '/api/version' || !req.path.startsWith('/api/')) {
      return next();
    }
    
    const token = parseCookie(req.headers.cookie, 'session');
    if (token && sessions.has(token)) {
      const session = sessions.get(token);
      // Check expiry
      if (Date.now() - session.createdAt > SESSION_EXPIRY) {
        sessions.delete(token);
        return res.status(401).json({ error: 'Session expired' });
      }
      // Bind to IP
      const clientIp = req.ip || req.connection.remoteAddress;
      if (session.ip !== clientIp) {
        return res.status(401).json({ error: 'Session invalid' });
      }
      req.sessionToken = token;
      return next();
    }
    
    // No valid session — auto-authenticate localhost (host machine)
    if (isLocalhostSocket(req.socket.remoteAddress)) {
      const clientIp = req.ip || req.connection.remoteAddress;
      const newToken = generateSessionToken();
      sessions.set(newToken, { ip: clientIp, createdAt: Date.now() });
      res.cookie('session', newToken, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'strict',
        maxAge: SESSION_EXPIRY,
        path: '/',
      });
      req.sessionToken = newToken;
      return next();
    }
    
    return res.status(401).json({ error: 'Authentication required' });
  };
}

function handleAuth(pinStore) {
  return (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    const { pin: submittedPin } = req.body;
    
    // Check lockout
    const attempts = failedAttempts.get(clientIp);
    if (attempts && attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
      const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ 
        error: `Too many failed attempts. Try again in ${remaining} minute(s).`,
        locked: true
      });
    }
    
    if (submittedPin !== pinStore.current) {
      // Track failed attempt
      if (!failedAttempts.has(clientIp)) {
        failedAttempts.set(clientIp, { count: 0, lockedUntil: null });
      }
      const att = failedAttempts.get(clientIp);
      att.count++;
      if (att.count >= MAX_ATTEMPTS) {
        att.lockedUntil = Date.now() + LOCKOUT_DURATION;
        return res.status(429).json({ 
          error: 'Too many failed attempts. Locked for 30 minutes.',
          locked: true
        });
      }
      return res.status(401).json({ 
        error: 'Invalid PIN',
        attemptsRemaining: MAX_ATTEMPTS - att.count
      });
    }
    
    // Success - clear failed attempts
    failedAttempts.delete(clientIp);
    
    const token = generateSessionToken();
    sessions.set(token, { ip: clientIp, createdAt: Date.now() });
    
    res.cookie('session', token, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'strict',
      maxAge: SESSION_EXPIRY,
      path: '/',
    });
    
    return res.json({ success: true });
  };
}

function handleLogout(req, res) {
  const token = parseCookie(req.headers.cookie, 'session');
  if (token) sessions.delete(token);
  res.clearCookie('session', { path: '/' });
  return res.json({ success: true });
}

function validateWsAuth(cookie, socketIp) {
  // Auto-authenticate localhost WebSocket connections
  if (isLocalhostSocket(socketIp)) return true;
  
  const token = parseCookie(cookie, 'session');
  if (!token || !sessions.has(token)) return false;
  const session = sessions.get(token);
  if (Date.now() - session.createdAt > SESSION_EXPIRY) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=')[1].trim() : null;
}

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_EXPIRY) sessions.delete(token);
  }
  for (const [ip, att] of failedAttempts) {
    if (att.lockedUntil && now > att.lockedUntil + LOCKOUT_DURATION) {
      failedAttempts.delete(ip);
    }
  }
}, 60000);

module.exports = {
  generatePin,
  createAuthMiddleware,
  handleAuth,
  handleLogout,
  validateWsAuth,
  sessions,
  isLocalhostSocket,
  parseCookie,
};
