# Read-only subagent runs — design record (implemented)

Status: **implemented.** This document is the design record; `extensions/subagents/index.ts` plus the helper `extensions/subagents/clone.ts` implement the execution-isolation half, and the evidence-ownership half is a prompt/skill contract (the `subagent-orchestration` skill and the `HANDOFF_CONTRACT`). `clone-check.ts` pins the isolation behaviors, `orchestration-check.ts` pins the non-duplication contract wording with static assertions. Current behavior matches the Design section with the limitations listed under Deferred items.

## Problem

`launchRun` in `extensions/subagents/index.ts` spawns every child with `cwd: ctx.cwd` —
the parent's working directory, which is a Git worktree. Scout and reviewer are
read-only *by policy* (agent prompt), not by enforcement. The audit of session
`019ff0a2-251a-7342-b5cd-285c72c4565d` confirmed two root causes, each with concrete
failure modes:

### Execution ownership: the child shares the parent's checkout and refs

The child's working directory is the parent's checkout. Four concrete failure modes:

1. **Concurrent fetch → ref lock contention.** Parent `git fetch` racing a child
   `git fetch` on the same repository writes the same ref lock files; one side fails or
   blocks.
2. **Child checkout detaches the parent's HEAD.** A child running `git checkout` /
   `git switch` in the shared worktree moves the *parent's* checkout onto a detached
   HEAD, silently changing what the parent's subsequent `git status` and commits see.
3. **Stash/pop conflicts.** `git stash` and `git stash pop` mutate the shared
   `refs/stash`; a child's stash/pop collides with the parent's stash state.
4. **`git reset --hard` risk.** Nothing stops a read-only child from running it; in the
   shared checkout this destroys the parent's working tree and index.

### Evidence ownership: the parent duplicates the child's exploration

Delegation is only worth its cost if the child isolates the high-volume exploration and
returns compressed evidence. Today the same evidence gets read multiple times: the
parent reads full issue bodies/timelines *before* delegating, the child reads the same
evidence again during its run, and after the handoff the parent re-reads issues, PRs,
and OpenSpec documents to integrate. The child's compression is thrown away and the
parent pays the full exploration cost on both sides — delegation loses its value.

The design boundary accepted by the user is deliberately minimal, and both root causes
are in scope at the same level:

- **Execution ownership:** isolate only the read-only agents (scout, reviewer) into a
  disposable local clone per run; leave worker/creative-worker on the shared checkout;
  solve the shared-checkout and concurrent-refs problems. Clone preparation is
  asynchronous, cancelable (stop/reload/tool abort), and bounded by one shared total
  deadline; a clone failure or an abort never falls back to the shared cwd.
- **Evidence ownership:** one reader per piece of evidence. The parent collects only
  routing inventory before delegating; the child owns the exploration of its scope; the
  parent integrates with bounded verification, never re-exploration.

Everything else is deferred (see Deferred items).

## Goals

### Execution isolation

- Read-only children (scout, reviewer) work against a per-run disposable local clone,
  never the parent's checkout. This holds in foreground and background modes — the
  only modes read-only agents run in.
- The child sees the parent's working tree exactly: staged changes stay staged, unstaged
  changes stay unstaged, non-ignored untracked files are present; ignored files are not
  copied. The `/review` contract ("review the current working tree — `git status`,
  staged and unstaged changes, including untracked files") is unchanged.
- A misbehaving read-only child — fetch, checkout, stash, `git reset --hard` — cannot
  touch the parent's refs, stash, index, or working tree.
- The parent's own git operations never contend with a child's (no shared ref locks).
- Fail closed if the clone cannot be prepared (including a parent cwd that is not a
  Git worktree) or the parent changes while its snapshot is being captured. There is
  no fallback to the shared cwd and no auto-repair.
- A parent change after a consistent snapshot was captured does not fail the child;
  it makes the result stale against its recorded Baseline and requires a narrow
  freshness check before integration.
- The external interface is unchanged: `subagent({ agent, task, background })` keeps its
  shape and semantics. No new user-facing options.

### Evidence ownership

- One reader per piece of evidence. If the parent reads an issue/PR in full, delegating
  it adds nothing; if the parent delegates it, the child is the reader and the parent
  consumes only the child's compressed evidence plus a bounded freshness delta.
- Before delegating, the parent collects only the routing inventory needed to split
  work — ids, titles, states, labels, `updatedAt`, repo HEAD — not full
  bodies/comments/timelines/PRs/OpenSpec.
- After a handoff, the parent verifies; it does not re-explore. Freshness deltas,
  narrow checks for flagged items, and conflict/canonical checks are in; re-reading
  bodies/comments/timelines, broad greps, and rebuilding the child's causal chain
  are out.
- Handoffs carry a baseline and compressed evidence, so integration never requires
  re-reading the source.

## Non-goals (deferred — see Deferred items)

- OS-level sandboxing (no sandbox-exec/seatbelt/container layer around the child).
- Read-only network credentials for the child.
- A command parser that whitelists or blocks specific git commands in children.
- Telemetry for duplicate queries / repeated investigation (resource ledger, soft
  warnings). Only after this document's contract lands and prompt/skill fixes cannot
  eliminate observed duplication.

## Why a disposable local clone, not a linked worktree

`git worktree add` gives each worktree its own HEAD and index, but the worktrees still
share one repository: **refs** (including `refs/stash`), reflogs, config, and the object
store. A child worktree's `git fetch` still locks the shared refs, its `git stash`
still mutates the parent's stash, and its branch operations still write shared refs.
Worktrees isolate the working tree and index only — exactly the parts that are *not*
the problem here.

A clone has its own refs, reflogs, stash, config, index, and working tree. That fully
decouples a child's git state from the parent's, at the cost of one local clone per run
— cheap for the typical repo sizes and one-shot runs involved, and the clone lives in a
temp directory that is deleted when the run finishes.

## Design

### Clone creation

- Default: create the clone from the Git worktree containing the parent cwd, at the
  parent's local HEAD at launch, checked out **detached** (no branch). That HEAD sha
  is the child's fixed baseline — no fetch is required for it.
- Read-only runs live in a **dedicated root**: `${tmpdir()}/wabi-readonly-runs/`,
  one directory per run named `wabi-ro-<runId>` (created mode 0700). The run's
  tempDir **is** this whole run dir (the prompt temp file and the clone live
  inside it), so the existing best-effort removal deletes everything at once.
  Writer prompt temp dirs keep the legacy `mkdtemp(tmpdir(), "wabi-")` pattern
  and are never part of the read-only sweep.
- Each run dir carries an **owner marker** (`owner.json`, mode 0600, written
  atomically via an exclusive temp file + rename **before** clone preparation
  starts): schema/version, the creating `process.pid`, a random per-extension-
  instance token, the creating process's start time (`ps -o lstart=` output on
  POSIX, `""` on Windows), the run id, and `createdAt`. The marker is what lets
  a later startup sweep tell a crashed run from a live one without trusting a
  pid alone (pids get reused). Each extension instance registers its token when
  it loads and deregisters it in its own `session_shutdown` (pi awaits the old
  instance's shutdown before the next instance loads on reload or session
  switch), so however many instances are live in one process, every live run
  stays protected — and a replaced instance's leftover dirs become reclaimable
  the moment its shutdown completes. Run-dir names fold non-`[A-Za-z0-9-]`
  characters (a user-authored agent name may contain anything) to `-`, so every
  dir the extension creates is always a legal, sweepable name.
- Implementation uses `git clone --no-local --no-checkout` from the worktree
  root: `--no-local` forces the file transport and a full object copy, so the
  clone never shares hardlinks with the source and never inherits
  `objects/info/alternates` — the absence of an alternates file is verified
  after cloning, so an alternate-backed source still yields a fully
  independent clone. Then a detached `git checkout` of the launch HEAD. The
  full object copy means a detached parent HEAD is always check-out-able in
  the clone.
- Preparation is **asynchronous and cancelable**: one shared total deadline
  (internal constant, 120 s) covers the whole preparation — not a per-command
  timeout — and an external AbortSignal (tool abort, stop, reload) aborts it
  at any point, killing the current git child (spawned with an argument
  array, no shell; stdout/stderr bounded). Untracked-file fingerprinting and
  copying use chunked async reads/writes with abort/deadline checks between
  chunks and a total byte cap, so a single huge untracked file cannot block
  the event loop or buffer unboundedly. An aborted preparation settles the
  run as **stopped** (never an infrastructure empty failure); a deadline
  expiry settles it as stopped too. Any other preparation error fails the
  run closed with the bounded handoff — no git stderr leaks into the handoff.
- The child process is spawned with `cwd` set to the clone instead of `ctx.cwd`.
  Everything else about the spawn (args, env, stdio, prompts) is unchanged.
  For foreground runs the tool's abort signal is wired **before** preparation
  starts; background runs never wire it, so the tool call ending cannot stop
  them, and a background tool call still returns only after preparation
  completes and the child is spawned.

### Working-tree snapshot

The clone must reproduce the parent's working-tree state, not just HEAD:

1. `git diff --cached --binary` from the parent → apply in the clone with
   `git apply --index --binary`. This updates the clone's index **and** working tree
   together: the staged patch is relative to HEAD, so it applies cleanly to the
   clone's pristine index, and applying it to both keeps index and working tree at
   "HEAD + staged".
2. `git diff --binary` from the parent → apply in the clone with `git apply --binary`,
   working tree only. The unstaged patch is relative to the index (HEAD + staged),
   which is exactly what step 1 produced, so it applies cleanly. The clone's working
   tree is now "HEAD + staged + unstaged" while the index still holds exactly the
   staged set.
3. `git ls-files --others --exclude-standard` from the parent → copy those files into
   the clone (preserving paths), preserving non-ignored untracked files. Ignored files
   are never copied.

Submodules are not copied in v1 (see Deferred items).

### Parent cwd inside a repo subdirectory

If the parent cwd is a subdirectory of the worktree, the child's cwd in the clone is
the corresponding subdirectory (same path relative to the repo root). If the parent cwd
is the repo root, the child starts at the clone root.

### Remotes

- The clone's fetch remote copies the source worktree's fetch URL (e.g. `origin`), so
  `gh` repo discovery keeps working inside the child.
- All push URLs on the clone are set to a deliberately invalid per-clone `file://`
  URL built with `pathToFileURL` (a non-existent path inside the run temp dir), so
  an ordinary `git push` fails fast on every platform instead of reaching the
  network. This is best-effort: a child can still reach the network by passing an
  explicit push URL or adding a new remote. It is a speed bump for policy-following
  children, not a security boundary — we do not promise that every push fails.

### Child policy and isolation boundary

- Scout/reviewer prompts keep their existing "read-only by policy" instruction: the
  child should not fetch, checkout, reset, or stash in its clone. The task text also
  carries the run's Baseline (detached HEAD sha, branch, as-of, fingerprint) so the
  child's handoff can report it accurately.
- The isolation goal is that even if a child ignores the policy, the damage is confined
  to the disposable clone: wrong HEAD, wiped index, cleaned stash — all discarded when
  the clone is deleted. This is Git-workspace confinement, not enforcement: a child
  can still write outside the clone through absolute paths or reach the network, so
  the boundary is not a security boundary. There is no enforcement layer beyond that
  (command parsing is deferred).

### Baseline and freshness

- The default baseline is the parent's local HEAD at launch — the same commit the
  parent is working against; no fetch is required.
- Only when the task requires remote freshness does the parent run **one** serialized
  `git fetch` *before* delegating, then hands every sibling the same SHA (and as-of)
  as the baseline. Children never fetch on their own; siblings cannot race the
  parent's refs because they hold no shared refs at all.
- Sibling scope allocation is described under Owned scope below.

### Evidence ownership and bounded integration

This is the second half of the design, at the same level as clone isolation. It is a
prompt/skill contract (see Implementation footprint) that makes the parent the *single
consumer* of delegated evidence instead of a second reader.

**Delegation gate.** If the parent already holds enough evidence to answer, it does not
delegate — a subagent run exists to produce evidence the parent lacks. Once the parent
decides to delegate a scope, it collects only the routing inventory needed to split and
dispatch work: issue id/title/state/labels/`updatedAt`, repo HEAD — plus the baseline
below. It does not pre-read full bodies, comments, timelines, PR diffs, or OpenSpec
documents for the delegated scope; that reading is the child's job.

**Owned scope.** Every delegated task states:

- **objective** — the question the run must answer;
- **owned resources / scope** — the paths, issues, PRs, or domain evidence the child
  owns;
- **out of scope** — what the child must not read;
- **baseline / as-of** — the SHA and timestamp the child works against;
- **expected verdict / output** — the shape of the answer;
- **stopping condition** — when the child may stop.

Siblings default to non-overlapping scopes; overlap exists only when the task
explicitly asks for voting/cross-check of the same evidence.

**Ownership transfer.** Delegating a scope transfers exploration ownership: the child
investigates; the parent does not run the same exploration in parallel before the
handoff; the child does not step outside its scope to patch a sibling's gaps — it
reports them instead.

**Handoff contract.** The global four-section `HANDOFF_CONTRACT` (Outcome / Evidence /
Risks / Next) is unchanged — read-only runs do not get extra top-level sections:

- **Evidence** — the first item is **Baseline**: exact HEAD sha, as-of timestamp,
  workspace fingerprint, and — for dynamic resources — the inspected update markers.
  Then each claim followed by its *smallest* supporting evidence: resource id, path +
  line, or command result. End with the list of inspected resources (ids / SHAs /
  timestamps) so the parent can delta-check exactly those.
- **Risks** — the first item is **Needs parent verification**: only narrow items the
  child could not complete from its clone — permissions, clone-unrepresentable state,
  dynamic state that moved. Never re-doable exploration.
- **Next** — unchanged.

**Parent integration algorithm.** After each handoff (or a batch of sibling handoffs),
in order:

1. Check that sibling baselines are consistent (same SHA / as-of where the task
   required it).
2. Run **one batched freshness delta** for dynamic resources: HEAD/status fingerprint,
   issue/PR state + `updatedAt`, check status — for the inspected resources only.
3. If nothing changed: adopt the handoff. Re-reading bodies/comments/timelines/PRs/
   OpenSpec is prohibited.
4. If a resource changed: re-review only the affected finding(s), not the whole scope.
5. Each Needs-parent-verification item: exactly one narrow check.
6. Sibling conflicts: only the tie-break check needed to adjudicate the conflict.
7. Shared canonical gates (e.g. "this symbol still exists", "this invariant holds"):
   run once per invariant, not once per child.
8. High-impact state changes (close / reopen / merge): before acting, verify only the
   predicate that decides the action (e.g. the issue is still open), not a full
   re-audit.
9. A handoff that lacks key evidence is an **incomplete handoff**: ask for one bounded
   follow-up or report uncertainty. The parent never silently takes over the whole
   scope.

**Verification vs re-exploration.** Verification is a yes/no or freshness check on a
single claim ("state is X?", "file still has line L?", "SHA still H?"). Re-exploration
is re-reading the full body/comments/timeline, broad greps, or rebuilding the same
causal chain. The allowed range:

| Allowed — verification | Not allowed — re-exploration |
|---|---|
| Freshness delta on inspected resources (state, `updatedAt`, HEAD, run id) | Re-reading full issue/PR bodies, comments, or timelines |
| One narrow check per Needs-parent-verification item | Broad greps or re-opening files the child already reported |
| Tie-break check for one sibling conflict | Rebuilding the child's causal chain |
| Canonical gate: one check per invariant | Re-querying OpenSpec/PR content the handoff already summarized |
| Predicate check before a high-impact action | Full re-audit before acting |

**External dynamic resources baseline.** For Git state, the baseline is the SHA plus
workspace fingerprint. When the audit covers GitHub issues/PRs/checks, the handoff must
also record an as-of timestamp and, per inspected resource, its update marker
(`updatedAt`, head SHA, run id). The parent uses exactly these markers for the batched
delta in step 2 — it never re-pulls bodies to find out what changed.

**A target session, good and bad.**

Bad: the parent pulls every issue body + timeline → scouts pull the same evidence →
the parent re-queries each issue, PR, and OpenSpec document to integrate. Same evidence
read three times; the child's compression is discarded.

Good: the parent pulls only the issue inventory (id/title/state/labels/`updatedAt`) and
records a fixed SHA + as-of → delegates mutually exclusive scopes by domain (e.g.
#148 auth, #149 billing, #150 perf) → each scout fully investigates its scope and hands
back evidence with baselines → the parent runs one batched state/`updatedAt` delta and
one check per shared canonical gate → summarizes from the handoffs. If #150 moved
open → closed while the run was in flight, only #150's finding is re-reviewed.

### Snapshot consistency and freshness

- During clone preparation, compute a workspace fingerprint immediately before and
  after materializing the snapshot. It covers branch, HEAD sha, a digest of the staged
  binary diff (`git diff --cached --binary`), a digest of the unstaged binary diff
  (`git diff --binary`), the sorted list of non-ignored untracked files with a content
  digest per file, and `refs/stash`.
- The two capture-time fingerprints must match. A mismatch means the copied snapshot
  may be internally inconsistent, so preparation fails closed. There is no retry and
  no auto repair (no auto reset, checkout, or stash cleanup).
- After the child finishes, the parent may recompute the fingerprint once as its
  freshness delta. A mismatch at this point means only that the result is stale
  against its recorded Baseline: the child remains completed, and the parent narrowly
  verifies the affected findings instead of repeating the investigation.

### Clone lifecycle: normal deletion, startup stale sweep

- **Normal ends delete immediately.** Every terminal path (completed, failed,
  stopped, force-killed at shutdown) removes the whole run dir best-effort via
  the existing temp-dir cleanup; a failed removal is recorded as a bounded local
  transcript entry and never blocks the handoff, artifact, circuit update, or
  settle. Clone preparation failure removes the dir too (the run dir exists
  before preparation starts).
- **Startup stale sweep.** Once per session start the extension sweeps exactly
  one level of the dedicated root (`extensions/subagents/cleanup.ts`,
  `sweepReadonlyRuns`), reclaiming dirs left by kill -9, crashes, power loss, or
  previous failed cleanups. There is no timer, daemon, or configuration surface.
  Per run dir, in order:
  1. The entry must be a real directory with a legal `wabi-ro-*` name resolving
     inside the real root; symlinks (root, entries, or markers), files, foreign
     names, and anything outside the root are never followed or deleted.
  2. With a **valid owner marker**, the dir is deleted only when the sweep can
     prove the creating process is gone: the instance token is not registered
     in this process (a previous extension instance after a reload), or the
     pid is dead, or — on POSIX — the pid's `ps -o lstart=` start time no
     longer matches the marker (pid reuse). A live process whose identity
     cannot be verified (Windows, or `ps` unavailable) is conservatively kept.
     The token registry is process-global — a `Symbol.for`-keyed set on
     `globalThis` — so every copy of the extension module in one process shares
     it and never sweeps another live instance's runs.
  3. With a **missing/corrupt/oversized/symlinked marker** the dir is never
     deleted immediately: only when its mtime is older than the 24 h internal
     fallback constant. Future mtimes and un-stat-able dirs are kept.
- The sweep never throws and never blocks loading: failures are counted, logged
  locally, and surfaced once as a UI warning notification; successful cleanups
  stay silent. Concurrent sweeps in two processes cannot delete a live run's
  dir (its marker always proves a live process), and an entry that vanishes
  mid-sweep counts as already handled.
- **Honest limits.** This is best-effort reclamation, not a guarantee: a dir
  whose deletion fails (permissions, filesystem errors, an adversarial tmpdir)
  stays behind until a later sweep or manual removal, and the 24 h fallback
  means unknown-state dirs can linger for a day. The sweep is not a security
  boundary — anything with write access to `$TMPDIR` can already litter or
  remove these dirs.

### Failure behavior

- Clone preparation fails, the parent cwd is not inside a Git worktree, or the
  capture-time fingerprint check fails → the run fails closed with the existing
  bounded failure handoff. Never fall back to the shared cwd, never retry, never
  auto-repair.
- Preparation is aborted (tool abort, stop, reload) or the shared total deadline
  expires → the run settles as **stopped**, never as an infrastructure empty
  failure (the circuit does not count it).
- The clone is deleted when the run finishes, on success **and** on failure
  (including stop and force-kill paths) — best-effort: a cleanup failure is
  recorded as a bounded local transcript entry for the inspector and never
  blocks the handoff, artifact write, circuit update, or settle. It carries no
  deliverables: transcripts and artifacts are already persisted to the session
  archive.

### Implementation footprint

- **Execution isolation:** `extensions/subagents/index.ts` (spawn `cwd` selection and
  the Baseline task block) plus one small helper `extensions/subagents/clone.ts` with
  the snapshot/clone logic and one tiny helper `extensions/subagents/cleanup.ts` with
  the dedicated-root lifecycle and startup stale sweep. No strategy/factory/interface
  abstractions; no new configuration surface; no new dependencies (Node stdlib +
  `git` argument arrays, no shell). Preparation cancellation uses the standard
  `AbortController`/`AbortSignal`.
- **Non-duplication:** no runtime modules, interfaces, or enforcement. It is a
  prompt/skill contract: updates to the `subagent-orchestration` skill (delegation
  gate, owned scope, ownership transfer, bounded integration) and the `HANDOFF_CONTRACT`
  wording (baseline first in Evidence, inspected-resources list, Needs-parent-
  verification first in Risks). `orchestration-check.ts` pins the wording with static
  assertions only.

## Acceptance tests

Both acceptance suites are implemented as runnable scripts — no test framework, no new
dependencies: `bun clone-check.ts` (isolation), `bun cleanup-check.ts` (dedicated-root
lifecycle and stale-run sweep), and `bun orchestration-check.ts` (non-duplication).
`smoke.ts` additionally proves the extension's `session_start` handler runs the sweep
and that a failing cleanup only notifies without breaking loading.

### Isolation behavior

A test script (extending the existing self-check or a small dedicated script) covers
four behaviors, keeping the key incident coverage (fetch races, checkout detach, stash
collisions, `reset --hard`) inside the mutation-containment test:

1. **Snapshot fidelity.** `clone-check.ts` builds a fixture with the hard cases — one
   file carrying staged and unstaged changes at the same time, a staged deletion, and
   binary files (staged and unstaged) — plus non-ignored untracked files (text,
   binary, symlink) and an ignored file, and asserts the clone reproduces the parent
   exactly: staged and unstaged `--binary` diffs byte-identical, porcelain status
   identical, ignored files absent.
2. **Mutation containment.** `clone-check.ts` runs a parent `git fetch` concurrently
   with fetches in two independent clones (no ref lock errors), then runs
   `git checkout <other-branch>`, `git stash` + `git stash pop`, and
   `git reset --hard` in a clone. The parent's HEAD, branch, index, working tree,
   stash, and refs are unchanged; the clone is still deleted afterward.
3. **Subdirectory and remotes.** `clone-check.ts` prepares a clone with the parent
   cwd inside a repo subdirectory and asserts the child starts at the matching
   subdirectory. The clone's fetch URL matches the source's origin; a plain
   `git push` fails fast on the deliberately invalid push URL and never reaches the
   network.
4. **Cleanup, consistency, and fail-closed.** The clone is deleted with its run temp
   dir (the extension removes the temp dir best-effort on every terminal path — a
   failed removal is recorded locally and never blocks settlement). Non-Git cwd, a
   repo without a commit, a submodule pointer change, and a capture-time fingerprint
   mismatch all fail closed; the shared cwd is never used. The fingerprint race itself
   is inherently nondeterministic, so its guard (`assertSnapshotConsistent`) is
   unit-tested at the mechanism level: matching fingerprints pass, mismatches throw.
   A parent change after capture while the child runs does not fail the run; it
   produces a freshness delta for narrow parent verification. There is no retry or
   auto repair.
5. **Async cancellation and independence.** Preparation is exercised through its
   async API; a pre-aborted signal and an abort mid-preparation both reject with
   `AbortError`, and a tiny injected total deadline rejects the whole preparation
   quickly (one shared deadline, not per-command timeouts). A fixture source with
   `objects/info/alternates` clones into a clone with no alternates that stays fully
   functional after the shared object store is destroyed. The invalid push URL is a
   per-clone `file://` path built with `pathToFileURL` (cross-platform; `git push`
   fails fast). A non-UTF8 untracked path (POSIX-only fixture) fails closed instead
   of being silently replaced. The cleanup helper never throws and reports failures
   through a callback (`check.ts`), and the extension's settle path wraps it so a
   cleanup error cannot block a handoff.
6. **Dedicated-root lifecycle and stale-run sweep.** `cleanup-check.ts` pins, inside a
   sandboxed root: marker creation before clone prep (with pid, instance token,
   process start time, runId, createdAt; 0700 dir, 0600 marker), whole-run-dir
   removal on normal end and on failed prep, writer temp dirs never swept, and the
   sweep decisions — dead pid deletes immediately, registered in-process token keeps,
   same-process previous-instance marker deletes, PID-reuse identity mismatch deletes
   (real `ps -o lstart=` verification against a real child process), live-but-
   unverifiable keeps (pure Windows-conservative logic), missing/corrupt/symlink/
   oversize markers kept fresh and deleted only past the 24 h mtime fallback, symlink
   roots/entries/markers never followed, path-boundary refusal, idempotency, and
   deletion failures reported without throwing. `smoke.ts` proves the extension's
   `session_start` handler actually runs the sweep and that a failing cleanup only
   notifies a warning without breaking the handler.

### Non-duplication orchestration check

`orchestration-check.ts` makes **static contract assertions only**: the
`HANDOFF_CONTRACT` Baseline/Needs-parent-verification shape (including the
read-only-injected vs writer-known baseline wording) and the skill's delegation
gate / owned scope / ownership transfer / bounded-integration language, so the
contract cannot silently regress. It does **not** audit transcripts: a synthetic
marker parser cannot prove real orchestration, so the earlier transcript-fixture
audit was removed and orchestration is not enforced at runtime. Deeper
orchestration behavior is verified by the manual recorded-session checklist
below.

**Manual recorded-session checklist** (review a session transcript where the
parent delegated and integrated; no tooling enforces this):

1. **Delegation gate.** Before delegating a scope, the parent read only routing
   inventory (ids/titles/states/labels/`updatedAt`, repo HEAD) — no full issue/PR
   bodies, comments, timelines, PR diffs, or OpenSpec documents for the delegated
   scope.
2. **Sibling scopes.** Sibling subagent tasks in one message are disjoint, or
   explicitly ask for voting/cross-check of shared ids.
3. **One batched freshness delta.** After the handoff, exactly one delta over the
   inspected resources' update markers; unchanged handoffs are adopted without
   re-reading.
4. **Narrow follow-ups.** A changed resource is re-reviewed only for its affected
   finding; each Needs-parent-verification item gets exactly one narrow check.
5. **Canonical gates once.** Shared canonical gates run once per invariant, and
   high-impact actions check only the deciding predicate.
6. **No re-exploration.** No re-reading of bodies/comments/timelines, broad greps,
   or rebuilt causal chains after the handoff.

## Deferred items and triggers

| Item | Trigger to pick it up |
|---|---|
| OS sandbox around the child (sandbox-exec/seatbelt/container) | A child damages state the clone cannot confine (e.g. files outside the clone), or runs against untrusted repos where clone isolation is insufficient. |
| Read-only network credentials for children | Children need authenticated network access (beyond `gh` repo discovery via the copied fetch URL) and push prevention at the credential level becomes necessary. |
| Command parser blocking git mutations in children | Policy violations observed in practice: children actually run fetch/checkout/reset/stash despite prompts, and clone isolation alone proves insufficient. |
| Duplicate-query / repeated-investigation telemetry (resource ledger, soft warnings) | The evidence-ownership contract in this document lands (baseline + freshness delta + owned scope), and real sessions still show duplication that prompt/skill updates cannot eliminate. Not in the current plan. |
| Runtime orchestration enforcement (transcript auditing inside the extension) | The static contract assertions and manual recorded-session checklist prove insufficient in real sessions. Not in the current plan. |
| Periodic garbage collection (timer/daemon) for the dedicated run root | Stale dirs survive the startup sweep (e.g. the extension never starts again, or an unknown-state dir sits under 24 h) and accumulate enough to matter. The startup sweep plus the 24 h fallback is deliberately enough today. Not in the current plan. |
| Submodule support in the snapshot | A repo under review uses submodules and reviewers need their content. |

## References

- Claude Code worktrees: <https://code.claude.com/docs/en/worktrees>
- Claude Code subagents: <https://code.claude.com/docs/en/subagents>
- OpenAI Codex agent approvals and security: <https://developers.openai.com/codex/agent-approvals-security>
- OpenAI Codex worktrees: <https://developers.openai.com/codex/app/worktrees>
- `git-worktree` manual: <https://git-scm.com/docs/git-worktree>
- Anthropic multi-agent research system: <https://www.anthropic.com/engineering/multi-agent-research-system>
