# wabi

Personal pi extension pack — subagents with tmux visibility, following 大道至简.

## What it is

A `subagent` tool for pi that delegates tasks to specialized agents, each running as a **visible `pi` instance in a detached tmux session** (`wabi-sub`) — the way the pi author practices it ("Spawn pi instances via tmux. Full observability, direct interaction."):

- Watch or interrupt any run: `tmux attach -t wabi-sub`
- Results are captured from JSONL output and returned to the main session with model + cost
- Recursion-blocked, read-only agents, no hidden background processes

## Agents (`~/.pi/agent/agents/`)

| agent | model | role |
|---|---|---|
| `scout` | deepseek-v4-flash | fast codebase recon → compressed findings |
| `planner` | qwen3.8-max | implementation plan (grills for clarifications when fuzzy, ponytail-minimal when clear) |
| `reviewer` | qwen3.8-max | two passes: correctness + ponytail-review complexity |

Change any agent's model/tools by editing its markdown frontmatter. No code changes needed.

## Usage

The main model calls the `subagent` tool with one of three modes:

- `{ agent: "reviewer", task: "review src/index.ts" }` — single
- `{ tasks: [{agent, task}, ...] }` — parallel (one tmux window each)
- `{ chain: [{agent: "scout", task: "..."}, {agent: "planner", task: "... based on {previous}"}] }` — sequential, `{previous}` passes the prior step's output

Optional overrides: `model`, `thinking`, `cwd`.

Workflow prompt: `/scout-and-plan` runs scout → planner as a chain.

## Install

```bash
./install.sh   # symlinks extension + agents + prompt into ~/.pi/agent/, then /reload in pi
```

When stable, install as a package: `pi install git:github.com/realmorrisliu/wabi` (this repo follows pi package conventions: `extensions/`, `prompts/`).

## Self-check

```bash
bun check.ts
```
