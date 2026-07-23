const assert = require('assert');
const path = require('path');
const { execFile } = require('child_process');
const { runWithAutoConfirmRetrying } = require('../lib/pqc_keygen');
const { VENV_BIN } = require('../lib/config');

function runCli(args, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'age-plugin-onlykey'),
            args,
            { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
        );
    });
}

// Maintainer's TC-06: --slot selects which of the 16 user ECC slots
// (101-116) a PQC key lives in; 117-132 are reserved for internal firmware
// use (web-derivation, HMAC, backup, derivation - see okcore.h) and must be
// rejected. validate_ecc_slot() (onlykey/age_plugin/__init__.py) runs
// before any device connection is attempted, so the reserved-slot case
// needs no button-press automation at all - it fails purely on argument
// parsing.
describe('PQC slot selection (TC-06)', function () {
    it('rejects a reserved slot (117) without touching the device', async function () {
        const result = await runCli(['--generate', '--slot', '117']);
        assert.notStrictEqual(result.code, 0, 'expected a non-zero exit for a reserved slot');
        assert.match(result.stderr, /reserved|101-116/i, `expected a reserved-slot error, got:\n${result.stderr}`);
    });

    it('rejects an out-of-range slot (200)', async function () {
        const result = await runCli(['--generate', '--slot', '200']);
        assert.notStrictEqual(result.code, 0, 'expected a non-zero exit for an out-of-range slot');
        assert.match(result.stderr, /101-116/i, `expected a slot-range error, got:\n${result.stderr}`);
    });

    it('generates an X-Wing identity in a non-default valid slot (103)', async function () {
        this.timeout(4 * 90 * 1000); // see runWithAutoConfirmRetrying
        const result = await runWithAutoConfirmRetrying(['--generate', '--slot', '103']);

        assert.strictEqual(result.code, 0, `age-plugin-onlykey exited ${result.code}:\n${result.stderr}`);
        assert.match(result.stdout, /^AGE-PLUGIN-ONLYKEY-1[A-Z0-9]+$/m, 'no identity line in stdout');
        assert.match(result.stderr, /# Recipient: age1onlykey1[a-z0-9]+/, 'no recipient line in stderr');
    });
});
