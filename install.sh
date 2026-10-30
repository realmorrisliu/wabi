#!/usr/bin/env bash
# wabi — Herdr-first Pi setup. Safe to re-run; personal configs are preserved.
set -euo pipefail
cd "$(dirname "$0")"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
command -v pi >/dev/null
command -v node >/dev/null
mkdir -p "$AGENT_DIR/skills"

# Direct versions are pinned. Upgrade deliberately and verify the tool contracts.
pi install npm:pi-subagents@0.66.0
pi install git:github.com/DietrichGebert/ponytail@09c434ab73ca43761c5d8b0c5d341926c2fba710
pi install npm:@gotgenes/pi-github-tools@5.0.0
# Provider behind the default model; the model id does not exist without it.
pi install npm:pi-commandcode-provider@0.7.11
# The detached subagent runner imports Pi as a package. Keep a matching local
# runtime even when the user's pi command is a standalone binary.
PI_RUNTIME_VERSION=$(pi --version)
npm install --prefix "$AGENT_DIR/npm" --save-exact "@earendil-works/pi-coding-agent@$PI_RUNTIME_VERSION"

export WABI_INSTALL_HERDR=0 WABI_INSTALL_GHOSTTY=0
if command -v herdr >/dev/null 2>&1; then
  export WABI_INSTALL_HERDR=1
  mkdir -p "$AGENT_DIR/skills/herdr"
  skill_tmp=$(mktemp "$AGENT_DIR/skills/herdr/.skill.XXXXXX")
  trap 'rm -f "$skill_tmp"' EXIT
  herdr --skill > "$skill_tmp"
  test -s "$skill_tmp"
  mv "$skill_tmp" "$AGENT_DIR/skills/herdr/SKILL.md"
  # Failure is actionable: never report successful setup without the integration.
  herdr integration install pi
else
  echo 'Warning: Herdr is not installed; install it and rerun to enable the primary workflow.' >&2
fi
if command -v ghostty >/dev/null 2>&1 || [ -d /Applications/Ghostty.app ] || [ -d "$CONFIG_DIR/ghostty" ]; then
  export WABI_INSTALL_GHOSTTY=1
fi
node scripts/configure.mjs "$PWD" "$AGENT_DIR" "$CONFIG_DIR"
echo "wabi installed into $AGENT_DIR — restart pi or /reload."
