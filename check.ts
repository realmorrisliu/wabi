// check.ts — self-check for wabi's pure logic. Run: bun check.ts

import { readFileSync } from "node:fs";
import {
	AgentConfig,
	buildTmuxCommand,
	discoverAgents,
	lastAssistantText,
	parseFrontmatter,
	replacePrevious,
	shellQuote,
} from "./extensions/subagents/lib.ts";

let failures = 0;
function check(name: string, cond: boolean) {
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

// --- lastAssistantText: parses pi --mode json JSONL, returns final assistant text ---
const jsonl = [
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], model: "deepseek-v4-flash" } }),
	JSON.stringify({ type: "toolCall", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }),
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }, { type: "text", text: " answer" }], model: "qwen3.8-max", usage: { input: 10, output: 20, cost: { total: 0.001 } } } }),
	JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "the real final" }], model: "qwen3.8-max", usage: { input: 10, output: 20, cost: { total: 0.002 } } } }),
].join("\n");
const r = lastAssistantText(jsonl);
check("lastAssistantText: takes the final text event (message_end/turn_end), not delta/toolcall events", r.text === "the real final");
check("lastAssistantText: captures model", r.model === "qwen3.8-max");
check("lastAssistantText: captures usage cost of the final event", r.usage?.cost === 0.002);
check("lastAssistantText: empty input", lastAssistantText("").text === "");

// --- replacePrevious ---
check("replacePrevious: substitutes all placeholders", replacePrevious("do A {previous} then {previous}", "X") === "do A X then X");
check("replacePrevious: no placeholder passes through", replacePrevious("plain", "X") === "plain");
check("replacePrevious: missing previous becomes empty", replacePrevious("a {previous} b", undefined) === "a  b");

// --- shellQuote ---
check("shellQuote: wraps in single quotes", shellQuote("hello") === "'hello'");
check("shellQuote: escapes embedded quotes", shellQuote("it's a 'test'") === `'it'\\''s a '\\''test'\\'''`);

// --- buildTmuxCommand ---
const cmd = buildTmuxCommand({
	command: ["pi", "--mode", "json", "-p", `Task: it's complex`],
	outFile: "/tmp/out file.jsonl",
	env: { WABI_SUBAGENT: "1" },
});
check("buildTmuxCommand: env prefix + quoted argv + redirect", cmd === `WABI_SUBAGENT='1' 'pi' '--mode' 'json' '-p' 'Task: it'\\''s complex' > '/tmp/out file.jsonl' 2>&1`);

// --- parseFrontmatter / discoverAgents ---
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
const names = agents.map((a) => a.name).sort();
check("discoverAgents: finds the 3 real agents", names.join(",") === "planner,reviewer,scout");
check("discoverAgents: scout has cheap model + tools", agents.find((a: AgentConfig) => a.name === "scout")?.model === "deepseek-v4-flash");
check("discoverAgents: planner/reviewer use strong model", agents.every((a: AgentConfig) => a.name === "scout" || a.model === "qwen3.8-max"));

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
