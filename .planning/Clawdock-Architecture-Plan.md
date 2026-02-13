# Clawdock Architecture Plan

**Repo:** [github.com/prillcode/clawdock](https://github.com/prillcode/clawdock)
**Forked from:** [github.com/qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
**Author:** Aaron Prill
**Date:** February 13, 2026

---

## 1. Project Overview

Clawdock is a personal fork of NanoClaw — a lightweight, container-isolated AI assistant built on the Anthropic Claude Agent SDK. The name "Clawdock" reflects the project's Docker-first container strategy, running on a Linux homelab VM rather than NanoClaw's original Apple Container target.

Clawdock replaces WhatsApp with Discord as the messaging layer, enabling context-isolated AI agent channels for family coordination, consulting work, and day-job engineering — all running through a single Discord server with per-channel agent isolation.

## 2. Why Fork NanoClaw

NanoClaw provides a minimal, auditable codebase (~2,000 lines of TypeScript) that runs Claude Code agents inside isolated containers. The value proposition is the tight coupling between the Claude Agent SDK and the container security model — each conversation group gets its own Linux container with explicit filesystem mounts, preventing cross-context data leakage.

Clawdock preserves this core architecture while making two primary changes: replacing WhatsApp with Discord, and targeting Docker on Linux rather than Apple Container on macOS.

The name "Clawdock" is a nod to this container-first identity — the Docker runtime is central to how the project isolates and executes AI agents, and the name captures both the "claw" lineage (from NanoClaw/OpenClaw) and the Docker ("dock") foundation.

## 3. Core Architecture (Inherited from NanoClaw)

The runtime is a single Node.js process that orchestrates everything:

- **Message Ingestion** — Discord.js listens for messages across registered channels. Messages matching the trigger pattern are persisted to SQLite.
- **Polling Loop** — The orchestrator (`src/index.ts`) polls the database every 2 seconds for unprocessed messages.
- **Container Execution** — For each triggered message, `src/container-runner.ts` spawns a Docker container with the Claude Agent SDK. The container receives the message context, the channel's `CLAUDE.md` memory file, and any explicitly mounted directories.
- **IPC Response** — The agent writes responses and tool actions (send message, schedule task, etc.) as JSON files to an IPC directory. The host process watches this directory and routes responses back through Discord.
- **Task Scheduling** — `src/task-scheduler.ts` handles cron, interval, and one-shot scheduled tasks. Each task execution spawns its own container.

**Key pipeline:** `Discord (discord.js) → SQLite → Polling Loop → Docker Container (Claude Agent SDK) → IPC → Discord Response`

## 4. Discord Channel Architecture

The Discord server will be organized into isolated channels, each mapped to a ClawDock "group" with its own container context, memory, and filesystem mounts.

### 4.1 Channel Definitions

**#main (Admin / DM Channel)**
- Privileged control channel for system administration
- Can register/unregister channels, manage scheduled tasks across all groups, view system status
- Has full project filesystem access
- Used for commands like "register #family" or "list all scheduled tasks"

**#family**
- Context: Family calendar management, kids' sports schedules, grocery lists, family logistics
- Memory (`groups/family/CLAUDE.md`): Contains family member details, recurring schedules, preferred grocery stores, school calendars
- Potential MCP integrations: Google Calendar, grocery list service
- Scheduled tasks: Monday morning week-ahead summary, game day reminders
- Filesystem: Mounted to family-specific shared directories only

**#consulting**
- Context: Consulting and side-project work — client projects, freelance development
- Memory (`groups/consulting/CLAUDE.md`): Client roster, project statuses, billing context, proposal templates
- Filesystem: Mounted to consulting project directories
- Scheduled tasks: Client deliverable reminders, weekly project status summaries

**#dayjob**
- Context: Primary employment engineering work — daily standups, sprint planning, feature development
- Memory (`groups/dayjob/CLAUDE.md`): Team context, sprint conventions, technical stack details, current project context
- Filesystem: Carefully scoped — only mount directories relevant to day-job work
- Scheduled tasks: Friday sprint recaps, standup reminders

### 4.2 Isolation Guarantees

Each channel's agent runs in a separate Docker container. The agent in #family cannot access #dayjob's filesystem, memory, or session history. This is enforced at the container level via volume mounts, not by prompt instructions. The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) controls which host directories each group can access.

## 5. Deployment Architecture

### 5.1 Development Environment

- **Machine:** Linux laptop (primary development workstation)
- **Workflow:** Fork repo → develop locally → test with `npm run dev` → push to GitHub
- **Purpose:** All code changes, skill development, testing, and iteration happen here

### 5.2 Production Environment

- **Machine:** Linux VM ("homelabvm") running on Windows 11 mini PC
- **Access:** Reachable via Tailscale tailnet as `homelabvm`
- **Runtime:** Node.js process managed by systemd, Docker for agent containers
- **Purpose:** Always-on Discord bot, 24/7 scheduled task execution, persistent message processing

### 5.3 Deployment Flow

```
Linux Laptop (dev) → git push → GitHub (prillcode/clawdock) → git pull on homelabvm → npm run build → systemd restart
```

The VM maintains:
- Claude Code authentication (Max subscription or API key)
- Docker daemon for agent containers
- SQLite database for message persistence and task scheduling
- Discord bot token and WebSocket connection to Discord gateway
- Systemd service for auto-restart and boot persistence

### 5.4 Tailscale Integration

- SSH into homelabvm for log inspection, service management, and config changes
- No public port exposure needed — Discord bot connection is outbound WebSocket
- Development machine and production VM communicate over the tailnet for ad-hoc management

## 6. Claude Max Subscription Strategy

Clawdock will initially authenticate via Claude Max subscription credentials. Usage considerations:

- All agent invocations (message responses, scheduled tasks, swarm agents) consume Max usage allocation
- Usage is shared across Claude web/desktop/mobile and Claude Code — ClawDock's container executions count against the same pool
- Usage limits reset every five hours
- If ClawDock usage begins competing with interactive Claude Code work (e.g., day-job development tasks), consider switching to API key billing (`ANTHROPIC_API_KEY`) for the ClawDock deployment specifically
- The VM deployment can be configured independently — Max credentials for interactive work on the laptop, API key for the always-on bot on homelabvm

## 7. Upstream Relationship

Clawdock is forked from `qwibitai/nanoclaw` with the upstream remote configured for pulling bug fixes and security patches:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream
git merge upstream/main
```

The Discord integration will be developed as a Claude Code skill (`.claude/skills/add-discord/SKILL.md`) so it can potentially be contributed back to the upstream repo as a PR. NanoClaw's README lists `/add-discord` as a "Request for Skills," so this contribution would be welcomed. The upstream PR would contain only the SKILL.md file, not the transformed source code — consistent with NanoClaw's "skills over features" philosophy.

## 8. Implementation Phases

### Phase 1: Discord Integration
- Create `.claude/skills/add-discord/SKILL.md`
- Run the skill via Claude Code to transform the codebase
- Replace Baileys (WhatsApp) with discord.js
- Adapt message storage schema for Discord channel/thread IDs
- Update IPC message routing for Discord's API
- Test locally on Linux laptop

### Phase 2: Homelab Deployment
- Set up systemd service on homelabvm
- Configure Docker runtime on the VM
- Authenticate Claude Code (Max or API key)
- Deploy and verify Discord bot connectivity
- Validate scheduled task execution

### Phase 3: Channel Configuration
- Create Discord server with #main, #family, #consulting, #dayjob channels
- Write per-channel `CLAUDE.md` memory files with appropriate context
- Configure mount allowlists for each channel's filesystem access
- Set up initial scheduled tasks per channel

### Phase 4: MCP Integrations (Future)
- Google Calendar integration for #family
- Potential project management tool integration for #consulting
- Evaluate additional MCP servers based on usage patterns

---

*This document captures the architectural decisions discussed on February 13, 2026. It is intended as a reference for implementation, not a final specification — details will evolve as the Discord integration is built and tested.*
