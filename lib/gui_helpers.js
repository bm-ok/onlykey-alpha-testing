// Shared helpers for nwjs-driven ("GUI") tests that click through the real
// onlykey.github.io app pages - extracted from test/14 (the first GUI test,
// written to be the reference pattern for this style of test - see its own
// doc comment) so test/15 and any later GUI test reuse the same, already-
// proven logic instead of re-deriving it.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { evalInPage } = require('./nwjs_client');
const { ensureUnlocked } = require('./device');
const { withCachedSetting } = require('./config_mode');
const { sleep } = require('./hid');
const { VENV_BIN } = require('./config');

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

// Navigates the browser page (if one is open) to a small status page before
// any raw HID operation touches the device directly - confirmed live in
// test/14's development that a page left loaded on a real app URL can hold
// its own outstanding device request, contending with Node's own direct HID
// access (see test/14's doc comment for the full finding). Best-effort: if
// nwjs isn't reachable yet, this is safe to skip rather than fail on, since
// raw HID access doesn't depend on the browser at all.
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

// Polls the DOM for the page's own OKCONNECT handshake to actually settle
// (success or failure), rather than guessing with a blind sleep - see
// test/14's doc comment for the collision this avoids ("A request is
// already pending"). Works for any app page that uses the standard
// onlykey-api.js headermsg() convention (writes .text-success/.text-danger
// into #header_messages once the handshake resolves), not just
// password-generator specifically.
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

// ensureUnlocked() now lives in device.js (every caller wants the same
// "make sure it's usable, cheaply if it already is" behaviour, not just the
// GUI ones) and is re-exported here so existing importers keep working.
// It matters most right before letting the browser touch the device:
// confirmed live in test/14 that a locked device leaves the browser's
// WebAuthn ceremony hanging on a native "touch your key" prompt instead of
// failing fast.

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

// Sets derived_key_challenge_mode to `value` (0 = fully off/blocked, 8 =
// bit 3 only, "derived keys per site without touch") - the same gate
// ok_extension.cpp's derive_public_key/derive_shared_secret dispatch
// enforces for ALL non-REQ_PRESS keytypes (P256R1 for password-generator,
// X-Wing for age-derive alike - confirmed live: both hit
// CTAP2_ERR_EXTENSION_NOT_SUPPORTED identically on a freshly-set-up
// device). Extracted from test/14 (where this was first built out) so
// test/15 and any later GUI test share the same enable step instead of
// re-deriving it.
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

// The same idea for stored_key_challenge_mode (okcore.cpp's PGPCHALENGEMODE,
// `onlykey-cli storedkeymode`) - the stored-key (RSA/ECC slot) analogue of
// derived_key_challenge_mode above, and a hard prerequisite for TC-11.
//
// When either flag is set, done_process_packets() (okcore.cpp:7332) takes a
// shortcut: it sets CRYPTO_AUTH = 3 directly and **skips computing
// Challenge_button1/2/3 altogether**, so those globals keep whatever values
// the last challenge-computing operation left in them. A harness that derives
// the three digits itself (as pqc_keygen.js's challengeDigitsForKeytype() and
// composite_pgp_challenge.js both do) then sends three freshly-computed
// digits at a device comparing them against stale ones - every press
// mismatches and the firmware takes its "Error incorrect challenge was
// entered" branch on the very first confirmation. Left non-zero by an earlier
// session, this silently invalidates the whole composite-PGP challenge flow,
// so TC-11 must force it to 0 exactly as TC-18/19 forces the derived flag.
const STORED_CACHE_PATH = path.join(__dirname, '..', '.stored-key-challenge-mode-cache.json');

function readCachedStoredKeyChallengeMode() {
    try {
        return JSON.parse(fs.readFileSync(STORED_CACHE_PATH, 'utf8')).value;
    } catch (e) {
        return undefined;
    }
}

function writeCachedStoredKeyChallengeMode(value) {
    try {
        fs.writeFileSync(STORED_CACHE_PATH, JSON.stringify({ value, ts: Date.now() }));
    } catch (e) { /* best effort - worst case just re-enters config mode next time */ }
}

// Both setters are thin wrappers around config_mode.js now - see that
// module for the enter/exit sequence and the reasons behind it. Each used to
// carry its own near-duplicate copy of the full
// unlock/config-mode/CLI/exit/re-unlock dance.
async function setDerivedKeyChallengeMode(value) {
    await withCachedSetting({
        readCached: readCachedDerivedKeyChallengeMode,
        writeCached: writeCachedDerivedKeyChallengeMode,
        value,
        operationFn: async () => {
            await showStatus(`setDerivedKeyChallengeMode(): setting derivedkeymode ${value}...`);
            const result = await runCli(['derivedkeymode', String(value)]);
            if (result.code !== 0) {
                throw new Error(`derivedkeymode ${value} failed:\n${result.stderr}\n${result.stdout}`);
            }
        },
    });
}

async function setStoredKeyChallengeMode(value) {
    await withCachedSetting({
        readCached: readCachedStoredKeyChallengeMode,
        writeCached: writeCachedStoredKeyChallengeMode,
        value,
        operationFn: async () => {
            await showStatus(`setStoredKeyChallengeMode(): setting storedkeymode ${value}...`);
            const result = await runCli(['storedkeymode', String(value)]);
            if (result.code !== 0) {
                throw new Error(`storedkeymode ${value} failed:\n${result.stderr}\n${result.stdout}`);
            }
        },
    });
}

module.exports = {
    showStatus,
    waitForOkConnectSettled,
    ensureUnlocked,
    setDerivedKeyChallengeMode,
    setStoredKeyChallengeMode,
    STATUS_URL,
};
