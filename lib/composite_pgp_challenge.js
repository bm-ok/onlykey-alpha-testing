// Challenge-PIN digit computation for composite PGP-PQC decrypt/sign
// (maintainer TC-11) - shared helper for test/17's GUI automation.
//
// Confirmed via direct read of done_process_packets() (okcore.cpp):
// the challenge digits are SHA256(exact accumulated payload bytes sent to
// OKDECRYPT/OKSIGN)[0]/[15]/[31] % 6 + 1 - the same formula
// pqc_decrypt.js's challengeDigitsForCiphertext() already uses for X-Wing
// decaps, just applied to composite's payload shape instead
// ([selector]+digest for sign; the raw X25519 point or ML-KEM ciphertext
// for decrypt - no extra framing bytes, confirmed by reading
// done_process_packets()'s sha256_update(&msg_hash, packet_buffer,
// packet_buffer_offset) call, which hashes the BEFORE-encryption
// accumulated buffer, i.e. exactly what okpqc_sign()/okpqc_decrypt()
// themselves operate on).
//
// There's no firmware debug print of the plain bytes to just read back:
// done_process_packets() computes the hash BEFORE
// okcore_aes_gcm_encrypt() re-encrypts the buffer for transport, and only
// prints AFTER that re-encryption ("Encrypted Buffer" - the same print
// pqc_decrypt.js's PRIMED_RE watches as a "some operation just finished
// accumulating" signal, which this module's callers reuse too, but it
// can't be parsed for the payload itself).

const crypto = require('crypto');

function challengeDigitsForPayload(payloadBytes) {
    const hash = crypto.createHash('sha256').update(Buffer.from(payloadBytes)).digest();
    return [hash[0] % 6 + 1, hash[15] % 6 + 1, hash[31] % 6 + 1].map(String);
}

module.exports = { challengeDigitsForPayload };
