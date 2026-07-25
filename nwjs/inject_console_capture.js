// Injected via nw.Window.open()'s inject_js_start option (runs after the
// DOM exists but before the page's own scripts, so nothing the app logs on
// load is missed - confirmed live this matters: the app fires its OKCONNECT
// handshake, with real console output, essentially immediately on load).
//
// Accumulates into this window's own `window.__nwConsoleLog`, read on
// demand from the background script via `win.window.__nwConsoleLog` (same
// process, cross-window access is fine within one nw.js app) - not pushed
// anywhere proactively, so it survives independent of whether anyone's
// listening at the time, and keeps working across a page reload only if
// this same option is set again (nw re-injects on each navigation).
(function () {
    window.__nwConsoleLog = window.__nwConsoleLog || [];

    function record(type, text) {
        window.__nwConsoleLog.push({ ts: Date.now(), type, text });
    }

    function stringifyArg(a) {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
            return JSON.stringify(a);
        } catch (e) {
            return String(a);
        }
    }

    ['log', 'warn', 'error', 'info', 'debug'].forEach((method) => {
        const original = console[method].bind(console);
        console[method] = function (...args) {
            record(method, args.map(stringifyArg).join(' '));
            return original(...args);
        };
    });

    window.addEventListener('error', (e) => {
        record('exception', (e.error && (e.error.stack || e.error.message)) || e.message);
    });
    window.addEventListener('unhandledrejection', (e) => {
        record('unhandledrejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
    });
})();
