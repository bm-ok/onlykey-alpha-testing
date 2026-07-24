const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS } = require('../lib/config');
const { sleep } = require('../lib/hid');
const agePqc = require('../lib/age_pqc');

// TC-09/10, the real thing: the derived (label-based) X-Wing split-custody
// round-trip over FIDO2/CTAP2, end to end against real hardware - the
// device does the X25519 half (sk_X never leaves it), the host does the
// ML-KEM half (lib/age_pqc.js, verified byte-for-byte against
// python-onlykey's derived_xwing.py in test/05), and the two must combine
// to the same shared secret a standard X-Wing encaps produces. This is the
// firmware's okcrypto_xwing_web_derive()/ok_extension.cpp derive path
// (RESERVED_KEY_WEB_DERIVATION + KEYTYPE_XWING) driven the same way the
// production web app would - lib/fido2/client.js's deriveXwing(), spawned
// via lib/fido2/run_derive.js (isolated child process - see its doc
// comment for why).
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

function runDerive(labelHex, ctXHex, { timeoutMs = 40000 } = {}) {
    return new Promise((resolve, reject) => {
        const args = [path.join(__dirname, '..', 'lib', 'fido2', 'run_derive.js'), labelHex];
        if (ctXHex) args.push(ctXHex);
        const child = spawn('node', args, { timeout: timeoutMs });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', () => {
            // Not checking the exit code - same native-cleanup-crash-after-
            // success situation as run_connect.js/test/09.
            const line = stdout.trim().split('\n').find((l) => l.startsWith('{'));
            if (!line) {
                return reject(new Error(`No JSON result from run_derive.js:\nstdout: ${stdout}\nstderr: ${stderr}`));
            }
            try {
                resolve(JSON.parse(line));
            } catch (e) {
                reject(new Error(`Could not parse run_derive.js output: ${line}`));
            }
        });
        child.on('error', reject);
    });
}

describe('FIDO2 X-Wing derive round-trip (TC-09/10)', function () {
    this.timeout(120000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    it('derives a recipient, encrypts host-side, decaps over FIDO2 - shared secrets match', async function () {
        const label32 = crypto.createHash('sha256').update('tc09-10-roundtrip-label').digest();
        const labelHex = label32.toString('hex');

        // 1. Recipient derivation - device does X25519 (sk_X never leaves),
        // returns pk_X + a one-way mlkem_seed the host expands locally.
        const pubResult = await runDerive(labelHex, null);
        assert.strictEqual(pubResult.ok, true, `pubkey derive failed: ${pubResult.error}`);
        const pkX = Buffer.from(pubResult.pkOrSsX, 'hex');
        const mlkemSeed = Buffer.from(pubResult.mlkemSeed, 'hex');
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
        const decResult = await runDerive(labelHex, Buffer.from(ctX).toString('hex'));
        assert.strictEqual(decResult.ok, true, `decap failed: ${decResult.error}`);
        const ssX = Buffer.from(decResult.pkOrSsX, 'hex');
        assert.strictEqual(ssX.length, 32);
        // Same label -> same derived seed both times.
        assert.strictEqual(decResult.mlkemSeed, pubResult.mlkemSeed);

        const ssDec = agePqc.splitDecapsulate(ssX, ciphertext, pkX, mlkemSeed);
        assert.deepStrictEqual(Buffer.from(ssDec), Buffer.from(ssEnc), 'shared secret mismatch - device and host disagree');
    });

    it('derives the same pk_X for the same label, a different one for a different label', async function () {
        const labelA = crypto.createHash('sha256').update('tc09-10-label-a').digest('hex');
        const labelB = crypto.createHash('sha256').update('tc09-10-label-b').digest('hex');

        const a1 = await runDerive(labelA, null);
        const a2 = await runDerive(labelA, null);
        const b1 = await runDerive(labelB, null);

        assert.strictEqual(a1.ok, true);
        assert.strictEqual(a2.ok, true);
        assert.strictEqual(b1.ok, true);
        assert.strictEqual(a1.pkOrSsX, a2.pkOrSsX, 'same label should derive the same pk_X');
        assert.notStrictEqual(a1.pkOrSsX, b1.pkOrSsX, 'different labels should derive different pk_X');
    });
});
