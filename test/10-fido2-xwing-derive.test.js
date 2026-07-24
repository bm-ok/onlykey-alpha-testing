const assert = require('assert');
const crypto = require('crypto');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS } = require('../lib/config');
const { SeremuChannel, sleep } = require('../lib/hid');
const { FIDO2Client, deriveXwing, withSimulatedPresses } = require('../lib/fido2/client');
const agePqc = require('../lib/age_pqc');

// TC-09/10, the real thing: the derived (label-based) X-Wing split-custody
// round-trip over FIDO2/CTAP2, end to end against real hardware - the
// device does the X25519 half (sk_X never leaves it), the host does the
// ML-KEM half (lib/age_pqc.js, verified byte-for-byte against
// python-onlykey's derived_xwing.py in test/05), and the two must combine
// to the same shared secret a standard X-Wing encaps produces. This is the
// firmware's derived X-Wing path (RESERVED_KEY_WEB_DERIVATION +
// KEYTYPE_XWING, ok_extension.cpp's bridge_to_onlykey() - NOT
// okcrypto_xwing_web_derive()'s OKGETPUBKEY/OKDECRYPT dispatch in
// okcrypto.cpp, which turned out not to be reachable over this FIDO2
// bridge; see lib/fido2/client.js's deriveXwing() doc comment) driven the
// same way the production web app would.
//
// Runs in-process (no longer isolated in a child process) - see
// test/09-fido2-connect.test.js's doc comment for the node-hid native-crash
// root cause and fix.
async function unlockDevice() {
    const device = await new OnlyKeyDevice().connect();
    device.restartDevice();
    device.close();
    await sleep(3000);
    await device.connect();
    device.unlockWithPrimaryPin(PINS.primary);
    for (let i = 0; i < 10; i++) {
        await sleep(500);
        const status = await checkStatus({ retries: 0 });
        if (status.state === 'unlocked') break;
    }
    device.close();
    await sleep(500);
}

// deriveXwing()'s REQ_PRESS variants need a real CTAP2 "user presence"
// confirmation (device.cpp's ctap_user_presence_test()) while the call is
// in flight - opens its own SEREMU channel and drives withSimulatedPresses()
// around the call.
async function deriveXwingConfirmed(fido2, label32, opts = {}) {
    const channel = new SeremuChannel();
    await channel.connect();
    try {
        return await withSimulatedPresses(channel, () => deriveXwing(fido2, label32, opts));
    } finally {
        channel.close();
    }
}

describe('FIDO2 X-Wing derive round-trip (TC-09/10)', function () {
    this.timeout(120000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    it('derives a recipient, encrypts host-side, decaps over FIDO2 - shared secrets match', async function () {
        const label32 = crypto.createHash('sha256').update('tc09-10-roundtrip-label').digest();
        const fido2 = new FIDO2Client(false);

        // 1. Recipient derivation - device does X25519 (sk_X never leaves),
        // returns pk_X + a one-way mlkem_seed the host expands locally.
        const pubResult = await deriveXwingConfirmed(fido2, label32);
        const pkX = pubResult.pkOrSsX;
        const mlkemSeed = pubResult.mlkemSeed;
        assert.strictEqual(pkX.length, 32);
        assert.strictEqual(mlkemSeed.length, 32);

        // 2. Build the 1216-byte X-Wing recipient and encrypt host-side -
        // no device involved for this half at all (standard X-Wing encaps).
        const recipient = agePqc.buildRecipient(pkX, mlkemSeed);
        const { sharedSecret: ssEnc, ciphertext } = agePqc.xwingEncapsHost(recipient);
        assert.strictEqual(ciphertext.length, 1120);

        // 3. Decapsulation - device does X25519(sk_X, ct_X) again (same
        // label -> same sk_X), host finishes the ML-KEM half + combiner.
        const ctX = agePqc.ctXOf(ciphertext);
        const decResult = await deriveXwingConfirmed(fido2, label32, { ctX: Buffer.from(ctX) });
        const ssX = decResult.pkOrSsX;
        assert.strictEqual(ssX.length, 32);
        // Same label -> same derived seed both times.
        assert.deepStrictEqual(decResult.mlkemSeed, pubResult.mlkemSeed);

        const ssDec = agePqc.splitDecapsulate(ssX, ciphertext, pkX, mlkemSeed);
        assert.deepStrictEqual(Buffer.from(ssDec), Buffer.from(ssEnc), 'shared secret mismatch - device and host disagree');
    });

    it('derives the same pk_X for the same label, a different one for a different label', async function () {
        const labelA = crypto.createHash('sha256').update('tc09-10-label-a').digest();
        const labelB = crypto.createHash('sha256').update('tc09-10-label-b').digest();
        const fido2 = new FIDO2Client(false);

        const a1 = await deriveXwingConfirmed(fido2, labelA);
        const a2 = await deriveXwingConfirmed(fido2, labelA);
        const b1 = await deriveXwingConfirmed(fido2, labelB);

        assert.deepStrictEqual(a1.pkOrSsX, a2.pkOrSsX, 'same label should derive the same pk_X');
        assert.notDeepStrictEqual(a1.pkOrSsX, b1.pkOrSsX, 'different labels should derive different pk_X');
    });
});
