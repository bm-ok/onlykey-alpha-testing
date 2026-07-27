#!/usr/bin/env node
// Checks whether an nwjs session is already up and healthy; reuses it if so,
// or cleans up anything stale left behind before a fresh one is started.
//
// nw.js/Chromium can crash natively (confirmed live: a real SIGSEGV inside
// libnw.so, not something this code causes or can prevent - this VM has no
// GPU acceleration, "VMware: No 3D enabled", a known source of Chromium
// instability) - when that happens the main nw process dies and drops off
// CDP (port 9222), but the web app server it spawned as a child process
// survives as an orphan (still answering on port 3000), which looks
// confusing/"hanging" from the outside: one port alive, the other dead, no
// way to inject/inspect anything anymore. This finds and clears that state.
//
// Usage: node ensure.js
//   exit 0  - already running and healthy, nothing to do, reuse it
//   exit 2  - was stale/not running; cleaned up; caller should now
//             `cd nwjs && npm start`
//   exit 1  - unexpected error
const { execSync } = require('child_process');
const { isAlive } = require('../lib/nwjs_client');

// Matches only processes rooted at *this* nwjs install (the SDK binary
// path is inside node_modules here) or spawned to run *this* project's
// web app server - not any other nw.js/node process on the machine.
const STALE_PATTERNS = [
    'nwjs/node_modules/nw/nwjs-sdk',
    'onlykey.github.io/index.js',
];

function findStalePids() {
    let psOut;
    try {
        psOut = execSync('ps -eo pid,args', { encoding: 'utf8' });
    } catch (e) {
        return [];
    }
    const pids = [];
    for (const line of psOut.split('\n')) {
        if (STALE_PATTERNS.some((p) => line.includes(p))) {
            const pid = parseInt(line.trim().split(/\s+/)[0], 10);
            if (Number.isFinite(pid) && pid !== process.pid) pids.push(pid);
        }
    }
    return pids;
}

async function main() {
    if (await isAlive()) {
        console.log('nwjs session already running and healthy - reusing it.');
        process.exit(0);
    }

    const pids = findStalePids();
    if (pids.length) {
        console.log(`Found ${pids.length} stale process(es) from a previous session: ${pids.join(', ')}. Cleaning up...`);
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch (e) {
                // already gone
            }
        }
    } else {
        console.log('No existing session found.');
    }
    console.log('Ready to start: cd nwjs && npm start');
    process.exit(2);
}

main().catch((e) => {
    console.error('ensure.js failed:', e.message);
    process.exit(1);
});
