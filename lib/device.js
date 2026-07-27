const path = require('path');
const { execFile } = require('child_process');
const { SeremuChannel, sleep } = require('./hid');
const { PINS, VENV_BIN } = require('./config');

const PIN_ADVANCE_SCRIPT = path.join(__dirname, 'py', 'pin_advance.py');

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

// Firmware digit encoding: buttons are '1'-'6' (ASCII), short press = '\n'
// terminator, long press = ' ' terminator (okcore.cpp ~2454-2516).
const SHORT_PRESS = 10; // '\n'
const LONG_PRESS = 32; // ' '

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

    pressButton(digit, { long = false } = {}) {
        const digitByte = digit.toString().charCodeAt(0);
        const terminator = long ? LONG_PRESS : SHORT_PRESS;
        this.channel.send([digitByte, terminator]);
    }

    enterPinDigits(pin) {
        for (const digit of String(pin)) {
            this.pressButton(digit, { long: false });
        }
    }

    // DEBUG-only device wipe. '0' = userspace only (safe, no reflash needed),
    // '9' = full wipe (also erases firmware hash, forces bootloader).
    // Both require the 'C' long-press confirm (okcore.cpp: WIPE_PENDING_*).
    wipeDevice({ full = false } = {}) {
        this.pressButton(full ? '9' : '0', { long: true });
        this.channel.send(['C'.charCodeAt(0), LONG_PRESS]);
    }

    // DEBUG-only non-destructive restart (CPU_RESTART(), okcore.cpp). Needed
    // after PIN setup since 'initialized' is only recomputed from flash at
    // boot (OnlyKey.ino setup()) - the host-message PIN flow below commits
    // flash state but never itself reboots.
    restartDevice() {
        this.pressButton('8', { long: true });
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
    async runInitialSetup({
        primary = PINS.primary,
        secondary = PINS.secondary,
        selfDestruct = PINS.selfDestruct,
        settleMs = 500,
    } = {}) {
        const rounds = [
            ['primary', primary],
            ['secondary', secondary],
            ['sd', selfDestruct],
        ];
        for (const [kind, pin] of rounds) {
            await sendPinAdvance(kind); // msg1: arm
            await sleep(settleMs);
            this.enterPinDigits(pin); // round 1
            await sleep(settleMs);
            await sendPinAdvance(kind); // msg2: store round 1
            await sleep(settleMs);
            await sendPinAdvance(kind); // msg3: arm confirm round
            await sleep(settleMs);
            this.enterPinDigits(pin); // round 2
            await sleep(settleMs);
            await sendPinAdvance(kind); // msg4: commit
            await sleep(settleMs);
        }
        this.restartDevice();
        // restartDevice() only fires CPU_RESTART() - the physical reboot and
        // USB re-enumeration take real wall-clock time. Without this settle,
        // a caller's immediate device.connect()/pressButton() can land mid-
        // reboot and throw "Cannot write to hid device: Timer expired" (same
        // race class as the config-mode entry fix in pqc_keygen.js, widened
        // to the same 1500ms budget there).
        await sleep(1500);
    }

    unlockWithPrimaryPin(pin = PINS.primary) {
        // No terminator button on unlock - profile1hashevaluate() re-checks
        // after every appended digit and auto-unlocks on match.
        this.enterPinDigits(pin);
    }
}

// Shells out to onlykey-cli (from the venv) to classify device state, since
// the binary HID protocol is already implemented there - no need to
// reimplement it in Node just to check status.
//
// Uses `settime` rather than `getlabels`: getlabels parses all 12 slot
// labels and is fragile against this dev-board firmware (index/ord()
// crashes seen against 0c-coder-python-onlykey's per-slot parsing);
// settime just round-trips one string ("UNLOCKEDv3.0.4-testc" /
// "INITIALIZED" / "UNINITIALIZED") and is enough to classify state.
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
            path.join(VENV_BIN, 'onlykey-cli'),
            ['settime'],
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

// Polls checkStatus() until it reports a real classification (anything but
// 'unknown') instead of a fixed sleep after restartDevice(). Confirmed live
// this matters: SeremuChannel.connect()'s own liveness probe (a bare 2-byte
// write) is NOT sufficient on its own to detect a genuinely-rebooted device
// - during CPU_RESTART()'s USB re-enumeration window, that write can
// succeed against a stale/soon-to-vanish handle (a false positive - the
// digits sent through it are silently lost, and the device never actually
// unlocks). onlykey-cli settime (what checkStatus() shells out to) reliably
// surfaces that same window as 'unknown'/a connection error instead, so
// polling on it is a real, working readiness signal - verified empirically
// against real hardware (a naive skip-the-sleep attempt using only
// connect()'s probe failed outright; this one didn't, consistently).
// Real-world timing observed: ~5-7s typical, this caps the wait rather than
// assuming a fixed duration - both faster in the common case and fails
// fast (a clear error, not a silent hang) if the device is genuinely gone.
async function waitForDeviceReady({ maxMs = 20000, pollMs = 400 } = {}) {
    const deadline = Date.now() + maxMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await checkStatus({ retries: 0, timeoutMs: 2000 });
        if (last.state !== 'unknown') return last;
        await sleep(pollMs);
    }
    throw new Error(`Device did not become ready within ${maxMs}ms (last status: ${JSON.stringify(last)})`);
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

    await waitForDeviceReady();

    const device2 = await new OnlyKeyDevice().connect();
    device2.unlockWithPrimaryPin(pin);
    device2.close();

    for (let i = 0; i < 20; i++) {
        const status = await checkStatus({ retries: 0, timeoutMs: 3000 });
        if (status.state === 'unlocked') return status;
        await sleep(400);
    }
    throw new Error('Device did not report unlocked after entering primary PIN');
}

module.exports = { OnlyKeyDevice, checkStatus, waitForDeviceReady, unlockDevice };
