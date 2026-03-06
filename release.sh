#!/bin/bash
set -e

# ─── Colors ───────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────
info()  { echo -e "${CYAN}ℹ ${NC}$1"; }
ok()    { echo -e "${GREEN}✔ ${NC}$1"; }
warn()  { echo -e "${YELLOW}⚠ ${NC}$1"; }
fail()  { echo -e "${RED}✖ ${NC}$1"; exit 1; }

# ─── Pre-flight checks ───────────────────────────────
command -v node >/dev/null  || fail "node is not installed"
command -v npm  >/dev/null  || fail "npm is not installed"
command -v gh   >/dev/null  || fail "gh (GitHub CLI) is not installed — brew install gh"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated — run: gh auth login"

# Ensure we're in the project root
[ -f "package.json" ] || fail "Run this script from the project root"

# ─── Handle dirty working tree ────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  warn "Working tree has uncommitted changes:"
  git status --short
  echo ""
  read -p "Include these changes in the release commit? [y/N]: " INCLUDE
  if [[ ! "$INCLUDE" =~ ^[Yy]$ ]]; then
    fail "Commit or stash your changes first, then re-run."
  fi
fi

# ─── Run tests BEFORE anything else ──────────────────
info "Running tests..."
npm test || fail "Tests failed. Fix before releasing."
ok "Tests passed"

# ─── Current version ─────────────────────────────────
CURRENT=$(node -p "require('./package.json').version")
echo ""
echo -e "${BOLD}🔗 NearDrop Release Script${NC}"
echo -e "   Current version: ${CYAN}v${CURRENT}${NC}"
echo ""

# ─── CHANGELOG check ─────────────────────────────────
echo -e "${YELLOW}⚠  Have you updated CHANGELOG.md for this release?${NC}"
read -p "Continue? [y/N]: " CHANGELOG_OK
[[ "$CHANGELOG_OK" =~ ^[Yy]$ ]] || fail "Update CHANGELOG.md first, then re-run."

# ─── Ask for bump type ────────────────────────────────
echo ""
echo -e "${BOLD}Which version bump?${NC}"
echo "  1) patch  (bug fixes, security patches)"
echo "  2) minor  (new features, backward compatible)"
echo "  3) major  (breaking changes)"
echo ""
read -p "Enter choice [1/2/3]: " CHOICE

case "$CHOICE" in
  1) BUMP="patch" ;;
  2) BUMP="minor" ;;
  3) BUMP="major" ;;
  *) fail "Invalid choice: $CHOICE" ;;
esac

# ─── Bump version ─────────────────────────────────────
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
ok "Version bumped: ${CURRENT} → ${NEW_VERSION}"

# ─── Confirm ─────────────────────────────────────────
echo ""
echo -e "${BOLD}Will release:${NC} v${NEW_VERSION} (${BUMP})"
echo -e "${BOLD}Output:${NC}     dist-electron/v${NEW_VERSION}/"
echo -e "${BOLD}Actions:${NC}"
echo "  • Commit all changes + version bump"
echo "  • Build for macOS, Windows, Linux (x64 + arm64)"
echo "  • Create git tag v${NEW_VERSION}"
echo "  • Push to GitHub"
echo "  • Create GitHub Release with all artifacts"
echo ""
read -p "Proceed? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  npm version "$CURRENT" --no-git-tag-version --allow-same-version >/dev/null
  fail "Aborted. Version reverted to ${CURRENT}."
fi

# ─── Commit ───────────────────────────────────────────
info "Committing..."
git add -A
git commit -m "release: v${NEW_VERSION}" --quiet
ok "Committed"

# ─── Build ────────────────────────────────────────────
OUT_DIR="dist-electron/v${NEW_VERSION}"
info "Building for all platforms into ${OUT_DIR}/ ..."
if ! npx electron-builder -mwl -c.directories.output="$OUT_DIR"; then
  warn "Build failed — rolling back commit..."
  git reset --soft HEAD~1
  npm version "$CURRENT" --no-git-tag-version --allow-same-version >/dev/null
  fail "Build failed. Commit reverted, version reset to ${CURRENT}."
fi
ok "Build complete → ${OUT_DIR}/"

# ─── Tag ──────────────────────────────────────────────
info "Creating tag v${NEW_VERSION}..."
git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
ok "Tagged"

# ─── Push ─────────────────────────────────────────────
info "Pushing to GitHub..."
if ! git push --quiet || ! git push --tags --quiet; then
  warn "Push failed — cleaning up tag..."
  git tag -d "v${NEW_VERSION}" 2>/dev/null || true
  fail "Push failed. Local tag removed. Commit is still in place — fix the issue and re-run."
fi
ok "Pushed"

# ─── Collect artifacts ────────────────────────────────
ARTIFACTS=()
for f in "${OUT_DIR}"/*.{dmg,exe,AppImage,deb,zip}; do
  [ -f "$f" ] && ARTIFACTS+=("$f")
done
# Add auto-update manifests and blockmaps
for f in "${OUT_DIR}"/latest*.yml; do
  [ -f "$f" ] && ARTIFACTS+=("$f")
done
for f in "${OUT_DIR}"/*.blockmap; do
  [ -f "$f" ] && ARTIFACTS+=("$f")
done

if [ ${#ARTIFACTS[@]} -eq 0 ]; then
  warn "No artifacts found in ${OUT_DIR}/ — creating release without binaries"
fi

# ─── Create GitHub Release ────────────────────────────
info "Creating GitHub Release with ${#ARTIFACTS[@]} artifacts..."

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Build compare URL (only if previous tag exists)
COMPARE=""
if git tag -l "v${CURRENT}" | grep -q "v${CURRENT}"; then
  COMPARE="**Full Changelog**: https://github.com/${REPO}/compare/v${CURRENT}...v${NEW_VERSION}"
fi

NOTES="## What's Changed

See [CHANGELOG.md](https://github.com/${REPO}/blob/main/CHANGELOG.md) for details.

${COMPARE}"

if ! gh release create "v${NEW_VERSION}" \
  --title "v${NEW_VERSION}" \
  --notes "$NOTES" \
  "${ARTIFACTS[@]}"; then
  warn "GitHub release creation failed — but tag and commits are already pushed."
  warn "Create the release manually: gh release create v${NEW_VERSION} ${OUT_DIR}/*"
  exit 1
fi

ok "GitHub Release created"

# ─── Done ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}🎉 v${NEW_VERSION} released successfully!${NC}"
echo -e "   ${CYAN}https://github.com/${REPO}/releases/tag/v${NEW_VERSION}${NC}"
echo ""
