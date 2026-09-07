// Repository-only validation. Does not inspect or mutate personal app settings.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
for (const file of readdirSync(new URL('prompts/', import.meta.url))) {
  assert.match(read(`prompts/${file}`), /^---\ndescription: .+/);
}
assert.equal(JSON.parse(read('themes/rose-pine.json')).name, 'rose-pine');
assert.match(read('herdr/config.toml'), /name = "rose-pine"/);
assert.match(read('herdr/config.toml'), /auto_switch = false/);
assert.match(read('ghostty/config'), /^theme = Rose Pine$/m);
assert.match(read('.pi/APPEND_SYSTEM.md'), /Herdr-first workflow/);
console.log('Distribution checks passed');
