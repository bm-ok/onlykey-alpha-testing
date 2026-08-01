// Background script - package.json's "main" points here directly (not an
// HTML page), which runs this as NW.js's real headless/background-script
// mode: a genuine Node module context (__dirname, require, module.exports
// all work normally).
//
// `npm start` is meant to double as a one-command starter for manual GUI
// testing, so this opens one real window automatically once the server is
// actually ready (not a blind delay - waits for the server's own "listening
// on" stdout line). lib/nwjs_client.js's getAppPage() looks for an existing
// page tab before opening a new one, so CDP-driven injection/inspection
// (run.js, console.js, mocha) naturally reuses this same window rather than
// opening a second one alongside it.
//
// Spawns the real onlykey.github.io web app server as a child process
// (NOT require()'d directly into this script's own JS realm - confirmed
// live that breaks: onlykey.github.io's GUN.js dependency does its own
// environment detection, and NW.js's hybrid window+Node context - both
// `window`/`document` AND `require`/`process` in scope at once - makes
// GUN's Radisk storage adapter pick an incompatible code path, throwing
// inside gun.js's Radisk() on startup. Spawning it as a genuinely separate,
// pure-Node child process sidesteps that entirely - same as running
// `node index.js` directly, which works fine), and exposes a helper for
// opening real, visible browser windows on demand via the native
// `nw.Window` API - driven externally over CDP (Runtime.evaluate against
// this background script's own context) rather than auto-opening anything
// on startup.
const path = require('path');
const { spawn } = require('child_process');

const WEBAPP_DIR = path.join(__dirname, '..', '..', 'onlykey.github.io');

// A landing page that makes no device call - see the auto-open below for why
// that matters. Says what it is, so a human who finds this window knows it is
// the harness and where to go next.
const START_URL =
    'data:text/html,' +
    encodeURIComponent(
        '<body style="background:#111;color:#0f0;font:16px monospace;padding:2em">' +
            '<h2>onlykey-testing: nwjs ready</h2>' +
            '<p>Web app is served at <a style="color:#6cf" href="http://localhost:3000/">http://localhost:3000/</a>.</p>' +
            '<p>This landing page makes no device call on purpose. Opening an app page before the ' +
            'OnlyKey is unlocked makes its startup OKCONNECT time out, which raises a native ' +
            'WebAuthn dialog that no test can dismiss.</p>' +
            '<p>Tests open their own window (lib/gui_session.js).</p></body>'
    );

const server = spawn(process.execPath, ['index.js'], {
    cwd: WEBAPP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverReady = false;
server.stdout.on('data', (d) => {
    const text = d.toString().trimEnd();
    console.log('[webapp]', text);
    if (!serverReady && /listening on/i.test(text)) {
        serverReady = true;
        // Deliberately NOT an app url. Loading any app page runs
        // src/plugins/index/index.js's doSetTime() -> OKCONNECT over FIDO2,
        // and at this point in startup nothing has unlocked the device yet -
        // so the request times out and Chromium raises a native
        // "Something went wrong / The request timed out" dialog. That dialog
        // is browser chrome: invisible to CDP, un-clickable from any test, and
        // it blocks the window's device calls until a human presses Close.
        // Confirmed live 2026-08-01 - the auto-open here was poisoning the
        // window before a single test ran.
        //
        // A window still opens automatically for manual use; it just starts
        // somewhere that makes no device call. Tests do not depend on this
        // one at all - lib/gui_session.js opens its own fresh window per test.
        openAppWindow(START_URL).catch((e) => console.error('failed to auto-open app window:', e.message));
    }
});
server.stderr.on('data', (d) => console.error('[webapp]', d.toString().trimEnd()));
server.on('exit', (code, signal) => console.log(`[webapp] exited (code=${code}, signal=${signal})`));

// Kill the child when this background page/app is closing, so a repeated
// `npm start` doesn't accumulate orphaned servers still holding port 3000.
nw.App.on('close', () => {
    server.kill();
    nw.App.quit();
});

// openAppWindow(url, options) -> Promise<nw.Window>
// Call from outside via CDP: Runtime.evaluate on this background page's
// websocket target, e.g. `openAppWindow('http://localhost:3000/app/encrypt')`.
// Always injects inject_console_capture.js at document-start, so the
// window's console output/uncaught errors are captured persistently into
// window.__nwConsoleLog (read back via lib/nwjs_client.js's
// getConsoleLog(), which evaluates directly against the page itself -
// NOT read through a cached reference here, which had a real cross-realm
// staleness bug after in-place navigation: this global used to also expose
// a getWindowConsoleLog() reaching into a saved `win.window`, but that
// reference doesn't reliably track which document is *currently* loaded
// after Page.navigate() - removed rather than left as a trap).
global.openAppWindow = function openAppWindow(url = 'http://localhost:3000/', options = {}) {
    const injectPath = path.join(__dirname, 'inject_console_capture.js');
    return new Promise((resolve) => {
        nw.Window.open(url, { ...options, inject_js_start: injectPath }, function (win) {
            resolve(win);
        });
    });
};

console.log('background script ready - call openAppWindow(url) over CDP to open a browser window');
