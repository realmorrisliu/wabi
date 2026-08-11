// Observable subagents for pi. Each run is a direct one-shot `pi --mode json`
// child: progress stays in the TUI, while only the final answer is handed back
// to the parent model.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type ArchivedRun,
	type HandoffFields,
	BACKGROUND_DELIVERY,
	JsonlDecoder,
	CircuitBreaker,
	archivedRunOf,
	childEnv,
	circuitBlockedMessage,
	composeSystemPrompt,
	contentText,
	createRunId,
	discoverAgents,
	ensureRunsDir,
	finishUnresolvedRuns,
	formatDuration,
	formatHandoff,
	isCompletedRun,
	isolationPct,
	isWriter,
	launchPolicy,
	loadRunArtifacts,
	sessionRunsDir,
	writeRunArtifact,
} from "./lib.ts";

const STDERR_BYTES = 128 * 1024;
const COMPLETED_WIDGET_MS = 5_000;
const FORCE_KILL_MS = 5_000;
/** If a spawn failed, `close` never fires; this bounds the wait before finalizing. */
const ERROR_FALLBACK_MS = 1_000;
/** After SIGKILL, how long to wait for the child's `close` event before finalizing the run ourselves. */
const CLOSE_GRACE_MS = 500;
const WIDGET_KEY = "wabi-subagents";
const COMPLETION_TYPE = "wabi-subagent-complete";

type RunStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "stopped";
type TranscriptKind = "text" | "thinking" | "tool" | "tool-result" | "system";

interface TranscriptEntry {
	kind: TranscriptKind;
	text: string;
	at: number;
}

interface RunUsage {
	input: number;
	output: number;
	cost: number;
}

interface RunRecord {
	id: string;
	agent: AgentConfig;
	task: string;
	background: boolean;
	writer: boolean;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	widgetUntil?: number;
	currentTool?: string;
	model?: string;
	lastStopReason?: string;
	exitCode?: number | null;
	exitSignal?: string | null;
	errorMessage?: string;
	hasOutput: boolean;
	hasStderr: boolean;
	stderr: string;
	finalText: string;
	handoffBytes?: number;
	handoffText?: string;
	transcript: TranscriptEntry[];
	transcriptBytes: number;
	liveText: Map<number, string>;
	liveThinking: Map<number, string>;
	liveToolResult?: string;
	usage: RunUsage;
	decoder: JsonlDecoder;
	process?: ChildProcess;
	tempDir?: string;
	stopRequested?: string;
	suppressHandoff: boolean;
	finished: boolean;
	done: Promise<RunRecord>;
	resolveDone: (run: RunRecord) => void;
	onUpdate?: (result: AgentToolResult<SubagentDetails>) => void;
	updateTimer?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
	/** Bounded fallback finalization for a spawn failure whose `close` never fires. */
	fallbackTimer?: ReturnType<typeof setTimeout>;
}

/** A live run or an immutable archived run (restored from this session's artifact dir). */
type InspectorRun = RunRecord | ArchivedRun;

function isArchived(run: InspectorRun): boolean {
	return "archived" in run && run.archived;
}

interface RunView {
	id: string;
	agent: string;
	task: string;
	background: boolean;
	status: RunStatus;
	currentTool?: string;
	startedAt: number;
	endedAt?: number;
	lastOutput?: string;
	transcriptBytes?: number;
	handoffBytes?: number;
	isolationPct?: number;
}

interface SubagentDetails {
	run: RunView;
}

interface CompletionDetails {
	run: RunView;
	success: boolean;
}

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Self-contained task to delegate" }),
	background: Type.Optional(
		Type.Boolean({ description: "Return immediately; read-only agents only, with the final result steered back before the parent's next model turn" }),
	),
});

function isActive(run: { status: RunStatus }): boolean {
	return run.status === "starting" || run.status === "running" || run.status === "stopping";
}
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function lastOutput(run: RunRecord): string {
	const live = [...run.liveText.values()].join("");
	if (live.trim()) return live;
	if (run.liveToolResult?.trim()) return run.liveToolResult;
	for (let index = run.transcript.length - 1; index >= 0; index--) {
		const entry = run.transcript[index];
		if (entry.kind === "text" && entry.text.trim()) return entry.text;
	}
	return "";
}

function lastLine(text: string): string {
	return text.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

function viewOf(run: RunRecord): RunView {
	return {
		id: run.id,
		agent: run.agent.name,
		task: run.task,
		background: run.background,
		status: run.status,
		currentTool: run.currentTool,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		lastOutput: lastLine(lastOutput(run)) || undefined,
		transcriptBytes: run.transcriptBytes,
		handoffBytes: run.handoffBytes,
		isolationPct: runIsolationPct(run),
	};
}

function statusIcon(status: RunStatus): string {
	switch (status) {
		case "starting":
		case "running":
			return "⟳";
		case "stopping":
			return "◐";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "stopped":
			return "■";
	}
}

/** Bounded, model-visible handoff for a finished run. Only the agent's own text output and failure metadata (provider error presence, exit code, signal, stop reason, output/stderr presence) are included; raw provider diagnostics, stderr, and the transcript stay inspector-only (user-inspectable via /subagents). */
function runHandoff(run: RunRecord): string {
	if (run.handoffText) return run.handoffText;
	const status: HandoffFields["status"] = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "stopped";
	const text = formatHandoff({
		runId: run.id,
		agent: run.agent.name,
		status,
		providerError: Boolean(run.errorMessage),
		output: status === "completed" ? run.finalText : lastOutput(run),
		failure: status === "completed" ? undefined : {
			exitCode: run.exitCode ?? null,
			exitSignal: run.exitSignal ?? null,
			stopReason: run.lastStopReason,
			hasOutput: run.hasOutput,
			hasStderr: run.hasStderr,
		},
	});
	run.handoffBytes = Buffer.byteLength(text);
	run.handoffText = text;
	return text;
}

function runIsolationPct(run: { handoffBytes?: number; transcriptBytes: number }): number | undefined {
	if (!run.handoffBytes || !run.transcriptBytes) return undefined;
	return isolationPct(run.handoffBytes, run.transcriptBytes);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function (pi: ExtensionAPI) {
	const piAgentDir = getAgentDir();
	const agentDefinitionsDir = join(piAgentDir, "agents");
	const agentSummary = discoverAgents(agentDefinitionsDir)
		.map((agent) => `${agent.name}: ${agent.description}`)
		.join("; ") || "none configured";
	const runs = new Map<string, RunRecord>();
	/** Runs restored from this session's durable artifact dir after a reload/resume: immutable archived views. */
	const history = new Map<string, ArchivedRun>();
	/** One shared circuit for all child launches: a shared infrastructure outage trips it across agent roles. */
	const circuit = new CircuitBreaker();
	let runsDir: string | undefined;
	let sequence = 0;
	/** Fresh per extension instance (every process start or /reload), so run ids never collide across resets. */
	const instanceToken = Math.random().toString(36).slice(2, 10);
	let latestCtx: ExtensionContext | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let inspectorOpen = false;
	let shuttingDown = false;

	/** Durable per-parent-session postmortem record: full transcript + stderr kept locally only, mode 0600 under a mode-0700 session dir, written atomically. */
	function persistRun(run: RunRecord): void {
		if (!runsDir) return;
		try {
			writeRunArtifact(runsDir, run.id, {
				kind: "wabi-run",
				version: 1,
				id: run.id,
				agent: run.agent.name,
				task: run.task,
				status: run.status,
				background: run.background,
				startedAt: run.startedAt,
				endedAt: run.endedAt,
				exitCode: run.exitCode ?? null,
				exitSignal: run.exitSignal ?? null,
				stopReason: run.lastStopReason,
				errorMessage: run.errorMessage,
				hasOutput: run.hasOutput,
				hasStderr: run.hasStderr,
				transcript: run.transcript,
				transcriptBytes: run.transcriptBytes,
				stderr: run.stderr,
				handoffBytes: run.handoffBytes,
				usage: run.usage,
			});
		} catch (error) {
			// A failed artifact write must never break the run flow; the run record is still in memory.
			console.error(`wabi: failed to persist run artifact for ${run.id}: ${String(error)}`);
		}
	}

	/** Feed the shared circuit: completed/failed-with-output reset it, empty failures trip it, stopped probes release the probe slot without counting. */
	function recordCircuitResult(run: RunRecord): void {
		if (run.status === "completed" || (run.status === "failed" && run.hasOutput)) circuit.recordSuccess();
		else if (run.status === "failed" && !run.hasOutput && !run.stopRequested) circuit.recordEmptyFailure();
		else if (run.status === "stopped") circuit.recordStopped();
	}

	function visibleWidgetRuns(now = Date.now()): RunRecord[] {
		return [...runs.values()].filter((run) => isActive(run) || (run.widgetUntil ?? 0) > now);
	}

	function refreshWidget(): void {
		const ctx = latestCtx;
		if (ctx?.mode !== "tui" || inspectorOpen) {
			ctx?.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const visible = visibleWidgetRuns();
		if (visible.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			return;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => {
				const activeCount = visible.filter(isActive).length;
				const lines = [theme.fg("dim", `subagents · ${activeCount} running`)];
				for (const run of visible) {
					const color = run.status === "failed" ? "error" : run.status === "completed" ? "success" : run.status === "stopped" ? "warning" : "accent";
					const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
					const tool = run.currentTool ? ` · ${run.currentTool}` : "";
					lines.push(
						theme.fg(color, statusIcon(run.status)) +
						` ${theme.fg("text", run.id)} ${theme.fg("muted", run.status + tool)} ${theme.fg("dim", elapsed)}`,
					);
				}
				lines.push(theme.fg("dim", "Alt+S or /subagents to inspect"));
				return new Text(lines.join("\n"), 0, 0);
			},
			{ placement: "belowEditor" },
		);
	}

	function ensureWidget(): void {
		refreshWidget();
		if (!widgetTimer && visibleWidgetRuns().length > 0) {
			widgetTimer = setInterval(refreshWidget, 1_000);
		}
	}

	function progressResult(run: RunRecord): AgentToolResult<SubagentDetails> {
		const activity = run.currentTool ? `running ${run.currentTool}` : lastLine(lastOutput(run)) || run.status;
		return {
			content: [{ type: "text", text: `${run.id}: ${activity}` }],
			details: { run: viewOf(run) },
		};
	}

	function emitUpdate(run: RunRecord, immediate = false): void {
		if (!run.onUpdate) return;
		if (run.updateTimer) {
			if (!immediate) return;
			clearTimeout(run.updateTimer);
			run.updateTimer = undefined;
		}
		if (immediate) {
			run.onUpdate(progressResult(run));
			return;
		}
		run.updateTimer = setTimeout(() => {
			run.updateTimer = undefined;
			run.onUpdate?.(progressResult(run));
		}, 100);
	}

	function append(run: RunRecord, kind: TranscriptKind, text: string): void {
		if (text) {
			run.transcriptBytes += Buffer.byteLength(text);
			run.transcript.push({ kind, text, at: Date.now() });
		}
	}

	function applyDecoded(run: RunRecord, decoded: { events: Record<string, any>[]; errors: string[] }): void {
		for (const malformed of decoded.errors) append(run, "system", `Malformed child event: ${malformed}`);
		for (const event of decoded.events) processEvent(run, event);
	}

	function processEvent(run: RunRecord, event: Record<string, any>): void {
		if (run.finished) return;

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			const index = Number(update?.contentIndex ?? 0);
			if (update?.type === "text_start") run.liveText.set(index, "");
			else if (update?.type === "text_delta") run.liveText.set(index, (run.liveText.get(index) ?? "") + String(update.delta ?? ""));
			else if (update?.type === "text_end") run.liveText.set(index, String(update.content ?? run.liveText.get(index) ?? ""));
			else if (update?.type === "thinking_start") run.liveThinking.set(index, "");
			else if (update?.type === "thinking_delta") run.liveThinking.set(index, (run.liveThinking.get(index) ?? "") + String(update.delta ?? ""));
			else if (update?.type === "thinking_end") run.liveThinking.set(index, String(update.content ?? run.liveThinking.get(index) ?? ""));
			emitUpdate(run);
			return;
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			run.liveText.clear();
			run.liveThinking.clear();
			const texts: string[] = [];
			for (const part of message.content ?? []) {
				if (part?.type === "thinking") append(run, "thinking", String(part.thinking ?? ""));
				if (part?.type === "text") {
					const text = String(part.text ?? "");
					append(run, "text", text);
					if (text.trim()) texts.push(text);
				}
			}
			if (texts.length > 0) run.finalText = texts.join("\n");
			if (message.model) run.model = String(message.model);
			if (message.stopReason) run.lastStopReason = String(message.stopReason);
			if (message.errorMessage) run.errorMessage = String(message.errorMessage);
			for (const diagnostic of message.diagnostics ?? []) {
				append(run, "system", `Provider diagnostic: ${safeJson(diagnostic)}`);
			}
			if (message.usage) {
				run.usage.input += Number(message.usage.input ?? 0);
				run.usage.output += Number(message.usage.output ?? 0);
				run.usage.cost += Number(message.usage.cost?.total ?? message.usage.cost ?? 0);
			}
			emitUpdate(run);
			return;
		}

		if (event.type === "tool_execution_start") {
			run.currentTool = String(event.toolName ?? "tool");
			run.liveToolResult = undefined;
			append(run, "tool", `${run.currentTool} ${safeJson(event.args ?? {})}`);
			emitUpdate(run, true);
			ensureWidget();
			return;
		}

		if (event.type === "tool_execution_update") {
			run.currentTool = String(event.toolName ?? run.currentTool ?? "tool");
			const text = contentText(event.partialResult?.content);
			if (text) run.liveToolResult = text;
			emitUpdate(run);
			return;
		}

		if (event.type === "tool_execution_end") {
			const name = String(event.toolName ?? run.currentTool ?? "tool");
			const text = contentText(event.result?.content);
			append(run, "tool-result", `${name}${event.isError ? " (error)" : ""}${text ? `\n${text}` : ""}`);
			run.currentTool = undefined;
			run.liveToolResult = undefined;
			emitUpdate(run, true);
			ensureWidget();
		}
	}

	function handoffBackground(run: RunRecord): void {
		if (run.suppressHandoff || shuttingDown) return;
		const success = run.status === "completed";
		pi.sendMessage(
			{
				customType: COMPLETION_TYPE,
				content: runHandoff(run),
				display: true,
				details: { run: viewOf(run), success } satisfies CompletionDetails,
			},
			{ deliverAs: BACKGROUND_DELIVERY, triggerTurn: true },
		);
	}

	function finishRun(run: RunRecord, exitCode: number | null, exitSignal: string | null): void {
		if (run.finished) return;
		applyDecoded(run, run.decoder.flush());
		// Commit any streaming state as partial transcript entries before clearing it, so
		// partial output reaches the failure handoff and counts toward transcriptBytes.
		// On a normal message_end the live maps are already clear, so nothing duplicates.
		for (const thinking of run.liveThinking.values()) append(run, "thinking", thinking);
		for (const text of run.liveText.values()) append(run, "text", text);
		if (run.liveToolResult) append(run, "tool-result", `${run.currentTool ?? "tool"} (partial)\n${run.liveToolResult}`);
		run.finished = true;
		run.endedAt = Date.now();
		run.exitCode = exitCode;
		run.exitSignal = exitSignal;
		run.hasOutput = run.finalText.trim() !== "" || lastOutput(run).trim() !== "";
		run.hasStderr = run.stderr.trim() !== "";
		run.liveText.clear();
		run.liveThinking.clear();
		run.currentTool = undefined;
		run.liveToolResult = undefined;

		if (run.stopRequested) run.status = "stopped";
		else if (isCompletedRun(exitCode, run.lastStopReason, run.errorMessage)) run.status = "completed";
		else run.status = "failed";

		if (run.status === "failed" && run.stderr.trim()) append(run, "system", run.stderr.trim());
		run.widgetUntil = run.endedAt + COMPLETED_WIDGET_MS;
		if (run.updateTimer) clearTimeout(run.updateTimer);
		if (run.killTimer) clearTimeout(run.killTimer);
		if (run.fallbackTimer) clearTimeout(run.fallbackTimer);
		if (run.tempDir) rmSync(run.tempDir, { recursive: true, force: true });
		runHandoff(run); // cache the model-visible handoff so handoffBytes lands in the artifact
		recordCircuitResult(run);
		persistRun(run);
		emitUpdate(run, true);
		ensureWidget();
		run.resolveDone(run);
		if (run.background) handoffBackground(run);
	}

	function launchRun(
		agent: AgentConfig,
		task: string,
		background: boolean,
		ctx: ExtensionContext,
		onUpdate?: (result: AgentToolResult<SubagentDetails>) => void,
	): RunRecord {
		let resolveDone!: (run: RunRecord) => void;
		const done = new Promise<RunRecord>((resolve) => {
			resolveDone = resolve;
		});
		const run: RunRecord = {
			id: createRunId(agent.name, ++sequence, instanceToken),
			agent,
			task,
			background,
			writer: isWriter(agent),
			status: "starting",
			startedAt: Date.now(),
			stderr: "",
			finalText: "",
			handoffBytes: undefined,
			handoffText: undefined,
			transcript: [],
			transcriptBytes: 0,
			liveText: new Map(),
			liveThinking: new Map(),
			hasOutput: false,
			hasStderr: false,
			usage: { input: 0, output: 0, cost: 0 },
			decoder: new JsonlDecoder(),
			suppressHandoff: false,
			finished: false,
			done,
			resolveDone,
			onUpdate,
		};
		runs.set(run.id, run);

		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-prompt-templates",
			"--no-themes",
			ctx.isProjectTrusted() ? "--approve" : "--no-approve",
		];
		if (agent.model) args.push("--model", agent.model);
		if (agent.thinking) args.push("--thinking", agent.thinking);
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

		try {
			run.tempDir = mkdtempSync(join(tmpdir(), "wabi-"));
			const promptFile = join(run.tempDir, "prompt.md");
			writeFileSync(promptFile, composeSystemPrompt(agent.systemPrompt), { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
			args.push(`Task: ${task}`);
			const child = spawn("pi", args, {
				cwd: ctx.cwd,
				env: childEnv(), // canonical agent dir: children share the parent's locks on auth.json/models-store.json
				stdio: ["ignore", "pipe", "pipe"],
			});
			run.process = child;
			run.status = "running";
			child.stdout?.on("data", (chunk) => {
				applyDecoded(run, run.decoder.push(chunk));
			});
			child.stderr?.on("data", (chunk) => {
				run.stderr = (run.stderr + chunk.toString()).slice(-STDERR_BYTES);
			});
			child.on("error", (error) => {
				// Record, but never finalize here: `close` carries the authoritative (code, signal).
				run.errorMessage = String(error);
				// After a spawn failure there is no pid and `close` never fires; bound the wait.
				if (child.pid === undefined) {
					run.fallbackTimer = setTimeout(() => {
						if (!run.finished) finishRun(run, null, null);
					}, ERROR_FALLBACK_MS);
				}
				emitUpdate(run);
			});
			child.on("close", (code, signal) => finishRun(run, code, signal));
		} catch (error) {
			run.errorMessage = String(error);
			finishRun(run, null, null);
		}

		emitUpdate(run, true);
		ensureWidget();
		return run;
	}

	function stopRun(run: RunRecord, reason: string): void {
		if (!isActive(run) || run.stopRequested) return;
		run.stopRequested = reason;
		run.suppressHandoff = true;
		run.status = "stopping";
		run.process?.kill("SIGTERM");
		run.killTimer = setTimeout(() => {
			if (!run.finished) run.process?.kill("SIGKILL");
		}, FORCE_KILL_MS);
		emitUpdate(run, true);
		ensureWidget();
	}

	function transcriptLines(run: { transcript: { kind: string; text: string; at: number }[]; liveText?: Map<number, string>; liveThinking?: Map<number, string>; liveToolResult?: string; currentTool?: string }, width: number, showThinking: boolean, theme: any): string[] {
		const lines: string[] = [];
		const add = (prefix: string, text: string, color: string) => {
			const styledPrefix = theme.fg("dim", prefix);
			const available = Math.max(1, width - prefix.length);
			const wrapped = wrapTextWithAnsi(theme.fg(color, text), available);
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? styledPrefix : " ".repeat(prefix.length)}${wrapped[index]}`);
			}
		};

		for (const entry of run.transcript) {
			if (entry.kind === "thinking" && !showThinking) continue;
			if (entry.kind === "thinking") add("think › ", entry.text, "dim");
			else if (entry.kind === "text") add("agent › ", entry.text, "text");
			else if (entry.kind === "tool") add("tool  › ", entry.text, "accent");
			else if (entry.kind === "tool-result") add("result› ", entry.text, "muted");
			else add("system› ", entry.text, "warning");
		}
		if (showThinking) {
			for (const thinking of run.liveThinking?.values() ?? []) if (thinking) add("think › ", thinking, "dim");
		}
		for (const text of run.liveText?.values() ?? []) if (text) add("agent › ", text, "text");
		if (run.liveToolResult) add("result› ", `${run.currentTool ?? "tool"} (live)\n${run.liveToolResult}`, "muted");
		return lines.length > 0 ? lines : [theme.fg("dim", "(no transcript yet)")];
	}

	async function openInspector(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/subagents requires interactive mode", "error");
			return;
		}
		inspectorOpen = true;
		refreshWidget();
		let timer: ReturnType<typeof setInterval> | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let selectedId = [...runs.keys()].at(-1) ?? [...history.keys()].at(-1);
				let scroll = 0;
				let showThinking = false;
				let confirmStop: string | undefined;

				const ordered = () => [...runs.values(), ...history.values()];
				const selected = () => {
					const all = ordered();
					return all.find((run) => run.id === selectedId) ?? all.at(-1);
				};
				const move = (delta: number) => {
					const all = ordered();
					if (all.length === 0) return;
					const current = Math.max(0, all.findIndex((run) => run.id === selectedId));
					selectedId = all[Math.max(0, Math.min(all.length - 1, current + delta))].id;
					scroll = 0;
					confirmStop = undefined;
				};

				timer = setInterval(() => tui.requestRender(), 250);
				return {
					render(width: number): string[] {
						const all = ordered();
						const archivedCount = history.size;
						const lines = [theme.fg("accent", theme.bold(`Subagents · ${all.length}${archivedCount > 0 ? ` (${archivedCount} archived from this session's run history)` : ""}`))];
						if (all.length === 0) {
							lines.push("", theme.fg("dim", "No runs in this session."), "", theme.fg("dim", "Esc close"));
							return lines.map((line) => truncateToWidth(line, width));
						}

						const current = selected()!;
						selectedId = current.id;
						const selectedIndex = all.findIndex((run) => run.id === current.id);
						const listStart = Math.max(0, Math.min(selectedIndex - 2, Math.max(0, all.length - 5)));
						for (const run of all.slice(listStart, listStart + 5)) {
							const marker = run.id === current.id ? theme.fg("accent", ">") : " ";
							const color = run.status === "failed" ? "error" : run.status === "completed" ? "success" : run.status === "stopped" ? "warning" : "accent";
							const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
							const tool = "currentTool" in run && run.currentTool ? ` · ${run.currentTool}` : "";
							lines.push(`${marker} ${theme.fg(color, statusIcon(run.status))} ${run.id} ${theme.fg("muted", run.status + (isArchived(run) ? " · archived" : "") + tool)} ${theme.fg("dim", elapsed)}`);
						}
						lines.push(theme.fg("dim", "─".repeat(Math.max(1, width))), theme.fg("muted", `Task: ${current.task}`));

						const metrics = current.transcriptBytes
							? `transcript ${formatBytes(current.transcriptBytes)} · handoff ${current.handoffBytes ? formatBytes(current.handoffBytes) : "—"} · isolation ${runIsolationPct(current) ?? "—"}%`
							: "";
						if (metrics) lines.push(theme.fg("dim", metrics));
						const body = transcriptLines(current, width, showThinking, theme);
						const pageSize = Math.max(5, (process.stdout.rows ?? 30) - Math.min(all.length, 5) - 8);
						const maxScroll = Math.max(0, body.length - pageSize);
						scroll = Math.min(scroll, maxScroll);
						const end = body.length - scroll;
						lines.push(...body.slice(Math.max(0, end - pageSize), end));
						lines.push(theme.fg("dim", "─".repeat(Math.max(1, width))));
						if (confirmStop === current.id) lines.push(theme.fg("warning", "Stop this run? y confirm · any other key cancel"));
						else lines.push(theme.fg("dim", `↑↓ select · PgUp/PgDn scroll · Ctrl+T thinking ${showThinking ? "on" : "off"} · s stop · Esc close`));
						return lines.map((line) => truncateToWidth(line, width));
					},
					handleInput(data: string): void {
						const current = selected();
						if (confirmStop) {
							if (data === "y" || matchesKey(data, Key.enter)) {
								const live = runs.get(confirmStop);
								if (live) stopRun(live, "stopped by user");
							}
							confirmStop = undefined;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.escape)) done(undefined);
						else if (matchesKey(data, Key.up)) move(-1);
						else if (matchesKey(data, Key.down)) move(1);
						else if (matchesKey(data, Key.pageUp)) scroll += Math.max(5, (process.stdout.rows ?? 30) - 12);
						else if (matchesKey(data, Key.pageDown)) scroll = Math.max(0, scroll - Math.max(5, (process.stdout.rows ?? 30) - 12));
						else if (matchesKey(data, Key.ctrl("t"))) showThinking = !showThinking;
						else if (data === "s" && current && isActive(current)) confirmStop = current.id;
						tui.requestRender();
					},
					invalidate() {},
				};
			});
		} finally {
			if (timer) clearInterval(timer);
			inspectorOpen = false;
			ensureWidget();
		}
	}

	pi.registerMessageRenderer(COMPLETION_TYPE, (message, options, theme) => {
		const details = message.details as CompletionDetails | undefined;
		const run = details?.run;
		const icon = details?.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const label = run ? `${run.id} ${run.status}` : "subagent handoff";
		return new Text(`${icon} ${theme.fg("muted", label)}${options.expanded ? " — result steered to the parent before its next turn" : ""}`, options.outputPad, 0);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent (wabi)",
		description: `Delegate substantial independent work to configured child agents (${agentSummary}). Foreground subagent runs stream progress and block until done; background runs return immediately and accept read-only agents only, with the final result steered back before the parent's next model turn. Issue multiple sibling subagent calls in one message for independent blocking work. At most four subagents may run, and only one write-capable subagent at a time; write-capable subagents (worker, creative-worker) must run in the foreground.`,
		promptSnippet: "Delegate substantial independent research, implementation, creative work, or review to isolated child agents",
		promptGuidelines: [
			"Use subagent for non-atomic implementation: delegate to the worker subagent whenever a task needs further exploration, touches multiple files, has an uncertain path, or needs a test/debug loop; keep in the parent only known, localized one-file atomic edits — and only when the exact file is known, one edit suffices with no exploration or test/debug loop, and no risk review is triggered.",
			"Issue sibling foreground subagent calls in one assistant message for independent blocking work so they run in parallel; do not duplicate delegated scope across subagents.",
			"Use subagent in background only for read-only, nonblocking work (scout, reviewer); write-capable subagents (worker, creative-worker) must run in the foreground.",
			"Never poll or sleep for a subagent; never answer before required subagent runs finish — await each result, then integrate and verify it.",
			"Two consecutive subagent failures with no output mean an infrastructure outage (shared across all agents): stop delegating, report degraded mode, and run at most one health probe after the cooldown — never retry blindly into an open circuit.",
			"A failed subagent reviewer run is not a review: it provides no review feedback, so never treat it as one; re-review only after the underlying failure is resolved.",
			"After two failures of a non-atomic multi-file worker subagent task, do not take the task over in the parent: keep in the parent only a residual that is itself atomic, otherwise report the blocker and replan.",
			"After risky subagent changes, delegate an independent review to the reviewer subagent (the subagent-orchestration skill lists the risk classes); verify the integrated result in the parent without repeating the worker's exploration.",
			"Consult the subagent-orchestration skill for detailed routing and agent selection.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestCtx = ctx;
			const agents = discoverAgents(agentDefinitionsDir);
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) throw new Error(`Unknown agent "${params.agent}". Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");

			const background = params.background ?? false;
			if (background && ctx.mode !== "tui" && ctx.mode !== "rpc") {
				throw new Error("Background subagents require an interactive or RPC parent session.");
			}
			const active = [...runs.values()].filter(isActive);
			const policyError = launchPolicy(agent, {
				background,
				activeCount: active.length,
				activeWriterCount: active.filter((run) => run.writer).length,
			});
			if (policyError) throw new Error(policyError);

			// Circuit admission sits immediately before the launch: every rejection path above
			// runs first, so a half-open probe can only be consumed by an actual launch.
			if (!circuit.allowLaunch()) throw new Error(circuitBlockedMessage(agent.name));

			const run = launchRun(agent, params.task.trim(), background, ctx, background ? undefined : onUpdate);

			if (background) {
				return {
					content: [{ type: "text", text: `Started ${run.id} in the background (read-only). Its final result will be steered back before your next turn.` }],
					details: { run: viewOf(run) },
				};
			}

			const abort = () => stopRun(run, "parent tool aborted");
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			await run.done.finally(() => signal?.removeEventListener("abort", abort));
			if (run.status !== "completed") throw new Error(runHandoff(run));
			return {
				content: [{ type: "text", text: runHandoff(run) }],
				details: { run: viewOf(run) },
			};
		},

		renderCall(args, theme) {
			const mode = args.background ? "background" : "foreground";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent)} ${theme.fg("muted", mode)}\n  ${theme.fg("dim", args.task)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			const run = details?.run;
			if (!run) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const color = run.status === "failed" ? "error" : run.status === "completed" ? "success" : run.status === "stopped" ? "warning" : "accent";
			const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
			let text = `${theme.fg(color, statusIcon(run.status))} ${theme.fg("toolTitle", run.id)} ${theme.fg("muted", run.status)} ${theme.fg("dim", elapsed)}`;
			if (run.currentTool) text += `\n${theme.fg("dim", `  ${run.currentTool}`)}`;
			if (expanded && run.lastOutput) text += `\n\n${theme.fg("toolOutput", run.lastOutput)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("subagents", {
		description: "Inspect live and completed subagents from this session",
		handler: async (_args, ctx) => openInspector(ctx),
	});
	pi.registerShortcut("alt+s", {
		description: "Open the subagent inspector",
		handler: async (ctx) => openInspector(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		shuttingDown = false;
		runsDir = sessionRunsDir(piAgentDir, ctx.sessionManager.getSessionId());
		history.clear();
		try {
			ensureRunsDir(runsDir); // harden (and create) the session archive dir before restoring
			for (const artifact of loadRunArtifacts(runsDir)) {
				history.set(artifact.id, archivedRunOf(artifact));
			}
		} catch {
			// Unusable archive dir (e.g. read-only agent dir): skip archiving this session.
			runsDir = undefined;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		const active = [...runs.values()].filter(isActive);
		for (const run of active) {
			run.suppressHandoff = true;
			stopRun(run, "parent session closed");
		}
		if (active.length > 0) {
			await Promise.race([
				Promise.all(active.map((run) => run.done)),
				new Promise((resolve) => setTimeout(resolve, FORCE_KILL_MS + 500)),
			]);
			for (const run of active) {
				if (!run.finished) run.process?.kill("SIGKILL");
			}
			if (active.some((run) => !run.finished)) {
				// Give `close` a moment to land after SIGKILL; then settle the rest explicitly so
				// every run still gets a terminal status, an artifact, and a resolved `done`.
				await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS));
			}
			// A late `close` after this is a no-op: finishRun's `finished` guard prevents double-finalizing.
			finishUnresolvedRuns(active, (run) => finishRun(run, null, "SIGKILL"));
			for (const run of active) {
				if (run.tempDir) rmSync(run.tempDir, { recursive: true, force: true });
			}
		}
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		runs.clear();
		history.clear();
		runsDir = undefined;
		latestCtx = undefined;
	});
}
