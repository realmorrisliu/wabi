import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, existsSync, rmSync } from 'node:fs';
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
    writeFileSync(join(agent, 'APPEND_SYSTEM.md'), 'Personal instructions\n');
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ theme: 'catppuccin-mocha', defaultProvider: 'openai', defaultModel: 'gpt-6-astra', defaultThinkingLevel: 'max', extensions: ['-builtin:mcp'], packages: ['git:github.com/DietrichGebert/ponytail', 'npm:other'] }));
    configure(repo, agent, config);
    const settings = JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'));
    assert.equal(settings.defaultProvider, 'deepseek');
    assert.equal(settings.defaultModel, 'deepseek-flash');
    assert.equal(settings.defaultThinkingLevel, 'max');
    assert.deepEqual(settings.extensions, ['-builtin:mcp']);
    assert.equal(settings.theme, 'rose-pine');
    assert.deepEqual(settings.packages, ['npm:other']);
    assert.equal(existsSync(join(agent, 'extensions/theme-pair.ts')), false);
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
test('fresh setup seeds dark defaults without overwriting later personal choices', () => {
  const root = mkdtempSync(join(tmpdir(), 'wabi-fresh-'));
  const agent = join(root, 'agent'), config = join(root, 'xdg');
  try {
    configure(repo, agent, config);
    const settingsPath = join(agent, 'settings.json');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {
      theme: 'rose-pine', defaultProvider: 'deepseek', defaultModel: 'deepseek-flash',
    });
    writeFileSync(settingsPath, JSON.stringify({ theme: 'omarchy-system', packages: [{ source: 'npm:personal', skills: [] }] }));
    configure(repo, agent, config);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.theme, 'omarchy-system');
    assert.deepEqual(settings.packages, [{ source: 'npm:personal', skills: [] }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
