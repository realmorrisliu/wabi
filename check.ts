// check.ts — self-check for wabi's pure logic. Run: bun check.ts

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentConfig,
	type HandoffFields,
	BACKGROUND_DELIVERY,
	archivedRunOf,
	ARTIFACT_ENTRY_BYTES,
	ARTIFACT_ERROR_BYTES,
	ARTIFACT_FILE_BYTES,
	ARTIFACT_MAX_RUNS,
	ARTIFACT_STDERR_BYTES,
	ARTIFACT_TASK_BYTES,
	CircuitBreaker,
	CIRCUIT_COOLDOWN_MS,
	circuitBlockedMessage,
	childEnv,
	composeSystemPrompt,
	contentText,
	createRunId,
	discoverAgents,
	ensureRunsDir,
	FAILURE_OUTPUT_BYTES,
	finishUnresolvedRuns,
	formatDuration,
	formatHandoff,
	HANDOFF_CONTRACT,
	HANDOFF_ENVELOPE_BYTES,
	isCompletedRun,
	isolationPct,
	isWriter,
	JsonlDecoder,
	launchPolicy,
	loadRunArtifacts,
	MAX_CHILDREN,
	MAX_TRANSCRIPT_ENTRIES,
	parseFrontmatter,
	parseRunArtifact,
	removeTempDirBestEffort,
	runArtifactPath,
	serializeRunArtifact,
	sessionRunsDir,
	truncateUtf8,
	writeRunArtifact,
} from "./extensions/subagents/lib.ts";

let failures = 0;
function check(name: string, condition: boolean) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

// Incremental JSONL parsing survives arbitrary chunk boundaries.
const decoder = new JsonlDecoder();
let decoded = decoder.push('{"type":"one"}\n{"type":"two"');
check("JsonlDecoder: emits complete lines", decoded.events.length === 1 && decoded.events[0].type === "one");
decoded = decoder.push('}\nbroken\n{"type":"three"}');
check("JsonlDecoder: joins split lines", decoded.events.length === 1 && decoded.events[0].type === "two");
check("JsonlDecoder: reports malformed lines", decoded.errors.length === 1 && decoded.errors[0] === "broken");
decoded = decoder.flush();
check("JsonlDecoder: flushes final unterminated line", decoded.events.length === 1 && decoded.events[0].type === "three");
const unicodeDecoder = new JsonlDecoder();
const unicodeLine = Buffer.from('{"text":"你好"}\n');
const splitAt = unicodeLine.indexOf(Buffer.from("好")) + 1;
unicodeDecoder.push(unicodeLine.subarray(0, splitAt));
decoded = unicodeDecoder.push(unicodeLine.subarray(splitAt));
check("JsonlDecoder: preserves split UTF-8 characters", decoded.events[0]?.text === "你好");

const truncated = truncateUtf8("你".repeat(100), 100);
check("truncateUtf8: respects byte cap", Buffer.byteLength(truncated) <= 100);
check("truncateUtf8: does not split UTF-8", !truncated.includes("�"));
check("truncateUtf8: leaves short text unchanged", truncateUtf8("short", 100) === "short");
check("truncateUtf8: tiny maxBytes stays valid", truncateUtf8("hello", 0) === "" && Buffer.byteLength(truncateUtf8("hello", 3)) <= 3);
check("truncateUtf8: Chinese boundary keeps budget and UTF-8", (() => { const t = truncateUtf8("你".repeat(100), 100); return Buffer.byteLength(t) <= 100 && !t.includes("�"); })());
check("truncateUtf8: emoji boundary keeps budget and UTF-8", (() => { const t = truncateUtf8("🚀".repeat(50), 20); return Buffer.byteLength(t) <= 20 && !t.includes("�"); })());
check("truncateUtf8: maxBytes smaller than suffix still obeys cap", (() => { const t = truncateUtf8("x".repeat(500), 5); return Buffer.byteLength(t) <= 5 && !t.includes("�"); })());

const bigOutput = "word ".repeat(10_000);
const successEnvelope = formatHandoff({ runId: "worker-1", agent: "worker", status: "completed", output: bigOutput });
check("formatHandoff: success envelope <= 8KiB incl. metadata", Buffer.byteLength(successEnvelope) <= HANDOFF_ENVELOPE_BYTES);
check("formatHandoff: success envelope carries metadata", successEnvelope.includes("run: worker-1") && successEnvelope.includes("agent: worker") && successEnvelope.includes("status: completed"));
check("formatHandoff: empty success says no text output", formatHandoff({ runId: "r", agent: "worker", status: "completed", output: "" }).includes("(no text output)"));

const failureEnvelope = formatHandoff({ runId: "worker-1", agent: "worker", status: "failed", providerError: true, output: bigOutput, failure: { exitCode: 1, exitSignal: null, stopReason: "error", hasOutput: true, hasStderr: true } });
check("formatHandoff: failure envelope <= 8KiB", Buffer.byteLength(failureEnvelope) <= HANDOFF_ENVELOPE_BYTES);
const failureOutput = failureEnvelope.split("Last output (potentially incomplete):\n")[1] ?? "";
check("formatHandoff: failure partial output <= 4KiB and labeled", Buffer.byteLength(failureOutput) <= FAILURE_OUTPUT_BYTES && failureEnvelope.includes("potentially incomplete"));
check("formatHandoff: provider error is a boolean, never raw content", failureEnvelope.includes("providerError: present") && !failureEnvelope.includes("boom") && !failureEnvelope.includes("Traceback"));
const leakFixture: HandoffFields = {
	runId: "r",
	agent: "worker",
	status: "failed",
	providerError: true,
	output: "partial",
	failure: { exitCode: 1, exitSignal: null, stopReason: "error", hasOutput: true, hasStderr: true },
};
const leakEnvelope = formatHandoff(leakFixture);
check("formatHandoff: no channel for stderr or provider diagnostics content", !leakEnvelope.includes("Traceback") && !leakEnvelope.includes("Provider diagnostic") && !leakEnvelope.includes("leak"));
check("formatHandoff: stderr presence reported as a boolean only", leakEnvelope.includes("stderr: present") && !leakEnvelope.includes("stderr:\n"));
const stoppedEnvelope = formatHandoff({ runId: "r", agent: "worker", status: "stopped", output: "partial" });
check("formatHandoff: stopped is a failure, never success", stoppedEnvelope.includes("status: stopped") && stoppedEnvelope.includes("Error:") && !stoppedEnvelope.includes("(no text output)"));

// Structured failure metadata: exit code, signal, stop reason, output/stderr presence — and no content leakage.
const failureMeta = {
	failedBeforeOutput: formatHandoff({
		runId: "worker-1-ab12",
		agent: "worker",
		status: "failed",
		providerError: true,
		output: "",
		failure: { exitCode: 1, exitSignal: null, stopReason: "error", hasOutput: false, hasStderr: true },
	}),
	failedWithOutput: formatHandoff({
		runId: "worker-1-ab12",
		agent: "worker",
		status: "failed",
		providerError: false,
		output: "partial text",
		failure: { exitCode: 1, exitSignal: "SIGTERM", stopReason: "stop", hasOutput: true, hasStderr: false },
	}),
};
check("formatHandoff: failure metadata carries exit code and signal", failureMeta.failedBeforeOutput.includes("exit: code 1") && failureMeta.failedWithOutput.includes("signal SIGTERM"));
check("formatHandoff: failure metadata carries stop reason", failureMeta.failedWithOutput.includes("stopReason stop"));
check("formatHandoff: failed-before-output is distinguishable", failureMeta.failedBeforeOutput.includes("output: none (failed before any output)") && !failureMeta.failedBeforeOutput.includes("Last output"));
check("formatHandoff: failed-with-output is distinguishable", failureMeta.failedWithOutput.includes("output: partial") && failureMeta.failedWithOutput.includes("Last output (potentially incomplete)"));
check("formatHandoff: stderr presence reported as a boolean only", failureMeta.failedBeforeOutput.includes("stderr: present") && failureMeta.failedWithOutput.includes("stderr: none"));
check("formatHandoff: raw provider error never reaches the envelope", !failureMeta.failedBeforeOutput.includes("rate limited") && !failureMeta.failedBeforeOutput.includes("Traceback"));
check("formatHandoff: provider error reported only as a boolean", failureMeta.failedBeforeOutput.includes("providerError: present") && !failureMeta.failedWithOutput.includes("providerError: present"));
check("formatHandoff: default error uses real exit code, not 'status failed'", (() => {
	const envelope = formatHandoff({ runId: "r", agent: "worker", status: "failed", output: "", failure: { exitCode: 3, exitSignal: null, stopReason: undefined, hasOutput: false, hasStderr: false } });
	return envelope.includes("child exited with code 3") && !envelope.includes("child exited with status failed");
})());
check("formatHandoff: signal shown in the default error line", formatHandoff({ runId: "r", agent: "worker", status: "failed", output: "", failure: { exitCode: 1, exitSignal: "SIGTERM", stopReason: undefined, hasOutput: false, hasStderr: false } }).includes("child exited with code 1, signal SIGTERM"));

check("isCompletedRun: exit 0, stop reason, no error completes", isCompletedRun(0, "stop", undefined));
check("isCompletedRun: missing stop reason fails", !isCompletedRun(0, undefined, undefined));
// A stream ending after a tool use retains `toolUse` or lacks a stop reason, so one
// behavioral check covers every non-stop final stop reason.
check("isCompletedRun: non-stop final stop reasons fail (error/aborted/length/toolUse)", ["error", "aborted", "length", "toolUse"].every((reason) => !isCompletedRun(0, reason, undefined)));
check("isCompletedRun: nonzero exit fails", !isCompletedRun(1, "stop", undefined));
check("isCompletedRun: provider error message fails", !isCompletedRun(0, "stop", "boom"));

check("isolationPct: 100 handoff of 1000 transcript is 90%", isolationPct(100, 1000) === 90);
check("isolationPct: handoff >= transcript clamps to 0", isolationPct(1000, 1000) === 0 && isolationPct(2000, 1000) === 0);
check("isolationPct: clamped 0..100", isolationPct(0, 1000) === 100 && isolationPct(0, 0) === 0);

check("formatDuration: seconds", formatDuration(12_900) === "12s");
check("formatDuration: minutes", formatDuration(125_000) === "2m5s");
check("formatDuration: hours", formatDuration(7_260_000) === "2h1m");
check("contentText: extracts text blocks", contentText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]) === "a\nb");

const transportFixture = mkdtempSync(join(tmpdir(), "wabi-check-"));
try {
	const sourceDir = join(transportFixture, "source");
	mkdirSync(sourceDir);
	writeFileSync(join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark", transport: "auto" }));
	writeFileSync(join(sourceDir, "auth.json"), "{}");

	// Auth/models mutable-state handling: children must use the canonical agent dir, not a per-run overlay.
	const baseEnv = { PI_CODING_AGENT_DIR: "/canonical/agent", HOME: "/home/u", OTHER: "x" };
	const child = childEnv(baseEnv);
	check("childEnv: preserves the canonical agent dir unchanged when present", child.PI_CODING_AGENT_DIR === "/canonical/agent" && child.HOME === "/home/u");
	check("childEnv: never injects a per-run agent dir", !Object.entries(child).some(([key, value]) => key.startsWith("PI_CODING_AGENT") && typeof value === "string" && value.includes(transportFixture)));
	check("childEnv: returns a copy, does not mutate the parent env", baseEnv.OTHER === "x" && child !== baseEnv && Object.keys(child).length === Object.keys(baseEnv).length);
	check("childEnv: no PI_CODING_AGENT_DIR injected when absent from the parent env", !("PI_CODING_AGENT_DIR" in childEnv({ HOME: "/home/u" })));
} finally {
	rmSync(transportFixture, { recursive: true, force: true });
}

const reader: AgentConfig = { name: "reader", description: "", tools: ["read", "bash"], systemPrompt: "" };
const writer: AgentConfig = { name: "writer", description: "", tools: ["read", "edit"], systemPrompt: "" };
const unrestricted: AgentConfig = { name: "all", description: "", systemPrompt: "" };
check("isWriter: read/bash agent is read-only by policy", !isWriter(reader));
check("isWriter: edit/write agent writes", isWriter(writer));
check("isWriter: unrestricted agent writes", isWriter(unrestricted));

check("launchPolicy: rejects write-capable background", launchPolicy(writer, { background: true, activeCount: 0, activeWriterCount: 0 }) !== undefined);
check("launchPolicy: allows read-only background", launchPolicy(reader, { background: true, activeCount: 0, activeWriterCount: 0 }) === undefined);
check("launchPolicy: allows writer foreground alone", launchPolicy(writer, { background: false, activeCount: 0, activeWriterCount: 0 }) === undefined);
check("launchPolicy: rejects a second concurrent writer", launchPolicy(writer, { background: false, activeCount: 1, activeWriterCount: 1 }) !== undefined);
check("launchPolicy: rejects beyond max children", launchPolicy(reader, { background: false, activeCount: MAX_CHILDREN, activeWriterCount: 0 }) !== undefined);
check("launchPolicy: allows reader at max-1", launchPolicy(reader, { background: false, activeCount: MAX_CHILDREN - 1, activeWriterCount: 0 }) === undefined);
check("BACKGROUND_DELIVERY: steer", BACKGROUND_DELIVERY === "steer");

// Globally unique run ids: distinct per instance token and sequence, so resume cannot collide.
const runIds = new Set();
for (let i = 0; i < 50; i++) runIds.add(createRunId("worker", i % 5, `tok${Math.floor(i / 5)}`));
check("createRunId: unique across tokens and sequences", runIds.size === 50 && createRunId("worker", 1, "tok").startsWith("worker-"));

// Run artifact helpers: session-scoped path, serialization cap, parse roundtrip, load order.
const artifactFixture = mkdtempSync(join(tmpdir(), "wabi-artifact-"));
try {
	const runsDir = sessionRunsDir(artifactFixture, "sess-01h2/../evil");
	check("sessionRunsDir: sanitizes session id and nests under agent dir", runsDir === join(artifactFixture, "wabi-runs", "sess-01h2..evil"));
	check("sessionRunsDir: degenerate ids fall back to a safe segment", sessionRunsDir(artifactFixture, "..") === join(artifactFixture, "wabi-runs", "session") && sessionRunsDir(artifactFixture, "/") === join(artifactFixture, "wabi-runs", "session"));
	check("runArtifactPath: names the file by run id", runArtifactPath(runsDir, "worker-1-tok") === join(runsDir, "worker-1-tok.json"));
	check("runArtifactPath: strips path metacharacters from run ids", runArtifactPath(runsDir, "../evil") === join(runsDir, "..evil.json") && runArtifactPath(runsDir, "a/b") === join(runsDir, "ab.json"));

	const bigTranscript = Array.from({ length: 100 }, (_, i) => ({ kind: "text" as const, text: `line ${i} ` + "x".repeat(500), at: i }));
	const artifact = {
		kind: "wabi-run" as const,
		version: 1 as const,
		id: "worker-1-tok",
		agent: "worker",
		task: "t",
		status: "failed",
		background: false,
		startedAt: 1,
		exitCode: 1,
		exitSignal: null,
		stopReason: "error",
		hasOutput: false,
		hasStderr: true,
		transcript: bigTranscript,
		transcriptBytes: 0,
		stderr: "secret stderr",
		usage: { input: 1, output: 1, cost: 0 },
	};
	const serialized = serializeRunArtifact(artifact, 2_000);
	const capped = parseRunArtifact(serialized)!;
	check("serializeRunArtifact: caps transcript to budget, dropping oldest", capped.transcriptBytes <= 2_000 && capped.transcript.length < bigTranscript.length && !capped.transcript.some((e) => e.text.startsWith("line 0")));
	check("parseRunArtifact: roundtrip keeps failure metadata and stderr", capped.id === "worker-1-tok" && capped.exitCode === 1 && capped.stopReason === "error" && capped.hasStderr === true && capped.stderr === "secret stderr");
	check("parseRunArtifact: rejects garbage and foreign files", parseRunArtifact("not json") === undefined && parseRunArtifact(JSON.stringify({ kind: "other" })) === undefined);
	check("parseRunArtifact: tolerates corrupt entries", parseRunArtifact(JSON.stringify({ kind: "wabi-run", version: 1, id: "x", agent: "a", task: "t", status: "failed", startedAt: 1, transcript: [] }))?.id === "x");
	check("parseRunArtifact: rejects non-terminal statuses", parseRunArtifact(JSON.stringify({ kind: "wabi-run", version: 1, id: "x", agent: "a", status: "starting", startedAt: 1, transcript: [] })) === undefined);
	check("parseRunArtifact: normalizes kinds, timestamps, and usage", (() => {
		const parsed = parseRunArtifact(JSON.stringify({
			kind: "wabi-run", version: 1, id: "x", agent: "a", task: "t", status: "failed", startedAt: "5",
			exitCode: null, exitSignal: 7, background: "yes", usage: { input: "3", cost: "nan" },
			transcript: [{ kind: "hack", text: "z", at: "bad" }, { kind: "text", text: 42, at: 3 }],
		}))!;
		return parsed.startedAt === 5 && parsed.background === false && parsed.exitSignal === null && parsed.usage.input === 3 && parsed.usage.cost === 0
			&& parsed.transcript.length === 1 && parsed.transcript[0].kind === "system" && parsed.transcript[0].at === 0;
	})());

	// Serialization caps every persisted field, not just the transcript total.
	const hugeArtifact = {
		...artifact,
		task: "t".repeat(10_000),
		errorMessage: "e".repeat(10_000),
		stderr: "s".repeat(200_000),
		transcript: [{ kind: "text" as const, text: "x".repeat(100_000), at: 1 }],
	};
	const hugeParsed = parseRunArtifact(serializeRunArtifact(hugeArtifact))!;
	check("serializeRunArtifact: caps per-entry, task, error, and stderr bytes", hugeParsed.task.length <= ARTIFACT_TASK_BYTES && (hugeParsed.errorMessage?.length ?? 0) <= ARTIFACT_ERROR_BYTES && hugeParsed.stderr.length <= ARTIFACT_STDERR_BYTES && hugeParsed.transcript[0].text.length <= ARTIFACT_ENTRY_BYTES);

	// Explicit serialization schema: identifiers capped/sanitized, usage finite non-negative, terminal status, no unchecked fields.
	check("serializeRunArtifact: caps and sanitizes id, agent, and exitSignal", (() => {
		const parsed = parseRunArtifact(serializeRunArtifact({ ...artifact, id: "run\u0000" + "x".repeat(5000), agent: "a\nb".repeat(2000), exitSignal: "SIGTERM".repeat(1000) }))!;
		return parsed.id.length <= 256 && !parsed.id.includes("\u0000") && parsed.id.startsWith("run") && parsed.agent.length <= 128 && !parsed.agent.includes("\n") && (parsed.exitSignal?.length ?? 0) <= 64;
	})());
	check("serializeRunArtifact: empty id and agent fall back instead of corrupting the artifact", (() => {
		const parsed = parseRunArtifact(serializeRunArtifact({ ...artifact, id: "", agent: "" }))!;
		return parsed.id === "unknown" && parsed.agent === "unknown";
	})());
	check("serializeRunArtifact: usage normalizes to finite non-negative numbers", (() => {
		const parsed = parseRunArtifact(serializeRunArtifact({ ...artifact, usage: { input: -3, output: Infinity, cost: "2.5" } as any }))!;
		return parsed.usage.input === 0 && parsed.usage.output === 0 && parsed.usage.cost === 2.5;
	})());
	check("serializeRunArtifact: non-terminal status normalizes to failed", parseRunArtifact(serializeRunArtifact({ ...artifact, status: "starting" }))!.status === "failed");
	check("serializeRunArtifact: transcript budget holds even for one oversized entry", (() => {
		const single = parseRunArtifact(serializeRunArtifact({ ...artifact, transcript: [{ kind: "text", text: "x".repeat(10_000), at: 1 }] }, 1_000))!;
		const tail = parseRunArtifact(serializeRunArtifact({ ...artifact, transcript: [{ kind: "text", text: "y", at: 0 }, { kind: "text", text: "x".repeat(10_000), at: 1 }] }, 1_000))!;
		return single.transcriptBytes <= 1_000 && single.transcript.length === 1 && single.transcript[0].text.length <= 1_000
			&& tail.transcriptBytes <= 1_000 && tail.transcript.length === 1 && !tail.transcript[0].text.includes("y");
	})());

	// Many tiny entries bypass the byte budget through per-entry JSON overhead: the count cap must
	// engage with the newest entries retained, and the serialized file must stay within the restore
	// cap the loader enforces (before the fix, 600K one-byte entries serialized to ~23 MB).
	check("serializeRunArtifact: many tiny entries are count-capped, newest retained, file within ARTIFACT_FILE_BYTES", (() => {
		const tiny = Array.from({ length: 600_000 }, (_, i) => ({ kind: "text" as const, text: "x", at: i }));
		const serialized = serializeRunArtifact({ ...artifact, transcript: tiny });
		const parsed = parseRunArtifact(serialized)!;
		return parsed.transcript.length === MAX_TRANSCRIPT_ENTRIES
			&& parsed.transcript[0].at === 600_000 - MAX_TRANSCRIPT_ENTRIES
			&& parsed.transcript[parsed.transcript.length - 1].at === 599_999
			&& Buffer.byteLength(serialized) <= ARTIFACT_FILE_BYTES;
	})());

	// Archived view: immutable, normalized, no live machinery.
	const archived = archivedRunOf(capped);
	check("archivedRunOf: immutable archived view with no live machinery", archived.archived === true && archived.id === "worker-1-tok" && archived.agentName === "worker" && archived.status === "failed" && archived.transcriptBytes <= 2_000 && !("decoder" in archived) && !("done" in archived) && !("liveText" in archived));

	mkdirSync(runsDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(runsDir, "zz-corrupt.json"), "{broken", { mode: 0o600 });
	writeFileSync(runArtifactPath(runsDir, "worker-2-tok"), serializeRunArtifact({ ...artifact, id: "worker-2-tok", startedAt: 5, status: "completed" }), { mode: 0o600 });
	writeFileSync(runArtifactPath(runsDir, "worker-1-tok"), serialized, { mode: 0o600 });
	const loaded = loadRunArtifacts(runsDir);
	check("loadRunArtifacts: loads artifacts oldest first, skipping corrupt files", loaded.length === 2 && loaded[0].id === "worker-1-tok" && loaded[1].id === "worker-2-tok");
	check("loadRunArtifacts: missing dir is empty", loadRunArtifacts(join(artifactFixture, "nope")).length === 0);
	check("artifact files are private", (statSync(runArtifactPath(runsDir, "worker-1-tok")).mode & 0o777) === 0o600);

	// Restore hardening: symlinks and oversized files are skipped before reading; count is capped.
	writeFileSync(join(runsDir, "huge.json"), Buffer.alloc(ARTIFACT_FILE_BYTES + 1, 0x7b), { mode: 0o600 });
	check("loadRunArtifacts: skips oversized files before reading", loadRunArtifacts(runsDir).length === 2);
	const manyDir = join(artifactFixture, "many");
	mkdirSync(manyDir);
	for (let i = 0; i < ARTIFACT_MAX_RUNS + 5; i++) {
		writeFileSync(runArtifactPath(manyDir, `run-${i}`), serializeRunArtifact({ ...artifact, id: `run-${i}`, startedAt: i }), { mode: 0o600 });
	}
	const many = loadRunArtifacts(manyDir);
	check("loadRunArtifacts: caps restored artifacts to the most recent", many.length === ARTIFACT_MAX_RUNS && many[0].startedAt === 5);

	// Write hardening: chmod existing dirs, replace a pre-created final symlink, exclusive temp, final 0600.
	const looseDir = join(artifactFixture, "loose");
	mkdirSync(looseDir, { mode: 0o777 });
	ensureRunsDir(looseDir);
	check("ensureRunsDir: chmods existing dirs to 0700", (statSync(looseDir).mode & 0o777) === 0o700);
	const attackDir = join(artifactFixture, "attack");
	mkdirSync(attackDir, { recursive: true, mode: 0o777 });
	const victim = join(attackDir, "victim.txt");
	writeFileSync(victim, "precious", { mode: 0o644 });
	symlinkSync(victim, runArtifactPath(attackDir, "worker-1-tok")); // pre-created final symlink
	writeRunArtifact(attackDir, "worker-1-tok", artifact);
	check("writeRunArtifact: replaces a pre-created final symlink without following it", !lstatSync(runArtifactPath(attackDir, "worker-1-tok")).isSymbolicLink() && readFileSync(victim, "utf8") === "precious");
	check("writeRunArtifact: final file is 0600", (statSync(runArtifactPath(attackDir, "worker-1-tok")).mode & 0o777) === 0o600);
	check("writeRunArtifact: session dir hardened to 0700", (statSync(attackDir).mode & 0o777) === 0o700);
	check("writeRunArtifact: no temp files left behind", readdirSync(attackDir).filter((entry) => entry.endsWith(".tmp")).length === 0);

	// Load hardening: a symlinked artifact must be rejected without reading the victim. The victim holds a
	// valid artifact, so if the loader ever followed the symlink its run would show up in the results.
	const victimPath = join(artifactFixture, "victim.json");
	writeFileSync(victimPath, serializeRunArtifact({ ...artifact, id: "victim-run", startedAt: 99 }), { mode: 0o600 });
	symlinkSync(victimPath, join(runsDir, "evil.json"));
	const afterSymlink = loadRunArtifacts(runsDir);
	check("loadRunArtifacts: rejects symlinked artifacts without reading the victim", afterSymlink.length === 2 && !afterSymlink.some((a) => a.id === "victim-run") && readFileSync(victimPath, "utf8") !== "");
} finally {
	rmSync(artifactFixture, { recursive: true, force: true });
}

// Shutdown settlement: unresolved runs are finalized exactly once each, settled ones untouched.
check("finishUnresolvedRuns: settles exactly the unresolved runs, once each", (() => {
	const runs: { finished: boolean }[] = [{ finished: true }, { finished: false }, { finished: false }];
	let calls = 0;
	const count = finishUnresolvedRuns(runs, (run) => { calls++; run.finished = true; });
	return count === 2 && calls === 2 && runs.every((run) => run.finished);
})());
check("finishUnresolvedRuns: empty input settles nothing", finishUnresolvedRuns([], () => { throw new Error("must not be called"); }) === 0);

// Circuit breaker (fixed shared policy): two empty failures open; cooldown admits exactly one probe; probe verdict decides.
const circuit = new CircuitBreaker();
const t0 = 1_000_000;
const cooldown = CIRCUIT_COOLDOWN_MS;
check("circuit: starts closed and allows launches", circuit.stateName() === "closed" && circuit.allowLaunch(t0));
circuit.recordEmptyFailure(t0);
check("circuit: one empty failure still allows", circuit.allowLaunch(t0 + 1));
circuit.recordEmptyFailure(t0 + 2);
check("circuit: second empty failure opens", circuit.stateName() === "open" && !circuit.allowLaunch(t0 + 3));
check("circuit: stays open before cooldown", !circuit.allowLaunch(t0 + cooldown - 1));
check("circuit: after cooldown admits exactly one probe", circuit.allowLaunch(t0 + cooldown + 2) && !circuit.allowLaunch(t0 + cooldown + 3));
check("circuit: half-open rejects all but the one admitted probe (validation-safe admission)", !circuit.allowLaunch(t0 + cooldown + 4));
circuit.recordSuccess();
check("circuit: probe success closes", circuit.stateName() === "closed" && circuit.allowLaunch(t0 + cooldown + 1000));
circuit.recordEmptyFailure(t0 + cooldown + 1001);
circuit.recordEmptyFailure(t0 + cooldown + 1002);
check("circuit: reopens after two more empty failures", circuit.stateName() === "open");
check("circuit: cooldown probe allowed, second launch refused", circuit.allowLaunch(t0 + 2 * cooldown + 1003) && !circuit.allowLaunch(t0 + 2 * cooldown + 1004));
circuit.recordEmptyFailure(t0 + 2 * cooldown + 1005);
check("circuit: probe failure reopens with fresh cooldown", circuit.stateName() === "open" && !circuit.allowLaunch(t0 + 2 * cooldown + 1006));
// A stopped probe must release the probe slot, or the circuit wedges half-open forever.
check("circuit: cooldown admits a new probe", circuit.allowLaunch(t0 + 3 * cooldown + 1006));
circuit.recordStopped();
check("circuit: stopped probe releases the slot, next launch probes again", circuit.stateName() === "half-open" && circuit.allowLaunch(t0 + 3 * cooldown + 1007));
circuit.recordStopped();
circuit.recordEmptyFailure(t0 + 3 * cooldown + 1008);
check("circuit: stopped probe then failure reopens with fresh cooldown", circuit.stateName() === "open" && !circuit.allowLaunch(t0 + 3 * cooldown + 1009));
check("circuit: recordStopped is a no-op while closed", (() => { const c = new CircuitBreaker(); c.recordStopped(); return c.stateName() === "closed" && c.allowLaunch(t0); })());
check("circuit: success resets the failure count", (() => { const c = new CircuitBreaker(); c.recordEmptyFailure(t0); c.recordSuccess(); c.recordEmptyFailure(t0 + 1); return c.allowLaunch(t0 + 2) && c.stateName() === "closed"; })());
// One shared circuit for all agent roles: failures across roles trip the same breaker.
check("circuit: shared across agent roles — two empty failures open regardless of agent", (() => { const c = new CircuitBreaker(); c.recordEmptyFailure(t0); c.recordEmptyFailure(t0 + 1); return c.stateName() === "open"; })());
check("circuit: parallel admitted runs open predictably when both fail empty", (() => {
	const c = new CircuitBreaker();
	c.allowLaunch(t0);
	c.allowLaunch(t0 + 1);
	c.recordEmptyFailure(t0 + 2);
	c.recordEmptyFailure(t0 + 3);
	return c.stateName() === "open" && !c.allowLaunch(t0 + 4);
})());
check("circuit: parallel admitted run finishing with output resets the shared circuit", (() => {
	const c = new CircuitBreaker();
	c.recordEmptyFailure(t0);
	c.recordSuccess(); // failed-with-output maps to recordSuccess
	return c.stateName() === "closed" && c.allowLaunch(t0 + 1);
})());
const blocked = circuitBlockedMessage("worker");
check("circuitBlockedMessage: names the outage and degraded mode", blocked.includes('agent "worker"') && blocked.includes("infrastructure outage") && blocked.includes("degraded mode") && blocked.includes("health probe"));

check("handoff contract: appended to every child system prompt", composeSystemPrompt("base").startsWith("base") && composeSystemPrompt("base").includes(HANDOFF_CONTRACT));
check("handoff contract: requires Outcome/Evidence/Risks/Next", ["Outcome", "Evidence", "Risks", "Next"].every((section) => HANDOFF_CONTRACT.includes(section)));
check("handoff contract: under 6KB", Buffer.byteLength(HANDOFF_CONTRACT) <= 6 * 1024);
check("handoff contract: final response is the only model-visible result", HANDOFF_CONTRACT.includes("ONLY model-visible result"));
check("handoff contract: read-only runs report the injected baseline, writers never fabricate a fingerprint", HANDOFF_CONTRACT.includes("injected HEAD sha") && HANDOFF_CONTRACT.includes("never fabricate") && HANDOFF_CONTRACT.includes("starting HEAD"));

// Best-effort temp dir removal: cleanup must never throw or block run settlement;
// a failure is reported through onError for bounded local recording only.
check("removeTempDirBestEffort: removes a real temp dir", (() => {
	const dir = mkdtempSync(join(tmpdir(), "wabi-cleanup-"));
	writeFileSync(join(dir, "x"), "x");
	removeTempDirBestEffort(dir);
	return !existsSync(dir);
})());
check("removeTempDirBestEffort: a failing removal never throws and reports via onError", (() => {
	let reported = false;
	removeTempDirBestEffort("bad\u0000path", (error) => { reported = Boolean(error); });
	return reported;
})());
check("removeTempDirBestEffort: no-op for undefined, onError never called", (() => {
	removeTempDirBestEffort(undefined, () => { throw new Error("must not be called"); });
	return true;
})());
check("removeTempDirBestEffort: a throwing onError callback never propagates", (() => {
	removeTempDirBestEffort("bad\u0000path", () => { throw new Error("onError boom"); });
	return true;
})());

const md = `---
name: test-agent
description: A test agent
tools: read, grep, find
model: deepseek-v4-flash
---
Body text here.
`;
const parsed = parseFrontmatter(md);
check("parseFrontmatter: extracts fields", parsed.frontmatter.name === "test-agent" && parsed.frontmatter.model === "deepseek-v4-flash" && parsed.frontmatter.tools === "read, grep, find");
check("parseFrontmatter: body without frontmatter", parseFrontmatter("no fm").body === "no fm");

const repoRoot = new URL(".", import.meta.url).pathname;
const agents = discoverAgents(`${repoRoot}agents`);
const names = agents.map((agent) => agent.name).sort();
check("discoverAgents: finds the 3 real agents", names.join(",") === "creative-worker,planner,reviewer");
check("discoverAgents: no legacy worker/scout agents", !names.includes("worker") && !names.includes("scout"));
const planner = agents.find((agent) => agent.name === "planner");
check("discoverAgents: planner uses the strong read-only planning profile", planner?.model === "openai-codex/gpt-5.6-sol" && planner.thinking === "max" && !isWriter(planner));
const creativeWorker = agents.find((agent) => agent.name === "creative-worker");
check("discoverAgents: creative-worker uses explicit kimi-coding k3", creativeWorker?.model === "kimi-coding/k3" && creativeWorker.thinking === "high");
const reviewer = agents.find((agent) => agent.name === "reviewer");
check("discoverAgents: reviewer uses the strong model at medium thinking", reviewer?.model === "openai-codex/gpt-5.6-sol" && reviewer.thinking === "medium");

const skill = parseFrontmatter(readFileSync(`${repoRoot}skills/subagent-orchestration/SKILL.md`, "utf8"));
check("subagent skill: valid discoverable frontmatter", skill.frontmatter.name === "subagent-orchestration" && skill.frontmatter.description?.includes("Use proactively"));
check("subagent skill: routes complex or uncertain tasks to the read-only planner", skill.body.includes("planner") && skill.body.includes("read-only") && skill.body.includes("complex or uncertain"));
check("subagent skill: the parent owns exploration and ordinary implementation", skill.body.includes("parent agent owns exploration") && skill.body.includes("implementation"));
check("subagent skill: background is read-only only", skill.body.includes("background") && skill.body.includes("read-only"));
check("subagent skill: risk-triggered reviewer policy is concrete", ["security", "concurrency", "schema", "API", "CI", "cross-platform", "cross-module", "retry", "explicit user request"].every((term) => skill.body.toLowerCase().includes(term.toLowerCase())));
check("subagent skill: parent integrates without repeating exploration", skill.body.includes("do not repeat the child's exploration"));
check("subagent skill: delegated failure flow retries once, then reports the blocker and replans", skill.body.includes("retry once") && skill.body.includes("two failures") && skill.body.includes("report the blocker") && skill.body.includes("replan"));
check("subagent skill: two empty failures mean outage — stop, one probe, degraded mode", skill.body.includes("no output") && skill.body.includes("infrastructure outage") && skill.body.includes("stop delegating") && skill.body.includes("at most one health probe") && skill.body.includes("degraded mode"));
check("subagent skill: failed reviewer is not a review", skill.body.includes("not a review") && skill.body.includes("no review feedback"));
check("subagent skill: no blind retry of a delegated task after two failures", skill.body.includes("do not blindly retry") && skill.body.includes("report the blocker"));

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
