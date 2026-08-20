import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

export type AgentKind = "pi" | "claude" | "codex" | "kimi" | "grok";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type AuthStatus = "ok" | "configured" | "missing" | "unknown";

export interface AgentProfile {
	tags: string[];
	priority: number;
	quotaPool: string;
}

export interface QuotaWindow {
	usedPercentage?: number;
	remainingPercentage?: number;
	observedPercentage?: number;
	percentageBasis?: "used" | "remaining" | "unknown";
	resetAt?: string;
	resetText?: string;
}

export interface QuotaSnapshot {
	source: "screen-parsed" | "statusline" | "dashboard" | "cache";
	confidence: "structured" | "screen-parsed" | "unknown";
	checkedAt: string;
	windows: Record<string, QuotaWindow>;
	evidence?: string[];
	stale?: boolean;
}

export interface LiveAgent {
	agent: string;
	agent_status: AgentStatus;
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	cwd?: string;
}

export interface IntegrationInfo {
	status: "current" | "not-installed" | "unknown";
	version?: number;
	authority: "lifecycle" | "screen" | "none" | "unknown";
}

export interface AgentRecord {
	kind: AgentKind;
	enabled: boolean;
	executable: string;
	path?: string;
	version?: string;
	installed: boolean;
	auth: { status: AuthStatus; method?: string; plan?: string; detail?: string };
	integration: IntegrationInfo;
	live: LiveAgent[];
	quota?: QuotaSnapshot;
	profile: AgentProfile;
}

export interface RouteRecommendation {
	kind: AgentKind;
	score: number;
	eligible: boolean;
	conditional: boolean;
	reasons: string[];
	matchedTags: string[];
}

export interface RouterConfig {
	enabledAgents?: AgentKind[];
	minRemainingPercentage?: number;
	cacheTtlMs?: number;
	profiles?: Partial<Record<AgentKind, Partial<AgentProfile>>>;
}

export const DEFAULT_PROFILES: Record<AgentKind, AgentProfile> = {
	pi: {
		tags: ["orchestration", "synthesis", "planning", "coding", "review"],
		priority: 6,
		quotaPool: "pi",
	},
	claude: {
		tags: ["architecture", "refactor", "tests", "review", "debugging"],
		priority: 5,
		quotaPool: "anthropic-subscription",
	},
	codex: {
		tags: ["implementation", "coding", "architecture", "review", "tests", "refactor"],
		priority: 5,
		quotaPool: "openai-codex",
	},
	kimi: {
		tags: ["chinese", "documentation", "long-context", "research", "ui"],
		priority: 4,
		quotaPool: "kimi-membership",
	},
	grok: {
		tags: ["web-research", "ui", "prototype", "exploration"],
		priority: 4,
		quotaPool: "xai-grok",
	},
};

export const EXECUTABLES: Record<AgentKind, string> = {
	pi: "pi",
	claude: "claude",
	codex: "codex",
	kimi: "kimi",
	grok: "grok",
};

export const STATE_AUTHORITY: Record<AgentKind, IntegrationInfo["authority"]> = {
	pi: "lifecycle",
	claude: "screen",
	codex: "screen",
	kimi: "lifecycle",
	grok: "screen",
};

export const DEFAULT_MIN_REMAINING = 15;

export function profileFor(kind: AgentKind, config: RouterConfig): AgentProfile {
	const override = config.profiles?.[kind] ?? {};
	const defaultPool = kind === "pi" && process.env.PI_PROVIDER === "openai-codex"
		? "openai-codex"
		: DEFAULT_PROFILES[kind].quotaPool;
	return {
		...DEFAULT_PROFILES[kind],
		...override,
		quotaPool: override.quotaPool ?? defaultPool,
		tags: override.tags ?? DEFAULT_PROFILES[kind].tags,
	};
}

export function findExecutable(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
	if (name.includes("/")) {
		try {
			accessSync(name, fsConstants.X_OK);
			return name;
		} catch {
			return undefined;
		}
	}

	for (const directory of pathValue.split(":").filter(Boolean)) {
		const candidate = join(directory, name);
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Keep scanning PATH.
		}
	}
	return undefined;
}

export function stripAnsi(text: string): string {
	return text
		.replace(/[\u001b\u009b]\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r/g, "");
}

export function parseIntegrationStatus(text: string): Record<string, IntegrationInfo> {
	const result: Record<string, IntegrationInfo> = {};
	for (const line of stripAnsi(text).split("\n")) {
		const match = line.trim().match(/^([a-z0-9_-]+):\s+(current|not installed)(?:\s+\(v(\d+)\))?/i);
		if (!match) continue;
		const kind = match[1].toLowerCase();
		const authority = (STATE_AUTHORITY as Record<string, IntegrationInfo["authority"]>)[kind] ?? "unknown";
		result[kind] = {
			status: match[2].toLowerCase() === "current" ? "current" : "not-installed",
			version: match[3] ? Number(match[3]) : undefined,
			authority,
		};
	}
	return result;
}

function parsePercent(line: string): number | undefined {
	const match = line.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%/);
	if (!match) return undefined;
	const value = Number(match[1]);
	return value >= 0 && value <= 100 ? value : undefined;
}

function windowKey(line: string): string | undefined {
	if (/(5\s*[- ]?hour|5h|five\s*[- ]?hour)/i.test(line)) return "five_hour";
	if (/(7\s*[- ]?day|seven\s*[- ]?day|weekly|week)/i.test(line)) return "seven_day";
	if (/(monthly|month)/i.test(line)) return "monthly";
	return undefined;
}

function resetValue(line: string): { resetAt?: string; resetText?: string } {
	const iso = line.match(/\b\d{4}-\d{2}-\d{2}T[^\s,)]+/);
	if (iso) return { resetAt: iso[0] };
	const relative = line.match(/(?:reset|resets|刷新|重置)[^\n:]*[:：]?\s*(.+)$/i);
	return relative ? { resetText: relative[1].trim().slice(0, 120) } : {};
}

export function parseQuotaText(_agent: AgentKind, raw: string, checkedAt = new Date().toISOString()): QuotaSnapshot {
	const text = stripAnsi(raw);
	const windows: Record<string, QuotaWindow> = {};
	const evidence: string[] = [];

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim().replace(/\s+/g, " ");
		if (!line || !/(quota|usage|limit|remaining|available|used|consumed|weekly|5h|hour|reset|刷新|重置|credit)/i.test(line)) continue;

		const key = windowKey(line);
		const percentage = parsePercent(line);
		if (key && percentage !== undefined) {
			const entry = windows[key] ?? {};
			if (/remaining|left|available|剩余/i.test(line)) {
				entry.remainingPercentage = percentage;
				entry.usedPercentage = 100 - percentage;
				entry.percentageBasis = "remaining";
			} else if (/used|consumed|spent|已用|使用/i.test(line)) {
				entry.usedPercentage = percentage;
				entry.remainingPercentage = 100 - percentage;
				entry.percentageBasis = "used";
			} else {
				entry.observedPercentage = percentage;
				entry.percentageBasis = "unknown";
			}
			Object.assign(entry, resetValue(line));
			windows[key] = entry;
			evidence.push(line.slice(0, 200));
			continue;
		}

		if (key) {
			const entry = windows[key] ?? {};
			Object.assign(entry, resetValue(line));
			windows[key] = entry;
			evidence.push(line.slice(0, 200));
		}
	}

	return {
		source: "screen-parsed",
		confidence: Object.keys(windows).length > 0 ? "screen-parsed" : "unknown",
		checkedAt,
		windows,
		evidence: evidence.slice(-8),
	};
}

export function inferTags(task: string): string[] {
	const rules: Array<[string, RegExp]> = [
		["architecture", /架构|方案设计|architecture|design/i],
		["refactor", /重构|refactor/i],
		["tests", /测试|test|coverage/i],
		["review", /审查|评审|review/i],
		["debugging", /诊断|调试|debug|bug|报错/i],
		["implementation", /实现|开发|编写|implementation/i],
		["chinese", /中文|汉语|chinese/i],
		["documentation", /文档|documentation|readme/i],
		["long-context", /长上下文|long.?context/i],
		["web-research", /网页|联网|调研|research|web|搜索/i],
		["ui", /界面|前端|UI|frontend/i],
		["prototype", /原型|prototype|demo/i],
	];
	const tags = rules.filter(([, pattern]) => pattern.test(task)).map(([tag]) => tag);
	return tags.length > 0 ? tags : ["coding"];
}

function quotaState(quota: QuotaSnapshot | undefined, minRemaining: number): "sufficient" | "low" | "exhausted" | "unknown" {
	if (!quota || quota.stale) return "unknown";
	const windows = Object.values(quota.windows).filter((window) => window.remainingPercentage !== undefined);
	if (windows.length === 0) return "unknown";
	if (windows.some((window) => (window.remainingPercentage ?? 0) <= 0)) return "exhausted";
	if (windows.some((window) => (window.remainingPercentage ?? 0) < minRemaining)) return "low";
	return "sufficient";
}

export function routeAgents(
	inventory: AgentRecord[],
	task: string,
	explicitTags: string[] = [],
	minRemaining = DEFAULT_MIN_REMAINING,
): RouteRecommendation[] {
	const tags = [...new Set([...inferTags(task), ...explicitTags.map((tag) => tag.toLowerCase())])];
	const busyPools = new Set(
		inventory.flatMap((agent) => agent.live.some((live) => live.agent_status === "working") ? [agent.profile.quotaPool] : []),
	);
	return inventory
		.map((agent) => {
			const reasons: string[] = [];
			const matchedTags = tags.filter((tag) => agent.profile.tags.includes(tag));
			let score = agent.profile.priority + matchedTags.length * 10;
			let eligible = true;
			let conditional = false;

			if (!agent.enabled) {
				eligible = false;
				score -= 100;
				reasons.push("disabled by configuration");
			}
			if (!agent.installed) {
				eligible = false;
				reasons.push("not installed");
			}
			if (agent.auth.status === "missing") {
				eligible = false;
				reasons.push("not authenticated");
			} else if (agent.auth.status === "unknown") {
				conditional = true;
				score -= 8;
				reasons.push("auth unknown");
			}
			if (agent.live.some((live) => live.agent_status === "blocked")) {
				conditional = true;
				score -= 6;
				reasons.push("a live pane is blocked");
			}
			if (agent.live.some((live) => live.agent_status === "working")) {
				score -= 3;
				reasons.push("already working");
			}
			if (busyPools.has(agent.profile.quotaPool)) {
				score -= 2;
				reasons.push(`shared quota pool busy (${agent.profile.quotaPool})`);
			}
			const quota = quotaState(agent.quota, minRemaining);
			if (quota === "exhausted" || quota === "low") {
				eligible = false;
				score -= 100;
				reasons.push(`quota ${quota}`);
			} else if (quota === "unknown") {
				conditional = true;
				score -= 4;
				reasons.push("quota unknown");
			} else {
				reasons.push("quota sufficient");
				score += 4;
			}
			if (agent.live.length === 0) reasons.push("will need a Herdr pane");
			if (matchedTags.length === 0) score -= 2;

			return { kind: agent.kind, score, eligible, conditional, reasons, matchedTags };
		})
		.sort((a, b) => b.score - a.score);
}
