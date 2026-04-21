#!/usr/bin/env bash
set -euo pipefail

# Prefer bash 4+ (for `read -e -i` readline preload). macOS ships 3.2 in
# /bin/bash, but Homebrew users usually have 5.x first on PATH. The readline
# preload is optional — on 3.x we fall back to a plain confirmation prompt.

# Register an Anthropic credential with OneCLI. Three paths:
#   1) Claude subscription — run `claude setup-token` (browser sign-in)
#                             and capture the resulting OAuth token.
#   2) Paste an existing sk-ant-oat… OAuth token you already have.
#   3) Paste an Anthropic API key (sk-ant-api…).
#
# Env overrides:
#   SECRET_NAME   OneCLI secret name   (default: Anthropic)
#   HOST_PATTERN  OneCLI host pattern  (default: api.anthropic.com)

SECRET_NAME="${SECRET_NAME:-Anthropic}"
HOST_PATTERN="${HOST_PATTERN:-api.anthropic.com}"

command -v onecli >/dev/null \
  || { echo "onecli not found. Install it first (see /setup §4)." >&2; exit 1; }

TOKEN=""

capture_via_claude_setup_token() {
  command -v claude >/dev/null \
    || { echo "claude CLI not found. Install from https://claude.ai/download" >&2; exit 1; }
  command -v script >/dev/null \
    || { echo "script(1) is required for PTY capture." >&2; exit 1; }

  local tmpfile
  tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
  trap 'rm -f "$tmpfile"' RETURN

  cat <<'EOF'
A browser window will open for sign-in. Token is captured automatically.
Press Enter to run, or edit the command first.

EOF

  local cmd="claude setup-token"
  if [[ ${BASH_VERSINFO[0]:-0} -ge 4 ]]; then
    # bash 4+: pre-fill the readline buffer so Enter literally submits.
    read -r -e -i "$cmd" -p "$ " cmd </dev/tty
  else
    # bash 3.x (macOS default /bin/bash): no readline preload. Fall back.
    echo "$ $cmd"
    read -r -p "Press Enter to run, Ctrl-C to abort. " _ </dev/tty
  fi

  # `script` arg order differs between BSD (macOS) and util-linux.
  if script --version 2>/dev/null | grep -q util-linux; then
    script -q -c "$cmd" "$tmpfile"
  else
    # BSD script: command is argv after the file, so let it word-split.
    # shellcheck disable=SC2086
    script -q "$tmpfile" $cmd
  fi

  # Strip ANSI codes + newlines (TTY wraps the token mid-string), then match
  # the sk-ant-oat…AA token. perl because BSD grep caps {n,m} at 255.
  TOKEN=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpfile" \
          | tr -d '\n\r' \
          | perl -ne 'print "$1\n" while /(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g' \
          | tail -1 || true)

  if [[ -z "$TOKEN" ]]; then
    local keep
    keep=$(mktemp -t claude-setup-token-log.XXXXXX)
    cp "$tmpfile" "$keep"
    echo >&2
    echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
    exit 1
  fi
}

prompt_for_pasted() {
  local prefix="$1"   # "oat" or "api"
  local value
  echo
  echo "Paste your sk-ant-${prefix}… credential and press Enter."
  echo "Nothing will appear on the screen as you paste — that's intentional."
  echo "Paste once, then just press Enter to submit."
  read -r -s -p "> " value </dev/tty
  echo

  if [[ -z "$value" ]]; then
    echo "No input. Aborting." >&2
    exit 1
  fi
  if [[ ! "$value" =~ ^sk-ant-${prefix} ]]; then
    echo "Value does not start with sk-ant-${prefix}. Aborting." >&2
    exit 1
  fi
  TOKEN="$value"
}

cat <<EOF
How would you like to authenticate?

  1) Use Claude subscription — runs \`claude setup-token\` and saves the
     resulting token in the Agent Vault.
  2) I have my own OAuth token — paste an existing sk-ant-oat… token.
  3) I have my own API key — paste an Anthropic API key (sk-ant-api…).

EOF

read -r -p "Choose [1/2/3]: " CHOICE </dev/tty

case "$CHOICE" in
  1) capture_via_claude_setup_token ;;
  2) prompt_for_pasted oat ;;
  3) prompt_for_pasted api ;;
  *) echo "Invalid choice." >&2; exit 1 ;;
esac

echo
echo "Got token: ${TOKEN:0:16}…${TOKEN: -4}"
echo "Registering with OneCLI as '$SECRET_NAME' (host pattern: $HOST_PATTERN)…"

onecli secrets create \
  --name "$SECRET_NAME" \
  --type anthropic \
  --value "$TOKEN" \
  --host-pattern "$HOST_PATTERN"

echo "Done."
