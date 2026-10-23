import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configure(repo, agentDir, configHome) {
  const backup = path => renameSync(path, `${path}.bak.${Date.now()}.${process.pid}`);
  const present = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; } };
  const ownedLink = (path, source) => present(path)?.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === join(repo, source);
  const link = (source, target) => {
    mkdirSync(dirname(target), { recursive: true });
    if (ownedLink(target, source)) return;
    if (present(target)) backup(target);
    symlinkSync(join(repo, source), target);
  };
  const retire = (source, target) => {
    if (ownedLink(target, source)) unlinkSync(target);
  };
  // Detach former repository links, preserving their current contents. New
  // machines get defaults; existing independent personal configs remain intact.
  const seed = (source, target) => {
    mkdirSync(dirname(target), { recursive: true });
    if (ownedLink(target, source)) {
      const text = readFileSync(target, 'utf8');
      backup(target);
      writeFileSync(target, text);
    } else if (!present(target)) writeFileSync(target, readFileSync(join(repo, source)));
  };
  link('prompts/review.md', join(agentDir, 'prompts', 'review.md'));
  link('lib/pr-review-threads.ts', join(agentDir, 'lib/pr-review-threads.ts'));
  link('extensions/pr-review-threads.ts', join(agentDir, 'extensions/pr-review-threads.ts'));
  link('themes/rose-pine.json', join(agentDir, 'themes/rose-pine.json'));
  for (const name of ['theme-pair', 'agent-router', 'agent-router-core']) retire(`extensions/${name}.ts`, join(agentDir, 'extensions', `${name}.ts`));
  retire('theme-pairs.json', join(agentDir, 'theme-pairs.json'));
  retire('prompts/simplify.md', join(agentDir, 'prompts', 'simplify.md'));
  for (const name of ['agent-routing', 'creative-worker', 'herdr-dispatch', 'planner']) retire(`skills/${name}/SKILL.md`, join(agentDir, 'skills', name, 'SKILL.md'));

  const settingsPath = join(agentDir, 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Pi settings must be a JSON object');
  const retiredThemes = ['catppuccin-latte', 'catppuccin-mocha', 'gruvbox-light-medium', 'gruvbox-dark-medium', 'solarized-light', 'solarized-dark', 'tokyonight-day', 'tokyonight', 'kanagawa-lotus', 'kanagawa', 'rose-pine-dawn'];
  // Migrate only themes owned by this checkout, including the old auto pairs.
  const selected = typeof settings.theme === 'string' ? settings.theme.split('/') : [];
  if (!selected.length || selected.every(name => name === 'rose-pine' || (retiredThemes.includes(name) && ownedLink(join(agentDir, 'themes', `${name}.json`), `themes/${name}.json`)))) settings.theme = 'rose-pine';
  for (const name of retiredThemes) retire(`themes/${name}.json`, join(agentDir, 'themes', `${name}.json`));
  settings.defaultProvider = 'deepseek';
  settings.defaultModel = 'deepseek-flash';
  const serialized = JSON.stringify(settings, null, '\t') + '\n';
  if (!existsSync(settingsPath) || readFileSync(settingsPath, 'utf8') !== serialized) {
    if (present(settingsPath)) backup(settingsPath);
    writeFileSync(settingsPath, serialized);
  }

  const instructionsPath = join(agentDir, 'APPEND_SYSTEM.md');
  const start = '<!-- wabi:start -->', end = '<!-- wabi:end -->';
  const original = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf8') : '';
  const block = `${start}\n${readFileSync(join(repo, '.pi/APPEND_SYSTEM.md'), 'utf8').trim()}\n${end}`;
  const first = original.indexOf(start), last = original.indexOf(end);
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) throw new Error('Malformed wabi instruction markers');
  const next = first >= 0 ? original.slice(0, first) + block + original.slice(last + end.length) : `${original}${original && !original.endsWith('\n') ? '\n' : ''}\n${block}\n`;
  if (next !== original) {
    if (present(instructionsPath)) backup(instructionsPath);
    writeFileSync(instructionsPath, next);
  }
  if (process.env.WABI_INSTALL_HERDR === '1') seed('herdr/config.toml', join(configHome, 'herdr/config.toml'));
  if (process.env.WABI_INSTALL_GHOSTTY === '1') seed('ghostty/config', join(configHome, 'ghostty/config'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) configure(...process.argv.slice(2));
