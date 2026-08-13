// Offline extension load smoke: registers wabi's subagent tool against a stub API.
// Run: bun smoke.ts
//
// The extension imports packages pi provides as virtual modules (typebox,
// @earendil-works/*). Outside pi those resolve from the pi install's nested
// node_modules, so this script discovers that path, re-executes itself with
// NODE_PATH set, and then runs the real checks below.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { OWNER_MARKER_NAME, readonlyRunsRoot, runDirName } from "./extensions/subagents/cleanup.ts";

// Hermetic agent set: point the extension's agent dir (PI_CODING_AGENT_DIR,
// honored by getAgentDir) at a temp dir with this repo's agents symlinked in,
// so discoverAgents sees exactly planner/reviewer/creative-worker — never the
// installed global agent dir, which can lag or carry stale (dangling) agents.
// Auth/models/runs-archive paths follow the same temp dir and never touch the
// user's real agent dir. Set BEFORE the extension registers.
const smokeAgentDir = mkdtempSync(join(tmpdir(), "wabi-smoke-agent-"));
const smokeAgentsDir = join(smokeAgentDir, "agents");
mkdirSync(smokeAgentsDir);
for (const entry of readdirSync(join(dirname(fileURLToPath(import.meta.url)), "agents"))) {
	if (!entry.endsWith(".md")) continue;
	symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "agents", entry), join(smokeAgentsDir, entry));
}
process.env.PI_CODING_AGENT_DIR = smokeAgentDir;
process.on("exit", () => rmSync(smokeAgentDir, { recursive: true, force: true }));
const { default: registerExtension, boxPanel } = await import("./extensions/subagents/index.ts");

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
	sendMessage: (message: unknown) => void (registered.messages ??= []).push(message),
} as unknown as ExtensionAPI;

registerExtension(stub);

// boxPanel width contract: panel total width equals the requested width for short, long, ANSI, and wide-char content; borders never drift.
{
	const id = (text: string) => text;
	const short = boxPanel(["a", "bb"], 8, id, id);
	const long = boxPanel(["abcdefghij"], 8, id, id);
	const ansi = boxPanel(["\u001b[31mred\u001b[39m"], 8, id, id);
	const wide = boxPanel(["中中"], 8, id, id);
	const mixed = boxPanel(["a中中a"], 8, id, id); // overlong mixed-width: truncation must stay inside the budget
	const degenerate = boxPanel(["abc"], 2, id, id);
	check("boxPanel: total width equals the requested width for short content", short.length === 4 && short[0] === "╭──────╮" && short[1] === "│ a    │" && short[3] === "╰──────╯");
	check("boxPanel: over-long content is truncated to the content budget", visibleWidth(long[1]) === 8 && long[1].endsWith("│"));
	check("boxPanel: ANSI-styled and wide-char content keeps the panel width", visibleWidth(ansi[1]) === 8 && visibleWidth(wide[1]) === 8);
	check("boxPanel: overlong mixed-width content stays within the budget", visibleWidth(mixed[1]) === 8 && mixed[1].endsWith("│"));
	check("boxPanel: below 3 columns the border is dropped, content stays in width", degenerate.length === 1 && visibleWidth(degenerate[0]) === 2);
}

const tool = registered.tool as { name?: string; description?: string; promptGuidelines?: string[] } | undefined;
check("extension loads and registers the subagent tool", tool?.name === "subagent");
check("every prompt guideline names subagent", (tool?.promptGuidelines?.length ?? 0) > 0 && (tool?.promptGuidelines ?? []).every((guideline) => guideline.includes("subagent")));
check("guidelines: two no-output failures mean outage — stop, probe, degraded mode", (tool?.promptGuidelines ?? []).some((g) => g.includes("infrastructure outage") && g.includes("health probe") && g.includes("degraded mode")));
check("guidelines: failed reviewer is not a review", (tool?.promptGuidelines ?? []).some((g) => g.includes("reviewer run is not a review")));
check("guidelines: no blind retry of a delegated task after two failures", (tool?.promptGuidelines ?? []).some((g) => g.includes("do not blindly retry") && g.includes("report the blocker") && g.includes("replan")));
check("tool description states background is read-only only", tool?.description?.includes("read-only agents only") ?? false);
check("completion renderer, inspector surface, and session handlers wired at load", Boolean(registered.renderer) && Boolean(registered.command) && Boolean(registered.shortcut) && typeof (registered.handlers as Record<string, unknown>)?.session_start === "function" && typeof (registered.handlers as Record<string, unknown>)?.session_shutdown === "function");

// Background completion steering: with a fast stub `pi` child on PATH (emits one
// completed message_end, exits 0), clone preparation still runs against a real Git
// workspace and the spawned stub completes quickly. The tool call must return
// Started (throwing nothing), and the result must then steer back via sendMessage
// with success details — proving the launch-time suppression is lifted only after
// the child truly starts. Runs FIRST because the fail-closed launches below are two
// consecutive no-output failures that trip the shared circuit and would block it.
const completionRepoCwd = mkdtempSync(join(tmpdir(), "wabi-smoke-repo-"));
const fakeBinDir = mkdtempSync(join(tmpdir(), "wabi-smoke-bin-"));
try {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: completionRepoCwd });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: completionRepoCwd });
	execFileSync("git", ["config", "user.name", "t"], { cwd: completionRepoCwd });
	writeFileSync(join(completionRepoCwd, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: completionRepoCwd });
	execFileSync("git", ["commit", "-qm", "c1"], { cwd: completionRepoCwd });
	writeFileSync(
		join(fakeBinDir, "pi"),
		`#!/bin/sh\nprintf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"stub result"}],"stopReason":"stop"}}'\nexit 0\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
	const execute = (registered.tool as { execute?: Function }).execute;
	const stubCtx = { cwd: completionRepoCwd, mode: "rpc", isProjectTrusted: () => false, ui: { setWidget: () => {} } };
	let error: unknown;
	let result: unknown;
	try {
		result = await execute?.("t4", { agent: "planner", task: "probe", background: true }, undefined, undefined, stubCtx);
	} catch (caught) {
		error = caught;
	}
	process.env.PATH = (process.env.PATH ?? "").replace(`${fakeBinDir}:`, "");
	const startedText = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content?.[0]?.text ?? "";
	check("background completion: tool call returns Started and throws nothing", error === undefined && startedText.includes("Started"));
	let steered: any;
	const deadline = Date.now() + 5000;
	while (!steered && Date.now() < deadline) {
		steered = (registered.messages ?? []).find((m: any) => m?.customType === "wabi-subagent-complete" && m?.details?.success === true);
		if (!steered) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	check("background completion: result steered back via sendMessage with success details", Boolean(steered) && String(steered.content).includes("status: completed"));
} finally {
	rmSync(completionRepoCwd, { recursive: true, force: true });
	rmSync(fakeBinDir, { recursive: true, force: true });
}

// Extension-integration fail-closed path: launching a read-only agent (planner) with a
// non-Git cwd must fail closed with the bounded handoff — never spawn a child, never
// fall back to the shared cwd, and never leak raw git stderr into the handoff.
const nonGitCwd = mkdtempSync(join(tmpdir(), "wabi-smoke-"));
try {
	const execute = (registered.tool as { execute?: Function }).execute;
	const stubCtx = {
		cwd: nonGitCwd,
		mode: "json",
		isProjectTrusted: () => false,
		ui: { setWidget: () => {} },
	};
	let error: unknown;
	try {
		await execute?.("t1", { agent: "planner", task: "probe" }, undefined, undefined, stubCtx);
	} catch (caught) {
		error = caught;
	}
	const message = error instanceof Error ? error.message : String(error);
	check("fail-closed: non-Git cwd rejects the run with the bounded handoff", typeof execute === "function" && message.includes("providerError: present") && message.includes("status: failed"));
	check("fail-closed: no raw git stderr leaks into the model-visible handoff", !message.includes("fatal:") && !message.includes("rev-parse"));
} finally {
	rmSync(nonGitCwd, { recursive: true, force: true });
}

// Foreground launch with a pre-aborted tool signal: the abort is wired BEFORE
// preparation starts, so the run settles as stopped (never a failed/infra run,
// never a spawn) and the handoff carries no providerError.
const repoCwd = mkdtempSync(join(tmpdir(), "wabi-smoke-repo-"));
try {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoCwd });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoCwd });
	execFileSync("git", ["config", "user.name", "t"], { cwd: repoCwd });
	writeFileSync(join(repoCwd, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: repoCwd });
	execFileSync("git", ["commit", "-qm", "c1"], { cwd: repoCwd });
	const controller = new AbortController();
	controller.abort(); // the tool call's signal is already gone
	const execute = (registered.tool as { execute?: Function }).execute;
	const stubCtx = { cwd: repoCwd, mode: "json", isProjectTrusted: () => false, ui: { setWidget: () => {} } };
	let error: unknown;
	try {
		await execute?.("t2", { agent: "planner", task: "probe" }, controller.signal, undefined, stubCtx);
	} catch (caught) {
		error = caught;
	}
	const message = error instanceof Error ? error.message : String(error);
	check("signal: a pre-aborted foreground signal settles the run as stopped, never providerError", typeof execute === "function" && message.includes("status: stopped") && !message.includes("providerError"));
	check("signal: no raw git stderr leaks into a stopped handoff", !message.includes("fatal:"));
} finally {
	rmSync(repoCwd, { recursive: true, force: true });
}

// Background launch with a non-Git cwd: preparation fails closed and settles the
// run without spawning, so the tool call must throw the bounded handoff — never
// return a Started result, never leak raw git stderr into the handoff.
const backgroundCwd = mkdtempSync(join(tmpdir(), "wabi-smoke-bg-"));
try {
	const execute = (registered.tool as { execute?: Function }).execute;
	const stubCtx = { cwd: backgroundCwd, mode: "rpc", isProjectTrusted: () => false, ui: { setWidget: () => {} } };
	let error: unknown;
	try {
		await execute?.("t3", { agent: "planner", task: "probe", background: true }, undefined, undefined, stubCtx);
	} catch (caught) {
		error = caught;
	}
	const message = error instanceof Error ? error.message : String(error);
	check("background fail-closed: non-Git cwd throws the bounded handoff, never Started", typeof execute === "function" && error !== undefined && message.includes("status: failed") && message.includes("providerError: present") && !message.includes("Started"));
	check("background fail-closed: handoff bounded, no raw git stderr leak", message.length < 8 * 1024 && !message.includes("fatal:") && !message.includes("rev-parse"));
	check("background fail-closed: delivered only via the tool error, never steered as a message", !(registered.messages ?? []).some((m: any) => m?.content?.includes("status: failed")));
} finally {
	rmSync(backgroundCwd, { recursive: true, force: true });
}

// Startup stale-run sweep: the registered session_start handler runs the sweep
// once per session start — a stale fixture dir (dead pid, foreign token) under
// the dedicated root is removed, and a cleanup failure (undeletable dir) only
// notifies a warning and never breaks the handler (so the sweep cannot take the
// extension down).
{
	const handlers = registered.handlers as Record<string, unknown>;
	const sessionStart = handlers.session_start as ((event: unknown, ctx: any) => void | Promise<void>) | undefined;
	const root = readonlyRunsRoot();
	const sessionId = `smoke-sweep-${Math.random().toString(36).slice(2, 8)}`;
	const staleDir = join(root, runDirName(`scout-fixture-${sessionId}`));
	const stuckDir = join(root, runDirName(`scout-stuck-${sessionId}`));
	const notifies: string[] = [];
	const sessionCtx = {
		mode: "json",
		cwd: tmpdir(),
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			setWidget: () => {},
			notify: (message: string) => void notifies.push(message),
		},
	};
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		mkdirSync(staleDir, { mode: 0o700 });
		writeFileSync(join(staleDir, OWNER_MARKER_NAME), JSON.stringify({ schema: 1, pid: 2 ** 30, instanceToken: `foreign-${sessionId}`, processStart: "", runId: `scout-fixture-${sessionId}`, createdAt: Date.now() }), { mode: 0o600 });
		// A second stale dir whose deletion will fail (no write permission, POSIX
		// non-root): the sweep must record the error, notify, and not throw.
		mkdirSync(stuckDir, { mode: 0o700 });
		writeFileSync(join(stuckDir, OWNER_MARKER_NAME), JSON.stringify({ schema: 1, pid: 2 ** 30, instanceToken: `stuck-${sessionId}`, processStart: "", runId: `scout-stuck-${sessionId}`, createdAt: Date.now() }), { mode: 0o600 });
		chmodSync(stuckDir, 0o500);
		let threw: unknown;
		try {
			await sessionStart?.({}, sessionCtx);
		} catch (error) {
			threw = error;
		}
		check("startup sweep: session_start removes a stale read-only run dir and does not throw", threw === undefined && !existsSync(staleDir));
		const canFailDeletion = process.platform !== "win32" && (typeof process.getuid !== "function" || process.getuid() !== 0);
		check("startup sweep: a failing cleanup only notifies a warning, never breaks the handler", threw === undefined && (!canFailDeletion || (notifies.some((message) => message.includes("read-only run")) && existsSync(stuckDir))));
		// The handler also hardened a session archive dir for the fake session; remove it.
		rmSync(join(getAgentDir(), "wabi-runs", sessionId), { recursive: true, force: true });
	} finally {
		try {
			chmodSync(stuckDir, 0o700);
		} catch {}
		rmSync(staleDir, { recursive: true, force: true });
		rmSync(stuckDir, { recursive: true, force: true });
		// Remove the dedicated root only when this test left it empty; a root with
		// real content (a live extension) is never touched.
		try {
			if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
		} catch {}
	}
}

// Fake lifecycle: with no active runs, session shutdown must settle and clear the header.
const handlers = registered.handlers as Record<string, unknown>;
const shutdown = handlers.session_shutdown as ((event: unknown, ctx: { ui: { setHeader: (content: unknown) => void } }) => Promise<void>) | undefined;
const headerClears: string[] = [];
const shutdownSettled = typeof shutdown === "function"
	? await shutdown({}, { ui: { setHeader: (content: unknown) => { if (content === undefined) headerClears.push("header"); } } }).then(() => true).catch(() => false)
	: false;
check("shutdown: fake lifecycle settles and clears the header", shutdownSettled && headerClears.includes("header"));

if (failures > 0) {
	console.error(`\n${failures} smoke check(s) FAILED`);
	process.exit(1);
}
console.log("\nall smoke checks passed");
