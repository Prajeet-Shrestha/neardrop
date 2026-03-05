const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
let qrcodeTerminal;
try { qrcodeTerminal = require('qrcode-terminal'); } catch (e) {}

// Check Node.js version
const nodeVersion = parseInt(process.version.slice(1));
if (nodeVersion < 18) {
  console.error(`\x1b[31mError: Node.js 18+ required. Current: ${process.version}\x1b[0m`);
  process.exit(1);
}

// Import modules
const { parseArgs, getLocalIPs, formatBytes, getDiskSpace } = require('./src/utils');
const { securityHeaders, corsMiddleware, createRateLimiter, ipAllowlist } = require('./src/security');
const { generatePin, createAuthMiddleware, handleAuth, handleLogout, validateWsAuth } = require('./src/auth');
const { createFileRoutes } = require('./src/files');
const { setupWebSocket, getChatHistory, getDeviceList, getDeviceByIp, setRegistryPath, loadDeviceRegistry, createBroadcaster } = require('./src/chat');

// Parse CLI args
const config = parseArgs(process.argv.slice(2));
const pinStore = { current: config.pin || generatePin() };

// Ensure shared directory exists
if (!fs.existsSync(config.dir)) {
  fs.mkdirSync(config.dir, { recursive: true });
  console.log(`\x1b[33mCreated shared directory: ${config.dir}\x1b[0m`);
}

// Set device registry path
setRegistryPath(config.dir);

// Express app
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security middleware
app.use(securityHeaders);
app.use(corsMiddleware);
app.use(createRateLimiter(200, 60000));
if (config.allowIps.length > 0) {
  app.use(ipAllowlist(config.allowIps));
}

// Auth middleware
app.use(createAuthMiddleware(pinStore));

// Auth routes (before static files)
app.post('/api/auth', handleAuth(pinStore));
app.post('/api/logout', handleLogout);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Start server (async for selfsigned cert generation)
(async () => {
  let server;

  if (config.noTls) {
    server = http.createServer(app);
  } else {
    const certDir = path.join(os.homedir(), '.connectlan');
    const certPath = path.join(certDir, 'cert.pem');
    const keyPath = path.join(certDir, 'key.pem');
    
    if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
    
    // Generate self-signed cert if it doesn't exist
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.log('\x1b[33mGenerating self-signed TLS certificate...\x1b[0m');
      try {
        const pems = await selfsigned.generate(
          [{ name: 'commonName', value: 'ConnectLAN' }],
          { keySize: 2048, algorithm: 'sha256' }
        );
        fs.writeFileSync(keyPath, pems.private);
        fs.writeFileSync(certPath, pems.cert);
      } catch (e) {
        console.log('\x1b[33mTLS cert generation failed. Falling back to HTTP.\x1b[0m');
        config.noTls = true;
      }
    }
    
    if (!config.noTls) {
      const tlsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
      server = https.createServer(tlsOptions, app);
      
      // HTTP redirect server
      const redirectServer = http.createServer((req, res) => {
        const host = req.headers.host?.split(':')[0] || 'localhost';
        res.writeHead(301, { Location: `https://${host}:${config.port}${req.url}` });
        res.end();
      });
      redirectServer.listen(config.port + 1);
    } else {
      server = http.createServer(app);
    }
  }

  // WebSocket server
  const wss = new WebSocketServer({ server });
  const broadcast = createBroadcaster(wss);

  // Setup WebSocket handlers
  setupWebSocket(wss, validateWsAuth);

  // File routes (need broadcast function)
  app.use('/api', createFileRoutes(config, broadcast, pinStore, getDeviceByIp, loadDeviceRegistry));

  // Refresh PIN — host only
  app.post('/api/refresh-pin', (req, res) => {
    const { isLocalhostSocket } = require('./src/auth');
    if (!isLocalhostSocket(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    pinStore.current = generatePin();
    console.log(`  \x1b[1m🔑 PIN refreshed:\x1b[0m  \x1b[33m\x1b[1m${pinStore.current}\x1b[0m`);
    // Broadcast to all clients so host UI can update
    broadcast({ type: 'pin-refreshed' });
    return res.json({ success: true, pin: pinStore.current });
  });

  // Chat history endpoint
  app.get('/api/chat/history', (req, res) => {
    res.json({ messages: getChatHistory(), devices: getDeviceList() });
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Graceful shutdown
  let isShuttingDown = false;
  function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n\x1b[33m${signal} received. Shutting down gracefully...\x1b[0m`);
    
    // Close WebSocket connections
    wss.clients.forEach(client => client.close(1001, 'Server shutting down'));
    
    server.close(() => {
      console.log('\x1b[32mServer closed.\x1b[0m');
      process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
      console.log('\x1b[31mForced shutdown.\x1b[0m');
      process.exit(1);
    }, 10000);
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Start server
  server.listen(config.port, '0.0.0.0', () => {
    const protocol = config.noTls ? 'http' : 'https';
    const ips = getLocalIPs();
    const disk = getDiskSpace(config.dir);
    
    console.log('');
    console.log('\x1b[1m\x1b[36m  ╔═══════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[1m\x1b[36m  ║         🔗 ConnectLAN v1.0.0              ║\x1b[0m');
    console.log('\x1b[1m\x1b[36m  ╚═══════════════════════════════════════════╝\x1b[0m');
    console.log('');
    console.log(`  \x1b[1m🔑 PIN:\x1b[0m  \x1b[33m\x1b[1m${pinStore.current}\x1b[0m`);
    console.log(`  \x1b[1m📁 Shared:\x1b[0m ${config.dir}`);
    console.log(`  \x1b[1m💾 Disk:\x1b[0m   ${formatBytes(disk.free)} free of ${formatBytes(disk.total)}`);
    console.log(`  \x1b[1m🔒 TLS:\x1b[0m    ${config.noTls ? 'Disabled (HTTP)' : 'Enabled (HTTPS)'}`);
    console.log('');
    console.log('  \x1b[1mAccess URLs:\x1b[0m');
    console.log(`  \x1b[2m  Local:\x1b[0m    ${protocol}://localhost:${config.port}`);
    
    if (ips.length > 0) {
      for (const ip of ips) {
        console.log(`  \x1b[2m  ${ip.name}:\x1b[0m ${protocol}://${ip.address}:${config.port}`);
      }
      
      // QR Code for first LAN IP
      if (qrcodeTerminal) {
        const url = `${protocol}://${ips[0].address}:${config.port}`;
        console.log('');
        console.log('  \x1b[1m📱 Scan to connect from phone:\x1b[0m');
        qrcodeTerminal.generate(url, { small: true }, (qr) => {
          console.log(qr.split('\n').map(l => '    ' + l).join('\n'));
        });
      }
    }
    
    console.log('');
    if (!config.noTls) {
      console.log('  \x1b[2m⚠ First visit: click "Advanced" → "Proceed" to accept the self-signed cert.\x1b[0m');
    }
    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m');
    console.log('');
  });
})().catch(err => {
  console.error('\x1b[31mFatal startup error:\x1b[0m', err);
  process.exit(1);
});
