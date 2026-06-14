// Thin shell-out helpers.
import { spawn } from 'node:child_process';

// The only env vars a privileged child legitimately needs from our process — the
// shell + tools (docker/ip/nft/curl/sudo/base64) read these. We DON'T forward the
// rest of our environment: anything sensitive must reach the child ONLY via the
// explicit `env` arg, never co-mingled with the whole inherited shell environment
// (which could itself hold a secret from a parent process). NOTE: under the current
// Docker-only model the mnemonic is delivered via a tmpfs bind-mount, NOT the env —
// the legacy NYM_*/ONION_* env-secret path no longer carries the mnemonic; this
// curation stays as defence in depth for any secret-bearing env on the sudo path.
const ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'TMPDIR', 'XDG_RUNTIME_DIR', 'SUDO_ASKPASS'];
function baseEnv() {
  const out = {};
  for (const k of ENV_PASSTHROUGH) if (process.env[k] != null) out[k] = process.env[k];
  // LC_* (locale) + DIAPHANI_* (documented user overrides, e.g. DIAPHANI_IMAGE /
  // DIAPHANI_CONTAINER). NOTE: these reach a privileged (sudo) child ONLY if the caller
  // also lists them in sudo's --preserve-env below — sudo's env_reset strips everything
  // else — so a DIAPHANI_* override does not take effect on the sudo path unless it is an
  // explicitly-injected `env` key. EXCEPT the vault passphrase (and its file path), which
  // are secret-bearing and must NEVER reach a privileged child's /proc/<pid>/environ or a
  // child core dump.
  for (const k in process.env) {
    if (k === 'DIAPHANI_PASSPHRASE' || k === 'DIAPHANI_PASSPHRASE_FILE') continue;
    if (k.startsWith('LC_') || k.startsWith('DIAPHANI_')) out[k] = process.env[k];
  }
  return out;
}

// Run a command. Returns { code, stdout, stderr }. Never throws on non-zero.
export function sh(cmd, { env = {}, cwd, privileged = false, stream = false } = {}) {
  // Disable core dumps for every child: their environment holds the decrypted
  // secrets, and a core dump would write that env to disk on a crash.
  const cmdNoCore = `ulimit -c 0 2>/dev/null; ${cmd}`;
  let line = cmd;
  if (privileged && process.getuid && process.getuid() !== 0) {
    // Forward ONLY the vars we explicitly injected (NYM_*/ONION_*/BOOTSTRAP_*…)
    // through sudo — not the user's entire environment (which `-E` would leak).
    // The names go raw into the sudo command line, so require POSIX identifiers
    // (no commas/spaces/metacharacters) — a hostile key can't inject sudo flags.
    const keys = Object.keys(env);
    if (!keys.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
      throw new Error('refusing to forward an environment variable with a non-POSIX name');
    }
    const pe = keys.length ? `--preserve-env=${keys.join(',')} ` : '';
    line = `sudo ${pe}bash -c ${shquote(cmdNoCore)}`;
  } else {
    line = `bash -c ${shquote(cmdNoCore)}`;
  }
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', line], {
      cwd,
      // Curated base (NOT the full process.env) + only the vars we explicitly inject,
      // so a decrypted secret never co-mingles with the inherited shell environment.
      env: { ...baseEnv(), ...env },
      stdio: stream ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    if (!stream) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
    }
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out.trim(), stderr: err.trim() }));
    child.on('error', (e) => resolve({ code: 127, stdout: '', stderr: e.message }));
  });
}

// Run and throw a friendly error on failure.
export async function shOk(cmd, opts = {}) {
  const r = await sh(cmd, opts);
  if (r.code !== 0) {
    throw new Error(`${opts.label || 'command failed'}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  return r.stdout;
}

// Capture stdout (empty string on failure).
export async function capture(cmd, opts = {}) {
  const r = await sh(cmd, opts);
  return r.code === 0 ? r.stdout : '';
}

function shquote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
