// Drives age-plugin-onlykey's X-Wing decrypt (TC-05) end-to-end without a
// human at the device - the decaps counterpart to pqc_keygen.js's keygen
// automation, but with real differences worth calling out:
//
//   1. OKDECRYPT only requires the device to be unlocked (okcore.cpp
//      `case OKDECRYPT:` ~526) - unlike OKSETPRIV, no config mode. So this
//      is just restart -> unlock, no long-press-6 dance at all.
//   2. The challenge-digit computation (see pqc_keygen.js's
//      challengeDigitsForKeytype) is the same done_process_packets()
//      formula, but decaps primes on the *ciphertext*, not a fixed
//      trigger payload: okcrypto_xwing_decaps() (okcrypto.cpp) calls
//      process_packets(buffer, 0, 0) once per incoming HID report while
//      !CRYPTO_AUTH, and process_packets() only reaches
//      done_process_packets() (which computes the challenge from the full
//      accumulated packet_buffer) on the *last* chunk of the multi-packet
//      ciphertext send (send_large_message2(), 57 bytes/chunk). So the
//      digits depend on the exact 1120-byte X-Wing ciphertext being
//      decrypted - parsed straight out of the .age file's
//      `-> mlkem768x25519 <base64>` stanza line (age doesn't wrap that
//      argument, unlike the body that follows it), so the harness doesn't
//      need the device or CLI to tell it anything.
//   3. This runs under `age -d`, not age-plugin-onlykey directly - age
//      spawns the plugin as `age-plugin-onlykey --age-plugin=identity-v1`
//      as its own child. Confirmed live (temporary file-based logging in
//      onlykey_hid.py/cli.py, since - see next point - stderr wasn't an
//      option) that unwrap_callback()/_decaps() each run exactly once, no
//      retries, and _decaps() does print "Press OnlyKey button to confirm
//      decryption..." right on schedule. It just never reaches us: `age`
//      does not forward the plugin's raw stderr output to its own stderr
//      (confirmed - watching age's stderr end-to-end only ever showed
//      age's own "waiting on onlykey plugin..." / final error text, never
//      the plugin's prints, even though the plugin process was live and
//      printing the whole time). That ruled out the keygen-style "watch
//      the CLI's stderr" approach entirely for anything invoked via `age`
//      itself (as opposed to age-plugin-onlykey run directly, which is
//      exactly what TC-04/TC-06 do and why that approach worked there).
//   4. So this instead watches the same DEBUG-serial channel already open
//      for button injection: `done_process_packets()`'s "Encrypted Buffer"
//      print (okcore.cpp - the last thing it does before returning, same
//      signal pqc_keygen.js's history mentions trying and moving away from
//      for keygen) fires once priming completes on the last of the ~20
//      ciphertext chunks. Unlike keygen, there's no equivalent
//      main-protocol-channel signal to poll instead (checkStatus() answers
//      "is it unlocked", not "has CRYPTO_AUTH been primed") - so this is
//      the only real option here, DEBUG-channel reliability caveats and
//      all.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SeremuChannel, sleep } = require('./hid');
const { PINS, VENV_BIN } = require('./config');
const { checkStatus } = require('./device');


// Parses the `-> mlkem768x25519 <base64>` stanza out of an age file and
// returns the raw 1120-byte X-Wing ciphertext (age_plugin's XWING_CT_SIZE /
// XWING_STANZA_ENC_LEN). Age doesn't wrap stanza *arguments* (only the
// body that follows), so the whole base64 blob is on one line.
function parseXwingCiphertext(ageFilePath) {
    const content = fs.readFileSync(ageFilePath, 'utf8');
    const match = content.match(/^-> mlkem768x25519 (\S+)$/m);
    if (!match) {
        throw new Error(`No mlkem768x25519 stanza found in ${ageFilePath}`);
    }
    // age uses unpadded base64 (RFC 4648 without '='); Buffer's base64
    // decoder tolerates missing padding fine.
    return Buffer.from(match[1], 'base64');
}

// Same formula as pqc_keygen.js's challengeDigitsForKeytype, but hashing
// the actual ciphertext bytes instead of a fixed trigger payload - see
// module doc comment point 2.
function challengeDigitsForCiphertext(ciphertext) {
    const hash = crypto.createHash('sha256').update(ciphertext).digest();
    return [hash[0] % 6 + 1, hash[15] % 6 + 1, hash[31] % 6 + 1].map(String);
}

function enterPinDigits(channel, pin) {
    for (const digit of String(pin)) {
        channel.sendPress(digit);
    }
}

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

// Printed as the last step of done_process_packets() (okcore.cpp), right
// before fadeon() - fires once priming completes on the last of the ~20
// ciphertext chunks. See module doc comment points 3-4 for why this is
// used instead of watching age's stderr (which doesn't relay the plugin's
// output) or a fixed delay.
const PRIMED_RE = /Encrypted Buffer/;

// Runs `age -d -i identityFile -o outputFile ageFile`, unlocking the device
// and auto-confirming the 3-button decrypt challenge. Resolves with
// { code, stdout, stderr }.
async function runDecryptWithAutoConfirm(ageFilePath, identityFilePath, outputFilePath, {
    primaryPin = PINS.primary,
    timeoutMs = 60000,
    pressDelayMs = 400,
    primedTimeoutMs = 20000,
} = {}) {
    const digits = challengeDigitsForCiphertext(parseXwingCiphertext(ageFilePath));

    await sleep(1500); // see pqc_keygen.js's same settle-before-connect comment

    const channel = new SeremuChannel();
    await channel.connect();

    try {
        // Force a known-locked state, then unlock - OKDECRYPT needs no
        // config mode, so this is the whole setup (contrast pqc_keygen.js's
        // extra long-press-6 + second unlock).
        channel.sendLine('8');
        channel.close();
        await sleep(3000);
        await channel.connect();

        await unlockAndConfirm(channel, primaryPin);
        channel.clearBuffer(); // so the PRIMED_RE wait below can't match a stale prior occurrence

        return await new Promise((resolve, reject) => {
            const child = spawn('age', ['-d', '-i', identityFilePath, '-o', outputFilePath, ageFilePath], {
                timeout: timeoutMs,
                env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH}` },
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });

            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));

            // Wait for the signal, but don't require it: live tracing found
            // the DEBUG channel can go silent right as done_process_packets()
            // reaches this print, mid a very heavy burst of per-packet debug
            // output (~20 chunks x full flash-decrypt spew each) - the same
            // "channel drops output under load" issue documented elsewhere
            // in this harness, just worse here given the volume. If the
            // signal doesn't show up within primedTimeoutMs, send the
            // presses anyway rather than give up - priming is very likely
            // done by then regardless (the whole send+prime sequence was
            // never observed taking anywhere close to that long), and the
            // isfade-gated press window is 20s wide either way.
            channel.waitFor(PRIMED_RE, primedTimeoutMs)
                .catch(() => { /* proceed anyway - see comment above */ })
                .then(async () => {
                    for (const digit of digits) {
                        channel.sendPress(digit);
                        await sleep(pressDelayMs);
                    }
                });
        });
    } finally {
        try {
            channel.sendLine('8');
        } catch (e) { /* channel already broken - nothing to send to */ }
        channel.close();
        await sleep(3000);
    }
}

// The second pattern is unwrap_callback()'s (cli.py) generic fallback
// message when identity-matching's xwing_getpubkey() call raised and got
// silently caught+continue'd past (its own except-block prints the real
// reason to stderr, but age doesn't relay the plugin's stderr - see this
// module's doc comment point 3 - so all we ever actually see is age's own
// wrapping of the empty/summary "error" protocol command). Confirmed via
// live tracing this happens on an otherwise-healthy device/key (manual
// getpubkey re-checks right after were clean 3/3), i.e. a transient read
// hiccup during identity matching, not a permanent failure - worth a retry
// of the whole operation same as a truncated response.
const RETRYABLE_RE = /got \d+ bytes, expected \d+|no identity matched any of the recipients/;

async function runDecryptWithAutoConfirmRetrying(ageFilePath, identityFilePath, outputFilePath, opts = {}, { attempts = 3 } = {}) {
    let lastResult;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        lastResult = await runDecryptWithAutoConfirm(ageFilePath, identityFilePath, outputFilePath, opts);
        if (lastResult.code === 0 || !RETRYABLE_RE.test(lastResult.stderr)) {
            return lastResult;
        }
    }
    return lastResult;
}

module.exports = {
    runDecryptWithAutoConfirm,
    runDecryptWithAutoConfirmRetrying,
    parseXwingCiphertext,
    challengeDigitsForCiphertext,
};
