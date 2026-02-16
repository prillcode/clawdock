# Smart Session Management Plan

**Status**: Planned
**Created**: 2026-02-15
**Context**: Session resume was replaying entire conversation history on every follow-up message, burning through `maxTurns` and causing Willis to hang. Two prerequisite fixes have been deployed. This plan addresses the remaining session lifecycle issues.

---

## Problem Summary

1. **Session resume replays history** -- When a new container starts with `resume: sessionId`, the Claude Agent SDK replays ALL historical messages from the transcript on disk. This gets progressively slower and can exhaust `maxTurns` before the new prompt is even processed.

2. **Context estimation re-fetches messages** -- After every agent response, `index.ts` calls `getMessagesSince(chatJid, '', ...)` to fetch up to 1000 messages from the DB, estimates tokens via `chars/4`, and checks thresholds. This is wasteful and inaccurate.

3. **No session lifecycle** -- Sessions grow forever. No automatic cleanup based on age, size, or transcript length. The `.claude/projects/` directory accumulates transcript data indefinitely.

4. **Auto-reset at 100% is incomplete** -- The code sends a notification at 100% but never actually generates a summary or triggers a real reset (marked as TODO in `index.ts:290`).

---

## Completed Prerequisites

### Fix 1: Limit context check to 1000 messages (`f8bf03d`)

- Capped `getMessagesSince()` results to last 1000 messages to prevent the full-table scan that was causing the original hang.
- Band-aid fix, replaced properly in Phase 1 below.

### Fix 2: Single long-lived query (`343afa4`)

- Replaced the query loop (which started a new `query()` call with `resume` for each follow-up message) with a single long-lived `query()` call.
- Follow-up messages are fed into the active query via `MessageStream` through IPC file polling.
- The SDK processes them as additional user turns in-memory -- no session replay needed for follow-ups within the same container run.

---

## Phase 1: Incremental Token Tracking

**Goal**: Track context usage incrementally instead of re-fetching messages after every response.

### Changes

#### `src/db.ts` -- Extend sessions table

Add columns to the `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN estimated_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN message_count INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN created_at TEXT;
ALTER TABLE sessions ADD COLUMN last_active TEXT;
ALTER TABLE sessions ADD COLUMN last_summary TEXT;
```

Add new functions:

| Function                                                      | Purpose                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `updateSessionMetrics(groupFolder, tokenDelta, messageDelta)` | Increment token/message counters after each agent response |
| `getSessionMetrics(groupFolder)`                              | Retrieve current token count, message count, timestamps    |
| `resetSessionMetrics(groupFolder)`                            | Zero out counters (called on session reset)                |

#### `src/index.ts` -- Replace message re-fetch with incremental tracking

**Remove** (lines 244-315): The entire `getMessagesSince(chatJid, '', ASSISTANT_NAME)` + `calculateSessionMetrics()` block.

**Replace with**:

```typescript
// After successful agent response
if (outputSentToUser && channel) {
  // Estimate tokens for the prompt + response (incremental)
  const promptTokens = estimateTokens(prompt);
  const responseTokens = estimateTokens(output.result || '');
  updateSessionMetrics(group.folder, promptTokens + responseTokens, 1);

  const metrics = getSessionMetrics(group.folder);
  const model = group.containerConfig?.model || AGENT_MODEL;
  const thresholds = checkSessionThresholds(metrics, model);

  if (thresholds.shouldAutoReset) {
    // Trigger auto-summary and reset (Phase 2)
  } else if (thresholds.shouldWarn) {
    // Send warning message
  }
}
```

#### `src/session-manager.ts` -- Update thresholds and add metrics-based check

- Change `AUTO_RESET_THRESHOLD` from `1.0` to `0.9` (90%)
- Keep `WARNING_THRESHOLD` at `0.8` (80%)
- Add `checkSessionThresholds(metrics, model)` that takes stored DB metrics instead of re-computing from messages
- Keep `estimateTokens(text)` for incremental estimation

---

## Phase 2: Auto-Summary and Reset at 90%

**Goal**: When context hits 90%, automatically generate a summary and reset the session with continuity.

### Changes

#### `src/index.ts` -- Auto-summary flow

When `shouldAutoReset` is true:

1. Send notification to user: "Session context at 90% -- generating summary and starting fresh session..."
2. Ask the current agent to generate a summary by sending a summary prompt via the active container's IPC input
3. Capture the summary from the agent's response
4. Trigger session reset via IPC (`new_chat_session_with_summary`)
5. Store the summary in the sessions DB (`last_summary` column)
6. Notify user: "New session started. Previous conversation summary preserved."

#### `src/types.ts` -- Add sessionSummary to ContainerInput

```typescript
interface ContainerInput {
  // ... existing fields
  sessionSummary?: string; // Summary from previous session to inject
}
```

#### `container/agent-runner/src/index.ts` -- Inject summary into first prompt

When `containerInput.sessionSummary` is present, prepend it to the first prompt:

```typescript
if (containerInput.sessionSummary) {
  prompt = `[Previous Session Summary]\n${containerInput.sessionSummary}\n\n---\n\n${prompt}`;
}
```

This ensures the agent has context from the previous session without needing to resume and replay history.

#### `src/ipc.ts` -- Store summary in DB during reset

When processing `new_chat_session_with_summary`:

- Store `sessionSummary` in the sessions table (`last_summary` column) so the next container spawn can retrieve and inject it.

#### `src/container-runner.ts` -- Pass summary to container

When building `ContainerInput`, check for a stored summary:

```typescript
const lastSummary = getSessionSummary(group.folder);
// Pass to container if available
input.sessionSummary = lastSummary || undefined;
```

---

## Phase 3: Resume Guard

**Goal**: Prevent slow container startups by skipping session resume when transcripts are too large.

### Changes

#### `src/index.ts` or `src/container-runner.ts` -- Check before resume

Before passing `sessionId` to the container:

1. Check stored `estimated_tokens` from the sessions DB
2. If above `SESSION_MAX_RESUME_TOKENS` threshold, clear the session and start fresh
3. Alternatively, check the `.claude/projects/` transcript file sizes on disk (>5MB = too large)

```typescript
const metrics = getSessionMetrics(group.folder);
if (metrics && metrics.estimated_tokens > SESSION_MAX_RESUME_TOKENS) {
  logger.info(
    { group: group.name, tokens: metrics.estimated_tokens },
    'Session too large to resume, starting fresh',
  );
  deleteSession(group.folder);
  sessionId = undefined;
  // Notify user on next response
}
```

#### `src/config.ts` -- New config values

```typescript
// Max tokens before skipping session resume (default: 100,000 = ~50% of context)
export const SESSION_MAX_RESUME_TOKENS = parseInt(
  process.env.SESSION_MAX_RESUME_TOKENS || '100000',
  10,
);

// Warning threshold (default: 0.8 = 80%)
export const SESSION_WARNING_THRESHOLD = parseFloat(
  process.env.SESSION_WARNING_THRESHOLD || '0.8',
);

// Auto-reset threshold (default: 0.9 = 90%)
export const SESSION_AUTO_RESET_THRESHOLD = parseFloat(
  process.env.SESSION_AUTO_RESET_THRESHOLD || '0.9',
);
```

#### Notification

When a session is skipped due to size:

> "Starting fresh session (previous session was too large to resume efficiently)."

---

## Phase 4: User-Initiated Session Control

**Goal**: Users can explicitly manage their sessions.

### Existing MCP Tools (already implemented)

| Tool                            | Trigger                          | Behavior                                                          |
| ------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `new_chat_session_with_summary` | "Start new session with summary" | Agent generates summary, archives session, resets with continuity |
| `new_chat_session_fresh`        | "Start fresh" / "New session"    | Archives session, clears summary, clean slate                     |

### Documentation

Update each group's `CLAUDE.md` to document session commands:

```markdown
## Session Management

- Users can say "start fresh" or "new session" to reset context
- Users can say "new session with summary" to preserve continuity
- Use the `new_chat_session_fresh` or `new_chat_session_with_summary` MCP tools
```

---

## Design Decisions

| Decision                    | Choice                       | Rationale                                                                                                                                            |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary delivery            | Injected into first prompt   | Guarantees the agent sees it immediately. File-based approach (`session-summary.md`) requires the agent to notice and read the file.                 |
| Warning threshold           | 80%                          | Early enough to give users time to wrap up or manually reset                                                                                         |
| Auto-reset threshold        | 90%                          | Gives agent 10% headroom to generate a quality summary before context is exhausted                                                                   |
| Resume guard                | Token-based (not time-based) | A short conversation from yesterday is fine to resume; a marathon session from 2 hours ago might be too large. Size is the real constraint, not age. |
| Session expiry notification | Brief, one-line              | Non-intrusive but keeps the user informed                                                                                                            |
| Token estimation            | `chars / 4` (incremental)    | Good enough for threshold checks. Exact tokenization would require the model's tokenizer and add overhead.                                           |

---

## File-by-File Change Summary

| File                                  | Phase | Changes                                                                   |
| ------------------------------------- | ----- | ------------------------------------------------------------------------- |
| `src/db.ts`                           | 1     | Extend sessions schema, add metrics functions                             |
| `src/session-manager.ts`              | 1     | Update thresholds (90% auto-reset), add `checkSessionThresholds()`        |
| `src/index.ts`                        | 1, 2  | Replace message re-fetch with incremental tracking, add auto-summary flow |
| `src/types.ts`                        | 2     | Add `sessionSummary` to `ContainerInput`                                  |
| `container/agent-runner/src/index.ts` | 2     | Accept and inject session summary into first prompt                       |
| `src/ipc.ts`                          | 2     | Store summary in DB during reset, retrieve for next session               |
| `src/container-runner.ts`             | 2, 3  | Pass summary to container, add resume guard                               |
| `src/config.ts`                       | 3     | Add `SESSION_MAX_RESUME_TOKENS`, configurable thresholds                  |

---

## Implementation Order

1. **Phase 1** (highest priority) -- Removes the per-response message re-fetch overhead
2. **Phase 2** (high priority) -- Completes the auto-reset TODO and provides real session continuity
3. **Phase 3** (medium priority) -- Safety net for the first-message-in-new-container case
4. **Phase 4** (low priority) -- Already mostly works, just needs documentation
