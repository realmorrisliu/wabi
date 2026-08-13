// Observable subagents for pi. Each run is a direct one-shot `pi --mode json`
// child: progress stays in the TUI, while only the final answer is handed back
// to the parent model.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activeOwnerTokens, createReadonlyRunDir, sweepReadonlyRuns } from "./cleanup.ts";
import { resolveChildCwd, resolveRunCwd, type CloneBaseline } from "./clone.ts";
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
	formatCost,
	formatDuration,
	formatHandoff,
	isCompletedRun,
	isolationPct,
	isWriter,
	launchPolicy,
	loadRunArtifacts,
	removeTempDirBestEffort,
	sessionRunsDir,
	terminalClamp,
	transcriptView,
	windowAround,
	writeRunArtifact,
} from "./lib.ts";

const STDERR_BYTES = 128 * 1024;
const COMPLETED_WIDGET_MS = 5_000;
const FORCE_KILL_MS = 5_000;
/** If a spawn failed, `close` never fires; this bounds the wait before finalizing. */
const ERROR_FALLBACK_MS = 1_000;
/** After SIGKILL, how long to wait for the child's `close` event before finalizing the run ourselves. */
const CLOSE_GRACE_MS = 500;
const COMPLETION_TYPE = "wabi-subagent-complete";
const WIDGET_KEY = "wabi-subagents";

/** Owner tokens of live extension instances in this process, kept in a process-global registry (a `Symbol.for`-keyed set on globalThis, see cleanup.ts) so every copy of this module in the same JS realm — duplicate/aliased extension paths, reloads — shares one set. The startup stale-run sweep skips any run whose marker token is registered here, and deletes runs of previous instances of this same process (reloads, session switches) that are not — a pid + identity check alone cannot see a reload inside the same process. One process can hold several extension instances at once (pi re-invokes the factory on every reload and session switch, and duplicate/aliased extension paths load twice), so each instance registers its own token when it loads and deregisters it in its own session_shutdown — never in another instance's load, never clearing other tokens. pi awaits an instance's session_shutdown before the next instance loads, so a replaced instance's token is gone by the next session_start sweep (its leftover dirs become reclaimable via the same-process rule) while every live instance's runs stay protected. */

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
	/** Cancellation for clone preparation: stopRun aborts it so prep terminates (killing the current git child) and settles as stopped. */
	abortPrep?: AbortController;
	/** Snapshot baseline for read-only runs (research-plan, reviewer) that execute in a per-run disposable clone. */
	baseline?: CloneBaseline;
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
	model?: string;
	cost: number;
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
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the run (default: the parent's current directory; relative paths resolve against it). Pass the target checkout when the task works in a different worktree of the repo, so read-only runs snapshot that directory — its uncommitted changes included — and write-capable runs start in it." }),
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
		model: run.model ?? run.agent.model,
		cost: run.usage.cost,
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
			return "●";
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

/** Baseline block appended to a read-only child's task so its handoff can report Baseline accurately. */
function baselinePrompt(baseline: CloneBaseline): string {
	return [
		`Read-only run environment: you are working in a per-run disposable clone of the working directory your task launched in (detached HEAD ${baseline.head}, branch ${baseline.branch}, as-of ${new Date(baseline.asOf).toISOString()}, fingerprint ${baseline.fingerprint}).`,
		"The staged, unstaged, and non-ignored untracked state of the launched working directory was copied into this clone; its refs, stash, config, index, and working tree are independent of the parent's and are discarded when the run ends.",
		"Stay read-only: do not fetch, checkout, reset, or stash. If you ignore this, only this disposable clone is damaged, never the parent workspace.",
		"Report this Baseline (HEAD sha, as-of, fingerprint) as the first Evidence item, followed by inspected update markers for dynamic resources.",
	].join("\n");
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

/** Wrap inspector lines in a bordered panel with a background so the rail reads as a distinct surface from the chat. `border`/`bg` are style functions (e.g. theme.fg/theme.bg). Rounded corners for the primary container; one column of padded background on each side so text never touches the border. The panel's total width is exactly `width`; over-long lines are truncated ANSI-safely to the content budget (padded from the truncated result). Below 3 columns the border is dropped and only the padded content rows remain. Exported so the offline smoke check can pin the width contract. */
export function boxPanel(lines: string[], width: number, border: (text: string) => string, bg: (text: string) => string): string[] {
	const inner = Math.max(1, width - 2); // border span between the corners
	const pad = (line: string) => {
		const content = truncateToWidth(line, Math.max(0, inner - 1));
		return " " + content + " ".repeat(Math.max(0, inner - 1 - visibleWidth(content)));
	};
	if (width < 3) return lines.map((line) => bg(truncateToWidth(line, Math.max(0, width))));
	return [border(`╭${"─".repeat(inner)}╮`), ...lines.map((line) => border("│") + bg(pad(line)) + border("│")), border(`╰${"─".repeat(inner)}╯`)];
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
	/** Fresh per extension instance (every process start, /reload, or session switch), so run ids never collide across resets. */
	const instanceToken = Math.random().toString(36).slice(2, 10);
	activeOwnerTokens().add(instanceToken);
	let latestCtx: ExtensionContext | undefined;
	let headerTimer: ReturnType<typeof setInterval> | undefined;
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
				model: run.model ?? run.agent.model,
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

	function visibleRuns(now = Date.now()): RunRecord[] {
		return [...runs.values()].filter((run) => isActive(run) || (run.widgetUntil ?? 0) > now);
	}

	/** Persistent top bar: a compact two-line status that never takes focus away from the editor. Installed when runs become visible, removed when they clear; the component re-renders itself once per second. */
	/** Persistent status line above the editor (the only non-scrolling "top bar" pi offers — setHeader lives inside the scrolling chat document and rolls out of view). One compact line: counts, cost, and the expand hint. */
	function refreshHeader(): void {
		const ctx = latestCtx;
		if (ctx?.mode !== "tui") return;
		const visible = visibleRuns();
		if (visible.length === 0) {
			if (headerTimer) {
				clearInterval(headerTimer); // stop the flip monitor; the next ensureHeader restarts it when a run appears
				headerTimer = undefined;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
			return;
		}
		if (headerTimer) return; // already installed; the widget refreshes itself below
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				const renderTimer = setInterval(() => tui.requestRender(), 1_000);
				const bgLine = (line: string, width: number) => theme.bg("customMessageBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
				return {
					render(width: number): string[] {
						const current = visibleRuns();
						const activeCount = current.filter(isActive).length;
						const doneCount = current.filter((run) => run.status === "completed").length;
						const failedCount = current.filter((run) => run.status === "failed").length;
						const totalCost = current.reduce((sum, run) => sum + (run.usage.cost || 0), 0);
						const cost = formatCost(totalCost);
						const narrow = width < 80;
						const sep = theme.fg("muted", " · ");
						const counts: string[] = [theme.fg("accent", `● ${activeCount} running`)];
						if (doneCount > 0) counts.push(theme.fg("success", `✓ ${doneCount} done`));
						if (failedCount > 0) counts.push(theme.fg("error", `✗ ${failedCount} failed`));
						if (cost && !narrow) counts.push(theme.fg("text", cost));
						const title = `${theme.fg("accent", theme.bold("SUBAGENTS"))}  ${counts.join(sep)}`;
						const perRun = current
							.slice(0, narrow ? 2 : 3)
							.map((run) => {
								const color = run.status === "failed" ? "error" : run.status === "completed" ? "success" : run.status === "stopped" ? "warning" : "accent";
								const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
								return `${theme.fg(color, statusIcon(run.status))} ${theme.fg("text", run.agent.name)}${narrow ? "" : ` ${theme.fg("muted", elapsed)}`}`;
							})
							.join(theme.fg("dim", " · "));
						const more = current.length - (narrow ? 2 : 3);
						const hint = process.platform === "darwin" ? "⌘S 展开面板 · /subagents" : "Alt+S 展开面板 · /subagents";
						const lines = [
							bgLine(title + (narrow ? "" : `  ${theme.fg("dim", hint)}`), width),
							bgLine(perRun + (more > 0 ? theme.fg("dim", ` · +${more} more`) : ""), width),
							bgLine("", width), // spacer keeps the band visually separate from the editor
						];
						return lines.map((line) => truncateToWidth(line, width));
					},
					invalidate() {},
					dispose() {
						clearInterval(renderTimer);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		headerTimer = setInterval(refreshHeader, 1_000); // keeps the 0↔non-zero flip monitored
	}

	function ensureHeader(): void {
		refreshHeader();
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
			ensureHeader();
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
			ensureHeader();
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
		// Best-effort temp dir removal: a cleanup failure is recorded locally (bounded) and never blocks the handoff, artifact, circuit update, emit, or settle.
		removeTempDirBestEffort(run.tempDir, (error) => {
			append(run, "system", `Run temp dir cleanup failed (left in place): ${String(error).slice(0, 200)}`);
		});
		runHandoff(run); // cache the model-visible handoff so handoffBytes lands in the artifact
		recordCircuitResult(run);
		persistRun(run);
		emitUpdate(run, true);
		ensureHeader();
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
			// Background runs suppress steering at launch: the tool call has not yet confirmed the
			// child truly started, so a prep failure/stop must be delivered once, as the tool error
			// thrown by execute — never also as a steered message. execute lifts this after startRun
			// proves the child is up; stopRun/session_shutdown re-assert it for their own semantics.
			suppressHandoff: true,
			finished: false,
			done,
			resolveDone,
			onUpdate,
			abortPrep: new AbortController(),
		};
		runs.set(run.id, run);
		emitUpdate(run, true);
		ensureHeader();
		return run;
	}

	/**
	 * Async launch pipeline: temp dir, clone preparation for read-only agents,
	 * then the child spawn. Runs in parallel with the caller; cancellation is
	 * wired through `run.abortPrep` (stopRun aborts it, so stop/reload during
	 * preparation terminates it and settles the run as stopped). Any
	 * preparation error fails the run closed with the bounded handoff — never
	 * a fallback to the shared cwd, never raw git stderr in the handoff.
	 */
	async function startRun(run: RunRecord, task: string, ctx: ExtensionContext, runCwd: string): Promise<void> {
		const agent = run.agent;
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
			if (run.stopRequested) {
				finishRun(run, null, null); // stopped before preparation started
				return;
			}
			if (run.writer) {
				run.tempDir = mkdtempSync(join(tmpdir(), "wabi-")); // legacy per-run prompt temp dir; never swept
			} else {
				// Read-only runs live in a dedicated root with an owner marker so a later
				// startup sweep can reclaim dirs left by kill -9/crashes or failed cleanups.
				// The marker is written before clone preparation begins; any failure here
				// fails the run closed and the dir is removed by the existing cleanup.
				run.tempDir = createReadonlyRunDir(run.id, instanceToken);
			}
			const promptFile = join(run.tempDir, "prompt.md");
			writeFileSync(promptFile, composeSystemPrompt(agent.systemPrompt), { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
			// Read-only agents (research-plan, reviewer) run in a per-run disposable clone: their git
			// state is independent of the parent's and the clone inherits the temp dir's
			// cleanup. Preparation is asynchronous and cancelable (stop/reload/tool abort
			// terminate it under one shared total deadline); failure throws and fails the run
			// closed — never fall back to the shared cwd. The clone is taken from the run's
			// working directory (the subagent `cwd` parameter, default the parent's), so a
			// task targeting a different worktree of the repo snapshots exactly that
			// worktree — that directory's uncommitted changes included. Write-capable
			// agents keep the run's working directory unchanged.
			let childCwd = runCwd;
			if (!run.writer) {
				const workspace = await resolveChildCwd(agent, runCwd, run.tempDir, run.abortPrep?.signal);
				childCwd = workspace.cwd;
				run.baseline = workspace.baseline;
			}
			if (run.stopRequested) {
				finishRun(run, null, null); // stopped while preparing; do not spawn
				return;
			}
			args.push(run.baseline ? `Task: ${task}\n\n${baselinePrompt(run.baseline)}` : `Task: ${task}`);
			const child = spawn("pi", args, {
				cwd: childCwd,
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
			emitUpdate(run, true);
			ensureHeader();
		} catch (error) {
			// An aborted preparation (stop/reload/tool abort, or the shared prep deadline)
			// settles as stopped — never an infrastructure empty failure, never providerError.
			if (error instanceof Error && error.name === "AbortError") {
				if (!run.stopRequested) run.stopRequested = "clone preparation deadline exceeded";
			} else {
				run.errorMessage = String(error);
			}
			finishRun(run, null, null);
		}
	}

	function stopRun(run: RunRecord, reason: string): void {
		if (!isActive(run) || run.stopRequested) return;
		run.stopRequested = reason;
		run.suppressHandoff = true;
		run.status = "stopping";
		run.abortPrep?.abort(); // terminate clone preparation (kills the current git child) when the child does not exist yet
		run.process?.kill("SIGTERM");
		run.killTimer = setTimeout(() => {
			if (!run.finished) run.process?.kill("SIGKILL");
		}, FORCE_KILL_MS);
		emitUpdate(run, true);
		ensureHeader();
	}

	function transcriptLines(run: { transcript: { kind: string; text: string; at: number }[]; liveText?: Map<number, string>; liveThinking?: Map<number, string>; liveToolResult?: string; currentTool?: string }, width: number, showThinking: boolean, theme: any): string[] {
		const lines: string[] = [];
		const add = (prefix: string, text: string, color: string, prefixColor = "dim") => {
			const styledPrefix = theme.fg(prefixColor, prefix);
			const available = Math.max(1, width - prefix.length);
			const wrapped = wrapTextWithAnsi(theme.fg(color, text), available);
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? styledPrefix : " ".repeat(prefix.length)}${wrapped[index]}`);
			}
		};

		for (const entry of run.transcript) {
			if (entry.kind === "thinking" && !showThinking) continue;
			if (entry.kind === "thinking") add("think › ", entry.text, "dim", "muted");
			else if (entry.kind === "text") add("agent › ", entry.text, "text", "accent");
			else if (entry.kind === "tool") add("tool  › ", entry.text, "toolOutput", "toolTitle");
			else if (entry.kind === "tool-result") add("result› ", entry.text, "muted", "muted");
			else add("system› ", entry.text, "warning", "warning");
		}
		if (showThinking) {
			for (const thinking of run.liveThinking?.values() ?? []) if (thinking) add("think › ", thinking, "dim");
		}
		for (const text of run.liveText?.values() ?? []) if (text) add("agent › ", text, "text");
		if (run.liveToolResult) add("result› ", `${run.currentTool ?? "tool"} (live)\n${run.liveToolResult}`, "muted");
		return lines.length > 0 ? lines : [theme.fg("dim", "(no transcript yet)")];
	}

	const groupOf = (run: InspectorRun): number => (isActive(run) ? 1 : isArchived(run) ? 3 : 2);
	const agentLabel = (run: InspectorRun): string => ("agentName" in run ? run.agentName : run.agent.name);
	const runModel = (run: InspectorRun): string | undefined => (isArchived(run) ? run.model : run.model ?? run.agent.model);
	const colorOf = (run: InspectorRun): string => (run.status === "failed" ? "error" : run.status === "completed" ? "success" : run.status === "stopped" ? "warning" : "accent");
	const GROUP_NAMES = ["all", "active", "review", "archived"];
	const panelBorder = (theme: any) => (text: string) => theme.fg("borderMuted", text);
	const panelBg = (theme: any) => (text: string) => theme.bg("customMessageBg", text);
	const box = (theme: any, lines: string[], width: number): string[] => boxPanel(lines, width, panelBorder(theme), panelBg(theme));

	/** Expandable top panel: the persistent subagent rail. ↑↓ selects, Enter opens the full detail page (Esc returns here), Esc closes the rail. */
	async function openRail(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/subagents requires interactive mode", "error");
			return;
		}
		let selection: string | undefined;
		do {
			selection = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
				let selectedId = [...runs.keys()].at(-1) ?? [...history.keys()].at(-1);
				let confirmStop: string | undefined;
				let groupFilter = 0; // 0 all · 1 active · 2 review · 3 archived

				const ordered = () => [...runs.values(), ...history.values()].filter((run) => groupFilter === 0 || groupOf(run) === groupFilter);
				const selected = () => {
					const all = ordered();
					return all.find((run) => run.id === selectedId) ?? all.at(-1);
				};
				const move = (delta: number) => {
					const all = ordered();
					if (all.length === 0) return;
					const current = Math.max(0, all.findIndex((run) => run.id === selectedId));
					selectedId = all[Math.max(0, Math.min(all.length - 1, current + delta))].id;
					confirmStop = undefined;
				};
				const cycleGroup = (delta: number) => {
					groupFilter = (groupFilter + delta + 4) % 4;
					const all = ordered();
					selectedId = all.at(-1)?.id ?? selectedId;
					confirmStop = undefined;
				};

				const timer = setInterval(() => tui.requestRender(), 250);
				return {
					render(width: number): string[] {
						const all = ordered();
						const innerW = Math.max(1, width - 4); // boxPanel inner width (border + padding)
						const rows = Math.max(4, Math.floor((process.stdout.rows ?? 30) / 2) - 4);
						const narrow = width < 80;
						const total = [...runs.values(), ...history.values()].length;
						const titleLeft = `${theme.fg("accent", theme.bold("SUBAGENTS"))} ${theme.fg("muted", `${total} total${history.size > 0 ? ` · ${history.size} archived` : ""}`)}`;
						const tabs = GROUP_NAMES.map((name, index) => (index === groupFilter ? theme.fg("accent", theme.bold(`[${name}]`)) : theme.fg("dim", name))).join(" ");
						const out = [titleLeft + (narrow ? "" : " ".repeat(Math.max(1, innerW - visibleWidth(titleLeft) - visibleWidth(tabs))) + tabs)];

						if (all.length === 0) {
							out.push("", theme.fg("dim", "No runs in this group."), "", theme.fg("dim", "←/→ switch group · Esc close"));
							return box(theme, out, width).map((line) => truncateToWidth(line, width));
						}

						const current = selected()!;
						selectedId = current.id;
						const leftLines: string[] = [];
						const leftRunAt = new Map<number, InspectorRun>();
						const groups: { filter: number; label: (count: number) => string; color: string }[] = [
							{ filter: 1, label: (count) => `● ACTIVE (${count})`, color: "accent" },
							{ filter: 2, label: (count) => `○ NEEDS REVIEW (${count})`, color: "muted" },
							{ filter: 3, label: (count) => `▽ ARCHIVED (${count})`, color: "dim" },
						];
						for (const group of groups) {
							if (groupFilter !== 0 && groupFilter !== group.filter) continue;
							const members = all.filter((run) => groupOf(run) === group.filter);
							if (members.length === 0 && groupFilter === 0) continue;
							if (leftLines.length > 0) leftLines.push(""); // blank line between groups
							leftLines.push(theme.fg(group.color, theme.bold(group.label(members.length))));
							for (const run of members) {
								leftRunAt.set(leftLines.length, run);
								leftLines.push("");
							}
						}
						// Fixed column widths computed once over the visible members: marker/icon fixed, name/model padded, elapsed right-aligned.
						const members = [...leftRunAt.values()];
						const nameW = narrow ? 0 : Math.min(24, Math.max(...members.map((run) => run.id.replace(/-[^-]+$/, "").length)));
						const modelW = narrow ? 0 : Math.min(20, Math.max(...members.map((run) => (runModel(run) ?? "").length)));
						const elapsedW = Math.max(...members.map((run) => formatDuration((run.endedAt ?? Date.now()) - run.startedAt).length));
						const runLine = (run: InspectorRun): string => {
							const shortId = run.id.replace(/-[^-]+$/, "");
							const selected = run.id === current.id;
							const marker = selected ? theme.fg("accent", "▸") : " ";
							const icon = theme.fg(colorOf(run), statusIcon(run.status));
							const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
							const running = isActive(run);
							let line = `${marker} ${icon} ${nameW > 0 ? theme.fg("text", shortId.padEnd(nameW)) + " " : ""}${modelW > 0 ? theme.fg("muted", (runModel(run) ?? "").padEnd(modelW)) + " " : ""}${theme.fg(running ? "accent" : "text", elapsed.padStart(elapsedW))}`;
							if (selected) line = theme.bg("selectedBg", line + " ".repeat(Math.max(0, innerW - visibleWidth(line))));
							return line;
						};
						for (const [lineIndex, run] of leftRunAt) leftLines[lineIndex] = runLine(run);
						const selectedLine = [...leftRunAt.entries()].find(([, run]) => run.id === current.id)?.[0] ?? 0;
						const listStart = windowAround(leftLines.length, rows - 2, selectedLine);
						out.push(...leftLines.slice(listStart, listStart + rows - 2));
						out.push("");
						if (confirmStop === current.id) out.push(theme.fg("warning", "Stop this run? y confirm · any other key cancel"));
						else out.push(theme.fg("dim", `↑↓/jk select · Enter 详情 · ←/→ group ${GROUP_NAMES[groupFilter]} · s stop · Esc close`));
						return box(theme, out, width).map((line) => truncateToWidth(line, width));
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
						else if (matchesKey(data, Key.enter) && current) done(current.id);
						else if (matchesKey(data, Key.up) || data === "k") move(-1);
						else if (matchesKey(data, Key.down) || data === "j") move(1);
						else if (matchesKey(data, Key.left)) cycleGroup(-1);
						else if (matchesKey(data, Key.right)) cycleGroup(1);
						else if (data === "s" && current && isActive(current)) confirmStop = current.id;
						tui.requestRender();
					},
					invalidate() {},
					dispose() {
						clearInterval(timer);
					},
				};
			}, {
				overlay: true,
				overlayOptions: () => {
					const termWidth = process.stdout.columns ?? 100;
					const width = termWidth < 80 ? "100%" : Math.min(110, Math.max(64, Math.floor(termWidth * 0.85)));
					return { anchor: "top-center", width, maxHeight: "55%", margin: { top: 1 } };
				},
			});
			if (selection) await openDetail(ctx, selection);
		} while (selection !== undefined);
	}

	/** Full-screen detail page for one run: header, metrics, transcript. Esc returns to the rail. */
	async function openDetail(ctx: ExtensionContext, runId: string): Promise<void> {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			let scroll = 0;
			let showThinking = false;
			let confirmStop: string | undefined;
			const timer = setInterval(() => tui.requestRender(), 250);
			return {
				render(width: number): string[] {
					const all = [...runs.values(), ...history.values()];
					const current = all.find((run) => run.id === runId) ?? all.at(-1);
					if (!current) return terminalClamp([theme.fg("dim", "Run not found — Esc close")], process.stdout.rows);
					const rows = Math.max(1, (process.stdout.rows ?? 30) - 3);
					const narrow = width < 80;
					const out: string[] = [];
					const model = narrow ? undefined : runModel(current);
					const cost = formatCost(current.usage.cost);
					const head: string[] = [];
					head.push(`${theme.fg("accent", theme.bold(agentLabel(current)))}${model ? ` ${theme.fg("muted", "· " + model)}` : ""}`);
					const statusText = `${statusIcon(current.status)} ${current.status}${isArchived(current) ? " · archived" : ""}`;
					head.push(`${theme.fg(colorOf(current), statusText)} · ${formatDuration((current.endedAt ?? Date.now()) - current.startedAt)}${cost ? ` · ${theme.fg("text", cost)}` : ""}${current.background ? ` · ${theme.fg("muted", "background")}` : ""}${("currentTool" in current && current.currentTool && narrow) ? ` · ${theme.fg("accent", `tool: ${current.currentTool}`)}` : ""}`);
					if (!narrow && "currentTool" in current && current.currentTool) head.push(theme.fg("accent", `tool: ${current.currentTool}`));
					const taskWrapped = wrapTextWithAnsi(current.task, Math.max(1, width - 8));
					taskWrapped.slice(0, 5).forEach((line, index) => {
						head.push(index === 0 ? `${theme.fg("accent", theme.bold("Task: "))}${theme.fg("text", line)}` : `      ${theme.fg("text", line)}`);
					});
					if (taskWrapped.length > 5) head.push(theme.fg("dim", "      …"));
					const metrics = current.transcriptBytes
						? `transcript ${formatBytes(current.transcriptBytes)} · handoff ${current.handoffBytes ? formatBytes(current.handoffBytes) : "—"} · isolation ${runIsolationPct(current) ?? "—"}%`
						: "";
					if (metrics && !narrow) head.push(theme.fg("dim", metrics));
					// Header block as a background band, same visual language as the top bar.
					out.push(...head.map((line) => theme.bg("customMessageBg", " " + line + " ".repeat(Math.max(0, width - 1 - visibleWidth(line))))));
					out.push(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
					const body = transcriptLines(current, width, showThinking, theme);
					const detailHeader = out.length;
					const pageSize = Math.max(0, rows - detailHeader);
					scroll = Math.min(scroll, Math.max(0, body.length - pageSize));
					const view = transcriptView(body.length, pageSize, scroll);
					out.push(...body.slice(view.start, view.end));
					out.push(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
					if (confirmStop === current.id) out.push(theme.fg("warning", "Stop this run? y confirm · any other key cancel"));
					else out.push(theme.fg("dim", `↑↓/jk scroll · PgUp/PgDn page · Ctrl+T thinking ${showThinking ? "on" : "off"} · s stop · Esc 返回`));
					return terminalClamp(out, process.stdout.rows).map((line) => truncateToWidth(line, width));
				},
				handleInput(data: string): void {
					const current = [...runs.values(), ...history.values()].find((run) => run.id === runId);
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
					else if (matchesKey(data, Key.up) || data === "k") scroll += 1; // render clamps the upper bound
					else if (matchesKey(data, Key.down) || data === "j") scroll = Math.max(0, scroll - 1);
					else if (matchesKey(data, Key.pageUp)) scroll += Math.max(5, (process.stdout.rows ?? 30) - 12);
					else if (matchesKey(data, Key.pageDown)) scroll = Math.max(0, scroll - Math.max(5, (process.stdout.rows ?? 30) - 12));
					else if (matchesKey(data, Key.ctrl("t"))) showThinking = !showThinking;
					else if (data === "s" && current && isActive(current)) confirmStop = current.id;
					tui.requestRender();
				},
				invalidate() {},
				dispose() {
					clearInterval(timer);
				},
			};
		});
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
		description: `Delegate substantial independent work to configured child agents (${agentSummary}). Foreground subagent runs stream progress and block until done; background runs return immediately and accept read-only agents only, with the final result steered back before the parent's next model turn. Issue multiple sibling subagent calls in one message for independent blocking work. At most four subagents may run, and only one write-capable subagent at a time; write-capable subagents (creative-worker) must run in the foreground.`,
		promptSnippet: "Delegate substantial independent research, planning, review, or creative work to isolated child agents",
		promptGuidelines: [
			"The parent agent owns ordinary implementation: keep non-atomic implementation in the parent, and do not delegate to subagents work that is small, tightly coupled, or already fully understood. Delegate only when isolation, parallelism, or a specialist child pays for the handoff.",
			"For a complex or uncertain task, delegate Research & Plan to the read-only `research-plan` subagent before you explore or implement — it owns the deep dive and returns an implementation plan with evidence. Do not pre-explore the task yourself: the handoff is the exploration. Foreground when the plan gates the next step, background otherwise. Implement the adopted plan in the parent; research-plan runs are read-only and never implement.",
			"Use the `creative-worker` subagent for visual, interactive, web, and 3D builds; use the `reviewer` subagent for an independent correctness and complexity pass after risky changes.",
			"Issue sibling foreground subagent calls in one assistant message for independent blocking work so they run in parallel; do not duplicate delegated scope across subagents.",
			"Use subagent in background only for read-only, nonblocking work (research-plan, reviewer); write-capable subagents (creative-worker) must run in the foreground.",
			"Never poll or sleep for a subagent; never answer before required subagent runs finish — await each result, then integrate and verify it.",
			"Two consecutive subagent failures with no output mean an infrastructure outage (shared across all agents): stop delegating, report degraded mode, and run at most one health probe after the cooldown — never retry blindly into an open circuit.",
			"A failed subagent reviewer run is not a review: it provides no review feedback, so never treat it as one; re-review only after the underlying failure is resolved.",
			"After two failures of the same delegated subagent task, do not blindly retry: report the blocker and replan (a fresh research-plan run may help) instead of hammering the same launch.",
			"After risky subagent changes, delegate an independent review to the reviewer subagent (the subagent-orchestration skill lists the risk classes); verify the integrated result in the parent without repeating the child's exploration.",
			"Research-plan and reviewer subagent runs execute in a per-run disposable clone of the run's working directory (detached HEAD at launch, snapshotting staged, unstaged, and non-ignored untracked state); a failed clone preparation fails the run closed — never fall back to the shared working directory, never retry the same launch blindly.",
			"Pass the subagent `cwd` parameter (default: the parent's current directory) when the delegated task targets a different working directory — e.g. another worktree or checkout of the same repo. Read-only runs then snapshot that directory instead of the parent's, so the reviewer's clone contains that directory's uncommitted changes; write-capable runs start in it. Never create a local commit just to make uncommitted changes reviewable.",
			"Delegating a scope transfers evidence ownership to the subagent child: before delegating, collect only routing inventory (ids, titles, states, labels, updatedAt, repo HEAD); after the handoff, verify with a batched freshness delta and narrow checks — do not re-read full evidence the child already summarized (see the subagent-orchestration skill).",
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

			const task = params.task.trim();
			// The run's working directory: the subagent `cwd` parameter when given (relative
			// paths resolve against the parent's cwd), else the parent's cwd. Read-only runs
			// snapshot this directory as their clone source; write-capable runs are spawned
			// here — so a task targeting a different worktree gets a reviewer clone that
			// actually contains that directory's uncommitted changes.
			const runCwd = resolveRunCwd(params.cwd, ctx.cwd);
			const run = launchRun(agent, task, background, ctx, background ? undefined : onUpdate);

			// Foreground: wire the tool's abort signal BEFORE preparation starts, so an
			// abort during clone preparation terminates it and settles the run as stopped.
			// Background runs never wire the signal: the tool call ending must not stop them.
			const abort = () => stopRun(run, "parent tool aborted");
			if (!background) {
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			}
			// Background still returns only after preparation completes and the child is
			// spawned (prep is async now, but the tool call waits for it, as before).
			await startRun(run, task, ctx, runCwd);

			if (background) {
				// A preparation failure (or a stop during preparation) settles the run
				// without spawning: surface the bounded handoff, never a Started result.
				// Suppression stays on in that case, so finishRun's handoffBackground is a
				// no-op and the throw below is the single delivery.
				if (!isActive(run)) throw new Error(runHandoff(run));
				// The child is genuinely up now: lift the launch-time suppression so its later
				// completion (success or failure) steers back normally via handoffBackground.
				run.suppressHandoff = false;
				return {
					content: [{ type: "text", text: `Started ${run.id} in the background (read-only). Its final result will be steered back before your next turn.` }],
					details: { run: viewOf(run) },
				};
			}

			await run.done.finally(() => signal?.removeEventListener("abort", abort));
			if (run.status !== "completed") throw new Error(runHandoff(run));
			return {
				content: [{ type: "text", text: runHandoff(run) }],
				details: { run: viewOf(run) },
			};
		},

		renderCall(args, theme) {
			const mode = args.background ? "background" : "foreground";
			const model = discoverAgents(agentDefinitionsDir).find((agent) => agent.name === args.agent)?.model;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent)} ${theme.fg("muted", mode)}${model ? theme.fg("dim", ` · ${model}`) : ""}\n  ${theme.fg("dim", args.task)}`,
				0,
				0,
			);
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
			const cost = formatCost(run.cost);
			let text = `${theme.fg(color, statusIcon(run.status))} ${theme.fg("toolTitle", run.id)} ${theme.fg("muted", run.status)} ${theme.fg("dim", elapsed)}${cost ? theme.fg("dim", ` · ${cost}`) : ""}`;
			if (run.model) text += ` ${theme.fg("dim", `· ${run.model}`)}`;
			if (run.currentTool) text += `\n${theme.fg("dim", `  ${run.currentTool}`)}`;
			if (expanded && run.lastOutput) text += `\n\n${theme.fg("toolOutput", run.lastOutput)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("subagents", {
		description: "Expand the subagent rail (grouped run list; Enter opens detail)",
		handler: async (_args, ctx) => openRail(ctx),
	});
	pi.registerShortcut("super+s", {
		description: "Expand the subagent rail",
		handler: async (ctx) => openRail(ctx),
	});
	// alt+s works on Linux/Windows; on macOS Option+S types "ß" in the editor, so super+s is the primary binding.
	pi.registerShortcut("alt+s", {
		description: "Expand the subagent rail",
		handler: async (ctx) => openRail(ctx),
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

		// One startup stale-run sweep per session start: reclaim dedicated read-only
		// run dirs left by crashes/kill -9 or previous failed cleanups. Never blocks
		// loading or the session; failures surface as a UI warning plus a local log
		// line only. Successful cleanups stay silent (log line only).
		try {
			const swept = sweepReadonlyRuns(activeOwnerTokens());
			if (swept.errors > 0) {
				console.error(`wabi: readonly-run sweep recorded ${swept.errors} error(s); removed ${swept.removed} stale run dir(s)`);
				ctx.ui.notify?.("wabi: stale read-only run cleanup had errors; see logs", "warning");
			} else if (swept.removed > 0) {
				console.log(`wabi: startup sweep removed ${swept.removed} stale read-only run dir(s)`);
			}
		} catch (error) {
			console.error(`wabi: readonly-run sweep failed: ${String(error)}`);
			ctx.ui.notify?.("wabi: stale read-only run cleanup failed; see logs", "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// First thing: this instance's runs are about to stop, so its token must stop
		// protecting them. A replaced instance's leftover run dirs are then reclaimable
		// by the next session_start sweep (same pid, token no longer registered), and a
		// throwing handler below cannot leave a stale token registered.
		activeOwnerTokens().delete(instanceToken);
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
			// (finishRun already removed each run's temp dir best-effort; the duplicate shutdown rm was dropped.)
			finishUnresolvedRuns(active, (run) => finishRun(run, null, "SIGKILL"));
		}
		if (headerTimer) clearInterval(headerTimer);
		headerTimer = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		runs.clear();
		history.clear();
		runsDir = undefined;
		latestCtx = undefined;
	});
}
