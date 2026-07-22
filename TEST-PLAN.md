# OnlyKey Automated Test Suite — Test Plan

Tracks every test this suite drives, plus the PQC test cases handed down from
the maintainer (`../OnlyKey-PQC-Test-Cases.md`, `../OnlyKey-PQC-Test-Report.md`).
Status legend: ✅ confirmed/implemented · 🚧 scaffolded, not yet run · ❓ needs
more research before it can be written.

Repos under test (all cloned as siblings of this repo):
`../arduino-1.6.5-r5-teensy_127` (firmware), `../python-onlykey` (CLI + age
plugin), `../lib-agent` (agent packaging), `../onlykey.github.io` (web app),
`../OnlyKey-App` (setup GUI), `../serial` (raw HID capture tool this suite's
`lib/hid.js` supersedes for scripted use).

## Design principle: two different strategies depending on what's under test

The goal of this suite is broader than PQC alone: exercise firmware
functionality the way real users actually hit it, via both the app and the
CLI/agent tooling. The two are tested differently, because of what each one
actually is:

- **OnlyKey-App (Electron GUI)** — not something this suite drives headlessly
  (no Spectron/Playwright layer here). Instead, **emulate** it: read what HID
  commands `OnlyKeyWizard.js` (and friends) send to the device, and send
  those same commands directly from the harness. Where the app talks to the
  device over a direct HID command (e.g. an `OKSETPIN`-style message
  carrying a typed PIN) instead of simulating touch-button digit presses,
  that's faster (no firmware-side 20s inactivity timers to wait out) and
  gives real coverage of the app's protocol, not just the DEBUG-only
  button-injection path. Button-simulation (`lib/hid.js`'s `SeremuChannel`)
  stays as the fallback for anything the app doesn't cover, or DEBUG-only
  paths (wipe, digit injection) that have no app equivalent by design.

- **`onlykey-cli` / `age-plugin-onlykey` / `onlykey-agent` (Python CLI
  tooling from `../python-onlykey`, `../lib-agent`)** — already scriptable
  binaries, installed in `../okpqc-venv`. No emulation needed or wanted:
  **shell out to the real binaries directly** (`child_process.execFile`,
  as `checkStatus()` in `lib/device.js` already does against `onlykey-cli
  getlabels`). Reimplementing their protocol logic in Node would just be a
  second, divergent copy of code that already exists and is already tested
  by `python-onlykey/tests/`.

**Resolved for SETUP-03** — confirmed by reading `OnlyKeyWizard.js` and
`OnlyKeyComm.js`, then cross-checking the firmware dispatch (`okcore.cpp:342-362`):

- Our hardware is the 6-button dev board (confirmed by the user), i.e.
  Classic/Color, not DUO. DUO gets a genuinely different fast path — a
  single `OKSETPIN` packet with all three PINs plus a `0xff` marker
  (`OnlyKeyComm.js:562-607` `sendPin_DUO`) that the firmware recognizes as
  `SETUP_MANUAL` and commits with zero button presses and no timer at all
  (`okcore.cpp:753-776`). Not available to us.
- For Classic, the wizard still requires physical button digit entry (no
  PIN text field), but it never waits on the firmware's 20s timer — it
  advances the state machine itself by sending a bare `OKSETPIN` (primary),
  `OKSETPIN2`/`OKSETPDPIN`=227 (secondary), or `OKSETSDPIN` (self-destruct)
  message the instant the user clicks Next (`OnlyKeyWizard.js` Step2-7:
  `enterFn`/`exitFn` bound to `sendSetPin`/`sendSetPin2`/`sendSetSDPin`).
  `okcore.cpp:342-362` confirms these bare messages work with **no prior
  button press needed to arm the state** — `case OKPIN` calls
  `set_primary_pin(recv_buffer, 0)` directly whenever `!initcheck`, and
  `keyboard_mode=0` means the firmware's timer-arming code path
  (`fadeoffafter20()`) is simply never reached on this route.
- `OnlyKeyDevice.runInitialSetup()` (`lib/device.js`) now uses this: arm →
  digits round 1 → advance (store round 1) → advance (arm confirm round) →
  digits round 2 → commit, for each of primary/secondary/self-destruct, via
  `sendPinAdvance()` (shells out to `lib/py/pin_advance.py`, which uses
  `python-onlykey`'s own `OnlyKey` class and `Message` enum — no
  reimplementation of the client-HID-message layer in Node, per the design
  principle above). No more 20-second sleeps. **Confirmed working end-to-end
  against real hardware** — an earlier version of this sequence used only 3
  messages per PIN (missing the "arm confirm round" message), which passed
  the setup step but left the device stuck `UNINITIALIZED` since the real
  commit (`case3`/`case6`/`case9` in `set_primary_pin`/`set_sd_pin`/
  `set_secondary_pin`) never fired. Fixed by tracing the firmware's `pin_set`
  state machine directly.
- The host-message PIN flow commits flash state but never itself reboots —
  only the physical-button-driven `okcore_quick_setup()` path reaches
  `CPU_RESTART()`, and `initialized` is only recomputed from flash at boot
  (`OnlyKey.ino` `setup()`). Fixed by adding a DEBUG-only `'8'` restart
  command to the firmware (`okcore.cpp:2500-2503`, long-press terminated,
  no confirmation needed since it touches no data) — `runInitialSetup()`
  now calls `restartDevice()` after the last PIN commits. **Confirmed**:
  device correctly reports `locked` (not `uninitialized`) after reboot.
- Unlocking after reboot needed two more fixes, both in `lib/hid.js`:
  (1) `SeremuChannel.connect()`'s retry loop only checked that
  `new HID()` didn't throw, not that the handle was actually live — during
  `CPU_RESTART()`'s USB re-enumeration this could grab a handle that went
  stale mid-open, causing the *next* write to fail with "Timer expired".
  Fixed with a liveness-probe write (2 bytes minimum — this hidraw device
  rejects 1-byte writes with `EINVAL` regardless of device state, unrelated
  to enumeration) immediately after opening, retried on failure like any
  other not-yet-enumerated case. (2) `profile1hashevaluate()` runs a
  Curve25519 + SHA256 computation on every digit once `guesslen>=7`, and
  our 7 unlock digits arrive in a rapid burst with no inter-digit delay —
  measured **~3.4s** from last digit sent to the device actually reporting
  `unlocked`. The original test's fixed 1-second wait was too short and
  reported a false failure; `test/00-setup.test.js` now polls every 500ms
  up to 5s instead. **Confirmed working end-to-end.**

---

## 0. Harness bootstrap (device setup) — NEW, not in the maintainer's doc

The maintainer's TC-03 ("initialize with an encrypted profile") assumes a
human does this by hand. This suite automates it over the DEBUG-serial
button-injection channel (`okcore.cpp:2454-2516`): ASCII digits `'1'`-`'6'`
simulate touch-button presses, terminated by `\n` (short press) / space
(long press).

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| SETUP-01a | Wipe device to clean/unconfigured state, userspace only | ✅ implemented, reflashed, not yet re-verified live | DEBUG-only: send `'0'`+space to arm, `'C'`+space to confirm → new `wipeuserspace()` (`okcore.cpp`). Found + fixed a real bug: the old DEBUG wipe called `factorydefault()`, which reads a `wipemode` EEPROM byte that's never set on a fresh device (reads as erased `0xFF`, i.e. `>1`), so it silently took the FULLWIPE branch and erased the firmware hash + forced the bootloader every time — requiring a manual reflash after every test-suite reset. `wipeuserspace()` calls `wipeEEPROM()`+`wipeflashdata()` directly, never touching firmware. Device has been reflashed with this build; the `'0'`/`'C'` path itself hasn't been explicitly exercised yet (SETUP-02/03/04 below were verified via a device that was already freshly wiped from a prior manual flash). |
| SETUP-01b | Wipe device to clean/unconfigured state, full (firmware + userspace) | ✅ implemented, reflashed, not yet re-verified live | DEBUG-only: send `'9'`+space to arm, `'C'`+space to confirm → calls `factorydefault()` (same FULLWIPE path as before, now reachable deliberately instead of by accident). Forces the bootloader; requires a manual reflash afterward. |
| SETUP-02 | Confirm fresh device reports UNINITIALIZED | ✅ confirmed live | `onlykey-cli getlabels` / raw HID read surfaces `UNINITIALIZED` (`client.py:404`) on an unconfigured device — reproduced against real hardware. |
| SETUP-03 | Initial setup on **encrypted** (STD) build: primary + secondary + self-destruct PIN | ✅ confirmed live end-to-end | Via host-message flow, not the button-driven `okcore_quick_setup()` (that's what the app itself does — see design principle above): arm → digits round 1 → store → arm-confirm → digits round 2 → commit, per PIN, then DEBUG `'8'` restart. `ONLYKEY_CONFIRM_SETUP=yes npx mocha` run against real hardware: device went from `UNINITIALIZED` to `locked` after reboot. Test PINs: primary `1111111`, secondary `2222222`, self-destruct `6666666`. |
| SETUP-04 | Unlock with primary PIN after reboot | ✅ confirmed live end-to-end | Short-press the primary PIN digits again (`OnlyKeyDevice.unlockWithPrimaryPin()`); `Password::profile1hashevaluate()` re-checks after every digit and auto-unlocks on match — no terminator button. Takes ~3-3.5s to actually flip to `unlocked` after the last digit (Curve25519+SHA256 per digit once `guesslen>=7`, all 7 digits arrive as a rapid burst) — `test/00-setup.test.js` polls for this instead of a fixed wait. |
| SETUP-05 | Confirm self-destruct PIN actually wipes | ❓ needs research | Haven't traced what device state looks like immediately after SD-PIN-triggered wipe vs. the DEBUG `'0'/'C'` wipe — may differ. Also need to confirm this is safe to test repeatedly without bricking. |
| SETUP-06 | Initial setup on **non-encrypted** (Travel edition) build | ❓ needs research | `profilemode` is a **compile-time** constant (`OnlyKey.ino:82` `STD_VERSION`), not a runtime/button choice. The quick-setup long-press triggers (buttons 1/2/3) are gated by `profilemode != NONENCRYPTEDPROFILE` (`OnlyKey.ino:731,735,739`) — meaning on a Travel-edition build (`STD_VERSION` undefined) those triggers **never fire**. Have not yet traced what the actual setup entry point is on that build. Requires: (a) a second firmware build with `STD_VERSION` undefined, (b) tracing its setup path, (c) a spare device or confirmed-safe re-flash cycle. |

## 1. Encryption verification — NEW, requested explicitly

The maintainer's doc treats "encrypted profile" as a precondition, never as
something independently verified. Given SETUP-06 above, we now have two
firmware builds whose only difference is `STD_VERSION`, which makes an actual
before/after comparison possible.

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| ENC-01 | Confirm `profilemode == STDPROFILE1` on the STD build after setup | ❓ needs research | Need a way to read `profilemode` back out — likely via the existing DEBUG EEPROM dump (`wipeEEPROM()`, `okcore.cpp:2898-2924`, gated by `DEBUG_CTAP_VERBOSE`) rather than a dedicated status command. |
| ENC-02 | Confirm PIN/profile data at rest is NOT plaintext-recoverable on the STD (encrypted) build | ❓ needs research | Dump EEPROM/flash via the DEBUG channel, inspect for the raw PIN digits / recognizable structure. This is the actual "confirm encryption is true" test — negative result (no plaintext match) is the pass condition. |
| ENC-03 | Confirm PIN/profile data at rest on the Travel (non-encrypted) build for contrast | ❓ needs research | Same dump technique against SETUP-06's build; expect the difference to be visible, which is what proves ENC-02 is meaningful rather than trivially true on both. |
| ENC-04 | PQC keygen/decrypt correctly no-ops on non-encrypted profile | ❓ needs research | The maintainer's report claims `set_private` returns early on `NONENCRYPTEDPROFILE`, blocking PQC keygen/decrypt (see Gotchas / risk register item 3 in `../OnlyKey-PQC-Test-Report.md`). Worth a dedicated negative test once SETUP-06's build exists: attempt TC-04 against it and confirm a clean no-op/error, not a hang or crash. |

## 2. Firmware (maintainer TC-01–TC-03, TC-15)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-01 | Firmware builds | ✅ done (prior session) | `../arduino-1.6.5-r5-teensy_127` at `d7d5080`, compiled clean, `builds/OnlyKey.cpp.hex` present. |
| TC-02 | Flash + boot | ✅ done (prior session) | Flashed, device enumerates (`lsusb`: `1d50:60fc OnlyKey`). |
| TC-03 | Initialize with an encrypted profile | ✅ done, via SETUP-03 | |
| TC-15 | Non-PQ regression: PIN unlock, slot labels, U2F/FIDO2, RSA/ECC | 🚧 PIN unlock done (SETUP-04); slot labels/U2F/FIDO2/RSA/ECC not started | |

## 3. CLI age — slot-based X-Wing (maintainer TC-04–TC-07)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-04 | Generate X-Wing age identity on device (`--generate --slot 101`) | ✅ confirmed live end-to-end, fully automated | `age-plugin-onlykey --generate` now produces a real `AGE-PLUGIN-ONLYKEY-1...` identity and `age1onlykey1...` recipient against real hardware, with **zero physical button presses** — driven entirely by `lib/pqc_keygen.js` (see `test/01-pqc-keygen.test.js`). Getting here required stacking five separate, real bugs found by tracing the firmware live (in addition to the enum bug from the previous session): <br>1. **Unreachable CRYPTO_AUTH gate** — `okcrypto_xwing_keygen()`/`okcrypto_mlkem_keygen()` require `CRYPTO_AUTH==4`, but nothing in the `OKSETPRIV` call chain ever primed it (only decaps did, via its own `process_packets()` call, for an unrelated operation). Fixed by having `ecc_priv_flash()` (`okcore.cpp`) prime the same 3-button challenge decaps uses, and adding an `OKSETPRIV` branch to the post-challenge dispatcher in `OnlyKey.ino` that decrypts the primed payload and completes the keygen — mirrors the existing `OKSIGN`/`OKDECRYPT` pattern exactly, no new mechanism invented. <br>2. **Seed-clobber correctness bug** — both keygen functions called `ecc_priv_flash()` (which AES-GCM-encrypts its input **in place**) and then expanded `buffer+7` for the public key *after* that call — meaning the returned public key was derived from ciphertext, not the seed, and would never have matched what decaps later derives from the correctly-decrypted stored seed. Fixed by saving the plaintext seed to a local buffer before the encrypting call. <br>3. **`OKSETPRIV` requires config mode** — silently rejected with "Error not in config mode" otherwise (`okcore.cpp` `case OKSETPRIV`), and config mode is *only* enterable via a duration≥72 long-press of button 6 while already unlocked (`OnlyKey.ino` ~895-908) — which itself re-locks the device as a re-auth step, requiring the PIN a second time. No firmware change here — the harness now performs this exact sequence (unlock → long-press 6 → unlock again) via simulated button presses, matching real user behavior per explicit instruction to keep firmware changes minimal. <br>4. **`isfade` timing race** — the entire long-press-detection chain (including config-mode entry) requires `!isfade`, and unlock completion sets `isfade=1` for ~2s (cleared by a scheduled `fadeendafter2sec` task) — pressing button 6 inside that window silently falls through to an unrelated long-press handler with no error, no lock, nothing. Fixed by waiting ~6s after each unlock (3.4s to match + fade-clear margin) before the next button press. <br>5. **Wrong slot numbers, not a firmware bug** — `age_plugin/__init__.py`'s `SLOT_XWING=134`/`SLOT_MLKEM=133` aren't valid ECC slots at all; `okcore.h`'s own comment says PQC keys "can be stored in any ECC slot (101-132)" via the type byte, not a dedicated slot range, and three separate bounds checks (`ecc_priv_flash()`, `okcrypto_getpubkey()`, `okcrypto_decrypt()`) all reject anything above 132/116. Also confirmed the maintainer's documented `--slot 101` flag is dead code — never parsed by `cli.py`, never threaded anywhere. Fixed by changing the two Python constants to valid slots (101/102) instead of touching the firmware bounds checks. <br>Slot 101 now holds a real X-Wing key on the physical device; TC-05 (encrypt/decrypt roundtrip) should validate it round-trips correctly given the seed-clobber fix. |
| TC-05 | Age encrypt (host) / decrypt (device) roundtrip | 🚧 unblocked, not yet run | Will exercise `okcrypto_xwing_decaps()`, which needs its own `process_packets()`-based 3-button confirmation (same pattern as keygen) — `lib/pqc_keygen.js`'s `runWithAutoConfirm()` should generalize to decrypt calls too, since `age -d` shells out to `age-plugin-onlykey --age-plugin=identity-v1`, not `--generate`. |
| TC-06 | Slot selection + reserved-slot rejection (116 ok, 117 rejected) | ❓ needs rethink | The maintainer's `--slot 116`/`--slot 117` test no longer applies as literally written, since `--slot` is dead/unparsed (see TC-04 finding #5) — slot selection is currently only changeable by editing `SLOT_XWING` in `age_plugin/__init__.py`. Either wire up `--slot` properly (larger CLI change) or adapt this test case to the constant instead. |
| TC-07 | Negative: decrypt with no device attached | 🚧 unblocked, not yet run | |

## 4. Web app — derived X-Wing (maintainer TC-08–TC-10)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-08 | Web app builds, `npm run test:pqc` 5/5 | 🚧 not started | |
| TC-09 | Derived X-Wing round-trip in browser | 🚧 not started | Maintainer flags the age file container in `age-pqc.js` as a known TODO — may be BLOCKED regardless. |
| TC-10 | Device derive protocol (module-level check) | 🚧 not started | |

## 5. PGP-PQC composite (maintainer TC-11)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-11 | Generate composite key → `setpqc` load → web app encrypt/decrypt/sign | 🚧 not started | |

## 6. Regression + security (maintainer TC-12–TC-14)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-12 | `hidraw` transport on Linux | 🚧 not started | |
| TC-13 | Reserved-slot guard doesn't break backup/HMAC/SSH/GPG | 🚧 not started | |
| TC-14 | Packaging versions (`onlykey` 1.2.11, `onlykey-agent` 1.1.16) | 🚧 not started | |

## 7. CLI derived (label-based) X-Wing + interop (maintainer TC-16–TC-19)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-16 | Derived identity + recipient, no slot, deterministic | 🚧 not started | |
| TC-17 | Derived encrypt→decrypt roundtrip (CLI only) | 🚧 not started | Maintainer flags the 64-byte HID framing as the single most likely hardware failure point. |
| TC-18 | ★ Interop: encrypt CLI → decrypt web app | 🚧 not started | Headline feature. |
| TC-19 | Reverse interop: encrypt web app → decrypt CLI | 🚧 not started | |

---

## Open questions before SETUP-06/ENC-01–04 can be scaffolded

1. What is the actual button/HID sequence for initializing a Travel-edition
   (`NONENCRYPTEDPROFILE`) build, given the quick-setup long-press triggers
   don't fire on that build? Needs a fresh trace through `OnlyKey.ino`/
   `okcore.cpp` for that `#ifndef STD_VERSION` branch.
2. Is there a non-destructive way to read back `profilemode` / EEPROM
   contents over the existing DEBUG channel, or does that need a small
   firmware addition?
3. Do we need a second physical device to safely hold a Travel-edition build
   side by side with the STD build under test, or is re-flashing the same
   device between builds acceptable for this suite?
