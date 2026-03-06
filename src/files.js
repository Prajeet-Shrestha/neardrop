const express = require('express');
const QRCode = require('qrcode');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const { safePath, checkSymlinkJail, sanitizeFilename } = require('./security');
const { formatBytes, getFileKind, getFileIconType, isImageFile, generateConflictFreeName, getDiskSpace } = require('./utils');
const { version } = require('../package.json');

function createFileRoutes(config, broadcast, pinStore, getDeviceByIp, loadDeviceRegistry) {
  const router = express.Router();
  const rootDir = config.dir;
  const tempDir = path.join(rootDir, '.neardrop-tmp');
  const metaPath = path.join(rootDir, '.neardrop-meta.json');
  const maxUploadSize = config.maxUploadSize || 10 * 1024 * 1024 * 1024; // 10GB

  // ─── Upload Metadata Store ───────────────────────────
  function loadMeta() {
    try {
      if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    } catch (e) { /* corrupt file, start fresh */ }
    return {};
  }

  function saveMeta(meta) {
    try {
      const tmp = metaPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
      fs.renameSync(tmp, metaPath);
    } catch (e) {
      console.error('Failed to save upload metadata:', e.message);
    }
  }

  function setFileMeta(relativePath, uploaderName, uploaderIp, deviceId) {
    const meta = loadMeta();
    meta[relativePath] = {
      uploaderName,
      uploaderIp,
      deviceId: deviceId || null,
      uploadedAt: new Date().toISOString(),
    };
    saveMeta(meta);
  }

  function deleteFileMeta(relativePath) {
    const meta = loadMeta();
    // Delete exact match and any children (for folders)
    const keysToDelete = Object.keys(meta).filter(
      k => k === relativePath || k.startsWith(relativePath + '/')
    );
    if (keysToDelete.length > 0) {
      keysToDelete.forEach(k => delete meta[k]);
      saveMeta(meta);
    }
  }

  function renameFileMeta(oldPath, newPath) {
    const meta = loadMeta();
    // Rename exact match and any children
    const updates = [];
    for (const k of Object.keys(meta)) {
      if (k === oldPath) {
        updates.push([k, newPath]);
      } else if (k.startsWith(oldPath + '/')) {
        updates.push([k, newPath + k.slice(oldPath.length)]);
      }
    }
    if (updates.length > 0) {
      for (const [oldK, newK] of updates) {
        meta[newK] = meta[oldK];
        delete meta[oldK];
      }
      saveMeta(meta);
    }
  }
  
  // Ensure temp dir exists
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  
  // Cleanup temp dir on startup
  try {
    const temps = fs.readdirSync(tempDir);
    for (const f of temps) {
      fs.rmSync(path.join(tempDir, f), { recursive: true, force: true });
    }
  } catch (e) { /* ignore */ }
  
  // Multer config for uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
      const uniqueName = Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname);
      cb(null, uniqueName);
    }
  });
  const upload = multer({ 
    storage, 
    limits: { fileSize: maxUploadSize }
  });
  
  // GET /api/version (public — no auth required)
  router.get('/version', (req, res) => {
    res.json({ version });
  });

  // GET /api/info
  router.get('/info', (req, res) => {
    const os = require('os');
    const { getLocalIPs } = require('./utils');
    const { isLocalhostSocket } = require('./auth');
    const disk = getDiskSpace(rootDir);
    const isHost = isLocalhostSocket(req.socket.remoteAddress);
    res.json({
      version,
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      platform: os.platform(),
      ips: getLocalIPs(),
      isHost,
      ...(isHost ? {
        sharedDir: rootDir,
        appDataDir: path.join(os.homedir(), '.neardrop'),
      } : {}),
      disk: {
        total: formatBytes(disk.total),
        free: formatBytes(disk.free),
        used: formatBytes(disk.used || (disk.total - disk.free)),
        freeBytes: disk.free,
      },
    });
  });
  
  // GET /api/connect-info — returns QR code, URLs, PIN for Connect Device modal
  router.get('/connect-info', async (req, res) => {
    try {
      const os = require('os');
      const { getLocalIPs } = require('./utils');
      const { isLocalhostSocket } = require('./auth');
      const ips = getLocalIPs();
      const protocol = config.noTls ? 'http' : 'https';
      const port = config.port || 3000;
      const isHost = isLocalhostSocket(req.socket.remoteAddress);
      
      const urls = ips.map(ip => `${protocol}://${ip.address}:${port}`);
      
      let qrSvg = null;
      if (urls.length > 0) {
        qrSvg = await QRCode.toString(urls[0], {
          type: 'svg',
          margin: 1,
          color: { dark: '#ffffff', light: '#00000000' },
        });
      }
      
      res.json({
        urls,
        pin: isHost ? pinStore.current : null,
        protocol,
        port,
        noTls: !!config.noTls,
        qrSvg,
        hostname: os.hostname(),
      });
    } catch (e) {
      console.error('Connect info error:', e.message);
      res.status(500).json({ error: 'Failed to generate connect info' });
    }
  });
  
  // GET /api/files?path=&showHidden=
  router.get('/files', async (req, res) => {
    try {
      const userPath = req.query.path || '';
      const showHidden = req.query.showHidden === 'true';
      const resolved = safePath(userPath, rootDir);
      
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      if (!(await checkSymlinkJail(resolved, rootDir))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        return res.status(404).json({ error: 'Directory not found' });
      }
      
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const files = [];
      const meta = loadMeta();
      const deviceRegistry = loadDeviceRegistry ? loadDeviceRegistry() : {};
      
      for (const entry of entries) {
        // Skip temp dir and meta file
        if (entry.name === '.neardrop-tmp' || entry.name === '.neardrop-meta.json' || entry.name === '.neardrop-devices.json') continue;
        // Skip dotfiles unless requested
        if (!showHidden && entry.name.startsWith('.')) continue;
        
        try {
          const fullPath = path.join(resolved, entry.name);
          const entryStat = await fs.promises.stat(fullPath).catch(() => null);
          if (!entryStat) continue;
          
          const isDir = entryStat.isDirectory();
          let itemCount = 0;
          if (isDir) {
            try {
              const children = await fs.promises.readdir(fullPath);
              itemCount = showHidden ? children.length : children.filter(c => !c.startsWith('.')).length;
            } catch (e) { /* permission denied */ }
          }
          
          const relPath = path.relative(rootDir, fullPath);
          const uploadInfo = meta[relPath] || null;

          // Dynamically resolve the latest name from device registry
          let displayName = uploadInfo ? uploadInfo.uploaderName : null;
          if (uploadInfo && uploadInfo.deviceId && deviceRegistry[uploadInfo.deviceId]) {
            displayName = deviceRegistry[uploadInfo.deviceId].hostname;
          }

          files.push({
            name: entry.name,
            isDirectory: isDir,
            size: isDir ? null : entryStat.size,
            sizeFormatted: isDir ? `${itemCount} item${itemCount !== 1 ? 's' : ''}` : formatBytes(entryStat.size),
            modified: entryStat.mtime.toISOString(),
            kind: getFileKind(entry.name, isDir),
            iconType: getFileIconType(entry.name, isDir),
            isImage: isImageFile(entry.name),
            path: relPath,
            uploadedBy: displayName,
            uploaderIp: uploadInfo ? uploadInfo.uploaderIp : null,
            deviceId: uploadInfo ? uploadInfo.deviceId : null,
            uploadedAt: uploadInfo ? uploadInfo.uploadedAt : null,
          });
        } catch (e) {
          // Skip files we can't read (EACCES)
          continue;
        }
      }
      
      // Get relative path for breadcrumbs
      const relativePath = path.relative(rootDir, resolved);
      
      res.json({
        path: relativePath || '',
        files,
        parentPath: relativePath ? path.dirname(relativePath) : null,
      });
    } catch (e) {
      console.error('Error listing files:', e.message);
      res.status(500).json({ error: 'Failed to list files' });
    }
  });
  
  // POST /api/upload
  router.post('/upload', upload.array('files', 100), async (req, res) => {
    try {
      const targetDir = req.body.targetPath || '';
      const resolved = safePath(targetDir, rootDir);
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      
      // Disk space check
      const disk = getDiskSpace(rootDir);
      const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);
      if (disk.free > 0 && totalSize > disk.free * 0.95) {
        // Cleanup temp files
        for (const f of req.files) fs.unlinkSync(f.path);
        return res.status(507).json({ error: 'Insufficient disk space' });
      }
      
      const uploaded = [];
      const clientIp = (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');
      const device = getDeviceByIp(clientIp);
      const uploaderName = device ? device.hostname : 'Unknown';

      for (const file of req.files) {
        const safeName = sanitizeFilename(file.originalname);
        let finalPath = path.join(resolved, safeName);
        
        // Validate final path is within root
        if (!finalPath.startsWith(rootDir)) {
          fs.unlinkSync(file.path);
          continue;
        }
        
        // Auto-rename on conflict
        finalPath = generateConflictFreeName(finalPath);
        
        // Atomic move from temp
        await fs.promises.rename(file.path, finalPath);
        const relPath = path.relative(rootDir, finalPath);
        uploaded.push(path.basename(finalPath));

        // Record upload metadata
        setFileMeta(relPath, uploaderName, clientIp, device ? device.deviceId : null);
      }
      
      // Broadcast file change
      broadcast({ type: 'file-changed', action: 'created', path: targetDir });
      
      res.json({ success: true, files: uploaded });
    } catch (e) {
      console.error('Upload error:', e.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
  
  // POST /api/upload-folder
  router.post('/upload-folder', upload.array('files', 1000), async (req, res) => {
    try {
      const targetDir = req.body.targetPath || '';
      const resolved = safePath(targetDir, rootDir);
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      
      const uploaded = [];
      for (const file of req.files) {
        const relativePath = sanitizeFilename(file.originalname);
        // webkitRelativePath includes folder structure
        const webkitPath = req.body[`paths_${file.fieldname}`] || relativePath;
        const safeName = webkitPath.split('/').map(p => sanitizeFilename(p)).join('/');
        let finalPath = path.join(resolved, safeName);
        
        if (!finalPath.startsWith(rootDir)) {
          fs.unlinkSync(file.path);
          continue;
        }
        
        // Create parent directories
        await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
        finalPath = generateConflictFreeName(finalPath);
        await fs.promises.rename(file.path, finalPath);
        uploaded.push(safeName);
      }
      
      broadcast({ type: 'file-changed', action: 'created', path: targetDir });
      res.json({ success: true, files: uploaded });
    } catch (e) {
      console.error('Folder upload error:', e.message);
      res.status(500).json({ error: 'Folder upload failed' });
    }
  });
  
  // GET /api/download?path=
  router.get('/download', async (req, res) => {
    try {
      const userPath = req.query.path || '';
      const resolved = safePath(userPath, rootDir);
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      if (!(await checkSymlinkJail(resolved, rootDir))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat || stat.isDirectory()) {
        return res.status(404).json({ error: 'File not found' });
      }
      
      const filename = path.basename(resolved);
      const mimeType = mime.lookup(filename) || 'application/octet-stream';
      
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      
      const stream = fs.createReadStream(resolved);
      stream.on('error', (err) => {
        console.error('Download stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      });
      stream.pipe(res);
    } catch (e) {
      console.error('Download error:', e.message);
      res.status(500).json({ error: 'Download failed' });
    }
  });
  
  // GET /api/download-folder?path=
  router.get('/download-folder', async (req, res) => {
    try {
      const userPath = req.query.path || '';
      const resolved = safePath(userPath, rootDir);
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        return res.status(404).json({ error: 'Folder not found' });
      }
      
      const folderName = path.basename(resolved);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(folderName)}.zip"`);
      
      const archive = archiver('zip', { zlib: { level: 5 } });
      archive.on('error', (err) => {
        console.error('Archive error:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
      
      // Limit file count
      let fileCount = 0;
      const MAX_FILES = 10000;
      archive.on('entry', () => {
        fileCount++;
        if (fileCount > MAX_FILES) {
          archive.abort();
        }
      });
      
      archive.pipe(res);
      archive.directory(resolved, folderName);
      archive.finalize();
    } catch (e) {
      console.error('Folder download error:', e.message);
      res.status(500).json({ error: 'Folder download failed' });
    }
  });
  
  // POST /api/mkdir
  router.post('/mkdir', async (req, res) => {
    try {
      const { path: dirPath, name } = req.body;
      const parentDir = safePath(dirPath || '', rootDir);
      if (!parentDir) return res.status(403).json({ error: 'Access denied' });
      
      const safeName = sanitizeFilename(name || 'New Folder');
      const newDir = path.join(parentDir, safeName);
      if (!newDir.startsWith(rootDir)) return res.status(403).json({ error: 'Access denied' });
      
      const finalPath = generateConflictFreeName(newDir);
      await fs.promises.mkdir(finalPath, { recursive: true });
      
      // Record creator metadata
      const clientIp = (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');
      const device = getDeviceByIp(clientIp);
      const creatorName = device ? device.hostname : 'Unknown';
      const relPath = path.relative(rootDir, finalPath);
      setFileMeta(relPath, creatorName, clientIp, device ? device.deviceId : null);

      broadcast({ type: 'file-changed', action: 'created', path: dirPath || '' });
      res.json({ success: true, name: path.basename(finalPath) });
    } catch (e) {
      console.error('Mkdir error:', e.message);
      res.status(500).json({ error: 'Failed to create folder' });
    }
  });
  
  // DELETE /api/delete
  router.delete('/delete', async (req, res) => {
    try {
      const { path: filePath } = req.body;
      const resolved = safePath(filePath, rootDir);
      if (!resolved || resolved === rootDir) return res.status(403).json({ error: 'Access denied' });
      
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat) return res.status(404).json({ error: 'Not found' });
      
      await fs.promises.rm(resolved, { recursive: true, force: true });

      // Remove upload metadata
      const filePath2 = req.body.path;
      deleteFileMeta(filePath2);

      const parentPath = path.relative(rootDir, path.dirname(resolved));
      broadcast({ type: 'file-changed', action: 'deleted', path: parentPath });
      res.json({ success: true });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        return res.status(403).json({ error: 'Permission denied' });
      }
      console.error('Delete error:', e.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  });
  
  // PUT /api/rename
  router.put('/rename', async (req, res) => {
    try {
      const { path: filePath, newName } = req.body;
      const resolved = safePath(filePath, rootDir);
      if (!resolved || resolved === rootDir) return res.status(403).json({ error: 'Access denied' });
      
      const safeName = sanitizeFilename(newName);
      if (!safeName) return res.status(400).json({ error: 'Invalid name' });
      
      const newPath = path.join(path.dirname(resolved), safeName);
      if (!newPath.startsWith(rootDir)) return res.status(403).json({ error: 'Access denied' });
      
      await fs.promises.rename(resolved, newPath);

      // Update upload metadata key
      const oldRelPath = filePath;
      const newRelPath = path.relative(rootDir, newPath);
      renameFileMeta(oldRelPath, newRelPath);

      const parentPath = path.relative(rootDir, path.dirname(resolved));
      broadcast({ type: 'file-changed', action: 'renamed', path: parentPath });
      res.json({ success: true, name: safeName });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        return res.status(403).json({ error: 'Permission denied' });
      }
      console.error('Rename error:', e.message);
      res.status(500).json({ error: 'Rename failed' });
    }
  });
  
  // GET /api/thumbnail?path=
  router.get('/thumbnail', async (req, res) => {
    try {
      const userPath = req.query.path || '';
      const resolved = safePath(userPath, rootDir);
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      if (!(await checkSymlinkJail(resolved, rootDir))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat || stat.isDirectory()) return res.status(404).json({ error: 'Not found' });
      
      const mimeType = mime.lookup(path.basename(resolved)) || 'application/octet-stream';
      if (!mimeType.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
      
      // Serve the image directly, let the browser handle scaling
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(resolved).pipe(res);
    } catch (e) {
      res.status(500).json({ error: 'Thumbnail failed' });
    }
  });
  
  // GET /api/search?path=&q=
  router.get('/search', async (req, res) => {
    try {
      const userPath = req.query.path || '';
      const query = (req.query.q || '').toLowerCase();
      if (!query) return res.json({ results: [] });
      
      const resolved = safePath(userPath, rootDir);
      if (!resolved) return res.status(403).json({ error: 'Access denied' });
      
      const results = [];
      const MAX_RESULTS = 50;
      
      async function searchDir(dir, depth = 0) {
        if (depth > 5 || results.length >= MAX_RESULTS) return;
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= MAX_RESULTS) break;
            if (entry.name.startsWith('.') || entry.name === '.neardrop-tmp') continue;
            
            if (entry.name.toLowerCase().includes(query)) {
              const fullPath = path.join(dir, entry.name);
              const stat = await fs.promises.stat(fullPath).catch(() => null);
              if (stat) {
                results.push({
                  name: entry.name,
                  isDirectory: stat.isDirectory(),
                  path: path.relative(rootDir, fullPath),
                  size: stat.isDirectory() ? null : stat.size,
                  sizeFormatted: stat.isDirectory() ? '' : formatBytes(stat.size),
                  kind: getFileKind(entry.name, stat.isDirectory()),
                  iconType: getFileIconType(entry.name, stat.isDirectory()),
                });
              }
            }
            
            if (entry.isDirectory()) {
              await searchDir(path.join(dir, entry.name), depth + 1);
            }
          }
        } catch (e) { /* permission denied, skip */ }
      }
      
      await searchDir(resolved);
      res.json({ results });
    } catch (e) {
      console.error('Search error:', e.message);
      res.status(500).json({ error: 'Search failed' });
    }
  });
  
  return router;
}

module.exports = { createFileRoutes };
