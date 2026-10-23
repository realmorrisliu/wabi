# wabi

Personal Pi configuration for a **Herdr-first coding workflow**. 大道至简.

Install Pi and Herdr, clone this repository, then run `./install.sh`.
Requires Node.js 22.18+ and npm. GitHub tools use an authenticated `gh` CLI.
Run Pi inside Herdr for persistent sessions and visible terminal work.

## What it installs

- A local npm Pi runtime matching `pi --version`, used by detached subagents; the existing Pi executable is preserved.
- `pi-subagents@0.66.0` — independent reviews, focused delegation, and completion notifications. Delegate when it helps; ordinary edits need no agent pipeline.
- `@gotgenes/pi-github-tools@5.0.0` — deterministic GitHub CI/release tools.
- `pr_review_threads` — paginated live review state. Summaries include IDs, comment counts and links; `thread_id` retrieves the entire discussion without body truncation.
- `/review [--background] [scope]` — independent, read-only review. Defaults to staged, unstaged and untracked changes, and returns completed findings unless background execution is requested.
- `/simplify [scope]` — on-demand complexity review based on behavior and maintenance cost.
- Concise engineering and Herdr workflow instructions, installed as a managed block in `~/.pi/agent/APPEND_SYSTEM.md`, preserving other instructions.
- The installed Herdr release's official skill (`herdr --skill`) and Pi integration. Integration failures are reported as installation failures.
- A single bundled Pi theme, **Rosé Pine dark**, plus fixed dark Herdr/Ghostty defaults. No theme selector, synchronization, or live-reload extension.
- Default model: `deepseek/deepseek-flash`. Installation updates the model/provider while preserving unrelated settings, including thinking level and MCP extension exclusions.

## Installation and migration

The installer honors `PI_CODING_AGENT_DIR` and `XDG_CONFIG_HOME`. Prompts, the review extension/helper, and the Pi theme link to this checkout; keep it in place.

Existing independent Herdr/Ghostty configs and custom Pi themes are preserved. New app configs are seeded from the repository. Former wabi app-config links become independent copies. Replaced files are backed up with `.bak.<timestamp>.<pid>` suffixes. The Ghostty template uses Maple Mono NF CN; install that font separately if desired.

The old theme-sync links and retired wabi skills/router links are removed only when they point to this checkout. Old wabi-managed Pi themes migrate to Rosé Pine. Ponytail's former Git package registration is removed from settings, disabling its automatic rules and bundled skills; cached package files are left alone. Its complexity-review purpose is covered by `/simplify`.

The installer does not rewrite macOS Ghostty App Support overrides or unrelated desktop settings. If Herdr is absent, it warns and installs the Pi portion; rerun after installing Herdr.

Restart Pi or run `/reload` after installation. Use `/subagents-doctor` to diagnose delegation in the running Pi session. Consult the installed subagent guide for current tool syntax and runtime requirements.

## Verify and update

```bash
node --experimental-strip-types --test tests/*.test.ts
node --experimental-strip-types check.ts
bash -n install.sh
```

Direct package versions are pinned in `install.sh`; update them deliberately and rerun verification. Herdr's skill is refreshed from the installed binary whenever the installer runs. Local tests cover distribution checks, installation migration, and GitHub pagination; they do not substitute for live provider/delegation checks.

Theme attribution: [themes/THIRD-PARTY.md](themes/THIRD-PARTY.md).
