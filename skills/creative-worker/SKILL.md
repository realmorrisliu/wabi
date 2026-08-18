---
name: creative-worker
description: "Build visual/interactive artifacts (web pages, 3D, prototypes, visual pieces) by driving a real Kimi Code CLI session in an isolated herdr worktree pane. Use for creative/visual builds the user may want to watch or jump into. Requires HERDR_ENV=1. For structured results the parent must keep reasoning about, delegate to an in-process subagent instead."
---

# Creative Worker (herdr + kimi)

Delegate a creative/visual build to a real Kimi Code CLI session: visible in the herdr sidebar, isolated in its own git worktree, and survivable across detach/restart. The parent (you) frames the task, kimi builds, you harvest files — never screen-scrape the pane.

Requires running inside herdr: `test "${HERDR_ENV:-}" = 1`. If not inside herdr, say so and stop; do not silently do the build in-process. Read the `herdr` skill for command details; this file only fixes the workflow and the contract.

## Workflow

1. Create an isolated worktree + workspace, keeping the user's focus where it is:

   ```bash
   herdr worktree create --cwd "$PWD" --branch <short-task-slug> --no-focus
   ```

   Read the worktree path and root pane ID from the JSON response (workspace + pane are created for you).

2. Start kimi in that pane (name it `creative-<slug>`):

   ```bash
   herdr agent start creative-<slug> --kind kimi --pane <pane-id>
   ```

3. Hand off the task with this contract (single prompt, then wait):

   ```bash
   herdr agent prompt creative-<slug> "<task description>

   Contract:
   - Build everything inside your current directory (it is a dedicated git worktree).
   - Polished, production-grade output, not generic AI aesthetics. Prefer self-contained files unless the task requires a stack.
   - Run/verify what you build before finishing.
   - When done, write RESULT.md here: what you built, file list, how to run it, what you verified." --wait --timeout 600000
   ```

   Creative builds are long; 10 min is a floor, not a ceiling. If the wait returns `blocked`, read `herdr agent get`/`agent read` and surface the question to the user instead of answering for kimi.

4. Harvest. Read `<worktree>/RESULT.md` and inspect the files directly — kimi runs on the alternate screen, so pane reads lose scrollback. Report to the user: worktree path, what was built, how to run it, and the pane name (they can jump in and keep driving kimi themselves).

## Boundaries

- One worktree per task; never build in the user's checkout.
- Do not close the workspace when done — the user may want to continue the kimi session. Clean up only on explicit request (`herdr worktree remove --workspace <id>`).
- If kimi CLI is missing or fails to start, report it; do not substitute another agent kind without asking.
