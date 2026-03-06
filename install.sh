#!/usr/bin/env bash
set -euo pipefail

# NearDrop Installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/Prajeet-Shrestha/neardrop/main/install.sh | bash

# ─── Colors ──────────────────────────────────────────
BOLD='\033[1m'
ACCENT='\033[38;2;0;122;255m'        # NearDrop blue  #007aff
SUCCESS='\033[38;2;40;205;65m'       # green          #28cd41
WARN='\033[38;2;255;204;0m'          # yellow         #ffcc00
ERROR='\033[38;2;255;59;48m'         # red            #ff3b30
MUTED='\033[38;2;99;99;102m'         # gray           #636366
NC='\033[0m'

# ─── Config ──────────────────────────────────────────
REPO="Prajeet-Shrestha/neardrop"
APP_NAME="NearDrop"
STAGE_TOTAL=3
STAGE_CURRENT=0

# ─── Temp Cleanup ────────────────────────────────────
TMPFILES=()
cleanup() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup EXIT

# ─── UI Helpers ──────────────────────────────────────
ui_success() { echo -e "  ${SUCCESS}✓${NC} $*"; }
ui_error()   { echo -e "  ${ERROR}✗${NC} $*"; }
ui_info()    { echo -e "  ${MUTED}·${NC} $*"; }
ui_warn()    { echo -e "  ${WARN}!${NC} $*"; }

ui_stage() {
    STAGE_CURRENT=$((STAGE_CURRENT + 1))
    echo ""
    echo -e "  ${ACCENT}${BOLD}[${STAGE_CURRENT}/${STAGE_TOTAL}] $1${NC}"
}

ui_kv() {
    printf "  ${MUTED}%-18s${NC} %s\n" "$1" "$2"
}

# ─── Banner ──────────────────────────────────────────
print_banner() {
    echo ""
    echo -e "  ${ACCENT}${BOLD}╔═══════════════════════════════════════════╗${NC}"
    echo -e "  ${ACCENT}${BOLD}║            🔗 NearDrop Installer          ║${NC}"
    echo -e "  ${ACCENT}${BOLD}╚═══════════════════════════════════════════╝${NC}"
    echo -e "  ${MUTED}LAN file sharing — no cloud, no accounts${NC}"
    echo ""
}

# ─── Detect OS & Arch ────────────────────────────────
detect_platform() {
    OS="$(uname -s 2>/dev/null || true)"
    ARCH="$(uname -m 2>/dev/null || true)"

    case "$OS" in
        Darwin)  PLATFORM="mac" ;;
        Linux)   PLATFORM="linux" ;;
        *)
            ui_error "Unsupported OS: ${OS}"
            ui_info  "Windows users: download the installer from GitHub Releases"
            ui_info  "https://github.com/${REPO}/releases/latest"
            exit 1
            ;;
    esac

    case "$ARCH" in
        arm64|aarch64) ARCH_LABEL="arm64" ;;
        x86_64|amd64)  ARCH_LABEL="x64" ;;
        *)
            ui_error "Unsupported architecture: ${ARCH}"
            exit 1
            ;;
    esac

    ui_success "Detected: ${OS} (${ARCH_LABEL})"
}

# ─── Check Dependencies ─────────────────────────────
check_deps() {
    local missing=0
    for cmd in curl; do
        if ! command -v "$cmd" &>/dev/null; then
            ui_error "Required: ${cmd} (not found)"
            missing=1
        fi
    done
    if [[ "$missing" -eq 1 ]]; then
        exit 1
    fi
}

# ─── Fetch Latest Version ───────────────────────────
fetch_version() {
    ui_info "Checking latest release..."

    # Use GitHub redirect (no API rate limits, no jq needed)
    local redirect_url
    redirect_url=$(curl -sI "https://github.com/${REPO}/releases/latest" \
        | grep -i "^location:" | tr -d '\r' | sed 's/.*\///')

    if [[ -z "$redirect_url" ]]; then
        ui_error "Could not determine latest version"
        ui_info  "Check: https://github.com/${REPO}/releases"
        exit 1
    fi

    VERSION="${redirect_url#v}"
    ui_success "Latest version: v${VERSION}"
}

# ─── Download Asset ──────────────────────────────────
download_asset() {
    # Determine asset name (includes arch label to match release filenames)
    if [[ "$PLATFORM" == "mac" ]]; then
        ASSET_NAME="${APP_NAME}-${VERSION}-${ARCH_LABEL}.dmg"
    else
        ASSET_NAME="${APP_NAME}-${VERSION}-${ARCH_LABEL}.AppImage"
    fi

    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET_NAME}"
    TMPDIR_DL=$(mktemp -d)
    TMPFILES+=("$TMPDIR_DL")
    DOWNLOAD_PATH="${TMPDIR_DL}/${ASSET_NAME}"

    ui_info "Downloading ${ASSET_NAME}..."

    local http_code
    printf "  "
    http_code=$(curl -L -# --retry 3 --retry-delay 2 --retry-connrefused \
        -w "%{http_code}" -o "$DOWNLOAD_PATH" "$DOWNLOAD_URL")

    if [[ "$http_code" != "200" ]]; then
        ui_error "Download failed (HTTP ${http_code})"
        ui_info  "URL: ${DOWNLOAD_URL}"
        ui_info  "Download manually: https://github.com/${REPO}/releases/latest"
        exit 1
    fi

    local size
    size=$(du -h "$DOWNLOAD_PATH" | cut -f1 | xargs)
    ui_success "Downloaded ${ASSET_NAME} (${size})"
}

# ─── Install (macOS) ────────────────────────────────
install_mac() {
    ui_info "Mounting DMG..."

    local mount_output mount_point
    mount_output=$(hdiutil attach "$DOWNLOAD_PATH" -nobrowse -quiet 2>&1)
    mount_point=$(echo "$mount_output" | grep "/Volumes" | tail -1 | sed 's/.*\t//')

    if [[ -z "$mount_point" ]]; then
        ui_error "Failed to mount DMG"
        exit 1
    fi

    local app_path
    app_path=$(find "$mount_point" -maxdepth 1 -name "*.app" | head -1)
    if [[ -z "$app_path" ]]; then
        ui_error "No .app found in DMG"
        hdiutil detach "$mount_point" -quiet 2>/dev/null || true
        exit 1
    fi

    # Remove old version
    if [[ -d "/Applications/${APP_NAME}.app" ]]; then
        ui_info "Removing previous version..."
        rm -rf "/Applications/${APP_NAME}.app"
    fi

    ui_info "Copying to /Applications..."
    cp -R "$app_path" /Applications/

    hdiutil detach "$mount_point" -quiet 2>/dev/null || true

    ui_success "Installed → /Applications/${APP_NAME}.app"
}

# ─── Install (Linux) ────────────────────────────────
install_linux() {
    local install_dir="/usr/local/bin"
    local install_path="${install_dir}/neardrop"

    chmod +x "$DOWNLOAD_PATH"

    if [[ -w "$install_dir" ]]; then
        mv "$DOWNLOAD_PATH" "$install_path"
    else
        ui_info "Root access required for ${install_dir}"
        sudo mv "$DOWNLOAD_PATH" "$install_path"
    fi

    ui_success "Installed → ${install_path}"
}

# ─── Main ────────────────────────────────────────────
main() {
    print_banner
    check_deps

    # Stage 1: Detect
    ui_stage "Detecting platform"
    detect_platform

    # Stage 2: Download
    ui_stage "Downloading latest release"
    fetch_version
    download_asset

    # Stage 3: Install
    ui_stage "Installing"
    if [[ "$PLATFORM" == "mac" ]]; then
        install_mac
    else
        install_linux
    fi

    # Summary
    echo ""
    echo -e "  ${SUCCESS}${BOLD}🎉 NearDrop v${VERSION} installed successfully!${NC}"
    echo ""
    ui_kv "Version"  "v${VERSION}"
    ui_kv "Platform" "${OS} (${ARCH_LABEL})"
    if [[ "$PLATFORM" == "mac" ]]; then
        ui_kv "Location" "/Applications/${APP_NAME}.app"
    else
        ui_kv "Location" "/usr/local/bin/neardrop"
        ui_kv "Run with" "neardrop"
    fi
    echo ""
    echo -e "  ${ACCENT}${BOLD}→ Search \"NearDrop\" to launch${NC}"
    echo ""
    ui_info "Releases: https://github.com/${REPO}/releases"
    echo ""
}

main "$@"
