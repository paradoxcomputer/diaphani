// Passphrase-encrypted credential vault: scrypt KDF + AES-256-GCM (authenticated),
// using only Node's built-in crypto — no external tool (age/gpg/openssl) needed.
// The plaintext (the Nym recovery phrase) never touches persistent disk;
// it is decrypted into memory once per `up` and held only for that run.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { password } from '@inquirer/prompts';
import { ui } from './ui.js';
import { paths, ensureDir } from './config.js';

// scrypt cost: ~tens of ms on a modern CPU; tunable. maxmem must cover 128*N*r.
const KDF = { N: 2 ** 16, r: 8, p: 1 };
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;

export function exists() {
  return fs.existsSync(paths.vault);
}

function deriveKey(passphrase, salt, params) {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEYLEN, {
    N: params.N, r: params.r, p: params.p, maxmem: MAXMEM,
  });
}

export function encrypt(obj, passphrase) {
  ensureDir();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt, KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const blob = {
    v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  // Atomic write: a crash mid-rewrite must never truncate the vault and lose the
  // credentials. Under the Docker-only model the vault holds just the Nym phrase —
  // the onion key lives in the dia-onion volume (unencrypted), not sealed here.
  const tmp = `${paths.vault}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(blob) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, paths.vault);
  fs.chmodSync(paths.vault, 0o600);
}

// Throws on a wrong passphrase (GCM auth failure) or a corrupted/missing vault.
export function decrypt(passphrase) {
  const blob = JSON.parse(fs.readFileSync(paths.vault, 'utf8'));
  const key = deriveKey(passphrase, Buffer.from(blob.salt, 'base64'), { N: blob.N, r: blob.r, p: blob.p });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  let pt;
  try {
    pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error('wrong passphrase (or corrupted vault)');
  }
  try {
    return JSON.parse(pt.toString('utf8'));
  } finally {
    pt.fill(0); // wipe the plaintext buffer (parsed strings still live in V8 until GC)
  }
}

// Unlock the vault. For unattended runs (`diaphani up --yes` under systemd/cron),
// the passphrase may come from DIAPHANI_PASSPHRASE_FILE (preferred — a file is not
// visible in /proc/<pid>/environ) or DIAPHANI_PASSPHRASE; otherwise it prompts.
// Returns { obj, pass }.
export async function unlock(message = 'Passphrase to unlock your credentials:', tries = 3) {
  const passFile = process.env.DIAPHANI_PASSPHRASE_FILE;
  const envPass = passFile
    ? fs.readFileSync(passFile, 'utf8').replace(/\r?\n$/, '')
    : process.env.DIAPHANI_PASSPHRASE;
  // Drop the plaintext passphrase from our own environ the moment we've read it, so it
  // is not inherited by any child we later spawn (defence in depth alongside run.js,
  // which already skips it in the privileged-child env).
  const envSrc = passFile ? null : process.env.DIAPHANI_PASSPHRASE;
  if (envSrc != null) delete process.env.DIAPHANI_PASSPHRASE;
  // A set-but-empty/whitespace env or file passphrase is a misconfiguration, not an
  // "unattended path not chosen" — say so plainly instead of falling through to the
  // prompt (or the misleading non-TTY "no env passphrase set" error below).
  if (envSrc != null && !envPass) {
    throw new Error('DIAPHANI_PASSPHRASE is set but empty — set it to your vault passphrase, or unset it to be prompted.');
  }
  if (passFile != null && !envPass) {
    throw new Error(`DIAPHANI_PASSPHRASE_FILE (${passFile}) is empty — write your vault passphrase to it, or unset it to be prompted.`);
  }
  if (envPass) {
    try {
      return { obj: decrypt(envPass), pass: envPass };
    } catch {
      throw new Error(`the passphrase from ${passFile ? 'DIAPHANI_PASSPHRASE_FILE' : 'DIAPHANI_PASSPHRASE'} does not unlock the vault`);
    }
  }
  // Non-interactive (systemd/cron/CI) with no env passphrase → fail fast with guidance,
  // not a confusing inquirer "no TTY" stack trace.
  if (!process.stdin.isTTY) {
    throw new Error(
      'The vault is locked and there is no terminal to prompt for the passphrase.\n' +
      '  For unattended runs set DIAPHANI_PASSPHRASE_FILE=/path/to/file (preferred — not\n' +
      '  visible in /proc) or DIAPHANI_PASSPHRASE, then re-run — or run it in a terminal.',
    );
  }
  for (let i = 0; i < tries; i++) {
    const pass = await password({ message, mask: '•' });
    try {
      return { obj: decrypt(pass), pass };
    } catch {
      if (i < tries - 1) ui.warn('wrong passphrase — try again');
      else throw new Error('wrong passphrase (or corrupted vault). For unattended runs, set DIAPHANI_PASSPHRASE_FILE or DIAPHANI_PASSPHRASE and re-run.');
    }
  }
}

// Prompt for a new passphrase twice and require a match (min 8 chars).
export async function newPassphrase() {
  for (;;) {
    const a = await password({ message: 'New passphrase (you enter this on every `diaphani up`):', mask: '•', validate: (v) => (v.length >= 8 ? true : 'use at least 8 characters') });
    const b = await password({ message: 'Confirm passphrase:', mask: '•' });
    if (a === b) return a;
    ui.warn('passphrases did not match — try again');
  }
}
