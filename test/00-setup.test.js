const assert = require('assert');
const { OnlyKeyDevice, checkStatus, waitForDeviceReady } = require('../lib/device');
const { PINS } = require('../lib/config');

// Setup only makes sense once per device lifetime - a device that's already
// past UNINITIALIZED has already been through this flow (or was set up by
// hand), so there's nothing to do and re-running would just hang waiting on
// PIN entry that never happens.
describe('Device initial setup (SETUP-02/03/04)', function () {
    this.timeout(60 * 1000); // message-driven advance (no 20s firmware timer waits) + reboot

    let status;

    before(async function () {
        status = await checkStatus();
        if (status.state === 'unknown') {
            // 'unknown' here almost always means "locked", not "unreachable":
            // a locked device answers `onlykey-cli settime` with an empty read
            // on most attempts (measured 2026-07-31: 12 of 14 polls over 22s),
            // and checkStatusOnce() has nothing to classify that as. Settle it
            // by making the device answer directly - waitForDeviceReady()
            // throws if it genuinely cannot, which is the case the assertion
            // below is really there to catch.
            await waitForDeviceReady();
            status = { state: 'locked', raw: status.raw };
        }
    });

    it('reports current device state', function () {
        console.log(`    device state: ${status.state}`);
        assert.notStrictEqual(status.state, 'unknown', `Could not read device state: ${status.error || status.raw}`);
    });

    it('walks through primary/secondary/self-destruct PIN setup (SETUP-03)', async function () {
        if (status.state !== 'uninitialized') {
            this.skip(); // already set up - nothing to do
        }
        if (process.env.ONLYKEY_CONFIRM_SETUP !== 'yes') {
            throw new Error(
                'Refusing to run initial setup against real hardware without ONLYKEY_CONFIRM_SETUP=yes. ' +
                    'This sets real PINs (including a self-destruct PIN) on the physical device.'
            );
        }

        const device = new OnlyKeyDevice();
        await device.connect();
        try {
            await device.runInitialSetup(PINS);
        } finally {
            device.close();
        }
    });

    it('unlocks with primary PIN after reboot (SETUP-04)', async function () {
        if (status.state === 'unlocked') {
            this.skip(); // already unlocked, nothing to verify
        }
        if (status.state === 'uninitialized' && process.env.ONLYKEY_CONFIRM_SETUP !== 'yes') {
            this.skip(); // setup step above didn't run, so there's nothing to unlock yet
        }

        const device = new OnlyKeyDevice();
        await device.connect();
        try {
            device.unlockWithPrimaryPin(PINS.primary);
        } finally {
            device.close();
        }

        // profile1hashevaluate() runs a Curve25519 + SHA256 computation on
        // every digit once guesslen>=7, and our 7 digits arrive in a rapid
        // burst - measured ~3.4s from last digit sent to the device actually
        // reporting unlocked, so poll instead of a single fixed-length wait.
        let after;
        for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            after = await checkStatus();
            if (after.state === 'unlocked') break;
        }
        assert.strictEqual(after.state, 'unlocked', `Expected unlocked, got ${after.state}: ${after.raw}`);
    });
});
