const assert = require('assert');
const path = require('path');
const { execFile } = require('child_process');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS, VENV_BIN } = require('../lib/config');
const { SeremuChannel, sleep } = require('../lib/hid');
const { enterConfigModeConfirmed, unlockAndConfirm } = require('../lib/pqc_keygen');

// Maintainer's TC-15 (non-PQ regression): does this session's PQC-era
// firmware changes - process_packets()'s bounds-check fix, the reserved-slot
// guard added to OKSETPRIV's dispatch (okcore.cpp ~438-467), and
// okcrypto_decrypt()'s RESERVED_KEY_WEB_DERIVATION dispatch fix
// (okcrypto.cpp) - regress the *classic* (non-PQC) slot-label and ECC-key
// paths sharing the same OKSETSLOT/OKSETPRIV dispatch cases?
//
// Confirmed via a static read of okcore.cpp before writing this test: classic
// ECC key generation (ecc_priv_flash(), keytype 1-3 = x25519/nist/secp256k1)
// has NO CRYPTO_AUTH button-confirmation gate at all - that gate is only
// entered `if (basetype == KEYTYPE_MLKEM768 || basetype == KEYTYPE_XWING)`
// (okcore.cpp ~5122-5148, the PQC keygen fix from TC-04). So unlike TC-04's
// PQC keygen, this needs no challenge-digit automation - just config mode
// (OKSETPRIV/OKSETSLOT's shared `configmode==true` gate, confirmed the same
// pattern TC-08's hmackeymode/backupkeymode tests already rely on).
//
// RSA key testing (also part of TC-15's title) is deliberately out of scope
// here: `rsa_priv_flash()` also has no CRYPTO_AUTH gate, but loading a real
// RSA key needs a correctly PGP-armored key fixture (client.py's loadkey()
// parses real OpenPGP packets, not a raw byte format worth hand-rolling) -
// and RSA's multi-message chunking is its own local packet_buffer_offset
// scheme distinct from process_packets()'s shared accumulator this session
// actually touched, so the regression signal here would be lower value for
// the added complexity. Flagged as still-open in TEST-PLAN.md rather than
// silently skipped.
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

// Same shared-config-mode-session pattern as TC-08's backup/HMAC tests -
// configmode is a device-side flag with no explicit exit besides reboot, so
// entering it once here and reusing it across both its() below is both
// faster and matches established harness style. Unlike TC-08's version,
// this wraps the body in try/finally: if unlockAndConfirm()/
// enterConfigModeConfirmed() throws (as happened live - see TEST-PLAN.md),
// an unclosed SeremuChannel keeps a live HID handle open, which keeps
// Node's event loop alive - mocha still prints its failure report on
// schedule, but the process then hangs indefinitely afterward instead of
// exiting. Confirmed live: this is exactly what happened, not a genuinely
// stuck operation.
async function enterConfigMode() {
    const channel = new SeremuChannel();
    await channel.connect();
    try {
        await unlockAndConfirm(channel, PINS.primary);
        await enterConfigModeConfirmed(channel, PINS.primary);
    } finally {
        channel.close();
    }
    await sleep(500);
}

describe('Non-PQ regression: slot labels + classic ECC keys (TC-15)', function () {
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
});
