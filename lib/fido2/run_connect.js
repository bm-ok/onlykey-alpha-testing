#!/usr/bin/env node
// Standalone entry point for the OKCONNECT FIDO2 handshake, meant to be
// spawned as a child process (see test/09-fido2-connect.test.js) rather than
// required in-process. Necessary because @vincss-public-projects/fido2-client's
// native node-hid binding reliably segfaults during process teardown *after*
// all of this script's own logic has already completed successfully
// (confirmed live: the JSON line below prints correctly every time,
// immediately before the crash) - isolating it in a child process keeps that
// native-cleanup crash from taking down the whole Mocha run. Prints one JSON
// line to stdout on success; a non-JSON/empty stdout on crash before that
// line is the real failure signal, not the child's own exit code.
const { FIDO2Client, connect } = require('./client');

async function main() {
    const fido2 = new FIDO2Client(false);
    const result = await connect(fido2);
    process.stdout.write(JSON.stringify({
        ok: true,
        sharedSecret: Buffer.from(result.sharedSecret).toString('hex'),
        okPub: Buffer.from(result.okPub).toString('hex'),
        status: result.status,
        fwVersion: result.fwVersion,
    }) + '\n');
}

main().catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
});
