#!/usr/bin/env bash
# wabi — pi 配置发行版: subagent runtime (pi-subagents), custom agents, prompt
# templates, settings seed, herdr skill + pi integration. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/prompts" "$AGENT_DIR/skills"

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
fi

echo "wabi installed into $AGENT_DIR — restart pi or /reload."
