import { input, password, select, confirm } from '@inquirer/prompts';
import { ui } from '../ui.js';
import { isRoot } from '../privilege.js';
import { which } from '../system.js';
import * as vault from '../vault.js';
import * as docker from '../docker.js';
import { save, purgeLegacyPlaintext, STRATEGIES, DEFAULT_PEERS, DEFAULT_GENESIS_PREFIX } from '../config.js';

export async function setup() {
  ui.banner();

  // ── 1. Detect what's here ───────────────────────────────────────────────
  ui.heading('Checking your machine');
  const spin = ui.spinner('scanning…').start();
  const [hasDocker, hasSudo] = await Promise.all([docker.hasDocker(), which('sudo')]);
  const root = isRoot();
  spin.stop();
  ui.kv('root / sudo', root ? ui.badge('ok', 'running as root') : hasSudo ? ui.badge('warn', 'sudo available (Docker install/daemon may prompt)') : ui.badge('bad', 'NO root/sudo — needed to install or start Docker'));
  ui.kv('docker', hasDocker ? ui.badge('ok', 'installed') : ui.badge('warn', 'not found — Diaphani will install it'));

  // ── 2. Credentials (encrypted vault) ────────────────────────────────────
  let phrase, vaultReused = false;
  if (vault.exists() && (await confirm({ message: 'Reuse your existing encrypted credentials (enter your passphrase)?', default: true }))) {
    phrase = (await vault.unlock()).obj.nym;
    vaultReused = true;
    ui.ok('credentials unlocked');
  } else {
    ui.heading('NymVPN — the layer that hides your node IP from peers');
    ui.dim('Get a subscription at https://nym.com (Monero/fiat, or a 7-day card trial), then paste your 24-word recovery phrase.');
    phrase = await password({ message: '24-word recovery phrase:', mask: '•', validate: (v) => (v.trim().split(/\s+/).length === 24 ? true : 'expected 24 words') });
  }
  const nym = phrase.trim().replace(/\s+/g, ' ');

  // ── 3. Anonymity mode ───────────────────────────────────────────────────
  ui.heading('Anonymity mode — speed vs. timing-attack resistance');
  const strategy = await select({
    message: 'Pick one:',
    choices: [
      { name: 'fast → 5-hop  ★ recommended', value: 'fast-5h', description: 'Sync fast on 2-hop WireGuard (~100 ms), then auto-switch to the 5-hop mixnet once the node is caught up. Best balance — quick sync, then strongest privacy.' },
      { name: 'fast → fast', value: 'fast-fast', description: 'Always 2-hop WireGuard. Hides your IP from peers at the lowest latency — best for a block-producing node. Does NOT resist an attacker watching both your link and the exit at once.' },
      { name: '5-hop → 5-hop', value: '5h-5h', description: 'Always the 5-hop Sphinx mixnet — strongest privacy (timing-attack resistant) but +seconds of latency. Best for a passive / observer node, not a block producer.' },
    ],
    default: 'fast-5h',
  });

  // ── 4. Bootstrap peers ──────────────────────────────────────────────────
  ui.heading('Bootstrap peers — who the node syncs from');
  ui.dim('The node needs ≥1 Logos testnet peer on a nym-allowed udp port (50000-65535). A known-good');
  ui.dim('peer is pre-filled below — keep it, or paste your own (ask the Logos team for a current one).');
  const peersRaw = await input({
    message: 'Peer multiaddr(s), space-separated:',
    default: process.env.BOOTSTRAP_PEERS || DEFAULT_PEERS.join(' '),
  });
  const peers = peersRaw.trim().split(/\s+/).filter(Boolean);

  // ── 5. Node settings ────────────────────────────────────────────────────
  ui.heading('Node settings');
  const swarmPort = Number(await input({ message: 'libp2p (swarm) port:', default: '3000', validate: numOk }));
  // Reject swarm/API collisions HERE (cheap) — they otherwise surface as an opaque
  // duplicate-bind failure minutes into `up`.
  const apiOk = (v) => (numOk(v) === true ? (Number(v) === swarmPort ? 'API port must differ from the swarm port' : true) : numOk(v));
  const apiPort = Number(await input({ message: 'HTTP API port:', default: '8080', validate: apiOk }));
  const onion = await confirm({ message: 'Expose the node API as a Tor .onion (anonymous access, no open ports)?', default: true });

  // ── 6. Save ─────────────────────────────────────────────────────────────
  const cfg = {
    version: 1, strategy, peers, swarmPort, apiPort, onion,
    genesisPrefix: DEFAULT_GENESIS_PREFIX,   // the testnet chain-start id the node joins
    createdAt: new Date().toISOString(),
  };
  save(cfg);
  if (!vaultReused) {
    ui.heading('Encrypt your credentials');
    ui.dim('Your Nym phrase is sealed with a passphrase you enter on every `diaphani up`. It never hits disk in plaintext.');
    ui.warn('If you LOSE this passphrase the vault can\'t be opened — back it up (password manager / paper). To start over, re-run `diaphani setup` with your Nym phrase.');
    const pass = await vault.newPassphrase();
    vault.encrypt({ nym }, pass);
    purgeLegacyPlaintext();
  }

  ui.nl();
  ui.ok('Saved to ~/.diaphani/  (credentials encrypted; config.json is non-secret)');

  // ── 7. Summary + next steps ─────────────────────────────────────────────
  ui.box('You\'re set up', [
    `${ui.c.dim('strategy')}  ${ui.accent(STRATEGIES[strategy].label)}`,
    `${ui.c.dim('peers   ')}  ${peers.length ? ui.accent(`${peers.length} set`) : ui.c.yellow('none yet — set BOOTSTRAP_PEERS before `up`')}`,
    `${ui.c.dim('node    ')}  swarm :${swarmPort}  ·  api :${apiPort}${onion ? '  ·  .onion API' : ''}`,
    '',
    `${ui.c.bold('Next:')}`,
    `  ${ui.accent('diaphani up')}             bring the masked node online`,
    `  ${ui.accent('diaphani status --follow')}  watch it sync`,
  ]);

  // Offer to install Docker now (otherwise `up` installs it on first run).
  if (!hasDocker && (await confirm({ message: 'Install Docker now? (otherwise `diaphani up` installs it on first run)', default: true }))) {
    await docker.ensureDocker();
  }
  if (!vault.exists()) ui.warn('Credential vault did not save — re-run setup.');

  // A previous run leaves the generated node config baked into the dia-data volume — `up`
  // reuses it, so these new settings (esp. the peer) would NOT take effect. Offer a clean
  // reset so `diaphani up` starts fresh from this config. Ideal for local testing.
  if (hasDocker) {
    const stale = (await docker.containerExists().catch(() => false)) || (await docker.dataVolumeExists().catch(() => false));
    if (stale) {
      ui.nl();
      ui.warn('An existing Diaphani node was found — its saved config would override these new settings on `up`.');
      if (await confirm({ message: 'Reset it so this config takes effect on the next `up`? (re-syncs the chain; keeps your .onion + credentials)', default: true })) {
        await docker.resetNode();
        ui.ok('Reset done — `diaphani up` will start fresh with this config.');
      } else {
        ui.dim('Left it as-is. To apply later: `diaphani down && docker volume rm dia-data && diaphani up`.');
      }
    }
  }
}

const numOk = (v) => (/^\d+$/.test(String(v).trim()) && +v > 0 && +v < 65536 ? true : 'enter a valid port');
