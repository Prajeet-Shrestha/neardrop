/* =====================================================
   NearDrop — Client-Side Application
   ===================================================== */

(function() {
  'use strict';

  // ─── State ──────────────────────────────────────────
  const state = {
    authenticated: false,
    currentPath: '',
    history: [],
    historyIndex: -1,
    viewMode: 'icon', // 'icon' | 'list'
    sortField: 'name',
    sortDir: 'asc',
    files: [],
    selectedFiles: new Set(),
    lastSelectedIndex: -1,
    devices: [],
    chatMessages: [],
    chatOpen: false,
    unreadCount: 0,
    ws: null,
    wsReconnectTimer: null,
    wsReconnectDelay: 1000,
    deviceHostname: '',
    deviceOS: '',
    deviceId: localStorage.getItem('neardrop-device-id') || (() => {
      const id = (typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
            (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      localStorage.setItem('neardrop-device-id', id);
      return id;
    })(),
    showHidden: false,
    isHost: false,
    kicked: false,
    filterDeviceId: null,
  };

  // ─── DOM References ─────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const dom = {
    loginPage: $('#login-page'),
    loginForm: $('#login-form'),
    pinDigits: Array.from(document.querySelectorAll('.pin-digit')),
    deviceNameInput: $('#device-name-input'),
    loginError: $('#login-error'),
    tlsHint: $('#tls-hint'),
    app: $('#app'),
    // Toolbar
    btnBack: $('#btn-back'),
    btnForward: $('#btn-forward'),
    breadcrumb: $('#breadcrumb'),
    btnIconView: $('#btn-icon-view'),
    btnListView: $('#btn-list-view'),
    sortSelect: $('#sort-select'),
    btnUpload: $('#btn-upload'),
    btnNewFolder: $('#btn-new-folder'),
    searchInput: $('#search-input'),
    // Sidebar
    sidebar: $('#sidebar'),
    sidebarHome: $('#sidebar-home'),
    sidebarThisDevice: $('#sidebar-this-device'),
    sidebarChat: $('#sidebar-chat'),
    chatBadge: $('#chat-badge'),
    thisDeviceName: $('#this-device-name'),
    connectedDevices: $('#connected-devices'),
    hamburger: $('#hamburger'),
    // Content
    contentArea: $('#content-area'),
    iconGrid: $('#icon-grid'),
    listView: $('#list-view'),
    listBody: $('#list-body'),
    emptyState: $('#empty-state'),
    dragOverlay: $('#drag-overlay'),
    // Chat
    chatPanel: $('#chat-panel'),
    chatMessages: $('#chat-messages'),
    chatInput: $('#chat-input'),
    chatSend: $('#chat-send'),
    chatPaste: $('#chat-paste'),
    chatClose: $('#chat-close'),
    // Status
    statusCenter: $('#status-center'),
    statusVersion: $('#status-version'),
    loginVersion: $('#login-version'),
    // Overlays
    contextMenu: $('#context-menu'),
    dialogOverlay: $('#dialog-overlay'),
    dialogTitle: $('#dialog-title'),
    dialogText: $('#dialog-text'),
    dialogCancel: $('#dialog-cancel'),
    dialogConfirm: $('#dialog-confirm'),
    progressOverlay: $('#progress-overlay'),
    progressTitle: $('#progress-title'),
    progressList: $('#progress-list'),
    toastContainer: $('#toast-container'),
    downloadContainer: $('#download-progress-container'),
    reconnectBanner: $('#reconnect-banner'),
    // Connect Device
    btnConnectDevice: $('#btn-connect-device'),
    connectModalOverlay: $('#connect-modal-overlay'),
    connectModalClose: $('#connect-modal-close'),
    connectQr: $('#connect-qr'),
    connectNoNetwork: $('#connect-no-network'),
    connectUrlsSection: $('#connect-urls-section'),
    connectUrls: $('#connect-urls'),
    connectPinSection: $('#connect-pin-section'),
    connectPin: $('#connect-pin'),
    connectRefreshPin: $('#connect-refresh-pin'),
    connectTlsStep: $('#connect-tls-step'),
    // Folder dialog
    folderDialogOverlay: $('#folder-dialog-overlay'),
    folderNameInput: $('#folder-name-input'),
    folderDialogCancel: $('#folder-dialog-cancel'),
    folderDialogCreate: $('#folder-dialog-create'),
    // Hidden inputs
    fileInput: $('#file-input'),
    folderInput: $('#folder-input'),
  };

  // ─── Electron Detection ─────────────────────────────
  const isElectron = !!(window.electronAPI);

  // ─── Init ───────────────────────────────────────────
  async function init() {
    detectDevice();
    setupPinInputs();
    setupEventListeners();
    
    if (location.protocol === 'https:' && !isElectron) {
      dom.tlsHint.textContent = 'If you see a security warning, click "Advanced" → "Proceed" to continue.';
    }
    if (isElectron && dom.tlsHint) {
      dom.tlsHint.style.display = 'none';
    }

    // Global drop prevention: prevent Electron from navigating to dropped files
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    // Check if already authenticated
    try {
      const res = await fetch('/api/info');
      if (res.ok) {
        const info = await res.json();
        showApp(info);
      }
    } catch (e) { /* not authenticated */ }

    // Fetch version for login page (no auth required)
    try {
      const res = await fetch('/api/version');
      if (res.ok) {
        const data = await res.json();
        if (dom.loginVersion) dom.loginVersion.textContent = 'v' + data.version;
      }
    } catch (e) { /* version fetch failed, non-critical */ }
  }

  function detectDevice() {
    const ua = navigator.userAgent;
    if (/Mac/.test(ua)) { state.deviceOS = 'macOS'; state.deviceHostname = 'Mac'; }
    else if (/Linux/.test(ua)) { state.deviceOS = 'Linux'; state.deviceHostname = 'Linux Device'; }
    else if (/Windows/.test(ua)) { state.deviceOS = 'Windows'; state.deviceHostname = 'Windows PC'; }
    else if (/iPhone|iPad/.test(ua)) { state.deviceOS = 'iOS'; state.deviceHostname = 'iPhone'; }
    else if (/Android/.test(ua)) { state.deviceOS = 'Android'; state.deviceHostname = 'Android Device'; }
    else { state.deviceOS = 'Unknown'; state.deviceHostname = 'Device'; }
  }

  // ─── Segmented PIN Input ────────────────────────────
  function setupPinInputs() {
    dom.pinDigits.forEach((input, i) => {

      // Primary handler: input event fires after value changes on all browsers
      input.addEventListener('input', () => {
        const val = input.value.replace(/[^0-9]/g, '');
        if (!val) { input.value = ''; input.classList.remove('filled'); return; }
        // Keep first digit in this box
        input.value = val[0];
        input.classList.add('filled');
        // Forward overflow digits to subsequent boxes
        for (let j = 1; j < val.length && (i + j) < 6; j++) {
          dom.pinDigits[i + j].value = val[j];
          dom.pinDigits[i + j].classList.add('filled');
        }
        const next = Math.min(i + val.length, 5);
        dom.pinDigits[next].focus();
        if (getPin().length === 6) dom.loginForm.requestSubmit();
      });

      // Backspace + arrow keys (these don't trigger input event)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (input.value) {
            // Let the browser clear it, input event will handle state
          } else if (i > 0) {
            e.preventDefault();
            dom.pinDigits[i - 1].value = '';
            dom.pinDigits[i - 1].classList.remove('filled');
            dom.pinDigits[i - 1].focus();
          }
        } else if (e.key === 'ArrowLeft' && i > 0) {
          dom.pinDigits[i - 1].focus();
        } else if (e.key === 'ArrowRight' && i < 5) {
          dom.pinDigits[i + 1].focus();
        }
      });

      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData.getData('text') || '').replace(/[^0-9]/g, '').slice(0, 6);
        for (let j = 0; j < 6; j++) {
          dom.pinDigits[j].value = text[j] || '';
          dom.pinDigits[j].classList.toggle('filled', !!dom.pinDigits[j].value);
        }
        const nextEmpty = text.length < 6 ? text.length : 5;
        dom.pinDigits[nextEmpty].focus();
        if (text.length === 6) dom.loginForm.requestSubmit();
      });
      input.addEventListener('focus', () => input.select());
    });
  }

  function getPin() {
    return dom.pinDigits.map(d => d.value).join('');
  }

  function clearPin() {
    dom.pinDigits.forEach(d => { d.value = ''; d.classList.remove('filled'); });
    dom.pinDigits[0].focus();
  }

  // ─── Auth ───────────────────────────────────────────
  dom.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = getPin();
    if (pin.length !== 6) {
      dom.pinDigits[dom.pinDigits.findIndex(d => !d.value) || 0].focus();
      return;
    }
    
    // Capture custom device name before clearing
    const customName = dom.deviceNameInput.value.trim();
    if (customName) {
      state.deviceHostname = customName + ' (' + state.deviceOS + ')';
    }
    
    dom.loginError.textContent = '';
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (res.ok) {
        const info = await (await fetch('/api/info')).json();
        showApp(info);
      } else {
        dom.loginError.textContent = data.error || 'Invalid PIN';
        clearPin();
      }
    } catch (e) {
      dom.loginError.textContent = 'Connection failed';
    }
  });

  function showApp(info) {
    state.authenticated = true;
    state.isHost = !!info.isHost;
    state.kicked = false;
    dom.loginPage.classList.add('hidden');
    dom.app.classList.remove('hidden');
    dom.thisDeviceName.textContent = info.hostname || 'This Device';
    state.diskFree = info.disk.free;
    if (info.version && dom.statusVersion) dom.statusVersion.textContent = 'v' + info.version;
    
    // Hide folder upload on iOS
    if (/iPhone|iPad/.test(navigator.userAgent)) {
      dom.folderInput.remove();
    }
    
    connectWebSocket();
    loadFiles('');
  }

  // ─── WebSocket ──────────────────────────────────────
  function connectWebSocket() {
    if (state.ws) state.ws.close();
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    state.ws = ws;
    
    ws.onopen = () => {
      state.wsReconnectDelay = 1000;
      dom.reconnectBanner.classList.add('hidden');
      ws.send(JSON.stringify({
        type: 'register-device',
        hostname: state.deviceHostname,
        os: state.deviceOS,
        deviceId: state.deviceId,
        userAgent: navigator.userAgent,
      }));
      // Load chat history
      loadChatHistory();
    };
    
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWsMessage(msg);
      } catch (err) { /* ignore */ }
    };
    
    ws.onclose = (e) => {
      // If kicked by host, show login and don't reconnect
      if (e.code === 4001 || state.kicked) {
        state.kicked = false;
        showLogin('Removed by host');
        return;
      }
      dom.reconnectBanner.classList.remove('hidden');
      clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = setTimeout(() => {
        state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, 30000);
        connectWebSocket();
      }, state.wsReconnectDelay);
    };
    
    ws.onerror = () => {};
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'device-list':
        state.devices = msg.devices;
        renderDevices();
        break;
      case 'device-joined':
        state.devices.push(msg.device);
        renderDevices();
        showToast('info', `${msg.device.hostname} connected`);
        break;
      case 'device-left':
        state.devices = state.devices.filter(d => d.ip !== msg.device.ip);
        renderDevices();
        break;
      case 'chat-message':
        state.chatMessages.push(msg);
        renderChatMessage(msg);
        if (!state.chatOpen) {
          state.unreadCount++;
          dom.chatBadge.textContent = state.unreadCount;
          dom.chatBadge.classList.remove('hidden');
          // Desktop notification
          if (document.hidden && Notification.permission === 'granted') {
            new Notification(`${msg.from.hostname}`, { body: msg.text });
          }
        }
        break;
      case 'file-changed':
        // Auto-refresh if we're viewing the affected directory
        if (msg.path === state.currentPath || msg.path === '') {
          loadFiles(state.currentPath);
        }
        break;
      case 'upload-progress':
        updateUploadProgress(msg);
        break;
      case 'kicked':
        // Server is about to close our connection
        state.kicked = true;
        if (state.ws) { try { state.ws.close(); } catch(e) {} }
        showLogin('Removed by host');
        break;
      case 'kick-result':
        if (msg.success) {
          showToast('success', `Removed ${msg.hostname}`);
        } else if (msg.error) {
          showToast('error', msg.error);
        } else {
          showToast('info', `${msg.hostname} already disconnected`);
        }
        break;
    }
  }

  // ─── File Browser ───────────────────────────────────
  async function loadFiles(filePath) {
    try {
      const params = new URLSearchParams({ path: filePath, showHidden: state.showHidden });
      const res = await fetch(`/api/files?${params}`);
      if (res.status === 401) return showLogin();
      if (!res.ok) { showToast('error', 'Failed to load files'); return; }
      
      const data = await res.json();
      state.currentPath = data.path;
      state.files = sortFiles(data.files);
      
      // Apply device filter if active
      if (state.filterDeviceId) {
        state.files = state.files.filter(f => {
          if (state.filterDeviceId === state.deviceId) {
            // "This Device" filter: include files with matching deviceId OR null (pre-existing host files)
            return f.deviceId === state.filterDeviceId || f.deviceId === null;
          }
          return f.deviceId === state.filterDeviceId;
        });
      }
      
      state.selectedFiles.clear();
      
      renderBreadcrumb();
      renderFiles();
      updateStatusBar();
      updateNavButtons();
    } catch (e) {
      showToast('error', 'Connection error');
    }
  }

  function showLogin(reason) {
    state.authenticated = false;
    state.isHost = false;
    dom.app.classList.add('hidden');
    dom.loginPage.classList.remove('hidden');
    dom.deviceNameInput.value = '';
    clearPin();
    // Reset hostname to default OS-detected name
    detectDevice();
    if (reason) {
      showToast('info', reason);
    }
  }

  function navigate(filePath) {
    // Push to history
    if (state.historyIndex < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyIndex + 1);
    }
    state.history.push(filePath);
    state.historyIndex = state.history.length - 1;
    loadFiles(filePath);
  }

  function sortFiles(files) {
    const f = state.sortField;
    const d = state.sortDir === 'asc' ? 1 : -1;
    return [...files].sort((a, b) => {
      // Folders always first
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      
      if (f === 'name') return d * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      if (f === 'date') return d * (new Date(a.modified) - new Date(b.modified));
      if (f === 'size') return d * ((a.size || 0) - (b.size || 0));
      if (f === 'kind') return d * a.kind.localeCompare(b.kind);
      return 0;
    });
  }

  function renderBreadcrumb() {
    const parts = state.currentPath ? state.currentPath.split('/') : [];
    let html = `<span class="breadcrumb-item" data-path="">Shared Files</span>`;
    let cumPath = '';
    for (const part of parts) {
      cumPath += (cumPath ? '/' : '') + part;
      html += `<span class="breadcrumb-sep">›</span>`;
      html += `<span class="breadcrumb-item" data-path="${esc(cumPath)}">${esc(part)}</span>`;
    }
    dom.breadcrumb.innerHTML = html;
    dom.breadcrumb.querySelectorAll('.breadcrumb-item').forEach(item => {
      item.addEventListener('click', () => navigate(item.dataset.path));
    });
    
    // Update sidebar active state
    dom.sidebarHome.classList.toggle('active', !state.filterDeviceId);
    dom.sidebarThisDevice.classList.toggle('active', state.filterDeviceId === state.deviceId);
  }

  function renderFiles() {
    if (state.viewMode === 'icon') {
      dom.iconGrid.classList.remove('hidden');
      dom.listView.classList.add('hidden');
      renderIconView();
    } else {
      dom.iconGrid.classList.add('hidden');
      dom.listView.classList.remove('hidden');
      renderListView();
    }
    
    const isEmpty = state.files.length === 0;
    dom.emptyState.classList.toggle('hidden', !isEmpty);
    if (isEmpty && state.filterDeviceId) {
      dom.emptyState.querySelector('.empty-title').textContent = 'No files from this device';
      dom.emptyState.querySelector('.empty-text').textContent = 'Files uploaded or created by this device will appear here';
    } else if (isEmpty) {
      dom.emptyState.querySelector('.empty-title').textContent = 'No files yet';
      dom.emptyState.querySelector('.empty-text').textContent = 'Drag & drop files here or use the upload button';
    }
  }

  function renderIconView() {
    dom.iconGrid.innerHTML = state.files.map((f, i) => {
      const uploaderTooltip = f.uploadedBy ? `Uploaded by ${f.uploadedBy} (${f.uploaderIp})\n${formatDate(f.uploadedAt)}` : '';
      return `
      <div class="file-item ${state.selectedFiles.has(i) ? 'selected' : ''}" data-index="${i}" data-path="${esc(f.path)}" data-is-dir="${f.isDirectory}" ${uploaderTooltip ? `title="${esc(uploaderTooltip)}"` : ''}>
        <div class="file-icon-wrap">
          ${f.isDirectory ? renderFolderIcon() : renderFileIcon(f)}
        </div>
        <div class="file-name">${esc(f.name)}</div>
        ${f.sizeFormatted ? `<div class="file-meta">${esc(f.sizeFormatted)}</div>` : ''}
        ${f.uploadedBy ? `<div class="file-uploader">${esc(f.uploadedBy)}</div>` : ''}
      </div>
    `}).join('');
    
    bindFileEvents(dom.iconGrid.querySelectorAll('.file-item'));
    // Handle thumbnail errors via delegation (CSP-safe)
    dom.iconGrid.querySelectorAll('img.file-thumbnail').forEach(img => {
      img.addEventListener('error', () => img.classList.add('img-error'));
    });
  }

  function renderListView() {
    dom.listBody.innerHTML = state.files.map((f, i) => {
      const uploaderTooltip = f.uploadedBy ? `${f.uploadedBy} (${f.uploaderIp}) • ${formatDate(f.uploadedAt)}` : '';
      return `
      <div class="list-row ${state.selectedFiles.has(i) ? 'selected' : ''}" data-index="${i}" data-path="${esc(f.path)}" data-is-dir="${f.isDirectory}">
        <div class="list-col col-name">
          ${f.isDirectory 
            ? '<svg class="list-icon list-folder-icon" viewBox="0 0 16 16"><path d="M1 3h5l2 2h7v8H1V3z" fill="currentColor"/></svg>'
            : '<svg class="list-icon list-file-icon" viewBox="0 0 16 16"><path d="M3 1h6l4 4v10H3V1z" fill="currentColor" opacity="0.5"/></svg>'
          }
          <span>${esc(f.name)}</span>
        </div>
        <div class="list-col col-date">${formatDate(f.modified)}</div>
        <div class="list-col col-size">${f.isDirectory ? '--' : esc(f.sizeFormatted)}</div>
        <div class="list-col col-kind">${esc(f.kind)}</div>
        <div class="list-col col-uploader" title="${esc(uploaderTooltip)}">${f.uploadedBy ? esc(f.uploadedBy) : '–'}</div>
      </div>
    `}).join('');
    
    bindFileEvents(dom.listBody.querySelectorAll('.list-row'));
  }

  function renderFolderIcon() {
    return `<div class="file-icon-folder">
      <div class="folder-tab"></div>
      <div class="folder-back"></div>
      <div class="folder-front"></div>
    </div>`;
  }

  function renderFileIcon(file) {
    if (file.isImage) {
      return `<img class="file-thumbnail" src="/api/thumbnail?path=${encodeURIComponent(file.path)}" alt="" loading="lazy" data-fallback="true">
              <div class="file-icon-doc thumb-fallback"><span class="file-ext-badge">${esc(getExt(file.name))}</span></div>`;
    }
    const cls = file.iconType;
    return `<div class="file-icon-doc ${cls}"><span class="file-ext-badge">${esc(getExt(file.name))}</span></div>`;
  }

  function bindFileEvents(items) {
    items.forEach(item => {
      item.addEventListener('click', (e) => handleFileClick(e, item));
      item.addEventListener('dblclick', () => handleFileDoubleClick(item));
      item.addEventListener('contextmenu', (e) => handleContextMenu(e, item));
      
      // Mobile long-press
      let pressTimer;
      item.addEventListener('touchstart', (e) => {
        pressTimer = setTimeout(() => {
          e.preventDefault();
          const touch = e.touches[0];
          handleContextMenu({ preventDefault: ()=>{}, clientX: touch.clientX, clientY: touch.clientY }, item);
        }, 500);
      }, { passive: false });
      item.addEventListener('touchend', () => clearTimeout(pressTimer));
      item.addEventListener('touchmove', () => clearTimeout(pressTimer));
    });
  }

  // Update selection classes in-place (avoids DOM destruction that breaks dblclick in Firefox)
  function updateSelectionUI() {
    const selector = state.viewMode === 'icon' ? '.file-item' : '.list-row';
    const items = dom.contentArea.querySelectorAll(selector);
    items.forEach(item => {
      const idx = parseInt(item.dataset.index);
      item.classList.toggle('selected', state.selectedFiles.has(idx));
    });
  }

  function handleFileClick(e, item) {
    const idx = parseInt(item.dataset.index);
    
    if (e.metaKey || e.ctrlKey) {
      // Toggle selection
      if (state.selectedFiles.has(idx)) state.selectedFiles.delete(idx);
      else state.selectedFiles.add(idx);
    } else if (e.shiftKey && state.lastSelectedIndex >= 0) {
      // Range selection
      const start = Math.min(state.lastSelectedIndex, idx);
      const end = Math.max(state.lastSelectedIndex, idx);
      for (let i = start; i <= end; i++) state.selectedFiles.add(i);
    } else {
      state.selectedFiles.clear();
      state.selectedFiles.add(idx);
    }
    
    state.lastSelectedIndex = idx;
    updateSelectionUI();
    updateStatusBar();
  }

  function handleFileDoubleClick(item) {
    const filePath = item.dataset.path;
    const isDir = item.dataset.isDir === 'true';
    
    if (isDir) {
      navigate(filePath);
    } else {
      downloadFile(filePath);
    }
  }

  // ─── Context Menu ───────────────────────────────────
  let contextFile = null;

  function handleContextMenu(e, item) {
    e.preventDefault();
    contextFile = state.files[parseInt(item.dataset.index)];
    
    // Select this item
    const idx = parseInt(item.dataset.index);
    if (!state.selectedFiles.has(idx)) {
      state.selectedFiles.clear();
      state.selectedFiles.add(idx);
      renderFiles();
    }
    
    showContextMenu(e.clientX, e.clientY);
  }

  function showContextMenu(x, y) {
    dom.contextMenu.classList.remove('hidden');
    // Position within viewport
    const w = dom.contextMenu.offsetWidth;
    const h = dom.contextMenu.offsetHeight;
    if (x + w > window.innerWidth) x = window.innerWidth - w - 8;
    if (y + h > window.innerHeight) y = window.innerHeight - h - 8;
    dom.contextMenu.style.left = x + 'px';
    dom.contextMenu.style.top = y + 'px';
  }

  function hideContextMenu() {
    dom.contextMenu.classList.add('hidden');
    contextFile = null;
  }

  dom.contextMenu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      if (contextFile) {
        switch (action) {
          case 'open':
            if (contextFile.isDirectory) navigate(contextFile.path);
            else downloadFile(contextFile.path);
            break;
          case 'download':
            if (contextFile.isDirectory) downloadFolder(contextFile.path);
            else downloadFile(contextFile.path);
            break;
          case 'rename':
            startRename(contextFile);
            break;
          case 'delete':
            confirmDelete(contextFile);
            break;
        }
      }
      if (action === 'upload') dom.fileInput.click();
      if (action === 'new-folder') createFolder();
      hideContextMenu();
    });
  });

  document.addEventListener('click', (e) => {
    if (!dom.contextMenu.contains(e.target)) hideContextMenu();
  });

  // Right-click on content area (no file)
  dom.contentArea.addEventListener('contextmenu', (e) => {
    if (e.target === dom.contentArea || e.target === dom.iconGrid || e.target === dom.emptyState) {
      e.preventDefault();
      contextFile = null;
      state.selectedFiles.clear();
      renderFiles();
      showContextMenu(e.clientX, e.clientY);
    }
  });

  // ─── File Operations ────────────────────────────────
  // Active downloads map: path -> { controller, completed, cardId }
  const activeDownloads = new Map();
  let downloadIdCounter = 0;

  async function downloadFile(filePath) {
    // Duplicate guard
    if (activeDownloads.has(filePath)) return;
    await streamDownload(filePath, `/api/download?path=${encodeURIComponent(filePath)}`, filePath.split('/').pop());
  }

  async function downloadFolder(filePath) {
    const key = filePath + '::zip';
    if (activeDownloads.has(key)) return;
    await streamDownload(key, `/api/download-folder?path=${encodeURIComponent(filePath)}`, filePath.split('/').pop() + '.zip');
  }

  async function streamDownload(downloadKey, url, filename) {
    const cardId = 'dl-' + (++downloadIdCounter);
    const controller = new AbortController();
    const entry = { controller, completed: false, cardId };
    activeDownloads.set(downloadKey, entry);

    // Delay showing card: skip for tiny files that finish in <300ms
    let cardVisible = false;
    const cardTimer = setTimeout(() => {
      if (!entry.completed) {
        createDownloadCard(cardId, filename, entry);
        cardVisible = true;
      }
    }, 300);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        clearTimeout(cardTimer);
        entry.completed = true;
        activeDownloads.delete(downloadKey);
        if (cardVisible) removeDownloadCard(cardId);
        showToast('error', 'Download failed');
        return;
      }

      const contentLength = res.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      // Try streaming with ReadableStream; fallback to blob() for old browsers
      let blob;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        const startTime = performance.now();
        let lastUpdateTime = 0;
        const speedSamples = [];
        let lastSampleLoaded = 0;
        let lastSampleTime = startTime;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;

          // Speed sampling every ~500ms
          const now = performance.now();
          if (now - lastSampleTime >= 500) {
            const dt = (now - lastSampleTime) / 1000;
            const db = loaded - lastSampleLoaded;
            speedSamples.push(db / dt);
            if (speedSamples.length > 6) speedSamples.shift(); // ~3s rolling window
            lastSampleLoaded = loaded;
            lastSampleTime = now;
          }

          // Throttle UI updates to ~60fps
          if (cardVisible && now - lastUpdateTime >= 100) {
            lastUpdateTime = now;
            const avgSpeed = speedSamples.length > 0
              ? speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length : 0;
            updateDownloadCard(cardId, loaded, total, avgSpeed);
          }
        }
        blob = new Blob(chunks);
      } else {
        // Fallback: no ReadableStream support — show indeterminate
        if (!cardVisible) {
          clearTimeout(cardTimer);
          createDownloadCard(cardId, filename, entry);
          cardVisible = true;
        }
        updateDownloadCard(cardId, 0, 0, 0); // indeterminate
        blob = await res.blob();
      }

      // Guard: check if cancelled during streaming
      if (entry.completed) return;
      entry.completed = true;
      activeDownloads.delete(downloadKey);
      clearTimeout(cardTimer);

      // Trigger browser download
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

      if (cardVisible) {
        // Show 100% briefly then remove
        updateDownloadCard(cardId, 1, 1, 0);
        removeDownloadCard(cardId, 800);
      }
    } catch (e) {
      clearTimeout(cardTimer);
      if (entry.completed) return; // cancelled, already cleaned up
      entry.completed = true;
      activeDownloads.delete(downloadKey);

      if (e.name === 'AbortError') {
        // User cancelled
        if (cardVisible) removeDownloadCard(cardId);
        showToast('info', 'Download cancelled');
      } else {
        // Network error or other failure
        if (cardVisible) {
          showDownloadCardError(cardId, 'Download failed');
          removeDownloadCard(cardId, 3000);
        } else {
          showToast('error', 'Download failed');
        }
      }
    }
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    
    const formData = new FormData();
    formData.append('targetPath', state.currentPath);
    for (const file of files) {
      formData.append('files', file);
    }
    
    showProgress(`Uploading ${files.length} file(s)...`, files);
    
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          updateProgressBar(0, e.loaded, e.total);
        }
      };
      
      xhr.onload = () => {
        hideProgress();
        if (xhr.status === 200) {
          showToast('success', `${files.length} file(s) uploaded`);
          // Auto-clear filter if viewing another device's files
          if (state.filterDeviceId && state.filterDeviceId !== state.deviceId) {
            state.filterDeviceId = null;
          }
          loadFiles(state.currentPath);
        } else {
          const data = JSON.parse(xhr.responseText);
          showToast('error', data.error || 'Upload failed');
        }
      };
      
      xhr.onerror = () => {
        hideProgress();
        showToast('error', 'Upload failed');
      };
      
      xhr.send(formData);
    } catch (e) {
      hideProgress();
      showToast('error', 'Upload failed');
    }
  }

  async function createFolder() {
    return new Promise((resolve) => {
      dom.folderNameInput.value = 'New Folder';
      dom.folderDialogOverlay.classList.remove('hidden');
      dom.folderNameInput.focus();
      dom.folderNameInput.select();

      const cleanup = () => {
        dom.folderDialogOverlay.classList.add('hidden');
        dom.folderDialogCreate.removeEventListener('click', onCreate);
        dom.folderDialogCancel.removeEventListener('click', onCancel);
        dom.folderNameInput.removeEventListener('keydown', onKey);
      };

      const doCreate = async (name) => {
        cleanup();
        if (!name || !name.trim()) { resolve(); return; }
        try {
          const res = await fetch('/api/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: state.currentPath, name: name.trim() }),
          });
          const data = await res.json();
          if (res.ok) {
            showToast('success', `Created "${data.name}"`);
            if (state.filterDeviceId && state.filterDeviceId !== state.deviceId) {
              state.filterDeviceId = null;
            }
            loadFiles(state.currentPath);
          } else {
            showToast('error', data.error || 'Failed to create folder');
          }
        } catch (e) {
          showToast('error', 'Failed to create folder');
        }
        resolve();
      };

      const onCreate = () => doCreate(dom.folderNameInput.value);
      const onCancel = () => { cleanup(); resolve(); };
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doCreate(dom.folderNameInput.value); }
        if (e.key === 'Escape') { cleanup(); resolve(); }
      };

      dom.folderDialogCreate.addEventListener('click', onCreate);
      dom.folderDialogCancel.addEventListener('click', onCancel);
      dom.folderNameInput.addEventListener('keydown', onKey);
    });
  }

  function startRename(file) {
    const item = dom.contentArea.querySelector(`[data-path="${CSS.escape(file.path)}"]`);
    if (!item) return;
    
    const nameEl = item.querySelector('.file-name') || item.querySelector('.col-name span');
    if (!nameEl) return;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-name-input';
    input.value = file.name;
    nameEl.replaceWith(input);
    input.focus();
    
    // Select name without extension
    const dotIdx = file.name.lastIndexOf('.');
    input.setSelectionRange(0, dotIdx > 0 ? dotIdx : file.name.length);
    
    const doRename = async () => {
      const newName = input.value.trim();
      if (!newName || newName === file.name) {
        loadFiles(state.currentPath);
        return;
      }
      try {
        const res = await fetch('/api/rename', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, newName }),
        });
        if (res.ok) {
          showToast('success', `Renamed to "${newName}"`);
        } else {
          const data = await res.json();
          showToast('error', data.error || 'Rename failed');
        }
      } catch (e) {
        showToast('error', 'Rename failed');
      }
      loadFiles(state.currentPath);
    };
    
    input.addEventListener('blur', doRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { loadFiles(state.currentPath); }
    });
  }

  function confirmDelete(file) {
    dom.dialogTitle.textContent = 'Delete';
    dom.dialogText.textContent = `Are you sure you want to delete "${file.name}"? This cannot be undone.`;
    dom.dialogOverlay.classList.remove('hidden');
    
    const handler = async () => {
      dom.dialogOverlay.classList.add('hidden');
      dom.dialogConfirm.removeEventListener('click', handler);
      try {
        const res = await fetch('/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path }),
        });
        if (res.ok) {
          showToast('success', `Deleted "${file.name}"`);
          loadFiles(state.currentPath);
        } else {
          const data = await res.json();
          showToast('error', data.error || 'Delete failed');
        }
      } catch (e) {
        showToast('error', 'Delete failed');
      }
    };
    
    dom.dialogConfirm.addEventListener('click', handler);
    dom.dialogCancel.onclick = () => {
      dom.dialogOverlay.classList.add('hidden');
      dom.dialogConfirm.removeEventListener('click', handler);
    };
  }

  // ─── Drag & Drop ────────────────────────────────────
  let dragCounter = 0;
  dom.contentArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dom.dragOverlay.classList.remove('hidden');
  });
  dom.contentArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dom.dragOverlay.classList.add('hidden'); dragCounter = 0; }
  });
  dom.contentArea.addEventListener('dragover', (e) => e.preventDefault());
  dom.contentArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dom.dragOverlay.classList.add('hidden');
    if (e.dataTransfer.files.length) {
      uploadFiles(Array.from(e.dataTransfer.files));
    }
  });

  // ─── Upload Buttons ─────────────────────────────────
  dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    if (dom.fileInput.files.length) {
      uploadFiles(Array.from(dom.fileInput.files));
      dom.fileInput.value = '';
    }
  });
  dom.btnNewFolder.addEventListener('click', createFolder);

  // ─── Navigation ─────────────────────────────────────
  dom.btnBack.addEventListener('click', () => {
    if (state.historyIndex > 0) {
      state.historyIndex--;
      loadFiles(state.history[state.historyIndex]);
    }
  });
  dom.btnForward.addEventListener('click', () => {
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++;
      loadFiles(state.history[state.historyIndex]);
    }
  });
  dom.sidebarHome.addEventListener('click', () => {
    state.filterDeviceId = null;
    navigate('');
  });
  dom.sidebarThisDevice.addEventListener('click', () => {
    if (state.filterDeviceId === state.deviceId) return; // Already active
    state.filterDeviceId = state.deviceId;
    navigate('');
  });

  function updateNavButtons() {
    dom.btnBack.disabled = state.historyIndex <= 0;
    dom.btnForward.disabled = state.historyIndex >= state.history.length - 1;
  }

  // ─── View Modes ─────────────────────────────────────
  dom.btnIconView.addEventListener('click', () => setViewMode('icon'));
  dom.btnListView.addEventListener('click', () => setViewMode('list'));

  function setViewMode(mode) {
    state.viewMode = mode;
    dom.btnIconView.classList.toggle('active', mode === 'icon');
    dom.btnListView.classList.toggle('active', mode === 'list');
    renderFiles();
  }

  // ─── Sorting ────────────────────────────────────────
  dom.sortSelect.addEventListener('change', () => {
    const val = dom.sortSelect.value;
    const [field, dir] = val.split('-');
    state.sortField = field;
    state.sortDir = dir;
    state.files = sortFiles(state.files);
    renderFiles();
  });

  // ─── Search ─────────────────────────────────────────
  let searchTimeout;
  dom.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const q = dom.searchInput.value.trim();
      if (q) {
        searchFiles(q);
      } else {
        loadFiles(state.currentPath);
      }
    }, 300);
  });

  async function searchFiles(query) {
    try {
      const res = await fetch(`/api/search?path=${encodeURIComponent(state.currentPath)}&q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      const data = await res.json();
      state.files = data.results;
      // Apply device filter to search results
      if (state.filterDeviceId) {
        state.files = state.files.filter(f => {
          if (state.filterDeviceId === state.deviceId) {
            return f.deviceId === state.filterDeviceId || f.deviceId === null;
          }
          return f.deviceId === state.filterDeviceId;
        });
      }
      state.selectedFiles.clear();
      renderFiles();
      dom.statusCenter.textContent = `${state.files.length} result${state.files.length !== 1 ? 's' : ''}`;
    } catch (e) { /* ignore */ }
  }

  // ─── Chat ───────────────────────────────────────────
  dom.sidebarChat.addEventListener('click', toggleChat);
  dom.chatClose.addEventListener('click', toggleChat);

  function toggleChat() {
    state.chatOpen = !state.chatOpen;
    dom.chatPanel.classList.toggle('hidden', !state.chatOpen);
    if (state.chatOpen) {
      state.unreadCount = 0;
      dom.chatBadge.classList.add('hidden');
      dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
      dom.chatInput.focus();
      // Request notification permission
      if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }
  }

  async function loadChatHistory() {
    try {
      const res = await fetch('/api/chat/history');
      if (!res.ok) return;
      const data = await res.json();
      state.chatMessages = data.messages || [];
      state.devices = data.devices || [];
      
      dom.chatMessages.innerHTML = '';
      state.chatMessages.forEach(msg => renderChatMessage(msg));
      renderDevices();
    } catch (e) { /* ignore */ }
  }

  function renderChatMessage(msg) {
    const isSelf = msg.from.hostname === state.deviceHostname && msg.from.os === state.deviceOS;
    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${isSelf ? 'self' : ''}`;
    msgEl.innerHTML = `
      ${!isSelf ? `<div class="chat-msg-sender">${getDeviceIcon(msg.from.os)} ${esc(msg.from.hostname)}</div>` : ''}
      <div class="chat-msg-bubble">${formatChatText(msg.text)}</div>
      <div class="chat-msg-time">${formatTime(msg.timestamp)}</div>
    `;
    
    // Click to copy
    msgEl.querySelector('.chat-msg-bubble').addEventListener('click', () => {
      navigator.clipboard.writeText(msg.text).then(() => {
        showToast('success', 'Copied to clipboard');
      });
    });
    
    dom.chatMessages.appendChild(msgEl);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  }

  function sendChatMessage() {
    const text = dom.chatInput.value.trim();
    if (!text || !state.ws || state.ws.readyState !== 1) return;
    
    state.ws.send(JSON.stringify({ type: 'chat-message', text }));
    dom.chatInput.value = '';
  }

  dom.chatSend.addEventListener('click', sendChatMessage);
  dom.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  dom.chatPaste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        dom.chatInput.value = text;
        sendChatMessage();
      }
    } catch (e) {
      showToast('info', 'Clipboard access denied');
    }
  });

  // ─── Connect Device ─────────────────────────────────
  dom.btnConnectDevice.addEventListener('click', openConnectModal);
  dom.connectModalClose.addEventListener('click', closeConnectModal);
  dom.connectModalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.connectModalOverlay) closeConnectModal();
  });

  async function openConnectModal() {
    try {
      const res = await fetch('/api/connect-info');
      if (!res.ok) { showToast('error', 'Failed to load connection info'); return; }
      const data = await res.json();

      if (!data.urls || data.urls.length === 0) {
        // No network
        dom.connectQr.classList.add('hidden');
        dom.connectUrlsSection.classList.add('hidden');
        dom.connectPinSection.classList.add('hidden');
        dom.connectNoNetwork.classList.remove('hidden');
      } else {
        dom.connectNoNetwork.classList.add('hidden');
        dom.connectQr.classList.remove('hidden');
        dom.connectUrlsSection.classList.remove('hidden');
        dom.connectPinSection.classList.remove('hidden');

        // QR code
        if (data.qrSvg) {
          dom.connectQr.innerHTML = data.qrSvg;
        }

        // URLs
        const copyIcon = '<svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        dom.connectUrls.innerHTML = data.urls.map(url =>
          `<div class="connect-copyable" data-copy="${esc(url)}"><span>${esc(url)}</span>${copyIcon}</div>`
        ).join('');

        // PIN
        dom.connectPin.innerHTML = `<span class="connect-pin-value">${esc(data.pin)}</span>${copyIcon}`;
        dom.connectPin.dataset.copy = data.pin;

        // Show refresh button for host only
        dom.connectRefreshPin.classList.toggle('hidden', !state.isHost);

        // TLS step
        dom.connectTlsStep.classList.toggle('hidden', data.noTls);
      }

      // Bind copy handlers
      dom.connectModalOverlay.querySelectorAll('.connect-copyable').forEach(el => {
        el.addEventListener('click', () => {
          const text = el.dataset.copy;
          if (text) {
            navigator.clipboard.writeText(text).then(() => showToast('success', 'Copied to clipboard'));
          }
        });
      });

      dom.connectModalOverlay.classList.remove('hidden');
    } catch (e) {
      showToast('error', 'Failed to load connection info');
    }
  }

  function closeConnectModal() {
    dom.connectModalOverlay.classList.add('hidden');
  }

  // Refresh PIN (host only)
  dom.connectRefreshPin.addEventListener('click', async () => {
    dom.connectRefreshPin.classList.add('spinning');
    try {
      const res = await fetch('/api/refresh-pin', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        showToast('error', data.error || 'Failed to refresh PIN');
        return;
      }
      const data = await res.json();
      // Update the displayed PIN
      const copyIcon = '<svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      dom.connectPin.innerHTML = `<span class="connect-pin-value">${esc(data.pin)}</span>${copyIcon}`;
      dom.connectPin.dataset.copy = data.pin;
      showToast('success', 'PIN refreshed');
    } catch (e) {
      showToast('error', 'Failed to refresh PIN');
    } finally {
      setTimeout(() => dom.connectRefreshPin.classList.remove('spinning'), 600);
    }
  });

  // ─── Devices ────────────────────────────────────────
  function renderDevices() {
    const removeIcon = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>';
    dom.connectedDevices.innerHTML = state.devices.map(d => `
      <div class="sidebar-item device-item${state.filterDeviceId === d.deviceId ? ' active' : ''}" data-device-id="${esc(d.deviceId || '')}">
        <span class="sidebar-icon">${getDeviceIcon(d.os)}</span>
        <span>${esc(d.hostname)}</span>
        ${state.isHost && !d.isHost ? `<button class="device-remove-btn" data-ip="${esc(d.ip)}" data-hostname="${esc(d.hostname)}" title="Remove device">${removeIcon}</button>` : ''}
      </div>
    `).join('');
    
    // Bind device click events for filtering
    dom.connectedDevices.querySelectorAll('.device-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.device-remove-btn')) return; // Don't filter when clicking remove
        const deviceId = item.dataset.deviceId;
        if (!deviceId || state.filterDeviceId === deviceId) return; // Already active or no deviceId
        state.filterDeviceId = deviceId;
        navigate('');
      });
    });
    
    // Bind remove button events
    if (state.isHost) {
      dom.connectedDevices.querySelectorAll('.device-remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmKickDevice(btn.dataset.ip, btn.dataset.hostname);
        });
      });
    }
  }

  function confirmKickDevice(ip, hostname) {
    dom.dialogTitle.textContent = 'Remove Device';
    dom.dialogText.textContent = `Remove "${hostname}"? They'll need the PIN to reconnect.`;
    dom.dialogConfirm.textContent = 'Remove';
    dom.dialogOverlay.classList.remove('hidden');
    
    const handler = () => {
      dom.dialogOverlay.classList.add('hidden');
      dom.dialogConfirm.removeEventListener('click', handler);
      dom.dialogConfirm.textContent = 'Delete'; // Reset
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'kick-device', ip, hostname }));
      }
    };
    
    dom.dialogConfirm.addEventListener('click', handler);
    dom.dialogCancel.onclick = () => {
      dom.dialogOverlay.classList.add('hidden');
      dom.dialogConfirm.removeEventListener('click', handler);
      dom.dialogConfirm.textContent = 'Delete'; // Reset
    };
  }

  function getDeviceIcon(osStr) {
    const os = (osStr || '').toLowerCase();
    const s = (d) => `<svg class="inline-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    if (os.includes('mac') || os.includes('darwin')) return s('<path d="M12 2C9.24 2 8 4.09 8 6c0 1.38.56 2.63 1.46 3.54C8.56 10.37 8 11.62 8 13c0 2.76 1.79 5 4 5s4-2.24 4-5c0-1.38-.56-2.63-1.46-3.54C15.44 8.63 16 7.38 16 6c0-1.91-1.24-4-4-4z" fill="currentColor" stroke="none"/>');
    if (os.includes('linux')) return s('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>');
    if (os.includes('windows')) return s('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/>');
    if (os.includes('ios') || os.includes('iphone')) return s('<rect x="5" y="2" width="14" height="20" rx="3"/><line x1="12" y1="18" x2="12" y2="18.01"/>');
    if (os.includes('android')) return s('<rect x="5" y="2" width="14" height="20" rx="3"/><line x1="12" y1="18" x2="12" y2="18.01"/>');
    return s('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>');
  }

  // ─── Progress ───────────────────────────────────────
  function showProgress(title, files) {
    dom.progressTitle.textContent = title;
    dom.progressList.innerHTML = `
      <div class="progress-item">
        <div class="progress-item-name">${files.length > 1 ? `${files.length} files` : esc(files[0].name)}</div>
        <div class="progress-bar"><div class="progress-bar-fill" id="progress-fill-0" style="width:0%"></div></div>
        <div class="progress-info" id="progress-info-0">Preparing...</div>
      </div>
    `;
    dom.progressOverlay.classList.remove('hidden');
  }

  function updateProgressBar(index, loaded, total) {
    const fill = $(`#progress-fill-${index}`);
    const info = $(`#progress-info-${index}`);
    if (!fill) return;
    
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    fill.style.width = pct + '%';
    if (info) {
      const mb = (loaded / (1024 * 1024)).toFixed(1);
      const totalMb = (total / (1024 * 1024)).toFixed(1);
      info.textContent = `${mb} MB / ${totalMb} MB — ${pct}%`;
    }
  }

  function updateUploadProgress(msg) {
    // Progress from WebSocket
    updateProgressBar(0, msg.loaded, msg.total);
  }

  function hideProgress() {
    dom.progressOverlay.classList.add('hidden');
  }

  // ─── Download Progress Cards ──────────────────────────
  function createDownloadCard(id, filename, entry) {
    const card = document.createElement('div');
    card.className = 'download-card';
    card.id = id;
    card.innerHTML = `
      <div class="dl-card-header">
        <svg class="dl-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2v8M4 6l4 4 4-4"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2"/>
        </svg>
        <div class="dl-card-filename" title="${esc(filename)}">${esc(filename)}</div>
        <button class="dl-card-cancel" title="Cancel">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
      <div class="dl-card-bar"><div class="dl-card-bar-fill" id="${id}-fill"></div></div>
      <div class="dl-card-info">
        <span class="dl-card-info-left" id="${id}-info">Starting...</span>
        <span class="dl-card-info-right" id="${id}-speed"></span>
      </div>
    `;
    // Cancel handler
    card.querySelector('.dl-card-cancel').addEventListener('click', () => {
      if (!entry.completed) {
        entry.completed = true;
        removeDownloadCard(id);
        showToast('info', 'Download cancelled');
        entry.controller.abort();
      }
    });
    dom.downloadContainer.appendChild(card);
  }

  function updateDownloadCard(id, loaded, total, speed) {
    const fill = $(`#${id}-fill`);
    const info = $(`#${id}-info`);
    const speedEl = $(`#${id}-speed`);
    if (!fill) return;

    if (total > 0) {
      const pct = Math.min(Math.round((loaded / total) * 100), 100);
      fill.classList.remove('indeterminate');
      fill.style.width = pct + '%';
      if (info) info.textContent = `${formatDlBytes(loaded)} / ${formatDlBytes(total)} — ${pct}%`;
    } else {
      // Indeterminate (folder ZIP or unknown size)
      fill.classList.add('indeterminate');
      fill.style.width = '';
      if (info && loaded > 0) info.textContent = `${formatDlBytes(loaded)} downloaded`;
    }
    if (speedEl && speed > 0) speedEl.textContent = `${formatDlBytes(speed)}/s`;
    else if (speedEl) speedEl.textContent = '';
  }

  function showDownloadCardError(id, message) {
    const info = $(`#${id}-info`);
    const speedEl = $(`#${id}-speed`);
    const fill = $(`#${id}-fill`);
    if (info) { info.textContent = message; info.classList.add('dl-card-error'); }
    if (speedEl) speedEl.textContent = '';
    if (fill) { fill.classList.remove('indeterminate'); fill.style.width = '0%'; fill.style.background = 'var(--red)'; }
  }

  function removeDownloadCard(id, delay = 0) {
    setTimeout(() => {
      const card = $(`#${id}`);
      if (!card) return;
      card.classList.add('removing');
      setTimeout(() => card.remove(), 300);
    }, delay);
  }

  function formatDlBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // ─── Toast Notifications ────────────────────────────
  function showToast(type, message) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  // ─── Status Bar ─────────────────────────────────────
  function updateStatusBar() {
    const total = state.files.length;
    const selected = state.selectedFiles.size;
    const suffix = state.filterDeviceId ? ' · filtered' : '';
    const diskPart = state.diskFree ? `, ${state.diskFree} available` : '';
    if (selected > 0) {
      dom.statusCenter.textContent = `${selected} of ${total} selected${diskPart}${suffix}`;
    } else {
      dom.statusCenter.textContent = `${total} item${total !== 1 ? 's' : ''}${diskPart}${suffix}`;
    }
  }

  // ─── Hamburger (Mobile) ─────────────────────────────
  const sidebarBackdrop = $('#sidebar-backdrop');
  
  function toggleSidebar(forceClose) {
    const isOpen = forceClose ? true : dom.sidebar.classList.contains('open');
    dom.sidebar.classList.toggle('open', !isOpen);
    if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active', !isOpen);
  }
  
  dom.hamburger.addEventListener('click', () => toggleSidebar());
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => toggleSidebar(true));
  
  // Close sidebar on item click (mobile)
  dom.sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.sidebar-item') && window.innerWidth <= 768) {
      toggleSidebar(true);
    }
  });

  // ─── Keyboard Shortcuts ─────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (!state.authenticated) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    // Delete key
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); // Prevent Electron browser back navigation
      if (state.selectedFiles.size === 1) {
        const idx = [...state.selectedFiles][0];
        confirmDelete(state.files[idx]);
      }
    }
    // Enter to rename
    if (e.key === 'Enter' && state.selectedFiles.size === 1) {
      const idx = [...state.selectedFiles][0];
      startRename(state.files[idx]);
    }
    // Cmd+A / Ctrl+A to select all
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      state.files.forEach((_, i) => state.selectedFiles.add(i));
      renderFiles();
    }
    // Escape to deselect
    if (e.key === 'Escape') {
      if (!dom.connectModalOverlay.classList.contains('hidden')) {
        closeConnectModal();
        return;
      }
      state.selectedFiles.clear();
      renderFiles();
      hideContextMenu();
    }
  });

  // ─── Helpers ────────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getExt(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatChatText(text) {
    // Escape all text first for safety, then apply code block formatting
    const escaped = esc(text);
    if (escaped.includes('```')) {
      return escaped.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="chat-code-block">${code}</pre>`);
    }
    return escaped;
  }

  function setupEventListeners() {
    // Click outside to deselect
    dom.contentArea.addEventListener('click', (e) => {
      if (e.target === dom.contentArea || e.target === dom.iconGrid) {
        state.selectedFiles.clear();
        renderFiles();
      }
    });
    
    // Window resize — close sidebar on desktop
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768) {
        dom.sidebar.classList.remove('open');
      }
    });

    // iOS keyboard — keep chat input visible using visualViewport API
    if (window.visualViewport && window.innerWidth <= 768) {
      window.visualViewport.addEventListener('resize', () => {
        const vv = window.visualViewport;
        const keyboardHeight = window.innerHeight - vv.height;
        if (dom.chatPanel && !dom.chatPanel.classList.contains('hidden')) {
          dom.chatPanel.style.bottom = keyboardHeight + 'px';
        }
      });
      window.visualViewport.addEventListener('scroll', () => {
        // Prevent iOS visual viewport scroll offset from shifting content
        if (dom.chatPanel && !dom.chatPanel.classList.contains('hidden')) {
          dom.chatPanel.style.top = window.visualViewport.offsetTop + 'px';
        }
      });
    }
  }

  // ─── Start ──────────────────────────────────────────
  init();
})();
