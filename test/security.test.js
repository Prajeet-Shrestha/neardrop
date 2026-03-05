const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { safePath, sanitizeFilename, isLanOrigin } = require('../src/security');

// ─── safePath ─────────────────────────────────────────

describe('safePath', () => {
  const root = '/tmp/test-share';

  it('resolves a simple filename', () => {
    const result = safePath(root, 'file.txt');
    assert.equal(result, path.join(root, 'file.txt'));
  });

  it('resolves a subdirectory path', () => {
    const result = safePath(root, 'sub/dir/file.txt');
    assert.equal(result, path.join(root, 'sub/dir/file.txt'));
  });

  it('returns null for path traversal with ../', () => {
    const result = safePath(root, '../etc/passwd');
    assert.equal(result, null);
  });

  it('returns null for absolute path escape', () => {
    const result = safePath(root, '/etc/passwd');
    assert.equal(result, null);
  });

  it('strips null bytes', () => {
    const result = safePath(root, 'file\x00.txt');
    assert.notEqual(result, null);
    assert.ok(!result.includes('\x00'));
  });

  it('handles empty path as root', () => {
    const result = safePath(root, '');
    assert.equal(result, root);
  });
});

// ─── sanitizeFilename ─────────────────────────────────

describe('sanitizeFilename', () => {
  it('strips path separators', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), '......etcpasswd');
  });

  it('strips angle brackets', () => {
    assert.equal(sanitizeFilename('<script>alert</script>'), 'scriptalertscript');
  });

  it('strips null bytes', () => {
    assert.equal(sanitizeFilename('file\x00.txt'), 'file.txt');
  });

  it('returns untitled for empty input', () => {
    assert.equal(sanitizeFilename(''), 'untitled');
  });

  it('returns untitled for whitespace-only input', () => {
    assert.equal(sanitizeFilename('   '), 'untitled');
  });

  it('preserves normal filenames', () => {
    assert.equal(sanitizeFilename('photo.jpg'), 'photo.jpg');
  });

  it('preserves filenames with spaces', () => {
    assert.equal(sanitizeFilename('my file (1).pdf'), 'my file (1).pdf');
  });
});

// ─── isLanOrigin (CORS validator) ─────────────────────

describe('isLanOrigin', () => {
  // Should ALLOW
  it('allows http://localhost:3000', () => {
    assert.equal(isLanOrigin('http://localhost:3000'), true);
  });

  it('allows https://localhost:51337', () => {
    assert.equal(isLanOrigin('https://localhost:51337'), true);
  });

  it('allows http://127.0.0.1:3000', () => {
    assert.equal(isLanOrigin('http://127.0.0.1:3000'), true);
  });

  it('allows http://[::1]:3000', () => {
    assert.equal(isLanOrigin('http://[::1]:3000'), true);
  });

  it('allows 192.168.x.x (RFC-1918)', () => {
    assert.equal(isLanOrigin('https://192.168.1.5:3000'), true);
  });

  it('allows 10.x.x.x (RFC-1918)', () => {
    assert.equal(isLanOrigin('http://10.0.0.1:3000'), true);
  });

  it('allows 172.16.x.x (RFC-1918)', () => {
    assert.equal(isLanOrigin('http://172.16.0.1:3000'), true);
  });

  it('allows 172.31.x.x (RFC-1918 upper bound)', () => {
    assert.equal(isLanOrigin('http://172.31.255.255:3000'), true);
  });

  it('allows 169.254.x.x (link-local)', () => {
    assert.equal(isLanOrigin('http://169.254.1.1:3000'), true);
  });

  // Should REJECT
  it('rejects null origin', () => {
    assert.equal(isLanOrigin('null'), false);
  });

  it('rejects empty string', () => {
    assert.equal(isLanOrigin(''), false);
  });

  it('rejects undefined', () => {
    assert.equal(isLanOrigin(undefined), false);
  });

  it('rejects public IP (8.8.8.8)', () => {
    assert.equal(isLanOrigin('http://8.8.8.8'), false);
  });

  it('rejects external domain', () => {
    assert.equal(isLanOrigin('http://evil.com'), false);
  });

  it('rejects domain spoofing (192.168.1.5.evil.com)', () => {
    assert.equal(isLanOrigin('http://192.168.1.5.evil.com:3000'), false);
  });

  it('rejects 172.15.x.x (below RFC-1918 range)', () => {
    assert.equal(isLanOrigin('http://172.15.0.1:3000'), false);
  });

  it('rejects 172.32.x.x (above RFC-1918 range)', () => {
    assert.equal(isLanOrigin('http://172.32.0.1:3000'), false);
  });

  it('rejects malformed URL', () => {
    assert.equal(isLanOrigin('not-a-url'), false);
  });
});
