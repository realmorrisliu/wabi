---
description: Delegate code review to the reviewer agent
argument-hint: "[--background] [scope]"
---
Delegate a review to the `reviewer` agent with the subagent tool.

Arguments: $@

Treat an optional leading `--background` as the subagent `background` flag and exclude it from the scope. If no scope remains, review the current working tree (`git status`, staged and unstaged changes, including untracked files). Report the review findings.
