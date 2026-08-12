// cleanup-check.ts — garbage-collection check for disposable read-only run
// dirs. Exercises extensions/subagents/cleanup.ts against real fixtures inside
// a sandboxed root (never the real tmpdir root): owner marker creation, the
// startup stale sweep's decisions (dead PID, PID-reuse identity mismatch,
// active current-process markers, previous-instance same-process markers, the
// 24 h fallback for missing/corrupt/symlink/oversize markers), symlink and
// path-boundary refusal, deletion-failure containment, idempotency, and the
// normal read-only run lifecycle (marker written before clone prep, whole run
// dir removed best-effort on end). Run: bun cleanup-check.ts

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OWNER_MARKER_NAME,
	OWNER_MARKER_SCHEMA,
	UNKNOWN_DIR_STALE_MS,
	activeOwnerTokens,
	classifyProcess,
	createReadonlyRunDir,
	currentProcessStart,
	defaultProcessProbe,
	markerVerdict,
	parseOwnerMarker,
	runDirName,
	sweepReadonlyRuns,
	type OwnerMarker,
} from "./extensions/subagents/cleanup.ts";
import { prepareClone } from "./extensions/subagents/clone.ts";
import { removeTempDirBestEffort } from "./extensions/subagents/lib.ts";

let failures = 0;
function check(name: string, condition: boolean) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Far beyond any real pid_max, so kill(pid, 0) reliably reports ESRCH. */
const DEAD_PID = 2 ** 30;

function marker(overrides: Partial<OwnerMarker> = {}): OwnerMarker {
	return {
		schema: OWNER_MARKER_SCHEMA,
		pid: DEAD_PID,
		instanceToken: "tok-test",
		processStart: "",
		runId: "scout-1-tok",
		createdAt: Date.now(),
		...overrides,
	};
}

function writeMarker(dir: string, m: OwnerMarker): void {
	writeFileSync(join(dir, OWNER_MARKER_NAME), JSON.stringify(m), { mode: 0o600 });
}

/** Backdate a dir's mtime past the unknown-state fallback window. */
function backdate(dir: string): void {
	const old = new Date(Date.now() - UNKNOWN_DIR_STALE_MS - 60_000);
	utimesSync(dir, old, old);
}

const sandbox = mkdtempSync(join(tmpdir(), "wabi-cleanup-root-"));
function fixtureDir(name: string): string {
	const dir = join(sandbox, name);
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

// ---------------------------------------------------------------------------
// 1. Pure marker parsing and verdict logic
// ---------------------------------------------------------------------------
check("marker: valid JSON round-trips through the strict parser", (() => {
	const m = marker();
	const parsed = parseOwnerMarker(JSON.stringify(m))!;
	return parsed.pid === m.pid && parsed.instanceToken === m.instanceToken && parsed.processStart === m.processStart && parsed.runId === m.runId && parsed.createdAt === m.createdAt && parsed.schema === OWNER_MARKER_SCHEMA;
})());
check("marker: rejects non-JSON, wrong schema, and non-object values", parseOwnerMarker("not json") === undefined && parseOwnerMarker(JSON.stringify({ schema: 99 })) === undefined && parseOwnerMarker("42") === undefined);
check("marker: rejects bad pids (non-integer, zero, negative, string)", [1.5, 0, -1, "123"].every((pid) => parseOwnerMarker(JSON.stringify(marker({ pid: pid as number }))) === undefined));
check("marker: rejects missing/oversized token, runId, and non-finite createdAt", parseOwnerMarker(JSON.stringify(marker({ instanceToken: "" }))) === undefined
	&& parseOwnerMarker(JSON.stringify(marker({ instanceToken: "x".repeat(65) }))) === undefined
	&& parseOwnerMarker(JSON.stringify(marker({ runId: "" }))) === undefined
	&& parseOwnerMarker(JSON.stringify(marker({ createdAt: Number.NaN }))) === undefined
	&& parseOwnerMarker(JSON.stringify(marker({ createdAt: null as unknown as number }))) === undefined);

check("classifyProcess: dead pid deletes on every platform", classifyProcess(false, true, "darwin") === "dead" && classifyProcess(false, undefined, "win32") === "dead");
check("classifyProcess: POSIX identity match keeps, mismatch (PID reuse) deletes", classifyProcess(true, true, "darwin") === "alive" && classifyProcess(true, false, "linux") === "dead");
check("classifyProcess: POSIX unverifiable identity (ps unavailable) keeps", classifyProcess(true, undefined, "linux") === "unverifiable");
check("classifyProcess: Windows live pid is conservatively kept even on mismatch", classifyProcess(true, true, "win32") === "unverifiable" && classifyProcess(true, false, "win32") === "unverifiable");

check("markerVerdict: a registered live instance keeps even when the probe says dead", markerVerdict(marker(), new Set(["tok-test"]), 1, () => "dead") === "keep");
check("markerVerdict: same-process foreign token (reloaded instance) deletes without probing", markerVerdict(marker({ pid: process.pid }), new Set(), process.pid, () => "alive") === "delete");
check("markerVerdict: dead pid deletes", markerVerdict(marker(), new Set(), process.pid, () => "dead") === "delete");
check("markerVerdict: verified-alive pid keeps", markerVerdict(marker(), new Set(), process.pid, () => "alive") === "keep");
check("markerVerdict: unverifiable pid keeps (conservative)", markerVerdict(marker(), new Set(), process.pid, () => "unverifiable") === "keep");

// ---------------------------------------------------------------------------
// 1b. Active-token registry is process-global: two independent extension
//     instances (module copies) share ONE set via the Symbol.for key, so one
//     instance's sweep can never delete another live instance's run dirs
// ---------------------------------------------------------------------------
{
	// Simulate a second module copy: re-derive the registry straight from the
	// global Symbol.for key, exactly as a separately-loaded module copy would.
	const holder = globalThis as { [key: symbol]: unknown };
	const KEY = Symbol.for("wabi.activeOwnerTokens");
	const existedBefore = KEY in holder;
	try {
		const shared = activeOwnerTokens();
		// Simulate a second module copy: re-derive the registry straight from the
		// global Symbol.for key after it exists, exactly as a separately-loaded
		// module copy would at sweep time.
		const otherCopy = holder[KEY];
		check("registry: the helper and a raw Symbol.for lookup see the same set", shared instanceof Set && holder[KEY] === shared);
		check("registry: empty before any instance registers", shared.size === 0);

		const rootA = mkdtempSync(join(tmpdir(), "wabi-cleanup-reg-a-"));
		const rootB = mkdtempSync(join(tmpdir(), "wabi-cleanup-reg-b-"));
		try {
			// Two instances load; each registers its own token (same process pid).
			const tokenA = "tok-inst-a";
			const tokenB = "tok-inst-b";
			shared.add(tokenA);
			shared.add(tokenB);
			const dirA = createReadonlyRunDir("scout-1-ainst", tokenA, { root: rootA });
			const dirB = createReadonlyRunDir("scout-2-binst", tokenB, { root: rootB });

			// Each instance's sweep runs with its own module copy's view of the
			// registry — which is the same set, so neither deletes the other's run.
			const rA = sweepReadonlyRuns(shared, { root: rootA });
			const rB = sweepReadonlyRuns(otherCopy as Set<string>, { root: rootB });
			check("registry: instance A's sweep keeps both live instances' dirs", rA.removed === 0 && existsSync(dirA));
			check("registry: instance B's sweep (other module copy) keeps A's live run too", rB.removed === 0 && existsSync(dirA) && existsSync(dirB));

			// Instance A shuts down: it deletes only its own token.
			shared.delete(tokenA);
			check("registry: shutdown deletes only the instance's own token", shared.size === 1 && !shared.has(tokenA) && shared.has(tokenB));

			// B's next sweep reclaims A's stale dir (same pid, token gone) but
			// keeps B's own active run.
			const rB2 = sweepReadonlyRuns(shared, { root: rootA });
			const rB3 = sweepReadonlyRuns(shared, { root: rootB });
			check("registry: after A's shutdown, B's sweep deletes A's stale dir", rB2.removed === 1 && !existsSync(dirA));
			check("registry: ...and keeps B's own active run", rB3.removed === 0 && existsSync(dirB));

			shared.delete(tokenB);
		} finally {
			rmSync(rootA, { recursive: true, force: true });
			rmSync(rootB, { recursive: true, force: true });
		}
	} finally {
		// Restore the global registry exactly as found: if this suite created it
		// and left it empty, remove the key so no other suite sees our residue.
		if (!existedBefore && activeOwnerTokens().size === 0) delete holder[KEY];
	}
}

// ---------------------------------------------------------------------------
// 2. Real-process probe (POSIX): liveness AND identity, no fake pids needed
// ---------------------------------------------------------------------------
if (process.platform !== "win32") {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	const childPid = child.pid!;
	const childStart = spawnSync("ps", ["-o", "lstart=", "-p", String(childPid)], { encoding: "utf8" }).stdout.trim();
	try {
		check("probe: live child with the matching start time is alive", childStart !== "" && defaultProcessProbe(marker({ pid: childPid, processStart: childStart })) === "alive");
		check("probe: PID-reuse identity mismatch is dead (start time differs)", defaultProcessProbe(marker({ pid: childPid, processStart: "Thu Jan  1 00:00:00 1970" })) === "dead");
	} finally {
		child.kill("SIGKILL");
		await new Promise((resolve) => child.on("close", resolve));
	}
	check("probe: the same pid is dead once its process exits", defaultProcessProbe(marker({ pid: childPid, processStart: childStart })) === "dead");
}
check("probe: a nonexistent pid is dead", defaultProcessProbe(marker({ pid: DEAD_PID })) === "dead");

// ---------------------------------------------------------------------------
// 3. createReadonlyRunDir: marker before clone prep, hardened dirs
// ---------------------------------------------------------------------------
{
	const runDir = createReadonlyRunDir("scout-7-tokabc", "tokabc", { root: sandbox, now: 1_700_000_000_000 });
	try {
		check("create: run dir created inside the root under a legal name", runDir === join(sandbox, runDirName("scout-7-tokabc")) && lstatSync(runDir).isDirectory());
		check("create: run dir is 0700", (statSync(runDir).mode & 0o777) === 0o700);
		const m = parseOwnerMarker(readFileSync(join(runDir, OWNER_MARKER_NAME), "utf8"))!;
		check("create: marker records pid, instance token, runId, createdAt", m.pid === process.pid && m.instanceToken === "tokabc" && m.runId === "scout-7-tokabc" && m.createdAt === 1_700_000_000_000);
		check("create: marker is a plain 0600 regular file (no symlink, no temp leftovers)", (statSync(join(runDir, OWNER_MARKER_NAME)).mode & 0o777) === 0o600 && !lstatSync(join(runDir, OWNER_MARKER_NAME)).isSymbolicLink() && readdirSync(runDir).length === 1);
		if (process.platform !== "win32") {
			check("create: POSIX markers carry the process start time (identity, not just pid)", currentProcessStart() !== "" && m.processStart !== "" && m.processStart === currentProcessStart());
		}
		// A duplicate name is refused (exclusive mkdir), never silently reused.
		let duplicateThrew = false;
		try {
			createReadonlyRunDir("scout-7-tokabc", "other", { root: sandbox });
		} catch {
			duplicateThrew = true;
		}
		check("create: a duplicate run dir name fails closed", duplicateThrew);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}

	// Root hardening: a symlink root and a file root are refused, target untouched.
	const target = mkdtempSync(join(tmpdir(), "wabi-cleanup-target-"));
	const symRoot = join(sandbox, "symroot");
	try {
		symlinkSync(target, symRoot);
		let threw = false;
		try {
			createReadonlyRunDir("scout-1-x", "x", { root: symRoot });
		} catch {
			threw = true;
		}
		check("create: refuses a symlink root without touching the target", threw && readdirSync(target).length === 0);
		const fileRoot = join(sandbox, "rootfile");
		writeFileSync(fileRoot, "x");
		threw = false;
		try {
			createReadonlyRunDir("scout-1-x", "x", { root: fileRoot });
		} catch {
			threw = true;
		}
		check("create: refuses a file root", threw);
	} finally {
		rmSync(symRoot, { force: true });
		rmSync(target, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 3b. Hostile run ids (user-authored agent names) are folded into legal dir
//     names, so dirs we create are always sweepable — never path traversal,
//     never a name the sweep refuses to touch.
// ---------------------------------------------------------------------------
{
	let dir: string | undefined;
	let created = false;
	try {
		dir = createReadonlyRunDir("scout_1/../x", "tok-hostile", { root: sandbox });
		created = true;
	} catch {
		created = false;
	}
	check("create: hostile run ids fold to legal sweepable dir names", created && dir !== undefined && /^wabi-ro-[A-Za-z0-9-]+$/.test(dir.slice(dir.lastIndexOf("/") + 1)));
	if (dir) {
		// Same-process foreign token + legal name: the sweep must reclaim it.
		const swept = sweepReadonlyRuns(new Set(), { root: sandbox });
		check("create: folded-name stale dir is reclaimed by the sweep", swept.removed === 1 && swept.errors === 0 && !existsSync(dir));
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 4. Sweep decisions end-to-end in the sandboxed root
// ---------------------------------------------------------------------------
{
	const dead = fixtureDir("wabi-ro-scout-1-dead");
	writeMarker(dead, marker());
	const active = fixtureDir("wabi-ro-scout-2-active");
	writeMarker(active, marker({ pid: process.pid, instanceToken: "tok-live" }));
	const oldInst = fixtureDir("wabi-ro-scout-3-oldinst");
	writeMarker(oldInst, marker({ pid: process.pid, instanceToken: "tok-old" }));
	const noMarker = fixtureDir("wabi-ro-scout-4-nomarker");
	const noMarkerOld = fixtureDir("wabi-ro-scout-5-nomarkerold");
	backdate(noMarkerOld);
	const corrupt = fixtureDir("wabi-ro-scout-6-corrupt");
	writeFileSync(join(corrupt, OWNER_MARKER_NAME), "{broken", { mode: 0o600 });
	const corruptOld = fixtureDir("wabi-ro-scout-7-corruptold");
	writeFileSync(join(corruptOld, OWNER_MARKER_NAME), "{broken", { mode: 0o600 });
	backdate(corruptOld);
	const oversize = fixtureDir("wabi-ro-scout-8-oversize");
	writeFileSync(join(oversize, OWNER_MARKER_NAME), "x".repeat(4096 + 1), { mode: 0o600 });
	const symMarker = fixtureDir("wabi-ro-scout-9-symmarker");
	const victimMarker = join(sandbox, "victim-marker.json");
	writeFileSync(victimMarker, JSON.stringify(marker()), { mode: 0o600 });
	symlinkSync(victimMarker, join(symMarker, OWNER_MARKER_NAME));
	const victimDir = mkdtempSync(join(tmpdir(), "wabi-cleanup-victim-"));
	const symEntry = join(sandbox, "wabi-ro-scout-10-symentry");
	symlinkSync(victimDir, symEntry);
	const foreignDir = fixtureDir("not-wabi-ours");
	const foreignFile = join(sandbox, "wabi-ro-file");
	writeFileSync(foreignFile, "x");
	const bareName = fixtureDir("wabi-ro");

	const swept = sweepReadonlyRuns(new Set(["tok-live"]), { root: sandbox });
	check("sweep: dead-pid valid marker removed immediately", !existsSync(dead));
	check("sweep: active current-process marker kept (registered token)", existsSync(active));
	check("sweep: previous-instance same-process marker removed (reload)", !existsSync(oldInst));
	check("sweep: fresh missing marker kept", existsSync(noMarker));
	check("sweep: missing marker older than 24h removed", !existsSync(noMarkerOld));
	check("sweep: fresh corrupt marker kept", existsSync(corrupt));
	check("sweep: corrupt marker older than 24h removed", !existsSync(corruptOld));
	check("sweep: oversize marker treated as unknown, fresh kept", existsSync(oversize));
	check("sweep: symlink marker treated as unknown, fresh kept, victim untouched", existsSync(symMarker) && existsSync(victimMarker));
	check("sweep: symlink run dir never followed or removed", lstatSync(symEntry).isSymbolicLink() && existsSync(victimDir) && readdirSync(victimDir).length === 0);
	check("sweep: foreign dirs, files, and non-conforming names untouched", existsSync(foreignDir) && existsSync(foreignFile) && existsSync(bareName));
	check("sweep: no errors during the happy-path sweep", swept.errors === 0);

	// Idempotent: a second sweep removes nothing further and keeps the live one.
	const again = sweepReadonlyRuns(new Set(["tok-live"]), { root: sandbox });
	check("sweep: idempotent — a second sweep removes nothing", again.removed === 0 && existsSync(active));

	// Windows-conservative probe injection: a live-but-unverifiable pid keeps.
	const sweepRoot2 = mkdtempSync(join(tmpdir(), "wabi-cleanup-sweep2-"));
	try {
		const a = join(sweepRoot2, "wabi-ro-scout-1-a");
		mkdirSync(a, { mode: 0o700 });
		writeMarker(a, marker({ pid: 424242 }));
		const b = join(sweepRoot2, "wabi-ro-scout-2-b");
		mkdirSync(b, { mode: 0o700 });
		writeMarker(b, marker({ pid: 424243 }));
		const r = sweepReadonlyRuns(new Set(), { root: sweepRoot2, probe: () => "unverifiable" });
		check("sweep: live-but-unverifiable (Windows-style) markers are all kept", r.removed === 0 && r.errors === 0 && existsSync(a) && existsSync(b));
	} finally {
		rmSync(sweepRoot2, { recursive: true, force: true });
	}

	// Deletion failure: never throws, never blocks, reported via onError.
	const failRoot = mkdtempSync(join(tmpdir(), "wabi-cleanup-fail-"));
	try {
		const dir = join(failRoot, "wabi-ro-scout-1-fail");
		mkdirSync(dir, { mode: 0o700 });
		writeMarker(dir, marker());
		chmodSync(dir, 0o500); // no write permission: children cannot be unlinked (POSIX, non-root)
		let reported: unknown;
		const r = sweepReadonlyRuns(new Set(), { root: failRoot, onError: (error) => void (reported = error) });
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			check("sweep: deletion failure containment (root user: deletion succeeds)", r.errors === 0 && r.removed === 1 && !existsSync(dir));
		} else {
			check("sweep: a failing deletion never throws, is counted and reported", r.errors === 1 && r.removed === 0 && reported !== undefined && existsSync(dir));
		}
	} finally {
		chmodSync(join(failRoot, "wabi-ro-scout-1-fail"), 0o700);
		rmSync(failRoot, { recursive: true, force: true });
	}

	// Missing root and symlink root: no-op / error, never a throw, target untouched.
	const missingRoot = join(sandbox, "missing-root");
	check("sweep: a missing root is a silent no-op", sweepReadonlyRuns(new Set(), { root: missingRoot }).removed === 0 && !existsSync(missingRoot));
	const symRoot = join(sandbox, "sweep-symroot");
	const symTarget = mkdtempSync(join(tmpdir(), "wabi-cleanup-symtarget-"));
	try {
		symlinkSync(symTarget, symRoot);
		const r = sweepReadonlyRuns(new Set(), { root: symRoot });
		check("sweep: a symlink root is refused with an error, target untouched", r.errors === 1 && r.removed === 0 && readdirSync(symTarget).length === 0);
	} finally {
		rmSync(symRoot, { force: true });
		rmSync(symTarget, { recursive: true, force: true });
	}

	rmSync(victimDir, { recursive: true, force: true });
	rmSync(victimMarker, { force: true });
}

// ---------------------------------------------------------------------------
// 5. Real-process sweep (POSIX): verified-live kept, PID-reuse mismatch and
//    post-exit removed — through the default probe, with real pids
// ---------------------------------------------------------------------------
if (process.platform !== "win32") {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	const childPid = child.pid!;
	const childStart = spawnSync("ps", ["-o", "lstart=", "-p", String(childPid)], { encoding: "utf8" }).stdout.trim();
	const liveRoot = mkdtempSync(join(tmpdir(), "wabi-cleanup-live-"));
	try {
		const live = join(liveRoot, "wabi-ro-scout-1-live");
		mkdirSync(live, { mode: 0o700 });
		writeMarker(live, marker({ pid: childPid, instanceToken: "tok-live-child", processStart: childStart }));
		const reused = join(liveRoot, "wabi-ro-scout-2-reused");
		mkdirSync(reused, { mode: 0o700 });
		writeMarker(reused, marker({ pid: childPid, instanceToken: "tok-reused", processStart: "Thu Jan  1 00:00:00 1970" }));
		const r = sweepReadonlyRuns(new Set(), { root: liveRoot });
		check("sweep: live process with verified identity kept", r.errors === 0 && existsSync(live));
		check("sweep: PID-reuse identity mismatch removed (POSIX ps verification)", !existsSync(reused));
		child.kill("SIGKILL");
		await new Promise((resolve) => child.on("close", resolve));
		const r2 = sweepReadonlyRuns(new Set(), { root: liveRoot });
		check("sweep: the kept dir is removed once its process exits", r2.removed === 1 && !existsSync(live));
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(liveRoot, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 6. Normal read-only run lifecycle: dedicated run dir IS the tempDir; marker
//    exists before clone prep; whole dir removed best-effort on end; writer
//    prompt temp dirs are never swept
// ---------------------------------------------------------------------------
{
	const repo = mkdtempSync(join(tmpdir(), "wabi-cleanup-repo-"));
	const lifecycleRoot = mkdtempSync(join(tmpdir(), "wabi-cleanup-life-"));
	const runDir = createReadonlyRunDir("scout-99-lifecycle", "tok-lifecycle", { root: lifecycleRoot });
	try {
		mkdirSync(repo, { recursive: true });
		git(["init", "-q", "-b", "main"], repo);
		git(["config", "user.email", "t@t"], repo);
		git(["config", "user.name", "t"], repo);
		writeFileSync(join(repo, "a.txt"), "a1\n");
		git(["add", "."], repo);
		git(["commit", "-qm", "c1"], repo);

		const baseline = await prepareClone(repo, runDir);
		check("lifecycle: marker exists before clone prep and clone lands inside the run dir", existsSync(join(runDir, OWNER_MARKER_NAME)) && baseline.cloneRoot.startsWith(runDir));
		const r = sweepReadonlyRuns(new Set(["tok-lifecycle"]), { root: lifecycleRoot });
		check("lifecycle: the sweep keeps the run dir while the run is active", r.removed === 0 && r.errors === 0 && existsSync(runDir));

		removeTempDirBestEffort(runDir);
		check("lifecycle: normal end removes the whole run dir (marker, prompt, clone)", !existsSync(runDir));

		// Clone prep failure: the dir is still removed via the same best-effort path.
		const runDir2 = createReadonlyRunDir("scout-100-failprep", "tok-failprep", { root: lifecycleRoot });
		let prepFailed = false;
		try {
			await prepareClone(join(repo, "nonexistent-sub"), runDir2);
		} catch {
			prepFailed = true;
		}
		removeTempDirBestEffort(runDir2);
		check("lifecycle: failed clone prep still removes the run dir (fail closed)", prepFailed && !existsSync(runDir2));

		// Writer prompt temp dirs keep the legacy wabi-* pattern outside the root.
		const writerDir = mkdtempSync(join(tmpdir(), "wabi-"));
		const r3 = sweepReadonlyRuns(new Set(), { root: lifecycleRoot });
		check("lifecycle: writer prompt temp dirs are never swept", existsSync(writerDir) && r3.removed === 0);
		rmSync(writerDir, { recursive: true, force: true });
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(lifecycleRoot, { recursive: true, force: true });
	}
}

rmSync(sandbox, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} cleanup check(s) FAILED`);
	process.exit(1);
}
console.log("\nall cleanup checks passed");
