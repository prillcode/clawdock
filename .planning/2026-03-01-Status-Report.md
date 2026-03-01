# Clawdock Status Report — March 1, 2026

## What Was Accomplished

### 1. Upstream Merge — NanoClaw 1.1.3

Merged 100 upstream commits from `qwibitai/nanoclaw`. Key changes:

**Security**
- Block path escapes in container-runner, db, ipc, task-scheduler
- Mount project root read-only to prevent container escape
- Block symlink escapes in skills file ops
- Sanitize env vars from agent Bash subprocesses (PreToolUse hook)

**Infrastructure**
- `src/container-runtime.ts` — Docker abstraction layer
- `src/group-folder.ts` — validated group folder paths
- `src/env.ts` — safe `.env` parsing without leaking to child processes
- Per-group writable `agent-runner-src` directory
- Container now runs as host user (uid/gid passthrough)
- Host timezone (`TZ`) passed into containers
- `assistantName` passed to agent (replaces hardcoded 'Andy')

**New subsystems**
- `skills-engine/` (v0.1) — deterministic skill application system with full test suite
- `setup/` — Node.js setup modules replacing bash scripts

**New upstream skills**
- `/add-slack`, `/add-gmail`, `/update`, `/convert-to-apple-container`
- `/qodo-pr-resolver`, `/get-qodo-rules`

**Bug fixes**
- Typing indicator now shows on every message
- Send available presence on connect (WhatsApp typing indicators)
- Filter empty messages from polling queries
- `TRIGGER_PATTERN` now requires `^` anchor
- Pause malformed scheduled tasks

**Clawdock-specific preserved**
- Discord channel as primary channel
- Multi-image container support (`base` / `devtools`)
- Smart Session Management (phases 1–3)
- Z.AI provider override (ANTHROPIC_BASE_URL)
- Per-channel model/budget/turns overrides
- `add-clawdock-discord` skill kept separate from upstream `add-discord`

### 2. End-to-End Test — Verified Working

Confirmed Willis is responding correctly on Discord:

- **#Main** — `sonnet` model, no trigger required (`noTrigger` flag), responding
- **#Family** — `haiku` model override confirmed active, responding
- Container spawning correctly as `clawdock-agent:base` with 6 mounts
- Z.AI provider override routing active
- All 4 channels registered: Main, Family, Devwork, Gamedev

**One gap noted:** `GH_TOKEN` is empty — GitHub CLI will not work inside `devwork`/`gamedev` containers.

---

## Next Feature: Discord Attachment Support

### Problem

The Discord channel (`src/channels/discord.ts`) currently only captures `message.content` (text). When a user attaches an image or file to a Discord message, it is silently ignored — the agent never sees it.

### What Needs to Be Built

**1. Capture attachments in `handleMessage`**

`message.attachments` is a Discord.js `Collection<string, Attachment>`. Each attachment has:
- `url` — CDN URL to download the file
- `name` — original filename
- `contentType` — MIME type (e.g. `image/png`, `application/pdf`)
- `size` — bytes

**2. Download and stage files**

Download attachments from Discord CDN and write them to a temp location accessible inside the container (e.g. a per-message subdirectory in the group's IPC or scratch folder).

**3. Pass attachment paths to the agent**

The `content` string passed to the agent should reference the staged file paths so the agent can read them via its container filesystem mount. Options:
- Append a structured block to the message content: `[Attachment: /mnt/scratch/msg-123/photo.png (image/png)]`
- Or extend the `Message` type to carry an `attachments` array and handle it in `container-runner.ts`

**4. Cleanup**

Delete staged files after the container exits.

### Scope Notes

- Images are the primary use case (share a screenshot, ask Willis about it)
- PDF and text files are also useful (share a doc for summarization)
- No need to handle audio/video initially
- The container already has read access to mounted directories — the main work is download + staging + message annotation
