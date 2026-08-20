import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_PROFILES,
	inferTags,
	parseIntegrationStatus,
	parseQuotaText,
	routeAgents,
	type AgentRecord,
} from "../extensions/agent-router-core.ts";

test("parses Herdr integration versions and install state", () => {
	const parsed = parseIntegrationStatus([
		"pi: current (v8) (/tmp/pi)",
		"claude: current (v8) (/tmp/claude)",
		"opencode: not installed (/tmp/opencode)",
	].join("\n"));

	assert.deepEqual(parsed.pi, { status: "current", version: 8, authority: "lifecycle" });
	assert.deepEqual(parsed.claude, { status: "current", version: 8, authority: "screen" });
	assert.equal(parsed.opencode.status, "not-installed");
	assert.equal(parsed.opencode.authority, "unknown");
});

test("parses quota percentages without trusting ANSI output", () => {
	const quota = parseQuotaText("claude", "\u001b[32m5-hour: 42% used\u001b[0m\nWeekly: 18% remaining");

	assert.equal(quota.windows.five_hour.usedPercentage, 42);
	assert.equal(quota.windows.five_hour.remainingPercentage, 58);
	assert.equal(quota.windows.seven_day.remainingPercentage, 18);
	assert.equal(quota.windows.seven_day.usedPercentage, 82);
});

test("infers routing tags from Chinese and English task text", () => {
	assert.deepEqual(inferTags("请做一次中文代码审查"), ["review", "chinese"]);
	assert.deepEqual(inferTags("Build a frontend prototype"), ["ui", "prototype"]);
});

test("default profiles share architecture and UI coverage", () => {
	assert.ok(DEFAULT_PROFILES.codex.tags.includes("architecture"));
	assert.ok(DEFAULT_PROFILES.kimi.tags.includes("ui"));
});

function agent(kind: AgentRecord["kind"], overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		kind,
		enabled: true,
		executable: kind,
		installed: true,
		auth: { status: "ok" },
		integration: { status: "current", authority: "screen" },
		live: [],
		profile: DEFAULT_PROFILES[kind],
		...overrides,
	};
}

test("disabled agents stay out of the route", () => {
	const recommendations = routeAgents([
		agent("grok", { enabled: false }),
	], "做一个网页原型");

	assert.equal(recommendations[0].kind, "grok");
	assert.equal(recommendations[0].eligible, false);
	assert.match(recommendations[0].reasons.join(" "), /disabled/);
});

test("routes by capability and excludes low quota", () => {
	const recommendations = routeAgents([
		agent("claude"),
		agent("codex", {
			quota: {
				source: "cache",
				confidence: "structured",
				checkedAt: new Date().toISOString(),
				windows: { five_hour: { remainingPercentage: 5 } },
			},
		}),
	], "重构认证模块并补测试");

	assert.equal(recommendations[0].kind, "claude");
	assert.equal(recommendations[1].kind, "codex");
	assert.equal(recommendations[1].eligible, false);
	assert.match(recommendations[1].reasons.join(" "), /quota low/);
});
