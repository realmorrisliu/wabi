# wabi

Personal pi configuration distribution — one bootstrap for a new machine, plus herdr setup. 大道至简.

On a new machine: install pi, clone this repo, run `./install.sh`. Done.

## What it installs

- [pi-subagents](https://github.com/nicobailon/pi-subagents) — the subagent runtime: `subagent` tool, builtin agents, fleet view, worktree isolation, native `fallbackModels`
- [ponytail](https://github.com/DietrichGebert/ponytail) — anti-over-engineering skills
- [@gotgenes/pi-github-tools](https://www.npmjs.com/package/@gotgenes/pi-github-tools) — deterministic GitHub CI tools (`ci_find`/`ci_watch`/`ci_list` with backoff + transient retry) replacing ad-hoc `gh` polling
- Custom extension `extensions/pr-review-threads.ts` — `pr_review_threads` tool: PR review comments with resolved/outdated state via live GraphQL (`gh pr view --comments` misses review threads)
- Custom skills in `~/.pi/agent/skills/` — both drive real CLI agents through herdr in isolated worktree panes (visible in the sidebar, user can jump in; results harvested via a written file, never screen-scraping):
  - `planner` — read-only research & plan for complex or uncertain tasks, via Codex CLI; plan lands in PLAN.md, the parent implements
  - `creative-worker` — creative/visual builds (web pages, 3D, prototypes) via Kimi Code CLI; results land in RESULT.md
- Prompt templates in `~/.pi/agent/prompts/`
- herdr official skill (`herdr --skill`, release-matched) and `herdr integration install pi`, when herdr is on PATH
- pi themes in `~/.pi/agent/themes/` (Kanagawa pair) + a settings seed that sets only `theme` to `kanagawa-lotus/kanagawa` (pi then follows terminal light/dark; the rest of settings.json is untouched)
- herdr (`herdr/config.toml`) and Ghostty (`ghostty/config`) theme configs — same Kanagawa pair, following macOS appearance; Ghostty also gets Maple Mono NF CN (font cask via brew) for powerline/icon/CJK coverage; installed when herdr/Ghostty is present, existing real files are backed up to `.bak`. On macOS, Ghostty's App Support config takes precedence over `~/.config`, so install strips `theme`/`window-theme` keys there (backed up) to keep wabi's theme winning — all other keys untouched

## Delegation

Specialist work goes to real CLI agents in herdr worktrees via the `planner` and `creative-worker` skills (see above). In-process subagents come from pi-subagents' builtins: `reviewer` for code review (inherits the session default model), `scout` for codebase recon, `researcher` for web research, `oracle` as decision advisor. For isolated in-process writing children use pi-subagents' `worktree: true`.

Prompt shortcut: `/review [--background] [scope]`.

## herdr

wabi doubles as the "use herdr well" layer: install.sh wires the official herdr skill and pi integration. Run pi inside herdr so agent sessions survive the laptop lid and restore after restarts.

## Verify

```bash
bun check.ts
```
