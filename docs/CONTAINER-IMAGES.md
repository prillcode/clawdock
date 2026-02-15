# Container Images

ClawDock uses Docker containers to isolate agent execution. Each channel can use a different container image based on its needs.

## Available Images

### `clawdock-agent:base` (Default)

Minimal image for general-purpose channels.

**Included tools:**

- Node.js 22
- Git (basic version control)
- Chromium (for web browsing via agent-browser)
- Essential utilities: curl, unzip, wget
- Claude Code Agent SDK
- agent-browser (web automation)

**Use cases:**

- Family chat (#family-assistant)
- General assistance channels
- Non-development channels

**Image size:** ~750MB

---

### `clawdock-agent:devtools`

Extended image with development tools. Built on top of `base`.

**Everything from `base` plus:**

- **AWS CLI v2** - Amazon Web Services command-line interface
- **GitHub CLI (`gh`)** - GitHub operations (PR creation, issues, etc.)
- **Docker CLI** - Container operations (useful for DevOps workflows)

**Use cases:**

- Software development (#devwork-assistant)
- Game development (#gamedev-assistant)
- System administration (#clawdock-admin)
- DevOps and deployment channels

**Image size:** ~1.1GB

---

## Selecting an Image

### At Channel Registration (via `.env`)

Specify the image in the `DISCORD_CHANNELS` environment variable using the `:image` suffix:

```bash
DISCORD_CHANNELS=id:name:folder[:triggerFlag][:image]
```

**Examples:**

```bash
# Family channel - base image (default, can be omitted)
DISCORD_CHANNELS=123456:family-assistant:family::base

# Devwork channel - devtools image
DISCORD_CHANNELS=234567:devwork-assistant:devwork::devtools

# Multiple channels
DISCORD_CHANNELS=123:clawdock-admin:clawdock-admin::devtools,456:family-assistant:family::base,789:devwork-assistant:devwork::devtools

# With trigger requirement
DISCORD_CHANNELS=999:private:private:requireTrigger:base
```

**Notes:**

- The 4th segment (`:triggerFlag`) must be explicitly set or left empty (`::`) when specifying an image
- If image is omitted, defaults to `base`
- Format: `id:name:folder::image` (empty trigger segment = no trigger required)
- Format: `id:name:folder:requireTrigger:image` (explicit trigger requirement)

---

### At Runtime (via #clawdock-admin)

Update a channel's image from the admin channel using natural language:

```
update channel #devwork-assistant to use devtools image
update channel #family-assistant to use base image
```

Or directly via the MCP tool:

```
update_channel({
  jid: "1471916061560406220",
  image: "devtools"
})
```

**Note:** Changes take effect on the next container restart (next message after update).

---

## Building Images

### Build Both Images (Recommended)

```bash
./container/build.sh
```

This builds both `base` and `devtools` images.

### Build Specific Image

```bash
./container/build.sh base      # Build base only
./container/build.sh devtools  # Build devtools only (auto-builds base if missing)
```

### Build Output

```
Building clawdock-agent:base...
✓ Built clawdock-agent:base

Building clawdock-agent:devtools...
✓ Built clawdock-agent:devtools

Build complete!

Available images:
  clawdock-agent:base (750MB)
  clawdock-agent:devtools (1.1GB)
```

---

## Choosing the Right Image

### Use `base` for:

- Family channels
- General chat
- Channels that only need web browsing and basic git operations
- Lightweight, non-development use cases

### Use `devtools` for:

- Software development work
- Game development
- DevOps/deployment operations
- Channels that need AWS CLI, GitHub CLI, or Docker CLI
- Admin channel (#clawdock-admin) for system management

---

## Custom Images

Advanced users can create custom images for specialized workflows.

### Example: Python ML Image

**1. Create `container/Dockerfile.python-ml`:**

```dockerfile
FROM clawdock-agent:base

USER root

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install numpy pandas scikit-learn torch

USER node
```

**2. Build the image:**

```bash
docker build -f container/Dockerfile.python-ml -t clawdock-agent:python-ml .
```

**3. Use in channel:**

```bash
DISCORD_CHANNELS=123:ml-assistant:ml::python-ml
```

---

## Image Validation

ClawDock validates that the specified image exists before starting a container.

**If an image is missing:**

```
[ERROR] Container image clawdock-agent:devtools not found. Run: ./container/build.sh
```

**Validation is cached** per image name to avoid repeated Docker CLI calls. Once an image is validated, subsequent container starts skip the validation check.

---

## Troubleshooting

### "Image not found" error

**Problem:** Container fails to start with "image not found" error.

**Solution:**

```bash
./container/build.sh  # Rebuild all images
```

### Switching from NanoClaw to ClawDock

**Problem:** After pulling ClawDock changes, containers fail with "nanoclaw-agent:latest not found".

**Solution:**

1. Rebuild images: `./container/build.sh`
2. Update `.env` with explicit image tags (see examples above)
3. Restart: `systemctl --user restart clawdock`

### Channel using wrong image

**Problem:** Channel is using `base` but needs `devtools` (or vice versa).

**Solution:**

**Option 1:** Update via admin channel:

```
update channel #devwork-assistant to use devtools image
```

**Option 2:** Update `.env` and restart:

```bash
# In .env, change:
DISCORD_CHANNELS=...,123:devwork-assistant:devwork::base
# To:
DISCORD_CHANNELS=...,123:devwork-assistant:devwork::devtools

# Then restart
systemctl --user restart clawdock
```

### Verify which image a channel is using

Check service logs after restart:

```bash
journalctl --user -u clawdock -n 100 | grep "image"
```

Look for log lines like:

```
Spawning container agent: group="devwork-assistant" image="clawdock-agent:devtools"
```

---

## Implementation Notes

### Image Name Prefix

ClawDock uses the `clawdock-agent:` prefix for all images (changed from `nanoclaw-agent:` for branding consistency). The image tag (`:base`, `:devtools`, etc.) is appended automatically.

### Image Resolution

When a channel specifies `image: "devtools"` in its config:

1. System resolves to full name: `clawdock-agent:devtools`
2. Validates image exists (cached check)
3. Spawns container with resolved image name

### Container Config Storage

Image selection is stored in the database (`registered_groups` table) as part of the `container_config` JSON field:

```json
{
  "image": "devtools",
  "model": "opus",
  "maxBudgetUsd": 0.75
}
```

### Backward Compatibility

- Existing channels without `image` field default to `base`
- Old `nanoclaw-agent:latest` images are no longer used
- Migration: rebuild images and update `.env` with explicit tags

---

## See Also

- [Groups and Channels Guide](Groups-Use-Cases.md) - Per-channel configurations
- [Project Status](PROJECT-STATUS.md) - Current deployment details
- [README](../README.md) - Main documentation
