## Async work and waiting

- Do not use foreground `sleep`, `while ... sleep`, or repeated status checks solely to wait for another task.
- Do not use shell `timeout` as a substitute for background task management. Use it only as a safety deadline.
- For subagent work, prefer async/background execution. If the current turn does not depend on the result, continue independent work or end the turn.
- In interactive mode, do not call blocking `subagent_wait` merely to wait. Use it only when the user explicitly requires the current request to return the result; use an exact non-blocking subscription when a wake subscription is needed.
- For GitHub CI and release flows, prefer the existing `ci_find`, `ci_watch`, `release_pr_find`, and `release_watch` tools over ad-hoc `gh` polling loops. These tools may block one tool call, but do not create extra model polling turns.
- For a known future-time check, prefer `pi-subagents` scheduled runs over foreground sleep.
- If a finite shell command must run concurrently and no process-monitor extension is installed, use an async delegated child only as a fallback: run the command once, do not edit files unless explicitly asked, and return its exit status plus a bounded output tail.
- For this setup, use Herdr for persistent servers, long-running shell commands, and pane-level background work when the user has opted into Herdr. Use `pane run`, `pane wait-output`, and `pane read`; for Herdr agents use `agent prompt --wait` or `agent wait`.
- Do not repeatedly poll Herdr output when a wait command can express the condition.
- If Herdr is unavailable or not explicitly enabled for the task, state the limitation instead of silently choosing another background-terminal mechanism.
- Herdr provides process visibility and waiting but does not automatically resume the parent Pi turn. If automatic parent wakeup is required, use async `pi-subagents` completion notifications or an existing completion-aware tool.
- If no independent work remains, do not invent background infrastructure; run a finite command once in the foreground or end the turn.
