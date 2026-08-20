---
name: planner
description: "Plan complex or uncertain implementation work before coding: use Codex in an isolated Herdr worktree to research the repository and write PLAN.md for the parent Pi agent. Requires HERDR_ENV=1."
---

# Plan first

Use this skill when the task has architectural uncertainty, broad repository impact, or an unclear implementation path. Codex researches; the parent Pi agent implements. Codex runs in auto-approval mode inside the worktree sandbox by default. Never use this skill to hand off routine coding or bypass the sandbox.

Requires `HERDR_ENV=1`. If it is not set, stop and report that Herdr is unavailable. Read the `herdr` skill for command details.

## Steps

1. **Isolate.** Create a worktree without moving the user's focus:

   ```bash
   herdr worktree create --cwd "$PWD" --branch plan-<short-task-slug> --no-focus
   ```

   Read the JSON response and record the worktree path and root pane ID. Done when both values are known.

2. **Start Codex.** In the root pane, run:

   ```bash
   herdr agent start plan-<slug> --kind codex --pane <pane-id> -- --sandbox workspace-write --approve-for-me
   ```

   Done when the named Codex agent is running in the isolated worktree.

3. **Issue one research prompt and wait.** Send the task plus this contract:

   ```text
   Contract:
   - Research this repository deeply, but do not edit project files or mutate git state.
   - The only file you may write is PLAN.md in the current worktree.
   - If the task is underspecified, put numbered clarifying questions with recommended answers in PLAN.md.
   - Otherwise, put the smallest viable plan in PLAN.md: files and change order, evidence, risks, and one verification step for each stage.
   ```

   Use `herdr agent prompt plan-<slug> "<task and contract>" --wait --timeout 600000`. Done when the wait returns or reports `blocked`.

4. **Harvest the artifact.** Read `<worktree>/PLAN.md` directly; never use pane scrollback as the deliverable. If Codex is blocked, read its status and surface the question instead of guessing. Done when the parent has either the numbered questions or a complete plan with named files, risks, and verification steps.

## Rules

- Keep one worktree per plan and do not work in the user's checkout.
- Do not let Codex implement the plan; the parent Pi agent owns the changes.
- Leave the workspace open for the user. Remove it only on explicit request with `herdr worktree remove --workspace <id>`.
- If Codex is missing or cannot start, report the failure; do not silently substitute another agent.
