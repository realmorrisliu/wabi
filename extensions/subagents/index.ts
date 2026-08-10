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
	JsonlDecoder,
	contentText,
	discoverAgents,
	formatDuration,
	isWriter,
	truncateUtf8,
} from "./lib.ts";

const MAX_CHILDREN = 4;
const HANDOFF_BYTES = 50 * 1024;
const STDERR_BYTES = 128 * 1024;
const COMPLETED_WIDGET_MS = 5_000;
const FORCE_KILL_MS = 5_000;
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
	errorMessage?: string;
	stderr: string;
	finalText: string;
	transcript: TranscriptEntry[];
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
		Type.Boolean({ description: "Return immediately and hand the final result back as a follow-up" }),
	),
});

function isActive(run: RunRecord): boolean {
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

function runError(run: RunRecord): string {
	return run.errorMessage || run.stderr.trim() || `child exited with status ${run.status}`;
}

export default function (pi: ExtensionAPI) {
	const runs = new Map<string, RunRecord>();
	let sequence = 0;
	let latestCtx: ExtensionContext | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let inspectorOpen = false;
	let shuttingDown = false;

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
		if (text) run.transcript.push({ kind, text, at: Date.now() });
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
		const output = truncateUtf8(success ? run.finalText || "(no text output)" : runError(run), HANDOFF_BYTES);
		pi.sendMessage(
			{
				customType: COMPLETION_TYPE,
				content: [
					`Background subagent handoff`,
					`run: ${run.id}`,
					`agent: ${run.agent.name}`,
					`status: ${run.status}`,
					"",
					output,
				].join("\n"),
				display: true,
				details: { run: viewOf(run), success } satisfies CompletionDetails,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	function finishRun(run: RunRecord, exitCode: number | null): void {
		if (run.finished) return;
		applyDecoded(run, run.decoder.flush());
		run.finished = true;
		run.endedAt = Date.now();
		if (run.liveToolResult) append(run, "tool-result", `${run.currentTool ?? "tool"} (partial)\n${run.liveToolResult}`);
		run.currentTool = undefined;
		run.liveToolResult = undefined;

		if (run.stopRequested) run.status = "stopped";
		else if (exitCode === 0 && run.lastStopReason !== "error" && run.lastStopReason !== "aborted" && !run.errorMessage) run.status = "completed";
		else run.status = "failed";

		if (run.status === "failed" && run.stderr.trim()) append(run, "system", run.stderr.trim());
		if (!run.finalText && run.errorMessage) run.finalText = run.errorMessage;
		run.widgetUntil = run.endedAt + COMPLETED_WIDGET_MS;
		if (run.updateTimer) clearTimeout(run.updateTimer);
		if (run.killTimer) clearTimeout(run.killTimer);
		if (run.tempDir) rmSync(run.tempDir, { recursive: true, force: true });
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
			id: `${agent.name}-${++sequence}`,
			agent,
			task,
			background,
			writer: isWriter(agent),
			status: "starting",
			startedAt: Date.now(),
			stderr: "",
			finalText: "",
			transcript: [],
			liveText: new Map(),
			liveThinking: new Map(),
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
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
		if (agent.systemPrompt.trim()) {
			run.tempDir = mkdtempSync(join(tmpdir(), "wabi-"));
			const promptFile = join(run.tempDir, "prompt.md");
			writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${task}`);

		try {
			const child = spawn("pi", args, {
				cwd: ctx.cwd,
				env: process.env,
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
				run.errorMessage = String(error);
				finishRun(run, 1);
			});
			child.on("close", (code) => finishRun(run, code));
		} catch (error) {
			run.errorMessage = String(error);
			finishRun(run, 1);
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

	function transcriptLines(run: RunRecord, width: number, showThinking: boolean, theme: any): string[] {
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
			for (const thinking of run.liveThinking.values()) if (thinking) add("think › ", thinking, "dim");
		}
		for (const text of run.liveText.values()) if (text) add("agent › ", text, "text");
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
				let selectedId = [...runs.keys()].at(-1);
				let scroll = 0;
				let showThinking = false;
				let confirmStop: string | undefined;

				const ordered = () => [...runs.values()];
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
						const lines = [theme.fg("accent", theme.bold(`Subagents · ${all.length}`))];
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
							const tool = run.currentTool ? ` · ${run.currentTool}` : "";
							lines.push(`${marker} ${theme.fg(color, statusIcon(run.status))} ${run.id} ${theme.fg("muted", run.status + tool)} ${theme.fg("dim", elapsed)}`);
						}
						lines.push(theme.fg("dim", "─".repeat(Math.max(1, width))), theme.fg("muted", `Task: ${current.task}`));

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
							if ((data === "y" || matchesKey(data, Key.enter)) && current?.id === confirmStop) stopRun(current, "stopped by user");
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
		return new Text(`${icon} ${theme.fg("muted", label)}${options.expanded ? " — full result delivered to the parent agent" : ""}`, options.outputPad, 0);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent (wabi)",
		description: "Delegate one task to a configured child agent. Foreground runs stream progress; background runs return immediately and hand their final answer back as a follow-up. Use multiple tool calls for parallel work. At most four children may run, and only one write-capable child may run at a time.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestCtx = ctx;
			const agents = discoverAgents(join(getAgentDir(), "agents"));
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) throw new Error(`Unknown agent "${params.agent}". Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");

			const active = [...runs.values()].filter(isActive);
			if (active.length >= MAX_CHILDREN) throw new Error(`At most ${MAX_CHILDREN} subagents may run concurrently.`);
			if (isWriter(agent)) {
				const writer = active.find((run) => run.writer);
				if (writer) throw new Error(`Write-capable subagent ${writer.id} is already running.`);
			}

			const background = params.background ?? false;
			if (background && ctx.mode !== "tui" && ctx.mode !== "rpc") {
				throw new Error("Background subagents require an interactive or RPC parent session.");
			}
			const run = launchRun(agent, params.task.trim(), background, ctx, background ? undefined : onUpdate);

			if (background) {
				return {
					content: [{ type: "text", text: `Started ${run.id} in the background. Its final answer will arrive as a follow-up.` }],
					details: { run: viewOf(run) },
				};
			}

			const abort = () => stopRun(run, "parent tool aborted");
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			await run.done.finally(() => signal?.removeEventListener("abort", abort));
			if (run.status !== "completed") throw new Error(`${run.id} ${run.status}: ${runError(run)}`);
			return {
				content: [{ type: "text", text: truncateUtf8(run.finalText || "(no text output)", HANDOFF_BYTES) }],
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
				if (run.tempDir) rmSync(run.tempDir, { recursive: true, force: true });
			}
		}
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		runs.clear();
		latestCtx = undefined;
	});
}
