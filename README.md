# wabi

Personal pi configuration distribution — one bootstrap for a new machine, plus herdr setup. 大道至简.

On a new machine: install pi, clone this repo, run `./install.sh`. Done.

## What it installs

- [pi-subagents](https://github.com/nicobailon/pi-subagents) — the subagent runtime: `subagent` tool, builtin agents, fleet view, worktree isolation, native `fallbackModels`
- [ponytail](https://github.com/DietrichGebert/ponytail) — anti-over-engineering skills
- [@gotgenes/pi-github-tools](https://www.npmjs.com/package/@gotgenes/pi-github-tools) — deterministic GitHub CI tools (`ci_find`/`ci_watch`/`ci_list` with backoff + transient retry) replacing ad-hoc `gh` polling
- Custom extension `extensions/pr-review-threads.ts` — `pr_review_threads` tool: PR review comments with resolved/outdated state via live GraphQL (`gh pr view --comments` misses review threads)
- Custom extension `extensions/agent-router.ts` — detects Pi/Claude/Codex/Kimi/Grok through PATH, auth checks, Herdr state, cached quota probes, and capability-based routing (`agent_router`, `/agents`)
- Custom skills in `~/.pi/agent/skills/`:
  - `agent-routing` — keeps the main Pi agent as the default implementer and defines when/how to delegate difficult specialist subtasks
  - `planner` — read-only research & plan for complex or uncertain tasks, via Codex CLI; plan lands in PLAN.md, the parent implements
  - `creative-worker` — creative/visual builds (web pages, 3D, prototypes) via Kimi Code CLI in an isolated herdr worktree; results land in RESULT.md
- Prompt templates in `~/.pi/agent/prompts/`
- herdr official skill (`herdr --skill`, release-matched) and `herdr integration install pi`, when herdr is on PATH
- shared `theme-pairs.json` registry + `/theme` command: choose one light/dark pair and update Pi, Herdr, and Ghostty together; each app then follows system appearance natively
- bundled Pi themes in `~/.pi/agent/themes/` for all six pairs; installation seeds the default pair only when no Pi theme is configured, preserving the rest of `settings.json`
- herdr (`herdr/config.toml`) and Ghostty (`ghostty/config`) theme configs — default to the Catppuccin pair and follow macOS appearance; Ghostty also gets Maple Mono NF CN (font cask via brew) for powerline/icon/CJK coverage; installed when herdr/Ghostty is present, existing real files are backed up to `.bak`. On macOS, Ghostty's App Support config takes precedence over `~/.config`, so install strips `theme`/`window-theme` keys there (backed up) to keep wabi's theme winning — all other keys untouched

## Theme pairs

Bundled pairs: **Kanagawa**, **Catppuccin**, **Tokyo Night**, **Rosé Pine**, **Gruvbox**, and **Solarized**. Pi theme attributions are in [`themes/THIRD-PARTY.md`](themes/THIRD-PARTY.md).

```text
/theme              # choose interactively
/theme kanagawa     # select directly
/theme catppuccin
/theme list
/theme status
```

The selector writes the symlink targets managed by this repository, validates Herdr/Ghostty configs, reloads Herdr, requests Ghostty's macOS config reload, and reloads Pi so its native light/dark listener remains active.

## Delegation

Specialist work goes to real CLI agents in herdr worktrees via the `planner` and `creative-worker` skills (see above). In-process subagents come from pi-subagents' builtins: `reviewer` for code review (inherits the session default model), `scout` for codebase recon, `researcher` for web research, `oracle` as decision advisor. For isolated in-process writing children use pi-subagents' `worktree: true`.

Prompt shortcut: `/review [--background] [scope]`.

## herdr

wabi doubles as the "use herdr well" layer: install.sh wires the official herdr skill and pi integration. Run pi inside herdr so agent sessions survive the laptop lid and restore after restarts.

## Agent router

One command handles configuration, inventory, routing, and quota:

```text
/agents
```

With no argument it opens a checkbox-style settings panel. Toggle agents with the space/enter controls and close the panel to save.

Non-interactive forms:

```text
/agents status
/agents route 重构认证模块并补测试
/agents quota
/agents quota probe claude [pane-id]
/agents list
/agents enable claude codex
/agents disable grok
/agents set claude,kimi
/agents reset
```

Optional global overrides live at `~/.pi/agent/agent-router.json` (or `$PI_AGENT_ROUTER_CONFIG`):

```json
{
  "enabledAgents": ["pi", "claude", "codex", "kimi"],
  "minRemainingPercentage": 15,
  "profiles": {
    "kimi": { "tags": ["chinese", "documentation", "research"], "priority": 5 }
  }
}
```

The router does not start agents or dispatch code yet; it returns a recommendation and preserves unknown quota as conditional rather than pretending it is sufficient.

## Verify

```bash
bun test tests/*.test.ts
bun check.ts
```
