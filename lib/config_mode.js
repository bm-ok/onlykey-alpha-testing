// Dedicated, reusable "enter config mode -> do one thing -> exit config
// mode" wrapper. Replaces the scattered, subtly-inconsistent copies of this
// same sequence previously duplicated across gui_helpers.js
// (setDerivedKeyChallengeMode/setStoredKeyChallengeMode) and pqc_keygen.js -
// each got small pieces right or wrong independently, so the fixes belong in
// one place where every caller gets them by construction.
//
// Three behaviours this module encodes, each with the evidence for it:
//
//   1. Only ever unlock ONCE per entry. An earlier version unlocked via
//      unlockDevice() and then again via unlockAndConfirm(), where the first
//      unlock's digits landed on an already-unlocked device and were read as
//      ordinary slot-button presses rather than a PIN attempt.
//
//   2. Never send a second restart on top of one already sent. Back-to-back
//      restarts re-trigger USB re-enumeration before the first reboot has
//      settled, which is why the exit path uses waitReadyAndUnlock() rather
//      than unlockDevice() (the latter restarts first).
//
//   3. Never open a HID handle or spawn onlykey-cli without first confirming
//      the device is enumerated - doing so mid CPU_RESTART() re-enumeration
//      risks an uninterruptible D-state wait that SIGKILL will not clear.
//      waitForUsbPresence()/waitForDeviceReady() (device.js) apply this, and
//      every path through this module funnels into them.
//
// Waits here are device-driven, not tuned constants. An earlier version of
// this module carried ~10s of settle sleeps per cycle
// (POST_OP_SETTLE_MS/EXIT_RESTART_SETTLE_MS/POST_CYCLE_REST_MS); those were
// compensating for status reads that could not see a locked device - the
// firmware answers a status request only when unlocked, and reports
// INITIALIZED via an unsolicited 1 Hz broadcast that a 100ms read window
// missed ~86% of the time (see lib/py/check_status.py and QUIRKS.md). With
// that read fixed, the device says what state it is in and the sleeps have
// nothing left to hide.

const { sleep, SeremuChannel, isOnlyKeyPresent } = require('./hid');
const { PINS } = require('./config');
const {
    checkStatus,
    waitForDeviceReady,
    waitForUsbPresence,
    waitReadyAndUnlock,
    ensureUnlocked,
    probeDeviceResponsive,
} = require('./device');
const { unlockAndConfirm, enterConfigModeConfirmed } = require('./pqc_keygen');


// Confirms a just-triggered restart actually happened, then that the device
// is back and usable.
//
// A restart always re-locks, so 'locked' is the one unambiguous signal that
// it genuinely took effect - waitForDeviceReady() alone would accept a device
// that never restarted at all. Watching the device leave the bus first is
// direct evidence rather than an assumption, but it is only a best-effort
// observation: the absence window is short and missing it is harmless, since
// the 'locked' assertion below is what actually decides. A device that
// ignored the restart stays unlocked and fails there.
async function waitForLockedAfterRestart({ absenceMaxMs = 2500 } = {}) {
    const absenceDeadline = Date.now() + absenceMaxMs;
    while (Date.now() < absenceDeadline && isOnlyKeyPresent()) await sleep(50);

    await waitForUsbPresence();
    await waitForDeviceReady();

    const status = await checkStatus({ retries: 5, retryDelayMs: 700 });
    if (status.state !== 'locked') {
        throw new Error(
            `Expected 'locked' after restart, got '${status.state}' - the restart may not have registered`
        );
    }
    return status;
}

// Runs `operationFn` with the device confirmed in config mode, then exits and
// leaves it unlocked again. Its return value is passed through.
//
// Both ends follow the same sequence: restart -> confirm locked -> unlock.
// The restart is the DEBUG-only '8' command path over the same SEREMU channel
// the unlock needs anyway - a reboot drops the underlying HID handle regardless
// of who opened it, so the channel is closed and reconnected around it either
// way. Sends the restart line and confirms the device ACTED on it, by watching
// it leave the USB bus.
//
// The line used to be fired blind. Input is dropped rather than queued while
// the firmware is busy (QUIRKS.md), so a dropped one left the device running
// and unlocked, and the only symptom was
// "Expected 'locked' after restart, got 'unlocked'" - a true statement about a
// command that was never received.
//
// The obvious acknowledgement, the firmware's `I received from DEBUG: <code>`
// echo, does NOT work for this particular command. It is printed before the
// line is acted on, but the action is CPU_RESTART(), which tears the USB stack
// down immediately - so the echo is usually lost with the connection it would
// have travelled over. Waiting for it timed out on a restart that had in fact
// succeeded, and the retry then threw "SEREMU channel not connected" against
// the handle the reboot had already invalidated.
//
// Leaving the bus cannot be lost that way, and it is direct evidence of the
// thing being asked for rather than of the byte arriving.
// waitForLockedAfterRestart() still has the final say on the state it returns
// in.
async function sendRestartAcked(channel, { attempts = 3, absenceMs = 4000, pollMs = 50 } = {}) {
    for (let i = 0; i < attempts; i++) {
        try {
            channel.sendLine('8');
        } catch (e) {
            // The handle is already gone, which only happens because the device
            // is already rebooting - an earlier press landed after all.
            return true;
        }
        const deadline = Date.now() + absenceMs;
        while (Date.now() < deadline) {
            if (!isOnlyKeyPresent()) return true; // off the bus: the restart took
            await sleep(pollMs);
        }
        // Still enumerated and running: the line was dropped, so send another.
    }
    throw new Error(
        `device never left the USB bus after ${attempts} restart commands - they are being dropped`
    );
}

async function runInConfigMode(operationFn, { primaryPin = PINS.primary } = {}) {
    const channel = new SeremuChannel();
    await channel.connect();
    await sendRestartAcked(channel); // restart -> known 'locked' starting state
    channel.close();
    await waitForLockedAfterRestart();

    await channel.connect(); // reconnect - the reboot above dropped the handle
    let result;
    try {
        await unlockAndConfirm(channel, primaryPin);
        await enterConfigModeConfirmed(channel, primaryPin);
        result = await operationFn();

        // Let the operation's flash/EEPROM write finish before the exit
        // restart tears the run loop down. The DEBUG handler runs inline in
        // loop(), so the device cannot echo this probe while it is still busy
        // writing - which makes the echo a real completion signal rather than
        // a guess at how long a write takes.
        await probeDeviceResponsive(channel).catch(() => {
            /* channel may already be gone; the exit restart below handles it */
        });
    } finally {
        // Config mode has no exit but a reboot. Guard the send: if an earlier
        // step failed because the channel itself broke, throwing here would
        // mask the real error and skip the close below.
        try {
            channel.sendLine('8');
        } catch (e) {
            /* channel already broken - nothing to send to */
        }
        channel.close();
    }

    await waitForLockedAfterRestart();
    await waitReadyAndUnlock(primaryPin);
    return result;
}

// "Try the cheap path first" for a harness-owned device setting: if the cache
// already says `value`, skip config mode entirely and just make sure the
// device is usable, rather than paying for a full restart/unlock/config-mode
// cycle to confirm something already true.
//
// The cache is only trustworthy while the harness owns the device. A reflash
// or wipe resets device settings without the cache knowing - see QUIRKS.md on
// .derived-key-challenge-mode-cache.json, which caused a real false negative.
async function withCachedSetting({ readCached, writeCached, value, operationFn, ...configModeOpts }) {
    if (readCached() === value) {
        await ensureUnlocked();
        return;
    }
    await runInConfigMode(operationFn, configModeOpts);
    writeCached(value);
}

module.exports = { runInConfigMode, withCachedSetting, waitForLockedAfterRestart };
