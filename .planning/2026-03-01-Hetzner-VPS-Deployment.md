# Clawdock — Hetzner VPS Deployment Plan

**Date:** March 1, 2026
**Target:** Hetzner CPX31 — Ashburn, VA (4 vCPU AMD, 8GB RAM, 160GB NVMe)
**Running:** Coolify + production client websites

---

## Overview

Clawdock runs as a systemd user service alongside Coolify and its managed web stacks. No ports are exposed. The two stacks are isolated at the Docker network level and don't interact.

The CPX31 has comfortable headroom for this workload. Clawdock's agent containers are short-lived (spawn → respond → exit) and typically consume 256–512MB RAM per active response. With `MAX_CONCURRENT_CONTAINERS=3`, worst-case peak RAM usage from Clawdock is ~1.5GB — well within the 8GB available alongside the production stack.

---

## Isolation from Coolify

Coolify manages its own Docker networks and containers. Clawdock runs independently:

- **Docker:** Separate containers, separate named network, no overlap with Coolify-managed stacks
- **Ports:** Clawdock opens no listening ports — nothing to expose, no firewall changes needed for the service
- **Systemd:** Runs as a user service, not interfering with Coolify's daemon or reverse proxy
- **Filesystem:** Lives in its own directory (e.g. `~/clawdock`), separate from Coolify's data paths

Coolify and Clawdock share only the Docker daemon and hardware resources.

---

## Prerequisites on the VPS

Verify these are already present or install:

```bash
# Node.js 22
node --version   # should be 22.x
# If not: install via nvm or nodesource

# Docker
docker --version  # already present if Coolify is running

# Tailscale
tailscale version  # install if not present
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

---

## Deployment Steps

### 1. Clone the repo

```bash
cd ~
git clone https://github.com/prillcode/clawdock.git
cd clawdock
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env   # or copy from homelabvm
nano .env
```

Key values to set on the VPS:
- `DISCORD_BOT_TOKEN` — same as homelabvm
- `DISCORD_CHANNELS` — same as homelabvm
- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` — Z.AI credentials
- `ASSISTANT_NAME=Willis`
- `GH_TOKEN` — if devwork/gamedev containers need GitHub CLI

Production safety limits (add these to protect the Coolify workload):
- `MAX_CONCURRENT_CONTAINERS=3` — caps simultaneous agent containers
- `CONTAINER_TIMEOUT=300000` — hard 5-minute kill on any runaway container

These are read from `.env` automatically via the systemd `EnvironmentFile` directive — no server-level env configuration needed.

### 4. Build the TypeScript

```bash
npm run build
```

### 5. Build the agent container image

```bash
./container/build.sh
```

### 6. Authenticate Claude Code

Claude Code must be authenticated on this machine for the agent containers to work:

```bash
claude
# Follow auth flow — Max subscription or API key
```

Or if using Z.AI exclusively via `ANTHROPIC_BASE_URL`, confirm that bypasses the Claude Code auth requirement (check container startup logs).

### 7. Create the systemd user service

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/nanoclaw.service << 'EOF'
[Unit]
Description=Clawdock (NanoClaw) AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/clawdock
ExecStart=%h/.nvm/versions/node/v22/bin/node dist/index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=%h/clawdock/.env

[Install]
WantedBy=default.target
EOF
```

> Note: `ExecStart` uses the full nvm path since systemd user services don't inherit your shell's `PATH`. Adjust the Node version path if needed (`ls ~/.nvm/versions/node/`).

```bash
systemctl --user daemon-reload
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
systemctl --user status nanoclaw
```

### 8. Enable lingering (run without login session)

```bash
sudo loginctl enable-linger $USER
```

This ensures the systemd user service survives logout and starts on boot.

---

## Updating Clawdock

```bash
cd ~/clawdock
git pull
npm run build
# Rebuild container if src/container/ changed:
./container/build.sh
systemctl --user restart nanoclaw
```

Or use the `/update` skill from Claude Code on the VPS.

---

## Decommissioning homelabvm

Once the VPS is confirmed working:

1. Verify Willis is responding on Discord from the VPS (check logs for container spawns)
2. Stop the service on homelabvm: `systemctl --user stop nanoclaw`
3. Disable it: `systemctl --user disable nanoclaw`
4. The SQLite DB on homelabvm can be discarded — it only holds message history and scheduled tasks. Recreate scheduled tasks by messaging Willis from Discord.

---

## Access & Management

- SSH into VPS via Tailscale IP (same workflow as homelabvm)
- Logs: `journalctl --user -u nanoclaw -f`
- Restart: `systemctl --user restart nanoclaw`
- No new Hetzner firewall rules needed
