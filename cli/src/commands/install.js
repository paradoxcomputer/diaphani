import { ui } from '../ui.js';
import * as docker from '../docker.js';

// Bootstrap the one dependency the run model needs: Docker. The container ships
// everything else (nym, tor, the node binary + circuits, glibc 2.39), so there is
// nothing else to install on the host.
export async function install() {
  ui.banner();
  ui.heading('Dependency bootstrap');

  if (await docker.hasDocker()) {
    ui.ok('Docker — already installed');
    try { await docker.ensureDocker(); ui.ok('Docker daemon reachable'); }
    catch (e) { ui.warn(e.message.split('\n')[0]); }
  } else {
    try { await docker.ensureDocker(); }
    catch (e) { ui.warn(`Docker: ${e.message.split('\n')[0]}`); }
  }

  ui.nl();
  ui.ok('Ready. Next: `diaphani setup` (if not done), then `diaphani up`.');
}
