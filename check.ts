// check.ts — self-check for wabi's pure logic. Run: bun check.ts

import {
	type AgentConfig,
	JsonlDecoder,
	contentText,
	discoverAgents,
	formatDuration,
	isWriter,
	parseFrontmatter,
	truncateUtf8,
} from "./extensions/subagents/lib.ts";

let failures = 0;
function check(name: string, condition: boolean) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}`);
	}
}

// Incremental JSONL parsing survives arbitrary chunk boundaries.
const decoder = new JsonlDecoder();
let decoded = decoder.push('{"type":"one"}\n{"type":"two"');
check("JsonlDecoder: emits complete lines", decoded.events.length === 1 && decoded.events[0].type === "one");
decoded = decoder.push('}\nbroken\n{"type":"three"}');
check("JsonlDecoder: joins split lines", decoded.events.length === 1 && decoded.events[0].type === "two");
check("JsonlDecoder: reports malformed lines", decoded.errors.length === 1 && decoded.errors[0] === "broken");
decoded = decoder.flush();
check("JsonlDecoder: flushes final unterminated line", decoded.events.length === 1 && decoded.events[0].type === "three");
const unicodeDecoder = new JsonlDecoder();
const unicodeLine = Buffer.from('{"text":"你好"}\n');
const splitAt = unicodeLine.indexOf(Buffer.from("好")) + 1;
unicodeDecoder.push(unicodeLine.subarray(0, splitAt));
decoded = unicodeDecoder.push(unicodeLine.subarray(splitAt));
check("JsonlDecoder: preserves split UTF-8 characters", decoded.events[0]?.text === "你好");

const truncated = truncateUtf8("你".repeat(100), 100);
check("truncateUtf8: respects byte cap", Buffer.byteLength(truncated) <= 100);
check("truncateUtf8: does not split UTF-8", !truncated.includes("�"));
check("truncateUtf8: leaves short text unchanged", truncateUtf8("short", 100) === "short");

check("formatDuration: seconds", formatDuration(12_900) === "12s");
check("formatDuration: minutes", formatDuration(125_000) === "2m5s");
check("formatDuration: hours", formatDuration(7_260_000) === "2h1m");
check("contentText: extracts text blocks", contentText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]) === "a\nb");

const reader: AgentConfig = { name: "reader", description: "", tools: ["read", "bash"], systemPrompt: "" };
const writer: AgentConfig = { name: "writer", description: "", tools: ["read", "edit"], systemPrompt: "" };
const unrestricted: AgentConfig = { name: "all", description: "", systemPrompt: "" };
check("isWriter: read/bash agent is read-only by policy", !isWriter(reader));
check("isWriter: edit/write agent writes", isWriter(writer));
check("isWriter: unrestricted agent writes", isWriter(unrestricted));

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
const names = agents.map((agent) => agent.name).sort();
check("discoverAgents: finds the 3 real agents", names.join(",") === "creative-worker,reviewer,worker");
check("discoverAgents: worker uses cheap model + full tools", agents.find((agent) => agent.name === "worker")?.model === "deepseek-v4-flash");
check("discoverAgents: creative-worker uses kimi-k3", agents.find((agent) => agent.name === "creative-worker")?.model === "kimi-k3");
check("discoverAgents: reviewer uses the strong model", agents.find((agent) => agent.name === "reviewer")?.model === "gpt-5.6-sol");

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
