import {
	accessSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const APP_KEYS = ["pi", "herdr", "ghostty"] as const;

export interface ThemeTargets {
	pi: string;
	herdr: string;
	ghostty: string;
}

export interface ThemePair {
	label: string;
	light: ThemeTargets;
	dark: ThemeTargets;
}

export interface ThemeRegistry {
	default: string;
	pairs: Record<string, ThemePair>;
}

export interface ThemeConfigPaths {
	pi: string;
	herdr: string;
	ghostty: string;
}

interface FileChange {
	path: string;
	before: string | undefined;
	existed: boolean;
	after: string;
}

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const GHOSTTY_RELOAD_SCRIPT = `if application "Ghostty" is running then
\ttell application "Ghostty"
\t\trepeat with t in every terminal
\t\t\tperform action "reload_config" on t
\t\tend repeat
\tend tell
end if`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function targets(value: unknown, pairId: string, mode: "light" | "dark"): ThemeTargets {
	if (!isRecord(value)) throw new Error(`Theme pair ${pairId} is missing ${mode} targets`);
	const result = {} as ThemeTargets;
	for (const app of APP_KEYS) {
		const name = value[app];
		if (typeof name !== "string" || !name.trim()) {
			throw new Error(`Theme pair ${pairId}.${mode}.${app} must be a non-empty string`);
		}
		result[app] = name.trim();
	}
	return result;
}

export function parseThemeRegistry(text: string): ThemeRegistry {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid theme-pairs.json: ${String(error)}`);
	}
	if (!isRecord(value) || !isRecord(value.pairs)) throw new Error("theme-pairs.json must contain a pairs object");

	const pairs: Record<string, ThemePair> = {};
	for (const [id, raw] of Object.entries(value.pairs)) {
		if (!isRecord(raw)) throw new Error(`Theme pair ${id} must be an object`);
		pairs[id] = {
			label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
			light: targets(raw.light, id, "light"),
			dark: targets(raw.dark, id, "dark"),
		};
	}
	const ids = Object.keys(pairs);
	if (ids.length === 0) throw new Error("theme-pairs.json must define at least one pair");
	const requestedDefault = typeof value.default === "string" ? value.default : "";
	return { default: pairs[requestedDefault] ? requestedDefault : ids[0], pairs };
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function registryPath(): string {
	if (process.env.WABI_THEME_PAIRS) return process.env.WABI_THEME_PAIRS;
	const installed = join(agentDir(), "theme-pairs.json");
	return existsSync(installed) ? installed : join(REPO_ROOT, "theme-pairs.json");
}

function loadRegistry(): ThemeRegistry {
	return parseThemeRegistry(readFileSync(registryPath(), "utf8"));
}

export function themeConfigPaths(): ThemeConfigPaths {
	const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return {
		pi: process.env.WABI_PI_SETTINGS ?? join(agentDir(), "settings.json"),
		herdr: process.env.WABI_HERDR_CONFIG ?? join(configHome, "herdr", "config.toml"),
		ghostty: process.env.WABI_GHOSTTY_CONFIG ?? join(configHome, "ghostty", "config"),
	};
}

export function piThemeValue(pair: ThemePair): string {
	return `${pair.light.pi}/${pair.dark.pi}`;
}

export function renderPiSettings(text: string, pair: ThemePair): string {
	let value: unknown = {};
	if (text.trim()) value = JSON.parse(text);
	if (!isRecord(value)) throw new Error("Pi settings.json must contain a JSON object");
	const theme = piThemeValue(pair);
	if (value.theme === theme) return text;
	value.theme = theme;
	return JSON.stringify(value, null, "\t") + "\n";
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

export function renderHerdrConfig(text: string, pair: ThemePair): string {
	const desired: Record<string, string> = {
		name: tomlString(pair.dark.herdr),
		auto_switch: "true",
		dark_name: tomlString(pair.dark.herdr),
		light_name: tomlString(pair.light.herdr),
	};
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	let start = lines.findIndex((line) => line.trim() === "[theme]");
	if (start < 0) {
		if (lines.length > 0 && lines.at(-1)?.trim()) lines.push("");
		lines.push("[theme]");
		for (const [key, value] of Object.entries(desired)) lines.push(`${key} = ${value}`);
		return lines.join("\n") + "\n";
	}

	let end = start + 1;
	while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end++;
	const seen = new Set<string>();
	for (let index = start + 1; index < end; index++) {
		const match = lines[index].match(/^(\s*)(name|auto_switch|dark_name|light_name)\s*=/);
		if (!match) continue;
		const key = match[2];
		lines[index] = `${match[1]}${key} = ${desired[key]}`;
		seen.add(key);
	}
	const missing = Object.entries(desired)
		.filter(([key]) => !seen.has(key))
		.map(([key, value]) => `${key} = ${value}`);
	lines.splice(end, 0, ...missing);
	return lines.join("\n") + "\n";
}

function setGhosttyKey(lines: string[], key: string, value: string): void {
	const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
	const index = lines.findIndex((line) => pattern.test(line));
	if (index >= 0) lines[index] = `${key} = ${value}`;
	else lines.push(`${key} = ${value}`);
}

export function renderGhosttyConfig(text: string, pair: ThemePair): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	setGhosttyKey(lines, "theme", `light:${pair.light.ghostty},dark:${pair.dark.ghostty}`);
	setGhosttyKey(lines, "window-theme", "system");
	return lines.join("\n") + "\n";
}

function writeAtomic(path: string, text: string): void {
	let destination = path;
	try {
		destination = realpathSync(path);
	} catch {
		// The file may not exist yet.
	}
	mkdirSync(dirname(destination), { recursive: true });
	const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, text);
		renameSync(temp, destination);
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// The temporary file was renamed successfully.
		}
	}
}

function prepareChange(path: string, after: string, optional: boolean): FileChange | undefined {
	const existed = existsSync(path);
	if (optional && !existed) return undefined;
	const before = existed ? readFileSync(path, "utf8") : undefined;
	return before === after ? undefined : { path, before, existed, after };
}

function restoreChange(change: FileChange): void {
	if (change.existed) {
		writeAtomic(change.path, change.before ?? "");
		return;
	}
	try {
		unlinkSync(change.path);
	} catch {
		// The file was already removed.
	}
}

function executable(name: string): string | undefined {
	if (name.includes("/")) {
		try {
			accessSync(name, fsConstants.X_OK);
			return name;
		} catch {
			return undefined;
		}
	}
	for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
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

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function run(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<CommandResult> {
	try {
		const result = await pi.exec(command, args, { signal: ctx.signal, timeout: 8_000 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? -1 };
	} catch (error) {
		return { stdout: "", stderr: String(error), code: -1 };
	}
}

function commandError(name: string, result: CommandResult): Error {
	const detail = (result.stderr || result.stdout).trim().split("\n").slice(-1)[0] || "unknown error";
	return new Error(`${name}: ${detail}`);
}

async function validate(
	pi: ExtensionAPI,
	changes: FileChange[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (changes.some((change) => change.path === themeConfigPaths().herdr)) {
		const herdr = executable("herdr");
		if (herdr) {
			const result = await run(pi, herdr, ["config", "check"], ctx);
			if (result.code !== 0) throw commandError("Herdr config validation failed", result);
		}
	}
	if (changes.some((change) => change.path === themeConfigPaths().ghostty)) {
		const ghostty = executable("ghostty") ?? "/Applications/Ghostty.app/Contents/MacOS/ghostty";
		if (executable(ghostty)) {
			const result = await run(pi, ghostty, ["+validate-config"], ctx);
			if (result.code !== 0) throw commandError("Ghostty config validation failed", result);
		}
	}
}

async function reloadExternal(
	pi: ExtensionAPI,
	changes: FileChange[],
	ctx: ExtensionCommandContext,
): Promise<string[]> {
	const warnings: string[] = [];
	const paths = themeConfigPaths();
	if (changes.some((change) => change.path === paths.herdr)) {
		const herdr = executable("herdr");
		if (herdr) {
			const result = await run(pi, herdr, ["server", "reload-config"], ctx);
			if (result.code !== 0) warnings.push(`Herdr live reload failed: ${commandError("herdr", result).message}`);
		}
	}
	if (changes.some((change) => change.path === paths.ghostty)) {
		const osascript = executable("osascript");
		if (process.platform === "darwin" && osascript) {
			const result = await run(pi, osascript, ["-e", GHOSTTY_RELOAD_SCRIPT], ctx);
			if (result.code !== 0) warnings.push(`Ghostty live reload failed: ${commandError("osascript", result).message}`);
		} else {
			warnings.push(process.platform === "darwin"
				? "Ghostty config updated; osascript is unavailable for live reload"
				: "Ghostty config updated; live reload is only available on macOS");
		}
	}
	return warnings;
}

function currentPiTheme(path: string): string | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return typeof value.theme === "string" ? value.theme : undefined;
	} catch {
		return undefined;
	}
}

function pairForPiTheme(registry: ThemeRegistry, theme: string | undefined): [string, ThemePair] | undefined {
	if (!theme) return undefined;
	return Object.entries(registry.pairs).find(([, pair]) => piThemeValue(pair) === theme);
}

function listText(registry: ThemeRegistry): string {
	return Object.entries(registry.pairs)
		.map(([id, pair]) => `${id} · ${pair.label} · light=${pair.light.pi} · dark=${pair.dark.pi}`)
		.join("\n");
}

function statusText(registry: ThemeRegistry, paths: ThemeConfigPaths): string {
	const piTheme = currentPiTheme(paths.pi);
	const current = pairForPiTheme(registry, piTheme);
	const lines = [
		`Theme pair: ${current ? `${current[0]} · ${current[1].label}` : piTheme ?? "not set"}`,
		`Light: ${current?.[1].light.pi ?? "unknown"}`,
		`Dark: ${current?.[1].dark.pi ?? "unknown"}`,
		`Pi: ${paths.pi}`,
		`Herdr: ${existsSync(paths.herdr) ? paths.herdr : "not installed"}`,
		`Ghostty: ${existsSync(paths.ghostty) ? paths.ghostty : "not installed"}`,
	];
	return lines.join("\n");
}

function show(ctx: ExtensionCommandContext, text: string): void {
	if (ctx.hasUI) ctx.ui.setWidget("theme-pair", text.split("\n"));
	else console.log(text);
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

async function applyPair(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	id: string,
	pair: ThemePair,
): Promise<void> {
	const paths = themeConfigPaths();
	const changes: FileChange[] = [];
	try {
		const settingsText = existsSync(paths.pi) ? readFileSync(paths.pi, "utf8") : "{}";
		const settings = prepareChange(paths.pi, renderPiSettings(settingsText, pair), false);
		if (settings) changes.push(settings);

		if (existsSync(paths.herdr)) {
			const change = prepareChange(paths.herdr, renderHerdrConfig(readFileSync(paths.herdr, "utf8"), pair), true);
			if (change) changes.push(change);
		}
		if (existsSync(paths.ghostty)) {
			const change = prepareChange(paths.ghostty, renderGhosttyConfig(readFileSync(paths.ghostty, "utf8"), pair), true);
			if (change) changes.push(change);
		}

		for (const change of changes) writeAtomic(change.path, change.after);
		await validate(pi, changes, ctx);
	} catch (error) {
		for (const change of [...changes].reverse()) restoreChange(change);
		throw error;
	}

	if (changes.length === 0) {
		notify(ctx, `${pair.label} is already selected`, "info");
		return;
	}

	const warnings = await reloadExternal(pi, changes, ctx);
	const updated = changes.map((change) => change.path).join(", ");
	notify(
		ctx,
		`${pair.label} selected (${id}); updated ${updated}${warnings.length ? ` · ${warnings.join("; ")}` : ""}`,
		warnings.length ? "warning" : "info",
	);
	await ctx.reload();
	return;
}

function resolvePair(registry: ThemeRegistry, value: string): [string, ThemePair] | undefined {
	const normalized = value.toLowerCase();
	return Object.entries(registry.pairs).find(([id, pair]) => id.toLowerCase() === normalized || pair.label.toLowerCase() === normalized);
}

export default function themePair(pi: ExtensionAPI): void {
	pi.registerCommand("theme", {
		description: "Select a light/dark theme pair for Pi, Herdr, and Ghostty",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			try {
				const registry = loadRegistry();
				const items = Object.entries(registry.pairs).map(([id, pair]) => ({ value: id, label: `${id} · ${pair.label}` }));
				const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
				return filtered.length > 0 ? filtered : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			let registry: ThemeRegistry;
			try {
				registry = loadRegistry();
			} catch (error) {
				notify(ctx, String(error), "error");
				return;
			}

			const operation = args.trim();
			const normalizedOperation = operation.toLowerCase();
			if (normalizedOperation === "list") {
				show(ctx, listText(registry));
				return;
			}
			if (normalizedOperation === "status") {
				show(ctx, statusText(registry, themeConfigPaths()));
				return;
			}
			if (normalizedOperation === "help") {
				show(ctx, "/theme · choose a pair\n/theme <id> · select a pair\n/theme list\n/theme status");
				return;
			}

			let selected = operation ? resolvePair(registry, operation) : undefined;
			if (!operation && !ctx.hasUI) {
				show(ctx, `${listText(registry)}\n\nUse /theme <id> to select a pair.`);
				return;
			}
			if (!operation && ctx.hasUI) {
				const options = Object.entries(registry.pairs).map(([id, pair]) => `${id} · ${pair.label} · ${pair.light.pi}/${pair.dark.pi}`);
				const choice = await ctx.ui.select("Select theme pair", options);
				if (!choice) return;
				selected = Object.entries(registry.pairs)[options.indexOf(choice)];
			}
			if (!selected) {
				show(ctx, `Unknown theme pair: ${operation || "(none)"}\n\n${listText(registry)}`);
				return;
			}
			try {
				await applyPair(pi, ctx, selected[0], selected[1]);
			} catch (error) {
				notify(ctx, `Theme pair update failed: ${String(error)}`, "error");
			}
		},
	});
}
