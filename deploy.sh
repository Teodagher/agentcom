#!/usr/bin/env bash
# Deploy AgentCom to astry-vm1-main. Idempotent — safe to re-run for updates.
set -euo pipefail

SERVER="root@178.105.24.117"
REMOTE_DIR="/opt/agentcom"
# DOMAIN = the vhost Caddy serves (the real origin).
# PUBLIC_ORIGIN = the URL humans and agents actually use — Vercel sits in front
# and proxies to DOMAIN, so every link the app prints must use this one.
DOMAIN="${AGENTCOM_DOMAIN:-agentcom.178-105-24-117.sslip.io}"
PUBLIC_ORIGIN="${AGENTCOM_PUBLIC_ORIGIN:-https://agentcom-astry.vercel.app}"
PORT=18802

cd "$(dirname "$0")"

echo "→ copying server.js to $SERVER:$REMOTE_DIR"
ssh "$SERVER" "mkdir -p $REMOTE_DIR/data/rooms"
scp -q server.js "$SERVER:$REMOTE_DIR/server.js"

echo "→ installing systemd unit"
ssh "$SERVER" "cat > /etc/systemd/system/agentcom.service" <<UNIT
[Unit]
Description=AgentCom — a chat room two AI agents can talk in
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
Environment=PORT=$PORT
Environment=PUBLIC_ORIGIN=$PUBLIC_ORIGIN
Environment=DATA_DIR=$REMOTE_DIR/data
ExecStart=/usr/bin/env node $REMOTE_DIR/server.js
Restart=always
RestartSec=2
StandardOutput=append:/var/log/agentcom.log
StandardError=append:/var/log/agentcom.log

[Install]
WantedBy=multi-user.target
UNIT

echo "→ installing Caddy site config for $DOMAIN"
ssh "$SERVER" "cat > /etc/caddy/conf.d/agentcom.conf" <<CADDY
# AgentCom — chat room for AI agents.
# Long-poll + SSE: disable buffering and allow long-held responses.
$DOMAIN {
  reverse_proxy 127.0.0.1:$PORT {
    flush_interval -1
    transport http {
      response_header_timeout 180s
      read_timeout 180s
    }
  }
}
CADDY

echo "→ restarting services"
ssh "$SERVER" "systemctl daemon-reload && systemctl enable --now agentcom && systemctl restart agentcom && caddy validate --config /etc/caddy/Caddyfile >/dev/null && systemctl reload caddy"

sleep 2
echo "→ health check"
ssh "$SERVER" "curl -sf http://127.0.0.1:$PORT/health" && echo "  local OK"
echo "→ done: $PUBLIC_ORIGIN  (origin: https://$DOMAIN)"
