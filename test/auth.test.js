const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { generatePin, normalizeIp } = require('../src/auth');

// ─── generatePin ──────────────────────────────────────

describe('generatePin', () => {
  it('returns a 6-digit string', () => {
    const pin = generatePin();
    assert.equal(pin.length, 6);
    assert.match(pin, /^\d{6}$/);
  });

  it('generates numeric-only PINs', () => {
    for (let i = 0; i < 50; i++) {
      const pin = generatePin();
      assert.match(pin, /^\d{6}$/, `PIN "${pin}" is not 6 digits`);
    }
  });

  it('generates PINs in range 100000-999999', () => {
    for (let i = 0; i < 50; i++) {
      const num = parseInt(generatePin(), 10);
      assert.ok(num >= 100000, `PIN ${num} below 100000`);
      assert.ok(num <= 999999, `PIN ${num} above 999999`);
    }
  });

  it('generates varying PINs (not all the same)', () => {
    const pins = new Set();
    for (let i = 0; i < 20; i++) pins.add(generatePin());
    assert.ok(pins.size > 1, 'All PINs were identical — randomness failure');
  });
});

// ─── normalizeIp ──────────────────────────────────────

describe('normalizeIp', () => {
  it('strips ::ffff: prefix', () => {
    assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  });

  it('leaves plain IPv4 unchanged', () => {
    assert.equal(normalizeIp('192.168.1.5'), '192.168.1.5');
  });

  it('leaves IPv6 loopback unchanged', () => {
    assert.equal(normalizeIp('::1'), '::1');
  });

  it('handles empty string', () => {
    assert.equal(normalizeIp(''), '');
  });

  it('handles null/undefined', () => {
    assert.equal(normalizeIp(null), '');
    assert.equal(normalizeIp(undefined), '');
  });
});
