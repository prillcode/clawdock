# Deployment Steps

This document outlines the deployment process for ClawDock from a development machine to the homelab VM.

## Process

```bash
# 1. Commit and push all changes from dev machine
git add .
git commit -m "Update trigger word to be configurable"
git push

# 2. SSH to homelabvm and pull latest code
ssh homelabvm
cd ~/dev/clawdock
git pull

# 3. Update ASSISTANT_NAME in .env on homelabvm
nano .env  # Or use your preferred editor
# Update: ASSISTANT_NAME=YourNewBotName

# 4. Build TypeScript on homelabvm
npm run build

# 5. Restart the service
systemctl --user restart clawdock

# 6. Verify it's running
systemctl --user status clawdock
journalctl --user -u clawdock -f  # Watch logs for startup
```

## Service File Reference

The service is defined at `~/.config/systemd/user/clawdock.service`:

```ini
[Unit]
Description=ClawDock NanoClaw
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=%h/dev/clawdock
EnvironmentFile=%h/dev/clawdock/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

## Trigger Name Configuration

The trigger word is now fully configurable via the `ASSISTANT_NAME` environment variable:

| Variable | Purpose | Default |
| -------- | --------- | -------- |
| `ASSISTANT_NAME` | Bot trigger word and display name in agent memory | `Andy` |

When you change `ASSISTANT_NAME` and restart the service:
- The Discord channel configuration automatically updates with the new trigger
- Existing group registrations are preserved with the updated trigger
- Container agents receive the new `ASSISTANT_NAME` as an environment variable

## Discord Bot Username

When changing the trigger word, you'll also want to update the Discord bot username:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application ("ClawDock" or similar)
3. Navigate to the **Bot** section
4. Update the **Username** field
5. Save changes

Note: Changing the Discord bot username will automatically update all existing `@mention` references in Discord messages. ClawDock translates these mentions to use the `ASSISTANT_NAME` trigger pattern internally.
