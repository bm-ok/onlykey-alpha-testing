// Encodes/decodes OnlyKey's vendor-command-over-WebAuthn trick: a normal
// CTAP2 authenticatorGetAssertion allowList credential ID is used to smuggle
// an arbitrary (cmd, opt1, opt2, opt3, data) vendor request to the device,
// and the device's "signature" field in the resulting assertion carries the
// response back. This is how browsers talk to OnlyKey's FIDO2 interface
// without a WebHID permission prompt - see onlykey-pgp.js's
// ctaphid_via_webauthn() for the production (browser) counterpart. Ported
// from onlykey.github.io/src/onlykey-fido2/onlykey/onlykey-api.js's
// encode_ctaphid_request_as_keyhandle()/decode_ctaphid_response_from_signature()
// (also github.com/bmatusiak/node-onlykey-fido2, cloned as reference).

const { getstringlen, bytes2string, CTAP_ERROR_CODES } = require('./crypto');

// `is_extension_request` (firmware-side CTAP2 parsing) expects at least 16
// bytes of keyhandle data - short requests are zero-padded up to that.
function encodeCtaphidRequestAsKeyhandle(cmd, opt1, opt2, opt3, data) {
    data = data || new Uint8Array();
    const offset = 10;
    if (offset + data.length > 255) {
        throw new Error('Max size exceeded');
    }
    const dataPad = data.length < 16 ? 16 - data.length : 0;
    const array = new Uint8Array(offset + data.length + dataPad);

    array[0] = cmd & 0xff;
    array[1] = opt1 & 0xff;
    array[2] = opt2 & 0xff;
    array[3] = opt3 & 0xff;
    array[4] = 0x8c; // 140
    array[5] = 0x27; // 39
    array[6] = 0x90; // 144
    array[7] = 0xf6; // 246
    array[8] = 0;
    array[9] = data.length & 0xff;
    array.set(data, offset);

    return array;
}

// `assertion.response` from FIDO2Client's getAssertion(): { authenticatorData,
// signature, ... } - see the FIDO2Client README (fido2.getAssertion() call).
function decodeCtaphidResponseFromSignature(response) {
    const authData = Buffer.from(response.authenticatorData);
    const signatureCount = authData.readUInt32BE(33); // bytes 33..37, big-endian

    const signature = Uint8Array.from(response.signature);
    const errorCode = signature[0];

    let data = null;
    let error = null;
    if (signature.length > 1) data = signature.slice(1, signature.length);

    const status = CTAP_ERROR_CODES[errorCode];
    if (status === 'CTAP1_SUCCESS') {
        // success - data carries the real response payload as-is.
    } else if (data && data.length < 73 && bytes2string(data.slice(0, 6)) === 'Error ') {
        // Device returned a short ASCII "Error ..." message instead of
        // binary data - surface it as the error text.
        const msgtext = data.slice(0, getstringlen(data));
        error = bytes2string(msgtext);
    }

    return {
        count: signatureCount,
        status,
        data,
        error,
        signature,
    };
}

module.exports = {
    encodeCtaphidRequestAsKeyhandle,
    decodeCtaphidResponseFromSignature,
};
