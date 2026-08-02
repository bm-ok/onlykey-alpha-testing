const assert = require('assert');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const { FIDO2Client, connect } = require('../lib/fido2/client');
const { loadOpenpgp } = require('../lib/fido2/openpgp_node');
const {
    compositeSign, HALF_ECC, HALF_PQC, ED25519_SIG_LEN, MLDSA_SIG_LEN,
} = require('../lib/fido2/composite');
const { SeremuChannel } = require('../lib/hid');
const { VENV_BIN } = require('../lib/config');
const { runInConfigMode } = require('../lib/config_mode');
const { ensureUnlocked, setStoredKeyChallengeMode } = require('../lib/gui_helpers');

const compositePgp = require('../../onlykey.github.io/src/onlykey-fido2/onlykey/composite_pgp.js');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const nacl = require('tweetnacl');

// NODE-FIRST counterpart to test/17's GUI composite PGP-PQC run (TC-11).
//
// The 9x band is for Node-first specs that pair with a GUI sibling. Build and
// prove a FIDO2 device path HERE first, then confirm the same behaviour in the
// web app under nwjs. Node drives the identical firmware over lib/fido2/ with
// no browser, no page handshake and no webpack bundle in the way, so a failure
// names one variable; the GUI run takes ~55s to say less.
//
// They also cross-check each other. A fault visible in BOTH is firmware; a
// fault only nwjs shows is the page. Confirmed useful on 2026-08-01: a
// composite-sign regression read as a "browser transit-key mismatch" through
// nwjs, and under Node was plainly BOTH halves failing - including the 64-byte
// Ed25519 one, which is far below any buffer limit and so ruled out the
// response-staging theory the GUI runs had pointed at.
//
// Ordered cheapest-discriminator-first, so an early failure spares the rest:
//   OKCONNECT        -> do host and device agree on a transit key at all?
//   Ed25519   (64 B) -> does the composite path work below the staging limit?
//   ML-DSA-65 (3309) -> the large-response path, retrieved in chunks.
const SLOT = 1;

function runCli(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(path.join(VENV_BIN, 'onlykey-cli'), args, { timeout: timeoutMs },
            (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
}

const hex = (b) => Buffer.from(b).toString('hex');

describe('Composite PGP-PQC over Node FIDO2 (TC-11, node-first)', function () {
    // No spec-level override. .mocharc.one.json's 120s cap is the backstop and
    // every device wait inside honours the 30s no-response rule, so if mocha's
    // timeout ever fires, something is waiting without a response check - that
    // is the bug to fix, not the number to raise.
    //
    // A 240s override here also let a run outlive the shell timeout wrapping
    // it, so the wrapper killed mocha mid-run and threw away every result.

    let fido2;
    let blob;
    // Fixed digest: the button challenge is SHA256 over the exact payload, so a
    // constant one makes a failure reproducible rather than a fresh puzzle.
    const digest = Buffer.alloc(32, 0xAB);
    let conn;
    let channel;

    before(async function () {
        await ensureUnlocked();
        // Force the full 3-digit challenge for stored (RSA-slot) keys - with a
        // non-zero mode the firmware never computes Challenge_button1/2/3 and
        // every confirmation fails against a stale single-button value.
        await setStoredKeyChallengeMode(0);

        // Loading a key is a FIXTURE, not part of any test. Doing it in this
        // hook costs two device restarts plus a CPU-bound ML-DSA keygen that
        // BLOCKS the event loop - so mocha's own timeout could not fire and a
        // single-case run sat past every cap with nothing to report.
        //
        // Seed once with TC11_LOAD_KEY=1; every run after that starts in
        // seconds against the already-loaded slot.
        const cachePath = require('path').join(__dirname, '..', '.tc11-blob-cache.hex');
        if (process.env.TC11_LOAD_KEY !== '1') {
            if (!fs.existsSync(cachePath)) {
                throw new Error('no composite key loaded - seed once with: '
                    + 'TC11_LOAD_KEY=1 npx mocha --config .mocharc.one.json test/17-nodejs-composite-pgp.test.js');
            }
            blob = Buffer.from(fs.readFileSync(cachePath, 'utf8').trim(), 'hex');
            assert.strictEqual(blob.length, 160, 'cached blob is not 160 bytes');
            fido2 = new FIDO2Client(false);
            conn = await connect(fido2);
            channel = new SeremuChannel();
            await channel.connect();
            return;
        }

        const openpgp = loadOpenpgp();
        const gen = await compositePgp.generateCompositeKey(openpgp, {
            userId: { name: 'TC11 node', email: 'tc11@example.com' },
        });
        blob = gen.blob;
        assert.strictEqual(blob.length, 160, `expected a 160-byte blob, got ${blob.length}`);

        // OKSETPRIV only writes in config mode; outside it the CLI still prints
        // a locally-generated success (see test/17's note).
        const load = await runInConfigMode(() => runCli(['setpqc', `RSA${SLOT}`, hex(blob)]));
        assert.strictEqual(load.code, 0, `setpqc failed:\n${load.stdout}\n${load.stderr}`);
        assert.match(load.stdout, /Loaded composite PQC PGP key/, `unexpected setpqc output: ${load.stdout}`);
        fs.writeFileSync(cachePath, hex(blob));

        // Connect HERE, not in the first it(). Tests that depend on a previous
        // test's variables cannot be run alone, and running one test alone is
        // the whole point of a fail-fast suite - `--grep` on any single case
        // died with "cannot read properties of undefined" until this moved.
        fido2 = new FIDO2Client(false);
        conn = await connect(fido2);
        channel = new SeremuChannel();
        await channel.connect();
    });

    after(function () {
        if (channel) { try { channel.close(); } catch (e) { /* already gone */ } }
    });

    it('establishes a transit key over OKCONNECT', async function () {
        // A decodable status string is proof the host and device agree on the
        // transit key - the response is encrypted with it.
        assert.match(conn.status, /UNLOCKED/, `unexpected OKCONNECT status: ${conn.status}`);
        assert.ok(conn.sharedSecret && conn.sharedSecret.length === 32,
            `expected a 32-byte shared secret, got ${conn.sharedSecret && conn.sharedSecret.length}`);
    });

    // Fetched as the FIRST composite operation, alone. Every previous
    // comparison of this key was taken after other operations had run, so a
    // mismatch could not be told apart from stale response state - which has
    // already faked one result today (a "seed" readback that returned the
    // previous response's bytes).
    it('derives the same ML-DSA public key as the host, from the same seed', async function () {
        const devPk = Buffer.from(
            await compositeSign(fido2, channel, conn.sharedSecret, SLOT, 2, digest));
        const { mldsaSeed } = compositePgp.unpackBlob(blob);
        // The device returns rho (pk[0:32]) only - the whole 1952-byte key
        // cannot cross store_FIDO_response()'s 1024-byte staging limit.
        const hostPk = Buffer.from(ml_dsa65.keygen(Uint8Array.from(mldsaSeed)).publicKey).slice(0, 32);
        console.log(`    [rho] host ${hostPk.toString('hex')}`);
        console.log(`    [rho] dev  ${devPk.toString('hex')}`);
        assert.ok(devPk.equals(hostPk),
            'device derives a DIFFERENT ML-DSA-65 public key from the same stored seed');
    });

    // The control for "first op right, later ops wrong": the SAME operation,
    // twice, with identical input. ML-DSA randomises signatures but Ed25519 is
    // deterministic, so two correct runs must be byte-identical - any
    // difference is state leaking between operations, not crypto.
    it('signs Ed25519 TWICE and both verify identically', async function () {
        const { ed25519Sk } = compositePgp.unpackBlob(blob);
        const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(ed25519Sk));
        const sigs = [];
        for (const attempt of [1, 2]) {
            const sig = await compositeSign(fido2, channel, conn.sharedSecret, SLOT, HALF_ECC, digest);
            const ok = nacl.sign.detached.verify(
                Uint8Array.from(digest), Uint8Array.from(sig), kp.publicKey);
            console.log(`    [ed25519 #${attempt}] ${Buffer.from(sig).slice(0, 16).toString('hex')}... verifies=${ok}`);
            sigs.push({ sig: Buffer.from(sig), ok });
        }
        assert.ok(sigs[0].ok, 'first Ed25519 signature did not verify');
        assert.ok(sigs[1].ok, 'SECOND Ed25519 signature did not verify - the first did, so device '
            + 'state is leaking between composite operations');
        assert.ok(sigs[0].sig.equals(sigs[1].sig), 'two Ed25519 signatures over the same digest differ');
    });

    // FIRST composite operation of the run, deliberately. Every other one runs
    // an ML-DSA keygen first, and a readback taken after those returned bytes
    // that tracked the derived public key rather than the stored seed - so this
    // has to happen before any of them to mean anything.
    it('reports the stored ML-DSA seed, and it matches the blob', async function () {
        const devSeed = await compositeSign(fido2, channel, conn.sharedSecret, SLOT, 3, digest);
        const hostSeed = Buffer.from(compositePgp.unpackBlob(blob).mldsaSeed);
        console.log(`    [seed] host ${hostSeed.toString('hex')}`);
        console.log(`    [seed] dev  ${Buffer.from(devSeed).toString('hex')}`);
        assert.ok(Buffer.from(devSeed).equals(hostSeed),
            'device STORED a different ML-DSA seed than the blob carries - the fault is in '
            + 'loading/storage, not in key derivation');
    });

    it('signs the Ed25519 half (64 B, below the response-staging limit)', async function () {
        const sig = await compositeSign(fido2, channel, conn.sharedSecret, SLOT, HALF_ECC, digest);
        assert.strictEqual(sig.length, ED25519_SIG_LEN,
            `expected ${ED25519_SIG_LEN} bytes, got ${sig.length}`);

        // Verify, not just measure. This half is the control for the ML-DSA
        // one: it proves the blob reached the right slot, that the device reads
        // the correct field out of it, and that the challenge/transport round
        // trip is sound - so a failure in the ML-DSA half afterwards cannot be
        // blamed on any of those.
        const { ed25519Sk } = compositePgp.unpackBlob(blob);
        const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(ed25519Sk));
        const valid = nacl.sign.detached.verify(
            Uint8Array.from(digest), Uint8Array.from(sig), kp.publicKey);
        assert.ok(valid, 'Ed25519 signature did not verify against the key derived from the blob seed');
    });

    it('signs the ML-DSA-65 half (3309 B, retrieved in chunks)', async function () {
        channel.clearBuffer();
        try {
            const sig = await compositeSign(fido2, channel, conn.sharedSecret, SLOT, HALF_PQC, digest);
            assert.strictEqual(sig.length, MLDSA_SIG_LEN,
                `expected ${MLDSA_SIG_LEN} bytes, got ${sig.length}`);

            // Length only proves the transport delivered 3309 bytes. Verify
            // them, independently of openpgp.js: derive the public key from the
            // SAME seed the blob carries (@noble's keygen(seed) is FIPS 204
            // KeyGen_internal, which is what okpqc.cpp calls), then check the
            // signature over the raw digest with an empty context - matching
            // the firmware's signature(..., ctx=NULL, ctxlen=0, ...).
            const { mldsaSeed } = compositePgp.unpackBlob(blob);
            const { publicKey } = ml_dsa65.keygen(Uint8Array.from(mldsaSeed));
            // Two candidate framings, checked against the SAME signature so one
            // device round trip settles it. FIPS 204's external API prepends
            // 0x00 || ctxlen(0) to the message; the internal API signs the
            // message representative directly. okpqc.cpp calls
            // signature(..., ctx=NULL, ctxlen=0, ...), and which of these that
            // corresponds to in mldsa_native is exactly what is in doubt.
            const S = Uint8Array.from(sig);
            const M = Uint8Array.from(digest);
            const results = {
                external: ml_dsa65.verify(S, M, publicKey),
                internal: ml_dsa65.internal.verify(S, M, publicKey),
                external_prefixed: ml_dsa65.verify(S, Uint8Array.from([0, 0, ...digest]), publicKey),
                internal_prefixed: ml_dsa65.internal.verify(S, Uint8Array.from([0, 0, ...digest]), publicKey),
            };
            console.log('    [verify]', JSON.stringify(results));

            // The device now prints the seed it read and the head of the key it
            // derived. Comparing both against the host's own derivation says
            // which side diverges - key material or the signing step - instead
            // of leaving "it does not verify" as the whole diagnosis.
            const grab = (label) => {
                const i = channel.buffer.lastIndexOf(label);
                if (i === -1) return null;
                const m = channel.buffer.slice(i + label.length).match(/^[\s]*((?:[0-9A-Fa-f]{1,2}[ \r\n]+)+)/);
                if (!m) return null;
                return Buffer.from(m[1].trim().split(/\s+/).map((h) => parseInt(h, 16)));
            };
            // Selector 2 returns the ML-DSA public key the DEVICE derives from
            // its stored seed, over the same chunked response path as the
            // signature. Comparing it with the host's own derivation splits
            // "does not verify" into wrong-key-material vs wrong-message -
            // which the DEBUG channel could not answer, since ML-DSA keygen
            // floods it and the prints are dropped (QUIRKS.md).
            // Seed and public-key readbacks live in their own tests now -
            // both confirmed byte-identical to the host. What is left to
            // settle here is the SIGNATURE itself.
            assert.ok(Object.values(results).some(Boolean),
                `ML-DSA-65 signature verified under NO framing: ${JSON.stringify(results)}`);
        } catch (e) {
            // The device's own account of what it staged and served. Without
            // this the only evidence is a host-side byte count, which says a
            // retrieval stopped short but not where or why.
            const dump = require('path').join(require('os').tmpdir(), 'tc11-node-mldsa-trace.log');
            try { require('fs').writeFileSync(dump, channel.buffer); e.message += `\n  full device trace: ${dump}`; }
            catch (x) { /* diagnostics must never replace the real error */ }
            const marks = (channel.buffer.match(/Stored Data for FIDO Response|Sending transport response data|Error [^\n]*/g) || []);
            e.message += `\n  device markers: ${JSON.stringify(marks.slice(0, 8))}`;
            throw e;
        }
    });
});
