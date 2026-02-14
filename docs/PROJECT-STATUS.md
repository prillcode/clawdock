# Project Status

Last updated: 2026-02-14

## What's Running

NanoClaw ("Prillbot") is deployed on a homelab VM (`homelabvm` via Tailscale) as a systemd user service. It connects to Discord and runs Claude agents in Docker containers, one per channel.

### Channels

| Channel  | Folder    | Model  | Trigger                  | Extra Mounts        |
| -------- | --------- | ------ | ------------------------ | ------------------- |
| #main    | `main`    | sonnet | All messages (noTrigger) | Full project access |
| #family  | `family`  | haiku  | @Prillbot                | None                |
| #devwork | `devwork` | opus   | @Prillbot                | `~/dev/` (rw)       |
| #gamedev | `gamedev` | sonnet | @Prillbot                | `~/gamedev/` (rw)   |

### API Provider

Calls route through **Z.AI** (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`) on the GLM Coding Lite-Quarterly plan.

- `opus` / `sonnet` aliases resolve to GLM-4.7 on the provider side
- `haiku` resolves to GLM-4.5-Air
- GLM-5 requires Pro/Max plan upgrade — env vars are pre-wired but commented out

### Safety Limits

- `$0.75` budget cap per query
- 30 turn limit per query

### Mount Security

Extra directory mounts are validated against an allowlist at `~/.config/nanoclaw/mount-allowlist.json` (outside the project). Currently allows `~/dev/` and `~/gamedev/`.

## Infrastructure

| Component    | Detail                                             |
| ------------ | -------------------------------------------------- |
| Host         | `homelabvm` (Tailscale SSH, user `prill`)          |
| Runtime      | Node.js, systemd user service (`clawdock.service`) |
| Containers   | Docker, one per channel invocation                 |
| Database     | SQLite at `store/messages.db`                      |
| Service mgmt | `systemctl --user {start,stop,restart} clawdock`   |

## Key Config Files

| File                 | Location                                  |
| -------------------- | ----------------------------------------- |
| Environment          | `.env` (gitignored)                       |
| Mount allowlist      | `~/.config/nanoclaw/mount-allowlist.json` |
| Systemd unit         | `~/.config/systemd/user/clawdock.service` |
| Channel instructions | `groups/{folder}/CLAUDE.md`               |
| Global instructions  | `groups/global/CLAUDE.md`                 |

## ClawDock Web UI (Planned)

Separate repo at `~/dev/clawdock-web/`. Scaffolded but not yet implemented.

**Goal**: Web chat interface for Prillbot — talk to any channel from a browser instead of Discord.

**Stack**: React 19 + Vite + Tailwind on Cloudflare Pages, Hono API on Cloudflare Workers, D1 for storage, Better Auth (Google + GitHub with allowlist).

**Phases**:

1. **MVP** — Messages routed through Discord (bot token sends/polls). Auth, session management, channel selector, chat UI.
2. **Direct API** — Bypass Discord, talk to NanoClaw directly via WebSocket/SSE for real-time streaming.
3. **File browser** — Browse agent workspace files and view inline diffs.

Plan document: `~/dev/clawdock-web/.planning/CLAWDOCK-WEB-UI-PLAN.md`

## Next Steps

### Immediate (VM)

- [ ] Clone dev repos into `~/dev/` on the VM so devwork mounts have content
- [ ] Clone game repos into `~/gamedev/` on the VM so gamedev mounts have content
- [ ] Update `.env` on VM: set `LOG_LEVEL=info` (currently `debug`)
- [ ] Pull latest commit on VM (`git pull` — includes `deleteSession`/`deleteAllSessions` helpers in db.ts)

### Future (ClawDock)

- [ ] Upgrade Z.AI plan to Pro/Max and uncomment GLM-5 model overrides
- [ ] Add WhatsApp channel back (if needed alongside Discord)
- [ ] Push latest commit to GitHub (1 unpushed on local)

### Future (ClawDock Web)

- [ ] Phase 1: Auth + Discord-proxied chat MVP
- [ ] Phase 2: Direct NanoClaw API with streaming
- [ ] Phase 3: File tree browser
