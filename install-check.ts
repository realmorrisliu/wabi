// install-check.ts — isolated install.sh verification against a throwaway HOME.
// install.sh symlinks into ~/.pi/agent; a temp HOME keeps this hermetic. The
// check pre-seeds stale artifacts from older wabi versions (worker/scout agents,
// /work and other retired prompts) and asserts the installed set is exactly the
// current one. Run: bun install-check.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, condition: boolean) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "wabi-install-home-"));
try {
	// Pre-existing stale state from an earlier wabi version.
	const agentsDir = join(home, ".pi", "agent", "agents");
	const promptsDir = join(home, ".pi", "agent", "prompts");
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(promptsDir, { recursive: true });
	for (const stale of ["worker.md", "scout.md"]) {
		symlinkSync(join(repoRoot, "agents", "planner.md"), join(agentsDir, stale));
	}
	for (const stale of ["work.md", "implement.md", "implement-and-review.md", "scout-and-plan.md"]) {
		symlinkSync(join(repoRoot, "prompts", "plan.md"), join(promptsDir, stale));
	}

	execFileSync("bash", ["install.sh"], { cwd: repoRoot, env: { ...process.env, HOME: home } });

	const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort();
	const prompts = readdirSync(promptsDir).filter((f) => f.endsWith(".md")).sort();
	check("install: agent set is exactly planner/reviewer/creative-worker", agents.join(",") === "creative-worker.md,planner.md,reviewer.md");
	check("install: stale worker/scout agents removed", !agents.includes("worker.md") && !agents.includes("scout.md"));
	check("install: /plan prompt installed, /work gone", prompts.includes("plan.md") && !prompts.includes("work.md"));
	check("install: retired prompts removed", !prompts.some((p) => ["implement.md", "implement-and-review.md", "scout-and-plan.md"].includes(p)));
} finally {
	rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} install check(s) FAILED`);
	process.exit(1);
}
console.log("\nall install checks passed");
