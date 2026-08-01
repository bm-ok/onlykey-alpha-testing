const assert = require('assert');
const { execFile } = require('child_process');
const { isAlive, evalInPage, getConsoleLog } = require('../lib/nwjs_client');
const { unlockDevice } = require('../lib/device');
const { SeremuChannel, sleep } = require('../lib/hid');
const { VENV_BIN, NO_RESPONSE_TIMEOUT_MS } = require('../lib/config');
const { ensureUnlocked, setStoredKeyChallengeMode } = require('../lib/gui_helpers');
const { startGuiSession } = require('../lib/gui_session');
const { armFailFast, waitInPage } = require('../lib/gui_wait');
const { challengeDigitsForPayload } = require('../lib/composite_pgp_challenge');
const { runInConfigMode } = require('../lib/config_mode');

// Maintainer's TC-11: composite PGP-PQC (ML-KEM-768 + ML-DSA-65 + X25519 +
// Ed25519), the last unfinished maintainer test case. Exercises the real
// src/plugins/pgp-pqc/ page end-to-end: generate (host-only) -> load via
// `onlykey-cli setpqc` (this app can't load keys itself - OKSETPRIV isn't
// reachable over the browser's WebAuthn transport, confirmed by direct
// firmware read, see the implementation plan) -> encrypt (host-only) ->
// decrypt (device, 2 challenge confirms: X25519 + ML-KEM halves) -> sign
// (device, 2 challenge confirms: Ed25519 + ML-DSA-65 halves) -> verify
// (host-only).
//
// UNTESTED against hardware before this - by inspection, mirroring the
// proven classic RSA/ECC transport (onlykey-pgp.js) and the proven X-Wing
// derive GUI pattern (test/15) as closely as possible. This is the FIRST
// real-hardware exercise of: the firmware's new chunked-retrieval path for
// large responses (ML-DSA-65 signatures, 3309 B - added this session,
// send_stored_response()/ok_extension.cpp), the enc=true fix to
// okpqc.cpp's send_transport_response calls (also this session), and the
// composite openpgp.js hardware hooks wiring (composite_pgp.js,
// onlykey-3rd-party.js). Expect a real debugging cycle - every other TC
// this session that reached real hardware for the first time found at
// least one genuine bug, despite "verified by inspection" beforehand.
//
// Challenge-PIN automation: decrypt and sign EACH need TWO separate
// device confirmations (confirmed via composite_pgp.js's own hooks smoke
// test - hooks.ecdh + hooks.mlkemDecaps fire separately for decrypt;
// hooks.signer drives HALF_ECC then HALF_PQC sequentially for sign), so a
// full round trip needs 4 total auto-confirmed challenges. The digits are
// SHA256(exact payload bytes)[0]/[15]/[31] % 6 + 1 (see
// composite_pgp_challenge.js).
//
// Decrypt's digits are captured via a Node-side/in-page DRY RUN with a
// fake device (no real hardware touched) BEFORE the real operation - safe
// here because the ECDH ephemeral point / ML-KEM ciphertext come from the
// already-fixed ciphertext blob, not anything regenerated per call.
//
// Sign CANNOT use that same dry-run-then-predict approach: v6 OpenPGP
// signatures embed a MANDATORY random salt in the hashed data (crypto-
// refresh spec), so openpgp.js computes a genuinely different digest on
// EVERY sign() call, even with an identical pinned `date` - confirmed live
// this session (a dry run's predicted digits never matched the real
// call's device-computed challenge). Sending wrong digits to a device with
// a self-destruct PIN configured (test/00-setup.test.js) is not
// acceptable, so sign instead captures each digest in REAL TIME: the real
// `ok.composite_sign` (exposed test-only via window.__pgpPqcTestHooks.ok,
// see pgp-pqc.js) is wrapped to stash the exact [component]+digest wire
// payload into a page-global the INSTANT it's computed, before the real
// device call fires - Node polls that global to know exactly what to send,
// no prediction involved. See setupRealtimeSignCapture/pollPendingDigest
// below.
const PGP_PQC_URL = 'http://localhost:3000/app/pgp-pqc';
const SHORT_PRESS = 10; // '\n'
const PRIMED_RE = /Encrypted Buffer/; // done_process_packets()'s DEBUG print, okcore.cpp - see composite_pgp_challenge.js

function runCli(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            require('path').join(VENV_BIN, 'onlykey-cli'),
            args,
            { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
        );
    });
}

// Waits for the next "Encrypted Buffer" priming signal, then injects one
// set of 3 challenge digits - one call per device confirmation needed.
// Tolerates a missed signal the same way pqc_decrypt.js does (channel
// output can go silent under heavy DEBUG print load): if the signal
// doesn't show up in time, sends the digits anyway rather than hanging -
// priming is very likely done by then regardless.
// primedTimeoutMs defaults generously: the ML-KEM ciphertext (1088 B) and
// ML-DSA-65 signature (3309 B) halves chunk-send over the WebAuthn bridge
// (~228 B/chunk, each a full CBOR/CTAP2 assertion round trip) - much
// slower per-chunk than the raw-HID transport pqc_decrypt.js's X-Wing path
// uses, so its 20s budget (comfortable there) isn't enough here. Confirmed
// live: the small 32-byte ECDH half reliably primes and confirms within
// 20s, but the ML-KEM half's priming signal was still ~20s+ out when the
// wait gave up, so its digits got sent blind (before the device was
// listening), rejected as "incorrect challenge".
// Accumulates TC11DEBUG lines across the whole test (confirmOneChallenge's
// own channel.clearBuffer() would otherwise wipe out an earlier challenge's
// firmware debug output before the test gets a chance to inspect it after
// a failure).
const tc11DebugLog = [];

// A failed device operation must report what the DEVICE said, not just that
// the host stopped waiting. Without this the whole diagnosis was "did not
// appear within 90000ms", while the firmware had been printing the reason on
// the DEBUG channel the entire time.
//
// Folds the trace into err.message rather than console.log()ing it, so it
// survives into mocha's failure output instead of scrolling past above it.
function attachDeviceTrace(err, channel, label, { lines = 40 } = {}) {
    if (!channel) return err;
    let buffer = '';
    try { buffer = channel.buffer || ''; } catch (e) { return err; } // channel already closed
    for (const line of buffer.split('\n')) {
        if (line.includes('TC11DEBUG')) tc11DebugLog.push(line);
    }
    // Write the WHOLE trace to a file and name it. A tail is a guess about
    // which slice of the trace matters, and the guess was wrong: 40 lines of a
    // decrypt failure covered only the polling loop, while the priming that
    // caused it had already scrolled off.
    let dumpPath = null;
    try {
        const os = require('os');
        const fs = require('fs');
        dumpPath = require('path').join(os.tmpdir(), `tc11-${label}-trace.log`);
        fs.writeFileSync(dumpPath, buffer);
    } catch (e) { /* diagnostics must never replace the real error */ }

    const tail = buffer.split('\n').filter((l) => l.trim()).slice(-lines);
    err.message += `\n\n--- device DEBUG trace during ${label} (last ${tail.length} lines`
        + (dumpPath ? `; FULL trace: ${dumpPath}` : '') + `) ---\n${tail.join('\n')}`;
    if (tc11DebugLog.length) {
        err.message += `\n--- TC11DEBUG ---\n${tc11DebugLog.join('\n')}`;
    }
    return err;
}

// Waits for the device to prime the confirmation challenge, then enters the
// three digits - each one gated on the device's own acknowledgement of the
// previous one.
//
// NO TIMERS. Every step proceeds on a recognised device response or throws;
// nothing continues because time passed.
//
// This previously did the opposite in the one place it mattered most: if the
// "Encrypted Buffer" priming signal did not arrive within its budget it
// logged `primed: false` and **sent the digits anyway**, on the theory that
// priming was "very likely done by then regardless". That is unrecognised
// state treated as success - and it is actively unsafe, because a wrong
// challenge on a device with a self-destruct PIN configured
// (test/00-setup.test.js) is not a retryable mistake. If the device has not
// said it is ready, the only correct move is to stop.
//
// The fixed 400ms between presses is gone for the same reason. The firmware
// echoes `I received from DEBUG: <digit>` from its terminator branch exactly
// once per complete press, and dispatches the press inline in loop() right
// afterwards - so the echo for press N+1 cannot appear until press N's
// handler has returned. Waiting on that echo is what the delay was
// approximating, and unlike the delay it cannot be wrong.
// Parses the firmware's `Received Message` byteprint out of the DEBUG trace.
//
// done_process_packets() prints exactly the bytes the challenge is hashed
// over - `byteprint(packet_buffer, packet_buffer_offset)` - immediately before
// computing Challenge_button1/2/3. So the host can check, rather than assume,
// that the device assembled the same payload the digits were derived from.
//
// byteprint() writes uppercase hex WITHOUT zero padding ("F3 0 0 8C"), one
// space between bytes, wrapped in blank lines.
function parseReceivedMessage(buffer) {
    const idx = buffer.lastIndexOf('Received Message');
    if (idx === -1) return null;
    const after = buffer.slice(idx + 'Received Message'.length);
    // Bytes run until the next non-hex label line the firmware prints.
    const match = after.match(/^[\s]*((?:[0-9A-Fa-f]{1,2}[ \r\n]+)+)/);
    if (!match) return null;
    const bytes = match[1].trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
    if (bytes.some((b) => Number.isNaN(b))) return null;
    return Buffer.from(bytes);
}

async function confirmOneChallenge(channel, challenge, { primedTimeoutMs = NO_RESPONSE_TIMEOUT_MS, ackTimeoutMs = 8000 } = {}) {
    const digits = challenge.digits || challenge;
    const expectedPayload = challenge.payload || null;
    for (const line of channel.buffer.split('\n')) {
        if (line.includes('TC11DEBUG')) tc11DebugLog.push(line);
    }
    channel.clearBuffer();

    try {
        await channel.waitFor(PRIMED_RE, primedTimeoutMs);
    } catch (e) {
        throw new Error(
            `device never primed the challenge (no "Encrypted Buffer" within ${primedTimeoutMs}ms) - ` +
            'refusing to enter digits blind, since a wrong challenge counts against the self-destruct PIN'
        );
    }

    // The challenge digits are SHA256 over the bytes the DEVICE accumulated.
    // If those differ from the bytes we hashed, the digits are wrong before a
    // single button is pressed - and entering them would spend a
    // self-destruct-PIN attempt to learn something already visible here.
    if (expectedPayload) {
        const received = parseReceivedMessage(channel.buffer);
        if (!received) {
            console.log('[DEBUG confirm] no "Received Message" byteprint in trace - cannot verify payload');
        } else if (!received.equals(expectedPayload)) {
            throw new Error(
                `device accumulated a DIFFERENT payload than the digits were computed over:\n` +
                `  host sent   ${expectedPayload.length} bytes: ${expectedPayload.toString('hex').slice(0, 64)}...\n` +
                `  device has  ${received.length} bytes: ${received.toString('hex').slice(0, 64)}...\n` +
                `  first difference at byte ${(() => {
                    const n = Math.min(received.length, expectedPayload.length);
                    for (let i = 0; i < n; i++) if (received[i] !== expectedPayload[i]) return i;
                    return n;
                })()}`
            );
        } else {
            console.log(`[DEBUG confirm] device payload verified (${received.length} bytes)`);
        }
    }

    console.log('[DEBUG confirm] sending digits', JSON.stringify(digits));
    for (const digit of digits) {
        const code = digit.charCodeAt(0);
        const echo = new RegExp(`I received from DEBUG: ${code}(?!\\d)`, 'g');
        const before = channel.countMatches(echo);
        channel.send([code, SHORT_PRESS]);
        try {
            await channel.waitForCount(echo, before + 1, ackTimeoutMs);
        } catch (e) {
            throw new Error(`device never acknowledged challenge digit '${digit}' within ${ackTimeoutMs}ms`);
        }
    }

    for (const line of channel.buffer.split('\n')) {
        if (line.includes('TC11DEBUG')) tc11DebugLog.push(line);
    }
}

async function confirmChallenges(channel, challenges, opts) {
    for (const challenge of challenges) {
        await confirmOneChallenge(channel, challenge, opts);
    }
}

async function openPgpPqcPage() {
    // startGuiSession() (lib/gui_session.js) is the standard open -> settle ->
    // test -> close flow shared by every GUI test, and the settle is exactly
    // what this page needs: onlykeyApi.sharedsec (used by
    // sendCompositePayload's aesgcm_encrypt) only exists once the page's
    // OKCONNECT handshake resolves (onlykey-api.js's OK_CONNECT()). Acting
    // before that is what made the real decrypt/sign calls fail with
    // "undefined is not iterable" deep inside aesgcm_encrypt.
    //
    // It also opens a genuinely fresh window every time, which is why the
    // about:blank bounce this file used to need before re-opening the page is
    // gone - that was a workaround for getAppPage() only navigating when the
    // target URL differed from the current one.
    const session = await startGuiSession({ url: PGP_PQC_URL, device: true });
    // Arm the traps before anything can throw. Every wait in this file breaks
    // on window.__guiFatal, so a page exception ends the test where it happens
    // instead of being discovered after a 90s DOM poll (lib/gui_wait.js).
    await armFailFast();
    return session;
}

async function clickGenerateAndCollect() {
    const { value, errors: pageErrors } = await evalInPage(`
        document.getElementById('pgp_generate').click();
        const deadline = Date.now() + 20000;
        let pub = '', blobHex = '';
        while (Date.now() < deadline) {
            pub = document.getElementById('pgp_public_key').value;
            blobHex = document.getElementById('pgp_blob_hex').value;
            if (pub && blobHex) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return { pub, blobHex, status: document.getElementById('pgp_generate_status').textContent };
    `, { timeoutMs: 25000 });
    assert.deepStrictEqual(pageErrors, [], `unexpected page errors during generate: ${pageErrors.join('; ')}`);
    assert.ok(value && value.pub && !/ERROR/.test(value.status), `generate failed: ${value && value.status}`);
    assert.strictEqual(value.blobHex.length, 320, `expected 160-byte (320 hex char) blob, got ${value.blobHex.length} chars`);
    return value;
}

async function clickEncryptAndCollect(slot, plaintext) {
    const { value, errors: pageErrors } = await evalInPage(`
        document.getElementById('pgp_slot').value = ${slot};
        document.getElementById('pgp_plaintext').value = ${JSON.stringify(plaintext)};
        document.getElementById('pgp_encrypt').click();
        const deadline = Date.now() + 20000;
        let ciphertext = '';
        while (Date.now() < deadline) {
            ciphertext = document.getElementById('pgp_ciphertext_out').value;
            if (ciphertext) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return ciphertext;
    `, { timeoutMs: 25000 });
    assert.deepStrictEqual(pageErrors, [], `unexpected page errors during encrypt: ${pageErrors.join('; ')}`);
    assert.ok(value && /^-----BEGIN PGP MESSAGE-----/.test(value), `expected armored ciphertext, got: ${JSON.stringify(value)}`);
    return value;
}

// Dry-run capture, no real hardware touched - see this file's top comment.
async function captureDecryptChallenges(armoredPublicKey, armoredCiphertext, slot) {
    const { value, errors: pageErrors } = await evalInPage(`
        const { openpgp, compositePgp } = window.__pgpPqcTestHooks;
        const captured = [];
        const fakeOk = {
            composite_decrypt: async (_slot, data) => { captured.push(Array.from(data)); return new Uint8Array(32); },
            composite_sign: async () => { throw new Error('unexpected sign call during decrypt capture'); },
        };
        const pub = await openpgp.readKey({ armoredKey: ${JSON.stringify(armoredPublicKey)} });
        compositePgp.registerCompositeHooks(openpgp, fakeOk, ${slot});
        const hwKey = openpgp.createHardwarePrivateKey(pub);
        const message = await openpgp.readMessage({ armoredMessage: ${JSON.stringify(armoredCiphertext)} });
        let debugErr = null;
        try {
            await openpgp.decrypt({ message, decryptionKeys: hwKey, format: 'utf8' });
        } catch (e) {
            // expected - the fake device's dummy shares fail the real
            // KMAC-combine/AES-keywrap integrity check. Only the captured
            // payload bytes matter here.
            debugErr = (e && e.stack) || String(e);
        }
        openpgp.clearHardwareHooks();
        return { captured, debugErr };
    `, { timeoutMs: 15000 });
    assert.deepStrictEqual(pageErrors, [], `unexpected page errors during decrypt capture: ${pageErrors.join('; ')}`);
    assert.strictEqual(value.captured.length, 2, `expected 2 captured decrypt payloads (ecdh + mlkemDecaps), got ${value.captured.length}. debugErr: ${value.debugErr}`);
    for (const bytes of value.captured) {
        console.log('[DEBUG capture]', Buffer.from(bytes).toString('hex'), 'len', bytes.length);
    }
    const digitSets = value.captured.map(challengeDigitsForPayload);
    console.log('[DEBUG digits]', JSON.stringify(digitSets));
    // Payloads travel with the digits so confirmOneChallenge() can verify the
    // device accumulated the SAME bytes before entering anything.
    return value.captured.map((payload, i) => ({ payload: Buffer.from(payload), digits: digitSets[i] }));
}

// Wires composite hooks with a WRAPPED ok.composite_sign that stashes each
// real [component]+digest wire payload into window.__tc11PendingDigest the
// instant it's computed - BEFORE calling through to the real device
// transport - so pollPendingDigest() below can pick it up. See this file's
// top comment on why sign needs this instead of decrypt's dry-run capture.
async function setupRealtimeSignCapture(armoredPublicKey, slot) {
    const { errors: pageErrors } = await evalInPage(`
        const { openpgp, compositePgp, ok } = window.__pgpPqcTestHooks;
        window.__tc11PendingDigest = null;
        const wrappedOk = {
            composite_decrypt: (...args) => ok.composite_decrypt(...args),
            composite_sign: async (slot, component, digest) => {
                const payload = new Uint8Array(1 + digest.length);
                payload[0] = component;
                payload.set(digest, 1);
                window.__tc11PendingDigest = Array.from(payload);
                return ok.composite_sign(slot, component, digest);
            },
        };
        const pub = await openpgp.readKey({ armoredKey: ${JSON.stringify(armoredPublicKey)} });
        compositePgp.registerCompositeHooks(openpgp, wrappedOk, ${slot});
        window.__tc11HwKey = openpgp.createHardwarePrivateKey(pub);
        return true;
    `, { timeoutMs: 15000 });
    assert.deepStrictEqual(pageErrors, [], `unexpected page errors during setupRealtimeSignCapture: ${pageErrors.join('; ')}`);
}

// The REAL sign, driven directly (not via the Sign button, which has no
// hook into window.__tc11HwKey) - fire-and-forget, resolved later once
// both challenges are confirmed.
function kickOffRealSign(plaintext) {
    return evalInPage(`
        const { openpgp } = window.__pgpPqcTestHooks;
        const message = await openpgp.createCleartextMessage({ text: ${JSON.stringify(plaintext)} });
        const armored = await openpgp.sign({ message, signingKeys: window.__tc11HwKey, format: 'armored' });
        document.getElementById('pgp_signature_out').value = armored;
        return armored;
        // Sign is fire-and-forget: pollPendingDigest() and confirmOneChallenge()
        // hold the real no-response budget for each half, and both throw the
        // moment the device goes quiet. This outer cap only has to outlive the
        // two halves plus their confirmations so their errors surface first.
    `, { timeoutMs: NO_RESPONSE_TIMEOUT_MS * 6 });
}

// Polls the page-global setupRealtimeSignCapture's wrapped composite_sign
// stashes each real digest into, clearing it once read.
async function pollPendingDigest({ maxMs = NO_RESPONSE_TIMEOUT_MS, pollMs = 200 } = {}) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const { value } = await evalInPage(`
            if (window.__guiFatal) return { fatal: window.__guiFatal };
            const d = window.__tc11PendingDigest;
            window.__tc11PendingDigest = null;
            return d ? { digest: d } : null;
        `, { timeoutMs: 5000 });
        // A fatal in the page means openpgp.js's sign() has already died -
        // no later digest is coming, so stop now instead of waiting out maxMs
        // and then blaming a timeout for someone else's exception.
        if (value && value.fatal) throw new Error(`composite sign aborted - page fatal: ${value.fatal}`);
        if (value && value.digest) return value.digest;
        await sleep(pollMs);
    }
    throw new Error(`Timed out after ${maxMs}ms waiting for the next composite_sign digest`);
}

async function clickDecryptAndCollect(armoredCiphertext) {
    // Kick the operation off, then wait via waitInPage() rather than an
    // in-page deadline loop that reports only at the end. The 90s here is a
    // backstop for a device still working through the ML-KEM half; a page
    // fatal or an ERROR status ends the wait at the moment it happens.
    // Discovering a first-second TypeError 90 seconds later is what this whole
    // helper exists to stop (see lib/gui_wait.js).
    await armFailFast();
    await evalInPage(`
        document.getElementById('pgp_ciphertext_in').value = ${JSON.stringify(armoredCiphertext)};
        document.getElementById('pgp_decrypt').click();
        return true;
    `, { timeoutMs: 15000 });

    return waitInPage(`document.getElementById('pgp_plaintext_out').value`, {
        // The page's own status line is the progress signal - onlykey-3rd-party
        // emits "Decrypting - confirm on the device" / "Decryption complete"
        // through it, so a device working its way through the ML-KEM half keeps
        // the clock alive while a wedged one does not.
        progressExpr: `document.getElementById('pgp_decrypt_status').textContent`,
        failExpr: `(function () {
            const s = document.getElementById('pgp_decrypt_status').textContent;
            return /ERROR/.test(s) ? s : '';
        })()`,
        label: 'composite decrypt',
    });
}

async function clickVerifyAndCollect(armoredSignedMessage) {
    const { value, errors: pageErrors } = await evalInPage(`
        document.getElementById('pgp_verify_in').value = ${JSON.stringify(armoredSignedMessage)};
        document.getElementById('pgp_verify').click();
        const deadline = Date.now() + 15000;
        let status = '';
        while (Date.now() < deadline) {
            status = document.getElementById('pgp_verify_status').textContent;
            if (status) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return status;
    `, { timeoutMs: 20000 });
    assert.deepStrictEqual(pageErrors, [], `unexpected page errors during verify: ${pageErrors.join('; ')}`);
    return value;
}

describe('GUI: Composite PGP-PQC (browser-driven, real device) (TC-11)', function () {
    // No multi-minute overrides. Every wait inside this file honours the 30s
    // no-response rule (lib/config.js NO_RESPONSE_TIMEOUT_MS), so mocha's own
    // timeout should never be what stops a run - if it ever fires, something
    // is waiting without a response check and THAT is the bug to fix.

    let channel;

    before(async function () {
        if (!(await isAlive())) {
            this.skip(); // nwjs not running - see nwjs/readme.md
        }
        await unlockDevice();
        // Force the full 3-digit challenge for stored (RSA-slot) keys -
        // see setStoredKeyChallengeMode's own doc comment in gui_helpers.js.
        // If this is left non-zero on the physical device (from an earlier
        // test/session), done_process_packets() skips computing
        // Challenge_button1/2/3 for our composite decrypt/sign entirely and
        // checks against a stale single-button value instead, which is what
        // was actually causing every confirmation attempt to fail with
        // "Error incorrect challenge was entered" here.
        await setStoredKeyChallengeMode(0);
    });

    afterEach(async function () {
        if (channel) {
            try { channel.close(); } catch (e) { /* already gone */ }
            channel = null;
            // No settle sleep here. SeremuChannel.connect() already retries
            // with a liveness probe, so the next open proves the handle is
            // usable instead of a fixed delay assuming it.
        }
    });

    it('TC-11: generate, load, encrypt, decrypt, sign, and verify a composite PGP-PQC key via the GUI', async function () {
        const slot = 1;
        const plaintext = `TC-11 composite PGP-PQC roundtrip payload ${Date.now()}\n`;
        await openPgpPqcPage();
        const { pub: armoredPublicKey, blobHex } = await clickGenerateAndCollect();
        // OKSETPRIV (setpqc's wire message) only writes when the device is
        // in config mode (okcore.cpp's OKSETPRIV case) - otherwise it's a
        // silent no-op that still returns a locally-generated "success"
        // message from the CLI (send_message() doesn't surface the
        // device's "Error not in config mode" hidprint text), which is
        // exactly what made this look like a load bug rather than a
        // missing precondition. runInConfigMode() (lib/config_mode.js) is
        // the dedicated, reusable enter/run/exit sequence built this
        // session to replace the previously scattered, inconsistently-timed
        // copies of this same dance - it unlocks, confirms real config-mode
        // entry (not just a blind wait), runs the operation, sleeps 2s so
        // the flash write settles before the exit restart, then exits and
        // re-unlocks. Config mode itself has no explicit exit besides
        // reboot, and while active it silently drops OKDECRYPT/OKSIGN/
        // OKPING (not in okcore.cpp's config-mode command whitelist), which
        // is exactly why the exit+re-unlock has to happen before the
        // upcoming decrypt/sign round trips.
        const loadResult = await runInConfigMode(() => runCli(['setpqc', `RSA${slot}`, blobHex]));
        assert.strictEqual(loadResult.code, 0, `onlykey-cli setpqc failed:\n${loadResult.stdout}\n${loadResult.stderr}`);
        assert.match(loadResult.stdout, /Loaded composite PQC PGP key/, `unexpected setpqc output: ${loadResult.stdout}`);
        // The restart above invalidates onlykeyApi.sharedsec - it's derived
        // (nacl.box.before) from a fresh ECDH exchange with the device's own
        // OKCONNECT keypair, which is regenerated every boot. The page's
        // OKCONNECT handshake already completed once (in openPgpPqcPage(),
        // before this restart), so its cached sharedsec is now stale -
        // exactly what made the real decrypt/sign calls fail with "undefined
        // is not iterable" deep inside aesgcm_encrypt. Reload the page fresh
        // (forcing a new OKCONNECT against the now-stable, post-restart
        // device) and re-populate the DOM's public key field from the
        // Node-side value already captured above, since a real navigation
        // clears it. startGuiSession() opens a genuinely fresh window every
        // call, so re-opening the same URL really is a new realm - no
        // about:blank bounce needed to force it.
        await openPgpPqcPage();
        await evalInPage(`document.getElementById('pgp_public_key').value = ${JSON.stringify(armoredPublicKey)}; return true;`);
        const armoredCiphertext = await clickEncryptAndCollect(slot, plaintext);
        const decryptDigitSets = await captureDecryptChallenges(armoredPublicKey, armoredCiphertext, slot);
        channel = new SeremuChannel();
        await channel.connect();
        let decryptedPlaintext;
        try {
            [decryptedPlaintext] = await Promise.all([
                clickDecryptAndCollect(armoredCiphertext),
                confirmChallenges(channel, decryptDigitSets),
            ]);
        } catch (e) {
            throw attachDeviceTrace(e, channel, 'decrypt');
        }
        channel.close();
        channel = null;
        assert.strictEqual(decryptedPlaintext, plaintext, 'device-decrypted content does not match the original plaintext');

        await setupRealtimeSignCapture(armoredPublicKey, slot);
        channel = new SeremuChannel();
        await channel.connect();
        const signPromise = kickOffRealSign(plaintext);
        // Sign needs 2 sequential confirms (Ed25519 half, then ML-DSA-65
        // half) - poll for each real digest as openpgp.js computes it,
        // rather than predicting both upfront (see this file's top comment
        // on why prediction can't work for v6 signatures).
        for (let i = 0; i < 2; i++) {
            const payload = await pollPendingDigest();
            await confirmOneChallenge(channel, {
                payload: Buffer.from(payload),
                digits: challengeDigitsForPayload(payload),
            });
        }
        let armoredSignedMessage;
        try {
            const { value, errors: pageErrors } = await signPromise;
            assert.deepStrictEqual(pageErrors, [], `unexpected page errors during real sign: ${pageErrors.join('; ')}`);
            assert.ok(value && /^-----BEGIN PGP SIGNED MESSAGE-----/.test(value), `expected an armored cleartext-signed message, got: ${JSON.stringify(value)}`);
            armoredSignedMessage = value;
        } catch (e) {
            throw attachDeviceTrace(e, channel, 'sign');
        }
        channel.close();
        channel = null;
        const verifyStatus = await clickVerifyAndCollect(armoredSignedMessage);
        assert.match(verifyStatus, /Signature VALID/, `expected a valid signature, got: ${verifyStatus}`);
    });
});
