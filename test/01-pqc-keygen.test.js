const assert = require('assert');
const { runWithAutoConfirm } = require('../lib/pqc_keygen');

// Maintainer's TC-04: generate an X-Wing age identity on the device.
// Runs against real hardware unconditionally - unlike SETUP-03, this
// doesn't touch PIN/profile state (it stores a key in slot 101 and can be
// re-run safely; a re-run just regenerates a fresh keypair in that slot).
describe('PQC X-Wing keygen (TC-04)', function () {
    this.timeout(90 * 1000); // two ~6s unlock settles + fade-clear margins + keygen itself

    it('generates an X-Wing identity via age-plugin-onlykey --generate', async function () {
        const result = await runWithAutoConfirm(['--generate']);

        assert.strictEqual(result.code, 0, `age-plugin-onlykey exited ${result.code}:\n${result.stderr}`);
        assert.match(result.stdout, /^AGE-PLUGIN-ONLYKEY-1[A-Z0-9]+$/m, 'no identity line in stdout');
        assert.match(result.stderr, /# Recipient: age1onlykey1[a-z0-9]+/, 'no recipient line in stderr');
    });
});
