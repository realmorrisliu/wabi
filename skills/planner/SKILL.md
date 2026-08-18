---
name: planner
description: "Research-and-plan specialist for complex or uncertain tasks — drives a real Codex CLI session in an isolated herdr worktree pane: it researches the codebase deeply and returns a concrete implementation plan in PLAN.md. Use before implementing anything complex or fuzzy. Requires HERDR_ENV=1."
---

# Planner (herdr + codex)

Delegate research and planning to a real Codex CLI session: visible in the herdr sidebar, isolated in its own git worktree, survivable across detach/restart. The parent (you) implements the plan; the planner never does. Harvest the plan from PLAN.md — never screen-scrape the pane.

Requires running inside herdr: `test "${HERDR_ENV:-}" = 1`. If not inside herdr, say so and stop. Read the `herdr` skill for command details; this file only fixes the workflow and the contract.

## Workflow

1. Create an isolated worktree + workspace, keeping the user's focus where it is:

   ```bash
   herdr worktree create --cwd "$PWD" --branch plan-<short-task-slug> --no-focus
   ```

   Read the worktree path and root pane ID from the JSON response.

2. Start codex in that pane, unattended and confined to the worktree:

   ```bash
   herdr agent start plan-<slug> --kind codex --pane <pane-id> -- --sandbox workspace-write --ask-for-approval never
   ```

3. Hand off the task with this contract (single prompt, then wait):

   ```bash
   herdr agent prompt plan-<slug> "<task description>

   Contract:
   - You are read-only for this repo: research deeply (read the files this task touches, trace the real flows, find existing helpers/patterns, verify assumptions) but NEVER edit project files and NEVER mutate git state.
   - The single file you may write is PLAN.md in your current directory.
   - If the task is fuzzy or underspecified, do not guess: PLAN.md holds a numbered list of clarifying questions, each with your recommended answer.
   - Otherwise PLAN.md holds the smallest plan that works: no speculative abstractions, no scaffolding, prefer stdlib and existing code. Name the files to touch and the order of changes, the key evidence behind the plan, risks, and the smallest verification step per stage." --wait --timeout 600000
   ```

   If the wait returns `blocked`, read `herdr agent get`/`agent read` and surface it to the user instead of answering for codex.

4. Harvest. Read `<worktree>/PLAN.md` — codex runs on the alternate screen, so pane reads lose scrollback. Relay clarifying questions to the user verbatim, or report the plan and implement it yourself. Mention the pane name so the user can jump in and keep refining the plan with codex.

## Boundaries

- The plan is the deliverable; never let the planner implement, and never implement from a pane scrape — PLAN.md only.
- One worktree per task; never write in the user's checkout.
- Do not close the workspace when done — the user may want to continue the codex session. Clean up only on explicit request (`herdr worktree remove --workspace <id>`).
- If codex CLI is missing or fails to start, report it; do not substitute another agent kind without asking.
