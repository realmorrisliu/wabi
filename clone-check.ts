// clone-check.ts — isolation integration check for read-only subagent runs.
// Exercises the disposable per-run clone from extensions/subagents/clone.ts
// against real git fixtures: snapshot fidelity, mutation containment (fetch
// races, checkout detach, stash collisions, reset --hard), subdirectory and
// remote handling, cleanup, fail-closed preparation, async cancellation
// (abort + shared total deadline), alternate-backed sources, and non-UTF8
// path rejection. This is NOT the evidence-ownership contract check (see
// orchestration-check.ts). Run: bun clone-check.ts

import { spawn, spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CLONE_PREP_DEADLINE_MS,
	assertSnapshotConsistent,
	decodeGitPaths,
	invalidPushUrl,
	prepareClone,
	resolveChildCwd,
	workspaceFingerprint,
} from "./extensions/subagents/clone.ts";

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
/** Run git returning trimmed stdout, or "" when it fails (optional queries). */
function gitQuietOk(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) return "";
	return result.stdout.trim();
}
/** Run git asynchronously (for the parallel-fetch containment test). */
function gitAsync(args: string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("close", (code) => resolve({ code, stderr }));
	});
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(["init", "-q", dir], dirname(dir));
	git(["config", "user.email", "t@t"], dir);
	git(["config", "user.name", "t"], dir);
	git(["checkout", "-q", "-b", "main"], dir);
}

const BIN_A = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x00, 0x0a, 0x0d]);
const BIN_B = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x01, 0x02, 0xfe, 0xed]);
const BIN_C = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x11, 0x22, 0x33]);

// ---------------------------------------------------------------------------
// Fixture: the hard cases — one file with staged and unstaged changes at the
// same time, a staged deletion, staged and unstaged binary changes, non-ignored
// untracked files (text, binary, symlink), and an ignored file.
// ---------------------------------------------------------------------------
function buildSnapshotFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "wabi-clone-fix-"));
	initRepo(root);
	writeFileSync(join(root, "a.txt"), "a1\n");
	writeFileSync(join(root, "b.txt"), "b1\n");
	writeFileSync(join(root, "del.txt"), "d1\n");
	writeFileSync(join(root, "bin.dat"), BIN_A);
	writeFileSync(join(root, "bin2.dat"), BIN_B);
	writeFileSync(join(root, ".gitignore"), "*.log\n");
	git(["add", "."], root);
	git(["commit", "-qm", "c1"], root);

	// One file with staged AND unstaged changes at the same time.
	writeFileSync(join(root, "a.txt"), "a2\n");
	git(["add", "a.txt"], root);
	writeFileSync(join(root, "a.txt"), "a3\n");
	// Staged binary change.
	writeFileSync(join(root, "bin.dat"), BIN_C);
	git(["add", "bin.dat"], root);
	// Staged deletion.
	git(["rm", "-q", "del.txt"], root);
	// Unstaged binary change.
	writeFileSync(join(root, "bin2.dat"), BIN_B.subarray(0, 6));
	// Non-ignored untracked: text, binary, symlink.
	writeFileSync(join(root, "note.txt"), "untracked note\n");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "untracked.bin"), BIN_A);
	symlinkSync("a.txt", join(root, "link"));
	// Ignored file: must never reach the clone.
	writeFileSync(join(root, "ignored.log"), "ignored\n");
	return root;
}

// ---------------------------------------------------------------------------
// 1. Snapshot fidelity
// ---------------------------------------------------------------------------
{
	const root = buildSnapshotFixture();
	const tempDir = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		const baseline = await prepareClone(root, tempDir);
		const clone = baseline.cloneRoot;
		const parentStaged = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: root });
		const cloneStaged = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: clone });
		const parentUnstaged = execFileSync("git", ["diff", "--binary"], { cwd: root });
		const cloneUnstaged = execFileSync("git", ["diff", "--binary"], { cwd: clone });
		check("fidelity: staged binary diff reproduced byte-for-byte (index)", Buffer.compare(parentStaged, cloneStaged) === 0);
		check("fidelity: unstaged binary diff reproduced byte-for-byte (worktree)", Buffer.compare(parentUnstaged, cloneUnstaged) === 0);
		const parentStatus = git(["status", "--porcelain"], root).split("\n").filter(Boolean).sort();
		const cloneStatus = git(["status", "--porcelain"], clone).split("\n").filter(Boolean).sort();
		check("fidelity: full porcelain status matches (index + worktree + untracked)", JSON.stringify(parentStatus) === JSON.stringify(cloneStatus));
		const parentUntracked = git(["ls-files", "--others", "--exclude-standard"], root).split("\n").filter(Boolean).sort();
		const cloneUntracked = git(["ls-files", "--others", "--exclude-standard"], clone).split("\n").filter(Boolean).sort();
		check("fidelity: non-ignored untracked set matches", JSON.stringify(parentUntracked) === JSON.stringify(cloneUntracked) && parentUntracked.includes("link") && parentUntracked.includes("note.txt") && parentUntracked.includes("sub/untracked.bin"));
		check("fidelity: ignored file absent from the clone", !existsSync(join(clone, "ignored.log")) && !cloneUntracked.includes("ignored.log"));
		check("fidelity: staged+unstaged file carries both states", readFileSync(join(clone, "a.txt"), "utf8") === "a3\n" && git(["diff", "--cached", "--name-only"], clone).split("\n").includes("a.txt"));
		check("fidelity: staged binary content in index and worktree", Buffer.compare(readFileSync(join(clone, "bin.dat")), BIN_C) === 0);
		check("fidelity: unstaged binary content in worktree only", Buffer.compare(readFileSync(join(clone, "bin2.dat")), BIN_B.subarray(0, 6)) === 0 && !git(["diff", "--cached", "--name-only"], clone).split("\n").includes("bin2.dat"));
		check("fidelity: staged deletion applied to index and worktree", !existsSync(join(clone, "del.txt")) && git(["diff", "--cached", "--name-only"], clone).split("\n").includes("del.txt"));
		check("fidelity: untracked binary copied byte-for-byte", Buffer.compare(readFileSync(join(clone, "sub", "untracked.bin")), BIN_A) === 0);
		check("fidelity: untracked symlink recreated as a symlink to the same target", lstatSync(join(clone, "link")).isSymbolicLink() && readlinkSync(join(clone, "link")) === "a.txt");
		check("fidelity: detached HEAD at the parent's launch HEAD", git(["rev-parse", "HEAD"], clone) === baseline.head && git(["rev-parse", "--symbolic-full-name", "HEAD"], clone) === "HEAD");
		check("fidelity: baseline carries head, branch, fingerprint, as-of", baseline.head === git(["rev-parse", "HEAD"], root) && baseline.branch === "main" && baseline.fingerprint.length === 64 && baseline.asOf > 0);
		check("fidelity: clone lives inside the run temp dir", baseline.cloneRoot.startsWith(tempDir));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 2. Mutation containment: fetch races, checkout detach, stash collisions,
//    reset --hard — with concurrent parent fetch. Parent state must be
//    untouched and no ref lock errors may occur.
// ---------------------------------------------------------------------------
{
	const root = mkdtempSync(join(tmpdir(), "wabi-clone-mut-"));
	const upstream = join(dirname(root), `${dirname(root).split("/").at(-1)}-upstream.git`);
	const upstreamSrc = join(dirname(root), "upstream-src");
	try {
		initRepo(root);
		writeFileSync(join(root, "a.txt"), "a1\n");
		git(["add", "."], root);
		git(["commit", "-qm", "c1"], root);
		git(["checkout", "-q", "-b", "other"], root);
		writeFileSync(join(root, "a.txt"), "a2\n");
		git(["add", "."], root);
		git(["commit", "-qm", "c2"], root);
		git(["checkout", "-q", "main"], root);
		// Parent has a remote of its own to fetch from concurrently with the clones.
		initRepo(upstreamSrc);
		writeFileSync(join(upstreamSrc, "u.txt"), "u1\n");
		git(["add", "."], upstreamSrc);
		git(["commit", "-qm", "u1"], upstreamSrc);
		git(["clone", "-q", "--bare", upstreamSrc, upstream], dirname(root));
		git(["remote", "add", "upstream", upstream], root);

		const parentBefore = {
			head: git(["rev-parse", "HEAD"], root),
			status: git(["status", "--porcelain"], root),
			stash: git(["stash", "list"], root),
			branches: git(["branch", "--format=%(refname)"], root),
			refs: git(["for-each-ref", "--format=%(refname)"], root),
		};
		const run1 = mkdtempSync(join(tmpdir(), "wabi-clone-run1-"));
		const run2 = mkdtempSync(join(tmpdir(), "wabi-clone-run2-"));
		try {
			const clone1 = (await prepareClone(root, run1)).cloneRoot;
			const clone2 = (await prepareClone(root, run2)).cloneRoot;
			// The incident replay: parent fetches while two independent clones also
			// fetch (from the parent's local path), concurrently. Separate repos,
			// separate refs — no shared ref locks.
		const [parentFetch, childFetch1, childFetch2] = await Promise.all([
				gitAsync(["fetch", "upstream"], root),
				gitAsync(["fetch"], clone1),
				gitAsync(["fetch"], clone2),
			]);
			check("containment: concurrent parent + child fetches all succeed, no ref lock errors", [parentFetch, childFetch1, childFetch2].every((r) => r.code === 0) && [parentFetch, childFetch1, childFetch2].every((r) => !/lock|unable to create/i.test(r.stderr)));
			// Parent state is captured after its own fetch, then the child mutations run.
			const parentBefore = {
				head: git(["rev-parse", "HEAD"], root),
				status: git(["status", "--porcelain"], root),
				stash: git(["stash", "list"], root),
				branches: git(["branch", "--format=%(refname)"], root),
				refs: git(["for-each-ref", "--format=%(refname)"], root),
			};
			// A misbehaving child in the clone: fetch, checkout another branch,
			// stash + pop, reset --hard.
			git(["fetch"], clone1);
			git(["checkout", "-q", "other"], clone1);
			writeFileSync(join(clone1, "a.txt"), "child dirty\n");
			git(["stash", "-q"], clone1);
			check("containment: child stash wrote only the clone's own refs/stash", gitQuietOk(["rev-parse", "-q", "--verify", "refs/stash"], clone1) !== "" && git(["stash", "list"], root) === "");
			git(["stash", "pop", "-q"], clone1);
			writeFileSync(join(clone1, "a.txt"), "about to be wiped\n");
			git(["reset", "--hard", "-q", "HEAD"], clone1);
			check("containment: child checkout of another branch stayed inside the clone", git(["branch", "--format=%(refname)"], root) === parentBefore.branches && git(["branch", "--show-current"], clone1) === "other");
			const parentAfter = {
				head: git(["rev-parse", "HEAD"], root),
				status: git(["status", "--porcelain"], root),
				stash: git(["stash", "list"], root),
				branches: git(["branch", "--format=%(refname)"], root),
				refs: git(["for-each-ref", "--format=%(refname)"], root),
			};
			check("containment: parent HEAD, branch, index, worktree, stash, and refs all unchanged", JSON.stringify(parentAfter) === JSON.stringify(parentBefore));
			// The clone still exists while the run is live, and is deleted with its temp dir.
			check("cleanup: clone exists during the run", existsSync(clone1));
			rmSync(run1, { recursive: true, force: true });
			check("cleanup: clone deleted with its run temp dir", !existsSync(clone1));
		} finally {
			rmSync(run1, { recursive: true, force: true });
			rmSync(run2, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(upstream, { recursive: true, force: true });
		rmSync(upstreamSrc, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 3. Subdirectory mapping and remotes: origin fetch URL preserved, plain push
//    fails fast on the deliberately invalid push URL.
// ---------------------------------------------------------------------------
{
	const root = mkdtempSync(join(tmpdir(), "wabi-clone-sub-"));
	const origin = join(dirname(root), `${dirname(root).split("/").at(-1)}-origin.git`);
	const tempDir = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		initRepo(root);
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "x.txt"), "x1\n");
		git(["add", "."], root);
		git(["commit", "-qm", "c1"], root);
		writeFileSync(join(root, "sub", "u.txt"), "u1\n"); // untracked, copied into the clone subdir
		git(["clone", "-q", "--bare", root, origin], dirname(root));
		git(["remote", "add", "origin", origin], root);
		const baseline = await prepareClone(join(root, "sub"), tempDir);
		check("remotes: child cwd maps to the matching subdirectory of the clone", baseline.childCwd === join(baseline.cloneRoot, "sub") && existsSync(join(baseline.childCwd, "x.txt")) && existsSync(join(baseline.childCwd, "u.txt")));
		check("remotes: clone origin fetch URL copies the source's origin fetch URL", git(["config", "--get", "remote.origin.url"], baseline.cloneRoot) === origin);
		check("remotes: invalid push URL is a per-clone file:// URL (cross-platform, no /dev/null)", invalidPushUrl(tempDir).startsWith("file://") && invalidPushUrl(tempDir).includes("invalid-push") && !invalidPushUrl(tempDir).includes("/dev/null"));
		check("remotes: every clone remote push URL is the deliberately invalid per-clone path", git(["config", "--get", "remote.origin.pushurl"], baseline.cloneRoot) === invalidPushUrl(tempDir));
		const push = spawnSync("git", ["push", "origin", "HEAD"], { cwd: baseline.cloneRoot, encoding: "utf8" });
		check("remotes: plain git push fails fast on the invalid push URL, never reaching the network", push.status !== 0 && push.stderr.includes("invalid-push"));
		check("remotes: clone refs are its own (local default branch, origin remote-tracking, no shared refs)", git(["for-each-ref", "--format=%(refname)"], baseline.cloneRoot).split("\n").every((ref) => /^refs\/(heads\/|remotes\/origin\/|tags\/)/.test(ref)));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(origin, { recursive: true, force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 4. Cleanup, consistency, and fail-closed preparation.
// ---------------------------------------------------------------------------
{
	// Cleanup: the clone lives inside the run temp dir and dies with it.
	const root = buildSnapshotFixture();
	const tempDir = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		const baseline = await prepareClone(root, tempDir);
		rmSync(tempDir, { recursive: true, force: true });
		check("cleanup: clone removed when its run temp dir is removed", !existsSync(baseline.cloneRoot));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}

	// Non-Git cwd: fail closed.
	const plain = mkdtempSync(join(tmpdir(), "wabi-clone-plain-"));
	const runDir = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		let threw = false;
		try {
			await prepareClone(plain, runDir);
		} catch {
			threw = true;
		}
		check("fail-closed: non-Git cwd throws (no fallback to the shared cwd)", threw && !existsSync(join(runDir, "clone")));
	} finally {
		rmSync(plain, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}

	// Unborn HEAD repo (git init, no commits): forced preparation failure.
	const unborn = mkdtempSync(join(tmpdir(), "wabi-clone-unborn-"));
	const runDir2 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		initRepo(unborn);
		let threw = false;
		try {
			await prepareClone(unborn, runDir2);
		} catch {
			threw = true;
		}
		check("fail-closed: repo without a commit fails preparation closed", threw);
	} finally {
		rmSync(unborn, { recursive: true, force: true });
		rmSync(runDir2, { recursive: true, force: true });
	}

	// Capture-time consistency guard: mismatch fails closed, no retry/auto-repair.
	check("consistency: matching fingerprints pass the guard", (() => { assertSnapshotConsistent("a", "a"); return true; })());
	check("consistency: mismatched fingerprints fail closed", (() => { try { assertSnapshotConsistent("a", "b"); return false; } catch { return true; } })());

	// Submodule pointer changes are deferred: they fail closed instead of
	// silently producing a misrepresented snapshot.
	const parent = mkdtempSync(join(tmpdir(), "wabi-clone-submod-"));
	const subSrc = join(dirname(parent), "sub-src");
	const runDir3 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		initRepo(parent);
		writeFileSync(join(parent, "top.txt"), "t1\n");
		git(["add", "."], parent);
		git(["commit", "-qm", "c1"], parent);
		initRepo(subSrc);
		writeFileSync(join(subSrc, "s.txt"), "s1\n");
		git(["add", "."], subSrc);
		git(["commit", "-qm", "s1"], subSrc);
		git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "sub"], parent);
		git(["commit", "-qm", "add submodule"], parent);
		writeFileSync(join(subSrc, "s.txt"), "s2\n");
		git(["add", "."], subSrc);
		git(["commit", "-qm", "s2"], subSrc);
		git(["-C", "sub", "pull", "-q"], parent); // advance the checked-out gitlink pointer
		git(["add", "sub"], parent); // staged submodule pointer change
		let threw = false;
		try {
			await prepareClone(parent, runDir3);
		} catch (error) {
			threw = String(error).includes("submodule");
		}
		check("fail-closed: submodule pointer changes fail closed (deferred)", threw);
	} finally {
		rmSync(parent, { recursive: true, force: true });
		rmSync(subSrc, { recursive: true, force: true });
		rmSync(runDir3, { recursive: true, force: true });
	}

	// Writer routing: write-capable agents keep the shared cwd; read-only agents
	// get a clone. resolveChildCwd is the exact decision the extension makes.
	const repo = buildSnapshotFixture();
	const runDir4 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		const writer = { name: "worker", description: "", tools: ["read", "edit"], systemPrompt: "" };
		const reader = { name: "scout", description: "", tools: ["read", "bash"], systemPrompt: "" };
		const writerWorkspace = await resolveChildCwd(writer, repo, runDir4);
		check("routing: writer keeps the shared cwd, no clone, no baseline", writerWorkspace.cwd === repo && writerWorkspace.baseline === undefined && !existsSync(join(runDir4, "clone")));
		const readerWorkspace = await resolveChildCwd(reader, repo, runDir4);
		check("routing: read-only agent gets the clone and its baseline", readerWorkspace.baseline !== undefined && readerWorkspace.cwd === readerWorkspace.baseline.childCwd && readerWorkspace.cwd.startsWith(join(runDir4, "clone")));
		// The fingerprint must be stable across captures of an unchanged workspace
		// and must change when the workspace changes.
		const fp1 = await workspaceFingerprint(repo);
		const fp2 = await workspaceFingerprint(repo);
		writeFileSync(join(repo, "note.txt"), "changed\n");
		const fp3 = await workspaceFingerprint(repo);
		check("consistency: fingerprint stable across captures, sensitive to workspace changes", fp1.value === fp2.value && fp1.value !== fp3.value);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir4, { recursive: true, force: true });
	}
}

// materializeSnapshot's staged→index+worktree / unstaged→worktree-only contract
// is covered end-to-end by the fidelity checks above (byte-identical staged and
// unstaged diffs plus porcelain status).

// ---------------------------------------------------------------------------
// 5. Async, cancelable preparation: the async API, abort during preparation,
//    the one shared total deadline, alternate-backed sources, and non-UTF8
//    paths failing closed. (The cleanup-helper and deadline constants live in
//    lib.ts/check.ts and the extension wiring in smoke.ts.)
// ---------------------------------------------------------------------------
{
	// Async API: preparation resolves with a usable baseline.
	const root = buildSnapshotFixture();
	const tempDir = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		const baseline = await prepareClone(root, tempDir);
		check("async: prepareClone resolves with a usable baseline", baseline.fingerprint.length === 64 && existsSync(baseline.cloneRoot));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}

	// A pre-aborted signal: preparation rejects with AbortError before any git work.
	const root2 = buildSnapshotFixture();
	const tempDir2 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		const controller = new AbortController();
		controller.abort();
		const error = await prepareClone(root2, tempDir2, controller.signal).then(() => null, (caught) => caught);
		check("async: a pre-aborted signal rejects preparation with AbortError", error instanceof Error && error.name === "AbortError");
	} finally {
		rmSync(root2, { recursive: true, force: true });
		rmSync(tempDir2, { recursive: true, force: true });
	}

	// Abort while preparation is in flight (git child running): rejects with AbortError.
	const root3 = buildSnapshotFixture();
	const tempDir3 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		const controller = new AbortController();
		const pending = prepareClone(root3, tempDir3, controller.signal).then(() => null, (caught) => caught);
		controller.abort();
		const error = await pending;
		check("async: aborting mid-preparation rejects with AbortError", error instanceof Error && error.name === "AbortError");
	} finally {
		rmSync(root3, { recursive: true, force: true });
		rmSync(tempDir3, { recursive: true, force: true });
	}

	// One shared total deadline (not per-command): a tiny deadline rejects the
	// whole preparation quickly, with the same AbortError a stop would produce.
	const root4 = buildSnapshotFixture();
	const tempDir4 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		check("async: default deadline constant is a single positive total", CLONE_PREP_DEADLINE_MS > 0);
		const started = Date.now();
		const error = await prepareClone(root4, tempDir4, undefined, 5).then(() => null, (caught) => caught);
		check("async: the shared total deadline rejects preparation with AbortError, well under the constant", error instanceof Error && error.name === "AbortError" && Date.now() - started < CLONE_PREP_DEADLINE_MS);
	} finally {
		rmSync(root4, { recursive: true, force: true });
		rmSync(tempDir4, { recursive: true, force: true });
	}

	// Alternate-backed source: the clone must not inherit alternates and must stay
	// fully functional when the shared object store is destroyed.
	const shared = mkdtempSync(join(tmpdir(), "wabi-clone-shared-"));
	const source = mkdtempSync(join(tmpdir(), "wabi-clone-alt-"));
	const tempDir5 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
	try {
		initRepo(shared);
		writeFileSync(join(shared, "base.txt"), "base\n");
		git(["add", "."], shared);
		git(["commit", "-qm", "base"], shared);
		// Build the alternate-backed source deterministically: `git clone --shared`
		// hardlinks on one filesystem and writes no alternates file, so write the
		// real object-store alternates pointer (`<source>/.git/objects/info/alternates`)
		// by hand and fetch the shared objects through it.
		initRepo(source);
		mkdirSync(join(source, ".git", "objects", "info"), { recursive: true });
		writeFileSync(join(source, ".git", "objects", "info", "alternates"), `${join(shared, "objects")}\n`);
		git(["fetch", "-q", shared, "main"], source);
		git(["checkout", "-q", "-B", "main", "FETCH_HEAD"], source);
		writeFileSync(join(source, "work.txt"), "work\n");
		git(["add", "."], source);
		git(["commit", "-qm", "work"], source);
		check("alternates: fixture source is alternate-backed", existsSync(join(source, ".git", "objects", "info", "alternates")));
		const baseline = await prepareClone(source, tempDir5);
		const head = baseline.head;
		check("alternates: clone has no alternates file", !existsSync(join(baseline.cloneRoot, ".git", "objects", "info", "alternates")));
		rmSync(shared, { recursive: true, force: true }); // the source is now broken; the clone must not be
		check("alternates: clone stays fully functional without the shared object store", git(["rev-parse", "HEAD"], baseline.cloneRoot) === head && git(["status", "--porcelain"], baseline.cloneRoot) === "");
	} finally {
		rmSync(shared, { recursive: true, force: true });
		rmSync(source, { recursive: true, force: true });
		rmSync(tempDir5, { recursive: true, force: true });
	}

	// Non-UTF8 git path: NUL-delimited paths are split as bytes and each path must
	// round-trip strict UTF-8; otherwise preparation fails closed instead of
	// silently replacing the path. The decoder itself is deterministic everywhere;
	// the on-disk fixture is POSIX-only and skipped when the filesystem refuses
	// raw-byte names (APFS rejects them with EILSEQ).
	check("fail-closed: git path decoder round-trips valid UTF-8 paths", (() => {
		const bytes = Buffer.from("a/b.txt\0中文\0emoji-🚀.ts\0");
		return JSON.stringify(decodeGitPaths(bytes)) === JSON.stringify(["a/b.txt", "中文", "emoji-🚀.ts"]);
	})());
	check("fail-closed: git path decoder rejects non-UTF8 bytes instead of replacing them", (() => {
		try {
			decodeGitPaths(Buffer.from([0x6f, 0x6b, 0x00, 0xff, 0xfe, 0x00]));
			return false;
		} catch (error) {
			return error instanceof Error && /utf-8/i.test(String(error));
		}
	})());
	if (process.platform !== "win32") {
		const root6 = mkdtempSync(join(tmpdir(), "wabi-clone-nonutf8-"));
		const tempDir6 = mkdtempSync(join(tmpdir(), "wabi-clone-run-"));
		try {
			initRepo(root6);
			writeFileSync(join(root6, "tracked.txt"), "x\n");
			git(["add", "."], root6);
			git(["commit", "-qm", "c1"], root6);
			const badPath = Buffer.concat([Buffer.from(join(root6, "untracked-")), Buffer.from([0xff, 0xfe]), Buffer.from(".txt")]);
			try {
				writeFileSync(badPath, "content\n");
			} catch (error) {
				// APFS rejects raw-byte names; the pure decoder checks above still pin the behavior.
				check("fail-closed: non-UTF8 on-disk fixture skipped (filesystem refuses raw-byte names)", true);
				throw new Error("__skip__");
			}
			const error = await prepareClone(root6, tempDir6).then(() => null, (caught) => caught);
			check("fail-closed: non-UTF8 untracked path fails closed instead of silent replacement", error instanceof Error && /utf-8/i.test(String(error)));
		} catch (error) {
			if (error instanceof Error && error.message !== "__skip__") throw error;
		} finally {
			rmSync(root6, { recursive: true, force: true });
			rmSync(tempDir6, { recursive: true, force: true });
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} clone check(s) FAILED`);
	process.exit(1);
}
console.log("\nall clone checks passed");
