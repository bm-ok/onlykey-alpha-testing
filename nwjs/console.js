#!/usr/bin/env node
// Dumps the app window's persistently-captured console log - everything
// that happened in the page since it opened (or since the last --clear),
// not just output from a specific run.js injection. This is the one to use
// to check "what did the GUI actually do" after a human click, a page
// reload, or any activity that wasn't itself a script I injected.
//
// Usage: node console.js [--clear]
const { getConsoleLog } = require('../lib/nwjs_client');

async function main() {
    const clear = process.argv.includes('--clear');
    const entries = await getConsoleLog({ clear });
    if (!entries.length) {
        console.log('(no console output captured)');
        return;
    }
    for (const e of entries) {
        console.log(`[${new Date(e.ts).toISOString()}] [${e.type}] ${e.text}`);
    }
}

main().catch((e) => {
    console.error('console.js failed:', e.message);
    process.exit(1);
});
