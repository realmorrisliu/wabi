# wabi

Personal Pi configuration for a **Herdr-first coding workflow**. 大道至简.

Install Pi and Herdr, clone this repository, then run `./install.sh`.
Requires Node.js 22.18+ and npm. GitHub tools use an authenticated `gh` CLI.
Run Pi inside Herdr for persistent sessions and visible terminal work.

## What it installs

- A local npm Pi runtime matching `pi --version`, used by detached subagents; the existing Pi executable is preserved.
- `pi-subagents@0.66.0` — independent reviews, focused delegation, and completion notifications. Delegate when it helps; ordinary edits need no agent pipeline.
- [ponytail](https://github.com/DietrichGebert/ponytail) — anti-over-engineering rules and skills, including `ponytail-audit` for whole-repo audits.
- `@gotgenes/pi-github-tools@5.0.0` — deterministic GitHub CI/release tools.
- `pi-commandcode-provider@0.7.11` — the `commandcode` provider the default model runs on.
- `pr_review_threads` — paginated live review state. Summaries include IDs, comment counts and links; `thread_id` retrieves the entire discussion without body truncation.
- `/review [--background] [scope]` — independent, read-only review. Defaults to staged, unstaged and untracked changes, and returns completed findings unless background execution is requested.
- Concise engineering and Herdr workflow instructions, installed as a managed block in `~/.pi/agent/APPEND_SYSTEM.md`, preserving other instructions.
- The installed Herdr release's official skill (`herdr --skill`) and Pi integration. Integration failures are reported as installation failures.
- A single bundled Pi theme, **Rosé Pine dark**, plus fixed dark Herdr/Ghostty defaults. No theme selector, synchronization, or live-reload extension.
- Default model: `commandcode` / `deepseek/deepseek-v4.1-flash` at thinking level `high`. Installation migrates the previous wabi default (`deepseek` / `deepseek-flash`) and leaves a model you chose yourself alone.
- The `-builtin:mcp` extension exclusion is removed: it disables every MCP server in a session while `pi mcp list` still reports a connection.

## Installation and migration

The installer honors `PI_CODING_AGENT_DIR` and `XDG_CONFIG_HOME`. Prompts, the review extension/helper, and the Pi theme link to this checkout; keep it in place.

Existing independent Herdr/Ghostty configs and custom Pi themes are preserved. New app configs are seeded from the repository. Former wabi app-config links become independent copies. Replaced files are backed up with `.bak.<timestamp>.<pid>` suffixes. The Ghostty template uses Maple Mono NF CN; install that font separately if desired.

The old theme-sync links, the retired `/simplify` prompt, and retired wabi skills/router links are removed only when they point to this checkout. Old wabi-managed Pi themes migrate to Rosé Pine. The Ponytail Git package registration is preserved.

The installer does not rewrite macOS Ghostty App Support overrides or unrelated desktop settings. If Herdr is absent, it warns and installs the Pi portion; rerun after installing Herdr.

Restart Pi or run `/reload` after installation. Use `/subagents-doctor` to diagnose delegation in the running Pi session. Consult the installed subagent guide for current tool syntax and runtime requirements.

## Cua Driver (optional)

When `cua-driver` is on `PATH`, the installer adds its MCP server to `~/.pi/agent/mcp.json` as `cua-driver` (`args: ["mcp"]`, `exposure: "deferred"`), keeps your other servers, and leaves a `cua-driver` entry you wrote yourself untouched. The driver itself is not installed here:

```bash
curl -fsSL https://cua.ai/driver/install.sh | bash   # macOS and Linux; see cua.ai/docs for Windows
cua-driver permissions grant                          # macOS: switch on Accessibility and Screen Recording
./install.sh                                          # wires the MCP server
```

Tools arrive through `tool_search`, and the driver's own skill lands in `~/.agents/skills/cua-driver`. Cua's docs still say Pi has no MCP support, so `cua-driver mcp-config --client pi` offers a CLI-only setup; register the server as above instead. The daemon starts on demand, and the default `standard` permission mode lets it send input to every app.

## Verify and update

```bash
node --experimental-strip-types --test tests/*.test.ts
node --experimental-strip-types check.ts
bash -n install.sh
```

Direct package versions are pinned in `install.sh`; update them deliberately and rerun verification. Herdr's skill is refreshed from the installed binary whenever the installer runs. Local tests cover distribution checks, installation migration, and GitHub pagination; they do not substitute for live provider/delegation checks.

Three Pi behaviors that look like configuration bugs:

- Defaults change only through `Ctrl+S` in `/model` and `/thinking`. Switching inside a session changes that session, and `PI_MODEL`/`PI_PROVIDER` follow it, so the environment can look right while new sessions keep the old default.
- `/reload` reloads extensions, MCP servers and resources; it does not re-resolve the running session's model or thinking level.
- `pi mcp list` always uses the built-in implementation, so it can report a connected server that a session never sees (see the `-builtin:mcp` note above).

Theme attribution: [themes/THIRD-PARTY.md](themes/THIRD-PARTY.md).
