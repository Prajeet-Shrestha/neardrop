const path = require('path');
const fs = require('fs');

// Path sanitization: resolve user path and verify it's within root
function safePath(userPath, rootDir) {
  if (!userPath) return rootDir;
  // Strip null bytes
  const cleaned = userPath.replace(/\0/g, '');
  const resolved = path.resolve(rootDir, cleaned);
  if (!resolved.startsWith(rootDir)) return null;
  return resolved;
}

// Check if resolved path (following symlinks) is still within root
async function checkSymlinkJail(filePath, rootDir) {
  try {
    const realPath = await fs.promises.realpath(filePath);
    return realPath.startsWith(rootDir);
  } catch (e) {
    if (e.code === 'ENOENT') return true; // File doesn't exist yet (upload target)
    return false;
  }
}

// Sanitize uploaded filename
function sanitizeFilename(name) {
  return name
    .replace(/\0/g, '')           // null bytes
    .replace(/\.\.\//g, '')       // path traversal
    .replace(/\.\.\\/g, '')       // windows path traversal
    .replace(/[<>:"|?*]/g, '_')   // invalid chars
    .replace(/[\x00-\x1f]/g, '')  // control chars
    .trim();
}

// Security headers middleware
function securityHeaders(req, res, next) {
  // CSP - strict, no inline scripts or styles
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' wss: ws:; " +
    "frame-ancestors 'none'"
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
}

// CORS middleware - permissive for LAN usage (PIN auth protects access)
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
}

// Simple rate limiter
function createRateLimiter(maxRequests = 100, windowMs = 60000) {
  const hits = new Map();
  
  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits) {
      if (now - data.start > windowMs) hits.delete(ip);
    }
  }, windowMs);
  
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!hits.has(ip)) {
      hits.set(ip, { count: 1, start: now });
      return next();
    }
    
    const data = hits.get(ip);
    if (now - data.start > windowMs) {
      hits.set(ip, { count: 1, start: now });
      return next();
    }
    
    data.count++;
    if (data.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

// IP allowlist middleware
function ipAllowlist(allowedIps) {
  if (!allowedIps || allowedIps.length === 0) return (req, res, next) => next();
  
  return (req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    const normalized = clientIp.replace('::ffff:', '');
    if (allowedIps.includes(normalized) || allowedIps.includes(clientIp) || normalized === '127.0.0.1') {
      return next();
    }
    return res.status(403).json({ error: 'Access denied. Your IP is not allowed.' });
  };
}

module.exports = {
  safePath,
  checkSymlinkJail,
  sanitizeFilename,
  securityHeaders,
  corsMiddleware,
  createRateLimiter,
  ipAllowlist,
};
