// Pure helpers for the wabi subagent extension. Checked by check.ts.

import { readdirSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

export interface DecodedJsonl {
	events: Record<string, any>[];
	errors: string[];
}

/** Incrementally decode LF-delimited JSON, including chunks split mid-line. */
export class JsonlDecoder {
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");

	push(chunk: string | Buffer): DecodedJsonl {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return decodeLines(lines);
	}

	flush(): DecodedJsonl {
		this.buffer += this.decoder.end();
		const line = this.buffer;
		this.buffer = "";
		return decodeLines(line ? [line] : []);
	}
}

function decodeLines(lines: string[]): DecodedJsonl {
	const events: Record<string, any>[] = [];
	const errors: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object") events.push(value);
		} catch {
			errors.push(line);
		}
	}
	return { events, errors };
}

/** Keep model-visible handoffs bounded without splitting UTF-8 characters. */
export function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	const suffix = "\n\n[Output truncated; full transcript is available in /subagents.]";
	const limit = Math.max(0, maxBytes - Buffer.byteLength(suffix));
	let body = bytes.subarray(0, limit).toString("utf8");
	while (body.endsWith("�")) body = body.slice(0, -1);
	return body + suffix;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds < 3600 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function isWriter(agent: AgentConfig): boolean {
	return !agent.tools || agent.tools.some((tool) => tool === "edit" || tool === "write");
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && (part as any).type === "text")
		.map((part) => String((part as any).text ?? ""))
		.join("\n");
}

/** Parse the deliberately flat frontmatter used by agent definitions. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter, body: content.trim() };
	for (const line of match[1].split("\n")) {
		const field = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (field) frontmatter[field[1]] = field[2].trim();
	}
	return { frontmatter, body: match[2].trim() };
}

export function discoverAgents(dir: string): AgentConfig[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		let content: string;
		try {
			content = readFileSync(`${dir}/${entry}`, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name) continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description ?? "",
			tools: frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
			model: frontmatter.model || undefined,
			systemPrompt: body,
		});
	}
	return agents;
}
