// Drives `onlykey-gpg init` end-to-end without a human at the device.
//
// Unlike the PQC CLI (age-plugin-onlykey), lib-agent's onlykey.py *does*
// print its challenge digits straight to stdout (device/onlykey.py's
// sign()/ecdh(), ~line 372-373: "Enter the 3 digit challenge code..." then
// "B1 B2 B3" on the next line) - so this scrapes them live instead of
// precomputing a SHA256-based digest, which is simpler and exactly matches
// what a human operator would be reading off their terminal.
//
// `onlykey-gpg init` needs TWO such confirmations in sequence (once to
// derive the signing subkey, once for the decryption subkey - --skey/--dkey
// both default to 'ECC32', libagent/gpg/__init__.py's run_init() ->
// export_public_key()), so this watches for as many prompts as show up
// until the process exits, answering each one as it arrives.
//
// Root cause of this taking real live-serial firmware tracing to nail down:
// Python's stdout is fully buffered (not line-buffered) once it isn't a TTY,
// which is exactly the case when spawned with piped stdio here - so
// sign()'s print() calls sat unflushed in Python's own buffer, sometimes for
// 20+ seconds, well past the point the device's challenge window had closed
// and the whole operation had already failed/timed out. Confirmed live via
// the device's own DEBUG-serial trace: the firmware was receiving and
// correctly responding to every request immediately (real pubkey bytes,
// proper CRYPTO_AUTH priming) - the corruption/timeouts were entirely a
// host-side artifact of challenge digits arriving at the harness far too
// late to answer in time. PYTHONUNBUFFERED=1 fixes it outright.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SeremuChannel, sleep } = require('./hid');
const { VENV_BIN } = require('./config');

const SHORT_PRESS = 10; // '\n'

const CHALLENGE_RE = /Enter the 3 digit challenge code[^\n]*\n(\d) (\d) (\d)/g;

// Runs `onlykey-gpg init --homedir <homedir> <userId>`, answering every
// "3 digit challenge code" prompt it prints. Resolves with
// { code, stdout, stderr }.
async function runGpgInitWithAutoConfirm(homedir, userId, {
    timeoutMs = 60000,
    pressDelayMs = 400,
    // sign()'s print happens BEFORE it calls send_large_message2() (unlike
    // ecdh(), which sends first) - device/onlykey.py ~372-376 - so the
    // prompt appears before the device even has the request, let alone is
    // in its pending-challenge state. Confirmed live: pressing immediately
    // on seeing the print reliably produced "Error device locked" (the
    // presses landed as ordinary button-matrix input, not challenge
    // confirmation, and the real request's own challenge window then timed
    // out unconfirmed) - the same class of race as TC-04 finding #8, fixed
    // there with a real margin rather than reacting to the print.
    preSettleMs = 2500,
    extraArgs = [],
} = {}) {
    const channel = new SeremuChannel();
    await channel.connect();

    // Tracks every scheduleAnswer() call so we can wait for them all to
    // settle before closing the channel - see the bug this fixes, below.
    const pendingAnswers = [];

    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn(
                path.join(VENV_BIN, 'onlykey-gpg'),
                ['init', '--homedir', homedir, ...extraArgs, userId],
                { timeout: timeoutMs, env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}`, PYTHONUNBUFFERED: '1' } }
            );

            let stdout = '';
            let stderr = '';
            let seen = 0; // how many challenge prompts matched so far
            let scanning = false;

            async function scanForChallenges() {
                if (scanning) return;
                scanning = true;
                try {
                    CHALLENGE_RE.lastIndex = 0;
                    let match;
                    let count = 0;
                    while ((match = CHALLENGE_RE.exec(stdout)) !== null) {
                        count += 1;
                        if (count <= seen) continue; // already scheduled
                        seen += 1;
                        const [, b1, b2, b3] = match;
                        // Not awaited here (would block scanning further
                        // matches) - tracked instead. Left un-awaited and
                        // uncaught, this crashed the whole process: lib-agent's
                        // device/onlykey.py sign()/ecdh() have no validation
                        // that a received HID report actually answers the
                        // request just sent (a real, separate bug - not fixed
                        // here, it's in the lib-agent repo), so it can accept
                        // stale/wrong data and return almost instantly instead
                        // of genuinely waiting up to 22s for a real
                        // confirmation. When that happens, this promise is
                        // still asleep (mid preSettleMs) when the child process
                        // has already exited and the `finally` block below
                        // closes the channel - its `channel.send()` then
                        // throws on the closed handle, as an unhandled
                        // rejection Node terminates the process for (confirmed
                        // live: crashed a retry loop's *second* attempt this
                        // way, mid-setup, with no relation to that attempt's
                        // own state at all).
                        pendingAnswers.push(
                            scheduleAnswer([b1, b2, b3]).catch(() => { /* channel closed under us - operation already finished */ })
                        );
                    }
                } finally {
                    scanning = false;
                }
            }

            async function scheduleAnswer(digits) {
                await sleep(preSettleMs);
                for (const digit of digits) {
                    channel.send([digit.charCodeAt(0), SHORT_PRESS]);
                    // eslint-disable-next-line no-await-in-loop
                    await sleep(pressDelayMs);
                }
            }

            child.stdout.on('data', (d) => {
                stdout += d.toString();
                scanForChallenges().catch(() => { /* channel closed mid-run - let the process finish/timeout on its own */ });
            });
            child.stderr.on('data', (d) => { stderr += d.toString(); });

            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
        // Let any still-sleeping scheduleAnswer() calls finish (harmlessly,
        // since they're now caught) before the channel closes under them.
        await Promise.allSettled(pendingAnswers);
        return result;
    } finally {
        channel.close();
    }
}

// Same intermittent-race family as TC-04/TC-06's other findings (a host-side
// read/timing hiccup around a device-busy window - CRYPTO_AUTH priming for
// TWO chained OKSIGN calls here), not a device correctness issue: reproduced
// live with DEBUG-serial tracing and confirmed the device always computes a
// correct signature and responds promptly every time it happens. What fails
// is the *host* occasionally missing/mistiming a read during that window -
// combined with lib-agent's device/onlykey.py sign()/ecdh() having no
// validation that a received report actually answers the request just sent
// (a real bug, not fixed here - it's in the lib-agent repo), an occasional
// bad read can surface as this specific "out of core"/gpg-import-failure
// signature instead of a clean error. Retrying the *whole* operation (fresh
// homedir each time - run_init() refuses to reuse an existing one) is
// legitimate here specifically because the failure has been traced back to
// a transient host-side read, not to the device ever returning wrong data -
// unlike TC-05's decrypt retries (a different, already-understood transport
// issue) this isn't papering over a correctness bug.
const RETRYABLE_RE = /out of core|Fatal/i;

async function runGpgInitWithAutoConfirmRetrying(baseDir, userId, opts = {}, { attempts = 3 } = {}) {
    let lastResult;
    let lastHomedir;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const homedir = path.join(baseDir, `attempt-${attempt}`);
        lastHomedir = homedir;
        // eslint-disable-next-line no-await-in-loop
        lastResult = await runGpgInitWithAutoConfirm(homedir, userId, opts);
        if (lastResult.code === 0 || !RETRYABLE_RE.test(lastResult.stderr)) {
            return { ...lastResult, homedir };
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
    }
    return { ...lastResult, homedir: lastHomedir };
}

module.exports = { runGpgInitWithAutoConfirm, runGpgInitWithAutoConfirmRetrying };
