# API Provider Override & Model Mapping

NanoClaw can route agent API calls through an alternative provider instead of Anthropic directly. This is useful for cost savings, higher rate limits, or accessing different models through a compatible API proxy.

## How It Works

NanoClaw containers run the Claude Agent SDK, which makes API calls to Anthropic by default. When provider override env vars are set in `.env`, the container-runner forwards them to the container instead of the default `CLAUDE_CODE_OAUTH_TOKEN`. The Claude CLI inside the container uses `ANTHROPIC_BASE_URL` to determine where to send requests.

### Authentication Priority

| `.env` Configuration                          | Container Gets        | API Destination      |
| --------------------------------------------- | --------------------- | -------------------- |
| Only `CLAUDE_CODE_OAUTH_TOKEN`                | OAuth token           | Anthropic directly   |
| Only `ANTHROPIC_API_KEY`                      | API key               | Anthropic directly   |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | Base URL + auth token | Alternative provider |

When `ANTHROPIC_BASE_URL` is set, `CLAUDE_CODE_OAUTH_TOKEN` is **excluded** from the container — the provider's auth token takes precedence automatically.

## Setup

### 1. Configure `.env`

Comment out (or remove) the Anthropic OAuth token and set the provider override vars:

```bash
# Comment out Anthropic direct auth
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...

# Provider override
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your_provider_api_key
API_TIMEOUT_MS=3000000
```

### 2. Restart the Service

```bash
# Stop any running containers first
docker ps --filter "name=nanoclaw" -q | xargs -r docker stop

# Restart
npm run dev
```

The next container spawn will use the provider credentials. You can verify by checking the env inside a running container:

```bash
docker exec <container-name> bash -c 'for pid in $(pgrep node); do cat /proc/$pid/environ 2>/dev/null | tr "\0" "\n" | grep ANTHROPIC; done'
```

### 3. Revert to Anthropic Direct

Comment out the provider vars and uncomment `CLAUDE_CODE_OAUTH_TOKEN`:

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...

# ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
# ANTHROPIC_AUTH_TOKEN=your_provider_api_key
# API_TIMEOUT_MS=3000000
```

Restart the service. No other changes needed.

## Provider Model Mapping (Z.AI Example)

Alternative providers may map Claude model aliases to their own models. For example, Z.AI maps:

| Claude Alias | Z.AI Default Model | Notes                       |
| ------------ | ------------------ | --------------------------- |
| `opus`       | GLM-4.7            | Same as sonnet on Lite plan |
| `sonnet`     | GLM-4.7            | General-purpose             |
| `haiku`      | GLM-4.5-Air        | Lightweight/fast            |

### Overriding the Model Mapping

Some providers support model mapping env vars to control which backend model each Claude alias resolves to. For Z.AI:

```bash
# In .env — only effective when ANTHROPIC_BASE_URL is set
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5        # Requires Z.AI Pro or Max plan
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air
```

These are forwarded to the container alongside the provider auth vars. The Claude CLI uses them to override its internal model resolution.

**Important:** Setting a model your plan doesn't have access to (e.g., `glm-5` on Lite plan) will cause **errors**, not a graceful fallback. Only uncomment model overrides for models your plan supports.

## Per-Channel Model Selection

NanoClaw supports different Claude model aliases per Discord channel, configured in `.env`:

```bash
AGENT_MODEL=sonnet                                    # Global default
AGENT_CHANNEL_MODELS=family:haiku,devwork:opus        # Per-channel overrides
```

These aliases are stored in the database and passed to the Claude Agent SDK's `query()` call. When combined with a provider override, the alias resolution chain is:

```
Channel config (e.g., opus)
  → Claude CLI model alias resolution
    → Provider model mapping (e.g., ANTHROPIC_DEFAULT_OPUS_MODEL)
      → Provider backend model (e.g., GLM-4.7 or GLM-5)
```

## Supported Providers

Any provider that implements the Anthropic API format and accepts `ANTHROPIC_BASE_URL` should work. Known compatible providers:

| Provider                            | Base URL                         | Notes                          |
| ----------------------------------- | -------------------------------- | ------------------------------ |
| [Z.AI](https://z.ai)                | `https://api.z.ai/api/anthropic` | GLM models, subscription plans |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1`   | Multi-model proxy (untested)   |

## Security Notes

- Provider credentials are stored in `.env` (gitignored) and forwarded via a mounted env file, not command-line arguments
- The env file is written to `data/env/env` at container spawn time and mounted read-only
- Only auth-related vars are forwarded — no other `.env` values leak into containers
- The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) is stored outside the project root to prevent container tampering

## Troubleshooting

**Container still using old credentials after `.env` change:**
The env file is written when a container spawns, using the host process's view of `.env`. If you changed `.env` without restarting the host process, stop all containers and restart:

```bash
docker ps --filter "name=nanoclaw" -q | xargs -r docker stop
# Then restart npm run dev
```

**"Model not found" errors:**
The model alias you're using may not be available on your provider plan. Check your provider's documentation for supported models and plan tiers.

**Verifying which API endpoint is being used:**

```bash
# Check env vars inside a running container
docker exec <container-name> cat /workspace/env-dir/env
```
