const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS } = require('../lib/config');
const { sleep } = require('../lib/hid');

// TC-09/10 groundwork: the OKCONNECT handshake over FIDO2/CTAP2 - the same
// transport onlykey-pgp.js uses in the browser (WebAuthn getAssertion(),
// with the credential ID smuggling a vendor command), driven here from Node
// via lib/fido2/client.js. This is the foundation TC-09/10's real device
// derive/decap calls (okcrypto_xwing_web_derive(), okcrypto.cpp) will build
// on - proving the transport itself works before adding the age-pqc.js math
// on top.
//
// Runs lib/fido2/run_connect.js as a child process rather than calling
// connect() in-process - see that file's doc comment: the FIDO2 client's
// native HID binding segfaults during process teardown after its own work
// is already done, and isolating it here keeps that from taking down the
// whole Mocha run.
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

function runConnectHandshake({ timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(__dirname, '..', 'lib', 'fido2', 'run_connect.js')], {
            timeout: timeoutMs,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', () => {
            // Deliberately not checking the exit code - see this file's and
            // run_connect.js's doc comments: a segfault during native HID
            // cleanup is expected *after* the JSON line is already printed,
            // and isn't itself a failure.
            const line = stdout.trim().split('\n').find((l) => l.startsWith('{'));
            if (!line) {
                return reject(new Error(`No JSON result from run_connect.js (crashed before printing?):\nstdout: ${stdout}\nstderr: ${stderr}`));
            }
            try {
                resolve(JSON.parse(line));
            } catch (e) {
                reject(new Error(`Could not parse run_connect.js output: ${line}`));
            }
        });
        child.on('error', reject);
    });
}

describe('FIDO2/CTAP2 OKCONNECT handshake (TC-09/10 groundwork)', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    it('establishes a shared secret and reports device status over FIDO2', async function () {
        const result = await runConnectHandshake();
        assert.strictEqual(result.ok, true, `handshake failed: ${result.error}`);
        assert.match(result.sharedSecret, /^[0-9a-f]{64}$/, 'sharedSecret should be a 32-byte hex string');
        assert.match(result.okPub, /^[0-9a-f]{64}$/, 'okPub should be a 32-byte hex string');
        assert.match(result.status, /^UNLOCKED/, `expected an UNLOCKED status, got: ${result.status}`);
        assert.match(result.fwVersion, /^v\d+\.\d+\.\d+/, `expected a version string, got: ${result.fwVersion}`);
    });

    it('is repeatable - a second handshake also succeeds with a fresh shared secret', async function () {
        const first = await runConnectHandshake();
        const second = await runConnectHandshake();
        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, true);
        assert.strictEqual(first.status, second.status);
        // Fresh ephemeral keypair each handshake -> different shared secret.
        assert.notStrictEqual(first.sharedSecret, second.sharedSecret);
    });
});
