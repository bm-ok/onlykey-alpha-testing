const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { SeremuChannel, sleep } = require('../lib/hid');
const { PINS, VENV_BIN } = require('../lib/config');
const { checkStatus } = require('../lib/device');
const { runDecryptWithAutoConfirmRetrying } = require('../lib/pqc_decrypt');
const { runWithAutoConfirmRetrying } = require('../lib/pqc_keygen');

const SHORT_PRESS = 10;
const LONG_PRESS = 32;
const SLOT = 101;

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

// --identity needs no CRYPTO_AUTH confirmation (no button press) and no
// device read at all - it's just the slot number encoded, see cli.py's
// encode_identity(). Retry on the same truncated-response signature
// runWithAutoConfirmRetrying watches for, just in case.
async function runCliRetrying(args, attempts = 3) {
    let result;
    for (let i = 1; i <= attempts; i++) {
        result = await runCli(args);
        if (result.code === 0 || !/got \d+ bytes, expected \d+/.test(result.stderr)) return result;
        await sleep(1000);
    }
    return result;
}

const FETCH_VALID_RECIPIENT_SCRIPT = path.join(__dirname, '..', 'lib', 'py', 'fetch_valid_recipient.py');

// Fetches --recipient-equivalent output but validates the key content
// cryptographically before trusting it - getpubkey can still occasionally
// return a well-formed but content-corrupted key (right length, wrong
// bytes; TC-04 finding #12) even with the transport packet-loss bug
// fixed, so a length check alone (what onlykey_hid.py itself does) isn't
// enough. See lib/py/fetch_valid_recipient.py.
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

// Maintainer's TC-05: age encrypt (host) / decrypt (device) roundtrip.
// Encryption is host-only (X-Wing encapsulation needs just the public
// key), so only the decrypt half touches the device / needs button
// confirmation - see lib/pqc_decrypt.js for why that flow differs from
// keygen's (no config mode, digits computed from the ciphertext).
describe('PQC X-Wing encrypt/decrypt roundtrip (TC-05)', function () {
    this.timeout(4 * 90 * 1000);

    let tmpDir, plaintextPath, ageFilePath, identityPath, decryptedPath;
    let recipient;

    before(async function () {
        this.timeout(4 * 90 * 1000);
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc05-'));
        plaintextPath = path.join(tmpDir, 'plaintext.txt');
        ageFilePath = path.join(tmpDir, 'secret.age');
        identityPath = path.join(tmpDir, 'identity.txt');
        decryptedPath = path.join(tmpDir, 'decrypted.txt');
        fs.writeFileSync(plaintextPath, `TC-05 roundtrip test payload ${Date.now()}\n`);

        // Make sure slot SLOT actually has a key before trying to read it -
        // this test previously assumed one already existed from an earlier
        // TC-04 run, which broke the first time it ran against a freshly
        // reflashed/re-initialized device with no keys generated yet
        // (getpubkey correctly reported "no ECC Private Key set in this
        // slot", surfaced only after fixing _read_response()'s error
        // handling below to stop swallowing it).
        const keygenResult = await runWithAutoConfirmRetrying(['--generate', '--slot', String(SLOT)]);
        assert.strictEqual(keygenResult.code, 0, `--generate failed:\n${keygenResult.stderr}`);

        // Unlock once (OKGETPUBKEY needs no config mode) so --recipient/
        // --identity below can run without TC-04's full confirm flow.
        const channel = new SeremuChannel();
        await channel.connect();
        channel.send(['8'.charCodeAt(0), LONG_PRESS]);
        channel.close();
        await sleep(3000);
        await channel.connect();
        for (const digit of String(PINS.primary)) {
            channel.send([digit.charCodeAt(0), SHORT_PRESS]);
        }
        for (let i = 0; i < 10; i++) {
            await sleep(500);
            const status = await checkStatus({ retries: 0 });
            if (status.state === 'unlocked') break;
        }
        channel.close();
        await sleep(500);

        const identityResult = await runCliRetrying(['--identity', '--slot', String(SLOT)]);
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

    it('decrypts on-device to the original plaintext', async function () {
        const result = await runDecryptWithAutoConfirmRetrying(ageFilePath, identityPath, decryptedPath);

        assert.strictEqual(result.code, 0, `age -d exited ${result.code}:\n${result.stderr}`);
        assert.ok(fs.existsSync(decryptedPath), 'age -d did not produce an output file');
        const decrypted = fs.readFileSync(decryptedPath);
        const original = fs.readFileSync(plaintextPath);
        assert.deepStrictEqual(decrypted, original, 'decrypted content does not match the original plaintext');
    });
});
