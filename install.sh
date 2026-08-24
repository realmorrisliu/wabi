#!/usr/bin/env bash
# wabi — pi 配置发行版: subagent runtime, prompt templates, pi themes,
# settings seed, herdr skill + pi integration + theme, ghostty theme.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT_DIR/prompts" "$AGENT_DIR/skills"

backup_if_real() { if [ -e "$1" ] && [ ! -L "$1" ]; then mv "$1" "$1.bak"; fi; }

# 1. pi packages: the subagent runtime + ponytail skills + deterministic GitHub CI tools
pi install npm:pi-subagents
pi install git:github.com/DietrichGebert/ponytail
pi install npm:@gotgenes/pi-github-tools

# 2. prompt templates
for f in prompts/*.md; do ln -sf "$PWD/$f" "$AGENT_DIR/prompts/$(basename "$f")"; done

# 3. custom extensions (PR review threads + cross-app theme selection)
mkdir -p "$AGENT_DIR/extensions"
for f in extensions/*.ts; do ln -sf "$PWD/$f" "$AGENT_DIR/extensions/$(basename "$f")"; done
# Remove files retired from older wabi installs.
rm -f "$AGENT_DIR/extensions/agent-router.ts" "$AGENT_DIR/extensions/agent-router-core.ts"
for name in agent-routing creative-worker herdr-dispatch planner; do
	rm -f "$AGENT_DIR/skills/$name/SKILL.md"
	rmdir "$AGENT_DIR/skills/$name" 2>/dev/null || true
done

# 4. herdr (optional): release-matched official skill + pi integration
if command -v herdr >/dev/null 2>&1; then
	mkdir -p "$AGENT_DIR/skills/herdr"
	herdr --skill >"$AGENT_DIR/skills/herdr/SKILL.md"
	herdr integration install pi >/dev/null 2>&1 || true
	# herdr theme config (default Catppuccin pair, fixed dark)
	mkdir -p "$HOME/.config/herdr"
	backup_if_real "$HOME/.config/herdr/config.toml"
	ln -sf "$PWD/herdr/config.toml" "$HOME/.config/herdr/config.toml"
fi

# 5. pi themes and the shared pair registry
mkdir -p "$AGENT_DIR/themes"
for f in themes/*.json; do ln -sf "$PWD/$f" "$AGENT_DIR/themes/$(basename "$f")"; done
ln -sf "$PWD/theme-pairs.json" "$AGENT_DIR/theme-pairs.json"

# 6. settings: seed the default dark pair and migrate wabi auto-pairs
node -e '
const fs = require("fs");
const path = require("path");
const f = process.argv[1];
const registry = JSON.parse(fs.readFileSync(path.join(process.cwd(), "theme-pairs.json"), "utf8"));
const pair = registry.pairs[registry.default];
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
if (pair) {
  const selected = Object.values(registry.pairs).find((candidate) => s.theme === `${candidate.light.pi}/${candidate.dark.pi}`);
  if (typeof s.theme !== "string" || selected) s.theme = (selected ?? pair).dark.pi;
}
fs.writeFileSync(f, JSON.stringify(s, null, "\t") + "\n");
' "$AGENT_DIR/settings.json"

# 7. ghostty (optional): selected pair, fixed dark
if [ -d /Applications/Ghostty.app ] || [ -d "$HOME/.config/ghostty" ]; then
	mkdir -p "$HOME/.config/ghostty"
	backup_if_real "$HOME/.config/ghostty/config"
	ln -sf "$PWD/ghostty/config" "$HOME/.config/ghostty/config"
	# font referenced by the config (skip silently without brew)
	command -v brew >/dev/null 2>&1 && brew install --cask font-maple-mono-nf-cn || true
	# macOS: App Support config takes precedence over XDG — strip theme keys
	# there (backup first) so wabi's theme wins; personal settings untouched
	for f in "$HOME/Library/Application Support/com.mitchellh.ghostty/config" "$HOME/Library/Application Support/com.mitchellh.ghostty/config.ghostty"; do
		if [ -f "$f" ] && grep -qE '^(theme|window-theme)\s*=' "$f"; then
			cp "$f" "$f.bak"
			sed -i '' -E '/^(theme|window-theme)\s*=/d' "$f"
		fi
	done
fi

echo "wabi installed into $AGENT_DIR — restart pi or /reload."
