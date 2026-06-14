import { confirm } from '@inquirer/prompts';
import { ui } from '../ui.js';
import * as docker from '../docker.js';

export async function down(opts = {}) {
  ui.banner();
  const autoYes = !!opts.yes || process.env.DIAPHANI_YES === '1';

  ui.heading('Tearing down');
  if (!autoYes && process.stdin.isTTY) {
    const ok = await confirm({
      message: 'Stop + remove the Diaphani container? (the chain DB + .onion key in named volumes are kept)',
      default: false,
    });
    if (!ok) { ui.dim('Left it running.'); return; }
  }

  await withSpin('Stopping the masked node container', () => docker.stopContainer());
  await withSpin('Removing the container (volumes kept)', () => docker.removeContainer());
  // Scrub the tmpfs mnemonic now that the container is gone — it must not linger.
  docker.wipeSecrets();
  ui.nl();
  ui.ok('Diaphani is down. The chain DB + .onion key persist in the dia-data / dia-onion volumes.');
  ui.dim('Bring it back with: diaphani up   (or `docker volume rm dia-data dia-onion` to wipe everything).');
}

async function withSpin(label, fn) {
  const spin = ui.spinner(label + '…').start();
  try { await fn(); spin.succeed(label); } catch (e) { spin.fail(label + ` — ${ui.c.red(e.message)}`); throw e; }
}
