const assert = require('assert');
const crypto = require('crypto');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS } = require('../lib/config');
const { SeremuChannel, sleep } = require('../lib/hid');
const { FIDO2Client, withSimulatedPresses, DEFAULT_ORIGIN } = require('../lib/fido2/client');

// Maintainer's TC-15 (non-PQ regression), U2F/FIDO2 half. test/09-10 already
// prove this repo's FIDO2/CTAP2 transport works end to end, but only via
// OnlyKey's own vendor-command-smuggling trick (a fake credential ID encoding
// an OKCONNECT/derive request, tunneled through a real authenticatorGetAssertion
// call - see lib/fido2/ctaphid.js). That's a genuinely different code path
// from a *standard* WebAuthn ceremony (authenticatorMakeCredential followed
// by a real authenticatorGetAssertion against the credential it created) -
// this test exercises that ordinary path instead, the one any real relying
// party's browser flow would use, to confirm this session's PQC-era firmware
// changes didn't regress it.
//
// Both calls need a real CTAP2 "user presence" confirmation
// (device.cpp's ctap_user_presence_test(), the same blue-LED indicator noted
// in TEST-PLAN.md's "known minor issues") while in flight - reuses the same
// withSimulatedPresses() helper test/10 already established for that.
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

async function withPresses(fn) {
    const channel = new SeremuChannel();
    await channel.connect();
    try {
        return await withSimulatedPresses(channel, fn);
    } finally {
        channel.close();
    }
}

describe('FIDO2 standard makeCredential/getAssertion ceremony (TC-15)', function () {
    this.timeout(120000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    it('creates a real credential and authenticates with it (no vendor keyHandle trick)', async function () {
        const fido2 = new FIDO2Client(false);
        const rpId = 'onlyagent.app';

        const creationOptions = {
            publicKey: {
                challenge: crypto.randomBytes(32),
                rp: { id: rpId, name: 'OnlyKey Test Suite' },
                user: {
                    id: crypto.randomBytes(16),
                    name: 'tc15-fido2-test-user',
                    displayName: 'TC-15 FIDO2 Test User',
                },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
                // userVerification MUST be one of 'required'/'preferred'/
                // 'discouraged' - FIDO2Client.js's testUserPresence() branches
                // on exact string equality with no default/else case (~line
                // 126-147). Leaving it unset means none of those branches
                // match, so its Promise never resolves *or* rejects - it just
                // hangs forever, silently, before the actual MAKE_CREDENTIAL
                // CBOR command is ever sent to the device. Confirmed live via
                // DEBUG-serial trace: GET_INFO completes fine, then nothing -
                // a genuine host-side library bug, not a device/firmware
                // issue (see TEST-PLAN.md).
                authenticatorSelection: { requireResidentKey: false, userVerification: 'discouraged' },
                attestation: 'none',
                timeout: 60000,
            },
        };

        const attestation = await withPresses(() => fido2.makeCredential(creationOptions, DEFAULT_ORIGIN));
        assert.ok(attestation.rawId && attestation.rawId.length > 0, 'no credential id returned');
        assert.ok(
            attestation.response.clientDataJSON && attestation.response.clientDataJSON.length > 0,
            'no clientDataJSON in attestation response'
        );

        const requestOptions = {
            publicKey: {
                challenge: crypto.randomBytes(32),
                rpID: rpId,
                allowCredentials: [{ type: 'public-key', id: Buffer.from(attestation.rawId) }],
                userVerification: 'discouraged',
                timeout: 60000,
            },
        };

        const assertion = await withPresses(() => fido2.getAssertion(requestOptions, DEFAULT_ORIGIN));
        assert.deepStrictEqual(
            Buffer.from(assertion.rawId),
            Buffer.from(attestation.rawId),
            'assertion answered with a different credential than the one just created'
        );
        assert.ok(assertion.response.signature && assertion.response.signature.length > 0, 'no signature in assertion response');
        assert.ok(
            assertion.response.authenticatorData && assertion.response.authenticatorData.length > 0,
            'no authenticatorData in assertion response'
        );
    });
});
