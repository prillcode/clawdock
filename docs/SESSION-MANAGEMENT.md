# Session Management

ClawDock automatically monitors conversation context and helps you manage long chat sessions to keep responses fast and costs under control.

## Overview

Each Discord channel maintains its own **chat session** with the Claude Agent SDK. As conversations grow longer, they consume more of the model's context window, which can:

- Slow down responses (more context to process)
- Increase costs (more tokens processed per query)
- Eventually hit context limits

ClawDock's session management feature automatically warns you when conversations get long and makes it easy to start fresh.

---

## How It Works

### Automatic Context Monitoring

ClawDock tracks the approximate token count of your conversation in real-time:

- **Token estimation**: ~1 token per 4 characters (rough approximation)
- **Model-aware**: Respects different context windows (200K tokens for opus/sonnet/haiku)
- **Per-channel**: Each channel's context is tracked independently

### Automatic Warnings

When a conversation reaches **80% of the context window**, Willis automatically sends a warning with two options:

```
⚠️ This chat session is getting long (142,000 tokens, 80% of context window).

Start a new session anytime by telling Willis:
• "Start a new session with context summary of current session" (recommended - preserves continuity)
• "Start a new session completely fresh" (best for new work)
```

### Automatic Reset at 100%

If you don't manually reset and the conversation reaches **100% of the context window**, Willis will:

1. Automatically generate a summary of the current session
2. Save it to `session-summary.md`
3. Archive the full conversation
4. Start a new session with the summary available
5. Notify you that the reset occurred

```
🔄 Automatic Session Reset

This chat session reached 100% of the context window. I've automatically started a new session with a summary of our previous discussion saved to session-summary.md.
```

**Thresholds are configurable** - see [Configuration](#configuration) below.

---

## Starting a New Chat Session

### Two Options

**Option 1: With Context Summary (Recommended)**

Preserves continuity by summarizing the current session:

```
start a new session with context summary of current session
```

Willis will:

- Generate a concise summary (accomplishments, current state, next steps)
- Save to `session-summary.md`
- Archive the full conversation
- Reset context
- The summary remains available in the new session

**Option 2: Completely Fresh**

Clean slate with no context carried over:

```
start a new session completely fresh
```

Willis will:

- Archive the full conversation
- Clear `session-summary.md` (if it exists)
- Reset context completely
- Ready for entirely new work

### Short Variations

These also work:

```
new session with summary
new session fresh
reset with summary
reset completely
```

⚠️ This chat session is getting long (142,000 tokens, 80% of context window).
Consider starting a new chat session to keep responses fast and reduce costs.

To start fresh, say: "start a new chat session"

```

**Threshold is configurable** - see [Configuration](#configuration) below.

---

## Starting a New Chat Session

### From Any Channel

Simply say:

```

start a new chat session

```

Or variations like:

```

let's start a new chat session
can we start a new chat session?
new chat session

```

Willis will respond with:

```

✅ Started a new chat session. Previous session archived.

You can find the old conversation in:
/workspace/group/conversations/archive/session-2026-02-15-18-30/

Long-term memory (CLAUDE.md and saved files) has been preserved.

```

### What Happens

1. **Current session archived**
   - Session state saved to `groups/{channel}/conversations/archive/session-{timestamp}/`
   - Timestamp format: `session-2026-02-15-18-30` (year-month-day-hour-minute)

2. **Agent SDK session cleared**
   - Database session record deleted
   - Container session state removed

3. **Context reset**
   - Next message starts with fresh, empty context
   - Fast responses resume

4. **Long-term memory preserved**
   - `CLAUDE.md` (channel memory) remains intact
   - Saved files and notes preserved
   - Only the conversation context is cleared

---

## When to Use

### Good Times to Start a New Session

✅ **After completing a major task**

```

You: Thanks for helping me build that Roblox inventory system!
Willis: You're welcome! The system is complete.
You: start a new chat session

```

✅ **When switching topics**

```

You: [after long discussion about game mechanics]
You: Now I want to work on AWS infrastructure instead
You: start a new chat session

```

✅ **After receiving the 80% warning**

```

Willis: ⚠️ This chat session is getting long...
You: start a new chat session

```

✅ **When responses feel slow**

```

You: Willis seems slower than usual
You: start a new chat session

```

### When NOT to Start a New Session

❌ **In the middle of a task**

```

Willis: I've created the first part of the DataStore module...
You: [Don't reset here - Willis needs context to continue]

```

❌ **When referencing recent conversation**

```

You: What was that AWS command you mentioned earlier?
[If you reset, Willis won't remember]

````

---

## Configuration

### Change Warning Threshold

Add to your `.env` file:

```bash
# Warn at 90% instead of 80%
SESSION_WARNING_THRESHOLD=0.9

# Warn at 70% (more conservative)
SESSION_WARNING_THRESHOLD=0.7

# Warn at 95% (less frequent)
SESSION_WARNING_THRESHOLD=0.95
````

### Disable Warnings

Set threshold to 1.0 to disable automatic warnings:

```bash
# Never warn (you can still manually reset)
SESSION_WARNING_THRESHOLD=1.0
```

After changing `.env`, restart the service:

```bash
systemctl --user restart clawdock
```

---

## Accessing Archived Sessions

### Location

Archived sessions are stored in:

```
groups/{channel}/conversations/archive/session-{timestamp}/
```

**Example:**

```
groups/gamedev/conversations/archive/session-2026-02-15-18-30/
groups/devwork/conversations/archive/session-2026-02-14-09-15/
```

### Viewing Archives

**From the host machine:**

```bash
ls -la ~/dev/clawdock/groups/gamedev/conversations/archive/
```

**From a channel:**

```
list the archived sessions in this channel
```

**Referencing old sessions:**

```
can you check what we discussed about Roblox inventory in the archived session from yesterday?
```

Willis can read archived sessions since they're in the workspace mount.

---

## Technical Details

### Token Estimation

ClawDock uses a rough approximation for token counting:

```
estimatedTokens = totalCharacters / 4
```

This is intentionally conservative (tends to overestimate) to warn early rather than late.

**Why rough estimation?**

- Exact token counting requires the model's tokenizer
- Would add significant overhead per message
- Rough estimation is fast and good enough for warnings

### Context Windows by Model

| Model  | Context Window |
| ------ | -------------- |
| opus   | 200,000 tokens |
| sonnet | 200,000 tokens |
| haiku  | 200,000 tokens |

**Note**: These are standard values. If you're using model overrides via Z.AI or another provider, the actual context window may differ.

### Session Storage

Sessions are stored in two places:

1. **Database** (`store/messages.db`)
   - `sessions` table maps `group_folder` → `session_id`

2. **Filesystem** (`data/sessions/{channel}/`)
   - Agent SDK session state (conversation history, tool outputs, etc.)

When you start a new chat session, **both** are cleared.

---

## Troubleshooting

### Warning Not Appearing

**Problem**: Long conversation but no warning shown.

**Solutions:**

1. Check threshold setting in `.env`:

   ```bash
   grep SESSION_WARNING_THRESHOLD ~/.env
   ```

   If not set, default is 0.8 (80%). If set to 1.0, warnings are disabled.

2. Check if conversation is actually long enough:
   - 80% of 200K tokens = 160K tokens
   - ~160K tokens = ~640K characters
   - That's a VERY long conversation

3. Check logs for warnings:
   ```bash
   journalctl --user -u clawdock -n 100 | grep "context warning"
   ```

### Session Not Resetting

**Problem**: Said "start a new chat session" but context seems to persist.

**Solutions:**

1. Check if command was recognized:

   ```bash
   journalctl --user -u clawdock -n 50 | grep "new_chat_session"
   ```

2. Verify session was cleared:

   ```bash
   ls ~/dev/clawdock/data/sessions/gamedev/
   # Should be empty or show new session ID
   ```

3. Check archive was created:
   ```bash
   ls ~/dev/clawdock/groups/gamedev/conversations/archive/
   # Should show session-{timestamp} directory
   ```

### Archive Missing

**Problem**: Started new session but can't find the archive.

**Cause**: Session might have been empty (no conversation to archive).

**Solution**: Archives are only created if there was an active session. If you reset immediately after starting, there's nothing to archive.

---

## Best Practices

### 1. Reset After Major Milestones

```
✅ Built feature → reset → start next feature
❌ Reset mid-implementation
```

### 2. Use Channel Memory for Important Info

Before resetting, ask Willis to save important context:

```
You: Remember that we're using DataStore2 for persistence
Willis: I've noted that in CLAUDE.md
You: start a new chat session
```

CLAUDE.md persists across resets, so the info is retained.

### 3. Don't Reset Too Frequently

**Why?** Recent context helps Willis:

- Remember what you just discussed
- Avoid repeating questions
- Maintain continuity

**Rule of thumb**: Only reset when you see the warning or when switching major topics.

### 4. Archive Review Strategy

Periodically review old archives:

```
what are the key decisions we made in yesterday's session about the game inventory?
```

Willis can read archives and extract useful information.

---

## Example Workflow

### Game Development Session

```
[Long conversation about game mechanics]
Willis: ⚠️ This chat session is getting long (165,000 tokens, 82% of context window)...
You: Thanks for all the help on the combat system! Can you save a summary to CLAUDE.md?
Willis: I've added a combat system summary to CLAUDE.md.
You: start a new chat session
Willis: ✅ Started a new chat session. Previous session archived.

You: Now let's work on the inventory UI
Willis: [Fresh context - fast response]
```

### Development Session

```
[Working on AWS infrastructure]
You: This conversation is getting long, let's reset
You: start a new chat session
Willis: ✅ Started a new chat session...

You: What AWS services did we discuss earlier?
Willis: I can check the archived session...
[Willis reads the archive and summarizes]
```

---

## FAQ

**Q: Will I lose my conversation history?**
A: No, it's archived. You can reference it later.

**Q: Will Willis forget everything?**
A: No, CLAUDE.md and saved files persist. Only the conversation context is cleared.

**Q: How do I know when to reset?**
A: Willis will warn you at 80%. Or reset anytime you switch topics.

**Q: Can I lower the warning threshold?**
A: Yes, set `SESSION_WARNING_THRESHOLD=0.7` (or any value 0.0-1.0) in `.env`.

**Q: Does this work in all channels?**
A: Yes, every channel has independent session tracking.

**Q: What if I reset by accident?**
A: The archive is still there. Ask Willis to check the most recent archived session.

**Q: Can I delete old archives?**
A: Yes, they're just files. Delete manually from `groups/{channel}/conversations/archive/`.

---

## See Also

- [Container Images](CONTAINER-IMAGES.md) - Image selection and management
- [Groups and Channels](Groups-Use-Cases.md) - Channel configurations
- [Project Status](PROJECT-STATUS.md) - Current deployment details
