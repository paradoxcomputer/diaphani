import path from 'node:path';
import { ui } from '../ui.js';
import { sh } from '../run.js';
import * as docker from '../docker.js';
import { load, scriptsDir } from '../config.js';

// Generate a v3 onion client-authorization keypair so only key-holders can reach
// the (unauthenticated) node API. Installs the client's PUBLIC key on the node
// side and prints the PRIVATE key for that client. Pure user-level: no sudo —
// the next `diaphani up` copies the pubkey into the onion.
export async function clientauth(name) {
  ui.banner();
  const cfg = load();
  if (!cfg) throw new Error('No config — run `diaphani setup` first.');
  if (!cfg.onion) ui.warn('This config has the .onion disabled — client-auth only matters for the onion API.');
  const clientName = (name || 'client').replace(/[^a-zA-Z0-9_-]/g, '') || 'client';

  // The container keeps the onion key in the dia-onion volume (not the vault), so read
  // the address from the running container — otherwise the printed client line is
  // missing the onion prefix and isn't copy-paste ready.
  let onion = (await docker.containerOnion().catch(() => '')) || '';
  if (!onion) ui.warn('No .onion sealed yet — run `diaphani up` once to create it. Generating the key anyway; prepend the address to the client line yourself.');

  ui.heading(`Authorizing client "${clientName}"`);
  // Writes the non-secret pubkey to ~/.diaphani/onion_authorized_clients/ and
  // streams the PRIVATE key line to the terminal for the user to copy.
  await sh(`bash ${q(path.join(scriptsDir, 'diaphani-clientauth.sh'))} ${q(clientName)} ${q(onion)}`, { stream: true });

  ui.nl();
  ui.ok(`Client "${clientName}" authorized (public key saved).`);
  ui.dim('Give the PRIVATE key above to that client only.');
  ui.dim('Re-run `diaphani up` to apply it to the onion; on the client, save it as');
  ui.dim('<ClientOnionAuthDir>/<name>.auth_private and set ClientOnionAuthDir in its torrc.');
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
