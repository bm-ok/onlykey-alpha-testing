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
//      not in config mode" otherwise - see okcore.cpp case OKSETPRIV.
//   3. That long-press *also* forces unlocked=false on non-DUO hardware
//      (Duo_config[0]!=1) as a re-authentication requirement, so the
//      device needs the primary PIN re-entered a second time before
//      OKSETPRIV's `unlocked==true` check passes.
//   4. Run age-plugin-onlykey, which prints "Press these 3 OnlyKey
//      buttons..." and blocks waiting for the firmware's 3-button
//      confirmation challenge (okcore.cpp done_process_packets() /
//      OnlyKey.ino CRYPTO_AUTH 1->4) - parse the digits out of its stderr
//      and inject them over the DEBUG SEREMU channel.
//   5. Restart the device (DEBUG '8') afterward so config mode - which has
//      no explicit exit besides reboot - doesn't leak into later tests.

const path = require('path');
const { spawn } = require('child_process');
const { SeremuChannel, sleep } = require('./hid');
const { PINS, VENV_BIN } = require('./config');

const SHORT_PRESS = 10; // '\n'
const LONG_PRESS = 32; // ' '
const CHALLENGE_RE = /Press these 3 OnlyKey buttons in order to confirm[^:]*:\s*(\d)\s*,\s*(\d)\s*,\s*(\d)/;

function enterPinDigits(channel, pin) {
    for (const digit of String(pin)) {
        channel.send([digit.charCodeAt(0), SHORT_PRESS]);
    }
}

// Runs `age-plugin-onlykey <args>`, entering config mode, re-unlocking, and
// auto-confirming the 3-button challenge it prints - the same sequence a
// real user performs at the device. Resolves with { code, stdout, stderr }.
async function runWithAutoConfirm(args, { primaryPin = PINS.primary, timeoutMs = 60000, pressDelayMs = 400 } = {}) {
    const channel = new SeremuChannel();
    await channel.connect();

    // 0: force a known-locked starting state - if the device were already
    // unlocked, the "unlock" digits below would instead be read as normal
    // slot-button presses (payload()'s `if (unlocked || ...)` branch),
    // not a PIN attempt.
    channel.send(['8'.charCodeAt(0), LONG_PRESS]);
    channel.close();
    await sleep(3000); // let CPU_RESTART() + USB re-enumeration settle
    await channel.connect();

    // 1: unlock (config-mode long-press only registers while unlocked).
    // Unlock completion calls fadeon()/fadeoff(), setting isfade=1; a
    // scheduled task (fadeendafter2sec) only clears it ~2s later, and the
    // entire long-press-detection chain (including config-mode entry)
    // requires !isfade. 3.4s to match + 2.5s fade-clear margin = 6s.
    enterPinDigits(channel, primaryPin);
    await sleep(6000);

    // 2+3: enter config mode (which re-locks as a re-auth step) and unlock again.
    channel.send(['6'.charCodeAt(0), LONG_PRESS]);
    await sleep(1000);
    enterPinDigits(channel, primaryPin);
    await sleep(6000);

    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(path.join(VENV_BIN, 'age-plugin-onlykey'), args, { timeout: timeoutMs });

            let stdout = '';
            let stderr = '';
            let confirmed = false;

            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', async (d) => {
                stderr += d.toString();
                if (confirmed) return;
                const match = stderr.match(CHALLENGE_RE);
                if (!match) return;
                confirmed = true;
                for (const digit of [match[1], match[2], match[3]]) {
                    channel.send([digit.charCodeAt(0), SHORT_PRESS]);
                    await sleep(pressDelayMs);
                }
            });

            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
    } finally {
        // 4: exit config mode by rebooting (DEBUG-only '8', no data touched).
        // Wait for re-enumeration before returning - otherwise whatever
        // test/command runs right after this one can race the reboot (seen
        // as "open failed" / garbled onlykey-cli responses when a 00-setup
        // suite followed this one with no gap).
        channel.send(['8'.charCodeAt(0), LONG_PRESS]);
        channel.close();
        await sleep(3000);
    }
}

module.exports = { runWithAutoConfirm };
