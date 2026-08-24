# wabi

Personal pi configuration distribution — one bootstrap for a new machine, plus herdr setup. 大道至简.

On a new machine: install pi, clone this repo, run `./install.sh`. Done.

## What it installs

- [pi-subagents](https://github.com/nicobailon/pi-subagents) — the subagent runtime: `subagent` tool, builtin agents, fleet view, worktree isolation, native `fallbackModels`
- [ponytail](https://github.com/DietrichGebert/ponytail) — anti-over-engineering skills
- [@gotgenes/pi-github-tools](https://www.npmjs.com/package/@gotgenes/pi-github-tools) — deterministic GitHub CI tools (`ci_find`/`ci_watch`/`ci_list` with backoff + transient retry) replacing ad-hoc `gh` polling
- Custom extension `extensions/pr-review-threads.ts` — `pr_review_threads` tool: PR review comments with resolved/outdated state via live GraphQL (`gh pr view --comments` misses review threads)
- Prompt templates in `~/.pi/agent/prompts/`
- herdr official skill (`herdr --skill`, release-matched) and `herdr integration install pi`, when herdr is on PATH
- shared `theme-pairs.json` registry + `/theme` command: choose one dark theme pair and update Pi, Herdr, and Ghostty together; all three stay dark regardless of system appearance
- bundled Pi themes in `~/.pi/agent/themes/` for all six pairs; installation seeds the default dark pair when no Pi theme is configured and migrates wabi auto-pairs, preserving the rest of `settings.json`
- herdr (`herdr/config.toml`) and Ghostty (`ghostty/config`) theme configs — default to the dark Catppuccin pair and ignore macOS appearance; Ghostty also gets Maple Mono NF CN (font cask via brew) for powerline/icon/CJK coverage; installed when herdr/Ghostty is present, existing real files are backed up to `.bak`. On macOS, Ghostty's App Support config takes precedence over `~/.config`, so install strips `theme`/`window-theme` keys there (backed up) to keep wabi's theme winning — all other keys untouched

## Theme pairs

Bundled pairs: **Kanagawa**, **Catppuccin**, **Tokyo Night**, **Rosé Pine**, **Gruvbox**, and **Solarized**. Pi theme attributions are in [`themes/THIRD-PARTY.md`](themes/THIRD-PARTY.md).

```text
/theme              # choose interactively
/theme kanagawa     # select directly
/theme catppuccin
/theme list
/theme status
```

The selector writes the symlink targets managed by this repository, applies the selected pair's dark variant, validates Herdr/Ghostty configs, reloads Herdr, requests Ghostty's macOS config reload, and reloads Pi.

## herdr

wabi doubles as the "use herdr well" layer: install.sh wires the official herdr skill and pi integration. Run pi inside herdr so agent sessions survive the laptop lid and restore after restarts.

## Verify

```bash
bun test tests/*.test.ts
bun check.ts
```
