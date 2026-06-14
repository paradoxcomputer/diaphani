import fs from 'node:fs';
import { ui } from '../ui.js';
import { sleep } from '../run.js';
import * as vault from '../vault.js';
import * as docker from '../docker.js';
import { load, paths, STRATEGIES } from '../config.js';

export async function status(opts = {}) {
  const cfg = load();
  if (!cfg) {
    ui.banner();
    ui.warn('Not configured yet — run `diaphani setup`.');
    return;
  }

  if (!opts.follow) { ui.banner(); await render(cfg); return; }

  // --follow: clear + re-render every interval until Ctrl-C (like a dashboard).
  const interval = Math.max(2, Number(opts.interval) || 5) * 1000;
  process.once('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
  for (;;) {
    process.stdout.write('\x1b[2J\x1b[H'); // clear + home
    ui.banner();
    await render(cfg);
    ui.dim(`\n(following — refresh ${interval / 1000}s · Ctrl-C to stop)`);
    await sleep(interval);
  }
}

async function render(cfg) {
  ui.heading('Diaphani status');
  ui.kv('strategy', ui.accent(STRATEGIES[cfg.strategy]?.label || cfg.strategy));

  const s = await gather(cfg);

  ui.kv('runtime', s.up
    ? ui.badge('ok', 'container up')
    : ui.badge('bad', 'down — run `diaphani up`'));
  ui.kv('nym tunnel', s.nym.connected ? ui.badge('ok', `connected (${s.nym.mode})`) : ui.badge('bad', 'disconnected'));
  if (s.info) {
    // Node lifecycle: Online (caught up, following the tip) vs syncing (Bootstrapping / IBD).
    const synced = String(s.info.mode).toLowerCase() === 'online';
    const peers = s.net && s.net.n_peers != null ? `${s.net.n_peers} peer${s.net.n_peers === 1 ? '' : 's'}` : null;
    const detail = [s.info.height != null ? `height ${s.info.height}` : null, peers].filter(Boolean).join(' · ');
    ui.kv('node', (synced ? ui.badge('ok', 'Online — synced') : ui.badge('warn', `syncing (${s.info.mode || '…'})`)) +
      (detail ? ui.c.dim(`  · ${detail}`) : ''));
  } else {
    // No API yet: the container is up but the node/Nym are still coming up (connecting), or it's down.
    ui.kv('node', s.up ? ui.badge('warn', 'starting — connecting, API not up yet') : ui.badge('bad', 'not running — run `diaphani up`'));
  }
  ui.kv('egress', s.nym.exit
    ? ui.badge('ok', s.nym.exit) + ui.c.dim('  ← nym exit (what Logos peers see)')
    : ui.badge('warn', s.nym.connected ? 'connected (exit unknown)' : 'n/a'));
  if (cfg.onion) ui.kv('API .onion', s.onion ? ui.accent(s.onion) : ui.badge('warn', 'not published yet'));
  ui.kv('credentials', vault.exists() ? ui.badge('ok', 'encrypted vault (locked)') : ui.badge('warn', 'none — run setup'));

  ui.nl();
  ui.dim('Tip: `diaphani logs -f` to watch sync · `diaphani status --follow` for a live view.');
  if (fs.existsSync(paths.config)) ui.dim(`config: ${paths.config}`);
}

async function gather(cfg) {
  const up = await docker.containerRunning();
  const nym = parseNym(up ? await docker.containerNym() : '');
  let info = null, net = null;
  if (up) {
    try { info = JSON.parse(await docker.execApi(cfg.apiPort, '/cryptarchia/info')); } catch { /* API not up yet */ }
    try { net = JSON.parse(await docker.execApi(cfg.apiPort, '/network/info')); } catch { /* API not up yet */ }
  }
  const onion = up ? await docker.containerOnion() : '';
  return { up, nym, info, net, onion: onion || null };
}

function parseNym(out) {
  const head = (out.split('\n')[0] || '').trim();
  const connected = /Connected/i.test(head) && !/Disconnected/i.test(head);
  // Test the mixnet patterns FIRST: nym shows WireGuard/WG underlay details even in
  // 5-hop mixnet mode, so a 'wireguard'/'wg' substring must NOT win over an explicit
  // mixnet/5-hop indicator (otherwise a real 5-hop tunnel is mislabelled 'fast').
  const mode = /mixnet|5.?hop|anonymous|\bmix\b/i.test(out) ? '5-hop'
    : /two.?hop|fast|wireguard|\bwg\b/i.test(out) ? 'fast' : 'on';
  // nym status shows "... → <exit-ip>:port [<id>]" — grab the exit ip if present.
  const m = /→\s*([0-9.]+)/.exec(out) || /\bto ([0-9.]+)/i.exec(out);
  return { connected, mode, exit: m ? m[1] : null };
}
