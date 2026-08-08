// lib.ts — pure logic for the wabi subagent extension (no side effects, unit-checked in check.ts)

import { readdirSync, readFileSync } from "node:fs";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

export interface ParsedResult {
	text: string;
	model?: string;
	usage?: { input?: number; output?: number; cost?: number };
}

/** Extract the final assistant text (plus model/usage) from `pi --mode json` JSONL output. */
export function lastAssistantText(jsonl: string): ParsedResult {
	let text = "";
	let model: string | undefined;
	let usage: ParsedResult["usage"];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = ev?.message;
		if (!msg || msg.role !== "assistant") continue;
		const parts = (msg.content ?? [])
			.filter((p: any) => p?.type === "text" && p.text)
			.map((p: any) => p.text);
		if (parts.length === 0) continue; // message_start / delta events carry no full text
		text = parts.join("");
		if (msg.model) model = msg.model;
		if (msg.usage) {
			usage = {
				input: msg.usage.input,
				output: msg.usage.output,
				cost: msg.usage.cost?.total ?? msg.usage.cost,
			};
		}
	}
	return { text, model, usage };
}

/** Replace every {previous} placeholder with the given context (empty string when absent). */
export function replacePrevious(template: string, previous: string | undefined): string {
	if (!template.includes("{previous}")) return template;
	return template.split("{previous}").join(previous ?? "");
}

/** Quote a string for safe inclusion in a POSIX shell command line. */
export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export interface TmuxCommandConfig {
	command: string[]; // argv of the command to run inside the pane
	outFile: string; // stdout/stderr redirected here
	env?: Record<string, string>; // extra env vars, prefixed as VAR=val
}

/** Build the shell command string for one tmux window. */
export function buildTmuxCommand(cfg: TmuxCommandConfig): string {
	const envPrefix = cfg.env ? Object.entries(cfg.env).map(([k, v]) => `${k}=${shellQuote(v)} `).join("") : "";
	const argv = cfg.command.map(shellQuote).join(" ");
	return `${envPrefix}${argv} > ${shellQuote(cfg.outFile)} 2>&1`;
}

/** Parse frontmatter (--- yaml ---) + body from a markdown agent file. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { frontmatter, body: content.trim() };
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (kv) frontmatter[kv[1]] = kv[2].trim();
	}
	return { frontmatter, body: m[2].trim() };
}

/** Load agent definitions from a directory of markdown files. */
export function discoverAgents(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return agents;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		let content: string;
		try {
			content = readFileSync(`${dir}/${entry}`, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name) continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description ?? "",
			tools: frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean),
			model: frontmatter.model || undefined,
			systemPrompt: body,
		});
	}
	return agents;
}
