---
name: herdr-dispatch
description: Manually dispatch a new task to a coding agent through Herdr in a fresh isolated worktree.
argument-hint: "agent, task, mode, execution, permissions, deliverable"
disable-model-invocation: true
---

# Herdr dispatch

This is a manual dispatch command. Invoke it as `/herdr-dispatch` when a new task must run through **Herdr + worktree**, not `pi-subagents`.

Never use `subagent`, `workflowScript`, `/run`, or a pi-subagents agent for this skill.

## Request format

Accept a structured block or ordinary prose. Normalize it to this contract before starting anything:

```text
agent: auto | <Herdr agent kind>
task: <one concrete task>
mode: plan | build | review | research
execution: auto | yolo | interactive
repository: <optional repository path; defaults to the current repo>
branch: <optional branch slug>
permissions: read-only | artifact-only | source-edit
artifact: <optional path, such as PLAN.md or RESULT.md>
wait: true | false
keep-workspace: true | false
```

Defaults:

- `agent: auto` when no agent is named; route with `agent_router`.
- A fresh worktree is always created.
- `execution: auto`.
- `wait: true`.
- `keep-workspace: true`.
- No commit, push, merge, release, or deletion unless explicitly requested.
- `permissions` follows the task only when unambiguous: planning/research/review is `read-only` or `artifact-only`; implementation/build/fix is `source-edit` inside the isolated worktree. Ask instead of guessing when the boundary is unclear.

The task must name an outcome, not just an activity. If it is missing a target, acceptance condition, or deliverable, ask one concise clarification before creating a worktree.

## Execution mode

`mode` describes the task; `execution` describes the agent's permission behavior. The default is `auto`, not `yolo`.

- `auto`: run unattended with the agent's normal sandbox and automatic routine approvals.
- `yolo`: only when explicitly requested; bypasses permission checks or sandboxing where the native CLI supports it.
- `interactive`: pass no permission-mode arguments and let the agent ask normally.

Pass native arguments after `--` in `herdr agent start`:

| Agent kind | `auto` | `yolo` |
| --- | --- | --- |
| `codex` | `--sandbox workspace-write --approve-for-me` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `--permission-mode auto` | `--dangerously-skip-permissions` |
| `kimi` | `--auto` | `--yolo` |
| `grok` | `--permission-mode auto` | `--permission-mode bypassPermissions` |
| `pi` | unsupported (`--approve` only trusts project files) | unsupported; do not claim yolo |

For any other kind, inspect its native `--help` output and establish an equivalent mode before starting. Do not silently launch an unknown kind interactively when `execution: auto` was requested. If a kind has no native autonomous mode, report that limitation and ask whether to continue interactively.

## Route selection

- If `agent` is explicit, honor it; do not re-route.
- If `agent: auto`, call `agent_router` with `action: "route"` and the concrete task. Use the returned recommendation only if it is eligible; an unknown or conditional quota is not proof of capacity.
- Use `action: "probe"` only when the user explicitly asks for a live quota check and only for an existing Herdr pane in `idle` or `done` state.
- If the route selects the `planner` or `creative-worker` skill, follow that skill's contract. Otherwise use the generic Herdr flow below. Do not silently substitute another agent when the selected kind cannot start.

## Execution

Read and follow the `herdr` skill before issuing Herdr commands. Stop if `HERDR_ENV` is not `1`.

1. Create the isolated worktree without taking focus:

   ```bash
   herdr worktree create --cwd "<repository-path>" --branch <branch-slug> --no-focus
   ```

   Read the JSON response. Use its returned worktree path, workspace ID, and root pane ID; never predict IDs.

2. Confirm the selected kind with the installed Herdr CLI when needed, then start a uniquely named agent in the returned root pane:

   ```bash
   herdr agent start <agent-name> --kind <agent-kind> --pane <root-pane-id> -- <native-mode-args>
   ```

   Use the execution-mode mapping above; omit the final `-- ...` for `interactive`. Keep user focus unchanged unless requested.

3. Send one complete prompt through the agent surface. Use `--wait --timeout 600000` when `wait: true`; otherwise submit without `--wait` and return the started status.

   ```bash
   herdr agent prompt <agent-name> "<task contract>" --wait --timeout 600000
   ```

4. If the result is `blocked` or waiting fails, inspect `herdr agent get` and `herdr agent read` before sending any follow-up. Surface approval or product questions instead of guessing.

5. When the agent settles, read the requested artifact if one was specified and inspect the diff directly. Pane scrollback is status/debug evidence, not the deliverable.

6. Report the agent name and kind, worktree path, workspace ID, branch, status, artifact path if any, validation result, and any remaining decision. Leave the workspace open unless `keep-workspace: false` was explicitly requested; then remove only the created workspace with `herdr worktree remove --workspace <workspace-id>` after harvesting its results.

## Prompt contract

Build the child prompt from the request and make the authority boundary explicit:

```text
Goal:
<context and concrete outcome>

Scope:
<files, symbols, or product boundary>

Allowed:
<read-only, artifact-only, or source edits in this worktree>

Forbidden:
<parent checkout edits, commits, pushes, releases, unrelated refactors>

Acceptance:
<observable conditions that must be true>

Validation:
<commands or checks to run>

Deliverable:
<artifact path or required final report>

Stop and ask the parent when:
<missing product decision, unsafe operation, or scope expansion>
```

Do not ask the child to choose another agent, create another worktree, or launch another dispatcher.

## Examples

Planning task:

```text
/herdr-dispatch
agent: codex
mode: plan
execution: auto
permissions: artifact-only
artifact: PLAN.md
task: Analyze the current authentication flow and propose the smallest implementation plan for refresh-token rotation. Do not modify source files or git state.
```

Visual build:

```text
/herdr-dispatch
agent: kimi
mode: build
execution: auto
permissions: source-edit
artifact: RESULT.md
task: Rework the settings page into a polished responsive interface. Preserve existing behavior, run the app, verify desktop and mobile layouts, and document the changed files and checks in RESULT.md.
```

Auto-route:

```text
/herdr-dispatch
agent: auto
mode: review
execution: auto
permissions: read-only
task: Review the current diff for correctness regressions and missing tests. Return findings with file and line references.
```
