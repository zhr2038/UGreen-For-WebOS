import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Expand the test list here because Windows npm scripts do not expand shell globs on Node 20.
const directory = resolve(import.meta.dirname, '../test');
const files = readdirSync(directory)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => resolve(directory, name));
if (!files.length) throw new Error('No unit tests found');
const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
  windowsHide: true,
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
