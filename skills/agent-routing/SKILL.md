---
name: agent-routing
description: "Route before delegating external agent work, or when deciding whether a task needs specialist help; keep the main Pi agent as owner and delegate only difficult, uncertain, specialist, visual, or parallel subtasks through agent_router."
---

# Route before delegate

The main Pi agent owns the requirements, implementation, integration, and final verification. Use this skill to decide whether delegation earns its cost; `agent_router` is advisory and does not start an agent.

## Steps

1. **Own routine work.** Stay in Pi for clear local changes, normal coding, tests, documentation, and small-to-medium fixes. Done when the task can be completed correctly without a distinct specialist advantage.
2. **Name the subtask.** Delegate only a narrow, reviewable unit that is difficult or uncertain, needs specialist research or visual iteration, or can run independently in parallel. Done when the subtask has one owner, one deliverable, and an explicit boundary.
3. **Preflight.** Call `agent_router` with `action: "route"` and the concrete subtask (use `action: "inventory"` when availability itself is unknown). Treat the configured profiles and returned recommendation as the capability source of truth; do not maintain a second agent matrix here. Done when installation, authentication, enabled state, live status, and quota condition are recorded; never turn a conditional quota into an eligible claim.
4. **Choose a contract.** Use `planner` for Codex read-only repository research that returns `PLAN.md`; use `creative-worker` for Kimi visual/interactive builds that return `RESULT.md`. For any other external dispatch, do not invent an automatic workflow: report the recommendation and get the user's approval before starting it. Done when the handoff scope, worktree, artifact, and verification command are explicit.
5. **Integrate.** Read the returned artifact, inspect the files or diff directly, make the final changes in Pi, and run the relevant checks. Done when the parent Pi agent has reviewed the result and the final verification passes.

## Capacity and safety

- Unknown quota is **conditional**, never evidence of capacity.
- Use `agent_router` with `action: "probe"` only for an explicit live quota check and only on an existing Herdr pane whose state is `idle` or `done`; never interrupt a working pane.
- Herdr operations require `HERDR_ENV=1`. If Herdr is unavailable, continue in Pi or explain the limitation.
- Disabled agents stay out of routing. Do not delegate secrets, destructive operations, or final release decisions without explicit approval.
- Keep delegated work isolated; do not close its worktree until the user asks.
