// Background script - package.json's "main" points here directly (not an
// HTML page), which runs this as NW.js's real headless/background-script
// mode: a genuine Node module context (__dirname, require, module.exports
// all work normally) with no window opened on startup at all.
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

const server = spawn(process.execPath, ['index.js'], {
    cwd: WEBAPP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => console.log('[webapp]', d.toString().trimEnd()));
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
// window's console output/uncaught errors are captured persistently (see
// getWindowConsoleLog() below) independent of whether/when anyone's
// actively evaluating something against the page - GUI-only interaction
// (a human clicking around, or the app's own background activity) is
// still visible after the fact, not just output that happens to occur
// during a specific injected eval.
global.openAppWindow = function openAppWindow(url = 'http://localhost:3000/', options = {}) {
    const injectPath = path.join(__dirname, 'inject_console_capture.js');
    return new Promise((resolve) => {
        nw.Window.open(url, { ...options, inject_js_start: injectPath }, function (win) {
            global.currentAppWindow = win;
            resolve(win);
        });
    });
};

// getWindowConsoleLog({ since, clear }) -> array of {ts, type, text}
// Reads the currently-open app window's accumulated console log
// (window.__nwConsoleLog, populated by inject_console_capture.js).
// `since` (a timestamp) filters to entries after that point; `clear`
// empties the buffer after reading (both optional).
global.getWindowConsoleLog = function getWindowConsoleLog({ since = 0, clear = false } = {}) {
    const win = global.currentAppWindow;
    if (!win || !win.window || !win.window.__nwConsoleLog) return [];
    const log = win.window.__nwConsoleLog;
    const entries = since ? log.filter((e) => e.ts > since) : log.slice();
    if (clear) win.window.__nwConsoleLog = [];
    return entries;
};

console.log('background script ready - call openAppWindow(url) over CDP to open a browser window');
