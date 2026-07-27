const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { isAlive, evalInPage, getConsoleLog } = require('../lib/nwjs_client');
const { unlockDevice } = require('../lib/device');
const { VENV_BIN } = require('../lib/config');
const { showStatus, waitForOkConnectSettled, ensureUnlocked, setDerivedKeyChallengeMode } = require('../lib/gui_helpers');

// Maintainer's TC-18/TC-19: the last two rows of TEST-PLAN.md, and the
// reason the age-derive page (src/plugins/age-derive/) exists at all -
// interop between the browser's derived (label-based) X-Wing implementation
// (src/onlykey-fido2/onlykey/age_pqc.js + age_file.js, a from-scratch port
// of derived_xwing.py/xwing.py, vendored @noble crypto) and the real CLI
// (age-plugin-onlykey --derived, already proven in test/11's TC-16/TC-17).
// Structured like test/14 (the reference GUI-test pattern this was built
// to follow, per this session's direction) - same nwjs/CDP harness, same
// device-contention precautions (ensureUnlocked/showStatus via
// lib/gui_helpers.js).
//
//   TC-18: encrypt via the CLI (`age -r <recipient>`), decrypt in the browser.
//   TC-19: encrypt in the browser, decrypt via the CLI (`age -d -i <identity>`).
//
// Same label on both sides must derive the same X-Wing key (device-side
// derivation is deterministic given (device secret, label) - test/11
// already proved this for CLI-vs-CLI; this proves it for CLI-vs-browser).
const AGE_DERIVE_URL = 'http://localhost:3000/app/age-derive';

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

function runAge(args, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
        execFile('age', args, {
            timeout: timeoutMs,
            env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
        }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
}

// Same derivation as test/11's derivedRecipient/derivedIdentity (TC-16) -
// pure local CLI calls, no device touch beyond what --recipient/--identity
// themselves need (none, per derived_xwing.py's encode_identity - only
// --recipient talks to the device).
async function derivedRecipient(label) {
    const result = await runCli(['--derived', '--label', label, '--recipient']);
    assert.strictEqual(result.code, 0, `--derived --recipient failed for label ${JSON.stringify(label)}:\n${result.stderr}`);
    const recipient = result.stdout.trim();
    assert.match(recipient, /^age1onlykey1[a-z0-9]+$/, `not a valid recipient: ${recipient}`);
    return recipient;
}

// Navigates to the page fresh, sets the label, and waits for the OKCONNECT
// handshake to settle before returning - same pre-click sequencing test/14
// established (clicking while OKCONNECT is still in flight collides with
// it, "A request is already pending").
async function openAgeDerivePage(label) {
    await ensureUnlocked();
    await evalInPage('return true;', { url: AGE_DERIVE_URL });
    const settledClass = await waitForOkConnectSettled();
    if (!/text-success/.test(settledClass)) {
        throw new Error(`OKCONNECT handshake settled as failed (${settledClass}) before any operation was attempted`);
    }
    await getConsoleLog({ clear: true });
    await evalInPage(`document.getElementById('label').value = ${JSON.stringify(label)}; return true;`);
}

// Clicks Encrypt and polls #age_file_out/#identity_out until both are
// populated (or the budget runs out) - a real round trip here is a
// DERIVE_PUBLIC_KEY WebAuthn ceremony followed by local X-Wing encaps and
// STREAM encryption, so this needs real margin, same reasoning as test/14's
// clickGenerateAndCollect().
async function clickEncryptAndCollect() {
    const { value, errors: pageErrors } = await evalInPage(`
        document.getElementById('encrypt_start').click();
        const deadline = Date.now() + 30000;
        let fileB64 = '';
        while (Date.now() < deadline) {
            fileB64 = document.getElementById('age_file_out').value;
            if (fileB64) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return { fileB64, identity: document.getElementById('identity_out').value };
    `, { timeoutMs: 35000 });

    const log = await getConsoleLog();
    const ctapErrors = log.filter((e) => /CTAP2_ERR/i.test(e.text)).map((e) => e.text);
    return { fileB64: value && value.fileB64, identity: value && value.identity, ctapErrors, pageErrors };
}

// Pastes a base64 age file into #decrypt_file_in, clicks Decrypt, and polls
// #decrypted_out - a real round trip here is DERIVE_PUBLIC_KEY *and*
// DERIVE_SHARED_SECRET (two WebAuthn ceremonies), so gets the same 30s
// budget as encrypt.
async function clickDecryptAndCollect(fileB64) {
    const { value: decrypted, errors: pageErrors } = await evalInPage(`
        document.getElementById('decrypt_file_in').value = ${JSON.stringify(fileB64)};
        document.getElementById('decrypt_start').click();
        const deadline = Date.now() + 30000;
        let value = '';
        while (Date.now() < deadline) {
            value = document.getElementById('decrypted_out').value;
            if (value) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return value;
    `, { timeoutMs: 35000 });

    const log = await getConsoleLog();
    const ctapErrors = log.filter((e) => /CTAP2_ERR/i.test(e.text)).map((e) => e.text);
    return { decrypted, ctapErrors, pageErrors };
}

describe('GUI: Derived X-Wing age encryption (browser-driven, real device) (TC-18/TC-19)', function () {
    this.timeout(120000);

    let tmpDir;

    before(async function () {
        if (!(await isAlive())) {
            this.skip(); // nwjs not running - see nwjs/readme.md
        }
        this.timeout(90000);
        await unlockDevice();
        // Unlike test/14, this suite isn't testing the "derived keys per
        // site without touch" gate itself - it's testing crypto interop,
        // so the precondition is set unconditionally here rather than
        // conditionally probing and retrying. Confirmed live: the FIDO2
        // derive dispatch (ok_extension.cpp) enforces this same
        // derived_key_challenge_mode bit 3 gate for ALL non-REQ_PRESS
        // keytypes, X-Wing included - a freshly-set-up device hits
        // CTAP2_ERR_EXTENSION_NOT_SUPPORTED here exactly like
        // password-generator does in test/14.
        await setDerivedKeyChallengeMode(8); // bit 3 = 0b1000 = 8
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc1819-'));
    });

    after(function () {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('TC-19: encrypts in the browser, decrypts via the CLI', async function () {
        this.timeout(90000);
        const label = `tc19-${Date.now()}`;
        const plaintext = `TC-19 browser-encrypt roundtrip payload ${Date.now()}\n`;

        await openAgeDerivePage(label);
        await evalInPage(`document.getElementById('plaintext').value = ${JSON.stringify(plaintext)}; return true;`);

        const { fileB64, identity, ctapErrors, pageErrors } = await clickEncryptAndCollect();
        assert.deepStrictEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join('; ')}`);
        assert.deepStrictEqual(ctapErrors, [], `unexpected CTAP2 errors: ${JSON.stringify(ctapErrors)}`);
        assert.ok(fileB64 && !fileB64.startsWith('ERROR'), `expected a base64 age file, got: ${JSON.stringify(fileB64)}`);
        assert.match(identity, /^AGE-PLUGIN-ONLYKEY-1[A-Z0-9]+$/, `not a valid derived identity: ${identity}`);

        const ageFilePath = path.join(tmpDir, 'tc19-secret.age');
        const identityPath = path.join(tmpDir, 'tc19-identity.txt');
        const decryptedPath = path.join(tmpDir, 'tc19-decrypted.txt');
        fs.writeFileSync(ageFilePath, Buffer.from(fileB64, 'base64'));
        fs.writeFileSync(identityPath, identity + '\n');

        await showStatus('TC-19: decrypting with the real age CLI...');
        const decryptResult = await runAge(['-d', '-i', identityPath, '-o', decryptedPath, ageFilePath]);
        assert.strictEqual(decryptResult.code, 0, `age -d exited ${decryptResult.code}:\n${decryptResult.stderr}`);
        const decrypted = fs.readFileSync(decryptedPath, 'utf8');
        assert.strictEqual(decrypted, plaintext, 'CLI-decrypted content does not match the browser-encrypted plaintext');
    });

    it('TC-18: encrypts via the CLI, decrypts in the browser', async function () {
        this.timeout(90000);
        const label = `tc18-${Date.now()}`;
        const plaintext = `TC-18 CLI-encrypt roundtrip payload ${Date.now()}\n`;

        await showStatus('TC-18: deriving recipient via the CLI...');
        const recipient = await derivedRecipient(label);

        const plaintextPath = path.join(tmpDir, 'tc18-plaintext.txt');
        const ageFilePath = path.join(tmpDir, 'tc18-secret.age');
        fs.writeFileSync(plaintextPath, plaintext);

        await showStatus('TC-18: encrypting with the real age CLI...');
        const encryptResult = await runAge(['-r', recipient, '-o', ageFilePath, plaintextPath]);
        assert.strictEqual(encryptResult.code, 0, `age -r exited ${encryptResult.code}:\n${encryptResult.stderr}`);
        assert.ok(fs.existsSync(ageFilePath), 'age did not produce an output file');

        const fileB64 = fs.readFileSync(ageFilePath).toString('base64');

        await openAgeDerivePage(label);

        const { decrypted, ctapErrors, pageErrors } = await clickDecryptAndCollect(fileB64);
        assert.deepStrictEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join('; ')}`);
        assert.deepStrictEqual(ctapErrors, [], `unexpected CTAP2 errors: ${JSON.stringify(ctapErrors)}`);
        assert.strictEqual(decrypted, plaintext, 'browser-decrypted content does not match the CLI-encrypted plaintext');
    });
});
