---
name: subagent-orchestration
description: Routes work through Wabi's subagent tool — worker for non-atomic implementation, scout/reviewer for read-only work, creative-worker for builds; foreground for blocking work, background only for read-only work, reviewer after risky changes. Use proactively when coding work can run independently or in parallel, would consume substantial parent context, needs an independent review, or is a creative UI build. Do not use for trivial or tightly coupled edits. Requires the subagent tool.
compatibility: Requires Wabi's subagent extension and configured child agents.
---

# Subagent Orchestration

Delegate only when isolation or parallelism pays for the handoff. Keep small tasks and tightly coupled edits in the parent.

## Route implementation work

- Use `worker` by default for non-atomic implementation: further exploration, multiple files, an uncertain path, or a test/debug loop.
- Keep in the parent only known, localized one-file atomic edits — and only when ALL of these hold: the exact file/location is known; the change is one localized file edit; no further exploration is needed; no iterative test/debug loop is required (one direct verification suffices); and the change triggers no review under the risk classes below.
- Use `creative-worker` for visual, interactive, web, and 3D builds.
- Use `scout` for read-only investigation and compressed context.
- Use `reviewer` for an independent correctness and complexity pass.

## Choose a mode

- Foreground: blocks until the subagent finishes and streams progress; use for work that gates the next decision. Issue sibling foreground subagent calls in one assistant message for independent blocking work.
- Background: read-only, nonblocking work only (`scout`, `reviewer`). Write-capable subagents are rejected in the background; their final result is steered back before your next turn.
- At most four subagents may run, and only one write-capable at a time.

## Review risky changes

Delegate an independent review to `reviewer` after any change in one of these risk classes:

- **Security or authentication**: permissions, secrets, untrusted input, injection, authorization boundaries.
- **Concurrency or consistency**: races, locking, ordering, shared mutable state, eventual consistency.
- **Schema or migrations**: data shape changes, migrations, backfills, defaults.
- **Public protocol or API**: wire formats, message types, function signatures, model-visible contracts.
- **CI, release, or deploy**: pipelines, versioning, packaging, rollout or rollback.
- **Cross-platform**: OS or architecture differences, path handling, shell quoting, line endings.
- **Cross-module behavior**: changes whose effect spans modules or ownership boundaries.
- **Worker retry or uncertainty**: the worker reported retries, partial failures, or unresolved risk.
- **Explicit user request**: the user asked for a review.

## When a worker fails

- Inspect the existing diff, refine the task, and retry once with one fresh worker.
- After a second failure, handle in the parent only a residual that is itself atomic; otherwise report the blocker and replan.

## Integrate and hand off

- Integrate the worker's result yourself and verify the integrated state — do not repeat the worker's exploration.
- Never poll or sleep for a subagent; never answer before required subagent runs finish.
- Do not duplicate delegated scope across subagents.

## Delegate well

Give the child a self-contained task with the working directory, scope, constraints, expected output, and whether changes are allowed. Expect the child's handoff to be Outcome/Evidence/Risks/Next; verify its evidence rather than re-exploring.
