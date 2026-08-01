// Runs onlykey.github.io's REAL device library in Node, by supplying the small
// browser surface it needs instead of a browser.
//
// This is the same idea as that repo's own `src/onlykey-fido2/test-api`
// (`window_replacements/index.js`), generalised and pointed at this harness's
// dependencies. The point is that `onlykey-3rd-party.js` -
// `derive_public_key`, `derive_shared_secret`, and eventually the composite
// calls - is exercised as-is. A reimplementation in Node would be a second,
// divergent copy of the code under test, which is the thing this whole suite
// exists to avoid.
//
// Two settings here are correctness-critical, both learned from real failures:
//
//   * `location.hostname` must be `onlyagent.app`. It is folded into the
//     derivation (okcrypto_hkdf reads the RPID staged at ctap_buffer+4), and
//     the CLI pins the same value. Anything else derives a DIFFERENT key with
//     no error - the failure surfaces much later as "no identity matched any
//     of the recipients". test-api's own shim hardcodes `apps.crp.to`, which
//     is why it must not be copied verbatim.
//
//   * this module must be loaded from `onlykey-testing`, so `node-hid`
//     resolves to 3.4.0 via this package's `overrides`. Resolved from
//     `onlykey.github.io` it picks up 2.2.0, whose bundled hidapi has a
//     use-after-free that segfaults on process teardown (root-caused with gdb;
//     see TEST-PLAN TC-10).

const path = require('path');
const { webcrypto } = require('crypto');
const { FIDO2Client } = require('@vincss-public-projects/fido2-client');

const WEB_FIDO2 = path.resolve(
    __dirname, '..', '..', '..', 'onlykey.github.io', 'src', 'onlykey-fido2'
);

const DEFAULT_RPID = 'onlyagent.app';

// The surface onlykey-3rd-party.js actually touches, read off the source
// rather than guessed: crypto.subtle/getRandomValues, TextEncoder, atob/btoa,
// navigator.{vendor,userAgent,platform}, navigator.credentials.get,
// location.hostname, and a mutable window._status the library both sets and
// reads while polling.
// Presents a WebAuthn assertion response the way a browser does: every binary
// field as a real ArrayBuffer rather than a Buffer/typed array.
function toArrayBuffers(response) {
    if (!response || typeof response !== 'object') return response;
    const out = {};
    for (const [k, v] of Object.entries(response)) {
        if (v instanceof ArrayBuffer) out[k] = v;
        else if (ArrayBuffer.isView(v)) out[k] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        else if (Array.isArray(v) && v.every((n) => typeof n === 'number')) out[k] = Uint8Array.from(v).buffer;
        else out[k] = v;
    }
    return out;
}

function makeWindow(fido2, { rpId = DEFAULT_RPID } = {}) {
    const $window = {
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        location: { hostname: rpId, origin: `https://${rpId}` },
        navigator: {
            vendor: 'Node',
            userAgent: 'NODE',
            platform: 'Linux',
            credentials: {
                // FIDO2Client hands back Node Buffers; a real
                // navigator.credentials.get() hands back ArrayBuffers, and
                // the library builds a DataView straight over
                // assertion.response.signature. Without this conversion it
                // throws "First argument to DataView constructor must be an
                // ArrayBuffer", which its own catch turns into the generic
                // "Problem Derive Public Key on onlykey" - so the real cause
                // is invisible. Convert on the way out instead of patching
                // the library.
                get: async (ticket) => {
                    const assertion = await fido2.getAssertion(ticket, `https://${rpId}`);
                    return { ...assertion, response: toArrayBuffers(assertion.response) };
                },
            },
        },
        _status: undefined,
    };
    return $window;
}

// Mirrors plugin.js's wiring (which is an architect module, so it cannot be
// require()'d directly) - same vendored dependencies, same construction order.
function loadOnlykeyLib($window, { quiet = true } = {}) {
    // The library decorates Uint8Array.prototype; plugin.js does this too.
    if (!Uint8Array.prototype.toHexString) {
        // eslint-disable-next-line no-extend-native
        Uint8Array.prototype.toHexString = function toHexString() {
            const out = [];
            this.forEach((c) => out.push(c.toString(16).toUpperCase()));
            return out.join(' ');
        };
    }

    // The library reads `imports.window` in some places and a bare, ambient
    // `window` in others (e.g. onlykey-3rd-party.js:369) - harmless in a
    // browser bundle where it is global, fatal in Node. Install it globally as
    // well as passing it in, so both styles resolve to the same object.
    global.window = $window;
    if (!global.navigator) global.navigator = $window.navigator;
    if (!global.location) global.location = $window.location;

    const imports = {
        window: $window,
        console: quiet ? { log() {}, warn() {}, error() {}, info() {} } : console,
    };
    imports.kbpgp = require(path.join(WEB_FIDO2, 'onlykey', 'kbpgp-2.1.0.ok.ecc.js'));
    imports.nacl = require(path.join(WEB_FIDO2, 'onlykey', 'nacl.min.js'));
    imports.forge = require(path.join(WEB_FIDO2, 'onlykey', 'forge.min.js'));
    imports.pgpDecoder = require(path.join(WEB_FIDO2, 'onlykey', 'pgp-decoder', 'pgp.decoder.js'));

    const onlykeyApi = require(path.join(WEB_FIDO2, 'onlykey', 'onlykey-api.js'))(imports);
    const onlykey3rd = require(path.join(WEB_FIDO2, 'onlykey', 'onlykey-3rd-party.js'))(imports, onlykeyApi);
    return { onlykeyApi, onlykey3rd, imports };
}

// One call: a live FIDO2 client, the shimmed window, and the real library.
// `ok` is what the web app's own pages get from `app.onlykey3rd(...)`.
function createBrowserEnv({ rpId = DEFAULT_RPID, quiet = true, slot = 1, keyType = 0 } = {}) {
    const fido2 = new FIDO2Client(false);
    const $window = makeWindow(fido2, { rpId });
    const { onlykeyApi, onlykey3rd, imports } = loadOnlykeyLib($window, { quiet });
    return { fido2, window: $window, onlykeyApi, onlykey3rd, imports, ok: onlykey3rd(slot, keyType) };
}

module.exports = { createBrowserEnv, makeWindow, loadOnlykeyLib, WEB_FIDO2, DEFAULT_RPID };
