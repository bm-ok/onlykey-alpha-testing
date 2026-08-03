const path = require('path');
const { execFile } = require('child_process');
const { SeremuChannel, sleep, isOnlyKeyPresent } = require('./hid');
const { PINS, VENV_BIN } = require('./config');

const PIN_ADVANCE_SCRIPT = path.join(__dirname, 'py', 'pin_advance.py');
const CHECK_STATUS_SCRIPT = path.join(__dirname, 'py', 'check_status.py');

// Sends a bare OKSETPIN/OKSETPDPIN/OKSETSDPIN message (client HID interface,
// not the SEREMU debug channel) via python-onlykey's own OnlyKey class -
// mirrors OnlyKeyComm.js's sendSetPin/sendSetPin2/sendSetSDPin, which is how
// OnlyKeyWizard.js advances the firmware's PIN state machine on Classic
// hardware without waiting on its internal 20s inactivity timer
// (fadeoffafter20sec(), okcore.cpp). Confirmed via okcore.cpp:342-362
// (case OKPIN/OKPINSD/OKPINSEC) that this works with no prior button press
// needed to arm the state - the message itself arms it.
function sendPinAdvance(kind, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile(
            path.join(VENV_BIN, 'python3'),
            [PIN_ADVANCE_SCRIPT, kind],
            { timeout: timeoutMs },
            (err, stdout, stderr) => {
                if (err) reject(new Error(`pin_advance ${kind} failed: ${stderr || err.message}`));
                else resolve();
            }
        );
    });
}

// Waits for the firmware's own print for a PIN-flow step instead of sleeping.
// Every step of okcore.cpp's three PIN state machines prints an unambiguous
// success string, and every step that can fail prints an unambiguous failure
// string ("Error PIN is not between 7 - 10 digits", "Error PINs Don't Match").
// Waiting on those means a failure is reported here, in the device's own
// wording and at the step that actually failed, instead of surfacing later as
// an unexplained "still uninitialized".
async function awaitPinStep(channel, label, okRe, failRe = null, timeoutMs = 10000) {
    const combined = failRe ? new RegExp(`${okRe.source}|${failRe.source}`) : okRe;
    let match;
    try {
        match = await channel.waitFor(combined, timeoutMs);
    } catch (e) {
        throw new Error(`${label}: device did not acknowledge the step within ${timeoutMs}ms`);
    }
    if (failRe && failRe.test(match[0])) {
        throw new Error(`${label}: device reported "${match[0].trim()}"`);
    }
    return match[0];
}

// Firmware line encoding (okcore.cpp, touch_sense_loop): buttons are '1'-'6'
// with an optional '!' hold tier, return terminates the line, and anything not
// starting with a button digit is a command path. See SeremuChannel.sendPress.

class OnlyKeyDevice {
    constructor() {
        this.channel = new SeremuChannel();
    }

    async connect(opts) {
        await this.channel.connect(opts);
        return this;
    }

    close() {
        this.channel.close();
    }

    // `hold` is a tier name - 'tap' (default), 'hold', 'long' or 'longest'.
    // The firmware's payload() has more duration bands than a single long press
    // can reach, so the tier has to be chosen rather than toggled.
    pressButton(digit, { hold = 'tap' } = {}) {
        this.channel.sendPress(digit.toString(), { hold });
    }

    // The firmware acknowledges every injected digit with one debug line:
    // "password appended with N" (primary), "2nd profile password appended
    // with N" (secondary) or "SD password appended with N" (self-destruct) -
    // all three share the "password appended with" substring.
    //
    // Measured live on this hardware: the device consumes injected digits at
    // ~97ms each, so a 7-digit PIN takes ~680ms to land in the password
    // buffer. Callers that follow the digits with a state-machine advance
    // message must wait for that, not a fixed sleep - see runInitialSetup().
    //
    // awaitAcks is opt-in because unlock (unlockWithPrimaryPin) deliberately
    // does not depend on debug output at all: it closes the channel straight
    // away and confirms over the main HID protocol via checkStatus() instead,
    // for the reasons in TEST-PLAN finding #10.
    async enterPinDigits(pin, { awaitAcks = false, ackTimeoutMs = 8000 } = {}) {
        const digits = String(pin);
        if (awaitAcks) this.channel.clearBuffer();
        // One line for the whole PIN: the firmware queues the presses and
        // replays them one per loop() iteration, so there is no per-digit delay
        // here to tune. A PIN is at most 10 digits, inside the firmware's
        // 16-slot queue, so it always goes in a single write.
        this.channel.sendPress(digits);
        if (!awaitAcks) return;
        try {
            await this.channel.waitForCount(/password appended with/gi, digits.length, ackTimeoutMs);
        } catch (e) {
            // The verbose DEBUG-serial channel is known to drop output under
            // load (TEST-PLAN finding #10), so a missing acknowledgement is
            // not proof the digit never landed. Fall back to a conservative
            // margin at the measured per-digit rate rather than failing here;
            // runInitialSetup()'s end-state check over the main HID protocol
            // is what actually decides whether setup worked.
            await sleep(digits.length * 200);
        }
    }

    // DEBUG-only device wipe. '0C' = userspace only (safe, no reflash needed),
    // '9C' = full wipe (also erases firmware hash, forces bootloader).
    //
    // The trailing 'C' is the confirmation, and the firmware only acts on a
    // complete path within one line - so there is no arm/confirm handshake to
    // sequence here, and no window in which a half-sent wipe is pending.
    wipeDevice({ full = false } = {}) {
        this.channel.clearBuffer();
        this.channel.sendLine(full ? '9C' : '0C');
    }

    // DEBUG-only non-destructive restart (CPU_RESTART(), okcore.cpp). Needed
    // after PIN setup since 'initialized' is only recomputed from flash at
    // boot (OnlyKey.ino setup()) - the host-message PIN flow below commits
    // flash state but never itself reboots.
    restartDevice() {
        this.channel.sendLine('8');
    }

    // A press whose delivery the device itself confirms.
    //
    // okcore.cpp's DEBUG serial handler prints "I received from DEBUG: <code>"
    // once per completed line, carrying the line's first byte - the button for
    // a press line, the command for a path. That makes it the one universal
    // acknowledgement available on this channel, and the firmware dispatches
    // the line inline in loop() straight afterwards, so the next line cannot be
    // echoed until this one's handler has returned.
    //
    // Prefer a command's own completion print where it has one (see
    // runInitialSetup) - that confirms the work finished rather than that the
    // line arrived. This is the fallback for presses that have no such print.
    async pressButtonAcked(digit, { hold = 'tap', timeoutMs = 5000 } = {}) {
        const code = digit.toString().charCodeAt(0);
        const echo = new RegExp(`I received from DEBUG: ${code}(?!\\d)`, 'g');
        const before = this.channel.countMatches(echo);
        this.pressButton(digit, { hold });
        await this.channel.waitForCount(echo, before + 1, timeoutMs);
    }

    // Drives the firmware's out-of-box setup flow the same way OnlyKeyWizard.js
    // does on Classic hardware. Each PIN type is a 4-message state machine
    // (okcore.cpp set_primary_pin/set_secondary_pin/set_sd_pin, states 0-3):
    //   msg1 (arm)   -> "Enter PIN"
    //   [round 1 digits entered]
    //   msg2 (store) -> validates + stores round 1 as the expected value, resets buffer
    //   msg3 (armConfirm) -> "re-enter your PIN to confirm" (does NOT touch the buffer)
    //   [round 2 digits entered]
    //   msg4 (commit) -> validates round 2 + password.evaluate() match, commits
    // No 20s timer waits - each message is sent as soon as the previous step
    // is done, matching OnlyKeyWizard.js's Step2-7 enterFn/exitFn pairs.
    //
    // Every step here waits on the firmware's own print for that step rather
    // than on a fixed sleep. That is not a refinement, it is what makes the
    // flow correct: the device consumes injected digits at ~97ms each
    // (measured live), so a 7-digit PIN takes ~680ms to land, and the 500ms
    // sleep this used to rely on let the "store" message arrive mid-burst.
    // The firmware then saw a 5-digit PIN, answered "Error PIN is not between
    // 7 - 10 digits", and the whole sequence ran to completion having
    // committed nothing.
    async runInitialSetup({
        primary = PINS.primary,
        secondary = PINS.secondary,
        selfDestruct = PINS.selfDestruct,
    } = {}) {
        const rounds = [
            ['primary', primary],
            ['secondary', secondary],
            ['sd', selfDestruct],
        ];
        // All three PIN state machines print the same step strings
        // (okcore.cpp set_primary_pin/set_secondary_pin/set_sd_pin), so the
        // buffer is cleared between steps to keep each wait unambiguous.
        const TOO_SHORT = /Error PIN is not between 7 - 10 digits/;
        for (const [kind, pin] of rounds) {
            this.channel.clearBuffer();
            await sendPinAdvance(kind); // msg1: arm
            await awaitPinStep(this.channel, `${kind} arm`, /Enter PIN/);

            await this.enterPinDigits(pin, { awaitAcks: true }); // round 1

            this.channel.clearBuffer();
            await sendPinAdvance(kind); // msg2: store round 1
            await awaitPinStep(this.channel, `${kind} store`, /Storing PIN/, TOO_SHORT);

            this.channel.clearBuffer();
            await sendPinAdvance(kind); // msg3: arm confirm round
            await awaitPinStep(this.channel, `${kind} arm-confirm`, /Confirm PIN/);

            await this.enterPinDigits(pin, { awaitAcks: true }); // round 2

            this.channel.clearBuffer();
            await sendPinAdvance(kind); // msg4: commit
            await awaitPinStep(
                this.channel,
                `${kind} commit`,
                /Both PINs Match/,
                /Error PINs Don't Match|Error PIN is not between 7 - 10 digits/
            );
        }
        // The restart is the one step with no observable debug feedback:
        // okcore.cpp ~2500-2503 prints "'8' restart requested" and then calls
        // CPU_RESTART() on the next line, which does not return - so the
        // device resets before the SEREMU buffer is flushed and neither that
        // print nor the byte echo before it ever reaches the host. Confirmed
        // live: waiting on either times out on a restart that demonstrably
        // happened. The real acknowledgement is the post-reboot status read
        // below, over the main HID protocol.
        this.restartDevice();
        // restartDevice() only fires CPU_RESTART() - the physical reboot and
        // USB re-enumeration take real wall-clock time. Without this settle,
        // a caller's immediate device.connect()/pressButton() can land mid-
        // reboot and throw "Cannot write to hid device: Timer expired" (same
        // race class as the config-mode entry fix in pqc_keygen.js, widened
        // to the same 1500ms budget there).
        await sleep(1500);

        // Verify the PINs actually committed, over the main HID protocol
        // rather than the debug channel. Without this the whole sequence can
        // run to completion, print nothing alarming, and leave the device
        // still UNINITIALIZED - which is exactly what a mid-burst advance
        // message causes ("Error PIN is not between 7 - 10 digits"), and it
        // used to surface one test later as a confusing unlock failure
        // instead of here, where the cause is.
        //
        // Deliberately not waitForDeviceReady(): after CPU_RESTART() the
        // device is locked, and a locked device mostly answers settime with
        // an empty read that checkStatusOnce() can only classify as
        // 'unknown' - measured live, only 2 of 14 polls over 22s returned the
        // recognizable "OnlyKey is locked" text. An *uninitialized* device,
        // by contrast, answers deterministically ("No PIN set, You must set a
        // PIN first"), so 'uninitialized' is the reliable signal to test for
        // and 'unknown' here means "not uninitialized", not "unreadable".
        const deadline = Date.now() + 15000;
        let status = null;
        let inconclusive = 0;
        while (Date.now() < deadline) {
            status = await checkStatus({ retries: 0, timeoutMs: 3000 });
            if (status.state !== 'unknown') break;
            // Three consecutive unreadable answers, after the device has had
            // time to re-enumerate, settle it: an uninitialized device would
            // have said so by now.
            if (++inconclusive >= 3) break;
            await sleep(300);
        }
        if (status.state === 'uninitialized') {
            throw new Error(
                `Initial setup did not commit: device still reports uninitialized after restart (${status.raw})`
            );
        }
        return status;
    }

    unlockWithPrimaryPin(pin = PINS.primary) {
        // No terminator button on unlock - profile1hashevaluate() re-checks
        // after every appended digit and auto-unlocks on match.
        this.enterPinDigits(pin);
    }
}

// Shells out to lib/py/check_status.py - deliberately NOT `onlykey-cli
// settime`, for two separate reasons, both confirmed against firmware
// source rather than inferred from behaviour:
//
// 1. A locked device never *answers* this at all. okcore.cpp's set_time()
//    (~1318) has no `unlocked == false` branch - it returns without
//    printing anything. The "INITIALIZED" string that locked-state
//    detection depends on comes from somewhere else entirely: a periodic
//    firmware task, `Task taskInitialized(1000, sendInitialized)`
//    (OnlyKey.ino:213), added when the device locks (400/498/905/919) and
//    removed on unlock (704), which broadcasts once a second regardless of
//    what the host sends. `read_string()` defaults to a 100ms read window
//    (client.py:442), so it lands inside a 1000ms broadcast gap most of the
//    time and reports nothing - measured 2026-07-31 as 12 of 14 polls over
//    22s returning empty, i.e. a locked device classified 'unknown' ~86% of
//    the time. check_status.py reads with a 2500ms timeout instead, which
//    always spans at least one full broadcast whatever the phase.
//
// 2. onlykey-cli constructs OnlyKey() at module import (cli.py), so its
//    own pre-existing _connect() HID-enumeration race can crash the
//    process before any subcommand runs - indistinguishable, from here,
//    from a real device fault. Status is needed constantly by internal
//    plumbing and has nothing to do with CLI correctness, so it should not
//    depend on the CLI starting up. onlykey-cli stays the right tool for
//    tests that are actually exercising the CLI (setpqc, storedkeymode,
//    derivedkeymode).
//
// The mechanism is otherwise identical to what `settime` does internally
// (set_time() then read_string()) - a write is genuinely required to
// elicit a reply; the device does not push status unprompted. It uses that
// rather than `getlabels` because getlabels parses all 12 slot labels and
// is fragile against this dev-board firmware (index/ord() crashes seen
// against the fork's per-slot parsing).
//
// The vendor OnlyKey() constructor's own HID-interface enumeration
// (client.py _connect()) assumes retail Classic/Color USB descriptors and
// can race right after CPU_RESTART() re-enumeration on this dev board -
// observed as either a raised OnlyKeyUnavailableException or (worse) a
// silent non-match that leaves `_hid` unset, surfacing later as
// `AttributeError: 'OnlyKey' object has no attribute '_hid'`. Retried here
// rather than fixed upstream, since it's a pre-existing enumeration gap
// unrelated to what this suite is validating.
function checkStatusOnce({ timeoutMs = 15000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'python3'),
            [CHECK_STATUS_SCRIPT],
            { timeout: timeoutMs },
            (err, stdout, stderr) => {
                const combined = `${stdout || ''}\n${stderr || ''}`;
                if (/UNINITIALIZED|No PIN set|must be configured first/i.test(combined)) {
                    resolve({ state: 'uninitialized', raw: combined });
                } else if (/^UNLOCKED/im.test(combined)) {
                    resolve({ state: 'unlocked', raw: combined });
                } else if (/OnlyKey is locked|^INITIALIZED/im.test(combined)) {
                    resolve({ state: 'locked', raw: combined });
                } else {
                    resolve({ state: 'unknown', raw: combined, error: err && err.message });
                }
            }
        );
    });
}

async function checkStatus({ timeoutMs = 15000, retries = 3, retryDelayMs = 2000 } = {}) {
    let result;
    for (let i = 0; i <= retries; i++) {
        result = await checkStatusOnce({ timeoutMs });
        if (result.state !== 'unknown') return result;
        if (i < retries) await sleep(retryDelayMs);
    }
    return result;
}

// Byte 90 ('Z'): not a command path in the DEBUG serial handler. okcore.cpp's
// dbg_run_command() recognises only '8', '0C' and '9C'; an unrecognised path
// does nothing whatsoever beyond the echo, which is exactly what a readiness
// probe wants.
const PROBE_BYTE = 'Z'.charCodeAt(0);
const PROBE_LINE = 'Z';

// Makes the device answer on a channel the caller already has open, and
// returns once it does. Because the DEBUG handler runs inline in loop(), the
// echo cannot come back while the firmware is busy with something else - so
// this doubles as the "it has finished what it was doing" signal for the
// stretches where the device is genuinely occupied (PIN re-evaluation,
// profile-key derivation, CTAP2/wallet init after a config-mode long-press).
async function probeDeviceResponsive(channel, { timeoutMs = 8000 } = {}) {
    const echo = new RegExp(`I received from DEBUG: ${PROBE_BYTE}(?!\\d)`, 'g');
    const before = channel.countMatches(echo);
    channel.sendLine(PROBE_LINE);
    await channel.waitForCount(echo, before + 1, timeoutMs);
}

// Confirms the device is running again after a restart by making it answer,
// rather than by waiting a fixed time or hoping a status read lands.
//
// The probe is one DEBUG press of a byte the firmware ignores. Every complete
// press makes okcore.cpp (~2478-2480) print "I received from DEBUG: <byte>",
// so the echo comes back with no side effect, and receiving it proves the
// firmware is running loop() and reading serial. That is strictly stronger
// than SeremuChannel.connect()'s own liveness probe, which only checks that a
// write succeeded - during CPU_RESTART()'s USB re-enumeration a write can
// succeed against a stale handle whose presses are then silently lost, and no
// echo comes back from a handle like that.
//
// This used to poll checkStatus() for any non-'unknown' state, which cannot
// work for the case it is most needed in: after a restart the device is
// *locked*, and a locked device answers `onlykey-cli settime` with an empty
// read on most attempts (measured 2026-07-31: 12 of 14 polls over 22s), which
// checkStatusOnce() can only classify as 'unknown'. That left this function
// waiting to get lucky, and it timed out across four separate test files in
// one suite run.
// Waits for the device to be back on the USB bus. Deliberately enumerate-only
// (node-hid's device list reads descriptor metadata and opens nothing), which
// makes it safe to call at moments when opening a handle is not.
//
// That distinction matters: opening a HID handle or spawning onlykey-cli while
// the device is mid CPU_RESTART() re-enumeration can land the caller in an
// uninterruptible kernel I/O wait (D state) that even SIGKILL will not clear -
// seen once already in this workspace as a stuck `onlykey-cli` during a failed
// config-mode entry (TEST-PLAN, TC-15). Checking presence first is free and
// sidesteps the whole hazard rather than retrying blind into it.
async function waitForUsbPresence({ maxMs = 10000, pollMs = 200 } = {}) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (isOnlyKeyPresent()) return true;
        await sleep(pollMs);
    }
    throw new Error(`OnlyKey did not re-enumerate on USB within ${maxMs}ms`);
}

async function waitForDeviceReady({ maxMs = 20000 } = {}) {
    const deadline = Date.now() + maxMs;
    const echo = new RegExp(`I received from DEBUG: ${PROBE_BYTE}(?!\\d)`);
    let lastError = null;
    while (Date.now() < deadline) {
        // Never open the channel below while the device is off the bus - see
        // waitForUsbPresence(). Failing this just means "not back yet", so it
        // falls through to another loop iteration rather than throwing.
        if (!isOnlyKeyPresent()) {
            try {
                await waitForUsbPresence({ maxMs: Math.max(0, Math.min(10000, deadline - Date.now())) });
            } catch (e) {
                lastError = e;
                continue;
            }
        }
        const channel = new SeremuChannel();
        try {
            // Short per-attempt budget: the interface itself disappears and
            // returns while the device re-enumerates, so failing fast and
            // trying again beats a long wait on one stale handle.
            await channel.connect({ retries: 4, retryDelayMs: 250 });
            channel.clearBuffer();
            channel.sendLine(PROBE_LINE);
            await channel.waitFor(echo, 2000);
            return true;
        } catch (e) {
            lastError = e;
        } finally {
            channel.close();
        }
    }
    throw new Error(
        `Device did not answer a DEBUG probe within ${maxMs}ms (last error: ${lastError && lastError.message})`
    );
}

// Waits for an already-triggered restart to come back, then enters the PIN.
// Split out of unlockDevice() because a caller that has just sent its own
// restart must not send a second one: back-to-back restarts re-trigger USB
// re-enumeration before the first reboot has settled, which config_mode.js
// found the hard way when its exit path used unlockDevice() directly.
async function waitReadyAndUnlock(primaryPin) {
    const pin = primaryPin || require('./config').PINS.primary;
    await waitForDeviceReady();

    const device = await new OnlyKeyDevice().connect();
    device.unlockWithPrimaryPin(pin);
    device.close();

    for (let i = 0; i < 20; i++) {
        const status = await checkStatus({ retries: 0, timeoutMs: 3000 });
        if (status.state === 'unlocked') return status;
        await sleep(400);
    }
    throw new Error('Device did not report unlocked after entering primary PIN');
}

// Unlocks only if the device is not already unlocked - so a caller that just
// needs "device usable" does not pay for a restart + PIN cycle to confirm
// something already true.
//
// This is deliberately a plain state check. It used to need a two-stage
// ambiguity dance (empty read -> sleep -> re-read -> guess) because an empty
// answer could not be told apart from a locked device; with checkStatus()
// now reading past the firmware's 1 Hz INITIALIZED broadcast, 'locked' is
// reported directly and there is nothing left to disambiguate.
async function ensureUnlocked() {
    const status = await checkStatus({ retries: 2, retryDelayMs: 500 });
    if (status.state === 'unlocked') return status;
    return unlockDevice();
}

// Shared restart-and-unlock-with-primary-PIN sequence, used by most test
// files to get to a known 'unlocked' state at the start of a test. Replaces
// each file's own previously-duplicated local copy of this same function
// (which used a fixed sleep(3000) here instead of waitForDeviceReady()).
async function unlockDevice({ primaryPin } = {}) {
    const pin = primaryPin || require('./config').PINS.primary;
    const device = await new OnlyKeyDevice().connect();
    device.restartDevice();
    device.close();

    return waitReadyAndUnlock(pin);
}

module.exports = {
    OnlyKeyDevice,
    checkStatus,
    waitForDeviceReady,
    waitForUsbPresence,
    probeDeviceResponsive,
    waitReadyAndUnlock,
    ensureUnlocked,
    unlockDevice,
};
