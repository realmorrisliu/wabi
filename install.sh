#!/usr/bin/env bash
# wabi — install (symlink) into the global pi agent dir.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents ~/.pi/agent/prompts

ln -sfn "$PWD/extensions/subagents" ~/.pi/agent/extensions/wabi-subagents
for f in agents/*.md; do
	ln -sf "$PWD/$f" ~/.pi/agent/agents/"$(basename "$f")"
done
for f in prompts/*.md; do
	ln -sf "$PWD/$f" ~/.pi/agent/prompts/"$(basename "$f")"
done

# stale combined prompt and symlinks from the scout/planner era
rm -f ~/.pi/agent/prompts/implement-and-review.md
rm -f ~/.pi/agent/agents/scout.md ~/.pi/agent/agents/planner.md ~/.pi/agent/prompts/scout-and-plan.md

echo "wabi installed. Run /reload in pi to load the extension."
