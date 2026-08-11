# wabi

Personal pi extension pack — small, observable subagents following 大道至简.

## What it is

Wabi adds one `subagent` tool. Each task runs in an isolated, one-shot `pi --mode json` child process while the parent keeps the useful parts visible:

- Foreground runs stream progress and block until the result is ready
- Background runs return immediately and are read-only only; the final result is steered back before the parent's next model turn
- A compact widget shows agent, status, current tool, and elapsed time
- `/subagents` or `Alt+S` opens the live transcript inspector; `s` stops a running child
- Child process noise stays out of the parent model context; only the final answer is handed back
- Failed runs hand back a bounded, structured summary — exit code, exit signal, stop reason, provider error, and whether output/stderr exist — never raw stderr or provider diagnostics
- Two consecutive no-output failures open one shared circuit breaker across all agent roles: launches are refused and the parent is told to report degraded mode; at most one health probe runs after the cooldown
- Every finished run is written to a durable per-session artifact (mode 0600 under a mode-0700 session dir) with the retained transcript and stderr, so postmortem and `/subagents` survive reload and resume
- A `subagent-orchestration` skill teaches the parent when to delegate, which agent to choose, and when to use background mode

Children inherit project context and skills, but not ambient extensions, prompt templates, or themes. Each child runs against the canonical agent directory (same `auth.json`, `models-store.json`, and settings as the parent), so pi's own file locks are shared and OAuth refreshes can never race through per-run copies. The old per-run overlay also force-set `transport: "sse"`; children now follow the parent's transport setting instead — the accepted tradeoff for sharing one canonical auth/models state. They are stopped when the parent session reloads, switches, or exits.

## Agents (`~/.pi/agent/agents/`)

| agent | model | role |
|---|---|---|
| `scout` | deepseek-v4-flash | investigation and compressed context (read-only by policy, high thinking) |
| `worker` | deepseek-v4-flash | executor — default for non-atomic implementation (full file access, max thinking) |
| `creative-worker` | kimi-k3 | creative executor — web pages, 3D games, visual builds (full file access, high thinking) |
| `reviewer` | gpt-5.6-sol | correctness + ponytail-review complexity pass (read-only by policy, minimal thinking) |

Change an agent's model, thinking level, tools, or instructions in its Markdown frontmatter. Per-call overrides are intentionally unsupported so runs stay reproducible.

## Usage

The parent model calls one primitive:

```ts
subagent({ agent: "worker", task: "fix issue #12" })                       // foreground: non-atomic implementation
subagent({ agent: "scout", task: "map the auth flow", background: true })  // background: read-only only
subagent({ agent: "reviewer", task: "review src/index.ts" })
```

Routing policy lives in the subagent tool's guidelines and the `subagent-orchestration` skill: `worker` is the default executor for non-atomic implementation (further exploration, multiple files, uncertain path, test/debug loops); the parent keeps only known, localized one-file atomic edits. Use multiple sibling `subagent` calls in one assistant message for independent blocking work. Wabi permits at most four concurrent children, rejects a second write-capable child while one is active, and rejects write-capable children in the background (background is read-only only). Sequential composition happens naturally as each result is handed back to the parent.

Workflow prompts:

```text
/work <task>
/review [--background] [scope]
```

`/review` defaults to the current working tree. `/work` always runs in the foreground (worker is write-capable); `/review` may run in the background. For creative builds, ask the parent to delegate to `creative-worker`.

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
bun check.ts   # pure logic self-check
bun smoke.ts   # offline extension load against a stub API
```
