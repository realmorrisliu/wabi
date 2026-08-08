// wabi subagents — tmux-visible subagent orchestration for pi.
// Spawns one `pi --mode json` instance per task inside a detached tmux session
// (`wabi-sub`) so runs are fully observable and interruptible. Results are
// captured from stdout JSONL and returned as structured text.

import { ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	AgentConfig,
	discoverAgents,
	lastAssistantText,
	replacePrevious,
	buildTmuxCommand,
	ParsedResult,
} from "./lib.ts";

const SESSION = "wabi-sub";
const RECURSION_ENV = "WABI_SUBAGENT";

interface RunResult extends ParsedResult {
	agent: string;
	task: string;
	error?: string;
}

// --- tmux helpers -----------------------------------------------------------

function hasTmux(): boolean {
	const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
	return r.status === 0;
}

function ensureSession(firstWindow: string, firstCommand: string, cwd: string): void {
	const check = spawnSync("tmux", ["has-session", "-t", SESSION], { stdio: "ignore" });
	if (check.status === 0) return;
	spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-n", firstWindow, "-c", cwd, firstCommand]);
}

function newWindow(name: string, command: string, cwd: string): void {
	spawnSync("tmux", ["new-window", "-t", SESSION, "-n", name, "-c", cwd, command]);
}

/** Wait until the pane is dead (command exited) or the window/session is gone. */
async function waitPaneDead(windowName: string, signal?: AbortSignal): Promise<void> {
	while (true) {
		if (signal?.aborted) throw new Error("aborted");
		const out = spawnSync("tmux", ["list-panes", "-t", `${SESSION}:${windowName}`, "-F", "#{pane_dead}"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const dead = out.stdout?.toString().trim();
		if (out.status !== 0 || dead === "1") return; // window gone (user closed) or command finished
		await new Promise((r) => setTimeout(r, 400));
	}
}

function killSession(): void {
	spawnSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
}

// --- single agent run -------------------------------------------------------

async function runAgent(
	agent: AgentConfig,
	task: string,
	step: number,
	cwd: string,
	modelOverride: string | undefined,
	thinkingOverride: string | undefined,
	signal: AbortSignal | undefined,
	openWindow: (name: string, command: string) => void,
): Promise<RunResult> {
	const tmp = mkdtempSync(join(tmpdir(), "wabi-"));
	const promptFile = join(tmp, "prompt.md");
	const outFile = join(tmp, "out.jsonl");
	writeFileSync(promptFile, agent.systemPrompt, "utf-8");

	const args = ["--mode", "json", "-p", "--no-session"];
	if (modelOverride) args.push("--model", modelOverride);
	else if (agent.model) args.push("--model", agent.model);
	if (thinkingOverride) args.push("--thinking", thinkingOverride);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	args.push("--append-system-prompt", promptFile, `Task: ${task}`);

	const windowName = `${agent.name}-${step}`;
	const command = buildTmuxCommand({ command: ["pi", ...args], outFile, env: { [RECURSION_ENV]: "1" } });

	try {
		openWindow(windowName, command);
		await waitPaneDead(windowName, signal);
		const result = lastAssistantText(readFileSync(outFile, "utf-8"));
		return { ...result, agent: agent.name, task };
	} catch (e) {
		return { text: "", agent: agent.name, task, error: String(e) };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// --- tool registration ------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for sequential execution; {previous} in task is replaced with the prior step's output" })),
	model: Type.Optional(Type.String({ description: "Override the agent's configured model (e.g. deepseek-v4-pro or provider/model:thinking)" })),
	thinking: Type.Optional(Type.String({ description: "Override thinking level: off, minimal, low, medium, high, xhigh, max" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (default: current project)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent (wabi)",
		description: [
			"Delegate tasks to specialized subagents with isolated context, each running as a visible pi instance in a detached tmux session (wabi-sub).",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Agents are discovered from ${join(getAgentDir(), "agents")} (*.md with name/description/tools/model frontmatter).`,
			"Watch or interact with any run via: tmux attach -t wabi-sub",
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal) {
			const agents = discoverAgents(join(getAgentDir(), "agents"));
			const cwd = params.cwd ?? process.cwd();

			if (process.env[RECURSION_ENV]) {
				return {
					content: [{ type: "text", text: "Recursion blocked: subagents cannot spawn subagents." }],
				};
			}
			if (!hasTmux()) {
				return {
					content: [{ type: "text", text: "tmux is required (install it and retry): brew install tmux" }],
				};
			}

			const findAgent = (name: string) => agents.find((a) => a.name === name);
			const modes = [params.agent && params.task ? "single" : null, params.tasks ? "parallel" : null, params.chain ? "chain" : null].filter(Boolean);
			if (modes.length !== 1) {
				const available = agents.map((a) => `"${a.name}" (${a.description})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Provide exactly one mode. Available agents: ${available}` }],
				};
			}

			const run = async (agentName: string, task: string, step: number) => {
				const agent = findAgent(agentName);
				if (!agent) {
					return { text: "", agent: agentName, task, error: `Unknown agent "${agentName}". Available: ${agents.map((a) => a.name).join(", ")}` };
				}
				return runAgent(agent, task, step, cwd, params.model, params.thinking, signal, openWindow);
			};

			let sessionCreated = false;
			const openWindow = (name: string, command: string) => {
				if (!sessionCreated) {
					ensureSession(name, command, cwd);
					sessionCreated = true;
				} else {
					newWindow(name, command, cwd);
				}
			};

			const results: RunResult[] = [];
			try {
				if (params.agent) {
					results.push(await run(params.agent, params.task ?? "", 1));
				} else if (params.tasks) {
					// Launch all windows first so they run in parallel, then wait for each.
					const steps = params.tasks.map((t, i) => run(t.agent, t.task, i + 1));
					results.push(...(await Promise.all(steps)));
				} else if (params.chain) {
					let previous: string | undefined;
					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const task = replacePrevious(step.task, previous);
						const r = await run(step.agent, task, i + 1);
						results.push(r);
						if (r.error) break;
						previous = r.text;
					}
				}
			} finally {
				killSession();
			}

			const text = results
				.map((r, i) => {
					const usage = r.usage ? ` [${r.usage.input ?? 0}↑/${r.usage.output ?? 0}↓ ${r.usage.cost != null ? `$${Number(r.usage.cost).toFixed(4)}` : ""}]` : "";
					const head = `## ${r.agent}${r.model ? ` (${r.model})` : ""}${usage}`;
					const body = r.error ? `ERROR: ${r.error}` : r.text.trim() || "(no text output)";
					return `${head}\n\n${body}`;
				})
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text }],
				details: { mode: params.agent ? "single" : params.tasks ? "parallel" : "chain", results },
			};
		},
	});
}
