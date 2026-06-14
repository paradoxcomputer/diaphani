// The Docker run model — the DEFAULT. The container IS the network namespace and ships
// every dependency + glibc 2.39 (docker/entrypoint.sh does the masked bring-up: nym →
// node → .onion). So `diaphani up` just ensures Docker, builds the image, writes the
// secret to a tmpfs, and `docker run`s it; the container supervises itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh, shOk, capture, sleep } from './run.js';
import { which } from './system.js';
import { ensureSudo } from './privilege.js';
import { ui } from './ui.js';
import { dockerDir } from './config.js';

// Host dir holding the v3 onion client-auth PUBLIC keys (`<name>.auth`), written by
// `diaphani clientauth`. Bind-mounted read-only into the container so the entrypoint
// can install them into the live HiddenServiceDir — without this the Docker onion runs
// with NO client-auth (the only access control on the unauthenticated node API).
export function onionAuthDir() { return path.join(os.homedir(), '.diaphani', 'onion_authorized_clients'); }
export function hasOnionAuth() {
  try { return fs.readdirSync(onionAuthDir()).some((f) => f.endsWith('.auth')); } catch { return false; }
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// IMAGE/CONTAINER are overridable via env — validate to a strict Docker-name charset
// (defence in depth; they are also q()-quoted at every use) so a hostile value can't
// smuggle shell metacharacters or `docker` flags into a command.
function envName(name, dflt, re) {
  const v = process.env[name] || dflt;
  if (!re.test(v)) throw new Error(`${name}=${v} is not a valid Docker name (allowed: ${re})`);
  return v;
}
export const IMAGE = envName('DIAPHANI_IMAGE', 'diaphani:local', /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/);
export const CONTAINER = envName('DIAPHANI_CONTAINER', 'diaphani', /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

// Most installs add you to the `docker` group (no sudo), but a fresh `docker.io`
// install does not until you re-login — so detect once and prefix `sudo` if needed.
let _prefix;
async function prefix() {
  if (_prefix !== undefined) return _prefix;
  const r = await sh('docker info');
  if (r.code === 0) return (_prefix = '');
  if (process.getuid && process.getuid() === 0) return (_prefix = '');
  // Only fall back to (and CACHE) sudo on a genuine permission/socket-access error.
  // A daemon that is merely DOWN also fails `docker info`, but for a connection
  // reason — caching 'sudo ' there would force every later docker call through sudo
  // for the whole run even after ensureDaemon() starts it. So defer (return '' WITHOUT
  // caching) and let a later probe (post-start) re-decide.
  if (!/permission denied|EACCES|connect: permission/i.test(r.stderr)) return '';
  await ensureSudo();
  return (_prefix = 'sudo ');
}
async function dk(args, opts = {}) { return sh(`${await prefix()}docker ${args}`, opts); }
async function dkOk(args, opts = {}) {
  const r = await dk(args, opts);
  if (r.code !== 0) throw new Error(`${opts.label || 'docker'}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  return r.stdout;
}

export async function hasDocker() { return !!(await which('docker')); }

// Install Docker if missing (apt: docker.io) + ensure the daemon is up. Throws with
// guidance on non-apt hosts (where we can't auto-install).
export async function ensureDocker() {
  if (!(await hasDocker())) {
    if (!(await which('apt-get'))) {
      throw new Error(
        'Docker is required but is not installed, and this host is not apt-based.\n' +
        '  Install Docker — https://docs.docker.com/engine/install/ — then re-run `diaphani up`.',
      );
    }
    ui.warn('Docker not found — installing it (docker.io)…');
    await ensureSudo();
    await shOk('apt-get update -qq && apt-get install -y docker.io', { privileged: true, stream: true, label: 'install docker' });
    await sh('systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true', { privileged: true });
    if (!(await hasDocker())) {
      throw new Error('installed docker.io but the `docker` command is still not on PATH — open a new shell and re-run `diaphani up`.');
    }
    ui.ok('Docker installed');
  }
  await ensureDaemon();
}

async function ensureDaemon() {
  if ((await dk('info')).code === 0) return;
  await sh('systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true', { privileged: true });
  // The daemon can take a few seconds to accept connections (loaded host, slow
  // systemd) — poll instead of checking exactly once after a fixed sleep.
  for (let i = 0; i < 6; i++) {
    await sleep(1500);
    if ((await dk('info')).code === 0) return;
  }
  throw new Error('the Docker daemon is not reachable — start it (`sudo systemctl start docker`) and re-run.');
}

export async function imageExists(tag = IMAGE) {
  return (await dk(`image inspect ${tag} --format {{.Id}}`)).code === 0;
}

// Build the image from the bundled Dockerfile. The build CONTEXT is the PARENT of
// dockerDir, so the Dockerfile's `COPY docker/entrypoint.sh` resolves (in-repo and
// from the published npm package alike). Streams the build output.
export async function ensureImage({ rebuild = false } = {}) {
  if (!rebuild && (await imageExists())) return IMAGE;
  const dfile = path.join(dockerDir, 'Dockerfile');
  if (!fs.existsSync(dfile)) throw new Error(`Dockerfile not found at ${dfile} (set DIAPHANI_DOCKER to the dir that holds it)`);
  const ctx = path.resolve(dockerDir, '..');
  await shOk(`${await prefix()}docker build -f ${q(dfile)} -t ${q(IMAGE)} ${q(ctx)}`, { stream: true, label: 'docker build' });
  return IMAGE;
}

export async function containerExists() {
  return (await capture(`${await prefix()}docker ps -a --filter ${q(`name=^/${CONTAINER}$`)} --format {{.Names}}`)) === CONTAINER;
}
export async function containerRunning() {
  return (await capture(`${await prefix()}docker ps --filter ${q(`name=^/${CONTAINER}$`)} --format {{.Names}}`)) === CONTAINER;
}

// STRICT existence probe for the teardown path. The capture()-based variants above
// return '' on ANY non-zero exit, so a daemon fault (socket EACCES, daemon restarting/
// OOM, lost perms) is indistinguishable from "container absent" — both look like "gone".
// That is the dangerous direction for `down`: it would scrub the mnemonic + report
// success while the masked node + its .onion are still live behind a briefly-unreachable
// daemon. So surface a docker-query failure as a throw; only a clean exit may answer.
async function containerExistsStrict() {
  const r = await dk(`ps -a --filter ${q(`name=^/${CONTAINER}$`)} --format {{.Names}}`);
  if (r.code !== 0) throw new Error(`could not query docker (daemon down?): ${r.stderr || `exit ${r.code}`}`);
  return r.stdout === CONTAINER;
}

// The per-CONTAINER tmpfs dir that holds the bind-mounted nym.txt. Namespaced by
// CONTAINER so two instances (different DIAPHANI_CONTAINER) never race on one file.
function secretsParent() {
  // RAM-backed only — the mnemonic must NEVER touch persistent disk. os.tmpdir()
  // (/tmp) is persistent on most hosts, so we refuse to fall back to it.
  const ram = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR)
    ? process.env.XDG_RUNTIME_DIR
    : (fs.existsSync('/dev/shm') ? '/dev/shm' : null);
  if (!ram) throw new Error('no RAM-backed dir (XDG_RUNTIME_DIR or /dev/shm) to hold the decrypted mnemonic — refusing to write it to persistent disk');
  return ram;
}
function secretsDir() { return path.join(secretsParent(), `diaphani-secrets-${CONTAINER}`); }

// Decrypt-then-mount: write nym.txt into a RAM-backed (tmpfs) dir so the mnemonic NEVER
// touches persistent disk (preserves the encrypted-vault property), chmod 700. Returns
// the dir to bind-mount read-only at /diaphani/secrets.
export function writeSecrets(nym) {
  const dir = secretsDir();
  // Refuse a pre-existing SYMLINK (a 1777 tmpfs lets an attacker pre-create one at our
  // fixed name to redirect the 0600 mnemonic into a dir they own) — remove it first so
  // mkdir creates a real, uid-owned dir.
  try { if (fs.lstatSync(dir).isSymbolicLink()) fs.rmSync(dir, { force: true }); } catch { /* not present */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is ignored when the dir already exists (a prior run, or a
  // pre-created one) — force 0700 so a loosely-permissioned dir can't expose the
  // mnemonic we're about to write into it.
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'nym.txt'), String(nym).trim() + '\n', { mode: 0o600 });
  return dir;
}

// Overwrite-then-remove the tmpfs mnemonic. Called on `down` so the plaintext does
// not linger on tmpfs for the whole container life + beyond (until reboot).
export function wipeSecrets() {
  let f;
  try { f = path.join(secretsDir(), 'nym.txt'); } catch { return; } // no tmpfs → nothing written
  try {
    if (fs.existsSync(f)) {
      try { fs.writeFileSync(f, '\0'.repeat(Math.max(1, fs.statSync(f).size)), { mode: 0o600 }); } catch { /* best-effort scrub */ }
      fs.rmSync(f, { force: true });
    }
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// Run the masked-node container. secretsDir holds nym.txt (mounted ro). env carries
// BOOTSTRAP_PEERS / NYM_MODE / ENABLE_ONION / API_PORT / SWARM_PORT to the entrypoint.
export async function runContainer({ secretsDir, env = {} }) {
  if (await containerExists()) await dkOk(`rm -f ${q(CONTAINER)}`, { label: 'remove stale container' });
  await dkOk('volume create dia-data', { label: 'create volume dia-data' });
  await dkOk('volume create dia-onion', { label: 'create volume dia-onion' });
  const e = Object.entries(env).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `-e ${k}=${q(String(v))}`).join(' ');
  // Mount the operator's onion client-auth pubkeys read-only so the entrypoint enforces
  // them. Only when at least one `.auth` exists — an empty mount would just leave the
  // onion open with no signal.
  const authMount = hasOnionAuth() ? `-v ${q(onionAuthDir())}:/diaphani/onion_authorized_clients:ro ` : '';
  await dkOk(
    `run -d --name ${q(CONTAINER)} --privileged --restart unless-stopped ` +
    `-v ${q(secretsDir)}:/diaphani/secrets:ro -v dia-data:/diaphani/data -v dia-onion:/diaphani/onion ` +
    `${authMount}${e} ${q(IMAGE)}`,
    { label: 'docker run' },
  );
}

// Stop the container if it exists — gated on the STRICT probe so a daemon fault throws
// (surfacing "couldn't reach docker") instead of silently skipping the stop and letting
// `down` march on to wipe the secret while the node is still live.
export async function stopContainer() { if (await containerExistsStrict()) await dk(`stop -t 10 ${q(CONTAINER)}`); }
// Remove the container and PROVE it is gone. Use the STRICT probe: `dk` never throws, so a
// failed `rm` (perms lost, daemon died mid-teardown, wedged container) OR a daemon that is
// simply unreachable would otherwise be reported as success while the masked node + its
// onion stay live — the strict probe turns an un-queryable daemon into a hard error.
export async function removeContainer() {
  if (await containerExistsStrict()) await dk(`rm -f ${q(CONTAINER)}`);
  if (await containerExistsStrict()) throw new Error(`container ${CONTAINER} still exists after \`docker rm -f\` — it may still be running. Remove it manually: docker rm -f ${CONTAINER}`);
}

// Does the chain-DB + generated-node-config volume exist? (A leftover dia-data shadows new
// `setup` settings — its persisted node config is reused on the next `up`.)
export async function dataVolumeExists() {
  return (await capture(`${await prefix()}docker volume ls --filter ${q('name=^dia-data$')} --format {{.Name}}`)) === 'dia-data';
}
// Reset the node to a clean slate so the next `up` regenerates its config from scratch: stop +
// remove the container, then drop the dia-data volume (chain DB + the baked node config/keys).
// KEEPS dia-onion (stable .onion address) + the host vault. Used by `setup` for local testing.
export async function resetNode() {
  await stopContainer();
  await removeContainer();
  // dk() never throws, so a failed `volume rm` (in-use by a second instance sharing dia-data,
  // EACCES/lost perms, transient daemon fault) would be swallowed and setup would report
  // "Reset done" while the stale baked node config silently persists. PROVE the volume is gone
  // (mirrors removeContainer's strict pattern): an "already absent" rm is success, a still-
  // present volume is a hard error with actionable guidance.
  await dk(`volume rm dia-data`);   // no-op if absent; container already gone so not in-use by it
  if (await dataVolumeExists()) {
    throw new Error('could not remove the dia-data volume after `docker volume rm` — is another container still using it? Remove it manually: docker volume rm dia-data');
  }
}

// Stream the container's logs to the terminal (optionally follow).
export async function streamLogs({ follow = false, tail = 200 } = {}) {
  const n = Math.max(1, Number(tail) || 200);   // coerce to a positive integer — never trust the caller
  const f = follow ? '-f ' : '';
  return sh(`${await prefix()}docker logs ${f}--tail ${n} ${q(CONTAINER)}`, { stream: true });
}

// Query the node API + nym + onion from inside the container (read-only).
export async function execApi(apiPort, apiPath) {
  const port = Number(apiPort) || 8080;
  return capture(`${await prefix()}docker exec ${q(CONTAINER)} curl -s --max-time 5 ${q(`http://127.0.0.1:${port}${apiPath}`)} 2>/dev/null`);
}
export async function containerNym() {
  return capture(`${await prefix()}docker exec ${q(CONTAINER)} nym-vpnc status 2>/dev/null`);
}
export async function containerOnion() {
  return validOnion(await capture(`${await prefix()}docker exec ${q(CONTAINER)} cat /diaphani/onion/api/hostname 2>/dev/null`));
}

// A v3 onion hostname is exactly 56 base32 chars + ".onion". The hostname file can
// hold a partially-written, stale (prior key/aborted run), or error value — only a
// well-formed address is a real published address; anything else is "not yet".
export function validOnion(s) {
  const v = String(s || '').trim();
  return /^[a-z2-7]{56}\.onion$/.test(v) ? v : '';
}
