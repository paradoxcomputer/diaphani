#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ui } from '../src/ui.js';
import { setup } from '../src/commands/setup.js';
import { install } from '../src/commands/install.js';
import { clientauth } from '../src/commands/clientauth.js';
import { up } from '../src/commands/up.js';
import { down } from '../src/commands/down.js';
import { status } from '../src/commands/status.js';
import { logs } from '../src/commands/logs.js';

const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

const program = new Command();

program
  .name('diaphani')
  .description('Run a Logos testnet node that links you to no one.')
  .version(pkg.version);

program
  .command('setup')
  .description('Interactive wizard: detect your node, enter credentials, pick an anonymity strategy.')
  .action(run(setup));

program
  .command('install')
  .description('Bootstrap Docker (the only host dependency — the container ships everything else) on Debian/Ubuntu.')
  .action(run(install));

program
  .command('up')
  .description('Install Docker if needed, then bring the masked node online in a container and print its .onion.')
  .option('--rebuild', 'rebuild the Docker image before starting')
  .option('-y, --yes', 'assume yes — run unattended with no prompts (also via DIAPHANI_YES=1)')
  .action(run(up));

program
  .command('clientauth [name]')
  .description('Generate a v3 onion client-auth key so only key-holders can reach the node API.')
  .action(run(clientauth));

program
  .command('status')
  .description('Show the node sync state, Nym mode, masked egress IP, and the .onion.')
  .option('-f, --follow', 'refresh continuously (live dashboard) until Ctrl-C')
  .option('--interval <seconds>', 'refresh interval for --follow', '5')
  .action(run(status));

program
  .command('logs')
  .description('Stream the node logs — sync progress, peer dials, startup errors.')
  .option('-f, --follow', 'follow the log (like tail -f)')
  .option('-n, --lines <N>', 'show the last N lines', '200')
  .action(run(logs));

program
  .command('down')
  .description('Stop + remove the masked node container (the chain DB + .onion key persist in named volumes).')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(run(down));

program.addHelpText('after', `
Quick start (Docker by default — the CLI installs Docker if it's missing):
  1. diaphani setup            one-time: nym phrase, bootstrap peers, anonymity strategy
  2. diaphani up               builds the image + runs the masked node; prints its .onion
  3. diaphani status --follow  watch it sync   (diaphani logs -f to tail the node)

You'll need:
  • a NymVPN subscription — a 24-word recovery phrase from https://nym.com
  • Docker (auto-installed on Debian/Ubuntu; the container ships everything else)
  • at least one Logos testnet peer on a nym-allowed udp port (50000-65535) —
    set it in \`diaphani setup\`, or pass BOOTSTRAP_PEERS="…"

Full command reference: docs/CLI.md`);

program.parseAsync(process.argv).catch((err) => {
  ui.fail(err?.message || String(err));
  process.exit(1);
});

function run(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err?.name === 'ExitPromptError') {
        ui.nl();
        ui.dim('Cancelled.');
        process.exit(130);
      }
      ui.fail(err?.message || String(err));
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }
  };
}
