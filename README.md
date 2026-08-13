# wabi

Personal pi extension pack — small, observable subagents following 大道至简.

## What it is

Wabi adds one `subagent` tool. Each task runs in a separate, one-shot `pi --mode json` child process while the parent keeps the useful parts visible. Write-capable children (creative-worker) share the parent's working directory; read-only agents (planner, reviewer) run in a per-run disposable local clone, so their Git workspace mutations are confined to that clone — read-only by confinement, not by enforcement (a child can still write outside the clone via absolute paths or reach the network; this is not a security boundary). See [Design](#design).

- Foreground runs stream progress and block until the result is ready
- Background runs return immediately and are read-only only; the final result is steered back before the parent's next model turn
- A compact widget shows agent, status, current tool, and elapsed time
- `/subagents` or `Alt+S` opens the live transcript inspector; `s` stops a running child
- Child process noise stays out of the parent model context; only the final answer is handed back
- Failed runs hand back a bounded, structured summary — exit code, exit signal, stop reason, provider error, and whether output/stderr exist — never raw stderr or provider diagnostics
- Two consecutive no-output failures open one shared circuit breaker across all agent roles: launches are refused and the parent is told to report degraded mode; at most one health probe runs after the cooldown
- Every finished run is written to a durable per-session artifact (mode 0600 under a mode-0700 session dir) with the retained transcript and stderr, so postmortem and `/subagents` survive reload and resume
- A `subagent-orchestration` skill teaches the parent when to delegate, which agent to choose, and when to use background mode

Children inherit project context and skills, but not ambient extensions, prompt templates, or themes. Write-capable children also inherit the parent's working directory (`ctx.cwd`) — a shared Git checkout — unless the call passes the optional `cwd` parameter (the working directory for the run; relative paths resolve against the parent's). Read-only children (planner, reviewer) instead work against a per-run disposable local clone of the run's working directory (created with `git clone --no-local --no-checkout` — a full object copy with no hardlinks and no alternates from the source, verified; detached HEAD at launch, reproducing staged, unstaged, and non-ignored untracked state), so their git operations cannot touch the parent's refs, stash, index, or working tree — and no shared ref locks remain. Passing `cwd` lets a review target a different worktree of the same repo, so the reviewer's clone contains that directory's uncommitted changes. Clone preparation is asynchronous and cancelable (stop/reload/tool abort terminate it under one shared total deadline, killing the current git child), and untracked-file fingerprinting/copying is chunked with abort checks and a total byte cap. Each child runs against the canonical agent directory (same `auth.json`, `models-store.json`, and settings as the parent), so pi's own file locks are shared and OAuth refreshes can never race through per-run copies. The old per-run overlay also force-set `transport: "sse"`; children now follow the parent's transport setting instead — the accepted tradeoff for sharing one canonical auth/models state. They are stopped when the parent session reloads, switches, or exits.

## Design

[`docs/read-only-subagent-runs.md`](docs/read-only-subagent-runs.md) is the design record and current-behavior reference for read-only subagent runs — **implemented**. It has two equal halves:

- **Execution ownership (isolation):** planner and reviewer runs execute in a per-run disposable local clone created from the run's working directory at launch — the optional `cwd` parameter, default the parent's (`extensions/subagents/clone.ts`): a full object copy via `git clone --no-local --no-checkout` (no hardlinks, no alternates — verified, so alternate-backed sources still yield independent clones), detached HEAD at the source's launch HEAD, staged changes applied into the clone's index and worktree together, unstaged changes into the worktree only, non-ignored untracked files copied (ignored files never), and the child's cwd mapped to the matching subdirectory. The clone's refs, stash, config, index, and working tree are fully independent of the parent's; it lives inside a per-run dir under the dedicated `$TMPDIR/wabi-readonly-runs/` root and is deleted best-effort on every terminal path (a failed cleanup is recorded in the local transcript and never blocks the run's handoff). Each run dir carries an owner marker (pid + instance token + process start time + runId), and once per session start a stale sweep reclaims dirs left by kill -9/crashes or failed cleanups: dead pids and PID-reuse mismatches delete immediately (POSIX identity via `ps -o lstart=`; a live but unverifiable pid — Windows — is conservatively kept), and dirs with missing/corrupt markers are only deleted past a 24 h mtime fallback. Preparation is asynchronous and cancelable — stop/reload/tool abort terminate it under one shared total deadline, and untracked fingerprinting/copying is chunked with a total byte cap. Clone preparation fails the run closed — no fallback to the shared cwd, no retry, no auto-repair — and a capture-time fingerprint (branch, HEAD, staged/unstaged binary diffs, untracked paths+content, `refs/stash`) computed before and after materialization makes an inconsistent snapshot fail instead of silently diverging. A parent change after capture does not fail the run; it makes the result stale against its recorded Baseline, which the child reports as the first Evidence item. Submodules are not copied (deferred: a submodule pointer change fails closed), and the deliberately invalid per-clone `file://` push URL on the clone's remotes is a speed bump for policy-following children, not a security boundary — as is the clone itself: a child can still escape via absolute paths or the network.
- **Evidence ownership (non-duplication):** a prompt/skill contract — the delegation gate (routing inventory only, no pre-reading), owned scope (objective / scope / out of scope / baseline-as-of / expected verdict / stopping condition), ownership transfer (the parent does not re-explore in parallel, siblings default to disjoint scopes), and bounded parent integration (one batched freshness delta, adopt unchanged handoffs, narrow checks only, tie-breaks, canonical gates once, predicate checks before acting, bounded follow-up for incomplete handoffs). The `HANDOFF_CONTRACT` now opens Evidence with Baseline and Risks with Needs parent verification; verification is allowed, re-exploration is not.

## Agents (`~/.pi/agent/agents/`)

This repository defines only **child agents**. The main/parent agent's model is configured by your pi session (project or user config), not by this repo; the recommended/target main model is `deepseek-v4-flash`, which drives exploration and ordinary implementation itself.

| agent | model (provider/id) | role |
|---|---|---|
| `planner` | openai-codex/gpt-5.6-sol | read-only planning — decomposes complex or uncertain tasks into an implementation plan (max thinking) |
| `creative-worker` | kimi-coding/k3 | creative executor — web pages, 3D games, visual builds (full file access, high thinking) |
| `reviewer` | openai-codex/gpt-5.6-sol | correctness + ponytail-review complexity pass (read-only by policy, medium thinking) |

Change an agent's model, thinking level, tools, or instructions in its Markdown frontmatter. Per-call overrides are intentionally unsupported so runs stay reproducible.

## Usage

The parent model calls one primitive:

```ts
subagent({ agent: "planner", task: "plan the multi-file refactor" })                  // foreground: plan a complex/uncertain task (read-only)
subagent({ agent: "planner", task: "plan the auth rework", background: true })        // background: read-only only
subagent({ agent: "reviewer", task: "review src/index.ts" })
subagent({ agent: "reviewer", task: "review the uncommitted fix", cwd: "/path/to/other/worktree" })  // snapshot a different worktree of the repo
```

Routing policy lives in the subagent tool's guidelines and the `subagent-orchestration` skill: the parent agent itself explores and implements (non-atomic implementation stays in the parent); before a complex or uncertain task it may ask the read-only `planner` for an implementation plan; `reviewer` runs an independent correctness + complexity pass after risky changes; `creative-worker` builds visual/interactive artifacts. Use multiple sibling `subagent` calls in one assistant message for independent blocking work. Wabi permits at most four concurrent children, rejects a second write-capable child while one is active, and rejects write-capable children in the background (background is read-only only). Sequential composition happens naturally as each result is handed back to the parent.

Workflow prompts:

```text
/plan <task>
/review [--background] [scope]
```

`/review` defaults to the current working tree. `/plan` runs the read-only planner (foreground by default) and returns the plan — it never implements. `/review` may run in the background. For creative builds, ask the parent to delegate to `creative-worker`.

## Inspector

Open with `/subagents` or `Alt+S`.

- `↑` / `↓`: select a run
- `PgUp` / `PgDn`: scroll transcript
- `Ctrl+T`: show or hide thinking
- `s`, then `y`: stop a running child
- `Esc`: close

Completed runs remain inspectable for the current parent session; their widget row disappears after five seconds. After a reload or resume, runs from earlier in the same session are restored from the session's run archive and shown with an `archived` marker — metadata and the capped, retained transcript included.

Model-visible handoffs are capped at 8 KB total and never contain stderr or provider diagnostics; the inspector retains the full session transcript and shows per-run transcript bytes, handoff bytes, and isolation percentage.

## Run archive and failure behavior

- Every finished run is persisted as `~/.pi/agent/wabi-runs/<session-id>/<run-id>.json` (directory mode 0700, files mode 0600, written atomically via a uniquely named exclusive temp file and rename — a pre-created symlink at the final path is replaced, never followed): run id, agent, task, status, timestamps, exit code, exit signal, stop reason, provider error presence, output/stderr presence, usage, the capped transcript, and retained stderr. Caps: transcript 4 MB total with 64 KB per entry (oldest entries dropped first) and at most 100,000 entries (newest retained), task and private error message 4 KB each, stderr 128 KB; serialized artifacts always stay within the 16 MB restore cap. These files are for local postmortem and `/subagents` inspection only — they are never fed to the parent model.
- Restoring the archive skips symlinks, files over 16 MB (checked before reading), and corrupt or foreign files; at most the 100 most recent runs of a session are restored, oldest first.
- Failure handoffs distinguish three outcomes: `completed`, failed with partial output, and failed before any output; each carries provider error presence, exit code, signal, stop reason, and output/stderr presence as booleans — raw provider diagnostics never cross the model boundary.
- One shared circuit breaker (all agent roles) opens after two consecutive no-output failures and refuses launches until the 60 s cooldown elapses, then admits exactly one health probe. A probe success closes the circuit; a probe failure reopens it; a stopped probe releases the probe slot without counting. Completed runs and failed runs with output reset the failure count.

## Install

```bash
./install.sh   # symlinks extension, agents, prompts, and skill into ~/.pi/agent/
```

Run `/reload` in pi after installing.

When stable, install as a package with `pi install git:github.com/realmorrisliu/wabi`.

## Self-check

```bash
bun check.ts                # pure logic self-check
bun smoke.ts                # offline extension load against a stub API
bun clone-check.ts          # disposable-clone isolation integration check (real git fixtures)
bun cleanup-check.ts        # dedicated-root lifecycle + startup stale-run sweep check
bun install-check.ts        # isolated install.sh verification (temp HOME, stale-artifact cleanup)
bun orchestration-check.ts  # evidence-ownership contract assertions (static prompt/skill wording checks; no runtime enforcement)
```
