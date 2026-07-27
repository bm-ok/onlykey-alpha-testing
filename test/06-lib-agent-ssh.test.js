const assert = require('assert');
const path = require('path');
const { execFile } = require('child_process');
const { OnlyKeyDevice, checkStatus, unlockDevice } = require('../lib/device');
const { VENV_BIN } = require('../lib/config');

// Maintainer's TC-13: confirm the PQC-era firmware/CLI changes this session
// made (process_packets() bounds-check fix, okcrypto_decrypt() dispatch
// fix, reserved-slot validation) didn't regress the existing, non-PQC
// SSH/GPG derived-key path lib-agent depends on.
//
// libagent/ssh's main() (see ssh/__init__.py ~262-320): with no
// command/--daemonize/--foreground/--connect/--shell given, it just prints
// the device's SSH public key(s) to stdout and exits 0 - no SSH server, no
// shell, no device-state mutation. That derived-key export goes through the
// SAME firmware path (okcrypto_ecdh(), okcrypto.cpp: buffer[5] in 201-204 ->
// "SSH/GPG Derive Key") as onlykey-pgp.js's production web-app PGP flow and
// the age-pqc.js groundwork's eventual real device wiring - proving it still
// works end-to-end is real regression coverage, not a toy check.
function runOnlykeyAgent(identity, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'onlykey-agent'),
            [identity],
            { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
        );
    });
}

describe('lib-agent SSH derived-key export (TC-13)', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    it('exports a real SSH public key from the device, unmodified device state', async function () {
        const result = await runOnlykeyAgent('onlykey-testing-tc13@example.com');
        assert.strictEqual(result.code, 0, `onlykey-agent failed:\n${result.stderr}`);
        assert.match(
            result.stdout,
            /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+/m,
            `expected an SSH public key line, got:\n${result.stdout}`
        );
    });

    it('is deterministic - the same identity string derives the same key twice', async function () {
        const first = await runOnlykeyAgent('onlykey-testing-tc13@example.com');
        const second = await runOnlykeyAgent('onlykey-testing-tc13@example.com');
        assert.strictEqual(first.code, 0);
        assert.strictEqual(second.code, 0);
        assert.strictEqual(first.stdout, second.stdout);
    });

    it('derives a different key for a different identity string', async function () {
        const a = await runOnlykeyAgent('onlykey-testing-tc13-a@example.com');
        const b = await runOnlykeyAgent('onlykey-testing-tc13-b@example.com');
        assert.strictEqual(a.code, 0);
        assert.strictEqual(b.code, 0);
        assert.notStrictEqual(a.stdout, b.stdout);
    });
});
