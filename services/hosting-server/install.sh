#!/usr/bin/env bash
# One-time setup for the AgentOS hosting server on a fresh Ubuntu VPS (e.g. Hetzner).
# Installs Docker, builds the hosting server image, and runs it on port 80 with a persistent
# volume and a generated deploy token. Re-running is safe (it recreates the container).
#
#   curl -fsSL https://.../install.sh | bash          # (or paste this file and run: bash install.sh)
#
# After it finishes it prints the DEPLOY TOKEN — paste that into AgentOS → Hosting settings.
set -euo pipefail

DATA_DIR="${HOSTING_DATA_DIR:-/opt/agentos-hosting/data}"
PORT="${HOSTING_PORT:-80}"
BASE_HOST="${HOSTING_BASE_HOST:-}"   # optional: set to your apex domain for *.domain subdomains
IMAGE="agentos-hosting:latest"
CONTAINER="agentos-hosting"

echo "==> AgentOS hosting server setup"

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# 2) A deploy token (reuse an existing one so re-running keeps the same token).
TOKEN_FILE="/opt/agentos-hosting/token"
mkdir -p /opt/agentos-hosting "$DATA_DIR"
if [ ! -f "$TOKEN_FILE" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

# 3) Build the image from this directory (expects the hosting-server source here).
echo "==> Building image..."
docker build -t "$IMAGE" "$(dirname "$0")"

# 4) (Re)start the container.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart unless-stopped \
  -p "${PORT}:8080" \
  -v "${DATA_DIR}:/data/sites" \
  -e HOSTING_DEPLOY_TOKEN="$TOKEN" \
  -e HOSTING_BASE_HOST="$BASE_HOST" \
  "$IMAGE"

PUBLIC_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo ""
echo "================================================================"
echo " AgentOS hosting server is running."
echo "   URL base : http://${PUBLIC_IP}/s/<site>/   (set a domain later for https + subdomains)"
echo "   Endpoint : http://${PUBLIC_IP}/api/deploy"
echo ""
echo "   DEPLOY TOKEN (paste into AgentOS -> Hosting):"
echo "   ${TOKEN}"
echo "================================================================"
