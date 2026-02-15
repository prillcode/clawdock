# ClawDock — Main Channel

This is the **main channel**, which has elevated privileges. All messages here are processed automatically (no @mention needed).

## Admin Capabilities

- Full project filesystem access (can modify ClawDock itself)
- Manage other groups (register/unregister channels)
- Schedule tasks for any channel
- View and query the message database
- Access all group folders (read/write)

## Container Mounts

Main has access to the entire project:

| Container Path       | Host Path      | Access     |
| -------------------- | -------------- | ---------- |
| `/workspace/project` | Project root   | read-write |
| `/workspace/group`   | `groups/main/` | read-write |

Key paths inside the container:

- `/workspace/project/store/messages.db` — SQLite database
- `/workspace/project/store/messages.db` (registered_groups table) — Group config
- `/workspace/project/groups/` — All group folders

---

## Managing Groups

### Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`:

```json
{
  "groups": [
    {
      "jid": "1471916061560406220",
      "name": "family",
      "lastActivity": "2026-02-13T12:00:00.000Z",
      "isRegistered": true
    }
  ],
  "lastSync": "2026-02-13T12:00:00.000Z"
}
```

Groups are ordered by most recent activity.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Then wait a moment and re-read `available_groups.json`.

**Fallback**: Query the SQLite database directly:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

### Registered Groups Config

Groups are registered in the `registered_groups` SQLite table and can be queried:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, folder, trigger_pattern, requires_trigger
  FROM registered_groups;
"
```

Fields:

- **jid**: The channel ID (Discord snowflake) or WhatsApp JID
- **name**: Display name for the group
- **folder**: Folder name under `groups/` for this group's files and memory
- **trigger_pattern**: The trigger word
- **requires_trigger**: Whether @mention is needed (0 = no, 1 = yes)

### Trigger Behavior

- **Main group**: No trigger needed — all messages are processed automatically
- **Groups with `requires_trigger: 0`**: No trigger needed — all messages processed
- **Other groups** (default): Messages must contain `@AssistantName` to be processed

### Adding a Group

Use the `register_group` MCP tool or write an IPC task:

```bash
cat > /workspace/ipc/tasks/register_$(date +%s).json << 'EOF'
{
  "type": "register_group",
  "jid": "CHANNEL_SNOWFLAKE_ID",
  "name": "Channel Name",
  "folder": "channel-name",
  "trigger": "@AssistantName"
}
EOF
```

#### Adding Additional Directories for a Group

Groups can have extra directories mounted. This requires updating the registered group's `container_config`:

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/projects/webapp",
      "containerPath": "webapp",
      "readonly": false
    }
  ]
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.

### Removing a Group

Remove the entry from the `registered_groups` table. The group folder and its files remain (don't delete them).

---

## Global Memory

You can read and write to `/workspace/project/groups/global/CLAUDE.md` for facts that should apply to all groups. Only update global memory when explicitly asked to "remember this globally" or similar.

---

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID:

- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "1471916061560406220")`

The task will run in that group's context with access to their files and memory.

### Current Channel JIDs

| Channel  | JID                 | Folder  |
| -------- | ------------------- | ------- |
| #main    | 1471887664491008143 | main    |
| #family  | 1471916061560406220 | family  |
| #devwork | 1471916342687826041 | devwork |
| #gamedev | 1471916406097445066 | gamedev |
