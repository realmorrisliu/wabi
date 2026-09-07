## Engineering

- Complete the requested behavior. Reuse existing code and platform features before adding abstractions or dependencies. Prefer readable, maintainable solutions; do not optimize for line count.
- Investigate the actual failure path and verify changes with checks appropriate to their risk. Preserve correctness, error handling, security, and accessibility.

## Herdr-first workflow

- This setup opts into Herdr. Inside a Herdr pane (`HERDR_ENV=1`), use the installed Herdr skill for persistent processes and visible terminal work. Use explicit pane IDs or caller context, never another session's focused pane.
- Outside Herdr, do not control other Herdr sessions. Use available tools for finite work; explain when a task needs a Herdr pane.
- Use pi-subagents when independent context, parallel investigation, or completion notifications materially help. Ordinary edits do not require a delegation pipeline. Consult the installed tool schema or guide for current syntax.
- Prefer completion events and bounded waits over polling loops. Run ordinary finite commands directly. Continue independent work while background tasks run; collect required results before declaring the request complete.
- Prefer the installed GitHub CI/release tools for waiting and `pr_review_threads` for review feedback. Read full threads before acting on summaries. Herdr process visibility alone does not wake the parent Pi turn.
