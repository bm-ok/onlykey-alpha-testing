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
| 04 | Generate X-Wing age identity | PASS (after fixes) | `age-plugin-onlykey --generate` now produces a valid `AGE-PLUGIN-ONLYKEY-1...` identity + `age1onlykey1...` recipient, fully automated (`onlykey-testing/lib/pqc_keygen.js`). Required fixing 5 stacked bugs first — see below and `onlykey-testing/TEST-PLAN.md`'s TC-04 entry for full detail: (1) `age_plugin`'s `OKGENKEY` pointed at the wrong message type (`OKSETSLOT` instead of `OKSETPRIV`), (2) keygen's `CRYPTO_AUTH` confirmation gate was unreachable — nothing in the `OKSETPRIV` path ever primed it, (3) both keygen functions derived the returned public key from AES-GCM ciphertext instead of the plaintext seed (real crypto-correctness bug, independent of reachability), (4) `SLOT_MLKEM=133`/`SLOT_XWING=134` aren't valid ECC slots — firmware only supports 101-132, fixed by using 101/102, (5) `OKSETPRIV` requires config mode, which needs an extra button-6 long-press + PIN re-entry sequence not previously documented anywhere. Fixes committed to `0c-coder-libraries`, `OnlyKey-Firmware`, and `python-onlykey`. |
| 05 | Age encrypt/decrypt roundtrip | BLOCKED | Not yet run — needs `pqc_keygen.js`'s confirmation-injection logic (decaps also requires the 3-button challenge) generalized from keygen to decrypt calls. |
| 06 | Slot select + reserved reject | ▢ | |
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
— no human button presses for any of these. Fixes for TC-04's five bugs
are committed to `0c-coder-libraries`, `OnlyKey-Firmware`, and
`python-onlykey` (not yet pushed/merged upstream — these are local commits
in the `bm-ok` forks pending review). `onlykey-testing/TEST-PLAN.md` has
the full technical writeup for every bug, with file/line references,
kept separately since the firmware repos' own history doesn't have a
natural place for a cross-repo narrative like this.
