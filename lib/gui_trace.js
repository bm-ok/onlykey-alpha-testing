// Instrumentation for nwjs-driven tests, so a stalled or failed page step
// says what the page was doing instead of just timing out.
//
// Why this needs to exist at all: the app pages report progress in three
// places, none of which reach the Node side on their own -
//
//   * the submit button's own label, which onlykey-pgp.js rewrites on every
//     `status` event ("Waiting for OnlyKey to process message.", "You have N
//     seconds to enter challenge code X on OnlyKey.", error text, ...)
//   * app.xterm's #terminal_messages element, which gets an "OKPGP(mode): ..."
//     line for each of those same events
//   * console.info, which onlykey-pgp.js uses heavily for the OKPING poll loop
//     ("Sending Ping Request to OnlyKey" / "Ping Successful")
//
// A test that only awaits a final field value throws away all three, so a
// device round trip that stalls halfway is indistinguishable from one that
// never started. watchPage() polls the first two and prints them as they
// change; trace() bundles all three into an error message on failure.
//
// The console log itself comes from nwjs/inject_console_capture.js's
// persistent window.__nwConsoleLog buffer (read via getConsoleLog), which
// survives across evalInPage() calls - so it covers what happened between
// our calls, not just during them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { evalInPage, getConsoleLog } = require('./nwjs_client');
const { sleep } = require('./hid');

// Where failure screenshots land. Under the OS temp dir, not the repo - these
// are diagnostic artefacts of one run, not something to accumulate in a
// checkout.
const SHOT_DIR = path.join(os.tmpdir(), 'onlykey-testing-shots');

// The X display the nwjs window lives on. This machine runs xpra on :100
// (started by ~/start-x.sh); DISPLAY is not set in the test process's own
// environment, so it cannot be inherited and has to be named.
const X_DISPLAY = process.env.OK_TEST_DISPLAY || ':100';

// Captures the whole X display to a PNG and returns its path.
//
// This exists because of a failure class nothing else in this harness can
// see: Chromium's native WebAuthn dialog. When a FIDO2 call times out the
// browser raises "Something went wrong / The request timed out" with a Close
// button, and that dialog is browser chrome, not page content - it is not in
// the DOM, CDP's Page.captureScreenshot does not include it, and snapshot()
// above is blind to it. It also blocks until a human clicks, so from Node the
// only symptom is that nothing ever settles. Confirmed live 2026-08-01: the
// window had been sitting behind exactly this dialog while every CDP-level
// probe reported a healthy page.
//
// Uses PIL's ImageGrab rather than a screenshot binary because that is what
// this machine actually has - system python3 carries PIL 12.1.1, while
// xdotool / python-xlib / pyautogui / scrot / ImageMagick are all absent.
// (The same absence is why this can only *see* the dialog, never dismiss it -
// there is no input-injection tool available. Recovery is recycleWindow() in
// nwjs_client.js, which destroys the dialog by destroying its parent window.)
function screenshot(label = 'gui') {
    return new Promise((resolve) => {
        const safe = String(label).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
        const file = path.join(SHOT_DIR, `${Date.now()}-${safe}.png`);
        try {
            fs.mkdirSync(SHOT_DIR, { recursive: true });
        } catch (e) {
            return resolve(null);
        }
        const code = [
            'from PIL import ImageGrab',
            `ImageGrab.grab(xdisplay=${JSON.stringify(X_DISPLAY)}).save(${JSON.stringify(file)})`,
        ].join('\n');
        execFile('python3', ['-c', code], { timeout: 15000 }, (err) => {
            // Never let a diagnostic failure replace the real error - a
            // missing PIL or a dead display just means no screenshot.
            resolve(err ? null : file);
        });
    });
}

// One read of everything the page shows about its own progress. Kept
// deliberately total-failure-tolerant: this runs on the error path, where a
// second exception would replace the real one with a useless wrapper.
async function snapshot() {
    try {
        const { value } = await evalInPage(`
            const btn = document.getElementById('onlykey_start');
            const term = document.getElementById('terminal_messages');
            const msg = document.getElementById('message');
            const hdr = document.querySelector('#header_messages .text-success, #header_messages .text-danger');
            return {
                url: location.href,
                button: btn ? btn.textContent : null,
                buttonClass: btn ? btn.className : null,
                terminal: term ? term.innerText.split('\\n').filter(Boolean).slice(-12) : [],
                messageHead: msg ? String(msg.value).slice(0, 60) : null,
                connect: hdr ? hdr.className : null,
            };
        `, { timeoutMs: 8000 });
        return value || {};
    } catch (e) {
        return { snapshotError: e.message };
    }
}

async function consoleTail(n = 25, { since = 0 } = {}) {
    try {
        const log = await getConsoleLog({ since });
        return log.slice(-n).map((e) => `[${e.type}] ${String(e.text).slice(0, 200)}`);
    } catch (e) {
        return [`<console log unavailable: ${e.message}>`];
    }
}

function formatTrace(label, snap, tail, shot) {
    const lines = [`--- page trace: ${label} ---`];
    lines.push(`  url:      ${snap.url}`);
    // Named first among the artefacts because it is the only one that can
    // show a native dialog - if the page looks healthy but nothing settled,
    // this is where the answer is.
    if (shot) lines.push(`  screen:   ${shot}   <- open this; a native WebAuthn dialog is invisible to everything else here`);
    lines.push(`  button:   ${JSON.stringify(snap.button)} (${snap.buttonClass || ''})`);
    lines.push(`  connect:  ${snap.connect || '(not settled)'}`);
    if (snap.messageHead !== null && snap.messageHead !== undefined) {
        lines.push(`  message:  ${JSON.stringify(snap.messageHead)}`);
    }
    if (snap.terminal && snap.terminal.length) {
        lines.push('  terminal:');
        for (const t of snap.terminal) lines.push(`    ${t}`);
    }
    if (tail && tail.length) {
        lines.push('  console tail:');
        for (const t of tail) lines.push(`    ${t}`);
    }
    if (snap.snapshotError) lines.push(`  (snapshot failed: ${snap.snapshotError})`);
    return lines.join('\n');
}

// Runs `fn`, and on any failure re-throws with the page's state appended.
// The original error message is kept first so mocha's one-line summary still
// says what actually went wrong.
async function trace(label, fn, { since = 0 } = {}) {
    try {
        return await fn();
    } catch (err) {
        // Screenshot first and in parallel: a native dialog blocks the page's
        // own device calls but not CDP, so the other two probes still answer
        // while it is up - it is the screenshot that explains why they say
        // everything is fine.
        const [snap, tail, shot] = await Promise.all([
            snapshot(),
            consoleTail(30, { since }),
            screenshot(label),
        ]);
        err.message = `${err.message}\n${formatTrace(label, snap, tail, shot)}`;
        throw err;
    }
}

// Prints the button label whenever it changes, for as long as the returned
// handle is open. This is the "what is it doing right now" view for the
// device-backed modes, where a single click can legitimately take a minute
// (multi-packet u2fSignBuffer, then a challenge, then OKPING polling) and
// silence is otherwise the only feedback.
//
// Deliberately a change-detector, not a ticker: the challenge countdown
// rewrites the label every second on its own, so printing every poll would
// bury the transitions that matter.
function watchPage(label, { intervalMs = 1000 } = {}) {
    let stopped = false;
    let last = null;
    const seen = [];
    const loop = (async () => {
        while (!stopped) {
            const snap = await snapshot();
            if (snap.button && snap.button !== last) {
                last = snap.button;
                seen.push(snap.button);
                console.log(`      [${label}] ${snap.button}`);
            }
            await sleep(intervalMs);
        }
    })();
    return {
        seen,
        async stop() {
            stopped = true;
            await loop.catch(() => {});
            return seen;
        },
    };
}

module.exports = { snapshot, consoleTail, formatTrace, trace, watchPage, screenshot, SHOT_DIR, X_DISPLAY };
