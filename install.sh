#!/usr/bin/env bash
# wabi — pi 配置发行版: subagent runtime (pi-subagents), custom agents, prompt
# templates, pi themes, settings seed, herdr skill + pi integration + theme,
# ghostty theme. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/prompts" "$AGENT_DIR/skills"

backup_if_real() { if [ -e "$1" ] && [ ! -L "$1" ]; then mv "$1" "$1.bak"; fi; }

# 1. pi packages: the subagent runtime + ponytail skills
pi install npm:pi-subagents
pi install git:github.com/DietrichGebert/ponytail

# 2. custom agents (pi-subagents discovers $AGENT_DIR/agents/**/*.md; a user
#    agent shadows a builtin of the same name)
for f in agents/*.md; do ln -sf "$PWD/$f" "$AGENT_DIR/agents/$(basename "$f")"; done

# 3. prompt templates
for f in prompts/*.md; do ln -sf "$PWD/$f" "$AGENT_DIR/prompts/$(basename "$f")"; done

# 4. herdr (optional): release-matched official skill + pi integration
if command -v herdr >/dev/null 2>&1; then
	mkdir -p "$AGENT_DIR/skills/herdr"
	herdr --skill >"$AGENT_DIR/skills/herdr/SKILL.md"
	herdr integration install pi >/dev/null 2>&1 || true
	# herdr theme config (kanagawa pair, follows host terminal light/dark)
	mkdir -p "$HOME/.config/herdr"
	backup_if_real "$HOME/.config/herdr/config.toml"
	ln -sf "$PWD/herdr/config.toml" "$HOME/.config/herdr/config.toml"
fi

# 5. pi themes (kanagawa pair)
mkdir -p "$AGENT_DIR/themes"
for f in themes/*.json; do ln -sf "$PWD/$f" "$AGENT_DIR/themes/$(basename "$f")"; done

# 6. settings seed: theme pair only, everything else preserved
node -e '
const fs = require("fs");
const f = process.argv[1];
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
s.theme = "kanagawa-lotus/kanagawa";
fs.writeFileSync(f, JSON.stringify(s, null, "\t") + "\n");
' "$AGENT_DIR/settings.json"

# 7. ghostty (optional): kanagawa theme, follows macOS appearance
if [ -d /Applications/Ghostty.app ] || [ -d "$HOME/.config/ghostty" ]; then
	mkdir -p "$HOME/.config/ghostty"
	backup_if_real "$HOME/.config/ghostty/config"
	ln -sf "$PWD/ghostty/config" "$HOME/.config/ghostty/config"
fi

echo "wabi installed into $AGENT_DIR — restart pi or /reload."
