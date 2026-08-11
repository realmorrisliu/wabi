// Offline extension load smoke: registers wabi's subagent tool against a stub API.
// Run: bun smoke.ts
//
// The extension imports packages pi provides as virtual modules (typebox,
// @earendil-works/*). Outside pi those resolve from the pi install's nested
// node_modules, so this script discovers that path, re-executes itself with
// NODE_PATH set, and then runs the real checks below.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findPiNodeModules(): string | undefined {
	try {
		const bin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		let dir = dirname(realpathSync(bin));
		while (dir !== dirname(dir)) {
			if (existsSync(join(dir, "node_modules", "typebox"))) return join(dir, "node_modules");
			dir = dirname(dir);
		}
	} catch {
		/* not installed; fall through to plain resolution */
	}
	return undefined;
}

if (!process.env.WABI_SMOKE_RUNNER) {
	const nodeModules = findPiNodeModules();
	if (nodeModules && !(process.env.NODE_PATH ?? "").split(":").includes(nodeModules)) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
			env: { ...process.env, NODE_PATH: nodeModules, WABI_SMOKE_RUNNER: "1" },
			stdio: "inherit",
		});
		process.exit(result.status ?? 1);
	}
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const { default: registerExtension } = await import("./extensions/subagents/index.ts");

let failures = 0;
function check(name: string, condition: boolean) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

const registered: Record<string, any> = {};
const stub = {
	registerTool: (tool: unknown) => void (registered.tool = tool),
	registerMessageRenderer: (type: unknown) => void (registered.renderer = type),
	registerCommand: (name: unknown) => void (registered.command = name),
	registerShortcut: (key: unknown) => void (registered.shortcut = key),
	on: (event: unknown, handler: unknown) => void ((registered.handlers ??= {})[String(event)] = handler),
} as unknown as ExtensionAPI;

registerExtension(stub);

const tool = registered.tool as { name?: string; description?: string; promptGuidelines?: string[] } | undefined;
check("extension loads and registers the subagent tool", tool?.name === "subagent");
check("every prompt guideline names subagent", (tool?.promptGuidelines?.length ?? 0) > 0 && (tool?.promptGuidelines ?? []).every((guideline) => guideline.includes("subagent")));
check("guidelines: two no-output failures mean outage — stop, probe, degraded mode", (tool?.promptGuidelines ?? []).some((g) => g.includes("infrastructure outage") && g.includes("health probe") && g.includes("degraded mode")));
check("guidelines: failed reviewer is not a review", (tool?.promptGuidelines ?? []).some((g) => g.includes("reviewer run is not a review")));
check("guidelines: no parent take-over of non-atomic worker tasks after two failures", (tool?.promptGuidelines ?? []).some((g) => g.includes("do not take the task over in the parent")));
check("tool description states background is read-only only", tool?.description?.includes("read-only agents only") ?? false);
check("completion renderer, inspector surface, and session handlers wired at load", Boolean(registered.renderer) && Boolean(registered.command) && Boolean(registered.shortcut) && typeof (registered.handlers as Record<string, unknown>)?.session_start === "function" && typeof (registered.handlers as Record<string, unknown>)?.session_shutdown === "function");

// Fake lifecycle: with no active runs, session shutdown must settle and clear the widget.
const handlers = registered.handlers as Record<string, unknown>;
const shutdown = handlers.session_shutdown as ((event: unknown, ctx: { ui: { setWidget: (key: string, value: unknown) => void } }) => Promise<void>) | undefined;
const widgetClears: string[] = [];
const shutdownSettled = typeof shutdown === "function"
	? await shutdown({}, { ui: { setWidget: (key: string, value: unknown) => { if (value === undefined) widgetClears.push(key); } } }).then(() => true).catch(() => false)
	: false;
check("shutdown: fake lifecycle settles and clears the widget", shutdownSettled && widgetClears.includes("wabi-subagents"));

if (failures > 0) {
	console.error(`\n${failures} smoke check(s) FAILED`);
	process.exit(1);
}
console.log("\nall smoke checks passed");
