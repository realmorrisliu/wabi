// check.ts — self-check for wabi's pure logic. Run: bun check.ts

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentConfig,
	type HandoffFields,
	BACKGROUND_DELIVERY,
	composeSystemPrompt,
	contentText,
	createChildAgentDir,
	discoverAgents,
	FAILURE_ERROR_BYTES,
	FAILURE_OUTPUT_BYTES,
	formatDuration,
	formatHandoff,
	HANDOFF_CONTRACT,
	HANDOFF_ENVELOPE_BYTES,
	isCompletedRun,
	isolationPct,
	isWriter,
	JsonlDecoder,
	launchPolicy,
	MAX_CHILDREN,
	parseFrontmatter,
	truncateUtf8,
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

const failureEnvelope = formatHandoff({ runId: "worker-1", agent: "worker", status: "failed", error: "boom", output: bigOutput });
check("formatHandoff: failure envelope <= 8KiB", Buffer.byteLength(failureEnvelope) <= HANDOFF_ENVELOPE_BYTES);
const failureOutput = failureEnvelope.split("Last output (potentially incomplete):\n")[1] ?? "";
check("formatHandoff: failure partial output <= 4KiB and labeled", Buffer.byteLength(failureOutput) <= FAILURE_OUTPUT_BYTES && failureEnvelope.includes("potentially incomplete"));
check("formatHandoff: failure error section present", failureEnvelope.includes("Error: boom"));
const longError = "boom ".repeat(2000);
const longErrorEnvelope = formatHandoff({ runId: "r", agent: "worker", status: "failed", error: longError, output: "" });
const longErrorLine = longErrorEnvelope.split("\n").find((line) => line.startsWith("Error: ")) ?? "";
check("formatHandoff: long error cap actually exercised", Buffer.byteLength(longErrorLine) <= "Error: ".length + FAILURE_ERROR_BYTES && !longErrorEnvelope.includes(longError) && longErrorEnvelope.includes("Output truncated"));
const leakFixture: HandoffFields & { stderr: string; diagnostics: string } = {
	runId: "r",
	agent: "worker",
	status: "failed",
	error: "boom",
	output: "partial",
	stderr: "stderr: Traceback (most recent call last):\nProvider diagnostic: {leak}",
	diagnostics: "Provider diagnostic: {leak}",
};
const leakEnvelope = formatHandoff(leakFixture);
check("formatHandoff: stderr and provider diagnostics never enter the handoff", !leakEnvelope.includes("Traceback") && !leakEnvelope.includes("stderr") && !leakEnvelope.includes("Provider diagnostic") && !leakEnvelope.includes("leak"));
const stoppedEnvelope = formatHandoff({ runId: "r", agent: "worker", status: "stopped", output: "partial" });
check("formatHandoff: stopped is a failure, never success", stoppedEnvelope.includes("status: stopped") && stoppedEnvelope.includes("Error:") && !stoppedEnvelope.includes("(no text output)"));

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
	const runDir = join(transportFixture, "run");
	mkdirSync(sourceDir);
	mkdirSync(runDir);
	writeFileSync(join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark", transport: "auto" }));
	writeFileSync(join(sourceDir, "auth.json"), "{}");
	const childDir = createChildAgentDir(sourceDir, runDir);
	const childSettings = JSON.parse(readFileSync(join(childDir, "settings.json"), "utf8"));
	check("child settings: force SSE without losing parent settings", childSettings.transport === "sse" && childSettings.theme === "dark");
	check("child settings: preserve other agent resources by symlink", lstatSync(join(childDir, "auth.json")).isSymbolicLink());
	check("child settings: private file permissions", (statSync(join(childDir, "settings.json")).mode & 0o777) === 0o600);
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

check("handoff contract: appended to every child system prompt", composeSystemPrompt("base").startsWith("base") && composeSystemPrompt("base").includes(HANDOFF_CONTRACT));
check("handoff contract: requires Outcome/Evidence/Risks/Next", ["Outcome", "Evidence", "Risks", "Next"].every((section) => HANDOFF_CONTRACT.includes(section)));
check("handoff contract: under 6KB", Buffer.byteLength(HANDOFF_CONTRACT) <= 6 * 1024);
check("handoff contract: final response is the only model-visible result", HANDOFF_CONTRACT.includes("ONLY model-visible result"));

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
check("discoverAgents: finds the 4 real agents", names.join(",") === "creative-worker,reviewer,scout,worker");
const scout = agents.find((agent) => agent.name === "scout");
check("discoverAgents: scout uses the bounded read-only profile", scout?.model === "deepseek-v4-flash" && scout.thinking === "high" && !isWriter(scout));
const worker = agents.find((agent) => agent.name === "worker");
check("discoverAgents: worker uses the default-executor profile", worker?.model === "deepseek-v4-flash" && worker.thinking === "max");
const creativeWorker = agents.find((agent) => agent.name === "creative-worker");
check("discoverAgents: creative-worker uses bounded kimi-k3", creativeWorker?.model === "kimi-k3" && creativeWorker.thinking === "high");
const reviewer = agents.find((agent) => agent.name === "reviewer");
check("discoverAgents: reviewer uses the strong model at bounded thinking", reviewer?.model === "gpt-5.6-sol" && reviewer.thinking === "minimal");

const skill = parseFrontmatter(readFileSync(`${repoRoot}skills/subagent-orchestration/SKILL.md`, "utf8"));
check("subagent skill: valid discoverable frontmatter", skill.frontmatter.name === "subagent-orchestration" && skill.frontmatter.description?.includes("Use proactively"));
check("subagent skill: routes non-atomic implementation to worker", skill.body.includes("worker") && skill.body.includes("non-atomic"));
check("subagent skill: background is read-only only", skill.body.includes("background") && skill.body.includes("read-only"));
check("subagent skill: risk-triggered reviewer policy is concrete", ["security", "concurrency", "schema", "API", "CI", "cross-platform", "cross-module", "retry", "explicit user request"].every((term) => skill.body.toLowerCase().includes(term.toLowerCase())));
check("subagent skill: parent integrates without repeating exploration", skill.body.includes("do not repeat the worker's exploration"));
check("subagent skill: atomic exception lists every condition", ["exact file", "localized", "no further exploration", "no iterative test/debug loop", "no review"].every((term) => skill.body.toLowerCase().includes(term.toLowerCase())));
check("subagent skill: worker failure flow retries once, then handles residual or replans", skill.body.includes("retry once") && skill.body.includes("second failure") && skill.body.includes("residual") && skill.body.includes("replan"));

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
