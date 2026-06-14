// Config + secrets live under ~/.diaphani (secrets are chmod 600, never logged).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..'); // .../diaphani/cli

export const DIR = path.join(os.homedir(), '.diaphani');
export const paths = {
  config: path.join(DIR, 'config.json'),
  vault: path.join(DIR, 'secrets.enc'), // passphrase-encrypted Nym phrase
  turnEnv: path.join(DIR, 'turn.env'),  // legacy plaintext (purged if a pre-TURN-removal run left one)
  nym: path.join(DIR, 'nym.txt'),       // legacy plaintext (migrated away + removed)
};

// The bundled bash scripts. Only one survives: diaphani-clientauth.sh, the v3 onion
// client-auth keypair generator (used by both `clientauth` and, via the bind-mount,
// the container). The masked bring-up itself lives entirely in docker/entrypoint.sh.
export const scriptsDir =
  process.env.DIAPHANI_SCRIPTS ||
  (fs.existsSync(path.join(PKG_ROOT, 'scripts', 'diaphani-clientauth.sh'))
    ? path.join(PKG_ROOT, 'scripts')
    : path.resolve(PKG_ROOT, '..', 'scripts'));

// The bundled docker assets (Dockerfile + entrypoint.sh). The build CONTEXT is the
// PARENT of this dir, so the Dockerfile's `COPY docker/entrypoint.sh` resolves both
// in-repo and when installed from npm (where dockerDir = <pkg>/docker).
export const dockerDir =
  process.env.DIAPHANI_DOCKER ||
  (fs.existsSync(path.join(PKG_ROOT, 'docker', 'Dockerfile'))
    ? path.join(PKG_ROOT, 'docker')
    : path.resolve(PKG_ROOT, '..', 'docker'));

// The masked node runs in a privileged Docker container — the only run model. The
// container IS the network namespace, ships every dependency + glibc 2.39, runs the
// fail-closed nym kill-switch internally, and a bad run is just `docker rm`.

// Anonymity strategy: an (entry, steady) pair of Nym modes. `fast` = 2-hop WireGuard (low
// latency); `anon` = the 5-hop Sphinx mixnet (max anonymity, +latency). `fast-5h` GRADUATES
// — the container syncs on Fast Mode then switches to the mixnet once the node is Online; the
// other two stay in one mode for the container's life. Picked once in `diaphani setup`.
export const STRATEGIES = {
  'fast-5h': { entry: 'fast', steady: 'anon', label: 'fast → 5-hop  (sync fast, then switch to max anonymity)' },
  'fast-fast': { entry: 'fast', steady: 'fast', label: 'fast → fast  (2-hop WireGuard — hide your IP, low latency)' },
  '5h-5h': { entry: 'anon', steady: 'anon', label: '5-hop → 5-hop  (always the mixnet — max anonymity, slower)' },
};

// The ENTRY nym mode the container connects in (the entrypoint's NYM_MODE: fast|anon).
// Tolerates an unknown/legacy key by falling back to a sane default.
export function nymModeFor(strategy) {
  const s = STRATEGIES[strategy];
  return s ? s.entry : (strategy === '5h-5h' || strategy === 'mixnet' ? 'anon' : 'fast');
}

// The mode the container GRADUATES to once the node is synced, or '' if it stays put. Only
// `fast-5h` graduates (fast → anon); the entrypoint reads this as $GRADUATE.
export function graduateModeFor(strategy) {
  const s = STRATEGIES[strategy];
  if (s) return s.steady !== s.entry ? s.steady : '';
  return strategy === 'fast-5h' ? 'anon' : '';
}

// Built-in default Logos testnet bootstrap peer(s) — a known-good 0.1.2 node on a nym-allowed
// udp port (50000-65535), used when the operator hasn't set their own (via `setup` or
// $BOOTSTRAP_PEERS). The peer-id is kept here for reference; the container's entrypoint strips
// the trailing /p2p/<id> before `init -p` (0.1.2 wants initial_peers without it). Override any
// time with `diaphani setup` or BOOTSTRAP_PEERS="…".
export const DEFAULT_PEERS = [
  '/ip4/51.83.134.116/udp/54003/quic-v1/p2p/12D3KooWBsDmW1YcmcxxLrpaWViGWLshfwtwvD9U3xicWnjSDbak',
];

export function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

export function exists() {
  return fs.existsSync(paths.config);
}

export function load() {
  if (!exists()) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch (e) {
    throw new Error(`config at ${paths.config} is unreadable/corrupt (${e.message}). Fix or delete it and re-run \`diaphani setup\`.`);
  }
  // Re-validate the numeric fields here (not just in setup's prompts) so a hand-edited or
  // partially-written config.json fails fast with an actionable message instead of flowing
  // unchecked into the container env / API URLs and an opaque mid-bring-up failure.
  for (const k of ['apiPort', 'swarmPort']) {
    if (cfg[k] == null) continue;
    const n = Number(cfg[k]);
    if (!(Number.isInteger(n) && n > 0 && n < 65536)) {
      throw new Error(`config ${k}=${cfg[k]} is not a valid port — fix ${paths.config} or re-run \`diaphani setup\`.`);
    }
  }
  if (cfg.apiPort != null && Number(cfg.apiPort) === Number(cfg.swarmPort)) {
    throw new Error(`config apiPort must differ from swarmPort — fix ${paths.config} or re-run \`diaphani setup\`.`);
  }
  return cfg;
}

export function save(cfg) {
  ensureDir();
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// Remove any legacy plaintext secret files (superseded by the encrypted vault).
export function purgeLegacyPlaintext() {
  for (const p of [paths.turnEnv, paths.nym]) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
}
