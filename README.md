# wabi

Personal pi extension pack — small, observable subagents following 大道至简.

## What it is

Wabi adds one `subagent` tool. Each task runs in an isolated, one-shot `pi --mode json` child process while the parent keeps the useful parts visible:

- Foreground runs stream progress into pi
- Background runs return immediately, then hand their final answer back as a follow-up
- A compact widget shows agent, status, current tool, and elapsed time
- `/subagents` or `Alt+S` opens the live transcript inspector; `s` stops a running child
- Child process noise stays out of the parent model context; only the final answer is handed back

Children inherit project context and skills, but not ambient extensions, prompt templates, or themes. They are stopped when the parent session reloads, switches, or exits.

## Agents (`~/.pi/agent/agents/`)

| agent | model | role |
|---|---|---|
| `worker` | deepseek-v4-flash | executor — implements tasks directly (full file access) |
| `creative-worker` | kimi-k3 | creative executor — web pages, 3D games, visual builds (full file access) |
| `reviewer` | gpt-5.6-sol | correctness + ponytail-review complexity pass (read-only by policy) |

Change an agent's model, tools, or instructions in its Markdown frontmatter. Per-call overrides are intentionally unsupported so runs stay reproducible.

## Usage

The parent model calls one primitive:

```ts
subagent({ agent: "reviewer", task: "review src/index.ts" })
subagent({ agent: "worker", task: "fix issue #12", background: true })
```

Use multiple tool calls for parallel read-only work. Wabi permits at most four concurrent children and rejects a second write-capable child while one is active. Sequential composition happens naturally as each result is handed back to the parent.

Workflow prompts:

```text
/work [--background] <task>
/review [--background] [scope]
```

`/review` defaults to the current working tree. For creative builds, ask the parent to delegate to `creative-worker`.

## Inspector

Open with `/subagents` or `Alt+S`.

- `↑` / `↓`: select a run
- `PgUp` / `PgDn`: scroll transcript
- `Ctrl+T`: show or hide thinking
- `s`, then `y`: stop a running child
- `Esc`: close

Completed runs remain inspectable for the current parent session; their widget row disappears after five seconds. Final handoffs are capped at 50 KB, while the inspector retains the session transcript.

## Install

```bash
./install.sh   # symlinks extension, agents, and prompts into ~/.pi/agent/
```

Run `/reload` in pi after installing.

When stable, install as a package with `pi install git:github.com/realmorrisliu/wabi`.

## Self-check

```bash
bun check.ts
```
