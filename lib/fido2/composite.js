// Composite PGP-PQC device transport (maintainer TC-11), in Node.
//
// This is the layer that was missing. onlykey.github.io's composite_pgp.js
// registers openpgp.js hardware hooks that call `ok.composite_sign(slot,
// half, hashed)` and `ok.composite_decrypt(slot, data)`, and its comment says
// those live in onlykey-3rd-party.js - but no definition of either exists
// anywhere in that repo. Only `api.derive_public_key` and
// `api.derive_shared_secret` are implemented there, so the signing hook could
// only ever have thrown. Building it here first means it can be proven
// against hardware before being ported into the browser lib.
//
// Protocol, read from firmware rather than inferred:
//
//   * The keyhandle carries (cmd, opt1, opt2, opt3, data). ok_extension.cpp
//     (~395-425) sets recv_buffer[5] = opt1 = **slot**, and splits `data`
//     into 57-byte chunks itself - the host sends the whole payload in ONE
//     request. recv_buffer[6] is 0xFF for "more coming"; when opt2 is set and
//     the remaining length fits one chunk it becomes that length, marking the
//     final packet. So opt2 must be truthy or the device never sees an end.
//
//   * okcrypto_sign() (okcrypto.cpp:178) routes on buffer[5]: slots 1-4 are
//     RSA slots, and a key whose type is KEYTYPE_PQC_PGP dispatches to
//     okpqc_sign(). Composite keys therefore live in slots 1-4.
//
//   * okpqc_sign() (okpqc.cpp:92) reads the accumulated buffer as
//     [0] = component selector, [1..] = message digest. Selector 0
//     (PQC_HALF_ECC) signs Ed25519 and returns 64 bytes; selector 1
//     (PQC_HALF_PQC) signs ML-DSA-65 and returns 3309 bytes.
//
//   * Both halves are gated on CRYPTO_AUTH == 4, i.e. the 3-digit button
//     challenge must be answered first. The digits are
//     SHA256(payload)[0]/[15]/[31] % 6 + 1 over the exact payload bytes
//     ([selector] || digest) - see composite_pgp_challenge.js, and
//     done_process_packets() (okcore.cpp:7332), which hashes the buffer
//     BEFORE re-encrypting it for transport.
//
//   * The result is retrieved by a follow-up request: every pass through the
//     bridge ends in send_stored_response(), so a cheap OKPING polls for it.
//
// Origin note: the OKSIGN/OKDECRYPT branch sits behind webcryptcheck() > 1.
// On a DEBUG build - which is any build this harness can drive, since SEREMU
// is DEBUG-only - webcryptcheck() returns 2 unconditionally ("Trust all
// origins for debug firmware", device.cpp:83), so the origin does not gate
// this path here. onlyagent.app is used anyway because production builds
// allowlist it explicitly (stored_appid_oa = SHA256("onlyagent.app")).

const { ctaphidViaWebauthn, DEFAULT_ORIGIN } = require('./client');
const { aesgcmEncrypt } = require('./crypto');
const { challengeDigitsForPayload } = require('../composite_pgp_challenge');
const { sleep } = require('../hid');

const OKSIGN = 237; // TYPE_INIT(0x80) | 0x6D
const OKDECRYPT = 240; // TYPE_INIT(0x80) | 0x70
const OKPING = 243; // TYPE_INIT(0x80) | 0x73

const HALF_ECC = 0; // Ed25519 / X25519
const HALF_PQC = 1; // ML-DSA-65 / ML-KEM-768

const ED25519_SIG_LEN = 64;
const MLDSA_SIG_LEN = 3309;

const SHORT_PRESS = 10;

// Vendor payloads on this branch are decrypted in place by the firmware
// before use - ok_extension.cpp calls okcrypto_aes_crypto_box(client_handle,
// handle_len, true) the moment it enters the protected-mode branch. Sending
// plaintext therefore does not "just work with an extra step": the device
// decrypts it into garbage, accumulates that, and the challenge is computed
// over bytes the host has never seen. Confirmed live by tracing both prints -
// the "Keyhandle:" dump matched the plaintext exactly, and the OKSIGN chunk
// that followed it did not.
function encryptPayload(payload, sharedSecret) {
    return Uint8Array.from(aesgcmEncrypt(Array.from(payload), sharedSecret));
}

// The firmware reports status and failures as plain ASCII via hidprint()
// ("Error not in config mode", "Error incorrect challenge was entered", ...),
// and those arrive through the SAME response path as real data. So a response
// has to be classified, not just measured: returns the text if the payload is
// entirely printable ASCII, otherwise null (i.e. real binary output).
//
// Safe to decide this way because a genuine signature being all-printable is
// not a practical possibility - (95/256)^64 for the Ed25519 half, and far
// smaller still for the 3309-byte ML-DSA one.
function asDeviceMessage(data) {
    if (!data || !data.length) return null;
    const text = Buffer.from(data).toString('latin1').replace(/\0+$/, '');
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

function describeShortResponse(data) {
    if (!data || !data.length) return '';
    const msg = asDeviceMessage(data);
    if (msg) return ` - device said: "${msg}"`;
    return ` - first bytes: ${Buffer.from(data).slice(0, 24).toString('hex')}`;
}

// Sends the three challenge digits the device is waiting on. Spaced, because
// the firmware handles a press inline in loop() and drops rather than queues
// presses that arrive while it is busy (QUIRKS.md).
async function answerChallenge(channel, digits, { pressDelayMs = 700 } = {}) {
    for (const d of digits) {
        channel.send([d.charCodeAt(0), SHORT_PRESS]);
        await sleep(pressDelayMs);
    }
}

// Polls for a stored response. Each bridge request ends in
// send_stored_response(), so an OKPING is the cheapest way to ask "is it ready
// yet" without re-triggering the operation.
//
// A non-empty reply is NOT the same as a result. OKPING's own branch answers
// `hidprint("Error incorrect challenge was entered")` whenever it finds
// neither a pending challenge nor a stored response - which is exactly the
// state during the window between the last challenge digit being consumed and
// the signature being computed and stored. Returning on the first non-empty
// reply therefore hands back that error string as though it were the answer,
// while the device goes on to produce the real signature moments later.
// Confirmed live: the trace shows this message, then `Sending transport
// response data` with the actual result right after it.
//
// So: keep polling through printable status text, return only on binary data,
// and if the deadline expires report the last message the device gave - which
// is what a genuine wrong-challenge failure looks like.
// A response larger than one WebAuthn assertion can carry is served across
// several polls: send_stored_response() (ok_extension.cpp) walks
// large_resp_buffer with a cursor and hands back one chunk at a time. So the
// host has to REASSEMBLE, not just take the first binary reply - a 3309-byte
// ML-DSA-65 signature arrives in ~47 pieces. `expected` is what tells us when
// we are done; the device gives no end-of-response marker.
//
// Duplicate suppression device-side keys off opt3, and this always sends 0:
// `large_resp_buffer_last_opt3 && opt3 <= last` is therefore always falsy, so
// every poll advances the cursor exactly once. Do not send a varying opt3
// here without re-reading that logic.
async function pollForResponse(fido2, {
    origin,
    timeoutMs,
    expected,
    maxMs = 30000,
    pollMs = 150,
    initialDelayMs = 800,
} = {}) {
    const deadline = Date.now() + maxMs;
    const parts = [];
    let total = 0;
    let lastMessage = null;
    let last = null;

    await sleep(initialDelayMs);
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const resp = await ctaphidViaWebauthn(fido2, origin, OKPING, 0, 0, 0, new Uint8Array(), timeoutMs);
        last = resp;
        if (resp && resp.data && resp.data.length) {
            const msg = asDeviceMessage(resp.data);
            if (msg) {
                // Status text. Before any data it means "still working"; once
                // chunks have started it means the buffer is gone (wiped or
                // exhausted) and the response will never complete.
                if (total > 0) break;
                lastMessage = msg;
            } else {
                parts.push(Buffer.from(resp.data));
                total += resp.data.length;
                if (!expected || total >= expected) {
                    return { ...resp, data: Buffer.concat(parts).slice(0, expected || total) };
                }
                continue; // more to collect - poll again immediately
            }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMs);
    }
    if (total > 0) {
        throw new Error(
            `Incomplete composite response: got ${total} of ${expected} bytes in ${parts.length} chunk(s)` +
            (lastMessage ? ` - last device message: "${lastMessage}"` : '')
        );
    }
    throw new Error(
        `No composite response within ${maxMs}ms` +
        (lastMessage ? ` - last device message: "${lastMessage}"` : ` (last status: ${last && last.status})`)
    );
}

// One half of a composite signature.
//
// `half` is HALF_ECC or HALF_PQC; `digest` is passed to the device UNCHANGED -
// the ML-DSA half's FIPS 204 empty-context framing is applied firmware-side by
// okpqc.cpp/mldsa_native, not here.
//
// The two halves must be run SEQUENTIALLY, never concurrently: they share
// firmware state (CRYPTO_AUTH, packet_buffer_details, large_resp_buffer), so
// overlapping them corrupts one or both. That also means a composite signature
// needs the button challenge answered TWICE - a real device property, not a
// harness limitation.
async function compositeSign(fido2, channel, sharedSecret, slot, half, digest, {
    origin = DEFAULT_ORIGIN,
    timeoutMs = 10000,
    maxMs = 30000,
} = {}) {
    const payload = Buffer.concat([Buffer.from([half]), Buffer.from(digest)]);
    // Digits are computed over the PLAINTEXT payload: the device hashes
    // packet_buffer, which holds the already-decrypted bytes.
    const digits = challengeDigitsForPayload(payload);

    // opt2 = 1 marks the final chunk; without it the device keeps waiting for
    // more and never primes the challenge.
    const primed = await ctaphidViaWebauthn(
        fido2, origin, OKSIGN, slot, 1, 0, encryptPayload(payload, sharedSecret), timeoutMs
    );

    await answerChallenge(channel, digits);
    const expected = half === HALF_ECC ? ED25519_SIG_LEN : MLDSA_SIG_LEN;
    const resp = await pollForResponse(fido2, { origin, timeoutMs, maxMs, expected });
    if (!resp.data || resp.data.length !== expected) {
        throw new Error(
            `composite_sign(half=${half}): expected ${expected} bytes, got ${resp.data ? resp.data.length : 0}` +
            ` (priming status ${primed && primed.status}, poll status ${resp.status})` +
            `${describeShortResponse(resp.data)}`
        );
    }
    return Buffer.from(resp.data);
}

// The device half of composite decryption. okpqc_decrypt() infers which half
// is being asked for purely from the input size - 32 bytes is the X25519
// ephemeral point, 1088 bytes is the ML-KEM-768 ciphertext - so no selector
// byte is sent, unlike signing.
async function compositeDecrypt(fido2, channel, sharedSecret, slot, data, {
    origin = DEFAULT_ORIGIN,
    timeoutMs = 10000,
    maxMs = 30000,
} = {}) {
    const payload = Buffer.from(data);
    const digits = challengeDigitsForPayload(payload);

    const primed = await ctaphidViaWebauthn(
        fido2, origin, OKDECRYPT, slot, 1, 0, encryptPayload(payload, sharedSecret), timeoutMs
    );

    await answerChallenge(channel, digits);
    const resp = await pollForResponse(fido2, { origin, timeoutMs, maxMs });

    if (!resp.data || !resp.data.length) {
        throw new Error(
            `composite_decrypt: no shared secret returned (priming status ${primed && primed.status})`
        );
    }
    return Buffer.from(resp.data);
}

// Builds the `ok`-shaped object composite_pgp.js's registerCompositeHooks()
// expects, bound to a connected FIDO2 client and SEREMU channel.
function makeCompositeApi(fido2, channel, sharedSecret, opts = {}) {
    return {
        composite_sign: (slot, half, hashed) =>
            compositeSign(fido2, channel, sharedSecret, slot, half, hashed, opts),
        composite_decrypt: (slot, data) =>
            compositeDecrypt(fido2, channel, sharedSecret, slot, data, opts),
    };
}

module.exports = {
    compositeSign,
    compositeDecrypt,
    makeCompositeApi,
    answerChallenge,
    pollForResponse,
    OKSIGN,
    OKDECRYPT,
    OKPING,
    HALF_ECC,
    HALF_PQC,
    ED25519_SIG_LEN,
    MLDSA_SIG_LEN,
};
