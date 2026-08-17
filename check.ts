// check.ts — self-check for wabi's distribution files. Run: bun check.ts

import { readFileSync, readdirSync } from "node:fs";
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

// --- settings template ---
const settings = JSON.parse(readFileSync(join(repoRoot, "settings.json"), "utf8"));
check("settings: default model and packages", settings.defaultModel === "k3" && settings.packages?.includes("npm:pi-subagents") && settings.packages?.includes("git:github.com/DietrichGebert/ponytail"));

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
