#!/usr/bin/env bash
# Runs ON the VPS: generates a deploy token, installs the systemd service for the hosting server
# (already copied to /opt/agentos-hosting/server.mjs), starts it on :80, and prints the token.
set -euo pipefail

DIR=/opt/agentos-hosting
mkdir -p "$DIR/data"

# Reuse an existing token so re-running keeps the same one.
if [ ! -f "$DIR/token" ]; then
  (openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') > "$DIR/token"
fi
TOKEN="$(cat "$DIR/token")"

cat > "$DIR/env" <<EOF
PORT=80
HOSTING_DATA_DIR=$DIR/data
HOSTING_DEPLOY_TOKEN=$TOKEN
HOSTING_BASE_HOST=
EOF

cat > /etc/systemd/system/agentos-hosting.service <<EOF
[Unit]
Description=AgentOS self-hosted hosting server
After=network.target

[Service]
Type=simple
EnvironmentFile=$DIR/env
ExecStart=$(command -v node) $DIR/server.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now agentos-hosting >/dev/null 2>&1
sleep 2
echo "STATUS=$(systemctl is-active agentos-hosting)"
echo "HEALTH=$(curl -fsS http://127.0.0.1/healthz 2>/dev/null || echo FAIL)"
# SECURITY: this listens on plain HTTP. The /api/deploy call carries the bearer token in clear text,
# so for anything beyond testing, put it behind TLS (add a domain + Caddy/Let's Encrypt and point the
# AgentOS hosting endpoint at https://). The token below is the publish credential — keep it private.
echo "TOKEN=$TOKEN"
