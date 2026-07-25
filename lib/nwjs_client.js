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
    const res = await fetch(`${CDP_ROOT}/json`);
    if (!res.ok) {
        throw new Error(
            `Could not reach nwjs CDP endpoint at ${CDP_ROOT} (${res.status}) - is it running? ` +
                '(cd nwjs && npm start)'
        );
    }
    return res.json();
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

// Finds the currently-open real app window (a "page" tab, i.e. not the
// hidden background page), or opens one via the background page's
// openAppWindow() global (nwjs/index.js) if none exists yet / `url` is
// given and doesn't match what's currently open.
async function getAppPage({ url } = {}) {
    let tabs = await listTabs();
    let page = tabs.find((t) => t.type === 'page');

    if (!page || (url && page.url !== url)) {
        const bg = tabs.find((t) => t.type === 'background_page');
        if (!bg) throw new Error('nwjs background page not found - is nwjs running? (cd nwjs && npm start)');
        await evalOn(bg.webSocketDebuggerUrl, `return await openAppWindow(${JSON.stringify(url || 'http://localhost:3000/')});`);
        // Give the new window a moment to register as its own CDP target.
        await new Promise((r) => setTimeout(r, 500));
        tabs = await listTabs();
        page = tabs.find((t) => t.type === 'page');
        if (!page) throw new Error('openAppWindow() did not produce a page tab');
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
// nwjs/inject_console_capture.js + nwjs/index.js's getWindowConsoleLog()) -
// covers everything that happened in the page, not just what occurred
// during a specific evalInPage() call. `since` (a ts from a previous read)
// filters to only-new entries; `clear` empties the buffer after reading.
async function getConsoleLog({ since = 0, clear = false } = {}) {
    const { value, errors } = await evalInBackground(
        `return getWindowConsoleLog(${JSON.stringify({ since, clear })});`
    );
    if (errors.length) throw new Error(`getConsoleLog failed: ${errors.join('; ')}`);
    return value || [];
}

module.exports = { listTabs, evalInPage, evalInBackground, getAppPage, getConsoleLog };
