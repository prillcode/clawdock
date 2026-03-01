# Clawdock Architecture

Clawdock is a personal AI assistant built on the [NanoClaw](https://github.com/qwibitai/nanoclaw) fork. It replaces WhatsApp with Discord as the messaging layer and targets Docker on Linux rather than Apple Container on macOS. A single Node.js host process connects to Discord, persists messages to SQLite, and dispatches Claude Code agents into isolated Docker containers — one container per group, per invocation.

**Key pipeline:**
```
Discord (discord.js) → SQLite → Polling Loop → Docker Container (Claude Agent SDK) → IPC → Discord Response
```

---

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator: startup, channel init, message loop, session management |
| `src/config.ts` | Env var loading, channel config parsing, all constants |
| `src/env.ts` | Reads `.env` from disk without leaking secrets into `process.env` |
| `src/types.ts` | Shared TypeScript types: `Channel`, `NewMessage`, `RegisteredGroup`, `ContainerConfig`, `ScheduledTask` |
| `src/db.ts` | All SQLite operations: messages, sessions, tasks, registered groups, router state |
| `src/container-runner.ts` | Spawns Docker containers, builds volume mounts, streams agent output via markers |
| `src/container-runtime.ts` | Docker abstraction: `stopContainer()`, `cleanupOrphans()`, `ensureContainerRuntimeRunning()` |
| `src/group-queue.ts` | Per-group task/message queue with global concurrency cap (`GroupQueue` class) |
| `src/group-folder.ts` | Validates and resolves group folder paths, blocks path traversal |
| `src/ipc.ts` | Host-side IPC watcher: polls for agent output files, routes messages and task mutations |
| `src/task-scheduler.ts` | Cron/interval/once scheduled task executor |
| `src/router.ts` | Formats outbound messages, routes to correct channel by JID |
| `src/session-manager.ts` | Token estimation, context threshold checks, auto-reset logic |
| `src/mount-security.ts` | Validates additional mounts against `~/.config/nanoclaw/mount-allowlist.json` |
| `src/logger.ts` | Pino logger wrapper |
| `src/channels/discord.ts` | Discord channel: connect, receive, send, typing indicator |
| `src/channels/whatsapp.ts` | WhatsApp channel (inactive in Clawdock, preserved from upstream) |

---

## Channel System

Channels implement the `Channel` interface (`src/types.ts`). At runtime, only channels with credentials configured in `.env` are instantiated. Clawdock uses Discord exclusively.

### Discord Channel (`src/channels/discord.ts`)

- Uses discord.js with `Guilds`, `GuildMessages`, `MessageContent` intents
- On `MessageCreate`, filters bot messages and DMs, then calls `onMessage(channelId, msg)`
- Discord channel IDs (snowflakes, all digits) are used as JIDs — collision-free with WhatsApp JIDs which always contain `@`
- Bot `<@mention>` tags are rewritten to `@{ASSISTANT_NAME}` so the trigger pattern matches
- Typing indicator: refreshes every 9s (Discord expires at 10s); started/stopped per message
- Long messages split at newline boundaries to respect Discord's 2000-char limit
- **Attachment support: not yet implemented** — `message.attachments` is not captured; files sent to Discord channels are silently ignored

### Channel Registration

Channels are auto-registered at startup via `DISCORD_CHANNELS` env var. Each entry maps a Discord channel ID to a Clawdock group folder. The `main` group (`clawdock-admin` folder) has elevated privileges. At runtime, channels are also stored in the `registered_groups` DB table.

---

## Container System

### Images

Two Docker images, built by `./container/build.sh`:

| Image | Contents | Size | Use |
|-------|----------|------|-----|
| `clawdock-agent:base` | Node 22, Chromium, git, gh CLI, agent-browser MCP | ~1.2 GB | Family, general channels |
| `clawdock-agent:devtools` | Extends base + AWS CLI, Docker CLI | ~1.5 GB | Devwork, admin channels |

Image selection per channel: 5th segment of `DISCORD_CHANNELS` entry (`:base` or `:devtools`). Default: `base`.

### Spawning (`src/container-runner.ts`)

1. Container named `nanoclaw-{groupFolder}-{timestamp}`, started with `--rm` (auto-cleanup on exit)
2. Runs as host user (uid/gid passthrough) — no root in container
3. Host timezone (`TZ`) passed in
4. `ContainerInput` JSON written to stdin, then stdin closed
5. Stdout parsed for `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers — output streamed incrementally, not batched on exit
6. Each parsed output calls `onOutput(containerOutput)` → host routes response to Discord
7. Container timeout: hard kill after `CONTAINER_TIMEOUT` ms (default 30m); resets on streaming activity
8. On timeout, logs written to `groups/{folder}/logs/container-{timestamp}.log`

### Volume Mounts

| Host path | Container path | Access |
|-----------|---------------|--------|
| `groups/{folder}/` | `/workspace/group` | Read-write |
| `groups/global/` | `/workspace/global` | Read-only (non-main) |
| Project root | `/workspace/project` | Read-only (main only) |
| `data/ipc/{folder}/` | `/workspace/ipc` | Read-write |
| Per-group `.claude/` | `/home/node/.claude` | Read-write (Claude Code settings) |
| Filtered env secrets | `/workspace/env-dir` | Read-only |
| Per-group agent runner src | `/app/src` | Read-write (per-group customization) |
| Additional mounts | `/workspace/extra/{name}` | Validated against allowlist |

Secrets are never placed in `process.env` — they're read from disk and written to a temp mount that the container reads directly.

---

## Group Queue & Concurrency (`src/group-queue.ts`)

`GroupQueue` enforces two levels of concurrency:

1. **Per-group:** Only one container per group at a time. If a container is already active for `#family` and a second message arrives, it sets `pendingMessages = true` on the group state. The message is delivered to the **same running container** via IPC if it's idle-waiting, or processed after the current container finishes.

2. **Global:** `MAX_CONCURRENT_CONTAINERS` (default 5, set in `.env`) caps total simultaneous containers across all groups. Groups blocked by the global cap are added to `waitingGroups[]` and drained in FIFO order as slots free up.

**Effect:** `MAX_CONCURRENT_CONTAINERS=3` means at most 3 different Discord channels can have active containers simultaneously. Multiple users messaging the same channel share one container sequentially — they do not each spawn their own.

**Drain priority:** After a container finishes — pending tasks run before pending messages. Task queue drains before global waiting groups.

**Retry:** On container failure, exponential backoff (5s → 10s → 20s → 40s → 80s, max 5 retries).

**Shutdown:** Non-destructive. Running containers are detached, not killed. They finish and self-clean via `--rm`.

---

## IPC Mechanism (`src/ipc.ts`)

Agents do not call the host directly. They write JSON files to `/workspace/ipc/` subdirectories; the host polls and processes them.

| IPC directory | Action |
|---------------|--------|
| `ipc/{folder}/messages/` | Send message to a Discord channel |
| `ipc/{folder}/tasks/` | Create, pause, resume, or cancel a scheduled task |

Poll interval: 1000ms (`IPC_POLL_INTERVAL`).

**Authorization:** Source group identity is derived from the IPC directory path — not from the file contents. This is tamper-proof from the container's perspective.

| Operation | Who can do it |
|-----------|--------------|
| Send message to own JID | Any group |
| Send message to other JID | Main group only |
| `register_group` | Main group only |
| `update_channel` | Main group only |
| `refresh_groups` | Main group only |
| `schedule_task` for own JID | Any group |
| `schedule_task` for other JID | Main group only |
| `new_chat_session_*` | Any group (for itself) |

---

## Database Schema (`src/db.ts`)

SQLite, stored at `data/nanoclaw.db`.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `chats` | Chat/channel metadata | `jid`, `name`, `channel`, `last_message_time` |
| `messages` | Full message history | `id`, `chat_jid`, `sender_name`, `content`, `timestamp`, `is_from_me`, `is_bot_message` |
| `scheduled_tasks` | Task definitions | `id`, `group_folder`, `chat_jid`, `prompt`, `schedule_type` (cron/interval/once), `schedule_value`, `context_mode`, `next_run`, `status` |
| `task_run_logs` | Execution history | `task_id`, `run_at`, `duration_ms`, `status`, `result`, `error` |
| `sessions` | Claude Code session tracking | `group_folder`, `session_id`, `estimated_tokens`, `message_count`, `last_summary` |
| `registered_groups` | Active groups/channels | `jid`, `name`, `folder`, `container_config` (JSON), `requires_trigger` |
| `router_state` | Polling cursors | `key` → `last_timestamp`, `last_agent_timestamp` |

---

## Configuration

All configuration via `.env` (loaded by systemd `EnvironmentFile` on production).

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCORD_BOT_TOKEN` | — | Discord bot credentials (required) |
| `DISCORD_CHANNELS` | — | `id:name:folder[:noTrigger][:image]` comma-separated |
| `ASSISTANT_NAME` | `Andy` | Trigger word: `@{name}` |
| `ANTHROPIC_BASE_URL` | — | Provider override URL (Z.AI, OpenRouter, etc.) |
| `ANTHROPIC_AUTH_TOKEN` | — | Auth token for provider override |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude Max subscription token (alternative to provider override) |
| `AGENT_MODEL` | SDK default | Default model: `opus`, `sonnet`, `haiku`, or full model ID |
| `AGENT_MAX_BUDGET_USD` | — | Max spend per query in USD |
| `AGENT_MAX_TURNS` | — | Max conversation turns per query |
| `AGENT_CHANNEL_MODELS` | — | Per-channel overrides: `folder:model,folder:model` |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Global container concurrency cap |
| `CONTAINER_TIMEOUT` | `1800000` | Hard container kill timeout (ms) |
| `CONTAINER_IMAGE` | `clawdock-agent:base` | Default image if not set per-channel |
| `IDLE_TIMEOUT` | `1800000` | Container idle-wait timeout (ms) |
| `POLL_INTERVAL` | `2000` | Message loop frequency (ms) |
| `IPC_POLL_INTERVAL` | `1000` | IPC watcher frequency (ms) |
| `SCHEDULER_POLL_INTERVAL` | `60000` | Task scheduler frequency (ms) |
| `SESSION_WARNING_THRESHOLD` | `0.8` | Warn user at this fraction of context window |
| `SESSION_AUTO_RESET_THRESHOLD` | `0.9` | Auto-reset session at this fraction |
| `SESSION_MAX_RESUME_TOKENS` | `100000` | Skip session resume if above this token count |
| `GH_TOKEN` | — | GitHub CLI token for agent containers |
| `LOG_LEVEL` | `info` | Pino log level |
| `TZ` | System | Timezone passed to containers for cron scheduling |

**Discord channel format:**
```
DISCORD_CHANNELS=1234567890:Main:main:noTrigger,0987654321:Family:family,1122334455:Devwork:devwork::devtools
#                ^channel-id ^name ^folder ^no-trigger-flag  ^image-tag (optional)
```

---

## Groups Directory Structure

```
groups/
├── global/                    # Shared read-only memory, mounted into all non-main groups
│   └── (shared files)
├── clawdock-admin/            # Main/admin group — has full /workspace/project access
│   ├── CLAUDE.md              # Group memory and instructions (agent system prompt)
│   ├── logs/
│   │   └── container-*.log   # Written on container timeout
│   └── conversations/
│       ├── archive/           # Previous sessions (auto-archived on reset)
│       └── (current session)
├── family/
│   ├── CLAUDE.md
│   ├── logs/
│   └── conversations/
└── devwork/
    ├── CLAUDE.md
    ├── logs/
    └── conversations/
```

`CLAUDE.md` is the agent's persistent memory and system prompt for that group. It persists across container restarts and sessions. Agents can append to it via file writes inside the container.

---

## Smart Session Management (`src/session-manager.ts`)

Claude Code sessions have a finite context window (~200k tokens). Clawdock tracks usage incrementally and manages resets automatically.

**Phase 1 — Token tracking:** After each agent response, `estimated_tokens` and `message_count` are updated in the `sessions` table. Token count is a rough estimate (1 token ≈ 4 chars), incremental only.

**Phase 2 — Summary injection:** On session reset, the outgoing session summary is stored in `sessions.last_summary` and `groups/{folder}/session-summary.md`. The next session receives the summary in `ContainerInput.sessionSummary` so the agent has continuity.

**Phase 3 — Auto-reset:** At `SESSION_WARNING_THRESHOLD` (80%), the user is warned. At `SESSION_AUTO_RESET_THRESHOLD` (90%), the host sends a `new_chat_session_with_summary` IPC request — the agent generates a summary, it's saved, and a fresh session begins.

If a session exceeds `SESSION_MAX_RESUME_TOKENS` (100k), the existing session ID is not resumed — a fresh session starts instead.

---

## Scheduled Tasks (`src/task-scheduler.ts`)

Tasks are stored in the `scheduled_tasks` DB table and polled every 60s.

| Schedule type | `schedule_value` | Recurrence |
|---------------|-----------------|------------|
| `cron` | Cron expression (e.g. `0 9 * * 1`) | Next occurrence via `cron-parser` |
| `interval` | Milliseconds (e.g. `86400000`) | Adds interval to current time |
| `once` | ISO timestamp | Runs once, marks `completed` |

**Context mode:**
- `isolated` (default) — fresh SDK session for each run
- `group` — reuse the group's active session if available

Scheduled task containers close 10s after output (not `IDLE_TIMEOUT`), preventing long idle waits for single-turn executions. Tasks can only send output to their own `chat_jid` unless created by the main group.

---

## Mount Security (`src/mount-security.ts`)

Additional filesystem mounts (beyond the standard set) are validated against `~/.config/nanoclaw/mount-allowlist.json` — stored **outside the project root** so containers cannot read or tamper with it.

**Allowlist structure:**
```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true }
  ],
  "blockedPatterns": [".ssh", ".gnupg", ".aws", ".env", "credentials", "id_rsa", ...],
  "nonMainReadOnly": true
}
```

Validation rules:
- Path must be under an allowed root
- Path must not match any blocked pattern
- Non-main groups are forced read-only if `nonMainReadOnly: true`
- Container paths must be relative (no `..`, no absolute paths)
- Resolved to `/workspace/extra/{name}` inside container

---

## Deployment (Hetzner VPS)

See [.planning/2026-03-01-Hetzner-VPS-Deployment.md](.planning/2026-03-01-Hetzner-VPS-Deployment.md) for the full migration guide.

**Production host:** Hetzner CPX31 (4 vCPU AMD, 8GB RAM) — Ashburn, VA
**Access:** SSH via Tailscale only. No inbound ports needed — Discord bot is outbound WebSocket.
**Process manager:** systemd user service (`~/.config/systemd/user/nanoclaw.service`)
**Isolation from Coolify:** Separate Docker networks, no shared ports, no interaction.

**Update flow:**
```bash
cd ~/clawdock && git pull && npm run build && systemctl --user restart nanoclaw
# If container/ changed:
./container/build.sh
```

**Key commands:**
```bash
systemctl --user start|stop|restart nanoclaw
journalctl --user -u nanoclaw -f
```
