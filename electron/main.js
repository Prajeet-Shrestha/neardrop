const { app, BrowserWindow, Menu, Tray, dialog, shell, session, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { version } = require('../package.json');
const { initAutoUpdater, checkForUpdates } = require('./updater');

// ─── State ───────────────────────────────────────────
let mainWindow = null;
let tray = null;
let serverInstance = null;
let isQuitting = false;
let serverPort = 51337;

// ─── Window State Persistence ────────────────────────
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) { /* corrupt file */ }
  return { width: 1200, height: 800 };
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(stateFile, JSON.stringify(bounds), 'utf8');
  } catch (e) { /* ignore */ }
}

// ─── Port Finding ────────────────────────────────────
async function findFreePort(startPort, endPort) {
  const net = require('net');
  for (let port = startPort; port <= endPort; port++) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '0.0.0.0');
    });
    if (available) return port;
  }
  throw new Error(`No free port found between ${startPort} and ${endPort}`);
}

// ─── macOS App Menu ──────────────────────────────────
function createMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => checkForUpdates() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── System Tray ─────────────────────────────────────
function createTray() {
  let trayIcon;
  if (process.platform === 'darwin') {
    // macOS: use Template image for menu bar
    const trayPath = path.join(__dirname, 'trayTemplate.png');
    if (fs.existsSync(trayPath)) {
      trayIcon = nativeImage.createFromPath(trayPath);
      trayIcon.setTemplateImage(true);
    } else {
      // Fallback: use app icon resized
      const iconPath = path.join(__dirname, '..', 'public', 'icon', 'favicon-16x16.png');
      trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
    }
  } else {
    // Windows/Linux: use color icon
    const trayPath = path.join(__dirname, 'tray.png');
    if (fs.existsSync(trayPath)) {
      trayIcon = nativeImage.createFromPath(trayPath);
    } else {
      const iconPath = path.join(__dirname, '..', 'public', 'icon', 'favicon-32x32.png');
      trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
    }
  }

  if (!trayIcon) return; // Can't create tray without icon

  tray = new Tray(trayIcon);
  tray.setToolTip('NearDrop');
  updateTrayMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const pin = serverInstance?.pinStore?.current || '----';
  const protocol = serverInstance?.config?.noTls ? 'http' : 'https';
  const { getLocalIPs } = require(path.join(__dirname, '..', 'src', 'utils'));
  const ips = getLocalIPs();
  const url = ips.length > 0 ? `${protocol}://${ips[0].address}:${serverPort}` : `${protocol}://localhost:${serverPort}`;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show NearDrop',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      }
    },
    { type: 'separator' },
    {
      label: `PIN: ${pin}`,
      click: () => {
        const { clipboard } = require('electron');
        clipboard.writeText(pin);
      }
    },
    {
      label: 'Copy URL',
      click: () => {
        const { clipboard } = require('electron');
        clipboard.writeText(url);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

// ─── Create Window ───────────────────────────────────
function createWindow() {
  const windowState = loadWindowState();
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 500,
    show: false, // Prevent login flash
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    }
  });

  // Load the server URL
  const protocol = serverInstance?.config?.noTls ? 'http' : 'https';
  mainWindow.loadURL(`${protocol}://localhost:${serverPort}`);

  // Show when ready (prevents login flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Inject .electron class on body for CSS overrides
    mainWindow.webContents.executeJavaScript(`document.body.classList.add('electron')`);
  });

  // Minimize to tray on close (except when quitting)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      // On Linux, tray may not be available
      if (process.platform === 'linux' && !tray) {
        mainWindow.minimize();
        mainWindow.show();
      }
    } else {
      saveWindowState();
    }
  });

  // Save state periodically
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  // ─── Download Handling ─────────────────────────────
  session.defaultSession.on('will-download', (event, item) => {
    const suggestedName = item.getFilename();
    const downloadPath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: suggestedName,
    });
    if (downloadPath) {
      item.setSavePath(downloadPath);
    } else {
      item.cancel();
    }
  });

  // ─── External Link Guard ──────────────────────────
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to our own server
    const serverUrl = `${protocol}://localhost:${serverPort}`;
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── App Lifecycle ───────────────────────────────────
app.whenReady().then(async () => {
  // Single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Set About panel version
  app.setAboutPanelOptions({
    applicationName: 'NearDrop',
    applicationVersion: version,
    copyright: '© 2026 Prajeet Shrestha',
  });

  // Create menu
  createMenu();

  // Find free port
  try {
    serverPort = await findFreePort(51337, 51347);
  } catch (e) {
    dialog.showErrorBox('NearDrop', `Could not find a free port (51337-51347): ${e.message}`);
    app.quit();
    return;
  }

  // Start embedded server (HTTP — no TLS issues for WebSocket or external devices)
  try {
    const { startServer } = require(path.join(__dirname, '..', 'server.js'));
    serverInstance = await startServer({ port: serverPort, embedded: true, noTls: true });
  } catch (e) {
    dialog.showErrorBox('NearDrop', `Server failed to start: ${e.message}`);
    app.quit();
    return;
  }

  // Create window and tray
  createWindow();
  createTray();

  // ─── IPC: Open Directory ─────────────────────────────
  ipcMain.handle('open-path', async (_, dirPath) => {
    const os = require('os');
    const allowed = [
      serverInstance?.config?.dir,
      path.join(os.homedir(), '.neardrop'),
    ].filter(Boolean);
    if (!allowed.some(a => dirPath.startsWith(a))) return;
    return shell.openPath(dirPath);
  });

  // Initialize auto-updater (only in packaged builds)
  initAutoUpdater(mainWindow);

  // Update tray menu periodically (PIN might change)
  setInterval(updateTrayMenu, 5000);
});

// Graceful shutdown
app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
  if (serverInstance?.gracefulShutdown) {
    serverInstance.gracefulShutdown('Electron quit');
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep running in tray
  if (process.platform !== 'darwin') {
    // Don't quit — tray keeps running
  }
});

app.on('activate', () => {
  // macOS: re-show window when dock icon clicked
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// ─── Crash Protection ────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  try {
    dialog.showErrorBox('NearDrop Error', `An unexpected error occurred:\n${err.message}`);
  } catch (e) { /* dialog may fail during shutdown */ }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
