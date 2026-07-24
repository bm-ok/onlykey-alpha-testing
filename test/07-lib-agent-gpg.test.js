const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OnlyKeyDevice, checkStatus } = require('../lib/device');
const { PINS } = require('../lib/config');
const { sleep } = require('../lib/hid');
const { runGpgInitWithAutoConfirmRetrying } = require('../lib/gpg_init');

// Maintainer's TC-13, GPG half: `onlykey-gpg init` creates an isolated GPG
// home directory (never touches the caller's real ~/.gnupg unless --homedir
// is omitted - always passed explicitly here to keep this test harmless to
// run), exports the device's derived OpenPGP public key, imports it into
// that fresh keyring, sets ultimate ownertrust, and confirms the agent
// responds to `gpg --list-secret-keys`. Like TC-13's SSH half, this is a
// regression check that this session's firmware/CLI PQC-era changes didn't
// break the existing (non-PQC) GPG derived-key path.
async function unlockDevice() {
    const device = await new OnlyKeyDevice().connect();
    device.restartDevice();
    device.close();
    await sleep(3000);
    await device.connect();
    device.unlockWithPrimaryPin(PINS.primary);
    for (let i = 0; i < 10; i++) {
        await sleep(500);
        const status = await checkStatus({ retries: 0 });
        if (status.state === 'unlocked') break;
    }
    device.close();
    await sleep(500);
}

describe('lib-agent GPG derived identity init (TC-13)', function () {
    this.timeout(4 * 90 * 1000); // see runGpgInitWithAutoConfirmRetrying

    let baseDir;

    before(async function () {
        this.timeout(30000);
        await unlockDevice();
        // A container directory, not the GPG homedir itself - the retrying
        // wrapper creates a fresh `attempt-N` subdir per try (run_init()
        // refuses to reuse an existing homedir).
        baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc13-gpg-'));
    });

    after(function () {
        if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
    });

    it('creates a hardware-backed GPG identity and the agent responds to it', async function () {
        const result = await runGpgInitWithAutoConfirmRetrying(baseDir, 'OnlyKey TC-13 Test <tc13-gpg@example.com>');
        assert.strictEqual(result.code, 0, `onlykey-gpg init failed:\n${result.stderr}\n${result.stdout}`);
        assert.ok(fs.existsSync(path.join(result.homedir, 'pubkey.asc')), 'no pubkey.asc written');

        const pubkey = fs.readFileSync(path.join(result.homedir, 'pubkey.asc'), 'utf8');
        assert.match(pubkey, /-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'pubkey.asc is not armored PGP');
    });
});
