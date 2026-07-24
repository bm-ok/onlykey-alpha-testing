// Crypto helpers for the OnlyKey web-app FIDO2 transport, ported from
// onlykey.github.io/src/onlykey-fido2/onlykey/onlykey.extra.js (also
// vendored standalone at github.com/bmatusiak/node-onlykey-fido2 - cloned
// alongside this repo as reference, not depended on directly). Uses the
// real `node-forge`/`tweetnacl` npm packages rather than the browser's
// minified bundles, for byte-exact fidelity with what the reference
// implementation actually does - this is a from-scratch port, not a copy.

const forge = require('node-forge');

function sha256(bytes) {
    const md = forge.md.sha256.create();
    md.update(bytes2string(bytes));
    return Array.from(md.digest().toHex().match(/.{2}/g).map(hexStrToDec));
}

function hexStrToDec(hexStr) {
    return parseInt(hexStr, 16) | 0;
}

function bytes2string(bytes) {
    return Array.from(bytes).map((c) => String.fromCharCode(c)).join('');
}

// Finds the length of a leading printable-ASCII run in `bytes` - used to
// pull an error string out of a fixed-size buffer that's zero-padded (or
// otherwise non-printable) after the text ends.
function getstringlen(bytes) {
    for (let i = 1; i <= bytes.length; i++) {
        if ((bytes[i] > 122 || bytes[i] < 97) && bytes[i] !== 32) return i;
    }
    return bytes.length;
}

function intToByteArray(int) {
    const byteArray = [0, 0, 0, 0];
    for (let index = 0; index < 4; index++) {
        const byte = int & 0xff;
        byteArray[3 - index] = byte;
        int = (int - byte) / 256;
    }
    return byteArray;
}

// The reference implementation's message counter (used to build the AES-GCM
// IV) is a module-scoped variable that's never actually incremented
// anywhere in onlykey.extra.js or onlykey-api.js - every message uses
// counter=0, i.e. a fixed all-zero 12-byte IV. Reproduced exactly as-is
// (not a design choice made here) since interop requires matching the
// device's own expectation byte-for-byte.
const FIXED_COUNTER = 0;

function gcmIv() {
    const iv = intToByteArray(FIXED_COUNTER);
    while (iv.length < 12) iv.push(0);
    return Buffer.from(iv);
}

// AES-256-GCM with tagLength=0 (no authentication tag - matches the
// reference implementation's forge.cipher.createDecipher/createCipher
// calls exactly). Key = SHA256(shared_sec). Returns/accepts plain byte
// arrays (0-255 ints), matching the rest of this protocol's convention.
function aesKeyFrom(sharedSec) {
    return Buffer.from(sha256(sharedSec));
}

function aesgcmDecrypt(encrypted, sharedSec) {
    const key = aesKeyFrom(sharedSec);
    const iv = gcmIv();
    const decipher = forge.cipher.createDecipher('AES-GCM', key.toString('binary'));
    decipher.start({ iv: iv.toString('binary'), tagLength: 0 });
    decipher.update(forge.util.createBuffer(Buffer.from(encrypted).toString('binary')));
    decipher.finish();
    const plaintext = decipher.output.toHex();
    return plaintext.match(/.{2}/g).map(hexStrToDec);
}

function aesgcmEncrypt(plaintext, sharedSec) {
    const key = aesKeyFrom(sharedSec);
    const iv = gcmIv();
    const cipher = forge.cipher.createCipher('AES-GCM', key.toString('binary'));
    cipher.start({ iv: iv.toString('binary'), tagLength: 0 });
    cipher.update(forge.util.createBuffer(Buffer.from(plaintext).toString('binary')));
    cipher.finish();
    const ciphertext = cipher.output.toHex();
    return ciphertext.match(/.{2}/g).map(hexStrToDec);
}

// CTAP2 status codes (fido-alliance CTAP2 spec) - only the ones this
// transport's response handling checks by name are used, the rest are kept
// for readable logging.
const CTAP_ERROR_CODES = {
    0x00: 'CTAP1_SUCCESS',
    0x01: 'CTAP1_ERR_INVALID_COMMAND',
    0x02: 'CTAP1_ERR_INVALID_PARAMETER',
    0x03: 'CTAP1_ERR_INVALID_LENGTH',
    0x04: 'CTAP1_ERR_INVALID_SEQ',
    0x05: 'CTAP1_ERR_TIMEOUT',
    0x06: 'CTAP1_ERR_CHANNEL_BUSY',
    0x0a: 'CTAP1_ERR_LOCK_REQUIRED',
    0x0b: 'CTAP1_ERR_INVALID_CHANNEL',
    0x10: 'CTAP2_ERR_CBOR_PARSING',
    0x11: 'CTAP2_ERR_CBOR_UNEXPECTED_TYPE',
    0x12: 'CTAP2_ERR_INVALID_CBOR',
    0x13: 'CTAP2_ERR_INVALID_CBOR_TYPE',
    0x14: 'CTAP2_ERR_MISSING_PARAMETER',
    0x15: 'CTAP2_ERR_LIMIT_EXCEEDED',
    0x16: 'CTAP2_ERR_UNSUPPORTED_EXTENSION',
    0x17: 'CTAP2_ERR_TOO_MANY_ELEMENTS',
    0x18: 'CTAP2_ERR_EXTENSION_NOT_SUPPORTED',
    0x19: 'CTAP2_ERR_CREDENTIAL_EXCLUDED',
    0x20: 'CTAP2_ERR_CREDENTIAL_NOT_VALID',
    0x21: 'CTAP2_ERR_PROCESSING',
    0x22: 'CTAP2_ERR_INVALID_CREDENTIAL',
    0x23: 'CTAP2_ERR_USER_ACTION_PENDING',
    0x24: 'CTAP2_ERR_OPERATION_PENDING',
    0x25: 'CTAP2_ERR_NO_OPERATIONS',
    0x26: 'CTAP2_ERR_UNSUPPORTED_ALGORITHM',
    0x27: 'CTAP2_ERR_OPERATION_DENIED',
    0x28: 'CTAP2_ERR_KEY_STORE_FULL',
    0x29: 'CTAP2_ERR_NOT_BUSY',
    0x2a: 'CTAP2_ERR_NO_OPERATION_PENDING',
    0x2b: 'CTAP2_ERR_UNSUPPORTED_OPTION',
    0x2c: 'CTAP2_ERR_INVALID_OPTION',
    0x2d: 'CTAP2_ERR_KEEPALIVE_CANCEL',
    0x2e: 'CTAP2_ERR_NO_CREDENTIALS',
    0x2f: 'CTAP2_ERR_USER_ACTION_TIMEOUT',
    0x30: 'CTAP2_ERR_NOT_ALLOWED',
    0x31: 'CTAP2_ERR_PIN_INVALID',
    0x32: 'CTAP2_ERR_PIN_BLOCKED',
    0x33: 'CTAP2_ERR_PIN_AUTH_INVALID',
    0x34: 'CTAP2_ERR_PIN_AUTH_BLOCKED',
    0x35: 'CTAP2_ERR_PIN_NOT_SET',
    0x36: 'CTAP2_ERR_PIN_REQUIRED',
    0x37: 'CTAP2_ERR_PIN_POLICY_VIOLATION',
    0x38: 'CTAP2_ERR_PIN_TOKEN_EXPIRED',
    0x39: 'CTAP2_ERR_REQUEST_TOO_LARGE',
};

module.exports = {
    sha256,
    hexStrToDec,
    bytes2string,
    getstringlen,
    intToByteArray,
    aesgcmDecrypt,
    aesgcmEncrypt,
    CTAP_ERROR_CODES,
};
