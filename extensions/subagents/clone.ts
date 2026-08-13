// Per-run disposable local clone for read-only subagent runs (research-plan, reviewer).
// The child works against this clone so its git state — refs, stash, config,
// index, working tree — is fully independent of the parent's checkout. The
// clone lives inside the run's temp dir and inherits its cleanup. Fail closed:
// any preparation failure throws and the run fails with the bounded handoff;
// there is no fallback to the shared cwd, no retry, and no auto-repair.
//
// Preparation is asynchronous and cancelable: one shared total deadline (not a
// per-command timeout) plus an external AbortSignal both abort the current git
// child and every in-flight file operation, so stop/reload/tool-abort during
// preparation terminates it. Aborts reject with an `AbortError`-named error;
// callers settle those runs as stopped, never as infrastructure failures.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentConfig } from "./lib.ts";
import { isWriter } from "./lib.ts";

/** One shared total deadline for the whole clone preparation, ms. Not per git command. */
export const CLONE_PREP_DEADLINE_MS = 120_000;
/** Cap for buffered git stdout (diffs, ls-files). Exceeding it fails the run closed. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** Cap for retained git stderr; only the first line is ever surfaced in an error. */
const GIT_STDERR_CAP = 128 * 1024;
/** Total bytes hashed/copied for non-ignored untracked files; exceeding it fails closed. */
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;
/** Chunk size for untracked-file hashing/copying: keeps abort/deadline checks frequent and the event loop free. */
const CHUNK_BYTES = 64 * 1024;

const CLONE_DIR = "clone";

/** Snapshot baseline recorded for a read-only run and handed to the child so its handoff can report it. */
export interface CloneBaseline {
	/** Parent worktree root (`git rev-parse --show-toplevel`). */
	root: string;
	/** Parent HEAD sha at launch — the clone's detached HEAD. */
	head: string;
	/** Parent branch name, or "(detached)". */
	branch: string;
	/** Capture-time workspace fingerprint. */
	fingerprint: string;
	/** When the snapshot was captured, ms epoch. */
	asOf: number;
	/** Clone root inside the run temp dir. */
	cloneRoot: string;
	/** Child working directory inside the clone (parent cwd mapped to the same relative path). */
	childCwd: string;
}

/** Abort or deadline-expiry marker: prep cancellations settle as stopped, never as infra failures. */
function abortError(reason: string): Error {
	const error = new Error(reason);
	error.name = "AbortError";
	return error;
}

interface PrepContext {
	signal: AbortSignal;
	/** Wall-clock deadline for the whole preparation, ms epoch. */
	deadline: number;
	/** Bytes consumed by untracked fingerprinting/copying so far. */
	untrackedBytes: number;
}

function throwIfAborted(ctx: PrepContext, what: string): void {
	if (ctx.signal.aborted) throw abortError(`clone preparation ${what} aborted`);
	if (Date.now() > ctx.deadline) throw abortError(`clone preparation ${what} exceeded the shared ${CLONE_PREP_DEADLINE_MS}ms deadline`);
}

/**
 * One shared cancellation scope for a preparation: an internal controller fed
 * by the external signal and by a single total-deadline timer, so both abort
 * the current git child (via the spawn signal) and every step in between.
 */
function prepScope(externalSignal?: AbortSignal, deadlineMs = CLONE_PREP_DEADLINE_MS): { ctx: PrepContext; done: () => void } {
	const controller = new AbortController();
	const onExternalAbort = () => controller.abort();
	if (externalSignal?.aborted) controller.abort();
	else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs));
	return {
		ctx: { signal: controller.signal, deadline: Date.now() + Math.max(0, deadlineMs), untrackedBytes: 0 },
		done: () => {
			clearTimeout(deadlineTimer);
			externalSignal?.removeEventListener("abort", onExternalAbort);
		},
	};
}

interface GitOutcome {
	status: number | null;
	stdout: Buffer;
	stderr: string;
}

/** Run one git command with an argument array (no shell). stdout/stderr stay bounded; abort/deadline kill the child. */
function gitRun(args: string[], cwd: string, ctx: PrepContext, input?: Buffer | string): Promise<GitOutcome> {
	return new Promise((resolvePromise, reject) => {
		if (ctx.signal.aborted) {
			reject(abortError(`git ${args[0]} aborted before start`));
			return;
		}
		const child = spawn("git", args, {
			cwd,
			signal: ctx.signal, // an abort kills the running child (SIGTERM)
			stdio: input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL"); // belt and braces: the signal option already sent SIGTERM
			reject(error);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > GIT_MAX_BUFFER) {
				fail(new Error(`git ${args[0]} stdout exceeded ${GIT_MAX_BUFFER} bytes; run failed closed`));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= GIT_STDERR_CAP) stderr.push(chunk);
		});
		child.on("error", (error) => fail(ctx.signal.aborted ? abortError(`git ${args[0]} aborted`) : error));
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (ctx.signal.aborted) {
				reject(abortError(`git ${args[0]} aborted`));
				return;
			}
			resolvePromise({ status: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
		});
		if (input !== undefined) {
			child.stdin?.on("error", () => {}); // child may die before reading all input
			child.stdin?.write(input);
			child.stdin?.end();
		}
	});
}

/** Run git, returning stdout; throws with a one-line stderr summary on failure. */
async function gitOut(args: string[], cwd: string, ctx: PrepContext, input?: Buffer | string): Promise<Buffer> {
	const result = await gitRun(args, cwd, ctx, input);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${(result.stderr.split("\n")[0] || "no stderr").trim()}`);
	}
	return result.stdout;
}

/** Run git returning trimmed stdout; empty string on failure (optional queries). */
async function gitQuiet(args: string[], cwd: string, ctx: PrepContext): Promise<string> {
	const result = await gitRun(args, cwd, ctx);
	if (result.status !== 0) return "";
	return result.stdout.toString("utf8").trim();
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Strictly decode one NUL-delimited git path: any bytes that are not valid UTF-8 fail closed instead of being silently replaced. */
export function decodeGitPath(bytes: Buffer): string {
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) {
		throw new Error("a git path is not valid UTF-8 (round-trip failed); snapshot failed closed rather than silently replacing it");
	}
	return text;
}

/** Split a NUL-delimited git path list on Buffer boundaries, decoding each path strictly. */
export function decodeGitPaths(buffer: Buffer): string[] {
	const paths: string[] = [];
	let start = 0;
	for (let i = 0; i <= buffer.length; i++) {
		if (i === buffer.length || buffer[i] === 0) {
			if (i > start) paths.push(decodeGitPath(buffer.subarray(start, i)));
			start = i + 1;
		}
	}
	return paths;
}

/** The Git worktree root containing `cwd`. Throws (fail closed) when `cwd` is not inside a Git worktree. */
async function worktreeRootOf(cwd: string, ctx: PrepContext): Promise<string> {
	return (await gitOut(["rev-parse", "--show-toplevel"], cwd, ctx)).toString("utf8").trim();
}

/** Capture-time workspace state: fingerprint plus the head/branch it was computed from. */
export interface WorkspaceFingerprint {
	/** sha256 over branch, HEAD, digests of the staged and unstaged binary diffs, refs/stash, and the sorted non-ignored untracked paths with per-entry content digests (symlinks hash their target text, never the target's content). */
	value: string;
	head: string;
	branch: string;
}

async function fingerprintWithCtx(root: string, ctx: PrepContext): Promise<WorkspaceFingerprint> {
	const head = (await gitOut(["rev-parse", "HEAD"], root, ctx)).toString("utf8").trim();
	const branch = (await gitQuiet(["symbolic-ref", "--short", "-q", "HEAD"], root, ctx)) || "(detached)";
	const stash = (await gitQuiet(["rev-parse", "-q", "--verify", "refs/stash"], root, ctx)) || "none";
	const staged = await gitOut(["diff", "--cached", "--binary"], root, ctx);
	const unstaged = await gitOut(["diff", "--binary"], root, ctx);
	const untracked = await gitOut(["ls-files", "--others", "--exclude-standard", "-z"], root, ctx);
	const hash = createHash("sha256");
	hash.update(`branch=${branch}\nhead=${head}\nstash=${stash}\n`);
	hash.update(`staged=${sha256(staged)}\nunstaged=${sha256(unstaged)}\n`);
	for (const path of decodeGitPaths(untracked).sort()) {
		throwIfAborted(ctx, "fingerprint");
		hash.update(`untracked:${path}:`);
		const full = join(root, path);
		const stats = await fsp.lstat(full);
		hash.update(stats.isSymbolicLink() ? `symlink:${await fsp.readlink(full)}` : sha256(await hashFileChecked(full, ctx)));
		hash.update("\n");
	}
	return { value: hash.digest("hex"), head, branch };
}

/**
 * Capture the parent workspace state; used to fail closed when the parent changes while its snapshot is being captured.
 * Chunked reads keep a single huge untracked file from blocking the event loop or buffering unboundedly.
 */
export async function workspaceFingerprint(root: string, signal?: AbortSignal, deadlineMs?: number): Promise<WorkspaceFingerprint> {
	const scope = prepScope(signal, deadlineMs);
	try {
		return await fingerprintWithCtx(root, scope.ctx);
	} finally {
		scope.done();
	}
}

/** Hash one file in bounded chunks, checking abort/deadline and the total untracked byte cap between chunks. */
async function hashFileChecked(path: string, ctx: PrepContext): Promise<string> {
	const hash = createHash("sha256");
	const handle = await fsp.open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		for (;;) {
			throwIfAborted(ctx, "reading untracked file");
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			ctx.untrackedBytes += bytesRead;
			if (ctx.untrackedBytes > MAX_UNTRACKED_BYTES) {
				throw new Error(`untracked snapshot exceeds ${MAX_UNTRACKED_BYTES} bytes; run failed closed`);
			}
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

/** Copy one file in bounded chunks (abort/deadline checks and the total byte cap between chunks), preserving the executable bit. */
async function copyFileChecked(src: string, dest: string, mode: number, ctx: PrepContext): Promise<void> {
	const [inHandle, outHandle] = await Promise.all([fsp.open(src, "r"), fsp.open(dest, "w", 0o600)]);
	try {
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		for (;;) {
			throwIfAborted(ctx, "copying untracked file");
			const { bytesRead } = await inHandle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			ctx.untrackedBytes += bytesRead;
			if (ctx.untrackedBytes > MAX_UNTRACKED_BYTES) {
				throw new Error(`untracked snapshot exceeds ${MAX_UNTRACKED_BYTES} bytes; run failed closed`);
			}
			await outHandle.write(buffer.subarray(0, bytesRead));
		}
	} finally {
		await inHandle.close();
		await outHandle.close();
	}
	await fsp.chmod(dest, mode);
}

/** Capture-time consistency guard: a mismatched fingerprint means the copied snapshot may be internally inconsistent, so preparation fails closed. No retry, no auto-repair. */
export function assertSnapshotConsistent(before: string, after: string): void {
	if (before !== after) {
		throw new Error("workspace changed while capturing the read-only snapshot; run failed closed (no retry, no auto-repair)");
	}
}

/** Resolve a git-relative path inside `base`; refuses paths that escape the repository. */
function safeJoin(base: string, rel: string): string {
	const resolved = resolve(base, rel);
	const boundary = resolve(base) + sep;
	if (resolved !== resolve(base) && !resolved.startsWith(boundary)) {
		throw new Error(`untracked path escapes the repository: ${rel}`);
	}
	return resolved;
}

async function copyDir(src: string, dest: string, ctx: PrepContext): Promise<void> {
	await fsp.mkdir(dest, { recursive: true });
	for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
		throwIfAborted(ctx, "copying untracked directory");
		const source = join(src, entry.name);
		const target = join(dest, entry.name);
		if (entry.isSymbolicLink()) await fsp.symlink(await fsp.readlink(source), target);
		else if (entry.isDirectory()) await copyDir(source, target, ctx);
		else if (entry.isFile()) await copyFileChecked(source, target, (await fsp.lstat(source)).mode & 0o777, ctx);
	}
}

/** Copy one non-ignored untracked entry (file, symlink, or directory) into the clone, preserving paths and the executable bit; symlinks are recreated, never followed. */
async function copyUntracked(cloneRoot: string, root: string, path: string, ctx: PrepContext): Promise<void> {
	const source = join(root, path);
	const target = safeJoin(cloneRoot, path);
	await fsp.mkdir(dirname(target), { recursive: true });
	const stats = await fsp.lstat(source);
	if (stats.isSymbolicLink()) await fsp.symlink(await fsp.readlink(source), target);
	else if (stats.isDirectory()) await copyDir(source, target, ctx);
	else await copyFileChecked(source, target, stats.mode & 0o777, ctx);
}

/**
 * Reproduce the parent's working-tree state in the clone: the staged binary
 * patch lands in the clone's index and working tree together (`--index`), the
 * unstaged binary patch lands in the working tree only, then non-ignored
 * untracked files are copied (ignored files are never copied). Submodule
 * pointer changes are not supported (deferred) and fail closed.
 */
async function materializeSnapshot(root: string, cloneRoot: string, ctx: PrepContext): Promise<void> {
	const staged = await gitOut(["diff", "--cached", "--binary"], root, ctx);
	const unstaged = await gitOut(["diff", "--binary"], root, ctx);
	if (staged.includes(Buffer.from("Subproject commit")) || unstaged.includes(Buffer.from("Subproject commit"))) {
		throw new Error("submodule pointer changes are not supported in disposable clones (deferred); snapshot failed closed");
	}
	if (staged.length > 0) await gitOut(["apply", "--index", "--binary"], cloneRoot, ctx, staged);
	if (unstaged.length > 0) await gitOut(["apply", "--binary"], cloneRoot, ctx, unstaged);
	const untracked = await gitOut(["ls-files", "--others", "--exclude-standard", "-z"], root, ctx);
	for (const path of decodeGitPaths(untracked)) await copyUntracked(cloneRoot, root, path, ctx);
}

/** Deliberately invalid push URL for one clone: a `file://` URL to a non-existent path inside the run temp dir, so a plain `git push` fails fast on every platform and never reaches the network. Best-effort speed bump for policy-following children, not a security boundary. */
export function invalidPushUrl(tempDir: string): string {
	return pathToFileURL(join(tempDir, "invalid-push")).href;
}

/**
 * Create the per-run clone: plain local clone with `--no-local` (full object
 * copy over the file transport — no shared hardlinks, no alternates from the
 * source; the absence of `objects/info/alternates` is verified) at the
 * parent's local HEAD, detached checkout. The clone's refs, stash, config,
 * index, and working tree are its own. Remotes: origin's fetch URL becomes
 * the source's origin fetch URL when it has one (so `gh` repo discovery keeps
 * working), and every existing remote's push URL is set to a deliberately
 * invalid per-clone `file://` path (best effort; not a security boundary).
 */
async function createClone(root: string, tempDir: string, ctx: PrepContext): Promise<string> {
	const head = (await gitOut(["rev-parse", "HEAD"], root, ctx)).toString("utf8").trim();
	const cloneRoot = join(tempDir, CLONE_DIR);
	await gitOut(["clone", "--no-local", "--no-checkout", "--", root, cloneRoot], tempDir, ctx);
	await gitOut(["checkout", "--detach", head], cloneRoot, ctx);
	// Verify the clone's object store does not reference the source's: a local
	// clone can inherit `objects/info/alternates` from the source, which would
	// couple the child's object store to the parent's. With `--no-local` every
	// reachable object was already fetched, so a copied alternates pointer would
	// be redundant — remove it if git wrote one, and fail closed if it persists.
	// (The worktree path is left alone: it may be a legitimately tracked file.)
	const alternates = join(cloneRoot, ".git", "objects", "info", "alternates");
	await fsp.rm(alternates, { force: true }).catch(() => {});
	if (await fsp.readFile(alternates, "utf8").then(() => true, () => false)) {
		throw new Error("clone unexpectedly shares objects via alternates; run failed closed");
	}
	const originFetchUrl = await gitQuiet(["config", "--get", "remote.origin.url"], root, ctx);
	if (originFetchUrl && (await gitQuiet(["remote"], cloneRoot, ctx)).split("\n").includes("origin")) {
		await gitOut(["remote", "set-url", "origin", originFetchUrl], cloneRoot, ctx);
	}
	for (const remote of (await gitQuiet(["remote"], cloneRoot, ctx)).split("\n").filter(Boolean)) {
		await gitOut(["remote", "set-url", "--push", remote, invalidPushUrl(tempDir)], cloneRoot, ctx);
	}
	return cloneRoot;
}

/**
 * Prepare the disposable clone for a read-only run: locate the worktree,
 * fingerprint the parent, clone, materialize the working-tree snapshot,
 * fingerprint again (mismatch fails closed), and map the parent cwd to the
 * matching subdirectory of the clone. Any failure throws — never fall back to
 * the shared cwd. The whole preparation shares one total deadline, and the
 * external signal aborts it at any point (killing the current git child);
 * both reject with an AbortError so callers can settle the run as stopped.
 */
export async function prepareClone(cwd: string, tempDir: string, signal?: AbortSignal, deadlineMs?: number): Promise<CloneBaseline> {
	const scope = prepScope(signal, deadlineMs);
	try {
		const ctx = scope.ctx;
		throwIfAborted(ctx, "start");
		const root = await fsp.realpath(await worktreeRootOf(cwd, ctx));
		const resolvedCwd = await fsp.realpath(cwd);
		const before = await fingerprintWithCtx(root, ctx);
		const cloneRoot = await createClone(root, tempDir, ctx);
		await materializeSnapshot(root, cloneRoot, ctx);
		const after = await fingerprintWithCtx(root, ctx);
		assertSnapshotConsistent(before.value, after.value);
		const rel = relative(root, resolvedCwd);
		if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
			throw new Error(`parent cwd escapes its worktree root: ${cwd}`);
		}
		return {
			root,
			head: after.head,
			branch: after.branch,
			fingerprint: after.value,
			asOf: Date.now(),
			cloneRoot,
			childCwd: join(cloneRoot, rel === "" ? "." : rel),
		};
	} finally {
		scope.done();
	}
}

export interface ChildWorkspace {
	cwd: string;
	baseline?: CloneBaseline;
}

/** The run's working directory: the subagent `cwd` parameter when given (relative paths resolve against the parent's cwd), else the parent's cwd. Read-only runs snapshot this directory as their clone source; write-capable runs are spawned here. */
export function resolveRunCwd(cwd: string | undefined, ctxCwd: string): string {
	return cwd === undefined ? ctxCwd : resolve(ctxCwd, cwd);
}

/** Write-capable agents keep the run's working directory; read-only agents (research-plan, reviewer) get a per-run disposable clone of that directory (the subagent `cwd` parameter, default the parent's). Fail closed: preparation failure throws and never falls back to the shared cwd. */
export async function resolveChildCwd(agent: AgentConfig, cwd: string, tempDir: string, signal?: AbortSignal): Promise<ChildWorkspace> {
	if (isWriter(agent)) return { cwd };
	const baseline = await prepareClone(cwd, tempDir, signal);
	return { cwd: baseline.childCwd, baseline };
}
