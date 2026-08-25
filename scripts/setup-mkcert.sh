#!/usr/bin/env bash
# scripts/setup-mkcert.sh
#
# Cross-platform helper to install mkcert and generate locally-trusted TLS
# certificates for local HTTPS development.
#
# Supported platforms: macOS, Linux, Windows WSL2
# Usage: bash scripts/setup-mkcert.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS_DIR="${REPO_ROOT}/certs"

# ─── Colour helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Colour

info()    { echo -e "${GREEN}[mkcert-setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[mkcert-setup] WARNING:${NC} $*"; }
error()   { echo -e "${RED}[mkcert-setup] ERROR:${NC} $*" >&2; exit 1; }

# ─── OS detection ────────────────────────────────────────────────────────────
detect_os() {
    if [[ "${OSTYPE}" == "darwin"* ]]; then
        echo "macos"
    elif grep -qEi "microsoft|WSL" /proc/version 2>/dev/null; then
        echo "wsl2"
    elif [[ "${OSTYPE}" == "linux-gnu"* ]]; then
        echo "linux"
    else
        error "Unsupported operating system: ${OSTYPE}. Please install mkcert manually: https://github.com/FiloSottile/mkcert"
    fi
}

# ─── Install mkcert ──────────────────────────────────────────────────────────
install_mkcert_macos() {
    if ! command -v brew &>/dev/null; then
        error "Homebrew is required on macOS. Install it from https://brew.sh and re-run this script."
    fi
    info "Installing mkcert via Homebrew..."
    brew install mkcert nss
}

install_mkcert_linux() {
    # Try apt first, then fall back to a direct binary download
    if command -v apt-get &>/dev/null; then
        info "Installing mkcert dependencies via apt..."
        sudo apt-get update -qq
        sudo apt-get install -y libnss3-tools curl

        MKCERT_VERSION="$(curl -fsSL https://api.github.com/repos/FiloSottile/mkcert/releases/latest \
            | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')"
        ARCH="$(uname -m)"
        case "${ARCH}" in
            x86_64)  MKCERT_ARCH="amd64" ;;
            aarch64) MKCERT_ARCH="arm64" ;;
            armv7l)  MKCERT_ARCH="arm"   ;;
            *)       error "Unsupported architecture: ${ARCH}" ;;
        esac

        info "Downloading mkcert v${MKCERT_VERSION} (${MKCERT_ARCH})..."
        sudo curl -fsSL \
            "https://github.com/FiloSottile/mkcert/releases/download/v${MKCERT_VERSION}/mkcert-v${MKCERT_VERSION}-linux-${MKCERT_ARCH}" \
            -o /usr/local/bin/mkcert
        sudo chmod +x /usr/local/bin/mkcert
    else
        error "apt-get not found. Please install mkcert manually: https://github.com/FiloSottile/mkcert"
    fi
}

install_mkcert_wsl2() {
    info "WSL2 detected — using Linux install path."
    install_mkcert_linux
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
    local os
    os="$(detect_os)"
    info "Detected OS: ${os}"

    # Install mkcert if not already present
    if command -v mkcert &>/dev/null; then
        info "mkcert is already installed: $(mkcert --version)"
    else
        info "mkcert not found — installing..."
        case "${os}" in
            macos) install_mkcert_macos ;;
            linux) install_mkcert_linux ;;
            wsl2)  install_mkcert_wsl2  ;;
        esac
    fi

    # Install the local Certificate Authority into the system trust store
    info "Installing local CA (you may be prompted for your password)..."
    mkcert -install

    # Create the certs/ directory at the repo root
    mkdir -p "${CERTS_DIR}"
    info "Certificate output directory: ${CERTS_DIR}"

    # Generate certificates for localhost, 127.0.0.1, and ::1
    info "Generating certificates..."
    mkcert \
        -cert-file "${CERTS_DIR}/localhost.pem" \
        -key-file  "${CERTS_DIR}/localhost-key.pem" \
        localhost 127.0.0.1 ::1

    echo ""
    echo -e "${GREEN}✔ mkcert setup complete!${NC}"
    echo ""
    echo "  Certificates written to:"
    echo "    ${CERTS_DIR}/localhost.pem"
    echo "    ${CERTS_DIR}/localhost-key.pem"
    echo ""
    echo "  Next steps:"
    echo "    1. Start the HTTPS stack:"
    echo "       docker compose --profile https up --build"
    echo ""
    echo "    2. Open https://localhost in your browser."
    echo "       Your browser should show a valid, trusted certificate."
    echo ""
    if [[ "${os}" == "wsl2" ]]; then
        warn "WSL2 users: the CA is installed in the Linux trust store."
        warn "To trust the cert in your Windows browser, run the following in"
        warn "a PowerShell terminal (as Administrator):"
        warn "  Import-Certificate -FilePath \"\$(wsl wslpath -w \"\$(mkcert -CAROOT)/rootCA.pem\")\" -CertStoreLocation Cert:\\LocalMachine\\Root"
    fi
}

main "$@"
