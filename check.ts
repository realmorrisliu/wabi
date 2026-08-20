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
for (const file of readdirSync(join(repoRoot, "extensions")).filter((f) => f.endsWith(".ts") && !f.endsWith("-core.ts"))) {
	const src = readFileSync(join(repoRoot, "extensions", file), "utf8");
	check(`extension ${file}: registers a tool and has default export`, src.includes("registerTool") && src.includes("export default"));
}

// --- skills ---
for (const dir of readdirSync(join(repoRoot, "skills"))) {
	const fm = parseFrontmatter(readFileSync(join(repoRoot, "skills", dir, "SKILL.md"), "utf8"));
	check(`skill ${dir}: name/description present`, fm.name === dir && !!fm.description);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
