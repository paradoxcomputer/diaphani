// Remove the bundled copies produced by bundle.mjs, so the in-repo dev tree
// falls back to ../scripts and ../docker. Runs automatically on `postpack`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const d of ['scripts', 'docker']) {
  fs.rmSync(path.join(pkg, d), { recursive: true, force: true });
}
for (const f of ['LICENSE-APACHE', 'LICENSE-MIT', 'README.md']) {
  fs.rmSync(path.join(pkg, f), { force: true });
}
console.log('cleaned bundled scripts/, docker/, LICENSE, README files');
