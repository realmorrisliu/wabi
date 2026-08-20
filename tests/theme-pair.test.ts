import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	GHOSTTY_RELOAD_SCRIPT,
	parseThemeRegistry,
	piThemeValue,
	renderGhosttyConfig,
	renderHerdrConfig,
	renderPiSettings,
} from "../extensions/theme-pair.ts";

const registry = parseThemeRegistry(`{
	"default": "kanagawa",
	"pairs": {
		"kanagawa": {
			"label": "Kanagawa",
			"light": { "pi": "lotus", "herdr": "lotus", "ghostty": "Lotus" },
			"dark": { "pi": "wave", "herdr": "wave", "ghostty": "Wave" }
		}
	}
}`);
const pair = registry.pairs.kanagawa;
const bundledRegistry = parseThemeRegistry(readFileSync(new URL("../theme-pairs.json", import.meta.url), "utf8"));

test("bundles the six cross-app theme pairs", () => {
	assert.equal(bundledRegistry.default, "catppuccin");
	assert.deepEqual(Object.keys(bundledRegistry.pairs), ["kanagawa", "catppuccin", "tokyo-night", "rose-pine", "gruvbox", "solarized"]);
	assert.equal(piThemeValue(bundledRegistry.pairs["rose-pine"]), "rose-pine-dawn/rose-pine");
	assert.equal(bundledRegistry.pairs.gruvbox.dark.ghostty, "Gruvbox Dark");
});

test("validates and reads a theme pair registry", () => {
	assert.equal(registry.default, "kanagawa");
	assert.equal(piThemeValue(pair), "lotus/wave");
});

test("reloads Ghostty one terminal at a time", () => {
	assert.match(GHOSTTY_RELOAD_SCRIPT, /repeat with t in every terminal/);
	assert.match(GHOSTTY_RELOAD_SCRIPT, /perform action "reload_config" on t/);
});

test("renders all three app configurations without dropping settings", () => {
	assert.match(renderPiSettings('{"defaultModel":"test"}', pair), /"defaultModel": "test"/);
	assert.match(renderPiSettings("{}", pair), /"theme": "lotus\/wave"/);
	assert.match(renderHerdrConfig("[ui]\nshow_agent_labels_on_pane_borders = true\n", pair), /\[theme\]/);
	assert.match(renderHerdrConfig("[theme]\nname = \"old\"\n", pair), /dark_name = \"wave\"/);
	assert.match(renderGhosttyConfig("font-size = 14\n", pair), /theme = light:Lotus,dark:Wave/);
	assert.match(renderGhosttyConfig("theme = old\nwindow-theme = dark\n", pair), /window-theme = system/);
});
