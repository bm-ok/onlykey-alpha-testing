const assert = require('assert');
const { OnlyKeyDevice, checkStatus, unlockDevice } = require('../lib/device');
const { FIDO2Client, connect } = require('../lib/fido2/client');

// TC-09/10 groundwork: the OKCONNECT handshake over FIDO2/CTAP2 - the same
// transport onlykey-pgp.js uses in the browser (WebAuthn getAssertion(),
// with the credential ID smuggling a vendor command), driven here from Node
// via lib/fido2/client.js. This is the foundation TC-09/10's real device
// derive/decap calls (okcrypto_xwing_web_derive(), okcrypto.cpp) build on -
// proving the transport itself works before adding the age-pqc.js math on
// top (see test/10-fido2-xwing-derive.test.js for the full round-trip).
//
// Runs in-process (no longer isolated in a child process): the FIDO2
// client's native HID binding used to segfault during process teardown
// after its own work was already done - root-caused via gdb to a
// use-after-free race in node-hid@2.2.0's bundled hidapi (a background read
// worker hitting "device disconnected" during close and then crashing while
// logging that error). Fixed by forcing the whole dependency tree onto the
// newer node-hid@3.4.0 this repo already depends on (package.json's
// "overrides") instead of the older version @vincss-public-projects/fido2-client
// pulls in on its own - confirmed clean (exit 0, no crash) across repeated
// runs after the override, including under the full derive round-trip.
describe('FIDO2/CTAP2 OKCONNECT handshake (TC-09/10 groundwork)', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    it('establishes a shared secret and reports device status over FIDO2', async function () {
        const fido2 = new FIDO2Client(false);
        const result = await connect(fido2);
        assert.match(Buffer.from(result.sharedSecret).toString('hex'), /^[0-9a-f]{64}$/);
        assert.match(Buffer.from(result.okPub).toString('hex'), /^[0-9a-f]{64}$/);
        assert.match(result.status, /^UNLOCKED/, `expected an UNLOCKED status, got: ${result.status}`);
        assert.match(result.fwVersion, /^v\d+\.\d+\.\d+/, `expected a version string, got: ${result.fwVersion}`);
    });

    it('is repeatable - a second handshake also succeeds with a fresh shared secret', async function () {
        const fido2 = new FIDO2Client(false);
        const first = await connect(fido2);
        const second = await connect(fido2);
        assert.strictEqual(first.status, second.status);
        // Fresh ephemeral keypair each handshake -> different shared secret.
        assert.notStrictEqual(
            Buffer.from(first.sharedSecret).toString('hex'),
            Buffer.from(second.sharedSecret).toString('hex')
        );
    });
});
