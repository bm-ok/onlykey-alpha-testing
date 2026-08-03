const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { isOnlyKeyPresent, SeremuChannel, sleep } = require('../lib/hid');
const { PINS, VENV_BIN } = require('../lib/config');
const { checkStatus } = require('../lib/device');
const { runWithAutoConfirmRetrying } = require('../lib/pqc_keygen');

const SLOT = 101;

// Maintainer's TC-07 ("wrong identity / no device"): unplug the OnlyKey and
// rerun the TC-05 decrypt; expect a clean failure, not a crash/hang. This is
// a genuine physical-layer test (no software trick reliably fakes a USB
// disconnect without root - see TEST-PLAN.md's TC-07 notes), so it's
// semi-automated: it prompts for the unplug/replug but never trusts a fixed
// delay for either - it polls the real HID enumeration state
// (isOnlyKeyPresent(), same node-hid device list lib/hid.js's SeremuChannel
// already relies on elsewhere) so it only proceeds once the disconnect (and
// later reconnect) actually happened.
// Skipped by default in normal test runs: it requires a real physical
// USB unplug/replug (see the module comment above - no software trick
// reliably fakes this without root), so an unattended `npm test` run
// would otherwise just sit at the "please unplug" prompt until its
// timeout. Opt in explicitly with ONLYKEY_TEST_PHYSICAL_UNPLUG=yes when
// actually testing this path (e.g. before shipping a production key) or
// running it on its own.
describe('PQC X-Wing decrypt with no device attached (TC-07)', function () {
    this.timeout(5 * 60 * 1000);

    let tmpDir, plaintextPath, ageFilePath, identityPath, decryptedPath;
    let recipient;

    before(async function () {
        this.timeout(4 * 90 * 1000);

        if (process.env.ONLYKEY_TEST_PHYSICAL_UNPLUG !== 'yes') {
            // eslint-disable-next-line no-console
            console.log('    (skipping TC-07 - requires a real physical USB unplug/replug; set ONLYKEY_TEST_PHYSICAL_UNPLUG=yes to run it)');
            this.skip();
        }

        if (!isOnlyKeyPresent()) {
            throw new Error('OnlyKey not detected - plug it in before running TC-07 (needs it present to prepare the ciphertext first)');
        }

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc07-'));
        plaintextPath = path.join(tmpDir, 'plaintext.txt');
        ageFilePath = path.join(tmpDir, 'secret.age');
        identityPath = path.join(tmpDir, 'identity.txt');
        decryptedPath = path.join(tmpDir, 'decrypted.txt');
        fs.writeFileSync(plaintextPath, `TC-07 no-device test payload ${Date.now()}\n`);

        const keygenResult = await runWithAutoConfirmRetrying(['--generate', '--slot', String(SLOT)]);
        assert.strictEqual(keygenResult.code, 0, `--generate failed:\n${keygenResult.stderr}`);

        const channel = new SeremuChannel();
        await channel.connect();
        channel.sendLine('8');
        channel.close();
        await sleep(3000);
        await channel.connect();
        for (const digit of String(PINS.primary)) {
            channel.sendPress(digit);
        }
        for (let i = 0; i < 10; i++) {
            await sleep(500);
            const status = await checkStatus({ retries: 0 });
            if (status.state === 'unlocked') break;
        }
        channel.close();
        await sleep(500);

        const identityResult = await runCli(['--identity', '--slot', String(SLOT)]);
        assert.strictEqual(identityResult.code, 0, `--identity failed:\n${identityResult.stderr}`);
        fs.writeFileSync(identityPath, identityResult.stdout);

        recipient = await fetchValidRecipientRetrying(SLOT);
        assert.match(recipient, /^age1onlykey1[a-z0-9]+$/, `not a valid recipient: ${recipient}`);

        await new Promise((resolve, reject) => {
            execFile('age', ['-r', recipient, '-o', ageFilePath, plaintextPath], {
                env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
            }, (err, stdout, stderr) => {
                if (err) reject(new Error(`age encrypt failed: ${stderr || err.message}`));
                else resolve();
            });
        });
        assert.ok(fs.existsSync(ageFilePath), 'age did not produce an output file');
    });

    after(function () {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('fails cleanly (no crash/hang) when the device is unplugged', async function () {
        // eslint-disable-next-line no-console
        console.log('\n    >>> TC-07: please UNPLUG the OnlyKey now. Waiting for it to disappear from USB (up to 2 minutes)...');
        await waitForPresence(false, 2 * 60 * 1000);
        // eslint-disable-next-line no-console
        console.log('    >>> Device gone from USB - running `age -d` against it now.');

        const result = await new Promise((resolve, reject) => {
            const child = execFile('age', ['-d', '-i', identityPath, '-o', decryptedPath, ageFilePath], {
                timeout: 30000,
                env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
            }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr, timedOut: !!err && err.killed }));
        });

        // eslint-disable-next-line no-console
        console.log('    >>> Please PLUG the OnlyKey back in. Waiting for it to reappear on USB (up to 2 minutes)...');
        await waitForPresence(true, 2 * 60 * 1000);
        // eslint-disable-next-line no-console
        console.log('    >>> Device back on USB, continuing.');

        assert.ok(!result.timedOut, `age -d hung and had to be killed instead of failing cleanly:\n${result.stderr}`);
        assert.notStrictEqual(result.code, 0, `expected a non-zero exit with no device attached, got 0:\n${result.stdout}`);
        assert.ok(!fs.existsSync(decryptedPath), 'age -d produced an output file despite no device being attached');
        // `age` doesn't forward the plugin's raw stderr (see pqc_decrypt.js's
        // module doc comment, point 3) - the plugin's own clean message
        // ("Could not connect to OnlyKey. Is it plugged in and unlocked?",
        // onlykey_hid.py) never reaches here. Confirmed live: `age -d`'s
        // actual stderr with no device attached is just its own generic
        // wrapper ("age: error: onlykey plugin:", no reason text). Matching
        // both that and the direct-plugin message in case this ever runs
        // against age-plugin-onlykey directly instead of via `age -d`.
        assert.match(
            result.stderr,
            /age: error: onlykey plugin|could not connect to onlykey|no identity matched|plugged in/i,
            `expected a clean "no device" error, got:\n${result.stderr}`
        );
    });
});

function waitForPresence(wantPresent, timeoutMs, pollMs = 1000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (isOnlyKeyPresent() === wantPresent) return resolve();
            if (Date.now() > deadline) {
                return reject(new Error(`Timed out waiting for OnlyKey to become ${wantPresent ? 'present' : 'absent'} on USB`));
            }
            setTimeout(tick, pollMs);
        };
        tick();
    });
}

function runCli(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'age-plugin-onlykey'),
            args,
            { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
        );
    });
}

const FETCH_VALID_RECIPIENT_SCRIPT = path.join(__dirname, '..', 'lib', 'py', 'fetch_valid_recipient.py');

function fetchValidRecipient(slot, { timeout = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'python3'),
            [FETCH_VALID_RECIPIENT_SCRIPT, String(slot)],
            { timeout },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
        );
    });
}

async function fetchValidRecipientRetrying(slot, attempts = 5) {
    let result;
    for (let i = 1; i <= attempts; i++) {
        result = await fetchValidRecipient(slot);
        if (result.code === 0) return result.stdout.trim();
        await sleep(1000);
    }
    throw new Error(`Could not fetch a valid recipient for slot ${slot} after ${attempts} attempts: ${result.stderr}`);
}
