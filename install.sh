#!/usr/bin/env bash
# wabi — install (symlink) into the global pi agent dir.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents ~/.pi/agent/prompts ~/.pi/agent/skills

ln -sfn "$PWD/extensions/subagents" ~/.pi/agent/extensions/wabi-subagents
ln -sfn "$PWD/skills/subagent-orchestration" ~/.pi/agent/skills/subagent-orchestration
for f in agents/*.md; do
	ln -sf "$PWD/$f" ~/.pi/agent/agents/"$(basename "$f")"
done
for f in prompts/*.md; do
	ln -sf "$PWD/$f" ~/.pi/agent/prompts/"$(basename "$f")"
done

# stale prompts and symlinks from earlier versions
rm -f ~/.pi/agent/prompts/implement-and-review.md ~/.pi/agent/prompts/implement.md
rm -f ~/.pi/agent/agents/planner.md ~/.pi/agent/prompts/scout-and-plan.md

echo "wabi installed. Run /reload in pi to load the extension."
