#!/usr/bin/env node
//
// Reproduces (or verifies the fix for) the OnlyKey web app's derived-key
// collision, on ANY key including a production one.
//
//   node tools/repro-derive-collision.js
//
// The bug: onlykey-3rd-party.js's derive_public_key()/derive_shared_secret()
// hash their input with `digestArray(Uint8Array.from(additional_d))`.
// Uint8Array.from() is not a string encoder - it treats a string as an
// iterable of characters and coerces each with Number(), which is NaN for any
// letter and stores as 0. Every passphrase therefore collapses to a run of
// zero bytes whose only distinguishing feature is its LENGTH.
//
// password-generator.js and vault.js both pass `$("#phrase").val()` straight
// in, so two different passphrases of equal length derive the SAME key and the
// password generator emits the same password for both.
//
// This script is deliberately usable in both directions:
//   * against the shipped/unfixed library it PRINTS THE COLLISION (exit 1)
//   * against the fixed library it confirms distinct keys (exit 0)
// so the same file is both the bug report and the regression test.
//
// Requirements, kept minimal on purpose so a maintainer can run it:
//   * an OnlyKey, plugged in and UNLOCKED (any firmware - no DEBUG build, no
//     SEREMU, no test PINs, nothing this harness normally relies on)
//   * a physical touch when the key blinks, unless the device setting
//     "derived keys per site without touch" is enabled
//
// Part 1 needs no key at all - it is plain JavaScript semantics and can be
// pasted into any REPL.

const path = require('path');
const readline = require('readline');

const REPO = path.resolve(__dirname, '..');
const { createBrowserEnv } = require(path.join(REPO, 'lib/fido2/browser_env'));

// Same character length, different content - that is the whole trick.
const PHRASE_A = 'spike-label';
const PHRASE_B = 'other-label';
const CONTROL = 'a-clearly-different-length-phrase';

const DERIVE_TIMEOUT_MS = 60000;

function bounded(promise, ms, what) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
    ]);
}

// The library logs verbosely through the GLOBAL console (debug_log is
// console.warn.bind(console), and htmlLog returns console.log.bind(...)), so
// passing a quiet console into it is not enough - it would bury the one line
// this script exists to print. Silence the globals only while the library runs.
async function silenced(fn) {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try {
        return await fn();
    } finally {
        Object.assign(console, saved);
    }
}

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

function part1() {
    console.log('--- Part 1: no device needed, pure JavaScript --------------------');
    const a = Uint8Array.from(PHRASE_A);
    const b = Uint8Array.from(PHRASE_B);
    console.log(`  Uint8Array.from(${JSON.stringify(PHRASE_A)}) = [${a.join(',')}]`);
    console.log(`  Uint8Array.from(${JSON.stringify(PHRASE_B)}) = [${b.join(',')}]`);
    const identical = Buffer.from(a).equals(Buffer.from(b));
    console.log(`  identical: ${identical}`);
    console.log('  -> the passphrase contributes only its LENGTH to the hash input.\n');
    return identical;
}

// Checks the key is present and unlocked before deriving anything, using only
// the FIDO2 OKCONNECT handshake - which works on a production key, unlike this
// harness's usual status path. Without this the failure surfaces as
// "FIDO2 device not found" / "derive failed: true", which says nothing about
// the actual cause.
async function preflight() {
    const { FIDO2Client, connect } = require(path.join(REPO, 'lib/fido2/client'));
    let status;
    try {
        status = await silenced(() => bounded(connect(new FIDO2Client(false)), 20000, 'OKCONNECT handshake'));
    } catch (e) {
        throw new Error(`could not reach the key over FIDO2 (${e.message}). Is it plugged in?`);
    }
    const text = String(status && status.status ? status.status : '');
    console.log(`  key reports: ${text || '(no status string)'}`);
    if (!/^UNLOCKED/i.test(text)) {
        throw new Error('the key is not unlocked - enter your PIN on the device, then re-run');
    }
}

async function part2() {
    console.log('--- Part 2: the same thing, on the device ------------------------');
    console.log('  Using onlykey.github.io\'s real onlykey-3rd-party.js, unmodified.');
    console.log('  Touch the key when it blinks (not needed if "derived keys per');
    console.log('  site without touch" is enabled on the device).\n');

    await preflight();
    console.log('');

    // Load the library INSIDE the silenced window: it binds its logger once
    // at module load (`debug_log = console.warn.bind(console)`), so a stub
    // installed afterwards is never seen. Binding it here captures the stub
    // and it stays quiet for the rest of the run.
    const env = await silenced(async () => createBrowserEnv({ quiet: true }));
    const derive = (phrase) => silenced(() => bounded(
        new Promise((res, rej) => {
            env.ok.derive_public_key(phrase, (err, value) => (
                err ? rej(new Error(`derive failed for ${JSON.stringify(phrase)}: ${err}`)) : res(value)
            ));
        }),
        DERIVE_TIMEOUT_MS,
        `derive(${JSON.stringify(phrase)})`
    ));

    const a = await derive(PHRASE_A);
    console.log(`  ${JSON.stringify(PHRASE_A)} (${PHRASE_A.length} chars) -> ${a}`);
    const b = await derive(PHRASE_B);
    console.log(`  ${JSON.stringify(PHRASE_B)} (${PHRASE_B.length} chars) -> ${b}`);
    const c = await derive(CONTROL);
    console.log(`  control (${CONTROL.length} chars)              -> ${c}\n`);

    // The control matters: if the page/library ignored the input entirely,
    // everything would match and "A === B" would prove nothing. A differing
    // control shows the input IS read - only its content is being discarded.
    if (a === c) {
        console.log('  INCONCLUSIVE: even a different-length phrase matched, so the');
        console.log('  input is not reaching the derivation at all. Check the key is');
        console.log('  unlocked and that the derive actually completed.');
        return null;
    }
    return a === b;
}

(async () => {
    const jsCollides = part1();
    const answer = await prompt('Run the device half? Needs an unlocked OnlyKey. [Y/n] ');
    if (answer.trim().toLowerCase() === 'n') {
        process.exit(jsCollides ? 1 : 0);
    }
    console.log('');

    const collides = await part2();
    console.log('--- Result -------------------------------------------------------');
    if (collides === null) process.exit(2);
    if (collides) {
        console.log('  VULNERABLE: two different passphrases of the same length derived');
        console.log('  the SAME key. The passphrase contributes only its length.');
        process.exit(1);
    }
    console.log('  FIXED: different passphrases derived different keys.');
    process.exit(0);
})().catch((e) => {
    console.error('\nERROR:', e && e.message);
    process.exit(2);
});
