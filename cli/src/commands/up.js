import { ui } from '../ui.js';
import { sleep } from '../run.js';
import * as vault from '../vault.js';
import * as docker from '../docker.js';
import { load, STRATEGIES, nymModeFor, graduateModeFor, DEFAULT_PEERS } from '../config.js';

// Logos bootstrap peers — from $BOOTSTRAP_PEERS (override) or the saved config, falling back to
// the built-in DEFAULT_PEERS. They MUST listen on a nym-allowed udp port (50000-65535) so the
// node reaches them straight through the tunnel. Validates + fails fast with an actionable message.
function resolvePeers(cfg) {
  const raw = (process.env.BOOTSTRAP_PEERS || (cfg && cfg.peers && cfg.peers.length ? cfg.peers.join(' ') : '') || '').trim();
  let peers = raw.split(/\s+/).filter(Boolean);
  if (!peers.length) peers = DEFAULT_PEERS.slice();   // built-in known-good testnet peer
  if (!peers.length) {
    throw new Error(
      'No bootstrap peers set. The node needs at least one Logos testnet peer on a\n' +
      '  nym-allowed udp port (50000-65535). Set it in `diaphani setup`, or pass it:\n' +
      '    BOOTSTRAP_PEERS="/ip4/<ip>/udp/54003/quic-v1/p2p/<peerid>" diaphani up',
    );
  }
  // Reject a /dns* (hostname) peer FIRST, with its own message: it would pass the
  // udp-port check but make the node's libp2p `.with_dns()` resolver issue a libc lookup
  // at dial time. That query goes to the container's resolv.conf (Docker's 127.0.0.11),
  // which forwards upstream from the HOST netns — OUTSIDE nym's tun, its kill-switch, and
  // the blackhole — leaking a DNS query for the peer hostname from the operator's REAL ip.
  // Only /ip4|/ip6 literals are reachable straight through the tunnel with no resolution.
  const named = peers.filter((p) => !isLiteralPeer(p));
  if (named.length) {
    throw new Error(
      'These bootstrap peers use a hostname (/dns, /dns4, /dns6, /dnsaddr), which the node\n' +
      '  would resolve via clearnet DNS OUTSIDE the nym tunnel — leaking your real IP. Use an\n' +
      `  /ip4/ or /ip6/ literal multiaddr instead:\n    ${named.join('\n    ')}`,
    );
  }
  const bad = peers.filter((p) => !isAllowedPeer(p));
  if (bad.length) {
    throw new Error(
      'These bootstrap peers are not on a nym-allowed udp port (50000-65535), so the\n' +
      `  node can't reach them through nym:\n    ${bad.join('\n    ')}`,
    );
  }
  return peers;
}
// A peer the node can reach straight through the tunnel with NO name resolution: the
// address component must be an /ip4/ or /ip6/ literal. A /dns*/ multiaddr would trigger
// an off-tunnel libc DNS lookup (see resolvePeers) — reject it.
function isLiteralPeer(ma) {
  return /\/ip[46]\//.test(ma);
}
function isAllowedPeer(ma) {
  const m = /\/udp\/(\d+)\//.exec(ma);
  const port = m ? Number(m[1]) : 0;
  return port >= 50000 && port <= 65535;
}

// Bring the masked node online in a privileged Docker container. The container IS the
// network namespace + ships every dependency; docker/entrypoint.sh does the masked
// bring-up (nym → node → .onion) and supervises itself. `up` just ensures Docker, builds
// the image, writes the mnemonic to a tmpfs, `docker run`s it, and waits for the API.
export async function up(opts = {}) {
  ui.banner();
  const cfg = load();
  if (!cfg) throw new Error('No config — run `diaphani setup` first.');
  if (!vault.exists()) throw new Error('No credential vault — run `diaphani setup` first.');

  const peers = resolvePeers(cfg);            // fail fast BEFORE the long build/run
  ui.heading('Preflight');
  await docker.ensureDocker();                // install Docker if missing + start the daemon
  ui.ok('Docker ready');

  await stage('Building the Diaphani image (first run only)', async () =>
    docker.ensureImage({ rebuild: !!opts.rebuild }).then(() => docker.IMAGE));

  // Decrypt the vault → write nym.txt to a tmpfs (RAM): the mnemonic never hits disk.
  const { obj: secrets } = await vault.unlock();
  const secretsDir = docker.writeSecrets(secrets.nym);
  secrets.nym = null;

  // The decrypted mnemonic now lives in the tmpfs file. Only `down` (or the next `up`)
  // wipes it, so if the bring-up THROWS before a container is live — runContainer fails,
  // or the wait loop sees the container exit — or the operator Ctrl-C's during the
  // multi-minute wait, scrub it now rather than orphan it on tmpfs until reboot. Once a
  // container is launched the secret belongs to its lifecycle (cleared on `down`).
  let launched = false;
  // Scrub the tmpfs mnemonic on an aborted `up` (Ctrl-C / systemd stop / hangup) before the
  // container owns it — SIGTERM/SIGHUP otherwise kill the process WITHOUT running the finally.
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => {
    const h = () => { if (!launched) docker.wipeSecrets(); process.exit(sig === 'SIGINT' ? 130 : 143); };
    process.once(sig, h);
    return [sig, h];
  });
  try {
    // v3 client-auth is the ONLY access control on the unauthenticated node API. The
    // container installs the operator's pubkeys (mounted by runContainer); warn here if
    // the onion is on but unguarded.
    if (cfg.onion && !docker.hasOnionAuth()) {
      ui.warn('.onion has NO client-auth — anyone with the address could call the node API. Run `diaphani clientauth <name>` first.');
    }

    await stage('Starting the masked node container', async () => {
      await docker.runContainer({
        secretsDir,
        env: {
          BOOTSTRAP_PEERS: peers.join(' '),
          NYM_MODE: nymModeFor(cfg.strategy),       // the mode to connect in (fast|anon)
          GRADUATE: graduateModeFor(cfg.strategy),  // switch to this once synced (anon), or ''
          ENABLE_ONION: cfg.onion ? '1' : '0',
          API_PORT: String(cfg.apiPort || 8080),
          SWARM_PORT: String(cfg.swarmPort || 3000),
        },
      });
      return docker.CONTAINER;
    });
    launched = true;                          // container exists — `down` owns the secret now

    ui.dim('The container is connecting Nym, starting the node, and publishing the .onion');
    ui.dim('— a few minutes on first run (Nym handshake + node init). Follow with `diaphani logs -f`.');
    let onion = null, info = null;
    await stage(cfg.onion ? 'Waiting for the node + .onion' : 'Waiting for the node', async () => {
      // Success = the node API answers; the .onion is only required when it's enabled.
      // (An onion-disabled run would otherwise burn the whole 5 min waiting on an onion
      // that never publishes; an onion-enabled run keeps polling only the onion.)
      const done = () => info && (!cfg.onion || onion);
      for (let i = 0; i < 60; i++) {            // ~5 min
        if (cfg.onion && !onion) onion = (await docker.containerOnion()) || null;
        try { info = JSON.parse(await docker.execApi(cfg.apiPort || 8080, '/cryptarchia/info')); } catch { /* not up yet */ }
        if (done()) break;
        if (!(await docker.containerRunning())) throw new Error('the container exited during bring-up — see `diaphani logs`');
        await sleep(5000);
      }
      // The loop may have run out without confirming success — make sure we don't
      // report "still starting" for a container that has since exited.
      if (!done() && !(await docker.containerRunning())) {
        throw new Error('the container exited during bring-up — see `diaphani logs`');
      }
      return onion ? `.onion ${onion}` : info ? `node ${info.mode || 'up'}` : 'still starting — see `diaphani logs`';
    });

    const entry = nymModeFor(cfg.strategy) === 'fast' ? 'Fast Mode (2-hop)' : '5-hop mixnet';
  const nymMode = graduateModeFor(cfg.strategy) ? `${entry} → 5-hop mixnet (graduates once synced)` : entry;
    ui.box('Diaphani is up', [
      `${ui.c.dim('strategy ')}  ${ui.accent((STRATEGIES[cfg.strategy] || {}).label || cfg.strategy)}`,
      `${ui.c.dim('nym mode ')}  ${ui.accent(nymMode)}`,
      onion ? `${ui.c.dim('API .onion')}  ${ui.accent(onion)}` : `${ui.c.dim('API       ')}  starting — run \`diaphani status\``,
      `${ui.c.dim('watch    ')}  ${ui.accent('diaphani status --follow')}  ·  ${ui.accent('diaphani logs -f')}`,
    ]);
  } finally {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    if (!launched) docker.wipeSecrets();      // no live container → don't orphan the mnemonic
  }
}

async function stage(label, fn) {
  const spin = ui.spinner(label + '…').start();
  try {
    const detail = await fn();
    spin.succeed(label + (detail ? ` — ${ui.c.dim(detail)}` : ''));
  } catch (e) {
    spin.fail(label + ` — ${ui.c.red(e.message)}`);
    throw e;
  }
}
