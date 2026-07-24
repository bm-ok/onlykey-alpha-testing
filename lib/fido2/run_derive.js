#!/usr/bin/env node
// Standalone entry point for an X-Wing web-derive FIDO2 call, spawned as a
// child process for the same reason run_connect.js is (see its doc comment
// - the native FIDO2 HID binding segfaults during process teardown after
// its own work is done). Also owns the SEREMU DEBUG-channel button-press
// loop needed to satisfy the device's real CTAP2 "user presence" check
// (ctap_user_presence_test(), device.cpp) while the FIDO2 call is in
// flight - confirmed live that this harness's ordinary simulated digit
// presses satisfy it, same as a physical touch would - since both need to
// run concurrently in one process (see lib/fido2/client.js's deriveXwing()
// doc comment for why this lives here and not in client.js itself).
//
// Usage: node run_derive.js <labelHex32> [ctXHex32]
// Prints one JSON line: { ok, pkOrSsX, mlkemSeed, status } or { ok: false, error }.
const { FIDO2Client, deriveXwing } = require('./client');
const { SeremuChannel, sleep } = require('../hid');

async function main() {
    const labelHex = process.argv[2];
    const ctXHex = process.argv[3] || null;
    if (!labelHex || labelHex.length !== 64) {
        throw new Error('usage: run_derive.js <labelHex32> [ctXHex32]');
    }
    const label32 = Buffer.from(labelHex, 'hex');
    const ctX = ctXHex ? Buffer.from(ctXHex, 'hex') : null;

    const channel = new SeremuChannel();
    await channel.connect();

    let stop = false;
    const pressLoop = (async () => {
        await sleep(500);
        while (!stop) {
            for (const digit of ['1', '2', '3', '4', '5', '6']) {
                if (stop) break;
                channel.send([digit.charCodeAt(0), 10]); // short press
                // eslint-disable-next-line no-await-in-loop
                await sleep(300);
            }
        }
    })();

    const fido2 = new FIDO2Client(false);
    try {
        const result = await deriveXwing(fido2, label32, { ctX, reqPress: true });
        process.stdout.write(JSON.stringify({
            ok: true,
            pkOrSsX: result.pkOrSsX.toString('hex'),
            mlkemSeed: result.mlkemSeed.toString('hex'),
            status: result.status,
        }) + '\n');
    } finally {
        stop = true;
        await pressLoop;
        channel.close();
    }
}

main().catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
});
