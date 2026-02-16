# Session Management

> **Note**: Session management is being reworked. See [SMART-SESSION-MANAGEMENT-PLAN.md](SMART-SESSION-MANAGEMENT-PLAN.md) for the full plan. This document describes the current working behavior.

---

## Overview

Each Discord channel maintains its own chat session with the Claude Agent SDK. As conversations grow, they consume more of the model's context window. ClawDock monitors this and warns you when it's time to start fresh.

## How Sessions Work

### Within a Container Run

When you send a message, ClawDock spawns a Docker container running the Claude Agent SDK. Follow-up messages are piped into the same running container via IPC, so the agent processes them as additional turns without any overhead. The container stays alive until an idle timeout (default: 30 minutes) with no new messages.

### Across Container Runs

When a container is killed (idle timeout, service restart, etc.) and you send a new message, a new container starts and resumes the previous session using the SDK's `resume` option. This replays the conversation history from disk, which gets slower as the session grows.

### Session Storage

Sessions are stored in two places:

1. **Database** (`store/messages.db`) -- Maps `group_folder` to `session_id`
2. **Filesystem** (`data/sessions/{channel}/.claude/`) -- SDK transcript files and project state

Both are cleared when you start a new session.

---

## Automatic Warnings

When a conversation reaches approximately **80% of the context window** (~160K tokens), Willis sends a warning:

```
This chat session is getting long (~160,000 tokens, 80% of context window).

Start a new session anytime:
- "Start a new session with summary" (preserves continuity)
- "Start a new session fresh" (clean slate)
```

## Starting a New Session

### With Summary (Recommended)

Preserves continuity by having Willis summarize the current session:

```
start a new session with summary
```

Willis will generate a summary, save it to `session-summary.md`, archive the conversation, and reset.

### Completely Fresh

Clean slate with no context carried over:

```
start a new session fresh
```

Archives the conversation, clears `session-summary.md`, and resets.

### What's Preserved

- `CLAUDE.md` (long-term memory)
- Saved files and notes in the group directory
- Archived conversations in `groups/{channel}/conversations/archive/`

### What's Cleared

- Conversation context (the SDK session)
- Session transcript files

---

## Configuration

In `.env`:

```bash
# Warning threshold (default: 0.8 = 80%)
SESSION_WARNING_THRESHOLD=0.8

# Idle timeout before container is closed (default: 1800000 = 30 min)
IDLE_TIMEOUT=1800000

# Max concurrent containers (default: 5)
MAX_CONCURRENT_CONTAINERS=5
```

Restart after changes: `systemctl --user restart clawdock`

---

## Troubleshooting

### Willis seems slow to respond

The session might be large. Start a new session:

```
start a new session with summary
```

### Willis not responding at all

Check for orphan containers and restart:

```bash
systemctl --user stop clawdock
docker ps --filter 'name=nanoclaw-'  # check for orphans
systemctl --user start clawdock
```

### Manually clearing all sessions

Nuclear option -- clears all session state:

```bash
systemctl --user stop clawdock
sqlite3 ~/dev/clawdock/store/messages.db "DELETE FROM sessions;"
rm -rf ~/dev/clawdock/data/sessions/*/
systemctl --user start clawdock
```

---

## See Also

- [SMART-SESSION-MANAGEMENT-PLAN.md](SMART-SESSION-MANAGEMENT-PLAN.md) -- Planned improvements (incremental token tracking, auto-summary at 90%, resume guard)
- [CONTAINER-IMAGES.md](CONTAINER-IMAGES.md) -- Container image selection
