// Copy the canonical bash scripts into the package so `npm pack` produces a
// self-contained tarball. Run automatically on `prepack`.
// In-repo, the CLI falls back to ../scripts, so this is only needed for publishing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..'); // .../diaphani/cli
const repo = path.resolve(pkg, '..'); // .../diaphani

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (!filter(name)) continue;
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.statSync(src).isDirectory()) continue; // shallow
    fs.copyFileSync(src, dst);
    if (name.endsWith('.sh')) fs.chmodSync(dst, 0o755);
  }
}

copyDir(path.join(repo, 'scripts'), path.join(pkg, 'scripts'), (n) => n.endsWith('.sh'));
copyDir(path.join(repo, 'docker'), path.join(pkg, 'docker'), (n) => n === 'Dockerfile' || n === 'entrypoint.sh');

// Dual license text lives at the repo root; ship it inside the tarball (the
// package root is cli/, so a published tarball would otherwise have none).
for (const lic of ['LICENSE-APACHE', 'LICENSE-MIT']) {
  const src = path.join(repo, lic);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pkg, lic));
}

// The canonical README lives at the repo root; the package root is cli/, which has
// no README of its own. Copy it in so npm auto-includes it and the npmjs.com page
// is not bare (npm rewrites its relative links against the `repository` field).
{
  const src = path.join(repo, 'README.md');
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pkg, 'README.md'));
}

console.log('bundled scripts/, docker/, LICENSE, and README into the package');
