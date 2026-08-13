// Pure helpers for the wabi subagent extension. Checked by check.ts.

import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
}

export interface DecodedJsonl {
	events: Record<string, any>[];
	errors: string[];
}

/** At most this many child runs may be active at once. */
export const MAX_CHILDREN = 4;
/** Hard cap for the entire model-visible handoff envelope, metadata included. */
export const HANDOFF_ENVELOPE_BYTES = 8 * 1024;
/** Cap for the "last output" section of a failure handoff. */
export const FAILURE_OUTPUT_BYTES = 4 * 1024;
/** Delivery mode for background completions: queued for before the parent's next model turn. */
export const BACKGROUND_DELIVERY = "steer" as const;
/** Marker appended whenever model-visible output is cut to fit a budget. */
export const TRUNCATION_SUFFIX = "\n\n[Output truncated; full transcript is available in /subagents.]";

/** Incrementally decode LF-delimited JSON, including chunks split mid-line. */
export class JsonlDecoder {
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");

	push(chunk: string | Buffer): DecodedJsonl {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return decodeLines(lines);
	}

	flush(): DecodedJsonl {
		this.buffer += this.decoder.end();
		const line = this.buffer;
		this.buffer = "";
		return decodeLines(line ? [line] : []);
	}
}

function decodeLines(lines: string[]): DecodedJsonl {
	const events: Record<string, any>[] = [];
	const errors: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object") events.push(value);
		} catch {
			errors.push(line);
		}
	}
	return { events, errors };
}

/** Longest valid-UTF-8 prefix of `text` that fits in `maxBytes` bytes. */
function truncateUtf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	let body = bytes.subarray(0, maxBytes).toString("utf8");
	while (body.endsWith("�")) body = body.slice(0, -1);
	return body;
}

/** Keep model-visible handoffs bounded without splitting UTF-8 characters. Even a maxBytes smaller than the truncation suffix stays within budget and valid UTF-8. */
export function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	if (maxBytes <= Buffer.byteLength(TRUNCATION_SUFFIX)) return truncateUtf8Prefix(TRUNCATION_SUFFIX, maxBytes);
	return truncateUtf8Prefix(text, maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX)) + TRUNCATION_SUFFIX;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds < 3600 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function isWriter(agent: AgentConfig): boolean {
	return !agent.tools || agent.tools.some((tool) => tool === "edit" || tool === "write");
}

/** Best-effort removal of a run's temp dir. Never throws: a cleanup failure must not block the handoff, artifact, circuit update, or settle. On failure the error goes to `onError` for bounded local recording (transcript/inspector) only. */
export function removeTempDirBestEffort(tempDir: string | undefined, onError?: (error: unknown) => void): void {
	if (!tempDir) return;
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch (error) {
		try {
			onError?.(error);
		} catch {
			// The cleanup callback itself must never throw either: run settlement continues regardless.
		}
	}
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && (part as any).type === "text")
		.map((part) => String((part as any).text ?? ""))
		.join("\n");
}

/**
 * Spawn environment for one-shot children: the parent environment unchanged, so children
 * use the canonical agent dir. A per-run overlay of symlinked auth/models state gave every
 * child its own lock path while they wrote one shared target (pi locks with `realpath:
 * false`), so concurrent OAuth refreshes raced; the canonical dir shares one lock path and
 * one transport setting (no forced SSE) with the parent.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...env };
}

/** Parse the deliberately flat frontmatter used by agent definitions. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter, body: content.trim() };
	for (const line of match[1].split("\n")) {
		const field = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (field) frontmatter[field[1]] = field[2].trim();
	}
	return { frontmatter, body: match[2].trim() };
}

export function discoverAgents(dir: string): AgentConfig[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		let content: string;
		try {
			content = readFileSync(`${dir}/${entry}`, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name) continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description ?? "",
			tools: frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
			model: frontmatter.model || undefined,
			thinking: frontmatter.thinking || undefined,
			systemPrompt: body,
		});
	}
	return agents;
}

/**
 * Fixed handoff contract appended to every child's system prompt. The child's final
 * response is the only model-visible artifact of the run, so it must be self-contained.
 */
export const HANDOFF_CONTRACT = [
	"HANDOFF CONTRACT (system-level; applies to every delegated task)",
	"Your final response is the ONLY model-visible result of this run. Your exploration, tool calls, thinking, and full transcript stay hidden from the parent model; the user can inspect them anytime via /subagents.",
	"",
	"Structure the final response as exactly four labeled sections:",
	"- Outcome: what changed or what you found, in 1-3 sentences.",
	"- Evidence: the first item is Baseline — for read-only runs (planner, reviewer) the injected HEAD sha, as-of timestamp, and workspace fingerprint from your task; for write-capable runs your starting HEAD sha (or the working directory when not a git worktree). Report a fingerprint only when your environment provided one — never fabricate it or go looking for it. For dynamic resources include the inspected update markers (state, updatedAt, head SHA, run id). Then each claim followed by its smallest supporting evidence: resource id, path + line, or command result. End with the list of inspected resources (ids / SHAs / timestamps) so the parent can delta-check exactly those.",
	"- Risks: the first item is Needs parent verification — only narrow items you could not complete: permissions, state that moved, clone-unrepresentable state. Never re-doable exploration. Then anything unverified, partial, or likely to break.",
	"- Next: the smallest sensible follow-up, if any.",
	"",
	"Target at most 6KB (~1000-1500 tokens). Omit exploration narrative, raw logs, and discarded approaches. If you hit a blocker, say so plainly in Outcome/Risks instead of padding.",
].join("\n");

/** Child system prompt = agent instructions + the fixed handoff contract. */
export function composeSystemPrompt(agentPrompt: string): string {
	return agentPrompt.trimEnd() + "\n\n" + HANDOFF_CONTRACT;
}

/** Structured failure metadata for a model-visible handoff: booleans and short values only, never stderr or provider diagnostics content. */
export interface HandoffFailure {
	exitCode: number | null;
	exitSignal: string | null;
	stopReason?: string;
	hasOutput: boolean;
	hasStderr: boolean;
}

/** Fields a model-visible handoff is allowed to contain. There is no error-content channel: raw provider diagnostics, stderr, and the full transcript are intentionally absent — the parent learns only that a provider error happened. */
export interface HandoffFields {
	runId: string;
	agent: string;
	status: "completed" | "failed" | "stopped";
	/** True when the child reported a provider or spawn error. Its raw content stays private (inspector/artifact only). */
	providerError?: boolean;
	/** Agent's own final (success) or last (failure) text output. */
	output: string;
	/** Failure metadata (exit code, signal, stop reason, output/stderr presence). */
	failure?: HandoffFailure;
}

/**
 * A child run is complete only when it exited 0 with no error and an explicit successful
 * final stop reason (`stop`). Missing stop reasons, `error`/`aborted`/`length`/`toolUse`,
 * or a stream ending after a tool use (which retains `toolUse` or lacks a stop reason)
 * all mean the output is potentially incomplete.
 */
export function isCompletedRun(exitCode: number | null, stopReason: string | undefined, errorMessage: string | undefined): boolean {
	return exitCode === 0 && !errorMessage && stopReason === "stop";
}

/** Percentage of the transcript that stays out of the model-visible handoff: `100 - min(100, handoff/transcript*100)`, clamped to 0..100. */
export function isolationPct(handoffBytes: number, transcriptBytes: number): number {
	if (transcriptBytes <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round(100 - (handoffBytes / transcriptBytes) * 100)));
}

/**
 * Globally unique run id: agent + per-extension-instance token + monotonic sequence.
 * A fresh token per instance (every process start or /reload) means resumed sessions
 * never collide with ids from before the reset sequence.
 */
export function createRunId(agentName: string, sequence: number, instanceToken: string): string {
	return `${agentName}-${sequence}-${instanceToken}`;
}

/** Session-scoped run artifact directory: `<agentDir>/wabi-runs/<sessionId>/`, mode 0700 (created by the caller). Real session ids are uuidv7; the sanitization and fallback are belt-and-braces. */
export function sessionRunsDir(agentDir: string, sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
	return join(agentDir, "wabi-runs", safe === "" || safe === "." || safe === ".." ? "session" : safe);
}

/** Per-run artifact file inside a session runs dir. Run ids embed agent names, so strip path metacharacters. */
export function runArtifactPath(runsDir: string, runId: string): string {
	return join(runsDir, `${runId.replace(/[^A-Za-z0-9._-]/g, "")}.json`);
}

/** Hard caps for the local run archive. The README quotes these numbers; keep them in sync. */
export const ARTIFACT_TRANSCRIPT_BYTES = 4 * 1024 * 1024; // total transcript kept (oldest entries dropped first)
export const ARTIFACT_ENTRY_BYTES = 64 * 1024; // per transcript entry
export const MAX_TRANSCRIPT_ENTRIES = 100_000; // per-entry JSON overhead bypasses a pure byte budget; tiny entries are count-capped too (newest retained)
export const ARTIFACT_TASK_BYTES = 4 * 1024; // task text
export const ARTIFACT_ERROR_BYTES = 4 * 1024; // private error message (never model-visible)
export const ARTIFACT_STDERR_BYTES = 128 * 1024; // retained stderr (matches ingestion cap)
export const ARTIFACT_FILE_BYTES = 16 * 1024 * 1024; // restore skips larger files before reading them
export const ARTIFACT_MAX_RUNS = 100; // most recent runs restored per session

/** Refuse to follow symlinks when opening artifact files; absent on platforms without it (Windows). */
const O_NOFOLLOW: number | undefined = fsConstants.O_NOFOLLOW;

/** Durable per-run record written mode 0600 under the session runs dir. Never fed to the parent model. */
export interface RunArtifact {
	kind: "wabi-run";
	version: 1;
	id: string;
	agent: string;
	model?: string;
	task: string;
	status: string;
	background: boolean;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	exitSignal: string | null;
	stopReason?: string;
	errorMessage?: string;
	hasOutput: boolean;
	hasStderr: boolean;
	transcript: { kind: string; text: string; at: number }[];
	transcriptBytes: number;
	stderr: string;
	handoffBytes?: number;
	usage: { input: number; output: number; cost: number };
}

const TRANSCRIPT_KINDS = new Set(["text", "thinking", "tool", "tool-result", "system"]);

/** Validate and normalize persisted transcript entries: known kinds, string text capped per entry, finite timestamps, empty entries dropped. */
function normalizeTranscript(transcript: unknown): { kind: string; text: string; at: number }[] {
	if (!Array.isArray(transcript)) return [];
	const result: { kind: string; text: string; at: number }[] = [];
	for (const entry of transcript) {
		if (!entry || typeof entry !== "object") continue;
		const raw = entry as Record<string, unknown>;
		const kind = typeof raw.kind === "string" && TRANSCRIPT_KINDS.has(raw.kind) ? raw.kind : "system";
		const text = typeof raw.text === "string" ? truncateUtf8Prefix(raw.text, ARTIFACT_ENTRY_BYTES) : "";
		if (!text) continue;
		const at = Number(raw.at);
		result.push({ kind, text, at: Number.isFinite(at) ? at : 0 });
	}
	return result;
}

const MAX_ID_BYTES = 256;
const MAX_AGENT_BYTES = 128;
const MAX_EXIT_SIGNAL_BYTES = 64;
const MAX_STOP_REASON_BYTES = 256;

/** Cap and sanitize a single-line persisted string: control characters have no place in an artifact, and every string is bounded. */
function normalizePersistedString(value: unknown, maxBytes: number): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	return truncateUtf8Prefix(text.replace(/[\u0000-\u001f\u007f]/g, ""), maxBytes);
}

/** Finite non-negative numbers only; NaN, Infinity, negatives, and non-numeric values become 0. */
function nonNegativeFinite(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : 0;
}

/** Finite number or null (exit codes). */
function finiteOrNull(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/** Finite non-negative number, or undefined (optional timestamps and byte counts). */
function optionalNonNegative(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Usage counters normalize to finite non-negative numbers. */
function normalizeUsage(usage: unknown): { input: number; output: number; cost: number } {
	const raw = (usage ?? {}) as Record<string, unknown>;
	return { input: nonNegativeFinite(raw.input), output: nonNegativeFinite(raw.output), cost: nonNegativeFinite(raw.cost) };
}

/** Keep the newest entries that fit `maxBytes`, dropping oldest first; when even one entry exceeds the budget its text is truncated (UTF-8-safe), so the budget always holds. Tiny entries carry fixed JSON overhead the byte budget cannot see, so the count is also capped at MAX_TRANSCRIPT_ENTRIES (newest retained). */
function capTranscript(entries: { kind: string; text: string; at: number }[], maxBytes: number): { kind: string; text: string; at: number }[] {
	if (maxBytes <= 0) return [];
	const result = [...entries];
	let used = result.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
	while (used > maxBytes && result.length > 1) {
		used -= Buffer.byteLength(result.shift()!.text);
	}
	if (used > maxBytes) {
		const entry = result[0]!;
		result[0] = { ...entry, text: truncateUtf8Prefix(entry.text, maxBytes) };
	}
	return result.length > MAX_TRANSCRIPT_ENTRIES ? result.slice(-MAX_TRANSCRIPT_ENTRIES) : result;
}

/** Worst-case UTF-8 bytes JSON.stringify emits for a string, quotes included: single-escape characters cost 2, escaped code units (control characters, lone surrogates, U+2028/29) cost 6, valid surrogate pairs and ordinary text cost their raw UTF-8 length. An upper bound on any engine's output; bun emits DEL and U+2028/29 raw, so those are over-counted, never under. */
function jsonStringBytesMax(text: string): number {
	let bytes = 2; // surrounding quotes
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const low = text.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				bytes += 4; // valid surrogate pair: emitted raw
				i++;
				continue;
			}
		}
		if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) bytes += 2;
		else if (code < 0x20 || code >= 0xd800 || code === 0x2028 || code === 0x2029) bytes += 6;
		else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
	}
	return bytes;
}

/** Fixed JSON around a transcript entry's variable parts: `{"kind":"` + kind + `","text":"` + text + `","at":` + number + `}`. */
const TRANSCRIPT_ENTRY_JSON_OVERHEAD = 9 + 9 + 6 + 1;

/**
 * The loader skips artifacts larger than ARTIFACT_FILE_BYTES, so the writer must never emit one.
 * The transcript byte budget counts raw text only, while JSON escaping and per-entry overhead
 * inflate the serialized size, so drop the oldest entries until a conservative size bound
 * (exact fixed-field skeleton plus each kept entry's worst case) fits the file cap. Single
 * pass over the entries, no iterative re-serialization.
 */
function fitTranscriptToFileSize(artifact: RunArtifact): RunArtifact {
	const transcript = artifact.transcript;
	if (transcript.length === 0) return artifact;
	const skeletonBytes = Buffer.byteLength(JSON.stringify({ ...artifact, transcript: [] })); // transcriptBytes holds the pre-fit sum, so it only over-states once entries drop
	const bounds = new Array<number>(transcript.length);
	let bound = skeletonBytes;
	for (let i = 0; i < transcript.length; i++) {
		const entry = transcript[i];
		// +1 for the array comma after every entry but the last (the last is never dropped, so the accounting stays exact as entries drop from the front)
		bounds[i] = TRANSCRIPT_ENTRY_JSON_OVERHEAD + entry.kind.length + jsonStringBytesMax(entry.text) + String(entry.at).length + (i + 1 < transcript.length ? 1 : 0);
		bound += bounds[i];
	}
	let keep = transcript.length;
	for (let i = 0; bound > ARTIFACT_FILE_BYTES && keep > 1; i++) {
		bound -= bounds[i];
		keep--;
	}
	if (keep === transcript.length) return artifact;
	const fitted = transcript.slice(-keep);
	return { ...artifact, transcript: fitted, transcriptBytes: fitted.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0) };
}

/** Serialize a run artifact, explicitly constructing every persisted field: identifiers sanitized and capped, status terminal, usage finite non-negative, transcript capped to the budget and count, and the serialized output always within ARTIFACT_FILE_BYTES. */
export function serializeRunArtifact(artifact: RunArtifact, maxBytes = ARTIFACT_TRANSCRIPT_BYTES): string {
	const transcript = capTranscript(normalizeTranscript(artifact.transcript), maxBytes);
	const transcriptBytes = transcript.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
	const id = normalizePersistedString(artifact.id, MAX_ID_BYTES);
	const agent = normalizePersistedString(artifact.agent, MAX_AGENT_BYTES);
	const model = artifact.model === undefined ? undefined : normalizePersistedString(String(artifact.model), MAX_ID_BYTES) || undefined;
	const normalized: RunArtifact = {
		kind: "wabi-run",
		version: 1,
		id: id || "unknown",
		agent: agent || "unknown",
		model,
		task: truncateUtf8Prefix(String(artifact.task ?? ""), ARTIFACT_TASK_BYTES),
		status: artifact.status === "completed" || artifact.status === "failed" || artifact.status === "stopped" ? artifact.status : "failed",
		background: artifact.background === true,
		startedAt: nonNegativeFinite(artifact.startedAt),
		endedAt: optionalNonNegative(artifact.endedAt),
		exitCode: finiteOrNull(artifact.exitCode),
		exitSignal: artifact.exitSignal === null || artifact.exitSignal === undefined ? null : normalizePersistedString(artifact.exitSignal, MAX_EXIT_SIGNAL_BYTES) || null,
		stopReason: artifact.stopReason === undefined ? undefined : normalizePersistedString(artifact.stopReason, MAX_STOP_REASON_BYTES),
		errorMessage: artifact.errorMessage === undefined ? undefined : truncateUtf8Prefix(String(artifact.errorMessage), ARTIFACT_ERROR_BYTES),
		hasOutput: artifact.hasOutput === true,
		hasStderr: artifact.hasStderr === true,
		transcript,
		transcriptBytes,
		stderr: truncateUtf8Prefix(String(artifact.stderr ?? ""), ARTIFACT_STDERR_BYTES),
		handoffBytes: optionalNonNegative(artifact.handoffBytes),
		usage: normalizeUsage(artifact.usage),
	};
	return JSON.stringify(fitTranscriptToFileSize(normalized));
}

/** Parse a run artifact into a fully validated, normalized record; returns undefined for corrupt, foreign, or oversized-lie files. */
export function parseRunArtifact(text: string): RunArtifact | undefined {
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object") return undefined;
		const raw = value as Record<string, unknown>;
		if (raw.kind !== "wabi-run" || raw.version !== 1) return undefined;
		const id = typeof raw.id === "string" ? normalizePersistedString(raw.id, MAX_ID_BYTES) : "";
		if (id === "") return undefined;
		const agent = typeof raw.agent === "string" ? normalizePersistedString(raw.agent, MAX_AGENT_BYTES) : "";
		if (agent === "") return undefined;
		if (typeof raw.task !== "string") return undefined;
		// Only terminal statuses exist in artifacts; anything else is foreign/corrupt.
		if (raw.status !== "completed" && raw.status !== "failed" && raw.status !== "stopped") return undefined;
		const startedAt = Number(raw.startedAt);
		if (!Number.isFinite(startedAt)) return undefined;
		const endedAt = Number(raw.endedAt);
		const exitCode = raw.exitCode === null || raw.exitCode === undefined ? null : Number(raw.exitCode);
		const transcript = capTranscript(normalizeTranscript(raw.transcript), ARTIFACT_TRANSCRIPT_BYTES);
		const transcriptBytes = transcript.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
		const stopReason = typeof raw.stopReason === "string" ? normalizePersistedString(raw.stopReason, MAX_STOP_REASON_BYTES) : undefined;
		const errorMessage = typeof raw.errorMessage === "string" ? truncateUtf8Prefix(raw.errorMessage, ARTIFACT_ERROR_BYTES) : undefined;
		const stderr = typeof raw.stderr === "string" ? truncateUtf8Prefix(raw.stderr, ARTIFACT_STDERR_BYTES) : "";
		const model = typeof raw.model === "string" ? normalizePersistedString(raw.model, MAX_ID_BYTES) : undefined;
		return {
			kind: "wabi-run",
			version: 1,
			id,
			agent,
			model,
			task: truncateUtf8Prefix(raw.task, ARTIFACT_TASK_BYTES),
			status: raw.status as RunArtifact["status"],
			background: raw.background === true,
			startedAt,
			endedAt: Number.isFinite(endedAt) ? endedAt : undefined,
			exitCode: Number.isFinite(exitCode) ? exitCode : null,
			exitSignal: typeof raw.exitSignal === "string" ? normalizePersistedString(raw.exitSignal, MAX_EXIT_SIGNAL_BYTES) || null : null,
			stopReason,
			errorMessage,
			hasOutput: raw.hasOutput === true,
			hasStderr: raw.hasStderr === true,
			transcript,
			transcriptBytes,
			stderr,
			handoffBytes: optionalNonNegative(raw.handoffBytes),
			usage: normalizeUsage(raw.usage),
		};
	} catch {
		return undefined;
	}
}

/**
 * Read one artifact file through a single descriptor: on platforms with O_NOFOLLOW (all POSIX)
 * a symlink fails at open, and the descriptor's own fstat must report a regular file within the
 * size cap before anything is read. On platforms without O_NOFOLLOW (Windows) an lstat pre-check
 * rejects symlinks first, and the same fstat still guards the descriptor. The fd is always closed.
 */
function readArtifactFile(path: string): string | undefined {
	if (O_NOFOLLOW === undefined) {
		try {
			const stats = lstatSync(path);
			if (!stats.isFile() || stats.size > ARTIFACT_FILE_BYTES) return undefined;
		} catch {
			return undefined;
		}
	}
	let fd: number;
	try {
		fd = openSync(path, O_NOFOLLOW === undefined ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.size > ARTIFACT_FILE_BYTES) return undefined;
		return readFileSync(fd, "utf8");
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** Load every run artifact in a session runs dir, oldest first. Symlinks, oversized files, and corrupt files are skipped; at most ARTIFACT_MAX_RUNS are restored. */
export function loadRunArtifacts(dir: string): RunArtifact[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const artifacts: RunArtifact[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const text = readArtifactFile(join(dir, entry));
		if (text === undefined) continue;
		const artifact = parseRunArtifact(text);
		if (artifact) artifacts.push(artifact);
	}
	artifacts.sort((a, b) => a.startedAt - b.startedAt);
	return artifacts.slice(-ARTIFACT_MAX_RUNS);
}

/** Create the session runs dir (and its `wabi-runs` parent) mode 0700, chmodding them even when they pre-exist. */
export function ensureRunsDir(runsDir: string): void {
	mkdirSync(runsDir, { recursive: true, mode: 0o700 });
	chmodSync(runsDir, 0o700);
	try {
		chmodSync(dirname(runsDir), 0o700);
	} catch {
		// Parent does not exist; nothing to harden.
	}
}

/** Atomically persist a run artifact: uniquely named exclusive 0600 temp file, then rename over the final path (which replaces, never follows, a pre-created symlink), then force final 0600. */
export function writeRunArtifact(runsDir: string, runId: string, artifact: RunArtifact): void {
	ensureRunsDir(runsDir);
	const safe = runId.replace(/[^A-Za-z0-9._-]/g, "");
	const tmpPath = join(runsDir, `.${safe}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	const fd = openSync(tmpPath, "wx", 0o600); // exclusive create; a pre-created temp cannot be raced
	try {
		writeFileSync(fd, serializeRunArtifact(artifact), "utf8");
	} catch (error) {
		closeSync(fd);
		rmSync(tmpPath, { force: true });
		throw error;
	}
	closeSync(fd);
	try {
		renameSync(tmpPath, runArtifactPath(runsDir, runId)); // atomic; replaces a symlink at the final path without following it
		chmodSync(runArtifactPath(runsDir, runId), 0o600); // final mode regardless of umask
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
}

/** Finish every run still unresolved, exactly once each: runs already settled are skipped, and the caller's `finish` must be idempotent (its own `finished` guard). Returns how many runs were finished. */
export function finishUnresolvedRuns<T extends { finished: boolean }>(runs: readonly T[], finish: (run: T) => void): number {
	let count = 0;
	for (const run of runs) {
		if (run.finished) continue;
		finish(run);
		count++;
	}
	return count;
}

/** Immutable archived view of a finished run, restored from a durable artifact for `/subagents` after reload/resume. No live decoder, promises, or mutable maps. */
export interface ArchivedRun {
	archived: true;
	id: string;
	agentName: string;
	model?: string;
	task: string;
	status: "completed" | "failed" | "stopped";
	background: boolean;
	startedAt: number;
	endedAt?: number;
	transcript: { kind: string; text: string; at: number }[];
	transcriptBytes: number;
	handoffBytes?: number;
	usage: { input: number; output: number; cost: number };
}

/** Build the archived view from an already-normalized artifact. */
export function archivedRunOf(artifact: RunArtifact): ArchivedRun {
	return {
		archived: true,
		id: artifact.id,
		agentName: artifact.agent,
		model: artifact.model,
		task: artifact.task,
		status: artifact.status as "completed" | "failed" | "stopped",
		background: artifact.background === true,
		startedAt: artifact.startedAt,
		endedAt: artifact.endedAt,
		transcript: artifact.transcript,
		transcriptBytes: artifact.transcriptBytes,
		handoffBytes: artifact.handoffBytes,
		usage: artifact.usage,
	};
}

/** Estimated spend, always labelled as an estimate; sub-cent amounts render as `< $0.01` instead of a misleading `$0.00`. */
export function formatCost(cost: number): string {
	if (!cost || !Number.isFinite(cost) || cost <= 0) return "";
	if (cost < 0.01) return "<$0.01 est";
	return `$${cost.toFixed(2)} est`;
}

/** List window start: center `size` rows around `selected` within `total`, clamped so the window never exceeds the list. */
export function windowAround(total: number, size: number, selected: number): number {
	return Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, total - size)));
}

/** Transcript view: the last `pageSize` lines at `scroll = 0` (newest always visible), clamped to the body length. */
export function transcriptView(bodyLength: number, pageSize: number, scroll: number): { start: number; end: number } {
	const maxScroll = Math.max(0, bodyLength - pageSize);
	const end = bodyLength - Math.min(scroll, maxScroll);
	return { start: Math.max(0, end - pageSize), end };
}

/** Terminal-height clamp used on every render path: the inspector never emits more lines than the real terminal has. */
export function terminalClamp(lines: string[], rows: number | undefined): string[] {
	return lines.slice(0, Math.max(0, rows ?? 30));
}

/** Fixed shared-circuit policy: two consecutive empty failures open; 60 s cooldown; one probe. */
export const CIRCUIT_FAILURE_THRESHOLD = 2;
export const CIRCUIT_COOLDOWN_MS = 60_000;

/**
 * One global circuit breaker for every child launch, so a shared infrastructure outage
 * (provider, spawn, auth) trips across agent roles. Consecutive empty failures open it;
 * launches are denied until the cooldown elapses, then exactly one launch (the health
 * probe) is allowed while the circuit re-arms behind it. A probe success closes it, a
 * probe failure reopens it with a fresh cooldown, and a stopped probe releases the probe
 * slot without counting. Runs admitted before the circuit opened still count normally
 * when they finish: successes/failed-with-output reset, empty failures count.
 */
export class CircuitBreaker {
	private state: CircuitState = "closed";
	private failures = 0;
	private openedAt = 0;
	private probeInFlight = false;

	stateName(): CircuitState {
		return this.state;
	}

	/** May a launch proceed right now? A half-open circuit admits exactly one probe. */
	allowLaunch(now = Date.now()): boolean {
		if (this.state === "closed") return true;
		if (this.state === "open" && now - this.openedAt >= CIRCUIT_COOLDOWN_MS) this.state = "half-open";
		if (this.state === "half-open") {
			if (this.probeInFlight) return false;
			this.probeInFlight = true;
			return true;
		}
		return false;
	}

	/** A run produced a normal final answer or any agent output: close the circuit and reset the count. */
	recordSuccess(): void {
		this.state = "closed";
		this.failures = 0;
		this.probeInFlight = false;
	}

	/** A probe run ended without a verdict (user stop or parent abort): release the probe slot so the next launch can probe again, without counting. */
	recordStopped(): void {
		if (this.state === "half-open") this.probeInFlight = false;
	}

	/** A run failed with no agent output. The probe's failure reopens with a fresh cooldown. */
	recordEmptyFailure(now = Date.now()): void {
		this.probeInFlight = false;
		if (this.state !== "closed") {
			this.state = "open";
			this.openedAt = now;
			this.failures = 0;
			return;
		}
		this.failures++;
		if (this.failures >= CIRCUIT_FAILURE_THRESHOLD) {
			this.state = "open";
			this.openedAt = now;
			this.failures = 0;
		}
	}
}

/** Model-visible circuit rejection: tells the parent to stop delegating and report degraded mode. */
export function circuitBlockedMessage(agentName: string): string {
	return `Subagent launch blocked: the circuit for agent "${agentName}" is open after ${CIRCUIT_FAILURE_THRESHOLD} consecutive no-output failures. Treat this as an infrastructure outage: stop delegating, report degraded mode, and run at most one health probe after the cooldown.`;
}

function formatSuccessBody(fields: HandoffFields): string {
	return fields.output.trim() || "(no text output)";
}

function formatFailureBody(fields: HandoffFields): string {
	const failure = fields.failure;
	const parts: string[] = [];
	if (fields.providerError) {
		// Only the boolean crosses the model boundary; raw provider diagnostics stay in the inspector/artifact.
		parts.push("Error: providerError: present (raw provider diagnostics withheld; inspect via /subagents)");
	} else {
		const exit = failure
			? `child exited with code ${failure.exitCode ?? "none"}${failure.exitSignal ? `, signal ${failure.exitSignal}` : ""}`
			: `child exited with status ${fields.status}`;
		parts.push(`Error: ${exit}`);
	}
	if (failure) {
		const exit = `exit: code ${failure.exitCode ?? "none"} \u00b7 signal ${failure.exitSignal ?? "none"} \u00b7 stopReason ${failure.stopReason ?? "none"}`;
		const output = failure.hasOutput ? "output: partial (agent text below; full transcript retained locally)" : "output: none (failed before any output)";
		const stderr = failure.hasStderr ? "stderr: present (retained locally; never shown to the parent model)" : "stderr: none";
		parts.push([exit, output, stderr].join("\n"));
	}
	const output = fields.output.trim();
	if (output) parts.push(`Last output (potentially incomplete):\n${truncateUtf8(output, FAILURE_OUTPUT_BYTES)}`);
	return parts.join("\n\n");
}

/** One pure formatter for every model-visible handoff: foreground/background, success/failure. */
export function formatHandoff(fields: HandoffFields): string {
	const meta = ["run: " + fields.runId, "agent: " + fields.agent, "status: " + fields.status].join("\n");
	const body = fields.status === "completed" ? formatSuccessBody(fields) : formatFailureBody(fields);
	return truncateUtf8(`${meta}\n\n${body}`, HANDOFF_ENVELOPE_BYTES);
}

export interface LaunchOptions {
	background: boolean;
	activeCount: number;
	activeWriterCount: number;
}

/** Pure launch policy: at most MAX_CHILDREN active, one write-capable child, and no write-capable background runs. Returns an error message when the launch must be rejected. */
export function launchPolicy(agent: AgentConfig, options: LaunchOptions): string | undefined {
	if (options.activeCount >= MAX_CHILDREN) return `At most ${MAX_CHILDREN} subagents may run concurrently.`;
	if (isWriter(agent)) {
		if (options.background) return `Write-capable subagent "${agent.name}" cannot run in the background; write-capable subagents must run in the foreground.`;
		if (options.activeWriterCount > 0) return "A write-capable subagent is already running; only one may be active at a time.";
	}
	return undefined;
}
