// Pure helpers for the wabi subagent extension. Checked by check.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
/** Cap for the short error line of a failure handoff. */
export const FAILURE_ERROR_BYTES = 2 * 1024;
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

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && (part as any).type === "text")
		.map((part) => String((part as any).text ?? ""))
		.join("\n");
}

/** Give one-shot children an isolated settings overlay with reliable SSE transport. */
export function createChildAgentDir(sourceAgentDir: string, tempDir: string): string {
	const childDir = join(tempDir, "agent");
	mkdirSync(childDir, { mode: 0o700 });
	for (const entry of readdirSync(sourceAgentDir)) {
		if (entry !== "settings.json") symlinkSync(join(sourceAgentDir, entry), join(childDir, entry));
	}

	const sourceSettings = join(sourceAgentDir, "settings.json");
	const settings = existsSync(sourceSettings) ? JSON.parse(readFileSync(sourceSettings, "utf8")) : {};
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Pi settings.json must contain an object.");
	settings.transport = "sse";
	writeFileSync(join(childDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	return childDir;
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
	"- Evidence: files touched (with a one-line reason each), commands run, and their results.",
	"- Risks: anything unverified, partial, or likely to break.",
	"- Next: the smallest sensible follow-up, if any.",
	"",
	"Target at most 6KB (~1000-1500 tokens). Omit exploration narrative, raw logs, and discarded approaches. If you hit a blocker, say so plainly in Outcome/Risks instead of padding.",
].join("\n");

/** Child system prompt = agent instructions + the fixed handoff contract. */
export function composeSystemPrompt(agentPrompt: string): string {
	return agentPrompt.trimEnd() + "\n\n" + HANDOFF_CONTRACT;
}

/** Fields a model-visible handoff is allowed to contain. Provider diagnostics, stderr, and the full transcript are intentionally absent. */
export interface HandoffFields {
	runId: string;
	agent: string;
	status: "completed" | "failed" | "stopped";
	/** Short provider error message; never stderr or provider diagnostics. */
	error?: string;
	/** Agent's own final (success) or last (failure) text output. */
	output: string;
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

function formatSuccessBody(fields: HandoffFields): string {
	return fields.output.trim() || "(no text output)";
}

function formatFailureBody(fields: HandoffFields): string {
	const error = truncateUtf8(fields.error?.trim() || `child exited with status ${fields.status}`, FAILURE_ERROR_BYTES);
	const output = fields.output.trim();
	const parts = [`Error: ${error}`];
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
