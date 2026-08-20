import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	DEFAULT_MIN_REMAINING,
	DEFAULT_PROFILES,
	EXECUTABLES,
	STATE_AUTHORITY,
	findExecutable,
	inferTags,
	parseIntegrationStatus,
	parseQuotaText,
	profileFor,
	routeAgents,
	stripAnsi,
	type AgentKind,
	type AgentRecord,
	type AgentStatus,
	type IntegrationInfo,
	type Inventory,
	type LiveAgent,
	type QuotaSnapshot,
	type RouterConfig,
	type RouteRecommendation,
} from "./agent-router-core.ts";

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const ALL_AGENTS = Object.keys(EXECUTABLES) as AgentKind[];
const PROBE_COMMAND: Record<AgentKind, string> = {
	pi: "/status",
	claude: "/usage",
	codex: "/status",
	kimi: "/usage",
	grok: "/usage",
};

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

function configPath(): string {
	return process.env.PI_AGENT_ROUTER_CONFIG ??
		join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "agent-router.json");
}

function statePath(): string {
	return join(dirname(configPath()), "agent-router-state.json");
}

function loadConfig(): RouterConfig {
	try {
		return JSON.parse(readFileSync(configPath(), "utf8")) as RouterConfig;
	} catch {
		return {};
	}
}

function enabledAgents(config: RouterConfig): Set<AgentKind> {
	return new Set(config.enabledAgents ?? ALL_AGENTS);
}

function saveConfig(config: RouterConfig): void {
	const file = configPath();
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(config, null, "\t") + "\n");
	renameSync(temp, file);
}

async function runCommand(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	signal?: AbortSignal,
	timeout = 8_000,
): Promise<CommandResult> {
	try {
		const result = await pi.exec(command, args, { signal, timeout });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.code ?? -1,
		};
	} catch (error) {
		return { stdout: "", stderr: String(error), code: -1 };
	}
}

function jsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return value === "idle" || value === "working" || value === "blocked" || value === "done" || value === "unknown";
}

function parseLiveAgents(text: string): LiveAgent[] {
	const data = jsonObject(text);
	const result = data?.result;
	if (!result || typeof result !== "object") return [];
	const agents = (result as { agents?: unknown }).agents;
	if (!Array.isArray(agents)) return [];
	return agents.flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const item = value as Record<string, unknown>;
		if (typeof item.agent !== "string" || typeof item.pane_id !== "string") return [];
		const session = item.agent_session && typeof item.agent_session === "object"
			? item.agent_session as Record<string, unknown>
			: undefined;
		const kind = typeof session?.agent === "string" ? session.agent : item.agent;
		return [{
			agent: kind,
			agent_status: isAgentStatus(item.agent_status) ? item.agent_status : "unknown",
			pane_id: item.pane_id,
			workspace_id: typeof item.workspace_id === "string" ? item.workspace_id : undefined,
			tab_id: typeof item.tab_id === "string" ? item.tab_id : undefined,
			cwd: typeof item.cwd === "string" ? item.cwd : undefined,
		}];
	});
}

function authFor(
	kind: AgentKind,
	output: CommandResult,
	live: LiveAgent[],
): AgentRecord["auth"] {
	const text = `${output.stdout}\n${output.stderr}`;
	if (kind === "pi") {
		return process.env.PI_PROVIDER
			? { status: "ok", method: process.env.PI_PROVIDER }
			: { status: "unknown", detail: "No active Pi provider in the current process" };
	}

	if (kind === "codex") {
		if (/logged in using/i.test(text) || /auth is configured/i.test(text)) {
			return { status: "ok", method: /chatgpt/i.test(text) ? "ChatGPT" : "configured" };
		}
		if (/not logged in|no authentication|not authenticated/i.test(text)) {
			return { status: "missing", detail: text.trim().slice(0, 160) };
		}
		return { status: "unknown", detail: output.code === 0 ? "Status output was not recognized" : "codex login status failed" };
	}

	if (kind === "claude") {
		const data = jsonObject(output.stdout);
		if (data?.loggedIn === true) {
			return {
				status: "ok",
				method: typeof data.authMethod === "string" ? data.authMethod : undefined,
				plan: typeof data.subscriptionType === "string" ? data.subscriptionType : undefined,
			};
		}
		if (data?.loggedIn === false) return { status: "missing" };
		return { status: "unknown", detail: output.code === 0 ? "Auth output was not recognized" : "claude auth status failed" };
	}

	if (kind === "kimi") {
		if (/source=oauth|managed:kimi-code/i.test(text)) {
			return { status: "configured", method: "OAuth" };
		}
		if (/no provider|not logged|unauth/i.test(text)) return { status: "missing" };
		return { status: output.code === 0 ? "configured" : "unknown", detail: "Provider configuration found; live quota not checked" };
	}

	// Grok's CLI currently exposes no read-only auth-status command.
	if (kind === "grok") {
		if (live.length > 0) return { status: "ok", method: "live Grok session" };
		return { status: "unknown", detail: "No stable read-only auth-status command is exposed by grok" };
	}

	return { status: "unknown" };
}

function parseVersion(text: string): string | undefined {
	const first = stripAnsi(text).trim().split("\n")[0];
	return first ? first.slice(0, 80) : undefined;
}

function readQuotaCache(ttlMs: number): Partial<Record<AgentKind, QuotaSnapshot>> {
	try {
		const value = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, QuotaSnapshot>;
		const now = Date.now();
		return Object.fromEntries(
			(Object.entries(value) as Array<[AgentKind, QuotaSnapshot]>)
				.filter(([, quota]) => quota && now - Date.parse(quota.checkedAt) <= ttlMs)
				.map(([kind, quota]) => [kind, { ...quota, source: "cache", stale: false }]),
		) as Partial<Record<AgentKind, QuotaSnapshot>>;
	} catch {
		return {};
	}
}

function saveQuota(kind: AgentKind, quota: QuotaSnapshot): void {
	const file = statePath();
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	let current: Record<string, QuotaSnapshot> = {};
	try {
		current = JSON.parse(readFileSync(file, "utf8")) as Record<string, QuotaSnapshot>;
	} catch {
		// Start a new cache.
	}
	current[kind] = { ...quota, source: quota.source === "statusline" ? "statusline" : "screen-parsed" };
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(current, null, "\t") + "\n");
	renameSync(temp, file);
}

async function collectInventory(pi: ExtensionAPI, signal?: AbortSignal): Promise<Inventory> {
	const checkedAt = new Date().toISOString();
	const herdrBinary = findExecutable("herdr");
	const herdrPath = process.env.HERDR_ENV === "1" ? herdrBinary : undefined;
	let live: LiveAgent[] = [];
	let integrations: Record<string, IntegrationInfo> = {};
	let herdrError: string | undefined;

	if (herdrPath) {
		const [agentList, integrationStatus] = await Promise.all([
			runCommand(pi, herdrPath, ["agent", "list"], signal),
			runCommand(pi, herdrPath, ["integration", "status"], signal),
		]);
		live = parseLiveAgents(agentList.stdout);
		integrations = parseIntegrationStatus(integrationStatus.stdout);
		if (agentList.code !== 0 && integrationStatus.code !== 0) herdrError = "Herdr is not reachable";
	} else {
		herdrError = herdrBinary ? "not running inside Herdr (HERDR_ENV!=1)" : "herdr is not on PATH";
	}

	const config = loadConfig();
	const enabled = enabledAgents(config);
	const cachedQuota = readQuotaCache(config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
	const agents = await Promise.all(ALL_AGENTS.map(async (kind) => {
		const executable = EXECUTABLES[kind];
		const path = findExecutable(executable);
		const liveForAgent = live.filter((item) => item.agent.toLowerCase() === kind);
		if (!path) {
			return {
				kind,
				enabled: enabled.has(kind),
				executable,
				installed: false,
				auth: { status: "missing" as const },
				integration: integrations[kind] ?? { status: "unknown" as const, authority: STATE_AUTHORITY[kind] },
				live: liveForAgent,
				profile: profileFor(kind, config),
			};
		}

		const versionPromise = runCommand(pi, path, ["--version"], signal, 5_000);
		const authPromise = kind === "codex"
			? runCommand(pi, path, ["login", "status"], signal, 8_000)
			: kind === "claude"
				? runCommand(pi, path, ["auth", "status", "--json"], signal, 8_000)
				: kind === "kimi"
					? runCommand(pi, path, ["provider", "list"], signal, 8_000)
					: Promise.resolve({ stdout: "", stderr: "", code: 0 });
		const [version, authOutput] = await Promise.all([versionPromise, authPromise]);

		return {
			kind,
			enabled: enabled.has(kind),
			executable,
			path,
			version: parseVersion(version.stdout),
			installed: true,
			auth: authFor(kind, authOutput, liveForAgent),
			integration: integrations[kind] ?? { status: "unknown" as const, authority: STATE_AUTHORITY[kind] },
			live: liveForAgent,
			quota: cachedQuota[kind],
			profile: profileFor(kind, config),
		};
	}) as Promise<AgentRecord>);

	return { checkedAt, herdr: { path: herdrPath, error: herdrError }, agents };
}

function formatAuth(auth: AgentRecord["auth"]): string {
	const suffix = [auth.method, auth.plan].filter(Boolean).join("/");
	return `${auth.status}${suffix ? ` (${suffix})` : ""}`;
}

function formatInventory(inventory: Inventory): string {
	const lines = [`Agent inventory · ${inventory.checkedAt}`];
	for (const agent of inventory.agents) {
		const live = agent.live.length > 0
			? ` live=${agent.live.map((item) => `${item.pane_id}:${item.agent_status}`).join(",")}`
			: "";
		const integration = `${agent.integration.status}${agent.integration.version ? ` v${agent.integration.version}` : ""}`;
		lines.push(`- ${agent.kind}: ${agent.enabled ? "enabled" : "disabled"} · ${agent.installed ? "installed" : "missing"}${agent.version ? ` · ${agent.version}` : ""} · auth=${formatAuth(agent.auth)} · herdr=${integration}${live}`);
		if (agent.quota) lines.push(`  quota=${formatQuota(agent.quota)}`);
	}
	if (inventory.herdr.error) lines.push(`- herdr: ${inventory.herdr.error}`);
	return lines.join("\n");
}

function formatQuota(quota: QuotaSnapshot | undefined): string {
	if (!quota) return "unknown";
	const windows = Object.entries(quota.windows).map(([key, window]) => {
		const value = window.remainingPercentage !== undefined
			? `${window.remainingPercentage}% remaining`
			: window.usedPercentage !== undefined
				? `${window.usedPercentage}% used`
				: "seen";
		return `${key}=${value}`;
	});
	return `${windows.join(", ") || "unknown"} · ${quota.confidence} · ${quota.checkedAt}`;
}

function formatRoute(task: string, recommendations: RouteRecommendation[]): string {
	const lines = [`Route · tags=${inferTags(task).join(", ")}`];
	for (const [index, recommendation] of recommendations.entries()) {
		const state = !recommendation.eligible ? "blocked" : recommendation.conditional ? "conditional" : "preferred";
		lines.push(`${index + 1}. ${recommendation.kind} [${state}, ${recommendation.score}]${recommendation.matchedTags.length ? ` · match=${recommendation.matchedTags.join(",")}` : ""} · ${recommendation.reasons.join("; ")}`);
	}
	return lines.join("\n");
}

function formatProbe(kind: AgentKind, quota: QuotaSnapshot): string {
	const evidence = quota.evidence?.length ? `\nEvidence:\n${quota.evidence.map((line) => `- ${line}`).join("\n")}` : "";
	return `${kind} quota probe · ${formatQuota(quota)}${evidence}`;
}

function targetFor(kind: AgentKind, target: string | undefined, inventory: Inventory): LiveAgent {
	const candidates = inventory.agents.find((agent) => agent.kind === kind)?.live ?? [];
	if (target) {
		const found = candidates.find((item) => item.pane_id === target || item.agent === target);
		if (found) return found;
		throw new Error(`No ${kind} pane matches target ${target}`);
	}
	if (candidates.length !== 1) {
		if (candidates.length === 0) throw new Error(`No live ${kind} pane; quota probe only uses existing idle panes`);
		throw new Error(`Multiple ${kind} panes; pass a pane id`);
	}
	return candidates[0];
}

async function probe(
	pi: ExtensionAPI,
	kind: AgentKind,
	target: string | undefined,
	signal: AbortSignal | undefined,
): Promise<QuotaSnapshot> {
	const inventory = await collectInventory(pi, signal);
	if (!inventory.herdr.path) throw new Error(inventory.herdr.error ?? "Herdr is unavailable");
	const live = targetFor(kind, target, inventory);
	if (live.agent_status !== "idle" && live.agent_status !== "done") {
		throw new Error(`Refusing to probe ${kind} pane ${live.pane_id}: state is ${live.agent_status}; use an idle pane`);
	}

	const promptResult = await runCommand(
		pi,
		inventory.herdr.path,
		["agent", "prompt", live.pane_id, PROBE_COMMAND[kind], "--wait", "--timeout", "30000"],
		signal,
		35_000,
	);
	if (promptResult.code !== 0) throw new Error(promptResult.stderr || `Herdr probe failed for ${kind}`);

	const readResult = await runCommand(
		pi,
		inventory.herdr.path,
		["agent", "read", live.pane_id, "--source", "recent-unwrapped", "--lines", "160"],
		signal,
		10_000,
	);
	if (readResult.code !== 0) throw new Error(readResult.stderr || `Could not read ${kind} quota output`);
	const quota = parseQuotaText(kind, readResult.stdout);
	saveQuota(kind, quota);
	return quota;
}

const actionSchema = StringEnum(["inventory", "route", "probe"] as const);

export default function agentRouter(pi: ExtensionAPI) {
	async function show(text: string, ctx: ExtensionContext): Promise<void> {
		if (ctx.hasUI) ctx.ui.setWidget("agent-router", text.split("\n"));
		else console.log(text);
	}

	pi.registerTool({
		name: "agent_router",
		label: "Agent Router",
		description: "Inspect installed Herdr coding agents, suggest a quota-aware route, or explicitly probe an idle agent's documented status command. It never starts agents or dispatches code.",
		promptSnippet: "Inspect or route work across installed coding agents",
		promptGuidelines: [
			"Use agent_router before delegating work to an external coding agent.",
			"Use agent_router action=probe only when the user explicitly asks for a live quota check; it sends a status command to an idle Herdr pane.",
		],
		parameters: Type.Object({
			action: actionSchema,
			task: Type.Optional(Type.String({ description: "Task description used for routing" })),
			tags: Type.Optional(Type.Array(Type.String())),
			agent: Type.Optional(StringEnum(["pi", "claude", "codex", "kimi", "grok"] as const)),
			target: Type.Optional(Type.String({ description: "Herdr pane id for a quota probe" })),
		}),
		async execute(_toolCallId, params, signal) {
			if (params.action === "probe") {
				if (!params.agent) throw new Error("agent is required for a quota probe");
				return {
					content: [{ type: "text", text: formatProbe(params.agent, await probe(pi, params.agent, params.target, signal)) }],
					details: {},
				};
			}

			const inventory = await collectInventory(pi, signal);
			if (params.action === "route") {
				const task = params.task?.trim() || "coding task";
				const recommendations = routeAgents(
					inventory.agents,
					task,
					params.tags ?? [],
					loadConfig().minRemainingPercentage ?? DEFAULT_MIN_REMAINING,
				);
				return { content: [{ type: "text", text: formatRoute(task, recommendations) }], details: { inventory, recommendations } };
			}
			return { content: [{ type: "text", text: formatInventory(inventory) }], details: { inventory } };
		},
	});

	async function configureAgents(ctx: ExtensionContext): Promise<void> {
		const config = loadConfig();
		const current = enabledAgents(config);
		if (ctx.mode !== "tui") {
			await show(`Enabled: ${ALL_AGENTS.filter((kind) => current.has(kind)).join(", ") || "none"}`, ctx);
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const items: SettingItem[] = ALL_AGENTS.map((kind) => ({
				id: kind,
				label: `${kind} · ${DEFAULT_PROFILES[kind].tags.slice(0, 5).join(", ")}`,
				currentValue: current.has(kind) ? "☑ enabled" : "☐ disabled",
				values: ["☑ enabled", "☐ disabled"],
			}));
			const container = new Container();
			container.addChild({
				render: () => [theme.fg("accent", theme.bold("Agent Router · enabled agents")), ""],
				invalidate: () => {},
			});
			const settingsTheme = {
				label: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : text,
				value: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : theme.fg("dim", text),
				description: (text: string) => theme.fg("dim", text),
				cursor: theme.fg("accent", "❯ "),
				hint: (text: string) => theme.fg("dim", text),
			};
			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 12),
				settingsTheme,
				(id, value) => {
					if (value.startsWith("☑")) current.add(id as AgentKind);
					else current.delete(id as AgentKind);
					config.enabledAgents = ALL_AGENTS.filter((kind) => current.has(kind));
					saveConfig(config);
				},
				() => done(undefined),
			);
			container.addChild(settingsList);
			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("agents", {
		description: "Configure, inspect, route, and probe coding agents",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const operation = (parts.shift() ?? "configure").toLowerCase();

			if (operation === "configure" || operation === "settings") {
				await configureAgents(ctx);
				return;
			}
			if (operation === "clear") {
				ctx.ui.setWidget("agent-router", undefined);
				return;
			}
			if (operation === "status" || operation === "inventory") {
				await show(formatInventory(await collectInventory(pi)), ctx);
				return;
			}
			if (operation === "route") {
				const task = parts.join(" ") || "coding task";
				const inventory = await collectInventory(pi);
				await show(formatRoute(task, routeAgents(inventory.agents, task, [], loadConfig().minRemainingPercentage ?? DEFAULT_MIN_REMAINING)), ctx);
				return;
			}
			if (operation === "quota") {
				if (parts[0] === "clear") {
					ctx.ui.setWidget("agent-router", undefined);
					return;
				}
				if (parts[0] === "probe") {
					const kind = parts[1] as AgentKind | undefined;
					if (!kind || !(kind in PROBE_COMMAND)) {
						ctx.ui.notify("Usage: /agents quota probe <pi|claude|codex|kimi|grok> [pane-id]", "error");
						return;
					}
					try {
						await show(formatProbe(kind, await probe(pi, kind, parts[2], undefined)), ctx);
					} catch (error) {
						ctx.ui.notify(String(error), "error");
					}
					return;
				}
				const inventory = await collectInventory(pi);
				await show(inventory.agents.map((agent) => `${agent.kind}: ${formatQuota(agent.quota)}`).join("\n"), ctx);
				return;
			}
			if (operation === "list" || operation === "show") {
				const config = loadConfig();
				const current = enabledAgents(config);
				await show([
					`Enabled: ${ALL_AGENTS.filter((kind) => current.has(kind)).join(", ") || "none"}`,
					`Disabled: ${ALL_AGENTS.filter((kind) => !current.has(kind)).join(", ") || "none"}`,
					`Config: ${configPath()}`,
				].join("\n"), ctx);
				return;
			}
			if (operation === "reset" || operation === "enable" || operation === "disable" || operation === "set") {
				const config = loadConfig();
				const current = enabledAgents(config);
				if (operation === "reset") {
					delete config.enabledAgents;
					saveConfig(config);
					await show("Agent router reset: all agents enabled", ctx);
					return;
				}
				const requested = parts.flatMap((part) => part.split(",")).map((kind) => kind.toLowerCase());
				const invalid = requested.filter((kind) => !ALL_AGENTS.includes(kind as AgentKind));
				if (requested.length === 0 || invalid.length > 0) {
					ctx.ui.notify(`Agents: ${ALL_AGENTS.join(", ")}`, "error");
					return;
				}
				if (operation === "set") current.clear();
				for (const kind of requested as AgentKind[]) {
					if (operation === "disable") current.delete(kind);
					else current.add(kind);
				}
				config.enabledAgents = ALL_AGENTS.filter((kind) => current.has(kind));
				saveConfig(config);
				await show(`Agent router updated: ${config.enabledAgents.join(", ") || "none enabled"}`, ctx);
				return;
			}

			ctx.ui.notify("Usage: /agents [configure|status|route|quota|list|enable|disable|set|reset]", "error");
		},
	});
}
