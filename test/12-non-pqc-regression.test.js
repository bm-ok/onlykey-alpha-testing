const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { OnlyKeyDevice, checkStatus, unlockDevice } = require('../lib/device');
const { VENV_BIN } = require('../lib/config');
const { enterConfigMode } = require('../lib/pqc_keygen');

// Maintainer's TC-15 (non-PQ regression): does this session's PQC-era
// firmware changes - process_packets()'s bounds-check fix, the reserved-slot
// guard added to OKSETPRIV's dispatch (okcore.cpp ~438-467), and
// okcrypto_decrypt()'s RESERVED_KEY_WEB_DERIVATION dispatch fix
// (okcrypto.cpp) - regress the *classic* (non-PQC) slot-label, ECC-key, and
// RSA-key paths sharing the same OKSETSLOT/OKSETPRIV dispatch cases?
//
// Confirmed via a static read of okcore.cpp before writing this test: classic
// ECC key generation (ecc_priv_flash(), keytype 1-3 = x25519/nist/secp256k1)
// and RSA key loading (rsa_priv_flash()) both have NO CRYPTO_AUTH
// button-confirmation gate at all - that gate is only entered
// `if (basetype == KEYTYPE_MLKEM768 || basetype == KEYTYPE_XWING)`
// (okcore.cpp ~5122-5148, the PQC keygen fix from TC-04). So unlike TC-04's
// PQC keygen, none of this needs challenge-digit automation - just config
// mode (OKSETPRIV/OKSETSLOT's shared `configmode==true` gate, confirmed the
// same pattern TC-08's hmackeymode/backupkeymode tests already rely on).
//
// RSA needs a real PGP-armored key fixture, not a raw byte format worth
// hand-rolling - client.py's loadkey() parses actual OpenPGP packets via the
// same OpenPGP.js bridge the web app uses (pgp_bridge.py). Generated fresh
// per run with the system `gpg` binary in an isolated GNUPGHOME (never
// touches the real user keyring), matching the rigor already established
// for TC-13's GPG identity tests.
function runCli(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'onlykey-cli'),
            args,
            { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
        );
    });
}

// Same shared-config-mode-session pattern as TC-08's backup/HMAC tests -
// configmode is a device-side flag with no explicit exit besides reboot, so
// entering it once here and reusing it across both its() below is both
// faster and matches established harness style. Now lib/pqc_keygen.js's
// shared enterConfigMode() helper (this file and TC-08 previously
// duplicated the same unlock+long-press-6 sequence locally); it already
// wraps the body in try/finally itself, for the same reason this file's
// local version did - an unclosed SeremuChannel on failure keeps a live
// HID handle open, which keeps Node's event loop alive and hangs the
// process after mocha's failure report instead of exiting (confirmed
// live - see TEST-PLAN.md - not a genuinely stuck operation).

function run(cmd, args, { timeoutMs = 20000, env } = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, env: env || process.env }, (err, stdout, stderr) =>
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
        );
    });
}

// Generates a fresh, throwaway RSA-2048 PGP key via the system `gpg` binary
// in an isolated GNUPGHOME (a tmpdir - never touches the real user
// keyring), exports it armored, and loads it onto the device via
// client.py's loadkey() (which parses it through the same OpenPGP.js
// bridge the web app uses). Returns the CLI-visible stdout/stderr from the
// load so the caller can assert on it.
async function generateAndLoadRsaKey({ slot = 1, features = 'd', passphrase = 'tc15-rsa-test-pass' } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc15-rsa-'));
    const gnupgHome = path.join(tmpDir, 'gnupghome');
    fs.mkdirSync(gnupgHome, { mode: 0o700 });
    const keyPath = path.join(tmpDir, 'key.asc');

    try {
        const gpgEnv = { ...process.env, GNUPGHOME: gnupgHome };
        const gen = await run('gpg', [
            '--batch', '--pinentry-mode', 'loopback', '--passphrase', passphrase,
            '--quick-generate-key', 'TC15 RSA Test <tc15-rsa-test@example.invalid>', 'rsa2048', 'encr', 'never',
        ], { timeoutMs: 30000, env: gpgEnv });
        assert.strictEqual(gen.code, 0, `gpg keygen failed:\n${gen.stderr}`);

        const exp = await run('gpg', [
            '--batch', '--pinentry-mode', 'loopback', '--passphrase', passphrase,
            '--armor', '--export-secret-keys', 'tc15-rsa-test@example.invalid',
        ], { timeoutMs: 15000, env: gpgEnv });
        assert.strictEqual(exp.code, 0, `gpg export failed:\n${exp.stderr}`);
        fs.writeFileSync(keyPath, exp.stdout);

        const pyScript = [
            'from onlykey.client import OnlyKey',
            `with open(${JSON.stringify(keyPath)}) as f:`,
            '    armored = f.read()',
            'ok = OnlyKey()',
            `ok.loadkey(armored, ${JSON.stringify(passphrase)}, slot=${slot}, key_features=${JSON.stringify(features)})`,
        ].join('\n');
        return await run(path.join(VENV_BIN, 'python3'), ['-c', pyScript], { timeoutMs: 20000 });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

describe('Non-PQ regression: slot labels, classic ECC + RSA keys (TC-15)', function () {
    this.timeout(90000);

    before(async function () {
        this.timeout(45000);
        await unlockDevice();
        await enterConfigMode();
    });

    it('sets a password-manager slot label without error (OKSETSLOT)', async function () {
        const result = await runCli(['setslot', '1a', 'label', 'tc15-regression-label']);
        assert.strictEqual(result.code, 0, `setslot label failed:\n${result.stderr}\n${result.stdout}`);
        assert.doesNotMatch(
            `${result.stdout}${result.stderr}`,
            /error/i,
            `unexpected error text:\n${result.stdout}${result.stderr}`
        );
    });

    it('generates a classic (non-PQC) x25519 ECC key on-device, no button confirmation needed', async function () {
        // ECC5 (slot 105) - untouched by this session's earlier PQC tests,
        // which used slot 101 (TC-04's default) and 103 (TC-06).
        const result = await runCli(['genkey', 'ECC5', 'x', 'd']);
        assert.strictEqual(result.code, 0, `genkey ECC5 failed:\n${result.stderr}\n${result.stdout}`);
        assert.match(
            `${result.stdout}${result.stderr}`,
            /successfully set ecc key/i,
            `expected success text, got:\n${result.stdout}${result.stderr}`
        );
    });

    it('loads a real RSA-2048 private key on-device, no button confirmation needed', async function () {
        this.timeout(60000); // gpg keygen + export + multi-message OKSETPRIV load
        const result = await generateAndLoadRsaKey({ slot: 1, features: 'd' });
        assert.strictEqual(result.code, 0, `RSA load failed:\n${result.stderr}\n${result.stdout}`);
        assert.match(
            `${result.stdout}${result.stderr}`,
            /successfully set rsa key/i,
            `expected success text, got:\n${result.stdout}${result.stderr}`
        );
    });
});
