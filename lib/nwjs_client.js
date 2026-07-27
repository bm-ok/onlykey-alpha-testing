// Reusable CDP client for the always-running nwjs app (nwjs/index.js,
// started separately via `npm start` in nwjs/ - a real Chromium runtime
// with a headless background script that keeps the onlykey.github.io web
// app server alive as a child process). This is the one place that knows
// how to talk CDP - both `nwjs/run.js` (CLI injection, for ad-hoc
// inspection/stepping) and mocha tests (`require()`-ing this directly, no
// CLI shelling - it's our own code, not a third-party binary) should use
// this, not hand-roll their own WebSocket/CDP calls.
//
// Every eval helper here returns { value, logs, errors } - not just the
// expression's return value - because a silent return value with no
// visibility into console output or uncaught exceptions defeats the point
// of "see what's actually happening in the page" for both a human/LLM
// stepping through a workflow and a test asserting on real app behavior.

const CDP_ROOT = 'http://localhost:9222';

async function listTabs() {
    let res;
    try {
        res = await fetch(`${CDP_ROOT}/json`);
    } catch (e) {
        // fetch() rejects outright (ECONNREFUSED etc.) rather than resolving
        // with a bad status when nothing is listening - without this catch
        // that surfaces as a generic, confusing "fetch failed" from deep in
        // undici. This is also the fast-fail path for a crashed nw process
        // (confirmed live: nw.js/Chromium can SEGV natively - not something
        // this code can prevent, just detect clearly instead of the caller
        // hanging on a dead CDP endpoint waiting for something that'll never
        // answer).
        throw new Error(
            `Could not reach nwjs CDP endpoint at ${CDP_ROOT} (${e.message}) - is it running? ` +
                'Run `node nwjs/ensure.js` first, or `cd nwjs && npm start`.'
        );
    }
    if (!res.ok) {
        throw new Error(`nwjs CDP endpoint at ${CDP_ROOT} returned ${res.status} - is it running?`);
    }
    return res.json();
}

// Cheap, fast liveness check - true iff the CDP endpoint actually answers
// (not just "port 9222 accepted a TCP connection"), false for anything
// else (not running, crashed, wrong thing on that port).
async function isAlive() {
    try {
        const res = await fetch(`${CDP_ROOT}/json/version`);
        return res.ok;
    } catch (e) {
        return false;
    }
}

function connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(webSocketDebuggerUrl);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(new Error(`CDP WebSocket connect failed: ${e.message || e}`));
    });
}

// Formats a CDP Runtime.RemoteObject (console arg, exception detail, etc.)
// into a readable string - prefers the primitive .value, falls back to
// .description (objects/errors), then a raw dump as a last resort.
function formatRemote(obj) {
    if (!obj) return String(obj);
    if (obj.value !== undefined) return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
    if (obj.description !== undefined) return obj.description;
    if (obj.unserializableValue !== undefined) return obj.unserializableValue;
    return JSON.stringify(obj);
}

// Runs `code` against an already-open CDP target (background page or a real
// app window), capturing console.* calls and uncaught exceptions that
// happen anywhere in the page during the call, not just the eval's own
// throw/return. `code` may be async / use top-level await; it's run inside
// an async IIFE wrapper automatically.
async function evalOn(webSocketDebuggerUrl, code, { timeoutMs = 30000 } = {}) {
    const ws = await connect(webSocketDebuggerUrl);
    const logs = [];
    const errors = [];
    let msgId = 1;

    const pending = new Map();
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
            return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            logs.push({
                type: msg.params.type,
                text: msg.params.args.map(formatRemote).join(' '),
            });
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const ex = msg.params.exceptionDetails;
            errors.push(ex.exception ? formatRemote(ex.exception) : ex.text);
        }
    };

    function send(method, params) {
        return new Promise((resolve) => {
            const id = msgId++;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    let timer;
    try {
        await send('Runtime.enable', {});
        const wrapped = `(async () => {\n${code}\n})()`;
        const evalPromise = send('Runtime.evaluate', {
            expression: wrapped,
            awaitPromise: true,
            returnByValue: true,
        });
        // Cleared in the finally below regardless of which promise wins -
        // an uncleared setTimeout() here keeps Node's event loop alive
        // until it naturally fires, so the CLI process hangs on exit for
        // up to timeoutMs even after a successful, already-printed result
        // (confirmed live: this exact bug, on the first real run).
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`nwjs eval timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        const response = await Promise.race([evalPromise, timeout]);

        if (response.result?.exceptionDetails) {
            const ex = response.result.exceptionDetails;
            errors.push(ex.exception ? formatRemote(ex.exception) : ex.text);
        }
        const value = response.result?.result?.value;
        return { value, logs, errors };
    } finally {
        clearTimeout(timer);
        ws.close();
    }
}

// Navigates the given page tab to `url` in place via CDP (Page.navigate),
// waiting for the load to actually complete (Page.loadEventFired) rather
// than a blind delay - re-injects inject_console_capture.js's hooks too,
// since a fresh navigation gets a fresh JS realm.
async function navigate(page, url) {
    const ws = await connect(page.webSocketDebuggerUrl);
    let msgId = 1;
    const pending = new Map();
    const loadWaiters = [];
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === 'Page.loadEventFired') {
            loadWaiters.splice(0).forEach((resolve) => resolve());
        }
    };
    function send(method, params) {
        return new Promise((resolve) => {
            const id = msgId++;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }
    try {
        await send('Page.enable', {});
        const loaded = new Promise((resolve) => loadWaiters.push(resolve));
        const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
        await send('Page.navigate', { url });
        await Promise.race([loaded, timeout]);
    } finally {
        ws.close();
    }
}

// Closes every "page" tab except the first, via CDP's plain HTTP
// /json/close/<id> (no WebSocket needed). This is the whole point of the
// shared-window model - one browser window, reused by manual clicking,
// injected scripts, and mocha tests alike - so more than one page tab ever
// existing is always a bug to self-heal, not a state to tolerate. Confirmed
// live: a second window did appear once (root cause not fully pinned down -
// plausibly a race between two close-together getAppPage() calls each
// finding no page tab yet) - this makes it self-correct regardless of
// exactly how it happens again.
async function closeExtraPages(tabs) {
    const pages = tabs.filter((t) => t.type === 'page');
    for (const extra of pages.slice(1)) {
        await fetch(`${CDP_ROOT}/json/close/${extra.id}`).catch(() => {});
    }
    return pages[0];
}

// Finds the currently-open real app window (a "page" tab, i.e. not the
// hidden background page) and navigates it in place if `url` is given and
// doesn't already match - or opens one via the background page's
// openAppWindow() global (nwjs/index.js) if none exists yet. Deliberately
// does NOT open a second window for a different url - confirmed live that
// was the original (wrong) behavior here: a fresh nw.Window.open() call
// per distinct URL, piling up extra windows instead of just navigating the
// one that's already open.
async function getAppPage({ url } = {}) {
    let tabs = await listTabs();
    let page = tabs.filter((t) => t.type === 'page').length > 1 ? await closeExtraPages(tabs) : tabs.find((t) => t.type === 'page');

    if (!page) {
        const bg = tabs.find((t) => t.type === 'background_page');
        if (!bg) throw new Error('nwjs background page not found - is nwjs running? (cd nwjs && npm start)');
        await evalOn(bg.webSocketDebuggerUrl, `return await openAppWindow(${JSON.stringify(url || 'http://localhost:3000/')});`);
        // Give the new window a moment to register as its own CDP target.
        await new Promise((r) => setTimeout(r, 500));
        tabs = await listTabs();
        page = tabs.find((t) => t.type === 'page');
        if (!page) throw new Error('openAppWindow() did not produce a page tab');
    } else if (url && page.url !== url) {
        await navigate(page, url);
        tabs = await listTabs();
        page = tabs.find((t) => t.type === 'page');
    }
    return page;
}

// Evaluate `code` in the real app window's page context (opening/reusing
// one automatically). This is the one most callers want - both the CLI
// injector and mocha tests checking real app/DOM behavior.
async function evalInPage(code, { url, timeoutMs = 30000 } = {}) {
    const page = await getAppPage({ url });
    return evalOn(page.webSocketDebuggerUrl, code, { timeoutMs });
}

// Evaluate `code` in the hidden background page's context (has `nw`,
// `require`, `openAppWindow`, and the spawned server's handle) - for
// controlling nwjs itself rather than the app page.
async function evalInBackground(code, { timeoutMs = 30000 } = {}) {
    const tabs = await listTabs();
    const bg = tabs.find((t) => t.type === 'background_page');
    if (!bg) throw new Error('nwjs background page not found - is nwjs running? (cd nwjs && npm start)');
    return evalOn(bg.webSocketDebuggerUrl, code, { timeoutMs });
}

// Reads the app window's persistently-captured console log (see
// nwjs/inject_console_capture.js) - covers everything that happened in the
// page, not just what occurred during a specific evalInPage() call.
// `since` (a ts from a previous read) filters to only-new entries; `clear`
// empties the buffer after reading.
//
// Reads via evalInPage() (a normal CDP eval *against the page itself*),
// NOT through the background script's cached nw.Window reference - that
// was the original approach (getWindowConsoleLog() in nwjs/index.js, now
// unused/removable) and it had a real cross-realm staleness bug: after an
// in-place Page.navigate(), the background script's win.window reference
// can still point at the pre-navigation document's JS realm, so reads
// silently came back empty/wrong even though the *current* page's log had
// real entries - confirmed live, this is exactly what made a genuine
// device rejection look like it hadn't happened. Evaluating directly
// against the page's own current websocket target has no such staleness
// window - it's always whatever's actually loaded right now.
async function getConsoleLog({ since = 0, clear = false } = {}) {
    // Deliberately ignores evalOn()'s `errors` here - those include *any*
    // Runtime.exceptionThrown that happens to fire anywhere on the page
    // during this call's brief connection window, not just genuine bugs in
    // the small inline reader script below. Confirmed live: a real, ambient
    // app-level error ("Unknown Key Type to Encode") fired while this was
    // reading the log and made getConsoleLog() itself throw - exactly
    // backwards, since surfacing ambient errors is the whole point of this
    // function (they're already captured as `exception`-type entries in
    // the returned log itself via inject_console_capture.js's own
    // window.onerror/unhandledrejection hooks - no need to *also* throw).
    const { value } = await evalInPage(`
        window.__nwConsoleLog = window.__nwConsoleLog || [];
        const log = window.__nwConsoleLog;
        const entries = ${since} ? log.filter((e) => e.ts > ${since}) : log.slice();
        if (${JSON.stringify(!!clear)}) window.__nwConsoleLog = [];
        return entries;
    `);
    return value || [];
}

module.exports = { listTabs, isAlive, evalInPage, evalInBackground, getAppPage, getConsoleLog };
