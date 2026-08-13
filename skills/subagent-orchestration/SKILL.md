---
name: subagent-orchestration
description: Routes work through Wabi's subagent tool — research-plan for complex or uncertain tasks (deep research + implementation plan), reviewer for independent review, creative-worker for builds; foreground for blocking work, background only for read-only work, reviewer after risky changes. Use proactively: research-plan before any complex or uncertain task, reviewer after risky changes, creative-worker for creative UI builds. Do not use for trivial or tightly coupled edits. Requires the subagent tool.
compatibility: Requires Wabi's subagent extension and configured child agents.
---

# Subagent Orchestration

The parent agent owns ordinary implementation. Delegate only when isolation or parallelism pays for the handoff, or when a specialist child (research-plan, review, creative) does the job better. Keep small tasks and tightly coupled edits in the parent.

## Route work

- The parent implements: keep non-atomic implementation in the parent — multiple files, an uncertain path, and test/debug loops are the parent's own job. Do not delegate work that is small, tightly coupled, or already fully understood.
- For a complex or uncertain task, delegate Research & Plan to `research-plan` **before you explore or implement**: it owns the deep dive — reads the relevant code, traces flows, verifies assumptions — and returns a concrete implementation plan with evidence. Do not pre-explore the task yourself: the handoff is the exploration. Foreground when the plan gates the next step (it usually does), background otherwise. research-plan never implements — adopt its plan and implement it yourself.
- Use `creative-worker` for visual, interactive, web, and 3D builds.
- Use `reviewer` for an independent correctness and complexity pass. When the reviewed work ran in a different working directory than your own (a task-level "Working directory" or another worktree of the repo), pass that directory as the subagent `cwd` parameter so the reviewer's disposable clone snapshots exactly it — uncommitted changes included. Never create a local commit just to make uncommitted changes reviewable.

## Choose a mode

- Foreground: blocks until the subagent finishes and streams progress; use for work that gates the next decision. Issue sibling foreground subagent calls in one assistant message for independent blocking work.
- Background: read-only, nonblocking work only (`research-plan`, `reviewer`). Write-capable subagents are rejected in the background; their final result is steered back before your next turn.
- At most four subagents may run, and only one write-capable at a time.

## Evidence ownership: one reader per piece of evidence

A subagent run exists to produce evidence the parent lacks. Once a scope is delegated, the child owns its exploration and the parent consumes only the child's compressed evidence plus a bounded freshness delta.

- **Delegation gate.** If you already hold enough evidence to answer, do not delegate. Before delegating a scope, collect only the routing inventory needed to split and dispatch work: issue id/title/state/labels/`updatedAt`, repo HEAD, and the baseline below. Do not pre-read full bodies, comments, timelines, PR diffs, or OpenSpec documents for the delegated scope — that reading is the child's job.
- **Owned scope.** Every delegated task must state: **objective** (the question the run must answer); **owned resources / scope** (the paths, issues, PRs, or evidence the child owns); **out of scope** (what the child must not read); **baseline / as-of** (the SHA and timestamp to work against); **expected verdict / output** (the shape of the answer); **stopping condition** (when the child may stop).
- **Ownership transfer.** Delegating a scope transfers exploration ownership: you do not run the same exploration in parallel before the handoff, and the child does not step outside its scope to patch a sibling's gaps — it reports them instead.
- **Sibling scopes** default to non-overlapping. Overlap exists only when the task explicitly asks for voting or cross-check of the same evidence.

## Integrate with bounded verification, never re-exploration

- Integrate delegated results yourself and verify the integrated state — do not repeat the child's exploration.
- Never poll or sleep for a subagent; never answer before required subagent runs finish.
- Do not duplicate delegated scope across subagents.
- After a handoff (or a batch of sibling handoffs), in order: check sibling baselines are consistent (same SHA / as-of where the task required it); run **one batched freshness delta** (HEAD/status fingerprint, issue/PR state + `updatedAt`, check status) for the inspected resources only; if nothing changed, **adopt the handoff**; if a resource changed, re-review only the affected finding(s), not the whole scope; each Needs-parent-verification item gets exactly one narrow check; sibling conflicts get only the **tie-break** check; each shared **canonical** gate (e.g. "this symbol still exists", "this invariant holds") runs once per invariant, not once per child; before close/reopen/merge, verify only the **predicate** that decides the action (e.g. the issue is still open), not a full re-audit.
- Verification is a yes/no or freshness check on a single claim ("state is X?", "file still has line L?", "SHA still H?"). Re-exploration — re-reading full bodies/comments/timelines, broad greps, or rebuilding the child's causal chain — is prohibited.
- A handoff that lacks key evidence is an **incomplete handoff**: ask for one bounded follow-up or report uncertainty. Never silently take over the whole scope.

## Review risky changes

Delegate an independent review to `reviewer` after any change in one of these risk classes:

- **Security or authentication**: permissions, secrets, untrusted input, injection, authorization boundaries.
- **Concurrency or consistency**: races, locking, ordering, shared mutable state, eventual consistency.
- **Schema or migrations**: data shape changes, migrations, backfills, defaults.
- **Public protocol or API**: wire formats, message types, function signatures, model-visible contracts.
- **CI, release, or deploy**: pipelines, versioning, packaging, rollout or rollback.
- **Cross-platform**: OS or architecture differences, path handling, shell quoting, line endings.
- **Cross-module behavior**: changes whose effect spans modules or ownership boundaries.
- **Child retry or uncertainty**: a delegated child reported retries, partial failures, or unresolved risk.
- **Explicit user request**: the user asked for a review.

## When a subagent fails

- Inspect the existing diff, refine the task, and retry once with one fresh run.
- Two consecutive failures with **no output** (empty infrastructure failures: nonzero exit, missing final stop reason, or provider error before any text) mean an infrastructure outage shared across all agents: **stop delegating**, report degraded mode, and run **at most one health probe** after the circuit's cooldown. Never retry blindly into an open circuit; a successful probe closes it, a failed probe reopens it.
- A failed reviewer run is **not a review**: it contributes no review feedback, so never treat it as one; re-review only after the underlying failure is resolved.
- After two failures of the same delegated task, **do not blindly retry**: report the blocker and replan — a fresh research-plan run may help — instead of hammering the same launch.

## Delegate well

Give the child a self-contained task with the working directory — pass it as the subagent `cwd` parameter (default: your own current directory) when it differs, so write-capable children start there and a read-only child's disposable clone snapshots exactly that directory instead of your checkout — scope, constraints, expected output, and whether changes are allowed. Expect the child's handoff to be Outcome/Evidence/Risks/Next with a Baseline (HEAD sha, as-of, fingerprint, inspected update markers) as the first Evidence item; verify its evidence rather than re-exploring.
