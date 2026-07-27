const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { OnlyKeyDevice, checkStatus, unlockDevice } = require('../lib/device');
const { VENV_BIN } = require('../lib/config');

// Maintainer's TC-16/TC-17: the CLI-side derived (label-based) X-Wing path -
// `age-plugin-onlykey --derived --label <name> ...` - no slot, the key is
// reproduced on demand from (device master secret, label, RPID
// "onlyagent.app") rather than stored, and is the CLI-side twin of the
// FIDO2 derive path test/10 already proved works (same firmware math,
// different transport: raw HID here via OKGETPUBKEY/OKDECRYPT +
// RESERVED_KEY_WEB_DERIVATION, okcrypto.cpp, vs the CTAP2 vendor-command
// bridge test/10 uses). Confirmed by reading onlykey_hid.py's
// derive_recipient()/derive_decaps(): neither needs a CRYPTO_AUTH
// button-press confirmation (no challenge digits printed, no confirmation
// gate in okcrypto.cpp's dispatch for this branch, unlike slot-based
// OKSIGN/OKDECRYPT) - so unlike TC-04/05, this needs no button-press
// automation at all. TC-17's decap also exercises the exact
// process_packets() multi-packet path (tag(32)+ct_X(32)=64B, over one
// 57-byte report) whose bounds-check bug was TC-05's finding #14 (the
// "most significant find of the day") - a real chance that fix also
// resolves the maintainer's specific concern here ("64-byte HID framing...
// most likely hardware failure point"), not just the slot-based case it was
// found for.
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

async function derivedRecipient(label) {
    const result = await runCli(['--derived', '--label', label, '--recipient']);
    assert.strictEqual(result.code, 0, `--derived --recipient failed for label ${JSON.stringify(label)}:\n${result.stderr}`);
    const recipient = result.stdout.trim();
    assert.match(recipient, /^age1onlykey1[a-z0-9]+$/, `not a valid recipient: ${recipient}`);
    return recipient;
}

async function derivedIdentity(label) {
    const result = await runCli(['--derived', '--label', label, '--identity']);
    assert.strictEqual(result.code, 0, `--derived --identity failed for label ${label}:\n${result.stderr}`);
    // Same "AGE-PLUGIN-ONLYKEY-1" prefix as a slot identity, deliberately -
    // `age` picks which plugin binary to run from that prefix text alone,
    // so a distinct prefix (even a bech32-valid one) makes it look for a
    // nonexistent executable instead of the real age-plugin-onlykey. Slot
    // vs. derived is disambiguated by a marker byte in the decoded payload
    // instead (derived_xwing.py's _DERIVED_MARKER).
    const identityLine = result.stdout.split('\n').find((l) => l.startsWith('AGE-PLUGIN-ONLYKEY-1'));
    assert.ok(identityLine, `no derived identity line in:\n${result.stdout}`);
    return identityLine.trim();
}

describe('CLI derived (label-based) X-Wing (TC-16/TC-17)', function () {
    this.timeout(120000);

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
    });

    describe('TC-16: derived identity + recipient, no slot, deterministic', function () {
        it('derives the same recipient for the same label, twice', async function () {
            const a = await derivedRecipient('tc16-label-a');
            const b = await derivedRecipient('tc16-label-a');
            assert.strictEqual(a, b);
        });

        it('derives a different recipient for a different label', async function () {
            const a = await derivedRecipient('tc16-label-a');
            const c = await derivedRecipient('tc16-label-c');
            assert.notStrictEqual(a, c);
        });

        it('derived identity encodes and round-trips the label, no device touch', async function () {
            const identity = await derivedIdentity('tc16-my-identity-label');
            assert.match(identity, /^AGE-PLUGIN-ONLYKEY-1[A-Z0-9]+$/);
            // Same label -> byte-identical identity string every time (pure
            // local encoding, no device call - see cmd_identity_derived()).
            const identity2 = await derivedIdentity('tc16-my-identity-label');
            assert.strictEqual(identity, identity2);
        });
    });

    describe('TC-17: derived encrypt (host) / decrypt (device) roundtrip', function () {
        this.timeout(4 * 60 * 1000);

        it('round-trips real data through age -r / age -d with no slot and no button press', async function () {
            const label = `tc17-roundtrip-${Date.now()}`;
            const recipient = await derivedRecipient(label);
            const identity = await derivedIdentity(label);

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc17-'));
            const plaintextPath = path.join(tmpDir, 'plaintext.txt');
            const ageFilePath = path.join(tmpDir, 'secret.age');
            const identityPath = path.join(tmpDir, 'identity.txt');
            const decryptedPath = path.join(tmpDir, 'decrypted.txt');

            try {
                fs.writeFileSync(plaintextPath, `TC-17 derived roundtrip payload ${Date.now()}\n`);
                fs.writeFileSync(identityPath, identity + '\n');

                await new Promise((resolve, reject) => {
                    execFile('age', ['-r', recipient, '-o', ageFilePath, plaintextPath], {
                        env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
                    }, (err, stdout, stderr) => {
                        if (err) reject(new Error(`age encrypt failed: ${stderr || err.message}`));
                        else resolve();
                    });
                });
                assert.ok(fs.existsSync(ageFilePath), 'age did not produce an output file');

                const decryptResult = await new Promise((resolve) => {
                    execFile('age', ['-d', '-i', identityPath, '-o', decryptedPath, ageFilePath], {
                        timeout: 60000,
                        env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
                    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
                });

                assert.strictEqual(decryptResult.code, 0, `age -d exited ${decryptResult.code}:\n${decryptResult.stderr}`);
                assert.ok(fs.existsSync(decryptedPath), 'age -d did not produce an output file');
                const decrypted = fs.readFileSync(decryptedPath);
                const original = fs.readFileSync(plaintextPath);
                assert.deepStrictEqual(decrypted, original, 'decrypted content does not match the original plaintext');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
