// OnlyKey FIDO2/CTAP2 transport: the same trick onlykey-pgp.js uses in the
// browser (a real WebAuthn getAssertion() call, with the credential ID
// smuggling an OnlyKey vendor command and the "signature" field carrying the
// response) - here driven from Node via @vincss-public-projects/fido2-client
// (github.com/bmatusiak/FIDO2Client, our own fork - no BLE deps, PIN-modal
// code path disabled) instead of a browser's navigator.credentials.
//
// Recreated from scratch in this repo against the reference implementation
// (onlykey.github.io/src/onlykey-fido2/onlykey/onlykey-api.js, also
// standalone at github.com/bmatusiak/node-onlykey-fido2, both cloned
// locally as read-only reference - not depended on directly), not copied
// from it. One deliberate deviation, called out where it happens below: the
// reference's post-handshake AES-key derivation goes through an extra
// hex-string round-trip (`digestBuff()`) whose type coercion looks like it
// silently collapses to hashing a fixed-length null-byte string rather than
// the real shared secret - i.e. a likely-dead/buggy branch, not a spec
// requirement. This implements the derivation the surrounding code's own
// comment describes ("AES256 key sha256 hash of shared secret") - one
// SHA256 of the raw NaCl shared secret, which is exactly what this module's
// aesgcmEncrypt/Decrypt already do internally - verified empirically
// against real hardware rather than blind-replicating the confusing path.

const nacl = require('tweetnacl');
const { FIDO2Client } = require('@vincss-public-projects/fido2-client');
const { encodeCtaphidRequestAsKeyhandle, decodeCtaphidResponseFromSignature } = require('./ctaphid');
const { aesgcmEncrypt, aesgcmDecrypt, bytes2string, hexStrToDec } = require('./crypto');
const { sleep } = require('../hid');

const OKCONNECT = 228;

// Origin/rpId this whole trick is pinned to (see okcrypto_xwing_web_derive()
// in the firmware - RPID is hardcoded "onlyagent.app" there too; the
// production web app runs at that origin). Override per-call if needed.
const DEFAULT_ORIGIN = 'https://onlyagent.app';

function randomBytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
}

// Builds the WebAuthn PublicKeyCredentialRequestOptions carrying the
// encoded vendor command as the (only) allowed credential ID, and resolves
// the decoded { status, data, error, count } response. Mirrors
// ctaphid_via_webauthn() in the reference.
async function ctaphidViaWebauthn(fido2, origin, cmd, opt1, opt2, opt3, data, timeoutMs) {
    const keyhandle = encodeCtaphidRequestAsKeyhandle(cmd, opt1, opt2, opt3, data);
    const rpId = new URL(origin).hostname;

    const options = {
        challenge: randomBytes(32),
        allowCredentials: [{
            transports: ['usb'],
            id: Buffer.from(keyhandle),
            type: 'public-key',
        }],
        timeout: timeoutMs,
        rpId,
        userVerification: 'discouraged',
    };

    // `timeout` in the options above is advisory - FIDO2Client does not
    // enforce it, so a device that never answers hangs this call forever.
    // Observed live: test/09's OKCONNECT sat until mocha's own 60s timeout
    // killed it (twice per run), and a standalone driver once blocked for 10
    // minutes. Every device-facing wait in this suite is supposed to be
    // bounded and resolve on a real response, so put a real ceiling here -
    // it covers connect(), deriveXwing() and the composite calls at once.
    const assertion = await Promise.race([
        fido2.getAssertion({ publicKey: options }, origin),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`FIDO2 getAssertion (cmd=${cmd}) did not answer within ${timeoutMs}ms`)),
            timeoutMs
        )),
    ]);
    const response = decodeCtaphidResponseFromSignature(assertion.response);
    return response;
}

// The initial handshake (OKCONNECT): generates an ephemeral NaCl box
// keypair, sends it to the device via ctaphidViaWebauthn, and derives the
// shared secret from the device's returned public key. Returns
// { sharedSecret, status, fwVersion } - sharedSecret is the raw 32-byte
// NaCl box shared secret (aesgcmEncrypt/Decrypt hash it internally per
// message, matching the rest of this protocol's convention).
//
// Confirmed empirically against real hardware (not from the reference JS,
// whose corresponding branch is confusing/likely dead code - see this
// module's doc comment): this firmware's OKCONNECT response is
// [device ephemeral pubkey(32) | plaintext status string], NOT encrypted -
// the tail decodes directly to the exact same status text
// `onlykey-cli settime`/checkStatus() reads ("UNLOCKEDv3.0.4-testc\0").
// Encryption (via the shared secret derived here) only applies to later
// vendor-command payloads sent through sendEncrypted(), not to this
// handshake reply itself.
async function connect(fido2, { origin = DEFAULT_ORIGIN, timeoutMs = 6000 } = {}) {
    const appKey = nacl.box.keyPair();

    const message = [255, 255, 255, 255, OKCONNECT];
    const currentEpochTimeHex = Math.round(Date.now() / 1000).toString(16);
    const timePart = (currentEpochTimeHex.match(/.{2}/g) || []).map(hexStrToDec);
    message.push(...timePart);
    message.push(...appKey.publicKey);
    // env = [browser, os] single-char codes - "Chrome"/"Node" defaults from
    // the reference (no real browser here, and getOS() returns "Node" when
    // there's no `window` global, which is exactly this context).
    message.push('C'.charCodeAt(0), 'N'.charCodeAt(0));

    const response = await ctaphidViaWebauthn(
        fido2, origin, OKCONNECT, null, null, null, Uint8Array.from(message), timeoutMs
    );

    if (response.status !== 'CTAP1_SUCCESS' || !response.data) {
        throw new Error(`OKCONNECT failed: status=${response.status} error=${response.error || '(none)'}`);
    }

    const data = response.data;
    const okPub = Uint8Array.from(data.slice(0, 32));
    const statusText = bytes2string(data.slice(32, data.length)).replace(/\0/g, '');

    const sharedSecret = nacl.box.before(okPub, appKey.secretKey);

    return {
        sharedSecret,
        okPub,
        status: statusText,
        fwVersion: (statusText.match(/v[\d.]+.*$/) || [])[0] || null,
    };
}

// Builds the same OKCONNECT-envelope header connect() sends (timestamp +
// ephemeral NaCl pubkey + browser/os bytes) - the derive commands below are
// ALSO cmd=OKCONNECT (not OKGETPUBKEY/OKDECRYPT - those exist in
// okcrypto.cpp's dispatcher but aren't reachable over this FIDO2 bridge;
// solo.cpp's bridge_u2f_to_solo() only routes OKPING/OKDECRYPT/OKSIGN/
// OKCONNECT to the device, OKGETPUBKEY is commented out there), reusing the
// SAME crypto_box_keypair()/transit_key setup on the device side
// (ok_extension.cpp's bridge_to_onlykey(), `if (cmd == OKCONNECT &&
// !CRYPTO_AUTH)` - the derive branch is nested inside that same gate).
function buildConnectHeader(appKey) {
    const header = [255, 255, 255, 255, OKCONNECT];
    const currentEpochTimeHex = Math.round(Date.now() / 1000).toString(16);
    const timePart = (currentEpochTimeHex.match(/.{2}/g) || []).map(hexStrToDec);
    header.push(...timePart);
    header.push(...appKey.publicKey);
    header.push('C'.charCodeAt(0), 'N'.charCodeAt(0));
    return header;
}

// wire opt2 for X-Wing: ok_extension.cpp does `opt2++` before comparing
// against KEYTYPE_XWING(6), so the value sent on the wire is 5.
const XWING_WIRE_KEYTYPE = 5;
const DERIVE_PUBLIC_KEY = 1;
const DERIVE_SHAREDSEC = 2;
const DERIVE_PUBLIC_KEY_REQ_PRESS = 3;
const DERIVE_SHAREDSEC_REQ_PRESS = 4;

// Derived (label-based) X-Wing split custody over FIDO2 - the browser-facing
// counterpart to derived_xwing.py/age_pqc.js's math. sk_X (X25519) never
// leaves the device; returns { pkOrSsX, mlkemSeed } - pkOrSsX is pk_X for
// recipient derivation, or ss_X for decapsulation (when ctX32 is given).
//
// `reqPress` selects the REQ_PRESS opt1 variant. The plain (non-REQ_PRESS)
// variant requires a device setting ("derived keys per site without touch",
// `derived_key_challenge_mode` bit 3) that isn't enabled by default -
// confirmed live: it fails with CTAP2_ERR_EXTENSION_NOT_SUPPORTED on an
// unmodified device. REQ_PRESS instead calls ctap_user_presence_test()
// (device.cpp), a real CTAP2 "test of user presence" loop that also still
// calls handle_packets() while waiting - confirmed live that this harness's
// existing SEREMU-simulated button presses (any digit, `lib/hid.js`'s
// SeremuChannel) satisfy it just like a real touch would, no new automation
// needed. The *caller* must be sending those presses concurrently while
// this call is in flight (see withSimulatedPresses() below) - this function
// itself doesn't manage that, since it has no channel to the SEREMU
// interface (a separate HID interface from the FIDO2 one this module uses).
//
// Response layout confirmed live (not just from reading ok_extension.cpp):
// [ device ephemeral pubkey(32) | plaintext status string, NUL-terminated
//   (variable length - "UNLOCKEDvX.Y.Z-xxxx\0") | pkOrSsX(32) | mlkemSeed(32) ]
// - the status-string gap is real (ok_extension.cpp's `xout = temp + 32 +
// sizeof(UNLOCKED) + 1`), parsed dynamically here rather than assuming a
// fixed offset since the version string's length can vary. When
// encryptResp is true, everything after the pubkey (status string + the
// 64-byte X-Wing payload, as one blob) is AES-GCM encrypted under the
// shared secret instead ("encrypt everything except transit public" -
// ok_extension.cpp forces any truthy opt3 to this mode, "encrypt truly
// everything" is unreachable from the wire).
async function deriveXwing(fido2, label32, {
    ctX = null,
    reqPress = true,
    encryptResp = false,
    origin = DEFAULT_ORIGIN,
    timeoutMs = 20000,
} = {}) {
    if (label32.length !== 32) throw new Error(`label must be 32 bytes, got ${label32.length}`);
    if (ctX && ctX.length !== 32) throw new Error(`ctX must be 32 bytes, got ${ctX.length}`);

    const appKey = nacl.box.keyPair();
    const message = buildConnectHeader(appKey);
    message.push(...label32);
    if (ctX) message.push(...ctX);

    const opt1 = ctX
        ? (reqPress ? DERIVE_SHAREDSEC_REQ_PRESS : DERIVE_SHAREDSEC)
        : (reqPress ? DERIVE_PUBLIC_KEY_REQ_PRESS : DERIVE_PUBLIC_KEY);

    const response = await ctaphidViaWebauthn(
        fido2, origin, OKCONNECT, opt1, XWING_WIRE_KEYTYPE, encryptResp ? 1 : 0,
        Uint8Array.from(message), timeoutMs
    );

    if (response.status !== 'CTAP1_SUCCESS' || !response.data) {
        throw new Error(`X-Wing derive failed: status=${response.status} error=${response.error || '(none)'}`);
    }

    const okPub = Uint8Array.from(response.data.slice(0, 32));
    const sharedSecret = nacl.box.before(okPub, appKey.secretKey);

    let tail = response.data.slice(32);
    if (encryptResp) {
        tail = Buffer.from(aesgcmDecrypt(tail, sharedSecret));
    }

    const nulAt = tail.indexOf(0);
    if (nulAt === -1) throw new Error('X-Wing derive response: no NUL-terminated status string found');
    const statusText = bytes2string(tail.slice(0, nulAt));
    const xwingPayload = tail.slice(nulAt + 1);
    if (xwingPayload.length !== 64) {
        throw new Error(`X-Wing derive response: expected 64 bytes after status, got ${xwingPayload.length}`);
    }

    return {
        pkOrSsX: Buffer.from(xwingPayload.slice(0, 32)),
        mlkemSeed: Buffer.from(xwingPayload.slice(32, 64)),
        okPub,
        sharedSecret,
        status: statusText,
    };
}

// A post-handshake encrypted vendor command: encrypts `plainData` with
// sharedSecret, sends it via ctaphidViaWebauthn, decrypts the response.
// Returns { status, error, data (decrypted bytes or null) }.
async function sendEncrypted(fido2, sharedSecret, cmd, opt1, opt2, opt3, plainData, {
    origin = DEFAULT_ORIGIN,
    timeoutMs = 6000,
} = {}) {
    const encrypted = plainData && plainData.length
        ? Uint8Array.from(aesgcmEncrypt(Array.from(plainData), sharedSecret))
        : new Uint8Array();

    const response = await ctaphidViaWebauthn(fido2, origin, cmd, opt1, opt2, opt3, encrypted, timeoutMs);

    if (response.status !== 'CTAP1_SUCCESS' || !response.data) {
        return { status: response.status, error: response.error, data: null };
    }

    const decrypted = Buffer.from(aesgcmDecrypt(response.data, sharedSecret));
    return { status: response.status, error: null, data: decrypted };
}

// Runs `fn()` while repeatedly sending simulated button presses over the
// given (already-connected) SEREMU channel, stopping as soon as `fn()`
// settles either way. For deriveXwing()'s REQ_PRESS variants, which need a
// real CTAP2 "user presence" confirmation - confirmed live that ordinary
// simulated digit presses satisfy it exactly like a physical touch would.
async function withSimulatedPresses(channel, fn, { pressDelayMs = 300, startDelayMs = 500 } = {}) {
    let stop = false;
    const pressLoop = (async () => {
        await sleep(startDelayMs);
        while (!stop) {
            for (const digit of ['1', '2', '3', '4', '5', '6']) {
                if (stop) break;
                channel.send([digit.charCodeAt(0), 10]); // short press
                // eslint-disable-next-line no-await-in-loop
                await sleep(pressDelayMs);
            }
        }
    })();

    try {
        return await fn();
    } finally {
        stop = true;
        await pressLoop;
    }
}

module.exports = {
    FIDO2Client,
    ctaphidViaWebauthn,
    connect,
    deriveXwing,
    sendEncrypted,
    withSimulatedPresses,
    OKCONNECT,
    DEFAULT_ORIGIN,
};
