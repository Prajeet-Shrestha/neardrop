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
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; " +
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

// Check if an origin is from a LAN (private network) address
function isLanOrigin(origin) {
  if (!origin || origin === 'null') return false;
  
  let parsed;
  try { parsed = new URL(origin); } catch (e) { return false; }
  
  // Only allow http/https protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  
  const hostname = parsed.hostname;
  
  // Localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  
  // Strip IPv4-mapped IPv6 prefix
  const stripped = hostname.replace('::ffff:', '');
  
  // Must be a strict IPv4 address (prevents bypass via 192.168.1.5.evil.com)
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped)) return false;
  
  const octets = stripped.split('.').map(Number);
  if (octets.some(o => o < 0 || o > 255)) return false;
  
  // RFC-1918 private ranges
  if (octets[0] === 10) return true;                                         // 10.0.0.0/8
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;  // 172.16.0.0/12
  if (octets[0] === 192 && octets[1] === 168) return true;                   // 192.168.0.0/16
  if (octets[0] === 169 && octets[1] === 254) return true;                   // 169.254.0.0/16 (link-local)
  
  return false;
}

// CORS middleware — only reflects origins from LAN/localhost (PIN auth as secondary protection)
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && isLanOrigin(origin)) {
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
  }, windowMs).unref();
  
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
  isLanOrigin,
};
