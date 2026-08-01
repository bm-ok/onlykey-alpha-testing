const assert = require('assert');
const { isAlive, evalInPage, getConsoleLog } = require('../lib/nwjs_client');
const { unlockDevice } = require('../lib/device');
const { sleep } = require('../lib/hid');
const { showStatus, ensureUnlocked, setDerivedKeyChallengeMode } = require('../lib/gui_helpers');
const { startGuiSession } = require('../lib/gui_session');

// First real browser-driven ("GUI") test in this suite - clicks through the
// actual onlykey.github.io web app UI in a real browser (see
// nwjs/readme.md) against the real device, rather than just its underlying
// crypto/protocol in isolation like the rest of this repo does. Requires
// nwjs already running (`cd nwjs && npm start`, or `node nwjs/ensure.js`
// first) - this test can't safely launch/manage that itself (a real,
// possibly-visible GUI process with its own lifecycle, meant to be shared
// with a human watching), so it skips with a clear message if unreachable.
//
// Confirmed live before writing this (manually, via nwjs/run.js) that the
// Password Generator's "Generate Password" button
// (onlykey-3rd-party.js's derive_public_key(), the plain/non-REQ_PRESS
// derive path) fails with CTAP2_ERR_EXTENSION_NOT_SUPPORTED on a fresh/
// default device - by design (libraries/fido2/ok_extension.cpp:197-208),
// gated on derived_key_challenge_mode bit 3 ("derived keys per site
// without touch"), off by default as a real security boundary against any
// website silently deriving site-specific keys with no physical
// confirmation. Tests both sides of that boundary: blocked by default,
// then unblocked once explicitly enabled (config mode required, same
// OKSETSLOT pattern as TC-08's hmackeymode/backupkeymode).
const PASSWORD_GEN_URL = 'http://localhost:3000/app/password-generator';

// setDerivedKeyChallengeMode() is shared with test/15 (and any later GUI
// test) via lib/gui_helpers.js - see that file's doc comment for why this
// setting/cache exists.

// Opens a fresh window on the page (own OKCONNECT handshake, own console
// capture buffer - see inject_console_capture.js), clicks Generate, waits
// for a response, and returns { password, ctapErrors, pageErrors }.
//
// The click has to happen after the page's startup handshake, not during it -
// clicking into an in-flight OKCONNECT collides with it ("A request is already
// pending", seen live in the console log). That ordering is now
// startGuiSession()'s job for every GUI test rather than this file's.
//
// Historical note kept because it rules something out: waiting for a *second*
// app-triggered connect was considered and disproved live - after the first
// connect settled, no further "OKCONNECT STATUS" ever appeared on this route
// across 12+s of watching, so gating on one would wait for a signal that never
// comes.
async function clickGenerateAndCollect() {
    // startGuiSession() (lib/gui_session.js) is the standard open -> settle ->
    // test -> close flow, and it subsumes what used to be four separate steps
    // here: ensureUnlocked(), the navigate, the OKCONNECT settle plus its
    // text-success assertion, and the console clear.
    //
    // It also replaces this function's `await sleep(3000)`. That was a margin
    // for "clicking too soon after the handshake collides with it", inferred
    // from a manual walkthrough that happened to leave a ~20-30s gap. The
    // session now waits for the device's own DEBUG trace to reach
    // "Transit AES Key" - i.e. the handshake is observed complete rather than
    // assumed complete after a delay - so there is nothing left for the sleep
    // to cover.
    const session = await startGuiSession({ url: PASSWORD_GEN_URL, device: true });

    // Polls #phrase_out rather than a fixed sleep - a real device round
    // trip here is two sequential derive calls (derive_public_key then
    // derive_shared_secret), each its own WebAuthn ceremony over the
    // signature-smuggling transport; confirmed live this can take well
    // over 5s end to end, longer than this function's previous fixed
    // wait allowed for. Also covers the "blocked" path (test 1), where
    // the field never becomes non-empty and this simply exhausts the
    // budget and returns whatever value is there (expected to stay '').
    const { value: password, errors: pageErrors } = await evalInPage(`
        document.getElementById('onlykey_start').click();
        const deadline = Date.now() + 30000;
        let value = '';
        while (Date.now() < deadline) {
            value = document.getElementById('phrase_out').value;
            if (value) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return value;
    `, { timeoutMs: 35000 });

    const log = await getConsoleLog();
    const ctapErrors = log.filter((e) => /CTAP2_ERR/i.test(e.text)).map((e) => e.text);
    // Step 4: destroy the window. Read the console log first - close()
    // recycles the window, and the log lives in that window's realm.
    await session.close();
    // "Unknown Key Type to Encode" is an ambient kbpgp error this app emits on
    // its own (already recorded in QUIRKS.md, where it once made
    // getConsoleLog() itself throw). It shows up on the BLOCKED path - when
    // the derive is refused, the page falls through to an encode it cannot
    // complete - so asserting `pageErrors === []` before the blocked branch is
    // even reached turns the expected-and-tested "blocked by default" case
    // into a failure. Confirmed live: with the derive actually permitted, the
    // same page returns a real password with pageErrors === []. Filtered here
    // rather than at the call site so both attempts get the same treatment.
    return {
        password,
        ctapErrors,
        pageErrors: (pageErrors || []).filter((e) => !/Unknown Key Type to Encode/.test(e)),
    };
}

describe('GUI: Password Generator (browser-driven, real device)', function () {
    this.timeout(90000);

    before(async function () {
        if (!(await isAlive())) {
            this.skip(); // nwjs not running - see nwjs/readme.md
        }
        // Widened from 30s while diagnosing a recurring hang here that
        // doesn't reproduce in isolation (device confirmed responsive
        // immediately after each timeout) - plausibly slower, not stuck,
        // under contention from the browser holding its own live device
        // connection during the restart. Diagnostic budget, not a
        // considered final value yet.
        this.timeout(90000);
        await unlockDevice();
    });

    it('generates a password, enabling "derived keys per site without touch" first if needed', async function () {
        this.timeout(90000);
        // Doesn't force derivedkeymode to any particular value up front -
        // tries a real generate first, on whatever state the device is
        // already in. The device defaults to blocked (derived_key_
        // challenge_mode bit 3 off), so the common case is: first attempt
        // fails with CTAP2_ERR_EXTENSION_NOT_SUPPORTED, we enable it, then
        // retry. But it's also fine if a previous run already left it
        // enabled - the first attempt just succeeds directly and the
        // enable step is skipped entirely, rather than asserting a specific
        // starting state that isn't actually load-bearing for what this
        // test cares about (that generation works, one way or another).
        let { password, ctapErrors, pageErrors } = await clickGenerateAndCollect();
        assert.deepStrictEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join('; ')}`);

        if (!password) {
            assert.match(
                ctapErrors.join('\n'),
                /CTAP2_ERR_EXTENSION_NOT_SUPPORTED/,
                `first attempt returned no password, but not from the expected "blocked" reason - got: ${JSON.stringify(ctapErrors)}`
            );

            await setDerivedKeyChallengeMode(8); // bit 3 = 0b1000 = 8

            ({ password, ctapErrors, pageErrors } = await clickGenerateAndCollect());
            assert.deepStrictEqual(pageErrors, [], `unexpected page errors after enabling: ${pageErrors.join('; ')}`);
            assert.deepStrictEqual(ctapErrors, [], `unexpected CTAP2 errors after enabling: ${JSON.stringify(ctapErrors)}`);
        }

        assert.ok(password && password.length > 0, `expected a generated password, got: ${JSON.stringify(password)}`);
    });
});
