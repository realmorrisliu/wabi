// Dedicated-root lifecycle and startup stale sweep for disposable read-only run
// dirs (planner, reviewer clones). One tiny helper file: no daemon, no timers, no
// configuration surface, no new dependencies. Normal ends remove the run dir
// immediately (best-effort, via the extension's existing temp-dir cleanup); a
// startup sweep (once per session start) reclaims dirs left behind by
// kill -9/crashes/power loss or failed cleanups. The sweep only ever scans one
// level of the dedicated root, never follows symlinks, and only deletes a dir
// when its owner marker proves the creating process is gone, or — for
// unknown/corrupt state — when the dir is older than the 24 h fallback.

import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** Dedicated root for every disposable read-only run dir: `${tmpdir()}/wabi-readonly-runs/`. Writer prompt temp dirs keep the legacy `wabi-*` pattern and are never swept. */
export const READONLY_RUNS_DIR_NAME = "wabi-readonly-runs";
export const OWNER_MARKER_NAME = "owner.json";
export const OWNER_MARKER_SCHEMA = 1;
/** Bounded owner-marker read: larger files are treated as corrupt/foreign. */
export const OWNER_MARKER_MAX_BYTES = 4096;
/** Dirs with a missing/corrupt/non-regular owner marker are only deleted once this old (mtime), never immediately. Internal constant; not configurable. */
export const UNKNOWN_DIR_STALE_MS = 24 * 60 * 60 * 1000;
/** Legal run-dir names: `wabi-ro-` + a run id (agent name, sequence, instance token). Anything else is foreign and skipped. */
const RUN_DIR_NAME_RE = /^wabi-ro-[A-Za-z0-9-]+$/;

/**
 * Process-global registry of live extension-instance tokens, keyed by a stable
 * `Symbol.for` so every copy of this module in the same JS realm (duplicate or
 * aliased extension paths, reloads) shares ONE set: an instance's sweep must
 * never delete another live instance's run dirs just because that instance's
 * token lives in a different module copy. Each instance adds its own token on
 * load and deletes it in its own session_shutdown; nothing ever clears the set
 * wholesale.
 */
const ACTIVE_OWNER_TOKENS_KEY = Symbol.for("wabi.activeOwnerTokens");

/** The process-global set of live extension-instance tokens, created lazily. Returns the mutable set itself: callers add their own token on load and delete it on shutdown. */
export function activeOwnerTokens(): Set<string> {
	const holder = globalThis as { [key: symbol]: unknown };
	let tokens = holder[ACTIVE_OWNER_TOKENS_KEY];
	if (!(tokens instanceof Set)) {
		tokens = new Set<string>();
		holder[ACTIVE_OWNER_TOKENS_KEY] = tokens;
	}
	return tokens as Set<string>;
}

/** Owner marker contents (mode 0600, written atomically inside the fresh run dir before clone preparation). */
export interface OwnerMarker {
	schema: number;
	/** Creating process pid. */
	pid: number;
	/** Random per-extension-instance token; the process registers live instances in an in-process set. */
	instanceToken: string;
	/** Creating process start time as `ps -o lstart=` output on POSIX; "" when unavailable (Windows). */
	processStart: string;
	runId: string;
	createdAt: number;
}

export type ProcessVerdict = "alive" | "dead" | "unverifiable";
/** Injectable process probe: "alive" only when the pid exists AND its identity matches the marker; "dead" when the pid is gone or was reused; "unverifiable" when the pid exists but identity cannot be checked (conservative keep). */
export type ProcessProbe = (marker: OwnerMarker) => ProcessVerdict;

export interface SweepOptions {
	/** Root to scan (defaults to the dedicated tmpdir root); tests inject a sandboxed root. */
	root?: string;
	now?: number;
	probe?: ProcessProbe;
	onError?: (error: unknown) => void;
}

export interface SweepResult {
	removed: number;
	kept: number;
	errors: number;
}

export function readonlyRunsRoot(): string {
	return join(tmpdir(), READONLY_RUNS_DIR_NAME);
}

/** The dedicated run dir name for a run id. The run id embeds the user-authored agent name, so characters outside the sweep's legal-name alphabet are folded to `-`: every dir we create must be sweepable, or crash leftovers would never be reclaimed. */
export function runDirName(runId: string): string {
	return `wabi-ro-${runId.replace(/[^A-Za-z0-9-]/g, "-")}`;
}

/**
 * Pure platform liveness classification: a dead pid deletes everywhere; a live
 * pid on Windows is conservatively kept (no reliable identity check without
 * new dependencies); on POSIX a verified identity keeps, a mismatch (PID
 * reuse) deletes, and an uncheckable identity keeps.
 */
export function classifyProcess(pidAlive: boolean, identityMatch: boolean | undefined, platform: string): ProcessVerdict {
	if (!pidAlive) return "dead";
	if (platform === "win32") return "unverifiable";
	if (identityMatch === true) return "alive";
	if (identityMatch === false) return "dead";
	return "unverifiable";
}

let cachedProcessStart: string | undefined;
function computeProcessStart(): string {
	if (process.platform === "win32") return "";
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0) return "";
	return result.stdout.trim();
}

/** This process's start time as `ps -o lstart=` output, "" when unavailable (Windows, missing ps). Cached: a process's start time never changes. */
export function currentProcessStart(): string {
	if (cachedProcessStart === undefined) cachedProcessStart = computeProcessStart();
	return cachedProcessStart;
}

/**
 * Default cross-platform probe. `process.kill(pid, 0)` only proves existence —
 * PID reuse would fool it — so on POSIX the marker's recorded process start
 * time is compared against `ps -o lstart=` for the pid; a mismatch means the
 * pid now belongs to a different process and the run dir is stale. When the
 * identity cannot be verified (Windows, ps unavailable, marker without a
 * recorded start), a live pid is conservatively kept.
 */
export function defaultProcessProbe(marker: OwnerMarker): ProcessVerdict {
	let pidAlive = true;
	try {
		process.kill(marker.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") pidAlive = false;
		// EPERM means the process exists (owned by another user); ps can still read lstart.
	}
	if (!pidAlive) return "dead";
	let identityMatch: boolean | undefined;
	if (process.platform !== "win32" && marker.processStart !== "") {
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(marker.pid)], { encoding: "utf8" });
		if (!result.error && result.status === 0) identityMatch = result.stdout.trim() === marker.processStart;
	}
	return classifyProcess(pidAlive, identityMatch, process.platform);
}

/** Strict owner-marker decode: schema, positive integer pid, bounded non-empty token/runId, string processStart, finite createdAt. Anything else is corrupt/foreign. */
export function parseOwnerMarker(text: string): OwnerMarker | undefined {
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object") return undefined;
		const raw = value as Record<string, unknown>;
		if (raw.schema !== OWNER_MARKER_SCHEMA) return undefined;
		if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined;
		if (typeof raw.instanceToken !== "string" || raw.instanceToken.length === 0 || raw.instanceToken.length > 64) return undefined;
		if (typeof raw.processStart !== "string" || raw.processStart.length > 128) return undefined;
		if (typeof raw.runId !== "string" || raw.runId.length === 0 || raw.runId.length > 128) return undefined;
		const createdAt = raw.createdAt;
		if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
		return { schema: OWNER_MARKER_SCHEMA, pid: raw.pid, instanceToken: raw.instanceToken, processStart: raw.processStart, runId: raw.runId, createdAt };
	} catch {
		return undefined;
	}
}

/** Pure sweep decision for a valid marker: a registered live instance keeps; this same process without a registered token (a reloaded instance) deletes; otherwise the probe decides, with "unverifiable" conservatively kept. */
export function markerVerdict(marker: OwnerMarker, activeTokens: ReadonlySet<string>, processPid: number, probe: ProcessProbe): "keep" | "delete" {
	if (activeTokens.has(marker.instanceToken)) return "keep";
	if (marker.pid === processPid) return "delete";
	return probe(marker) === "dead" ? "delete" : "keep";
}

function ensurePlainDir(dir: string): void {
	const stats = lstatSync(dir);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`not a plain directory: ${dir}`);
	}
}

/** Create the dedicated root (mode 0700) when missing; refuses a symlink or non-directory root. */
function ensureReadonlyRunsRoot(root: string): void {
	try {
		ensurePlainDir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(root, { mode: 0o700 });
			chmodSync(root, 0o700);
			return;
		}
		throw error;
	}
}

/**
 * Create one dedicated read-only run dir: exclusive mkdir inside the dedicated
 * root, then the owner marker written atomically (exclusive 0600 temp file,
 * rename) BEFORE any clone preparation. Returns the dir path — the run's
 * tempDir, so the existing best-effort removal covers the whole dir. Throws on
 * any failure; the caller fails the run closed.
 */
export function createReadonlyRunDir(runId: string, instanceToken: string, options: { root?: string; now?: number } = {}): string {
	const root = options.root ?? readonlyRunsRoot();
	ensureReadonlyRunsRoot(root);
	const dir = join(root, runDirName(runId));
	mkdirSync(dir, { mode: 0o700 }); // exclusive: a duplicate name fails
	chmodSync(dir, 0o700);
	const marker: OwnerMarker = {
		schema: OWNER_MARKER_SCHEMA,
		pid: process.pid,
		instanceToken,
		processStart: currentProcessStart(),
		runId,
		createdAt: options.now ?? Date.now(),
	};
	const tmpPath = join(dir, `.owner.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	const fd = openSync(tmpPath, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(marker), "utf8");
	} catch (error) {
		closeSync(fd);
		rmSync(tmpPath, { force: true });
		throw error;
	}
	closeSync(fd);
	try {
		renameSync(tmpPath, join(dir, OWNER_MARKER_NAME)); // atomic; replaces, never follows, a pre-created symlink
		chmodSync(join(dir, OWNER_MARKER_NAME), 0o600);
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
	return dir;
}

/** Read a dir's owner marker: must be a regular file (symlinks rejected via lstat), bounded size, valid schema. Returns undefined for missing/corrupt/foreign markers. */
function readOwnerMarker(dirPath: string): OwnerMarker | undefined {
	const path = join(dirPath, OWNER_MARKER_NAME);
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.size > OWNER_MARKER_MAX_BYTES) return undefined;
		return parseOwnerMarker(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Startup stale-run sweep: scan exactly one level of the dedicated root and
 * delete every dir whose owner marker proves its creating process is gone
 * (dead pid, PID-reuse identity mismatch, or a previous extension instance of
 * this same process). Dirs with a missing/corrupt/non-regular marker are only
 * deleted once their mtime is older than UNKNOWN_DIR_STALE_MS (future mtimes
 * and unstat-able dirs are kept); a live but unverifiable process is always
 * kept. Symlinks, foreign names, files, and anything resolving outside the
 * real root are never followed or deleted. Never throws: every failure is
 * counted and reported via onError, so a broken root cannot break extension
 * loading. Entries that vanish mid-sweep count as already handled.
 */
export function sweepReadonlyRuns(activeTokens: ReadonlySet<string>, options: SweepOptions = {}): SweepResult {
	const now = options.now ?? Date.now();
	const probe = options.probe ?? defaultProcessProbe;
	const result: SweepResult = { removed: 0, kept: 0, errors: 0 };
	const report = (error: unknown) => {
		result.errors++;
		try {
			options.onError?.(error);
		} catch {
			// The callback itself must never break the sweep.
		}
	};
	const root = options.root ?? readonlyRunsRoot();
	let rootReal: string;
	try {
		ensurePlainDir(root);
		rootReal = realpathSync(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; // nothing to sweep
		report(error);
		return result;
	}
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		report(error);
		return result;
	}
	const boundary = rootReal + sep;
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue; // never follow symlinks, never delete files
		if (!RUN_DIR_NAME_RE.test(entry.name)) continue; // not one of ours
		const dirPath = join(root, entry.name);
		try {
			if (!realpathSync(dirPath).startsWith(boundary)) continue; // path-boundary check: must live inside the real root
		} catch {
			continue; // vanished mid-sweep: treat as already handled
		}
		const marker = readOwnerMarker(dirPath);
		if (marker) {
			if (markerVerdict(marker, activeTokens, process.pid, probe) === "keep") {
				result.kept++;
				continue;
			}
		} else {
			// Unknown state: never delete immediately; only once the dir is older
			// than the fallback window (future mtimes keep too).
			let mtime: number;
			try {
				const stats = lstatSync(dirPath);
				if (!stats.isDirectory()) continue; // changed under us; never follow
				mtime = stats.mtimeMs;
			} catch {
				continue;
			}
			if (now - mtime <= UNKNOWN_DIR_STALE_MS) {
				result.kept++;
				continue;
			}
		}
		try {
			rmSync(dirPath, { recursive: true, force: true });
			result.removed++;
		} catch (error) {
			report(error);
		}
	}
	return result;
}
