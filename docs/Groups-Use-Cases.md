# ClawDock Groups & Channels

## Architecture Overview

Each Discord channel (or WhatsApp group) that ClawDock monitors is a **group**. Each group gets:

- **Isolated container** — a sandboxed Linux environment where the agent runs
- **Isolated filesystem** — `groups/{folder}/` with its own files, notes, and conversation history
- **Isolated memory** — what ClawDock learns in one channel stays in that channel
- **Isolated sessions** — conversation context persists per-channel across restarts

Groups **cannot** see each other's files or memory. The only exception is the `main` group, which has admin access to the entire project and all group folders.

## Memory Model

ClawDock has three layers of memory, from most ephemeral to most persistent:

### 1. Session Memory (automatic, temporary)

Claude maintains a conversation session per channel. Within a session, it remembers the full conversation thread without needing to re-read files. Sessions are stored in SQLite and persist across restarts, but eventually expire or get rotated.

### 2. File-Based Memory (explicit, persistent)

When ClawDock learns something important, it writes files to `/workspace/group/` inside its container (which maps to `groups/{folder}/` on the host). Examples:

- `groups/family/family-members.md` — names, birthdays, preferences
- `groups/devwork/project-context.md` — tech stacks, conventions, repos
- `groups/gamedev/game-design.md` — mechanics, engine choices, progress

The agent is instructed (via CLAUDE.md) to proactively create and update these files when asked to "remember" something, or when it learns important information during conversation.

### 3. Conversation History (automatic, persistent, searchable)

Every conversation is automatically saved to `groups/{folder}/conversations/`. The agent can search these to recall context from previous sessions — even after the session itself has expired.

## CLAUDE.md System

Each group has a `CLAUDE.md` file that defines the agent's personality, behavior, and knowledge for that channel. There are two layers:

### Global CLAUDE.md (`groups/global/CLAUDE.md`)

- Injected into the **system prompt** (high-priority instructions)
- Defines base personality, capabilities, communication rules
- Read-only for non-main groups
- Shared across all channels

### Group CLAUDE.md (`groups/{folder}/CLAUDE.md`)

- Loaded as **project memory** by Claude Code natively
- Channel-specific personality, tone, focus areas
- Memory instructions specific to what this channel should track
- Read-write for the agent — it can update its own CLAUDE.md

The agent sees both: global provides the baseline, group provides the customization.

## Channel Configuration

Channels are configured via the `DISCORD_CHANNELS` env var:

```
DISCORD_CHANNELS=id:name:folder[:noTrigger],...
```

- `noTrigger` — agent processes all messages (used for #main)
- Without `noTrigger` — agent only responds when `@AssistantName` is mentioned

---

## Channel Descriptions

### #main (folder: `main`)

**Purpose**: Admin/personal command center

**Trigger**: None — all messages processed automatically

**Capabilities**:

- Full project filesystem access (can modify ClawDock itself)
- Manage other groups (register/unregister channels)
- Schedule tasks for any channel
- View and query the message database
- Access all group folders (read/write)

**Use Cases**:

- Administrative commands ("list all groups", "schedule a daily summary in #family")
- Direct personal conversations without needing to @mention
- Debugging and monitoring ClawDock itself
- Cross-channel operations ("what did we discuss in #devwork yesterday?")

**Memory Focus**:

- Admin preferences and global settings
- Cross-channel context and coordination notes

---

### #family (folder: `family`)

**Purpose**: Family-oriented conversations and planning

**Trigger**: `@AssistantName` required

**Use Cases**:

- Family scheduling — "when is the next school holiday?"
- Meal planning — "suggest dinners for the week"
- Trip planning — "plan a weekend trip to the mountains"
- General knowledge — kids asking questions
- Gift ideas, activity suggestions, recommendations
- Remembering family preferences and important dates
- Homework help (age-appropriate explanations)

**Memory Focus**:

- Family member names, ages, preferences
- Birthdays, anniversaries, important dates
- Dietary restrictions, allergies
- Favorite activities, restaurants, places
- School schedules, recurring events
- Past trip notes and recommendations

**Tone**: Casual, warm, family-friendly. Avoids overly technical language unless asked.

---

### #devwork (folder: `devwork`)

**Purpose**: Professional software development

**Trigger**: `@AssistantName` required

**Use Cases**:

- Code review and debugging help
- Architecture and design discussions
- API research and documentation lookup
- Writing scripts, configs, and boilerplate
- Tech stack decisions and trade-offs
- Performance analysis and optimization
- DevOps and deployment questions
- Web browsing for documentation and Stack Overflow

**Memory Focus**:

- Active projects and their tech stacks
- Coding conventions and style preferences
- Common patterns and solutions used
- Infrastructure details (servers, services, domains)
- Client/employer context (what you're working on and for whom)
- Recurring issues and their solutions

**Tone**: Professional, technical, concise. Code-first when relevant.

---

### #gamedev (folder: `gamedev`)

**Purpose**: Game development projects and discussions

**Trigger**: `@AssistantName` required

**Use Cases**:

- Game engine help (Unity, Unreal, Godot, custom)
- Game design brainstorming — mechanics, systems, balance
- Shader and graphics programming
- Multiplayer/networking architecture
- Asset pipeline and tooling
- Performance profiling for games
- Game math (physics, procedural generation, AI)
- Playtesting feedback and iteration
- Web browsing for game dev resources and tutorials

**Memory Focus**:

- Current game projects and their status
- Engine and framework choices
- Game design documents and core mechanics
- Art style and asset specifications
- Target platforms and performance budgets
- Playtest notes and feedback
- References and inspiration (other games, art, music)

**Tone**: Enthusiastic, knowledgeable. Technical when discussing code and systems, creative when discussing design.

---

## Adding a New Channel

1. Create the Discord channel
2. Ensure the bot has View Channel + Send Messages permissions
3. Get the channel's snowflake ID (right-click > Copy Channel ID with Developer Mode on)
4. Add to `DISCORD_CHANNELS` in `.env`:
   ```
   DISCORD_CHANNELS=...,NEW_ID:ChannelName:folder-name
   ```
5. Create `groups/folder-name/CLAUDE.md` with channel-specific instructions
6. Restart ClawDock — the channel will auto-register

## Cross-Channel Communication

Channels are isolated by design, but the **#main** channel can:

- Read any group's files and conversation history
- Schedule tasks that run in another channel's context
- Send messages to any registered channel
- Register or unregister channels

This makes #main the central hub for cross-channel coordination without breaking the isolation of individual channels.
