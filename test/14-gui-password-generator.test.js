const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { isAlive, evalInPage, getConsoleLog } = require('../lib/nwjs_client');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS, VENV_BIN } = require('../lib/config');
const { SeremuChannel, sleep } = require('../lib/hid');
const { enterConfigModeConfirmed, unlockAndConfirm } = require('../lib/pqc_keygen');

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

// Navigates the browser page (if one is open) away to about:blank before
// any raw HID operation (SeremuChannel, OnlyKeyDevice) touches the device
// directly. Confirmed live this contention is real, not just a timing
// coincidence: Chromium logs its own "FIDO HID device timeout" (visible in
// nwjs's own stdout) while a page sits loaded on the password-generator URL
// from a previous step, spaced out almost exactly matching this suite's own
// unlockDevice()/config-mode calls - and on at least one run, this
// contention coincided with the whole nwjs process going down mid-test
// (browser process gone, orphaned webapp server left on :3000, no crash
// dump - see nwjs/ensure.js's own doc comment for the sibling case where
// this was a confirmed native SIGSEGV instead). Blanking the page first
// releases whatever handle/outstanding request Chromium may be holding
// against the device before Node also opens it directly. Best-effort: if
// nwjs isn't reachable yet (e.g. this is the very first call in `before()`,
// no window open yet) or the eval fails, raw HID access doesn't depend on
// the browser at all, so this is safe to skip rather than fail on.
// A tiny inline status page (not a literal about:blank) so a human watching
// the nwjs window sees what raw-HID step is in flight instead of a dead-
// looking white screen - confirmed live this was confusing without it.
// Uses a fixed data: URL so repeated calls just update its text via
// evalInPage() rather than re-navigating each time (getAppPage() only
// navigates when the target url actually differs from the current page).
const STATUS_URL =
    'data:text/html,' +
    encodeURIComponent(
        '<body style="background:#111;color:#0f0;font:16px monospace;padding:2em"><h2>onlykey-testing: raw device I/O</h2><pre id="status">starting...</pre></body>'
    );

async function showStatus(text) {
    try {
        await evalInPage(`
            const el = document.getElementById('status');
            if (el) { el.textContent = ${JSON.stringify(text)}; }
            return true;
        `, { url: STATUS_URL });
    } catch (e) {
        /* nwjs not up / no window yet - raw HID doesn't need the browser */
    }
}

async function unlockDevice() {
    await showStatus('unlockDevice(): restarting device...');
    const device = await new OnlyKeyDevice().connect();
    device.restartDevice();
    device.close();
    await sleep(3000);
    await device.connect();
    await showStatus('unlockDevice(): sending primary PIN...');
    device.unlockWithPrimaryPin(PINS.primary);
    for (let i = 0; i < 10; i++) {
        await sleep(500);
        const status = await checkStatus({ retries: 0 });
        if (status.state === 'unlocked') break;
    }
    device.close();
    await sleep(500);
    await showStatus('unlockDevice(): done, device unlocked');
}

// Sets derived_key_challenge_mode to `value` (0 = fully off/blocked, 8 =
// bit 3 only, "derived keys per site without touch"). Used both to
// guarantee test 1's "blocked by default" precondition is actually true
// (this device's setting is persistent EEPROM state, not reset between
// runs - confirmed live: an earlier run of this same test, before this
// function had its config-mode-exit fix, left it stuck at 8, silently
// invalidating the "default" assumption for every run after) and to
// enable it for test 2.
//
// The firmware has no host-readable "get" for this setting - only two
// internal call sites (okcore.cpp's backup(), gated behind a 72-180 tick
// physical button-1 hold, and an internal challenge-flow check), neither
// reachable via any HID/OK* command (confirmed by reading the firmware
// source). So there's no way to *verify* the current value without
// entering config mode. To still avoid needlessly repeating the whole
// unlock/config-mode/CLI/exit/re-unlock cycle when we already know we set
// it to this value moments ago (a real, observed failure mode: retrying
// after an interrupted run re-enters config mode for a value that's
// already correct, adding risk/time for nothing) this caches the last
// value *this harness itself* successfully wrote, trusting it rather than
// re-verifying. That trust can go stale if anything outside this test
// process changes the setting (a firmware reflash, a factory reset, manual
// use of the device/CLI elsewhere) - acceptable for a harness that owns
// the device during its own runs, not something to rely on for an
// actual security assertion. Delete CACHE_PATH to force a real re-check.
const CACHE_PATH = path.join(__dirname, '..', '.derived-key-challenge-mode-cache.json');

function readCachedDerivedKeyChallengeMode() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')).value;
    } catch (e) {
        return undefined;
    }
}

function writeCachedDerivedKeyChallengeMode(value) {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify({ value, ts: Date.now() }));
    } catch (e) { /* best effort - worst case just re-enters config mode next time */ }
}

async function setDerivedKeyChallengeMode(value) {
    if (readCachedDerivedKeyChallengeMode() === value) {
        await showStatus(`setDerivedKeyChallengeMode(): already ${value} (cached) - skipping config mode`);
        await unlockDevice();
        return;
    }

    // Starts with a full restart+re-unlock (unlockDevice(), not just
    // unlockAndConfirm()) - config-mode entry's long-press timing margins
    // are tuned around a *known*, freshly-unlocked starting state (every
    // other working use of enterConfigModeConfirmed() this session -
    // pqc_keygen.js's own runWithAutoConfirm(), test/08, test/12 - always
    // restarts first). Skipping that and unlocking whatever state the
    // device happens to be in after the previous test's button click is
    // not equivalent: if it's already unlocked, unlockAndConfirm() trivially
    // "succeeds" (checkStatus() already reports 'unlocked') without a real
    // PIN ceremony having run, leaving the device in an arbitrary state the
    // long-press's margins were never tuned for - confirmed live, this is
    // what was actually happening (not device/browser USB contention, the
    // first theory tried here).
    await unlockDevice();

    const channel = new SeremuChannel();
    await channel.connect();
    try {
        await showStatus('setDerivedKeyChallengeMode(): confirming PIN...');
        await unlockAndConfirm(channel, PINS.primary);
        await showStatus('setDerivedKeyChallengeMode(): entering config mode...');
        await enterConfigModeConfirmed(channel, PINS.primary);
        await sleep(500);
        await showStatus(`setDerivedKeyChallengeMode(): setting derivedkeymode ${value}...`);
        const result = await runCli(['derivedkeymode', String(value)]);
        assert.strictEqual(result.code, 0, `derivedkeymode ${value} failed:\n${result.stderr}\n${result.stdout}`);
        writeCachedDerivedKeyChallengeMode(value);
    } finally {
        // Exit config mode by restarting - it has no explicit exit besides
        // reboot (same pattern as pqc_keygen.js's runWithAutoConfirm()).
        // Missing this left the device stuck showing config mode after
        // this function returned - confirmed live, a real bug, not just a
        // leftover-state annoyance for the next test to work around.
        await showStatus('setDerivedKeyChallengeMode(): exiting config mode...');
        try {
            channel.send(['8'.charCodeAt(0), 32]);
        } catch (e) { /* channel already broken - nothing to send to */ }
        channel.close();
        await sleep(3000);
    }
    // The exit-config-mode restart above always re-locks the device (same
    // as any restart) - re-unlock so the caller's next step (clicking
    // Generate) hits an unlocked device, not a locked one.
    await unlockDevice();
}

// Navigates to the page fresh (own OKCONNECT handshake, own console
// capture buffer - see inject_console_capture.js), clicks Generate, waits
// for a response, and returns { password, ctapErrors, pageErrors }.
//
// Verifies the device is actually unlocked *right before* letting the
// browser touch it, rather than trusting whatever state an earlier step
// left it in - confirmed live this matters: a locked device left the
// browser's WebAuthn ceremony sitting on a native "touch your key" prompt
// indefinitely instead of getting a clean, fast error back. A previous
// step (e.g. enableDerivedKeyChallengeModeBit3()'s config-mode-exit
// restart) always re-locks the device as a side effect - checking here
// rather than only at the end of that one caller keeps this function
// correct regardless of what runs before it.
async function ensureUnlocked() {
    const status = await checkStatus({ retries: 2, retryDelayMs: 500 });
    if (status.state !== 'unlocked') {
        await unlockDevice();
    }
}

// Polls the DOM for the page's own OKCONNECT handshake to actually settle
// (success or failure), rather than guessing with a blind sleep. Confirmed
// live this was a real bug, not just imprecision: with a fixed 1500ms
// sleep, clicking Generate while OKCONNECT's own device request was still
// in flight collided with it ("A request is already pending" - the device
// rejects the second request outright), so both tests got neither a
// password nor a CTAP error - the click's request never actually happened.
// onlykey-api.js's headermsg() writes a `.text-success` or `.text-danger`
// child into #header_messages once the handshake resolves either way -
// this is the only externally-observable (window/document-scoped) signal;
// the handshake's own state (onlykey_api.init, sharedsec, etc.) lives in a
// closure never exposed on window (confirmed by reading the source - see
// src/onlykey-fido2/onlykey/onlykey-api.js). The app's own handshake
// budget is a 2000ms setTimeout plus up to a 6000ms webauthn timeout, so
// timeoutMs here needs real margin above that, not just above the network
// round-trip.
async function waitForOkConnectSettled({ timeoutMs = 15000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { value } = await evalInPage(`
            const el = document.querySelector('#header_messages .text-success, #header_messages .text-danger');
            return el ? el.className : null;
        `);
        if (value) return value;
        await sleep(300);
    }
    throw new Error(`OKCONNECT handshake did not settle within ${timeoutMs}ms (#header_messages never got .text-success/.text-danger)`);
}

// Considered also waiting for a *second* app-triggered connect
// (src/plugins/index/index.js's doSetTime(2000) -> onlykeyApi.api.check(),
// which re-runs the whole OK_CONNECT() handshake ~2000ms after page start)
// before clicking, on the theory that clicking while it's still in flight
// risks the same 'A request is already pending' collision seen live in the
// console log. Disproved live: watched the console log for 12+s after the
// first connect settled and no second "OKCONNECT STATUS" ever appeared on
// this page/route - so gating on it would just make every run wait for a
// timeout that never resolves. Manually walking through navigate -> wait
// for #header_messages .text-success -> click (this function's actual
// sequence) succeeded cleanly on the first try with a real ~20-30s gap
// between settle and click (the natural time several separate diagnostic
// round-trips took) - a fixed post-settle margin here approximates that
// same gap without needing the diagnostic calls that produced it.
async function clickGenerateAndCollect() {
    await ensureUnlocked();
    await evalInPage('return true;', { url: PASSWORD_GEN_URL });
    const settledClass = await waitForOkConnectSettled();
    if (!/text-success/.test(settledClass)) {
        throw new Error(`OKCONNECT handshake settled as failed (${settledClass}) before Generate was ever clicked`);
    }
    await sleep(3000);
    await getConsoleLog({ clear: true });

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
    return { password, ctapErrors, pageErrors };
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
