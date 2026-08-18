# wabi

Personal pi configuration distribution — one bootstrap for a new machine, plus herdr setup. 大道至简.

On a new machine: install pi, clone this repo, run `./install.sh`. Done.

## What it installs

- [pi-subagents](https://github.com/nicobailon/pi-subagents) — the subagent runtime: `subagent` tool, builtin agents, fleet view, worktree isolation, native `fallbackModels`
- [ponytail](https://github.com/DietrichGebert/ponytail) — anti-over-engineering skills
- [@gotgenes/pi-github-tools](https://www.npmjs.com/package/@gotgenes/pi-github-tools) — deterministic GitHub CI tools (`ci_find`/`ci_watch`/`ci_list` with backoff + transient retry) replacing ad-hoc `gh` polling
- Custom extension `extensions/pr-review-threads.ts` — `pr_review_threads` tool: PR review comments with resolved/outdated state via live GraphQL (`gh pr view --comments` misses review threads)
- Custom agents in `~/.pi/agent/agents/` (pi-subagents user agents; a user agent shadows a builtin of the same name)
- Prompt templates in `~/.pi/agent/prompts/`
- herdr official skill (`herdr --skill`, release-matched) and `herdr integration install pi`, when herdr is on PATH
- pi themes in `~/.pi/agent/themes/` (Kanagawa pair) + a settings seed that sets only `theme` to `kanagawa-lotus/kanagawa` (pi then follows terminal light/dark; the rest of settings.json is untouched)
- herdr (`herdr/config.toml`) and Ghostty (`ghostty/config`) theme configs — same Kanagawa pair, following macOS appearance; installed when herdr/Ghostty is present, existing real files are backed up to `.bak`

## Agents

| agent | model | fallback | role |
|---|---|---|---|
| `research-plan` | openai-codex/gpt-5.6-sol (max) | kimi-coding/kimi-k3 | read-only research & plan for complex or uncertain tasks |
| `creative-worker` | kimi-coding/k3 (high) | openai-codex/gpt-5.6-sol | web pages, 3D, visual builds |

Review uses pi-subagents' builtin `reviewer` (inherits the session default model).

Agents share the parent's working directory (pi-subagents has no clone isolation): read-only agents are read-only by policy and prompt — never write files, never mutate git state. For isolated writing children use pi-subagents' `worktree: true`.

Prompt shortcuts: `/research-plan <task>`, `/review [--background] [scope]`.

## herdr

wabi doubles as the "use herdr well" layer: install.sh wires the official herdr skill and pi integration. Run pi inside herdr so agent sessions survive the laptop lid and restore after restarts.

## Verify

```bash
bun check.ts
```
