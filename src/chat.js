// Chat & WebSocket handler
const os = require('os');
const { sessions, isLocalhostSocket, parseCookie } = require('./auth');

const chatHistory = []; // Last 100 messages
const MAX_HISTORY = 100;
const connectedDevices = new Map(); // ws -> { hostname, os, ip, userAgent, socketIp, sessionToken, isHost }

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setupWebSocket(wss, validateAuth) {
  wss.on('connection', (ws, req) => {
    const socketIp = req.socket.remoteAddress;
    const ip = socketIp.replace('::ffff:', '');
    
    // Auth check (pass socket IP for localhost auto-auth)
    const cookie = req.headers.cookie || '';
    if (!validateAuth(cookie, socketIp)) {
      ws.close(1008, 'Authentication required');
      return;
    }
    
    // Extract session token for kick-based invalidation
    const sessionToken = parseCookie(cookie, 'session') || null;
    
    // Default device info until register-device
    connectedDevices.set(ws, {
      hostname: 'Unknown Device',
      os: 'Unknown',
      ip,
      socketIp,
      sessionToken,
      isHost: isLocalhostSocket(socketIp),
      userAgent: req.headers['user-agent'] || '',
    });
    
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(ws, msg, wss);
      } catch (e) {
        // Ignore malformed messages
      }
    });
    
    ws.on('close', () => {
      const device = connectedDevices.get(ws);
      connectedDevices.delete(ws);
      if (device) {
        // Only broadcast device-left if this was the last connection from this IP
        const remainingFromIp = countConnectionsByIp(device.ip);
        if (remainingFromIp === 0) {
          broadcastToAll(wss, {
            type: 'device-left',
            device: { hostname: device.hostname, os: device.os, ip: device.ip },
          }, ws);
        }
      }
    });
    
    ws.on('error', () => {
      connectedDevices.delete(ws);
    });
  });
}

function handleMessage(ws, msg, wss) {
  switch (msg.type) {
    case 'register-device': {
      const device = connectedDevices.get(ws);
      if (device) {
        device.hostname = escapeHtml(msg.hostname || os.hostname());
        device.os = escapeHtml(msg.os || process.platform);
        device.userAgent = msg.userAgent || '';
        
        // Send current connected devices to the new client (deduplicated)
        const devices = getDeviceList();
        ws.send(JSON.stringify({ type: 'device-list', devices }));
        
        // Only broadcast device-joined if this is the first connection from this IP
        const connectionsFromIp = countConnectionsByIp(device.ip);
        if (connectionsFromIp === 1) {
          broadcastToAll(wss, {
            type: 'device-joined',
            device: { hostname: device.hostname, os: device.os, ip: device.ip, isHost: device.isHost },
          }, ws);
        }
      }
      break;
    }
    
    case 'chat-message': {
      const device = connectedDevices.get(ws);
      if (!device || !msg.text) return;
      
      const text = escapeHtml(msg.text.substring(0, 10000)); // Limit message length
      const chatMsg = {
        type: 'chat-message',
        from: { hostname: device.hostname, os: device.os },
        text,
        timestamp: new Date().toISOString(),
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      };
      
      // Store in history
      chatHistory.push(chatMsg);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      
      // Broadcast to all including sender
      broadcastToAll(wss, chatMsg);
      break;
    }
    
    case 'kick-device': {
      const sender = connectedDevices.get(ws);
      if (!sender) return;
      
      // Only host (localhost) can kick devices
      if (!isLocalhostSocket(sender.socketIp)) {
        ws.send(JSON.stringify({ type: 'kick-result', success: false, error: 'Not authorized' }));
        return;
      }
      
      const targetIp = msg.ip;
      let targetHostname = '';
      let kicked = 0;
      
      // Find ALL connections from this IP (multi-tab)
      for (const [targetWs, device] of connectedDevices) {
        if (device.ip === targetIp) {
          // Self-kick protection: skip loopback devices
          if (device.isHost) continue;
          
          targetHostname = device.hostname;
          
          // Invalidate session
          if (device.sessionToken && sessions.has(device.sessionToken)) {
            sessions.delete(device.sessionToken);
          }
          
          // Notify the kicked client, then close after delay
          try {
            targetWs.send(JSON.stringify({ type: 'kicked' }));
          } catch (e) { /* already closing */ }
          
          setTimeout(() => {
            try { targetWs.close(4001, 'Kicked by host'); } catch (e) { /* ignore */ }
          }, 100);
          
          kicked++;
        }
      }
      
      // Send result back to host
      ws.send(JSON.stringify({
        type: 'kick-result',
        success: kicked > 0,
        hostname: targetHostname,
        count: kicked,
      }));
      break;
    }
  }
}

function broadcastToAll(wss, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === 1) { // WebSocket.OPEN = 1
      client.send(data);
    }
  });
}

// Count how many WebSocket connections exist from a given IP
function countConnectionsByIp(ip) {
  let count = 0;
  for (const [, device] of connectedDevices) {
    if (device.ip === ip) count++;
  }
  return count;
}

// Deduplicated device list — one entry per unique IP
function getDeviceList() {
  const seen = new Map(); // ip -> device info
  for (const [, device] of connectedDevices) {
    if (!seen.has(device.ip)) {
      seen.set(device.ip, {
        hostname: device.hostname,
        os: device.os,
        ip: device.ip,
        isHost: device.isHost,
      });
    }
  }
  return Array.from(seen.values());
}

function getChatHistory() {
  return chatHistory.slice(-MAX_HISTORY);
}

// Create a broadcast function that can be used by file routes
function createBroadcaster(wss) {
  return (msg) => {
    broadcastToAll(wss, msg);
  };
}

module.exports = {
  setupWebSocket,
  getChatHistory,
  getDeviceList,
  createBroadcaster,
};
