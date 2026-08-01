// The standard startup/teardown for every nwjs-driven ("GUI") test.
//
// The flow, fixed for all tests:
//
//   1. open browser
//   2. let set time run - watching BOTH the debug emu and the browser console -
//      and settle once it has actually completed
//   3. proceed with the test
//   4. close browser
//
// Steps 1 and 4 are a pair on purpose. Each test gets its own window and
// destroys it afterwards, so nothing a test leaves behind can reach the next
// one. That matters more than it sounds: Chromium's native WebAuthn dialog
// ("Something went wrong / The request timed out") is browser chrome, cannot
// be seen over CDP and cannot be clicked from here, and once raised it sits
// over the window blocking its device calls until a human presses Close.
// Closing the window is the only way to clear it - so a window is never
// reused across tests, and a failed startup recycles rather than retries in
// place.
//
// Step 2 is the reason this file exists at all. Loading any app page runs
// src/plugins/index/index.js's doSetTime() -> onlykeyApi.api.check() ->
// OKCONNECT over FIDO2. Before this, tests waited on elapsed time plus one DOM
// side effect (#header_messages gaining a class), which cannot distinguish:
//
//   * the request never reached the device        -> the modal case
//   * the device got it and stalled
//   * the device answered and the app dropped it
//
// All three previously surfaced as the same bare timeout. The device's own
// DEBUG (SEREMU) output already separates them, because this is a DEBUG
// (`-test`) build and it traces the whole request:
//
//   Keyhandle:                     ok_extension.cpp - reached the OK bridge
//   App public = / Browser = / OS = ok_extension.cpp - OKCONNECT parsed it
//   Transit AES Key =              ok_extension.cpp - handshake COMPLETED
//   Stored Data for FIDO Response  device.cpp       - answer staged
//
// So settling means both sides agreeing: the device reached
// "Transit AES Key =", and the page's own handshake resolved successfully.
// Either alone is a weaker claim than it looks.
//
// test/17 already established that SEREMU and FIDO2 work concurrently (it
// injects button presses over SeremuChannel inside a Promise.all with a
// browser-driven decrypt), which is what makes watching the device during a
// page load possible at all.

const { isAlive, evalInPage, getConsoleLog, recycleWindow } = require('./nwjs_client');
const { waitForOkConnectSettled } = require('./gui_helpers');
const { ensureUnlocked } = require('./device');
const { SeremuChannel } = require('./hid');
const { snapshot, consoleTail, screenshot, formatTrace } = require('./gui_trace');

const WEBAPP_ROOT = 'http://localhost:3000/';

// Device-side markers, in the order the firmware emits them.
const DEBUG_REQUEST_ARRIVED = /Keyhandle:/;
const DEBUG_HANDSHAKE_DONE = /Transit AES Key/;

// Bounded per this repo's design principle ("every device-facing wait is
// bounded and response-driven"): ~30s, resolved by a real line, never by
// reaching the cap.
const SETTLE_TIMEOUT_MS = 30000;

// The webapp server is a separate process from nwjs (nwjs/index.js spawns it),
// so CDP answering on 9222 is not evidence that :3000 serves anything. Checked
// separately so "the server died" reports as itself rather than as a blank
// page or a mystery timeout.
async function webappServing({ timeoutMs = 5000 } = {}) {
    try {
        const res = await fetch(WEBAPP_ROOT, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    } catch (e) {
        return false;
    }
}

async function preflight({ device }) {
    if (!(await isAlive())) {
        throw new Error(
            'nwjs CDP endpoint (localhost:9222) is not answering - run `node nwjs/ensure.js`, then `cd nwjs && npm start`.'
        );
    }
    if (!(await webappServing())) {
        throw new Error(
            `nwjs is up but the web app server is not serving ${WEBAPP_ROOT} - it is a child process of nwjs/index.js; check its [webapp] output.`
        );
    }
    // Must happen BEFORE any app page is opened. An app page loaded against a
    // locked device fires OKCONNECT at something that will not answer, which
    // is precisely what raises the un-clickable modal - confirmed live
    // 2026-08-01, where nwjs/index.js's own startup auto-open did exactly this
    // and left the window unusable for every test that followed.
    if (device) await ensureUnlocked();
}

// Step 2. Waits for the device and the page to independently agree that the
// startup handshake completed, and reports which side failed when they don't.
async function settle(channel, { timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
    const started = Date.now();
    const trace = { arrived: false, completed: false, dom: null };

    if (channel) {
        try {
            await channel.waitFor(DEBUG_REQUEST_ARRIVED, timeoutMs);
            trace.arrived = true;
        } catch (e) {
            throw new Error(
                'startup handshake never reached the device: no "Keyhandle:" in the debug output. ' +
                    'The FIDO2 request did not get there at all - expect a native "Something went wrong / ' +
                    'The request timed out" dialog over the window (see the screenshot).'
            );
        }
        try {
            await channel.waitFor(DEBUG_HANDSHAKE_DONE, Math.max(1000, timeoutMs - (Date.now() - started)));
            trace.completed = true;
        } catch (e) {
            throw new Error(
                'startup handshake reached the device but never completed: saw "Keyhandle:" but no ' +
                    '"Transit AES Key". The device received the request and stalled part-way through OKCONNECT.'
            );
        }
    }

    // Browser side. Only meaningful once the device side is known good - if
    // the device never answered, this failing tells us nothing new.
    trace.dom = await waitForOkConnectSettled({
        timeoutMs: Math.max(1000, timeoutMs - (Date.now() - started)),
    });
    if (!/text-success/.test(trace.dom)) {
        throw new Error(
            `the device completed the handshake but the page reported it as failed (${trace.dom}) - ` +
                'device and browser disagree.'
        );
    }
    return trace;
}

// Steps 1-3. Returns a handle the test uses, and whose close() is step 4.
//
// `device: false` skips both ensureUnlocked() and the debug-trace wait, for
// pages that make no device call (e.g. /app/encrypt in "Encrypt Only" mode).
// Those still get the browser-side settle, because the page fires OKCONNECT on
// load regardless of what the test intends to do with it.
async function startGuiSession({
    url,
    device = true,
    keepChannel = false,
    timeoutMs = SETTLE_TIMEOUT_MS,
    attempt = 0,
} = {}) {
    await preflight({ device });

    // Opened BEFORE the window, so no debug output emitted during the page's
    // own load can be missed.
    let channel = null;
    if (device) {
        channel = new SeremuChannel();
        await channel.connect();
        channel.clearBuffer();
    }

    try {
        // Step 1: always a genuinely fresh window. recycleWindow() closes every
        // existing page tab first, which is also what clears a native dialog
        // left over from anything before us.
        await recycleWindow({ url });

        // Step 2.
        const trace = await settle(channel, { timeoutMs });
        await getConsoleLog({ clear: true });

        // The debug channel's job was the startup gate, so close it here
        // unless the caller explicitly wants it. Two reasons: test/17 opens
        // its own SeremuChannel to inject button presses, and a second
        // node-hid handle on the same hidraw node is a needless risk; and
        // this repo has already been bitten by holding a device handle for
        // longer than needed while the browser has its own connection open
        // (see gui_helpers.js's showStatus()). Tests that need SEREMU during
        // the test itself open their own, as they do today.
        if (!keepChannel && channel) {
            try { channel.close(); } catch (e) { /* already gone */ }
            channel = null;
        }

        return {
            url,
            get channel() { return channel; },
            trace,
            snapshot,
            screenshot,
            consoleTail,
            // Step 4.
            async close() {
                if (channel) {
                    try { channel.close(); } catch (e) { /* already gone */ }
                    channel = null;
                }
                // Leave the browser on a page that makes no device call, so an
                // idle window between tests cannot raise a dialog of its own.
                await recycleWindow({ url: 'about:blank' }).catch(() => {});
            },
        };
    } catch (err) {
        if (channel) {
            try { channel.close(); } catch (e) { /* already gone */ }
        }
        // One retry, through a fresh window. A failed startup usually means a
        // modal is up, and the window it belongs to has to be destroyed for
        // the next attempt to have any chance - retrying in place would just
        // hit the same blocked window again.
        if (attempt === 0) {
            await recycleWindow({ url: 'about:blank' }).catch(() => {});
            return startGuiSession({ url, device, keepChannel, timeoutMs, attempt: 1 });
        }
        const [snap, tail, shot] = await Promise.all([
            snapshot(),
            consoleTail(30),
            screenshot('gui-session-startup'),
        ]);
        err.message = `${err.message}\n${formatTrace(`startup ${url}`, snap, tail, shot)}`;
        throw err;
    }
}

module.exports = {
    startGuiSession,
    settle,
    preflight,
    webappServing,
    WEBAPP_ROOT,
    DEBUG_REQUEST_ARRIVED,
    DEBUG_HANDSHAKE_DONE,
};
