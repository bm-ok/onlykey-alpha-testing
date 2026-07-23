# OnlyKey Automated Test Suite — Test Plan

Tracks every test this suite drives, plus the PQC test cases handed down from
the maintainer (`./OnlyKey-PQC-Test-Cases.md`, `./OnlyKey-PQC-Test-Report.md`).
Status legend: ✅ confirmed/implemented · 🚧 scaffolded, not yet run · ❓ needs
more research before it can be written.

Repos under test (all cloned as siblings of this repo, per `../project-setup.sh`):
`./arduino-1.6.5-r5-teensy_127` (firmware, with `./libraries` and
`./OnlyKey-Firmware` as siblings of *it*, not nested inside), `./python-onlykey`
(CLI + age plugin — cloned directly from `0c-coder-python-onlykey`, the
correct fork; `okpqc-venv`'s editable `onlykey` install points here),
`./lib-agent` (agent packaging), `./onlykey.github.io` (web app), `./OnlyKey-App`
(setup GUI), `./serial` (raw HID capture tool this suite's `lib/hid.js`
supersedes for scripted use).

**Fork correction (2026-07-23):** this suite was originally built and TC-04
was debugged against a stale clone of `python-onlykey` lacking the
composite-PGP-PQC and derived-X-Wing work that `OnlyKey-PQC-Test-Report.md`'s
header table (`68c1c84`) actually describes; that was re-cloned that same day
as a separate `0c-coder-python-onlykey` directory. The workspace was later
reset entirely and `project-setup.sh` rewritten to clone the correct fork
directly as `./python-onlykey` from the start - there is only one
`python-onlykey` clone now, and it is the correct one. See the TC-04 entry
below for the bug-by-bug detail from that correction, and the entry after it
for further fixes found via live DEBUG-serial tracing once actually running
the full suite against this reset workspace.

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
  tooling from `./python-onlykey`, `./lib-agent`)** — already scriptable
  binaries, installed in `./okpqc-venv`. No emulation needed or wanted:
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
| ENC-04 | PQC keygen/decrypt correctly no-ops on non-encrypted profile | ❓ needs research | The maintainer's report claims `set_private` returns early on `NONENCRYPTEDPROFILE`, blocking PQC keygen/decrypt (see Gotchas / risk register item 3 in `./OnlyKey-PQC-Test-Report.md`). Worth a dedicated negative test once SETUP-06's build exists: attempt TC-04 against it and confirm a clean no-op/error, not a hang or crash. |

## 2. Firmware (maintainer TC-01–TC-03, TC-15)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-01 | Firmware builds | ✅ done (prior session) | `./arduino-1.6.5-r5-teensy_127` at `d7d5080`, compiled clean, `builds/OnlyKey.cpp.hex` present. |
| TC-02 | Flash + boot | ✅ done (prior session) | Flashed, device enumerates (`lsusb`: `1d50:60fc OnlyKey`). |
| TC-03 | Initialize with an encrypted profile | ✅ done, via SETUP-03 | |
| TC-15 | Non-PQ regression: PIN unlock, slot labels, U2F/FIDO2, RSA/ECC | 🚧 PIN unlock done (SETUP-04); slot labels/U2F/FIDO2/RSA/ECC not started | |

## 3. CLI age — slot-based X-Wing (maintainer TC-04–TC-07)

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| TC-04 | Generate X-Wing age identity on device (`--generate --slot 101`) | ✅ confirmed live end-to-end, fully automated, against the **correct** fork | `age-plugin-onlykey --generate` produces a real `AGE-PLUGIN-ONLYKEY-1...` identity and `age1onlykey1...` recipient against real hardware, with **zero physical button presses** — driven entirely by `lib/pqc_keygen.js` (see `test/01-pqc-keygen.test.js`). Originally debugged against `./python-onlykey`, which turned out to be a stale fork (see repo-header note above); re-verified against `./0c-coder-python-onlykey` (`68c1c84`, the one `OnlyKey-PQC-Test-Report.md` actually describes) with these results: <br>**Still applies, unchanged (firmware/harness bugs, fork-independent):** <br>1. **Unreachable CRYPTO_AUTH gate** — `okcrypto_xwing_keygen()`/`okcrypto_mlkem_keygen()` require `CRYPTO_AUTH==4`, but nothing in the `OKSETPRIV` call chain ever primed it. Fixed by having `ecc_priv_flash()` (`okcore.cpp`) prime the same 3-button challenge decaps uses, and adding an `OKSETPRIV` branch to the post-challenge dispatcher in `OnlyKey.ino` — mirrors the existing `OKSIGN`/`OKDECRYPT` pattern exactly. Firmware's own `okpqc.cpp` (composite PGP-PQC sign/decrypt, added independently) uses the identical `if (!CRYPTO_AUTH) { process_packets(...); pending_operation=...; return; }` pattern, confirming this is the codebase's existing convention, not a one-off. <br>2. **Seed-clobber correctness bug** — both keygen functions expanded `buffer+7` for the public key *after* `ecc_priv_flash()` AES-GCM-encrypted it in place. Fixed by saving the plaintext seed to a local buffer first. <br>3. **`OKSETPRIV` requires config mode**, only enterable via a duration≥72 long-press of button 6 while unlocked, which itself re-locks the device. Harness performs unlock → long-press 6 → unlock again. <br>4. **`isfade` timing race** on the config-mode long-press — fixed with a ~6s wait after each unlock. <br>**Did NOT carry over — was a bug in the stale fork only, already fixed upstream in the correct one:** <br>5. `./python-onlykey`'s `age_plugin/__init__.py` pointed `OKGENKEY` at `OKSETSLOT` (wrong message) and used invalid slots `133`/`134`. `./0c-coder-python-onlykey` already uses `OKSETPRIV` and valid slots `101`/`102` (`DEFAULT_XWING_SLOT`/`DEFAULT_MLKEM_SLOT`) — no Python fix needed against the correct fork. <br>**New, specific to the correct fork:** <br>6. **No challenge digits in CLI output** — the stale fork's `onlykey_hid.py` was patched (by us) to print `"Press these 3 OnlyKey buttons...: X, Y, Z"` so the harness could scrape it. The correct fork's `onlykey_hid.py` never prints digits at all — real UX is the device's own LEDs (`done_process_packets()` → `fadeon()`), no host-side text. `lib/pqc_keygen.js` now computes `Challenge_button1/2/3` itself (`challengeDigitsForKeytype()`): SHA256 of the fixed 9-byte `packet_buffer` (`[keytype, 0xFF×8]`, since the trigger payload is always `GENERATE_ON_DEVICE`) → `hash[0]%6+1, hash[15]%6+1, hash[31]%6+1`, matching `okcore.cpp`'s `done_process_packets()` (~7312-7324, non-DUO branch) exactly — then sends them on a fixed delay after spawning the CLI, since there's no stderr signal to wait on. Deterministic given keytype is known ahead of time, so this is more reliable than the old scrape-based approach, not less. <br>7. **Intermittent truncated read in `onlykey_hid.py`'s `_read_response()`** — observed ~1-in-3 runs returning 1152 bytes instead of the expected 1216 (short by exactly one 64-byte HID report). Root cause: `_read_response()`'s except-handler treats *any* read exception as "done" once `result` is non-empty (`except Exception: if result: break; else: continue`), so a single transient 2000ms read timeout mid-stream aborts the whole 30s poll early instead of retrying. Not fixed (host CLI code in a freshly-corrected fork, out of scope for this pass) — flagging here since it makes TC-04 flaky independent of anything in this repo; a real fix would keep polling on read-exception until the outer deadline, not just until `result` is non-empty. <br>**Also fixed in the harness this pass (unrelated to keygen itself, but blocked SETUP-04 against the new fork):** `lib/device.js`'s `checkStatus()` used `onlykey-cli getlabels`, which crashes (`IndexError`/`ord()` `TypeError`) against this dev-board firmware's per-slot label response under the correct fork's `hidraw`-preferring transport. Switched to the simpler `onlykey-cli settime` (one string round-trip, no per-slot parsing) plus a 3-retry wrapper, since the vendor `OnlyKey()` constructor's own HID-enumeration can race right after `CPU_RESTART()` re-enumeration on this board. <br>Slot 101 now holds a real X-Wing key on the physical device; TC-05 (encrypt/decrypt roundtrip) should validate it round-trips correctly given the seed-clobber fix. <br>**Round two, after the full workspace reset (2026-07-23, same day):** running TC-04 back-to-back with SETUP-04 in one mocha process (the exact scenario a full `npx mocha` run hits) exposed three more real races that fixed-delay/DEBUG-serial-print approaches above hadn't actually nailed down — root-caused via live DEBUG-serial tracing (temporary standalone scripts, not committed) with full-transcript timestamped logging, not guesswork: <br>8. **CRYPTO_AUTH priming presses arriving mid-block** — sending the 3 challenge presses right after the CLI's "Press OnlyKey button" print (which fires ~instantly, well before the device round-trips) landed while `ecc_priv_flash()`'s priming block was still synchronously blocking `loop()` (~0.6-0.9s) — 2 of 3 presses silently dropped, producing 0-byte or truncated responses. Originally "fixed" by waiting for the device's own "Encrypted Buffer" print (the last thing `done_process_packets()` does) instead of the CLI - but that print goes over the same verbose DEBUG-serial channel finding #10 below shows drops output under load, so it wasn't actually reliable either. Now just a fixed margin (2.5s) past the CLI's "Press OnlyKey button" print, comfortably past the observed blocking window. <br>9. **Config-mode `isfade` race, worse than first measured** — the button-6 long-press requires `!isfade` (`OnlyKey.ino:910`), cleared ~2s after unlock's `fadeon()`. A 500ms-1s gap here (previously believed sufficient) reliably lost the long-press every time in live tracing - "Button selected 6" still printed (that print fires regardless of which branch handles it, so it's not proof of success), but every subsequent "re-unlock" digit got read as a normal slot-button press instead of a PIN guess, spelling out "Additional Character / Slot Number 1 / Displaying Full Keybuffer" instead of ever reaching password evaluation. Fixed with a real 2.5s margin plus a retry loop (`enterConfigModeConfirmed()`) that verifies re-entry indirectly by checking whether the following re-unlock actually confirms. <br>10. **The verbose DEBUG-serial channel itself drops output under load** — the actual root cause behind #8/#9 initially seeming unfixable by margin-tuning alone. Watching for a device-side print like `password.cpp`'s `"Profile Key "` (only reached deep in `profile1hashevaluate()`'s successful-match branch) failed even on a slow, fully isolated, deliberate single-attempt test with generous delays and nothing else going on: live trace showed the PIN visibly accepted (hash match reached, intermediate prints present, no divergent/failure branch taken) and then the expected print just never arrived - no error, nothing. The dozens of lines of hex-dump text this path produces appear to be too much for the SEREMU virtual-serial link to reliably deliver under load. Switched unlock confirmation entirely to polling `checkStatus()` (`device.js`, `onlykey-cli settime`) instead - a single clean status string over the *separate, much leaner* main HID protocol interface, already proven reliable for this exact question by `00-setup.test.js`. <br>11. **Firmware-side USB packet loss on the main response channel too** — even with all of the above fixed, `onlykey_hid.py`'s `_read_response()` (fix #7, now committed to `python-onlykey`) still occasionally comes back short by 1-3 of the pubkey's 19 HID reports, *despite* retrying reads until its own full deadline - meaning the device genuinely never sent the missing report(s), not that the host missed one it could have retried for. Not fixable from the harness or client library; mitigated with `runWithAutoConfirmRetrying()` (`lib/pqc_keygen.js`), which retries the entire restart/unlock/configmode/keygen sequence specifically on that truncated-response error, since a partial failure can leave device state (CRYPTO_AUTH, config mode) in a condition only a clean restart recovers from. <br>Verified via 5 consecutive clean combined-suite runs (`00-setup` → `01-pqc-keygen` in one `npx mocha` process) after all of the above - the scenario that had been failing consistently before. Finding #11 remains a real, open firmware/USB-transport reliability question worth flagging to whoever owns that side. |
| TC-05 | Age encrypt (host) / decrypt (device) roundtrip | 🚧 unblocked, not yet run | Will exercise `okcrypto_xwing_decaps()`, which needs its own `process_packets()`-based 3-button confirmation (same pattern as keygen) — `lib/pqc_keygen.js`'s `runWithAutoConfirm()` should generalize to decrypt calls too, since `age -d` shells out to `age-plugin-onlykey --age-plugin=identity-v1`, not `--generate`. |
| TC-06 | Slot selection + reserved-slot rejection (116 ok, 117 rejected) | 🚧 unblocked, not yet run | Previously thought to need rethinking because `--slot` was dead/unparsed code — that was true of the stale `./python-onlykey` fork only (TC-04 finding #5). `./0c-coder-python-onlykey`'s `cli.py` (~495-503) properly parses `--slot N`/`--slot=N` and validates it via `validate_ecc_slot()` (101-116 user slots; 117-132 rejected as reserved) — the maintainer's test can be run as literally written against the correct fork. |
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
