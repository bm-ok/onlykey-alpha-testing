#!/usr/bin/env node
// Injects a JS file into the running nwjs app's real browser window (opening
// one via the background script if none is open yet) and prints back its
// return value plus any console output / uncaught errors that happened
// during the run - for ad-hoc inspection/stepping (a human or an LLM) and
// as the same mechanism a mocha test would use (though tests should
// `require('../lib/nwjs_client')` directly rather than shell out to this).
//
// Usage:
//   node run.js <script.js> [url]
//
// The script file's contents run inside an async function, so top-level
// `await` and `return <value>` both work. `document`/`window`/whatever the
// app itself defines are all in scope, same as pasting the code into
// DevTools console on that page.
const fs = require('fs');
const path = require('path');
const { evalInPage } = require('../lib/nwjs_client');

async function main() {
    const scriptPath = process.argv[2];
    const url = process.argv[3];
    if (!scriptPath) {
        console.error('Usage: node run.js <script.js> [url]');
        process.exit(1);
    }

    const code = fs.readFileSync(path.resolve(scriptPath), 'utf8');
    const { value, logs, errors } = await evalInPage(code, { url });

    for (const log of logs) {
        console.log(`[console.${log.type}] ${log.text}`);
    }
    if (value !== undefined) {
        console.log('--- return value ---');
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
    if (errors.length) {
        console.error('--- errors ---');
        for (const err of errors) console.error(err);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('run.js failed:', e.message);
    process.exit(1);
});
