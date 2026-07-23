# OnlyKey PQC — Test Report

**Build under test (0c-coder fork masters):**

| Component | Repo | master SHA |
|---|---|---|
| Firmware libs | 0c-coder/libraries | `7453297` |
| CLI / age | 0c-coder/python-onlykey | `68c1c84` |
| Agent | 0c-coder/lib-agent | `8785fc8` |
| Web app | 0c-coder/onlykey.github.io | `6edad87` |

**Tester:** ________________  **Date:** __________  **Host OS:** __________
**OnlyKey model / firmware target:** __________  **Compiler/Teensyduino:** __________
**age version:** __________  **Python:** __________  **Node:** __________

---

## 1. Summary of what is ALREADY verified (software only, pre-handoff)

These passed in software during development; the tester is validating the
**hardware / build / end-to-end** half that could not be checked without a device.

| Area | Verified in software | How |
|---|---|---|
| Derived X-Wing crypto (web app) | ✅ split decaps == standard encaps; domain separation; determinism; "no device ⇒ no decrypt" | `onlykey.github.io` `npm run test:pqc` (5/5, `@noble/post-quantum`) |
| CLI age host protocol | ✅ slot/keytype wire framing, `OKSETPRIV` keygen, multi-packet decaps, reserved-slot rejection | `python-onlykey` `tests/test_age_wire.py`, `tests/test_age_pq.py` |
| CLI age KEM/HPKE | ✅ ML-KEM/X-Wing + HPKE seal/open roundtrip, spec constants | `python-onlykey/tests/test_age_pq.py` |
| Firmware merge integrity | ✅ clean merge, no duplicate `#define`/function symbols | git 3-way merge inspection |
| Packaging | ✅ `onlykey` 1.2.11 / `onlykey-agent` 1.1.16 sdists build, `twine check` PASS | local build |

## 2. What has NOT been verified (this is the job)

- **Firmware has never been compiled or flashed.** TC-01 is the first real build.
- **No PQC operation has run on hardware** — keygen, decap, sign, derive.
- **Web app derived-X-Wing is not end-to-end** — device protocol + crypto exist, but the browser age *container* framing (`age-pqc.js`) is a TODO.
- **Composite PGP-PQC end-to-end** (gen → `setpqc` load → web app encrypt/decrypt/sign) has never run against a device.
- **Cross-implementation interop** (e.g. a stock `age`/`rage` binary decrypting, or GnuPG interop for PGP-PQC) is unverified.
- **CLI derived (label-based) X-Wing has never run on hardware.** The host crypto + identity encoding are software-verified (`tests/test_derived_xwing.py` 5/5), but the **HID derive transport** (`derive_recipient`/`derive_decaps`) and the **firmware HID derive branch** (`okcrypto_xwing_web_derive`) are UNTESTED. The decaps 64-byte input framing is expected to need a fix (TC-17/18/19).
- **CLI↔web-app derived interop** (TC-18/19, the headline feature) depends on three conventions matching exactly across both tools: RPID `onlyagent.app`, tag = `SHA256(label)`, and identical ML-KEM seed expansion. Unverified end-to-end.

## 3. Results matrix (fill in)

| TC | Title | Result (PASS/FAIL/BLOCKED) | Notes / evidence |
|----|-------|---------------------------|------------------|
| 01 | Firmware builds | PASS | Compiles clean via `make docker-build-local`. |
| 02 | Flash + boot | PASS | Device enumerates (`lsusb`: `1d50:60fc OnlyKey`). |
| 03 | Init encrypted profile | PASS | Automated end-to-end (`onlykey-testing` SETUP-03/04): fresh device UNINITIALIZED → primary/secondary/self-destruct PIN set via host-message flow → reboot → unlocked. No physical button presses. |
| 04 | Generate X-Wing age identity | PASS (after fixes), reliable across 5 consecutive combined-suite runs | `age-plugin-onlykey --generate` produces a valid `AGE-PLUGIN-ONLYKEY-1...` identity + `age1onlykey1...` recipient, fully automated (`onlykey-testing/lib/pqc_keygen.js`), against `python-onlykey` (the correct fork - cloned directly as such by `project-setup.sh` after a full workspace reset on 2026-07-23; no separate stale/correct clone split anymore). Two real firmware bugs fixed: (1) keygen's `CRYPTO_AUTH` confirmation gate was unreachable, (2) both keygen functions derived the returned public key from AES-GCM ciphertext instead of the plaintext seed. Three real harness-timing races, root-caused via live DEBUG-serial tracing after the reset exposed them running the full suite together: CRYPTO_AUTH-priming presses could arrive while the device was still synchronously blocking on priming and get silently dropped; the config-mode long-press's `!isfade` requirement needed a real margin, not the 500ms-1s originally assumed; and unlock confirmation itself couldn't reliably rely on the verbose DEBUG-serial channel at all (it drops output under load - confirmed even in an isolated, deliberate single attempt), so that switched to polling `checkStatus()` over the separate main HID protocol instead. One `python-onlykey` bug fixed and committed there directly: `onlykey_hid.py`'s `_read_response()` was bailing out early on any transient read exception once it had partial data, truncating multi-packet responses. One residual, unfixed firmware/USB-level issue: the device occasionally drops 1-3 of the pubkey's 19 HID reports outright even with client-side retrying exhausted - mitigated (not fixed) by retrying the whole keygen sequence at the test level. Full detail in `onlykey-testing/TEST-PLAN.md`'s TC-04 entry. |
| 05 | Age encrypt/decrypt roundtrip | PASS | `age -r` (host) → `age -d` (device decrypt, 3-button confirm) round-trips real data correctly, verified byte-identical across multiple runs. Getting here found and fixed the most significant bug of this whole effort: `process_packets()`'s last-packet bounds check (`okcore.cpp`) was simply wrong — it rejected the final chunk of *any* X-Wing/ML-KEM decapsulation 100% of the time, deterministically, regardless of timing (`PACKET_BUFFER_SIZE`=1120 exactly equals the ciphertext size but isn't a multiple of the 57-byte chunk size, so the running offset always overshoots the reused threshold by the time the last chunk arrives). PQC decrypt could not have worked before this fix, independent of every transport/timing issue found alongside it. Also fixed: a second, receive-side USB packet-loss bug (redundant per-packet flash decrypt in `okcrypto_decrypt()`'s dispatcher — mirror image of TC-04's send-side one), a real regression in `python-onlykey`'s error handling (introduced fixing an earlier bug the same day) that was swallowing legitimate device error messages, and a harness verification blind spot (config-mode entry looked "confirmed" via a check that couldn't actually distinguish success from silent failure). Full detail in `TEST-PLAN.md`'s TC-05 entry (findings #13-16). |
| 06 | Slot select + reserved reject | PASS | `test/02-pqc-slot.test.js`: reserved slot 117 and out-of-range slot 200 rejected instantly, no device interaction; real key generated successfully in a non-default slot (103). All confirmed live, including as part of the full combined-suite run (`00-setup` → TC-04 → TC-06 → TC-05, 7/7 passing). |
| 07 | Age negative (no device) | ▢ | |
| 08 | Web app build + `test:pqc` | ▢ | |
| 09 | Derived X-Wing browser roundtrip | ▢ | (may be BLOCKED on container TODO) |
| 10 | Device derive protocol (low-level) | ▢ | |
| 11 | PGP-PQC gen→load→encrypt/decrypt/sign | ▢ | |
| 12 | `hidraw` transport (#89) | ▢ | Linux |
| 13 | Reserved-slot guard: backup/HMAC/SSH/GPG intact | ▢ | |
| 14 | Packaging versions/description | ▢ | |
| 15 | Non-PQ regression (PIN/U2F/RSA/ECC) | ▢ | |
| 16 | Derived identity + recipient (CLI) | ▢ | recipient path — high confidence |
| 17 | Derived encrypt→decrypt roundtrip (CLI) | ▢ | decrypt = 64B framing, likely first fail |
| 18 | ★ Interop: encrypt CLI → decrypt web app | ▢ | headline feature; needs RPID + tag match |
| 19 | Reverse interop: encrypt web app → decrypt CLI | ▢ | |

**Totals:** Pass ▢  Fail ▢  Blocked ▢  Not run ▢

## 4. Risk register / watch-items (likely failure points)

1. **Compile errors (TC-01)** — highest risk. The X-Wing base and my `ok_extension.cpp` derive block merged cleanly *textually*, but were never compiled. Watch for: undefined `SHA256_CTX`/`sha256_*` in `ok_extension.cpp` scope, `device_set_status`/`ctap_user_presence_test` availability there, response-buffer sizing (`32 + sizeof(UNLOCKED) + 1 + 64`), and any duplicate/again-declared PQ symbols where the composite-PGP and X-Wing code meet in `okcrypto.cpp`/`okcore.h`.
2. **Keytype wire encoding** — the FIDO2 derive uses wire keytype **5** → `KEYTYPE_XWING(6)` after firmware `opt2++`. If the web app and firmware disagree here, derive returns the wrong key type. Verify in TC-10.
3. **Encrypted-profile requirement** — keygen/decrypt silently no-op on a non-encrypted profile. If TC-04/05 "do nothing," check the profile.
4. **Transit-key path for the 64-byte derive response** — the derive reply is `ENCRYPT_RESP` (wrapped in the OKCONNECT transit key). Confirm the web app decrypts it correctly (TC-10).
5. **Windows FIDO2 duplicate requests** — the classical derive path had `os=='W'` dedupe; the X-Wing derive branch does **not** replicate it. Test derived X-Wing on Windows separately if that's a target.
6. **age plugin discovery** — `age` must find `age-plugin-onlykey` on `PATH`; a distro `age` without plugin support will fail TC-05.
7. **Web app age container** — TC-09 may be BLOCKED until `age-pqc.js` container framing is finished; TC-10 still validates the device path.
8. **Derived decaps 64-byte HID framing (TC-17/18/19)** — `tag(32)||ct_X(32)` exceeds one report; CLI streams via `send_large_message2`, but that puts a length byte where the firmware branch reads the keytype (`buffer[6]`). **Most likely first hardware failure on the derived path.** Derived *recipient* (TC-16) is single-report and should pass.
9. **Derived interop conventions (TC-18/19)** — RPID must be `onlyagent.app` on both sides; the label tag must be `SHA256(utf8(label))` on both sides; ML-KEM seed expansion (`SHAKE256(seed,64)`) must be byte-identical on firmware, CLI (kyber-py), and web (@noble). Any one mismatch = silent wrong-key decrypt failure.

## 5. Sign-off

- [ ] All PASS, or failures triaged with issues filed (repo + SHA + command + output).
- [ ] Firmware build artifact (`.hex`) archived with compiler version.
- [ ] Go / No-go for promoting from `0c-coder` test masters: ______________

**Notes:**

TC-01/02/03/04 completed via an automated Mocha harness (new repo,
`onlykey-testing`, not part of the four repos in the header table) that
drives the physical device over its DEBUG-serial button-injection channel
— no human button presses for any of these. Firmware fixes for TC-04's
bugs are committed to `0c-coder-libraries` and `OnlyKey-Firmware` (not
yet pushed/merged upstream — these are local commits in the `bm-ok` forks
pending review). `onlykey-testing/TEST-PLAN.md` has the full technical
writeup for every bug, with file/line references, kept separately since
the firmware repos' own history doesn't have a natural place for a
cross-repo narrative like this.

**CLI fork correction (2026-07-23):** the `python-onlykey` clone used
during initial TC-04 debugging was a stale fork, missing the
composite-PGP-PQC and derived-X-Wing work this report's header table
(`68c1c84`) actually describes. Re-cloned as `0c-coder-python-onlykey`
and re-verified TC-04 against it — see TC-04's row above and
`onlykey-testing/TEST-PLAN.md` for what changed. No commits were made to
`0c-coder-python-onlykey`; the earlier `python-onlykey` fixes (message
type, slot constants) turned out to be specific to the stale clone and
don't apply to the correct one.

**TC-05/TC-06 completed, workspace reset (2026-07-23, later same day):**
the workspace was reset and `project-setup.sh` rewritten to clone the
correct CLI fork directly as `./python-onlykey` from the start — no more
separate stale/correct clone split to track. Re-verified TC-04 reliably
against the reset workspace, then built out TC-05 and TC-06. TC-06 was
straightforward; TC-05 surfaced four more real bugs (three firmware, one
`python-onlykey`) on top of the transport fix from earlier that day, the
most significant being a **deterministic** (not timing-dependent)
off-by-chunk bug in `process_packets()`'s bounds check that rejected the
final chunk of any X-Wing/ML-KEM ciphertext 100% of the time — meaning
PQC decrypt could not have worked before this investigation, independent
of everything else found. All four fixes are committed locally to
`0c-coder-libraries`/`python-onlykey` (not pushed), full detail in
`onlykey-testing/TEST-PLAN.md`'s TC-05 entry (findings #13-16). Final
state: the complete suite (`00-setup` → TC-04 → TC-06 → TC-05) passes
7/7 in a single combined run, with real X-Wing keys generated,
retrieved, and used for a full host-encrypt/device-decrypt round trip on
physical hardware.
