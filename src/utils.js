const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push({ name, address: addr.address });
      }
    }
  }
  return ips;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + units[i];
}

function getDiskSpace(dirPath) {
  try {
    if (process.platform === 'win32') {
      const drive = path.parse(dirPath).root;
      const driveLetter = drive[0]; // 'C' from 'C:\\'
      // Validate drive letter to be a single alphabetic character
      if (!/^[A-Za-z]$/.test(driveLetter)) return { free: 0, total: 0, used: 0 };
      try {
        // PowerShell (Win10+, required on Win11 25H2+)
        const out = execFileSync('powershell', [
          '-NoProfile', '-c',
          `(Get-PSDrive ${driveLetter} | Select-Object Free,Used | ConvertTo-Json)`
        ], { encoding: 'utf8', timeout: 5000 });
        const info = JSON.parse(out.trim());
        return { free: info.Free, total: info.Free + info.Used, used: info.Used };
      } catch (e) {
        // Fallback: wmic (older Windows)
        const deviceId = drive.replace('\\', ''); // 'C:'
        const out = execFileSync('wmic', [
          'logicaldisk', 'where', `DeviceID='${driveLetter}:'`,
          'get', 'FreeSpace,Size', '/format:csv'
        ], { encoding: 'utf8', timeout: 5000 });
        const lines = out.trim().split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
          const parts = lines[lines.length - 1].split(',');
          return { free: parseInt(parts[1]), total: parseInt(parts[2]) };
        }
      }
    } else {
      const out = execFileSync('df', ['-k', dirPath], { encoding: 'utf8', timeout: 5000 });
      const lines = out.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const total = parseInt(parts[1]) * 1024;
        const used = parseInt(parts[2]) * 1024;
        const free = parseInt(parts[3]) * 1024;
        return { free, total, used };
      }
    }
  } catch (e) { /* ignore */ }
  return { free: 0, total: 0, used: 0 };
}

function getFileKind(name, isDirectory) {
  if (isDirectory) return 'Folder';
  const ext = path.extname(name).toLowerCase().slice(1);
  const kinds = {
    // Images
    jpg: 'Image', jpeg: 'Image', png: 'Image', gif: 'Image', svg: 'Image',
    webp: 'Image', bmp: 'Image', ico: 'Image', heic: 'Image', heif: 'Image',
    tiff: 'Image', tif: 'Image',
    // Documents
    pdf: 'PDF Document', doc: 'Word Document', docx: 'Word Document',
    xls: 'Spreadsheet', xlsx: 'Spreadsheet', ppt: 'Presentation', pptx: 'Presentation',
    txt: 'Text', md: 'Markdown', rtf: 'Rich Text',
    // Code
    js: 'JavaScript', ts: 'TypeScript', py: 'Python', rb: 'Ruby',
    java: 'Java', c: 'C Source', cpp: 'C++ Source', h: 'Header',
    html: 'HTML', css: 'CSS', json: 'JSON', xml: 'XML', yaml: 'YAML',
    yml: 'YAML', sh: 'Shell Script', go: 'Go', rs: 'Rust', swift: 'Swift',
    // Archives
    zip: 'Archive', tar: 'Archive', gz: 'Archive', rar: 'Archive',
    '7z': 'Archive', bz2: 'Archive', xz: 'Archive', dmg: 'Disk Image',
    // Audio
    mp3: 'Audio', wav: 'Audio', flac: 'Audio', aac: 'Audio',
    ogg: 'Audio', m4a: 'Audio', wma: 'Audio',
    // Video
    mp4: 'Video', avi: 'Video', mkv: 'Video', mov: 'Video',
    wmv: 'Video', flv: 'Video', webm: 'Video', m4v: 'Video',
    '3gp': 'Video',
    // Other
    exe: 'Application', app: 'Application', deb: 'Package', rpm: 'Package',
    csv: 'CSV', sql: 'SQL', log: 'Log', eml: 'Email', ics: 'Calendar',
  };
  return kinds[ext] || (ext ? `${ext.toUpperCase()} File` : 'Document');
}

function getFileIconType(name, isDirectory) {
  if (isDirectory) return 'folder';
  const ext = path.extname(name).toLowerCase().slice(1);
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'heic', 'heif', 'tiff', 'tif'];
  const codeExts = ['js', 'ts', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'sh', 'go', 'rs', 'swift', 'php', 'sql'];
  const archiveExts = ['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'dmg'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'];
  const videoExts = ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp'];
  const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv'];
  
  if (imageExts.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (codeExts.includes(ext)) return 'code';
  if (archiveExts.includes(ext)) return 'archive';
  if (audioExts.includes(ext)) return 'audio';
  if (videoExts.includes(ext)) return 'video';
  if (docExts.includes(ext)) return 'document';
  return 'generic';
}

function isImageFile(name) {
  const ext = path.extname(name).toLowerCase().slice(1);
  return ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'heic', 'tiff', 'tif'].includes(ext);
}

function generateConflictFreeName(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let counter = 1;
  let newPath = filePath;
  while (fs.existsSync(newPath)) {
    newPath = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return newPath;
}

function parseArgs(args) {
  const config = {
    port: 3000,
    dir: path.join(os.homedir(), 'shared'),
    noTls: false,
    allowIps: [],
    pin: null,
  };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        config.port = parseInt(args[++i]) || 3000;
        break;
      case '--dir':
        config.dir = path.resolve(args[++i]);
        break;
      case '--no-tls':
        config.noTls = true;
        break;
      case '--allow-ip':
        config.allowIps.push(args[++i]);
        break;
      case '--pin':
        config.pin = args[++i];
        break;
    }
  }
  
  return config;
}

module.exports = {
  getLocalIPs,
  formatBytes,
  getDiskSpace,
  getFileKind,
  getFileIconType,
  isImageFile,
  generateConflictFreeName,
  parseArgs,
};
