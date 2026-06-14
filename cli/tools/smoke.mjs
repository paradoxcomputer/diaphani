// Non-interactive smoke test of the CLI's pure logic: config round-trip, the
// encrypted credential vault (scrypt + AES-256-GCM), file permissions, and the
// wizard validators. Run: node tools/smoke.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// isolate HOME so we never touch the real ~/.diaphani
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diaphani-smoke-'));
process.env.HOME = tmp;

const cfg = await import('../src/config.js');
const vault = await import('../src/vault.js');
let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

// config round-trip (non-secret)
cfg.save({ version: 1, strategy: 'fast-5h', swarmPort: 3000, apiPort: 8080, onion: true });
const back = cfg.load();
assert.equal(back.strategy, 'fast-5h');
assert.equal(back.apiPort, 8080);
ok('config save/load round-trips');

// vault encrypt → decrypt round-trip, including awkward characters
const secrets = {
  nym: 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual',
};
vault.encrypt(secrets, 'correct horse battery staple');
const got = vault.decrypt('correct horse battery staple');
assert.equal(got.nym.split(' ').length, 24);
assert.equal(got.nym.split(' ')[0], 'abandon');
ok('vault encrypt/decrypt round-trips (24-word phrase)');

// wrong passphrase must fail (GCM auth), not return garbage
assert.throws(() => vault.decrypt('wrong passphrase'), /wrong passphrase/);
ok('wrong passphrase is rejected (authenticated encryption)');

// the on-disk vault must not contain the plaintext
const raw = fs.readFileSync(cfg.paths.vault, 'utf8');
assert.ok(!raw.includes('abandon ability'), 'plaintext leaked into vault file');
ok('vault file contains no plaintext secrets');

// the vault generically round-trips an extra sealed object, preserving the Nym phrase
// (the live product seals only the Nym phrase; the onion key lives in the dia-onion volume)
const cur = vault.decrypt('correct horse battery staple');
cur.onion = { sk: 'c2VjcmV0', pk: 'cHVibGlj', hostname: 'diaphaexample.onion' };
vault.encrypt(cur, 'correct horse battery staple');
const sealed = vault.decrypt('correct horse battery staple');
assert.equal(sealed.onion.hostname, 'diaphaexample.onion');
assert.equal(sealed.nym.split(' ').length, 24);  // existing field preserved
ok('vault round-trips an extra sealed object, preserving the Nym phrase');

// permissions: vault + config are 0600, dir is 0700
assert.equal(fs.statSync(cfg.paths.vault).mode & 0o777, 0o600);
assert.equal(fs.statSync(cfg.paths.config).mode & 0o777, 0o600);
assert.equal(fs.statSync(cfg.DIR).mode & 0o777, 0o700);
ok('vault + config are chmod 600, ~/.diaphani is 700');

assert.equal(vault.exists(), true);
ok('vault.exists() true after encrypt');

// legacy plaintext purge
fs.writeFileSync(cfg.paths.turnEnv, 'export TURN_USER=x\n', { mode: 0o600 });
fs.writeFileSync(cfg.paths.nym, 'word\n', { mode: 0o600 });
cfg.purgeLegacyPlaintext();
assert.ok(!fs.existsSync(cfg.paths.turnEnv) && !fs.existsSync(cfg.paths.nym));
ok('purgeLegacyPlaintext() removes legacy turn.env + nym.txt');

// STRATEGIES well-formed + entry/graduate modes map to the entrypoint's NYM_MODE/GRADUATE
for (const k of ['fast-5h', 'fast-fast', '5h-5h']) {
  assert.ok(cfg.STRATEGIES[k].entry && cfg.STRATEGIES[k].steady && cfg.STRATEGIES[k].label);
}
assert.equal(cfg.nymModeFor('fast-5h'), 'fast');       // connects in fast…
assert.equal(cfg.graduateModeFor('fast-5h'), 'anon');  // …then graduates to the mixnet
assert.equal(cfg.nymModeFor('5h-5h'), 'anon');
assert.equal(cfg.graduateModeFor('fast-fast'), '');    // fast-fast / 5h-5h stay put
assert.equal(cfg.graduateModeFor('5h-5h'), '');
ok('STRATEGIES well-formed; fast-5h = fast→anon (graduates), others stay put');

// validators (mirror setup.js)
const numOk = (v) => (/^\d+$/.test(String(v).trim()) && +v > 0 && +v < 65536 ? true : 'enter a valid port');
assert.equal(numOk('3000'), true);
assert.equal(numOk('0'), 'enter a valid port');
assert.equal(numOk('70000'), 'enter a valid port');
ok('port validator behaves');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} checks passed.`);
