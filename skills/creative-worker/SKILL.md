---
name: creative-worker
description: "Build visual or interactive artifacts such as web pages, prototypes, or 3D pieces in an isolated Herdr worktree with Kimi; use when visual iteration is the specialist advantage and return RESULT.md. Requires HERDR_ENV=1."
---

# Build visually

Use this skill for a substantial visual or interactive build that benefits from Kimi's visual iteration. Keep small UI edits and routine frontend changes in the parent Pi agent. Kimi builds; the parent inspects and integrates.

Requires `HERDR_ENV=1`. If it is not set, stop and report that Herdr is unavailable. Read the `herdr` skill for command details.

## Steps

1. **Isolate.** Create a worktree without moving the user's focus:

   ```bash
   herdr worktree create --cwd "$PWD" --branch <short-task-slug> --no-focus
   ```

   Read the JSON response and record the worktree path and root pane ID. Done when both values are known.

2. **Start Kimi.** Name the workspace `creative-<slug>` and run:

   ```bash
   herdr agent start creative-<slug> --kind kimi --pane <pane-id>
   ```

   Done when the named Kimi agent is running in the isolated worktree.

3. **Issue one build prompt and wait.** Include the task plus this contract:

   ```text
   Contract:
   - Build inside the current dedicated worktree.
   - Produce polished, production-grade output rather than generic AI aesthetics.
   - Prefer self-contained files unless the task requires a stack.
   - Run and verify the result before finishing.
   - Write RESULT.md with what was built, the file list, how to run it, and what was verified.
   ```

   Use `herdr agent prompt creative-<slug> "<task and contract>" --wait --timeout 600000`. Done when the wait returns or reports `blocked`.

4. **Harvest and review.** Read `<worktree>/RESULT.md`, inspect the generated files and diff directly, and report the worktree path plus the run and verification instructions. If Kimi is blocked, read its status and surface the question instead of guessing. Done when the parent has reviewed the artifact and knows whether to integrate it.

## Rules

- Keep one worktree per build and do not build in the user's checkout.
- Do not close the workspace when done; remove it only on explicit request with `herdr worktree remove --workspace <id>`.
- If Kimi is missing or cannot start, report the failure; do not silently substitute another agent.
