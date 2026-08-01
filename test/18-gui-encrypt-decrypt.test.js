const assert = require('assert');
const { isAlive, evalInPage } = require('../lib/nwjs_client');
const { startGuiSession } = require('../lib/gui_session');
const { trace } = require('../lib/gui_trace');
const { createPgpEnv, encrypt } = require('../lib/fido2/pgp_env');

// Coverage for the web app's CLASSIC (non-PQC) PGP pages - /app/encrypt and
// /app/decrypt - which nothing in this suite touched before. TC-11 exercises
// the composite PGP-PQC page next door, and the two share a transport
// (onlykey-pgp.js's u2fSignBuffer + OKPING polling), so a regression in the
// shared parts shows up here first and much more cheaply.
//
// The split that shapes this file: of the encrypt page's three modes, only
// "Encrypt Only" avoids the device entirely (kbpgp encrypts to a recipient
// public key and stops). Sign Only, Encrypt and Sign, and both decrypt modes
// all call into OKSIGN/OKDECRYPT, which read RSA slots 1 (decrypt) and 2
// (sign) - onlykey-pgp.js's slotid() hardcodes those, and okcrypto.cpp
// dispatches buffer[5] < 101 to okcore_flashget_RSA(). So the device half
// needs a classic RSA key provisioned into those slots, and is deliberately
// kept separate from the device-free half below.
//
// What the device-free half is actually worth: it is the whole encrypt path
// short of the signature - page wiring, the tokenizer recipient field, kbpgp
// key import, and message boxing - and it runs in seconds with nothing
// plugged in. That makes it the cheapest possible "did we break encrypt"
// check, which is exactly what it is here for.
//
// Assertion style is deliberate. The password-generator bug this suite found
// (TEST-PLAN "Security findings") got past test/14 because that test only
// asserted "something came back". Everything here asserts a real
// input -> output relation instead: the ciphertext must decrypt, under a key
// we hold, back to the exact plaintext that went in.
const ENCRYPT_URL = 'http://localhost:3000/app/encrypt';

// A throwaway recipient. Generated per-run rather than kept as a fixture so
// there is never a private key checked into this repo, and generation is
// ~1.3s with kbpgp's ECC path (RSA would be far slower and buys nothing -
// the recipient key never goes near the device in these tests).
async function makeRecipient(env) {
    const kbpgp = env.imports.kbpgp(false, { log() {}, warn() {}, error() {}, info() {} });
    const km = await new Promise((res, rej) => kbpgp.KeyManager.generate_ecc(
        { userid: 'OnlyKey Test Recipient <recipient@example.invalid>' },
        (err, k) => (err ? rej(err) : res(k))
    ));
    await new Promise((res, rej) => km.sign({}, (err) => (err ? rej(err) : res())));
    const pub = await new Promise((res, rej) => km.export_pgp_public({}, (err, p) => (err ? rej(err) : res(p))));
    const ring = new kbpgp.keyring.KeyRing();
    ring.add_key_manager(km);
    const open = (armored) => new Promise((res, rej) => kbpgp.unbox(
        { keyfetch: ring, armored },
        (err, literals) => (err ? rej(err) : res(literals[0].toString()))
    ));
    return { kbpgp, km, pub, open };
}

// Open ONCE per suite, never per encryption.
//
// startGuiSession() (lib/gui_session.js) is the standard open -> settle ->
// test -> close flow every GUI test uses; see that file for why the settle
// watches the device's debug output and the browser together rather than a
// clock. What matters here is the "once": every load of an app page re-runs
// src/plugins/index/index.js's doSetTime() -> OKCONNECT over FIDO2, and a
// version of this file that re-navigated per encryption (cache-buster and
// all) hung on exactly that. Open once, then reset the page in-DOM between
// runs.
//
// device: false because "Encrypt Only" never reaches the device - kbpgp
// encrypts to a recipient public key and stops. The page still performs its
// own OKCONNECT on load, so the browser-side settle still applies.

// Puts the page back into a fresh pre-encrypt state without a reload.
//
// Needed because the click handler is a state machine: after a successful
// encryption okpgp's status is 'finished', so clicking the button again
// takes the 'finished' branch (copy to clipboard) instead of encrypting
// again. The page's own "Reset" button - added by the `completed` handler -
// calls page.setup() and is precisely the supported way back, so use that
// rather than poking at library internals.
async function resetEncryptPage() {
    const { value } = await evalInPage(`
        const rb = document.getElementById('resetstate');
        if (rb) rb.click();
        document.getElementById('message').value = '';
        document.getElementById('pgpkeyurl').value = '';
        return !!rb;
    `);
    return value;
}

// Drives the real page the way a person does: type the recipient, type the
// message, click the button, wait for the message box to be replaced by the
// armored ciphertext. Polls for the result rather than sleeping - the click
// handler is async all the way down (getKey -> kbpgp import -> kbpgp.box) and
// has no completion signal other than the field changing.
async function encryptOnPage(recipientPub, plaintext, label = 'encrypt') {
    return trace(label, async () => {
        const { value, errors } = await evalInPage(`
            document.getElementById('pgpkeyurl').value = ${JSON.stringify(recipientPub)};
            document.getElementById('message').value = ${JSON.stringify(plaintext)};
            document.getElementById('onlykey_start').click();
            const deadline = Date.now() + 40000;
            while (Date.now() < deadline) {
                const v = document.getElementById('message').value;
                if (v.indexOf('-----BEGIN PGP MESSAGE-----') === 0) return v;
                await new Promise((r) => setTimeout(r, 200));
            }
            return 'NO_CIPHERTEXT button=' + document.getElementById('onlykey_start').textContent;
        `, { timeoutMs: 60000 });
        if (errors && errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
        if (!String(value).startsWith('-----BEGIN PGP MESSAGE-----')) {
            throw new Error(`page produced no ciphertext: ${String(value).slice(0, 200)}`);
        }
        return value;
    });
}

describe('GUI: classic PGP encrypt/decrypt pages', function () {
    this.timeout(120000);

    let env;
    let recipient;
    let session = null;

    before(async function () {
        this.timeout(90000);
        env = createPgpEnv({ withDevice: false });
        recipient = await makeRecipient(env);
        if (await isAlive()) {
            session = await startGuiSession({ url: `${ENCRYPT_URL}?type=e`, device: false });
        }
    });

    // Step 4 of the standard flow: the window is destroyed, not left open.
    // Anything a test leaves behind - including a native dialog, which cannot
    // be dismissed any other way - dies with it.
    after(async function () {
        this.timeout(30000);
        if (session) await session.close();
    });

    // One reset between page-driven tests, so each starts from the same
    // pre-encrypt state without a reload (see resetEncryptPage's comment).
    afterEach(async function () {
        if (session) await resetEncryptPage().catch(() => {});
    });

    describe('Encrypt Only (no device)', function () {
        it('the Node shim encrypts through the real onlykey-pgp.js and the result decrypts', async function () {
            const plaintext = `node shim encrypt ${Date.now()}`;
            const ct = await encrypt(env, {
                mode: 'Encrypt Only',
                recipients: recipient.pub,
                message: plaintext,
            });
            assert.ok(
                String(ct).startsWith('-----BEGIN PGP MESSAGE-----'),
                `expected an armored PGP message, got: ${String(ct).slice(0, 120)}`
            );
            assert.strictEqual(await recipient.open(ct), plaintext);
        });

        it('the real /app/encrypt page encrypts and the result decrypts', async function () {
            if (!session) this.skip(); // nwjs not running - see nwjs/readme.md
            const plaintext = `page encrypt ${Date.now()}`;
            const ct = await encryptOnPage(recipient.pub, plaintext, 'page encrypt');
            assert.strictEqual(await recipient.open(ct), plaintext);
        });

        // The regression the password-generator collision would have needed.
        // Distinct plaintexts of the SAME length, so a length-only or
        // input-ignoring path cannot pass by accident: each ciphertext must
        // decrypt back to its own plaintext, not merely to something.
        it('distinct same-length plaintexts survive as distinct plaintexts', async function () {
            if (!session) this.skip();
            const a = 'alpha payload one';
            const b = 'bravo payload two';
            assert.strictEqual(a.length, b.length, 'test inputs must be the same length to be meaningful');
            const ctA = await encryptOnPage(recipient.pub, a, 'distinct-A');
            await resetEncryptPage();
            const ctB = await encryptOnPage(recipient.pub, b, 'distinct-B');
            assert.notStrictEqual(ctA, ctB, 'two different plaintexts produced byte-identical ciphertext');
            assert.strictEqual(await recipient.open(ctA), a);
            assert.strictEqual(await recipient.open(ctB), b);
        });

        // Cross-check, per the "both sides must verify each other" rule: the
        // browser and the Node shim are two clients of the same library, so
        // they must agree. Note this compares DECRYPTED plaintext, never the
        // ciphertext - PGP picks a fresh random session key every time, so
        // identical ciphertext would actually indicate a broken RNG.
        it('the browser page and the Node shim agree on what they encrypt', async function () {
            if (!session) this.skip();
            const plaintext = `cross-check ${Date.now()}`;
            const fromPage = await encryptOnPage(recipient.pub, plaintext, 'cross-check');
            const fromNode = await encrypt(env, {
                mode: 'Encrypt Only', recipients: recipient.pub, message: plaintext,
            });
            assert.notStrictEqual(fromPage, fromNode, 'identical ciphertext from two runs implies a static session key');
            assert.strictEqual(await recipient.open(fromPage), plaintext);
            assert.strictEqual(await recipient.open(fromNode), plaintext);
        });
    });
});
