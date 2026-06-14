// Privilege handling. We run as the normal user (so ~/.diaphani and the vault
// stay user-owned) and elevate only the specific commands that need root, via
// sudo. Because sh() runs commands with stdin closed, sudo can't prompt mid-run
// — so we authorize ONCE here, on the real terminal, and keep the timestamp warm.
import { sh } from './run.js';
import { ui } from './ui.js';

export const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

// Ensure privileged commands will work. Returns when we're root or sudo is
// usable; throws with a clear message otherwise. Prompts for the password once
// (on the inherited tty) so later stdin-less `sudo` calls succeed from cache.
export async function ensureSudo() {
  if (isRoot()) return;
  if ((await sh('command -v sudo')).code !== 0) {
    throw new Error('this step needs root, but `sudo` is not installed — re-run as root');
  }
  if ((await sh('sudo -n true')).code === 0) return; // already cached / passwordless

  ui.nl();
  ui.info('Diaphani needs sudo — to install Docker and manage the daemon / container.');
  ui.dim('Enter your password once; it is cached for this run only (Diaphani itself stays your user).');
  const r = await sh('sudo -v', { stream: true });
  if (r.code !== 0) throw new Error('sudo authorization failed or was cancelled');
}
