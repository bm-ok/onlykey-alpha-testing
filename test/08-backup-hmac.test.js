const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { OnlyKeyDevice, checkStatus, unlockDevice } = require('../lib/device');
const { VENV_BIN } = require('../lib/config');
const { enterConfigMode } = require('../lib/pqc_keygen');

// Maintainer's TC-13, backup/HMAC half. Scope note (see TEST-PLAN.md): a
// full backup-create -> restore round-trip isn't testable from this repo -
// there is no backup-file *creation* command anywhere in python-onlykey's
// client.py or CLI (only `restore_from_backup()`/`onlykey-cli restore`,
// which *consumes* a backup file); producing one is a closed-source
// OnlyKey-App/DUO-hardware feature this harness has no access to. Likewise,
// the actual HMAC *challenge-response* feature (YubiKey-OTP-compatible) is a
// keyboard/OTP HID interface python-onlykey doesn't implement a client for
// at all. What IS safely, meaningfully testable here: the `hmackeymode` /
// `backupkeymode` global device-setting toggles (`onlykey-cli
// hmackeymode`/`backupkeymode`, MessageField.HMACMODE/BACKUPMODE - both
// hardcoded to `setslot(1, ...)`, i.e. device-wide settings, not per-slot
// attributes) still work post-PQC-changes, and that malformed backup data is
// rejected cleanly (`_parse_backup_data()`'s SHA256 check runs entirely
// client-side before anything is ever sent to the device, so this is safe -
// no restore actually reaches the device on this path).
// Both hmackeymode and backupkeymode writes hit OKSETSLOT's
// `mod_keys_enabled && configmode == false` guard on this device's current
// state (confirmed live - both failed with "Error not in config mode"
// outside config mode). Entered once here and shared by both tests below,
// since configmode is a device-side flag that persists across separate CLI
// processes until the device relocks - same long-press-6 + re-unlock dance
// TC-04's keygen automation uses. Now lib/pqc_keygen.js's shared
// enterConfigMode() helper (this file previously duplicated the same
// unlock+long-press-6 sequence locally, as did test/12).
function runCli(args, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve) => {
        execFile(
            path.join(VENV_BIN, 'onlykey-cli'),
            args,
            { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
        );
    });
}

describe('Backup/HMAC device settings (TC-13)', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(45000);
        await unlockDevice();
        await enterConfigMode();
    });

    it('sets hmackeymode without error', async function () {
        const result = await runCli(['hmackeymode', '0']);
        assert.strictEqual(result.code, 0, `hmackeymode failed:\n${result.stderr}\n${result.stdout}`);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /error/i);
    });

    it('rejects changing backupkeymode after it is already set (write-once protection)', async function () {
        // Not a plain "does this succeed" check: okcore_quick_setup()
        // (initial device provisioning, SETUP-03) already commits
        // backupkeymode once as part of setup - confirmed live via the
        // firmware's own specific rejection message, distinct from the
        // generic "not in config mode" error. Verifying that protection
        // actually holds (a security-relevant setting can't be silently
        // changed later, even from config mode) is a more meaningful
        // regression check than a bare write would have been.
        const result = await runCli(['backupkeymode', '0']);
        assert.match(
            `${result.stdout}${result.stderr}`,
            /backup key mode may not be changed/i,
            `expected the write-once rejection, got:\n${result.stdout}\n${result.stderr}`
        );
    });

    it('rejects a malformed backup file cleanly (hash mismatch, no device I/O)', async function () {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlykey-tc13-backup-'));
        const badBackupPath = path.join(tmpDir, 'bad.backup');
        // Well-formed envelope, deliberately wrong hash - _parse_backup_data()
        // must catch this itself, before restore_from_backup() ever calls
        // send_message(msg=Message.OKRESTORE, ...).
        fs.writeFileSync(badBackupPath, [
            '-----BEGIN ONLYKEY BACKUP-----',
            Buffer.from('not the real backup payload').toString('base64'),
            `--${Buffer.from('0000000000000000000000000000000000000000000000000000000000000000').toString('base64')}`,
            '-----END ONLYKEY BACKUP-----',
        ].join('\n'));

        try {
            const result = await runCli(['restore', badBackupPath]);
            // onlykey-cli's restore command catches this exception and just
            // prints it (cli.py's `except Exception as e: print(...); return`)
            // rather than exiting non-zero - confirmed live. Not great CLI
            // ergonomics (a caller can't script off the exit code alone),
            // but not this pass's scope to fix - what matters for TC-13 is
            // that it's rejected cleanly with a clear message and no partial
            // OKRESTORE data ever reaches the device (guaranteed structurally:
            // _parse_backup_data() raises before restore_from_backup() gets
            // to its send_message(msg=Message.OKRESTORE, ...) loop).
            assert.match(
                `${result.stdout}${result.stderr}`,
                /hash mismatch|corrupt/i,
                `expected a clean hash-mismatch error, got:\n${result.stdout}\n${result.stderr}`
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
