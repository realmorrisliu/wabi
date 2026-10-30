import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configure } from '../scripts/configure.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
test('migrates wabi links, preserves personal settings and is repeatable', () => {
  const root = mkdtempSync(join(tmpdir(), 'wabi-test-'));
  const agent = join(root, 'agent'), config = join(root, 'xdg');
  const previous = process.env.WABI_INSTALL_HERDR;
  process.env.WABI_INSTALL_HERDR = '1';
  try {
    for (const dir of ['extensions', 'themes']) mkdirSync(join(agent, dir), { recursive: true });
    mkdirSync(join(config, 'herdr'), { recursive: true });
    symlinkSync(join(repo, 'extensions/theme-pair.ts'), join(agent, 'extensions/theme-pair.ts'));
    symlinkSync(join(repo, 'themes/catppuccin-mocha.json'), join(agent, 'themes/catppuccin-mocha.json'));
    symlinkSync(join(repo, 'herdr/config.toml'), join(config, 'herdr/config.toml'));
    mkdirSync(join(agent, 'prompts'), { recursive: true });
    symlinkSync(join(repo, 'prompts/simplify.md'), join(agent, 'prompts/simplify.md'));
    writeFileSync(join(agent, 'APPEND_SYSTEM.md'), 'Personal instructions\n');
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ theme: 'catppuccin-mocha', defaultProvider: 'openai', defaultModel: 'gpt-6-astra', defaultThinkingLevel: 'max', extensions: ['-builtin:mcp'], packages: ['git:github.com/DietrichGebert/ponytail', 'npm:other'] }));
    configure(repo, agent, config);
    const settings = JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'));
    assert.equal(settings.defaultProvider, 'openai');
    assert.equal(settings.defaultModel, 'gpt-6-astra');
    assert.equal(settings.defaultThinkingLevel, 'max');
    assert.equal(settings.extensions, undefined);
    assert.equal(settings.theme, 'rose-pine');
    assert.deepEqual(settings.packages, ['git:github.com/DietrichGebert/ponytail', 'npm:other']);
    assert.equal(existsSync(join(agent, 'extensions/theme-pair.ts')), false);
    assert.equal(lstatSync(join(agent, 'prompts/simplify.md'), { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(join(config, 'herdr/config.toml')).isSymbolicLink(), false);
    writeFileSync(join(config, 'herdr/config.toml'), 'personal config');
    const instructions = readFileSync(join(agent, 'APPEND_SYSTEM.md'), 'utf8');
    configure(repo, agent, config);
    assert.equal(readFileSync(join(agent, 'APPEND_SYSTEM.md'), 'utf8'), instructions);
    assert.match(instructions, /^Personal instructions/);
    assert.equal(readFileSync(join(config, 'herdr/config.toml'), 'utf8'), 'personal config');
  } finally {
    if (previous === undefined) delete process.env.WABI_INSTALL_HERDR; else process.env.WABI_INSTALL_HERDR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test('wires Cua Driver into mcp.json and leaves other servers alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'wabi-mcp-'));
  const agent = join(root, 'agent'), config = join(root, 'xdg'), bin = join(root, 'bin');
  const previous = process.env.PATH;
  try {
    mkdirSync(bin, { recursive: true });
    const driver = join(bin, 'cua-driver');
    writeFileSync(driver, '#!/bin/sh\n');
    chmodSync(driver, 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    configure(repo, agent, config);
    const mcpPath = join(agent, 'mcp.json');
    const first = readFileSync(mcpPath, 'utf8');
    assert.equal(JSON.parse(first).mcpServers['cua-driver'].command, driver);
    assert.deepEqual(JSON.parse(first).mcpServers['cua-driver'].args, ['mcp']);
    assert.equal(JSON.parse(first).mcpServers['cua-driver'].exposure, 'deferred');
    configure(repo, agent, config);
    assert.equal(readFileSync(mcpPath, 'utf8'), first);
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'cua-driver': { command: '/opt/mine', args: ['mcp'], exposure: 'direct' }, other: { url: 'https://example.com/mcp' } } }));
    configure(repo, agent, config);
    const merged = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers;
    assert.equal(merged['cua-driver'].command, '/opt/mine');
    assert.equal(merged['cua-driver'].exposure, 'direct');
    assert.equal(merged.other.url, 'https://example.com/mcp');
    writeFileSync(mcpPath, '{ broken');
    configure(repo, agent, config);
    assert.equal(readFileSync(mcpPath, 'utf8'), '{ broken');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test('fresh setup seeds dark defaults without overwriting later personal choices', () => {
  const root = mkdtempSync(join(tmpdir(), 'wabi-fresh-'));
  const agent = join(root, 'agent'), config = join(root, 'xdg');
  try {
    configure(repo, agent, config);
    const settingsPath = join(agent, 'settings.json');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {
      theme: 'rose-pine', defaultProvider: 'commandcode', defaultModel: 'deepseek/deepseek-v4.1-flash', defaultThinkingLevel: 'high',
    });
    writeFileSync(settingsPath, JSON.stringify({ theme: 'omarchy-system', packages: [{ source: 'npm:personal', skills: [] }] }));
    configure(repo, agent, config);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.theme, 'omarchy-system');
    assert.deepEqual(settings.packages, [{ source: 'npm:personal', skills: [] }]);
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-flash', defaultThinkingLevel: 'max' }));
    configure(repo, agent, config);
    const migrated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(migrated.defaultProvider, 'commandcode');
    assert.equal(migrated.defaultModel, 'deepseek/deepseek-v4.1-flash');
    assert.equal(migrated.defaultThinkingLevel, 'max');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
