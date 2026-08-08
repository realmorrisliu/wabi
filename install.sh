#!/usr/bin/env bash
# wabi — install (symlink) into the global pi agent dir.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents ~/.pi/agent/prompts

ln -sfn "$PWD/extensions/subagents" ~/.pi/agent/extensions/wabi-subagents
for f in agents/*.md; do
	ln -sf "$PWD/$f" ~/.pi/agent/agents/"$(basename "$f")"
done
ln -sf "$PWD/prompts/implement-and-review.md" ~/.pi/agent/prompts/implement-and-review.md

# review.md was the old prompt-based subagent; superseded by wabi's reviewer agent.
rm -f ~/.pi/agent/prompts/review.md
# stale symlinks from the scout/planner era
rm -f ~/.pi/agent/agents/scout.md ~/.pi/agent/agents/planner.md ~/.pi/agent/prompts/scout-and-plan.md

echo "wabi installed. Run /reload in pi to load the extension."
