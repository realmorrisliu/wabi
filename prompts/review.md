---
description: Review changes with an independent reviewer
argument-hint: "[--background] [scope]"
---
Use the installed subagent tool to delegate a read-only review to `reviewer`.

Arguments: $@

An optional leading `--background` requests background execution; remove it from the scope. Use the installed tool schema/guide for invocation and waiting semantics. Without that flag, collect the completed review before reporting the result.

If no scope remains, review the current working tree, including staged, unstaged, and untracked files. Gather the actual diff/status and pass the scope and relevant requirements to the reviewer. Do not edit files.

Report actionable findings by severity, with file/line, trigger, impact, and evidence. Evaluate correctness, regressions, missing meaningful checks, and unnecessary complexity. Judge simplifications by preserved behavior and maintenance cost, not deleted lines. If there are no findings, say so and state verification limitations.
