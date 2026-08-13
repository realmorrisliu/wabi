---
description: Delegate a complex or uncertain task to the read-only research-plan agent — it researches the task and returns an implementation plan (no implementation)
argument-hint: "<task>"
---
Delegate research and planning for this task to the `research-plan` agent with the subagent tool:

$@

Run it in the foreground (or background for non-blocking planning) and report the resulting plan. The research-plan agent is read-only: it researches the task deeply and must not implement anything; implementation stays with you.
