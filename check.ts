// check.ts — self-check for wabi's distribution files. Run: bun check.ts

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL(".", import.meta.url).pathname;
let failures = 0;

function check(name: string, ok: boolean): void {
	if (ok) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}`);
	}
}

function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const field = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
		if (field) fields[field[1]] = field[2].trim();
	}
	return fields;
}

// --- agents ---
const expected: Record<string, { model: string; fallback: string; thinking: string }> = {
	"research-plan": { model: "openai-codex/gpt-5.6-sol", fallback: "kimi-coding/kimi-k3", thinking: "max" },
	"creative-worker": { model: "kimi-coding/k3", fallback: "openai-codex/gpt-5.6-sol", thinking: "high" },
};

const agentFiles = readdirSync(join(repoRoot, "agents")).filter((f) => f.endsWith(".md"));
check("agents: exactly the 2 expected agents", agentFiles.sort().join(",") === "creative-worker.md,research-plan.md");

for (const [name, want] of Object.entries(expected)) {
	const fm = parseFrontmatter(readFileSync(join(repoRoot, "agents", `${name}.md`), "utf8"));
	check(`${name}: name/description/tools present`, fm.name === name && !!fm.description && !!fm.tools);
	check(`${name}: model + fallbackModels + thinking`, fm.model === want.model && fm.fallbackModels === want.fallback && fm.thinking === want.thinking);
	check(`${name}: inherits skills and project context`, fm.inheritSkills === "true" && fm.inheritProjectContext === "true");
}

// --- prompts ---
for (const file of readdirSync(join(repoRoot, "prompts")).filter((f) => f.endsWith(".md"))) {
	const fm = parseFrontmatter(readFileSync(join(repoRoot, "prompts", file), "utf8"));
	check(`prompt ${file}: has description`, !!fm.description);
}

// --- themes & app configs ---
for (const file of readdirSync(join(repoRoot, "themes")).filter((f) => f.endsWith(".json"))) {
	const theme = JSON.parse(readFileSync(join(repoRoot, "themes", file), "utf8"));
	check(`theme ${file}: name matches filename`, theme.name === file.replace(/\.json$/, ""));
}
check("ghostty config present", existsSync(join(repoRoot, "ghostty/config")));
// macOS App Support ghostty config (if any) must not override wabi's theme
for (const name of ["config", "config.ghostty"]) {
	const f = join(process.env.HOME ?? "", "Library/Application Support/com.mitchellh.ghostty", name);
	if (existsSync(f)) {
		check(`ghostty ${name}: no theme/window-theme override`, !/^(theme|window-theme)\s*=/m.test(readFileSync(f, "utf8")));
	}
}
check("herdr config present", existsSync(join(repoRoot, "herdr/config.toml")));

// --- extensions ---
for (const file of readdirSync(join(repoRoot, "extensions")).filter((f) => f.endsWith(".ts"))) {
	const src = readFileSync(join(repoRoot, "extensions", file), "utf8");
	check(`extension ${file}: registers a tool and has default export`, src.includes("registerTool") && src.includes("export default"));
}

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
