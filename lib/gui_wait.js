// Fail-fast waiting for browser-driven device tests.
//
// The rule this enforces: the ONLY thing a test may wait out is the device
// settling. Anything already known to have failed must stop the test at the
// moment it becomes known.
//
// The previous shape violated that badly. clickDecryptAndCollect() polled the
// DOM for 90 seconds, returned, and only THEN asserted that no page errors had
// occurred - so a TypeError thrown in the first second still cost the full 90,
// and the composite poll loop underneath it spent its own 120-second budget
// on a promise that could never settle. The information was there immediately;
// only the checking was late.
//
// Two pieces:
//
//   armFailFast()   installs window.onerror / unhandledrejection traps that
//                   record the FIRST fatal into window.__guiFatal.
//   waitInPage()    polls a caller-supplied expression in the page and breaks
//                   the instant __guiFatal is set, throwing on the Node side.
//
// Both are idempotent, so a test can re-arm after a navigation without
// stacking listeners.
const { evalInPage } = require('./nwjs_client');
const { NO_RESPONSE_TIMEOUT_MS } = require('./config');

// Installed once per page realm. Records only the first fatal - later ones are
// usually consequences of it, and the first is what points at the cause.
const ARM_SRC = `
    if (!window.__guiFatalArmed) {
        window.__guiFatalArmed = true;
        window.addEventListener('error', function (e) {
            if (!window.__guiFatal) {
                window.__guiFatal = 'uncaught error: ' + ((e.error && e.error.stack) || e.message || String(e));
            }
        });
        window.addEventListener('unhandledrejection', function (e) {
            if (!window.__guiFatal) {
                var r = e.reason;
                window.__guiFatal = 'unhandled rejection: ' + ((r && r.stack) || (r && r.message) || String(r));
            }
        });
    }
    window.__guiFatal = null;
    return true;
`;

async function armFailFast() {
    await evalInPage(ARM_SRC, { timeoutMs: 10000 });
}

// Polls `readExpr` (a JS expression evaluated in the page, e.g.
// `document.getElementById('x').value`) until it is truthy, and returns it.
//
// THE BUDGET IS INACTIVITY, NOT TOTAL ELAPSED TIME. `idleMs` is reset every
// time `progressExpr` changes, so an operation that keeps reporting - a status
// line ticking through "Decrypting", "confirm on the device", "Decryption
// complete" - may take as long as it needs, while a silent one dies in 30
// seconds. A total cap would have to be sized for the slowest legitimate
// operation and would therefore be useless as a wedged-device detector.
//
// A page fatal ends the wait immediately, and so does `failExpr` (for a page
// that reports failure in the DOM rather than by throwing).
async function waitInPage(readExpr, {
    idleMs = NO_RESPONSE_TIMEOUT_MS,
    pollMs = 250,
    failExpr = null,
    progressExpr = null,
    label = 'page value',
} = {}) {
    // Cap the CDP call itself well above the idle budget - it must outlive the
    // in-page loop so the loop's own verdict is what surfaces, never a
    // transport timeout wrapping it.
    const callTimeoutMs = Number(idleMs) * 4;
    const { value } = await evalInPage(`
        const idleMs = ${Number(idleMs)};
        let lastChange = Date.now();
        let lastToken = null;
        let ticks = 0;
        while (true) {
            if (window.__guiFatal) return { fatal: window.__guiFatal };
            ${failExpr ? `{ const f = (${failExpr}); if (f) return { failed: String(f) }; }` : ''}
            const v = (${readExpr});
            if (v) return { value: v };
            ${progressExpr ? `{
                const token = String(${progressExpr});
                if (token !== lastToken) { lastToken = token; lastChange = Date.now(); }
            }` : ''}
            if (Date.now() - lastChange > idleMs) {
                return { idle: true, lastToken: lastToken, ticks: ticks };
            }
            ticks++;
            await new Promise((r) => setTimeout(r, ${Number(pollMs)}));
        }
    `, { timeoutMs: callTimeoutMs });

    if (!value) throw new Error(`waitInPage(${label}): page returned nothing`);
    if (value.fatal) throw new Error(`${label} aborted - page fatal: ${value.fatal}`);
    if (value.failed) throw new Error(`${label} reported failure: ${value.failed}`);
    if (value.idle) {
        throw new Error(
            `${label}: no response for ${idleMs}ms` +
            (value.lastToken !== null && value.lastToken !== undefined
                ? ` - last reported state: "${value.lastToken}"`
                : ' - the page reported no state at all')
        );
    }
    return value.value;
}

// Reads the recorded fatal without waiting, for assertions after an operation
// that has its own completion signal.
async function pageFatal() {
    const { value } = await evalInPage('return window.__guiFatal || null;', { timeoutMs: 10000 });
    return value || null;
}

module.exports = { armFailFast, waitInPage, pageFatal, ARM_SRC };
