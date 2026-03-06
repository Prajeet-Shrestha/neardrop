# Changelog

All notable changes to NearDrop will be documented in this file.

## [1.0.1] - 2026-03-06

### Security
- Fixed command injection risk in `getDiskSpace()` — replaced `execSync` with `execFileSync` using argument arrays
- PIN is no longer exposed to non-host devices via `/api/connect-info`
- Removed PIN from `/api/refresh-pin` response body to prevent leakage via logs or proxies

## [1.0.0] - 2026-03-06

### Added
- LAN file sharing with drag-and-drop upload
- Real-time chat between connected devices
- PIN-based authentication with QR code pairing
- Icon and list view modes (Finder-inspired dark UI)
- Per-device shared file spaces
- Electron desktop app for macOS, Windows, and Linux
- Auto-update via GitHub Releases
- Terminal install script (`curl | bash`)

### Security
- Use cryptographically secure random PIN generation (`crypto.randomInt`)
- CORS restricted to LAN-only origins (localhost + RFC-1918 private IPs)
- WebSocket authentication now validates session IP binding
- WebSocket message size capped at 64KB
- Fixed XSS in device sidebar and chat message rendering
- Chat code blocks now properly escaped
- Removed forced auto-launch on login (now opt-in)
- Removed `trust proxy` setting (prevents IP spoofing on LAN)
- Added favicon, apple-touch-icon, and web manifest
