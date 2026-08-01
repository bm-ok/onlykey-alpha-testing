// Exposes onlykey.github.io's CLASSIC PGP api (`onlykey-pgp.js`) to Node, the
// same way lib/fido2/browser_env.js exposes onlykey-3rd-party.js.
//
// This is the code behind the app's /app/encrypt and /app/decrypt pages:
// `app.onlykeyApi.pgp().api()` in both encrypt.js and decrypt.js. Everything
// those pages do beyond wiring up the DOM goes through `startEncryption` /
// `startDecryption` on the object this module returns, so driving it directly
// exercises the real thing with no reimplementation.
//
// Worth knowing before reading further, because it explains the shape of this
// file: only ONE of the four page modes touches the device.
//
//   Encrypt Only  - kbpgp encrypts to a recipient public key. No device.
//   Sign Only     - device signs (OKSIGN).
//   Encrypt+Sign  - both.
//   Decrypt*      - device decrypts (OKDECRYPT).
//
// So the encrypt half can be tested with no key plugged in at all, which is
// where the cheap regression coverage lives.
//
// `imports.app` is the architect "app" service in the browser build. The PGP
// api only ever calls `.emit()` on it (ok-signing / ok-decrypting /
// ok-activity / ok-connected / ok-error), so an EventEmitter is a complete
// stand-in - and a useful one, since those events are the only progress
// signal the device path emits.

const path = require('path');
const { EventEmitter } = require('events');
const { makeWindow, loadOnlykeyLib, WEB_FIDO2, DEFAULT_RPID } = require('./browser_env');
const { FIDO2Client } = require('@vincss-public-projects/fido2-client');

// onlykey-pgp.js pulls in file-saver and jszip for the *-file page variants.
// Both are resolved from onlykey.github.io/node_modules (Node walks up from
// the required file's own directory), so no dependency is added here. They
// are only exercised by encryptFile/decryptFile, which the message-mode tests
// never reach.
function loadPgpApi($window, imports) {
    return require(path.join(WEB_FIDO2, 'onlykey', 'onlykey-pgp.js'))(imports);
}

// Mirrors what encrypt.js/decrypt.js do in their setup():
//   page.okpgp = app.onlykeyApi.pgp().api();
//   page.okpgp._$mode($("#action")[0].select_one.value);
// plus the api.on("status"/"error") wiring, surfaced here as an event log so a
// failing test can show what the library was doing when it gave up.
function createPgpEnv({ rpId = DEFAULT_RPID, quiet = true, withDevice = false } = {}) {
    const fido2 = withDevice ? new FIDO2Client(false) : null;
    const $window = makeWindow(fido2 || { getAssertion: async () => { throw new Error('no device in this env'); } }, { rpId });
    const { onlykeyApi, onlykey3rd, imports } = loadOnlykeyLib($window, { quiet });

    const app = new EventEmitter();
    app.setMaxListeners(0);
    imports.app = app;

    const pgpModule = loadPgpApi($window, imports);
    // Exactly `app.onlykeyApi.pgp().api()` from encrypt.js:64 / decrypt.js:57:
    // the module is curried (imports) -> (onlykeyApi) -> { api, ... }, and
    // .api() builds one PGP_API instance with its own kbpgp + event emitter.
    const okpgp = pgpModule(onlykeyApi).api();

    // Every status/error line the library emits, in order. `startEncryption`
    // reports failure by emitting "error" and returning normally - it does NOT
    // throw and does NOT call the callback - so without capturing these a
    // failed encrypt is indistinguishable from a hung one.
    const events = [];
    for (const name of ['status', 'error', 'working', 'done', 'completed']) {
        okpgp.on(name, (arg) => events.push({ name, arg: arg && arg.message ? arg.message : arg }));
    }
    for (const name of ['ok-signing', 'ok-decrypting', 'ok-activity', 'ok-connected', 'ok-error']) {
        app.on(name, () => events.push({ name }));
    }

    return { fido2, window: $window, onlykeyApi, onlykey3rd, imports, app, okpgp, pgpApi: pgpModule, events };
}

// Promise wrapper around startEncryption. Two things make this less trivial
// than it looks, both learned by watching it hang:
//
//   * the library signals failure only through the "error" event, so that has
//     to reject the promise or the caller waits forever;
//   * `to_pgpkeys` is checked with `to_pgpkeys.value == ""` (a leftover from
//     when it was handed the DOM element, not the string) - which is never
//     true for a string, so an empty recipient sails past the guard and fails
//     much later inside kbpgp. Callers should validate their own inputs.
function encrypt(env, { mode, recipients = '', signer = '', message }) {
    env.okpgp._$mode(mode);
    env.okpgp._$status(undefined);
    return new Promise((resolve, reject) => {
        const onError = (e) => reject(new Error(`okpgp error: ${e && e.message ? e.message : e}`));
        env.okpgp.once('error', onError);
        env.okpgp.startEncryption(recipients, signer, message, null, (err, data) => {
            env.okpgp.removeListener('error', onError);
            if (err) return reject(err instanceof Error ? err : new Error(String(err)));
            resolve(data);
        });
    });
}

function decrypt(env, { mode, signer = '', myPublic = '', message }) {
    env.okpgp._$mode(mode);
    env.okpgp._$status(undefined);
    return new Promise((resolve, reject) => {
        const onError = (e) => reject(new Error(`okpgp error: ${e && e.message ? e.message : e}`));
        env.okpgp.once('error', onError);
        env.okpgp.startDecryption(signer, myPublic, message, null, (err, data) => {
            env.okpgp.removeListener('error', onError);
            if (err) return reject(err instanceof Error ? err : new Error(String(err)));
            resolve(data);
        });
    });
}

module.exports = { createPgpEnv, encrypt, decrypt };
