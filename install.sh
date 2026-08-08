#!/usr/bin/env bash
# wabi — install (symlink) into the global pi agent dir.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents ~/.pi/agent/prompts

ln -sfn "$PWD/extensions/subagents" ~/.pi/agent/extensions/wabi-subagents
for f in agents/*.md; do
	ln -sf "$PWD/$f" ~/.pi/agent/agents/"$(basename "$f")"
done
ln -sf "$PWD/prompts/scout-and-plan.md" ~/.pi/agent/prompts/scout-and-plan.md

# review.md was the old prompt-based subagent; superseded by wabi's reviewer agent.
rm -f ~/.pi/agent/prompts/review.md

echo "wabi installed. Run /reload in pi to load the extension."
