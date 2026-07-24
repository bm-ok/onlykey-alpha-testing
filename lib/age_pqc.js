// JS port of python-onlykey's onlykey/age_plugin/derived_xwing.py - the
// browser-side twin of the derived (label-based) X-Wing split-custody math.
//
// Scope: this is deliberately hardware-free, matching test_derived_xwing.py's
// stand-in "_device_derive()" (a fake X25519 key generated locally instead of
// pulled from real hardware). It exists to prove the browser's crypto math
// (ML-KEM seed expansion + the X-Wing combiner) agrees byte-for-byte with the
// CLI's (kyber_py-based) and, ultimately, the firmware's
// (okcrypto_xwing_web_derive(), okcrypto.cpp) - not to talk to a real device.
// Wiring this to the actual device over FIDO2/CTAP2 (mirroring
// onlykey-pgp.js's ctaphid_via_webauthn transport) is separate, later work
// (TC-08-10, TC-17-19).
//
// Wire contract this mirrors (see okcrypto.cpp's okcrypto_xwing_web_derive,
// RESERVED_KEY_WEB_DERIVATION + KEYTYPE_XWING dispatch):
//   DERIVE_PUBLIC_KEY -> [ pk_X(32) | mlkem_seed(32) ]
//   DERIVE_SHAREDSEC  -> [ ss_X(32) | mlkem_seed(32) ]
// The device never returns sk_X or the ML-KEM secret key - only a one-way
// SHA256(sk_X || tag)-derived seed the host expands locally.

const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');
const { shake256, sha3_256 } = require('@noble/hashes/sha3.js');
const { x25519 } = require('@noble/curves/ed25519.js');

const MLKEM_PK = 1184;
const MLKEM_CT = 1088;
const XWING_PK = 1216;
const XWING_CT = 1120;
const SEED = 32;

// draft-connolly-cfrg-xwing-kem-09 combiner label "\.//^\"
const XWING_LABEL = Uint8Array.from([0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c]);

function concatBytes(...arrays) {
    const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

// Expands the 32-byte device-derived seed (SHAKE256 -> 64-byte d||z) into an
// ML-KEM-768 keypair. Matches the firmware (xwing_shake256/keypair_derand)
// and python-onlykey's mlkem_keypair_from_seed() (kyber_py's
// _keygen_internal(d, z)) - @noble/post-quantum's ml_kem768.keygen(seed64)
// splits the same way internally (seed[:32]=d, seed[32:]=z; see
// createKyber() in @noble/post-quantum's ml-kem.ts).
function mlkemKeypairFromSeed(mlkemSeed) {
    if (mlkemSeed.length !== SEED) {
        throw new Error(`mlkem_seed must be ${SEED} bytes, got ${mlkemSeed.length}`);
    }
    const seed64 = shake256(mlkemSeed, { dkLen: 64 });
    return ml_kem768.keygen(seed64); // { publicKey, secretKey }
}

// Builds the 1216-byte X-Wing recipient public key (pk_M || pk_X).
function buildRecipient(pkX, mlkemSeed) {
    if (pkX.length !== 32) {
        throw new Error(`pk_X must be 32 bytes, got ${pkX.length}`);
    }
    const { publicKey: pkM } = mlkemKeypairFromSeed(mlkemSeed);
    return concatBytes(pkM, pkX);
}

// X-Wing Combiner (draft-connolly-cfrg-xwing-kem-09 Section 5.3):
// SHA3-256(ss_M || ss_X || ct_X || pk_X || XWingLabel)
function xwingCombiner(ssM, ssX, ctX, pkX) {
    return sha3_256(concatBytes(ssM, ssX, ctX, pkX, XWING_LABEL));
}

// Finishes X-Wing decapsulation given the device's ss_X and the seed.
// ssX: 32-byte X25519 shared secret from the device (sk_X stays there)
// ciphertext: 1120-byte X-Wing ct (ct_M || ct_X) from the age stanza
// pkX: recipient X25519 public key
// mlkemSeed: 32-byte ML-KEM seed from the device
// Returns the 32-byte X-Wing shared secret. ct_M never leaves the host.
function splitDecapsulate(ssX, ciphertext, pkX, mlkemSeed) {
    if (ssX.length !== 32) throw new Error('ss_X must be 32 bytes');
    if (ciphertext.length !== XWING_CT) {
        throw new Error(`X-Wing ct must be ${XWING_CT} bytes, got ${ciphertext.length}`);
    }
    const ctM = ciphertext.subarray(0, MLKEM_CT);
    const ctX = ciphertext.subarray(MLKEM_CT, XWING_CT);
    const { secretKey: skM } = mlkemKeypairFromSeed(mlkemSeed);
    const ssM = ml_kem768.decapsulate(ctM, skM);
    return xwingCombiner(ssM, ssX, ctX, pkX);
}

// Returns ct_X (the 32 bytes the device needs) from a stanza ciphertext.
function ctXOf(ciphertext) {
    return ciphertext.subarray(MLKEM_CT, XWING_CT);
}

// Standard X-Wing Encapsulation (host/sender side, for encrypt - and for
// testing split decaps against a real encaps). Mirrors xwing.py's
// xwing_encaps_host() exactly.
function xwingEncapsHost(pk) {
    if (pk.length !== XWING_PK) {
        throw new Error(`X-Wing pk must be ${XWING_PK} bytes, got ${pk.length}`);
    }
    const pkM = pk.subarray(0, MLKEM_PK);
    const pkX = pk.subarray(MLKEM_PK, XWING_PK);

    const ekX = x25519.utils.randomSecretKey();
    const ctX = x25519.getPublicKey(ekX);
    const ssX = x25519.getSharedSecret(ekX, pkX);

    const { cipherText: ctM, sharedSecret: ssM } = ml_kem768.encapsulate(pkM);

    const ss = xwingCombiner(ssM, ssX, ctX, pkX);
    const ct = concatBytes(ctM, ctX);
    return { sharedSecret: ss, ciphertext: ct };
}

// ---- derived age identity encoding (label-based, no slot) ----------------
// Mirrors derived_xwing.py's encode_identity/decode_identity exactly
// (unpadded base32, uppercase, "AGE-PLUGIN-ONLYKEY-DERIVED-" prefix).
const DERIVED_PREFIX = 'AGE-PLUGIN-ONLYKEY-DERIVED-';
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }
    return out;
}

function base32Decode(str) {
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of str) {
        const idx = B32_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}

function encodeIdentity(label) {
    if (typeof label !== 'string' || !label) {
        throw new Error('derived identity needs a non-empty label');
    }
    const b32 = base32Encode(Buffer.from(label, 'utf8'));
    return DERIVED_PREFIX + b32.toUpperCase();
}

function decodeIdentity(s) {
    const upper = String(s).trim().toUpperCase();
    if (!upper.startsWith(DERIVED_PREFIX)) return null;
    const b32 = upper.slice(DERIVED_PREFIX.length);
    const label = Buffer.from(base32Decode(b32)).toString('utf8');
    return { derived: true, label };
}

module.exports = {
    mlkemKeypairFromSeed,
    buildRecipient,
    xwingCombiner,
    splitDecapsulate,
    ctXOf,
    xwingEncapsHost,
    encodeIdentity,
    decodeIdentity,
    XWING_LABEL,
    MLKEM_PK,
    MLKEM_CT,
    XWING_PK,
    XWING_CT,
    SEED,
};
