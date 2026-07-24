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

    try {
        return await new Promise((resolve, reject) => {
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
                        scheduleAnswer([b1, b2, b3]);
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
    } finally {
        channel.close();
    }
}

module.exports = { runGpgInitWithAutoConfirm };
