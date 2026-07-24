// Drives age-plugin-onlykey's PQC keygen (TC-04) end-to-end without a human
// at the device, by simulating exactly the button sequence a real user
// would perform - no firmware changes, no protocol shortcuts:
//
//   1. Unlock the device (primary PIN) - the button-6 long-press below only
//      registers as "enter config mode" from inside payload()'s
//      `if (unlocked || ...)` branch (OnlyKey.ino ~854-908); while locked
//      it's indistinguishable from a plain password digit.
//   2. Long-press button 6 to enter config mode (OnlyKey.ino ~895-908).
//      OKSETPRIV (which PQC keygen goes through) is rejected with "Error
//      not in config mode" otherwise - see okcore.cpp case OKSETPRIV. This
//      long-press additionally requires `!isfade` (OnlyKey.ino:910) -
//      isfade is set by the unlock completion's fadeon() and only clears
//      ~2s later via a scheduled task, so a long-press sent too soon after
//      unlocking is silently ignored (it still prints "Button selected 6"
//      - that print fires regardless of which branch ends up handling it,
//      so it is NOT proof config mode was entered). Confirmed via live
//      DEBUG-serial trace: a blind fixed wait here was too short often
//      enough that every following "unlock" digit got reinterpreted as a
//      normal (still-unlocked) slot action instead of a PIN guess. Fixed
//      by verifying re-entry into config mode indirectly - if step 3's
//      re-unlock doesn't produce the firmware's own unlock-success debug
//      print within a timeout, config mode never engaged, so retry the
//      long-press + re-unlock as a unit (see enterConfigModeConfirmed()).
//   3. That long-press *also* forces unlocked=false on non-DUO hardware
//      (Duo_config[0]!=1) as a re-authentication requirement, so the
//      device needs the primary PIN re-entered a second time before
//      OKSETPRIV's `unlocked==true` check passes.
//   4. Run age-plugin-onlykey. The real UX for the 3-button confirmation
//      challenge (okcore.cpp done_process_packets() / OnlyKey.ino
//      CRYPTO_AUTH 1->4) is the device's own LEDs, not CLI text - the
//      correct onlykey_hid.py (0c-coder-python-onlykey) never prints the
//      digits. So this harness computes them itself: done_process_packets()
//      hashes the 9-byte packet_buffer ([keytype, 0xFF*8], see the firmware
//      patch in ecc_priv_flash()) with SHA256 and takes
//      hash[0]%6+1, hash[15]%6+1, hash[31]%6+1 (okcore.cpp ~7305-7324,
//      non-DUO branch) - deterministic given keytype is always known ahead
//      of time (X-Wing=6, ML-KEM=5).
//
//      Timing here matters more than it looks. Priming the challenge
//      (ecc_priv_flash()'s `if (!CRYPTO_AUTH)` branch -> process_packets()
//      -> done_process_packets(), ending in "Encrypted Buffer" + fadeon())
//      runs synchronously inside the firmware's single HID-report handler,
//      *blocking loop()* for ~0.6-0.9s. Button presses that arrive during
//      that window aren't queued - they're silently dropped (confirmed via
//      live DEBUG-serial trace: sending all 3 presses right after the
//      CLI's "Press OnlyKey button" print, which fires ~instantly and well
//      before the device round-trips, lost 2 of 3, and the response came
//      back 0 bytes or truncated). Originally fixed by waiting for the
//      device's own "Encrypted Buffer" print before sending presses, but
//      that print goes over the same verbose DEBUG-serial channel that
//      turned out to drop output under load in combined test runs (see
//      unlockOnce's comment) - so instead this waits on the CLI's own
//      "Press OnlyKey button" text (reliable, plain stdio) plus a fixed
//      margin comfortably past the observed ~0.6-0.9s priming window. The
//      isfade-gated press window is 20s (fadeoffafter20()) after that, so
//      there's no rush once triggered.
//   5. Restart the device (DEBUG '8') afterward so config mode - which has
//      no explicit exit besides reboot - doesn't leak into later tests.

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { SeremuChannel, sleep } = require('./hid');
const { PINS, VENV_BIN } = require('./config');
const { checkStatus } = require('./device');

const SHORT_PRESS = 10; // '\n'
const LONG_PRESS = 32; // ' '

// Firmware key-type bytes (okcore.h KEYTYPE_MLKEM768 / KEYTYPE_XWING),
// mirrored in 0c-coder-python-onlykey's onlykey/age_plugin/__init__.py.
const KEYTYPE_MLKEM768 = 5;
const KEYTYPE_XWING = 6;

// Replicates done_process_packets()'s challenge-digit derivation
// (okcore.cpp ~7312-7324, non-DUO branch) for a known keytype trigger
// payload, so the harness doesn't need the device/CLI to tell it the
// digits - it can compute them ahead of time.
function challengeDigitsForKeytype(keytype) {
    const packetBuffer = Buffer.concat([Buffer.from([keytype]), Buffer.alloc(8, 0xff)]);
    const hash = crypto.createHash('sha256').update(packetBuffer).digest();
    return [hash[0] % 6 + 1, hash[15] % 6 + 1, hash[31] % 6 + 1].map(String);
}

function enterPinDigits(channel, pin) {
    for (const digit of String(pin)) {
        channel.send([digit.charCodeAt(0), SHORT_PRESS]);
    }
}

// Confirming unlock via the verbose DEBUG-serial output (e.g. waiting for
// password.cpp's "Profile Key " print, only reached deep in
// profile1hashevaluate()'s successful-match branch) turned out unreliable
// even on a slow, deliberate, isolated attempt with nothing else going on:
// live tracing showed the PIN visibly accepted (hash match reached, no
// divergent branch taken) with intermediate prints appearing right up to
// the point "Profile Key " should have followed - and then nothing, no
// error either. That points to the DEBUG-serial link itself dropping
// output under the sheer volume of hex-dump text this path produces, not
// a JS-side timing race. checkStatus() (device.js) sidesteps this
// entirely - it's a single clean status string over the *main* HID
// interface (via onlykey-cli), a completely different code path from the
// verbose DEBUG channel, and is what 00-setup.test.js already relies on
// successfully for the same "did unlock happen" question.
async function unlockOnce(channel, pin, { pollAttempts = 10, pollDelayMs = 500 } = {}) {
    channel.clearBuffer();
    enterPinDigits(channel, pin);
    for (let i = 0; i < pollAttempts; i++) {
        await sleep(pollDelayMs);
        const status = await checkStatus({ retries: 0 });
        if (status.state === 'unlocked') return;
    }
    throw new Error('Unlock not confirmed via checkStatus()');
}

// Retries a full PIN entry if unlock doesn't confirm in time.
async function unlockAndConfirm(channel, pin, { attempts = 3 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await unlockOnce(channel, pin);
            return;
        } catch (e) {
            if (attempt === attempts) {
                throw new Error(`Unlock not confirmed after ${attempts} attempts: ${e.message}`);
            }
            await sleep(1000);
        }
    }
}

// Long-presses button 6 and re-enters the PIN, retrying the pair as a unit
// if config-mode entry doesn't confirm - the isfade race means the
// long-press can silently no-op, in which case the "re-unlock" digits just
// get read as normal (still-unlocked) slot-button presses. `isfadeMarginMs`
// is a blind wait - there's no reliable debug print for "isfade cleared" to
// key off (see unlockOnce's comment on DEBUG-serial output dropping under
// load), and the window it's approximating (~2s after unlock's fadeon())
// was confirmed live: 500ms here reliably lost the long-press every time.
//
// Verifying success is subtler than just "did the re-unlock confirm":
// checkStatus() only reports the device's *current* lock state, and a
// no-op long-press leaves the device unlocked throughout - so a
// still-unlocked device and a genuinely re-locked-then-re-unlocked one
// both report 'unlocked' at the end, indistinguishable by that check
// alone. Caught this live: entry appeared to "succeed" 2/2 times by that
// measure, then the actual OKSETPRIV request failed with "Error not in
// config mode" (config mode's own state, checked firmware-side, is a
// separate boolean the checkStatus()/'unlocked' signal never touches).
// Confirming the device actually passes through 'locked' right after the
// long-press - not just that it's unlocked again afterward - is what
// actually proves the long-press registered as a long-press.
async function enterConfigModeConfirmed(channel, primaryPin, { attempts = 4, isfadeMarginMs = 2500 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await sleep(isfadeMarginMs);
        channel.send(['6'.charCodeAt(0), LONG_PRESS]);
        // Live DEBUG-serial tracing (temporary script, not committed) caught
        // this directly: right after the long-press, the device is
        // genuinely busy for ~2-3s (PIN re-evaluation, profile-key
        // derivation, CTAP2/wallet init housekeeping - all visible in the
        // DEBUG log), and the *host's* read on the main HID protocol
        // (checkStatus()'s `onlykey-cli settime`, not the DEBUG channel)
        // can time out and come back empty during that window even though
        // the device is responding fine on its own schedule - the device's
        // own log shows it sent "INITIALIZED" right when the host's read
        // gave up with nothing. Was landing this check right after a fixed
        // 1000ms + a 3-try/500ms retry budget (~1.5s total) - not always
        // enough to clear the ~2-3s busy window; widened both.
        await sleep(1500);
        try {
            // A couple of retries here, not a single zero-retry check - the
            // device can be transiently unsettled right at this moment
            // (same class of flakiness checkStatus()'s own retry loop
            // exists for elsewhere), and a spurious 'unknown' here would
            // wrongly count as "long-press didn't register" and burn a
            // whole retry attempt for nothing.
            const status = await checkStatus({ retries: 5, retryDelayMs: 600 });
            if (status.state !== 'locked') {
                throw new Error(`Expected 'locked' right after the long-press (config mode's re-auth step), got '${status.state}' - the long-press likely didn't register`);
            }
            await unlockAndConfirm(channel, primaryPin, { attempts: 1 });
            return;
        } catch (e) {
            if (attempt === attempts) {
                throw new Error(`Could not confirm config-mode entry after ${attempts} attempts: ${e.message}`);
            }
        }
    }
}

// Runs `age-plugin-onlykey <args>`, entering config mode, re-unlocking, and
// auto-confirming the device's 3-button challenge - the same sequence a
// real user performs at the device. `keytype` picks which digits to compute
// (KEYTYPE_XWING for --generate/xwing_keygen, KEYTYPE_MLKEM768 for the
// ML-KEM path). Resolves with { code, stdout, stderr }.
async function runWithAutoConfirm(args, {
    primaryPin = PINS.primary,
    timeoutMs = 60000,
    pressDelayMs = 400,
    primingMarginMs = 2500,
    keytype = KEYTYPE_XWING,
} = {}) {
    // Give any HID handle a prior test/suite was still holding (e.g.
    // 00-setup's last checkStatus() subprocess) time to fully release -
    // seen this connect() race intermittently when this suite runs
    // immediately after another one in the same mocha process, not when
    // run in isolation.
    await sleep(1500);

    const channel = new SeremuChannel();
    await channel.connect();

    try {
        // 0: force a known-locked starting state - if the device were
        // already unlocked, the "unlock" digits below would instead be
        // read as normal slot-button presses (payload()'s
        // `if (unlocked || ...)` branch), not a PIN attempt.
        channel.send(['8'.charCodeAt(0), LONG_PRESS]);
        channel.close();
        await sleep(3000); // let CPU_RESTART() + USB re-enumeration settle
        await channel.connect();

        // 1: unlock (config-mode long-press only registers while unlocked).
        await unlockAndConfirm(channel, primaryPin);

        // 2+3: enter config mode (which re-locks as a re-auth step) and
        // unlock again, retrying if the isfade race means the long-press
        // didn't land.
        await enterConfigModeConfirmed(channel, primaryPin);

        const digits = challengeDigitsForKeytype(keytype);

        return await new Promise((resolve, reject) => {
            const child = spawn(path.join(VENV_BIN, 'age-plugin-onlykey'), args, { timeout: timeoutMs });

            let stdout = '';
            let stderr = '';
            let triggered = false;

            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => {
                stderr += d.toString();
                // "Press OnlyKey button..." fires right before the OKSETPRIV
                // send, over the CLI's own stdio (reliable, unlike the
                // verbose DEBUG-serial channel - see unlockOnce's comment on
                // that channel dropping output under load, which turned out
                // to also affect waiting for "Encrypted Buffer" often enough
                // in combined test runs to matter). Priming itself is
                // synchronous and bounded (observed ~0.6-0.9s every time),
                // so a fixed margin comfortably past that is simpler and
                // just as reliable as waiting for a print that might not
                // arrive.
                if (triggered || !/Press OnlyKey button/.test(stderr)) return;
                triggered = true;
                (async () => {
                    await sleep(primingMarginMs);
                    for (const digit of digits) {
                        channel.send([digit.charCodeAt(0), SHORT_PRESS]);
                        await sleep(pressDelayMs);
                    }
                })();
            });

            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
    } finally {
        // 4: exit config mode by rebooting (DEBUG-only '8', no data touched).
        // Wait for re-enumeration before returning - otherwise whatever
        // test/command runs right after this one can race the reboot (seen
        // as "open failed" / garbled onlykey-cli responses when a 00-setup
        // suite followed this one with no gap). Guard the send - if an
        // earlier step failed because the channel itself was broken,
        // send() throwing here would mask the real error and, worse, skip
        // close() below, leaking the HID handle and hanging the process.
        try {
            channel.send(['8'.charCodeAt(0), LONG_PRESS]);
        } catch (e) { /* channel already broken - nothing to send to */ }
        channel.close();
        await sleep(3000);
    }
}

// Matches age_plugin's own error text for a short/truncated HID response,
// e.g. "X-Wing keygen: got 1088 bytes, expected 1216". This is firmware-
// side USB packet loss under load (confirmed via live trace: python-onlykey's
// own read loop already retries until its full deadline - see
// onlykey_hid.py's _read_response() - and still comes up short, meaning the
// device genuinely never sent the missing report(s), not that the host
// missed one it could have retried for). Not fixable from here; retrying
// the whole operation (fresh restart/unlock/configmode/keygen) is the
// practical mitigation until it's root-caused on the firmware side.
const TRUNCATED_RESPONSE_RE = /got \d+ bytes, expected \d+/;

// Retries the full runWithAutoConfirm() sequence - not just the keygen call
// - since a truncated response leaves the device's state (CRYPTO_AUTH,
// config mode) in whatever it was mid-operation; only a clean restart is a
// known-good starting point to try again from.
async function runWithAutoConfirmRetrying(args, opts = {}, { attempts = 3 } = {}) {
    let lastResult;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        lastResult = await runWithAutoConfirm(args, opts);
        if (lastResult.code === 0 || !TRUNCATED_RESPONSE_RE.test(lastResult.stderr)) {
            return lastResult;
        }
    }
    return lastResult;
}

module.exports = {
    runWithAutoConfirm,
    runWithAutoConfirmRetrying,
    challengeDigitsForKeytype,
    enterConfigModeConfirmed,
    unlockAndConfirm,
    KEYTYPE_MLKEM768,
    KEYTYPE_XWING,
};
