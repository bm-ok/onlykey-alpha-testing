# OnlyKey PQC — Test Case Document

**Scope:** validate the post-quantum work now on the `0c-coder` fork masters:
firmware (derived X-Wing + composite PGP-PQC + reserved-slot guard), the CLI age
plugin, the web app (derived X-Wing age + composite PGP-PQC), and packaging.

**These are test repos (0c-coder forks), not upstream.** Everything below is
UNCOMPILED firmware / software-verified-only until this pass — that's the point
of the exercise.

## Repos under test (use the `master` branch of each)

| Component | Repo | master @ | Role |
|---|---|---|---|
| Firmware (Arduino libraries) | `0c-coder/libraries` | `7453297` | X-Wing (slot + derived/HID) + PGP-PQC + slot guard |
| CLI / age plugin | `0c-coder/python-onlykey` | `68c1c84` | `onlykey-cli`, `age-plugin-onlykey` (slot + derived) |
| Agent (packaging) | `0c-coder/lib-agent` | `8785fc8` | `onlykey-agent` (pulls in `onlykey`) |
| Web app | `0c-coder/onlykey.github.io` | `6edad87` | derived X-Wing age + PGP-PQC UI |

```bash
mkdir -p ~/okpqc && cd ~/okpqc
for r in libraries python-onlykey lib-agent onlykey.github.io; do
  git clone -b master https://github.com/0c-coder/$r.git
done
```

## Hardware / host prerequisites

- An **OnlyKey** that can take the new firmware (PQC-capable; e.g. OnlyKey DUO / current STM/Teensy target). **Have a spare / backup** — reflashing wipes.
- The device will need to be **initialized with a PIN and an *encrypted* profile**. The firmware refuses key-set/keygen and decrypt on `NONENCRYPTEDPROFILE` (`set_private` returns early), so PQC keygen/decrypt only work on an encrypted profile.
- **Linux or macOS host.** Linux is preferred for the `hidraw` path (TC-12).
- **Python 3.8+**, **Node 20+**, **git**.
- **age** with plugin support: `FiloSottile/age >= 1.1.0` or `rage` (`brew install age` / distro package). Plain distro `age` sometimes lacks plugin support — verify.
- Firmware toolchain: **Arduino IDE + Teensyduino** (or the OnlyKey firmware build per <https://docs.onlykey.io>). Bring the OnlyKey firmware *sketch* repo too; `0c-coder/libraries` supplies the libraries it compiles against.

## One-time software install (use the fork source, NOT PyPI)

```bash
cd ~/okpqc
python3 -m venv venv && source venv/bin/activate
pip install --upgrade pip
# install the CLI + age plugin + agent from the fork masters (editable)
pip install -e ./python-onlykey          # onlykey-cli, age-plugin-onlykey
pip install -e ./lib-agent/agents/onlykey  # onlykey-agent (depends on onlykey, lib-agent)
pip install -e ./lib-agent                 # lib-agent
# PQC host deps
pip install cryptography kyber-py
which age-plugin-onlykey onlykey-cli onlykey-agent   # all must resolve
```

> `age` finds the plugin by the name `age-plugin-onlykey` on `PATH`. Confirm the venv `bin` is on `PATH` in the shell you run `age` from.

---

# A. Firmware

### TC-01 — Build the firmware
**Objective:** the merged master compiles for the target.
**Steps:** point the OnlyKey firmware build at `~/okpqc/libraries` as its libraries dir; compile the firmware sketch in Arduino/Teensyduino for the OnlyKey target.
**Expected:** compiles to a `.hex` with **no errors**. (⚠️ This has never been compiled — watch for missing symbols / duplicate-definition errors around `KEYTYPE_XWING`, `okcrypto_xwing_*`, `okpqc.*`, and the `ok_extension.cpp` derive block.)
**Record:** compiler version, target, any warnings/errors. **PASS / FAIL:** ▢

### TC-02 — Flash + boot
**Steps:** flash the `.hex` via the OnlyKey bootloader; unplug/replug.
**Expected:** device boots, LED normal, `onlykey-cli getlabels` responds. **PASS / FAIL:** ▢

### TC-03 — Initialize with an encrypted profile
**Steps:** set a PIN / initialize per OnlyKey app; ensure the profile is **encrypted** (not the non-encrypted profile).
**Expected:** device unlocks; `onlykey-cli getlabels` lists slots. **PASS / FAIL:** ▢

---

# B. CLI age — slot-based X-Wing (`age-plugin-onlykey`)

> This is python-onlykey's age path: an X-Wing keypair stored in a **user ECC
> slot (101–116)**, keygen via `OKSETPRIV`, decaps multi-packet. Pulled in when
> you install `onlykey-agent`.

### TC-04 — Generate an X-Wing age identity on the device
```bash
age-plugin-onlykey --generate --slot 101 > onlykey-age.txt   # touch device to confirm
cat onlykey-age.txt
RECIP=$(age-plugin-onlykey --recipient --slot 101); echo "$RECIP"   # age1onlykey1...
```
**Expected:** an `AGE-PLUGIN-ONLYKEY-1...` identity file + an `age1onlykey1...` recipient; device blinks/asks for confirmation on keygen. **PASS / FAIL:** ▢

### TC-05 — Encrypt (host-side, no device) then decrypt (device)
```bash
echo "pq hello $(date)" > secret.txt
age -r "$RECIP" -o secret.age secret.txt
grep -a mlkem768x25519 secret.age && echo "stanza present"
age -d -i onlykey-age.txt secret.age > out.txt     # press OnlyKey button on decrypt
diff secret.txt out.txt && echo "ROUNDTRIP OK"
```
**Expected:** `secret.age` header contains a `-> mlkem768x25519` stanza; decrypt asks for a button press and `diff` matches. **PASS / FAIL:** ▢

### TC-06 — Slot selection + reserved-slot rejection (host)
```bash
age-plugin-onlykey --generate --slot 116 >/dev/null && echo "116 ok"
age-plugin-onlykey --generate --slot 117 ; echo "exit=$?"   # must be rejected
```
**Expected:** slot 116 works; slot 117 prints an error (“must be a user ECC slot 101-116 (117-132 are reserved)”) and non-zero exit. **PASS / FAIL:** ▢

### TC-07 — Negative: wrong identity / no device
**Steps:** unplug the OnlyKey and rerun the TC-05 decrypt.
**Expected:** decryption fails cleanly (no crash). **PASS / FAIL:** ▢

---

# C. Web app — derived X-Wing age (split custody)

> Device keeps X25519 (`sk_X` never leaves); browser does ML-KEM. No slots — the
> key is derived from a label over the FIDO2 derive flow.

### TC-08 — Build + run the web app
```bash
cd ~/okpqc/onlykey.github.io
npm install
npm run test:pqc            # must print: pass 5, fail 0 (pure-crypto proof, no device)
npm run dev                 # webpack build -> ./dev
npm start                   # serves index.js
```
**Expected:** `test:pqc` passes 5/5; app builds and serves; open it in a plugin/WebAuthn-capable browser (Chrome). **PASS / FAIL:** ▢

### TC-09 — Derived X-Wing round-trip in the browser
**Preconditions:** OnlyKey connected + unlocked; app open on `localhost`/allowed origin.
**Steps (once the age plugin page is wired — see Known Gaps):**
1. Create/open an age identity by **label** (e.g. `age:personal`); export the recipient.
2. Encrypt a small file to that recipient in the browser.
3. Decrypt it — the OnlyKey should prompt for a **button press** (the X25519 `ss_X` step); the browser does ML-KEM locally.
**Expected:** recipient is a 1216-byte X-Wing key; decrypt requires the device and returns the original plaintext.
**⚠️ Known gap:** the browser **age file container** (stanza framing / encrypt-decrypt of real `.age` files) in `age-pqc.js` is still a TODO. The KEM + device protocol are implemented; if the container isn't finished, verify the device round-trip at the module level (see TC-10) instead. **PASS / FAIL / BLOCKED:** ▢

### TC-10 — Device derive protocol (lower-level check)
**Objective:** confirm the firmware FIDO2 derive branch returns the 64-byte `[pk_X|mlkem_seed]` / `[ss_X|mlkem_seed]` for the X-Wing keytype (wire keytype **5**).
**Steps:** using the web app’s `onlykey-pqc.js` (`getRecipient(label)` / `decapsulate(label, ct, pkX)`) from the browser console or a harness, with the OnlyKey connected.
**Expected:** `getRecipient` yields a 1216-byte recipient; `decapsulate` (button press) yields a 32-byte secret that matches a host `xwingEncapsulate` to the same recipient. **PASS / FAIL:** ▢

---

# D. Web app PGP-PQC (composite ML-KEM-768 + ML-DSA-65), key loaded via python-onlykey

> A single **160-byte composite blob** — `Ed25519(32) | ML-DSA-65 seed(32) |
> X25519(32) | ML-KEM-768 seed(64)` — is loaded into an **RSA slot (1–4)**; the
> device does ML-KEM decapsulation + ML-DSA-65 signing on-device.

### TC-11 — Generate composite key, load it, PGP round-trip
1. **Generate** the composite keypair in the web app (`gen-composite-key.js`) → an IETF OpenPGP-PQC **public key** + the **160-byte blob**.
2. **Load** the blob into an RSA slot with the CLI:
   ```bash
   onlykey-cli setpqc RSA1 <160-byte-hex-or-path-to-blob>
   # expect: "Loaded composite PQC PGP key (160 bytes) into RSA1"
   ```
3. In the web app, **encrypt** a PGP-PQC message to the public key, then **decrypt** it with the OnlyKey (button press → ML-KEM decap on-device).
4. **Sign** a message with ML-DSA-65 (sign type 1 → 3309-byte signature) and verify.
**Expected:** load succeeds; decrypt returns the plaintext; ML-DSA-65 signature verifies against the composite public key. **PASS / FAIL:** ▢

---

# E. Regression + security (things we changed recently)

### TC-12 — `hidraw` transport (#89, Linux)
```bash
python3 - <<'PY'
import onlykey.client as c
print("hid module:", c.hid.__name__)
PY
```
**Expected on Linux with the `hidraw` python module installed:** prints `hidraw`; CLI operations still work (no "hid open failed" when another app used the HID interface). On macOS it falls back to `hid`. **PASS / FAIL:** ▢

### TC-13 — Reserved-slot guard (firmware #29) does NOT break existing features
Confirm each still works after the new firmware:
- **Backup passphrase** setup (slot 131) still succeeds.
- **HMAC / Yubico challenge-response** (slots 129/130) still writes.
- **SSH/GPG** via `onlykey-agent` / `onlykey-gpg` still work.
```bash
onlykey-agent user@host -c            # SSH identity (existing feature)
onlykey-gpg init "Test <t@example.com>"   # GPG identity (existing feature)
```
**Expected:** backup, HMAC, SSH, GPG all unaffected; only *host writes to ECC slots 117–132* are newly refused. **PASS / FAIL:** ▢

### TC-14 — Packaging
```bash
python3 -c "import onlykey, importlib.metadata as m; print('onlykey', m.version('onlykey'))"   # 1.2.11
pip show onlykey-agent | grep -E "Version|Summary"                                             # 1.1.16 + description
```
**Expected:** `onlykey` 1.2.11, `onlykey-agent` 1.1.16 with a non-empty Summary/description. **PASS / FAIL:** ▢

### TC-15 — Existing (non-PQ) OnlyKey functions
Sanity that the new firmware didn’t regress core behavior: PIN unlock, slot labels, U2F/FIDO2 login to a test site, standard RSA/ECC key ops. **PASS / FAIL:** ▢

---

# F. CLI age — derived (label-based) X-Wing + cross-tool interop (NEW this pass)

> `age-plugin-onlykey` now supports **two identity models**: the slot-based keys
> in section B, and **derived** keys here. A derived key is not stored — the
> device reproduces it on demand from (web-derivation key, a 32-byte tag from the
> label, RPID). This is **split custody**: the OnlyKey returns its X25519 half +
> an ML-KEM seed over HID; the host finishes the ML-KEM half. The whole point is
> **interop with the web app**: same OnlyKey + same label ⇒ same key, so a file
> encrypted with `age` in the CLI decrypts in the web app on that device.
>
> **Confidence:** the *recipient/derive* path is single-report and high-confidence.
> The *decaps* path sends `tag(32)||ct_X(32)` = 64 B, which exceeds one 57-byte
> HID report, so it streams via `send_large_message2` — **this framing is
> unproven and is the most likely first hardware failure.** See Gotchas.

### TC-16 — Derived identity + recipient (no slot)
```bash
age-plugin-onlykey --derived --label "age:personal" --identity > derived-age.txt
cat derived-age.txt                       # AGE-PLUGIN-ONLYKEY-DERIVED-...
DRECIP=$(age-plugin-onlykey --derived --label "age:personal" --recipient)
echo "$DRECIP"                            # age1onlykey1...
python3 -c "import base64,sys; r='$DRECIP'; print('recipient decodes, len ok')"
```
**Expected:** a `AGE-PLUGIN-ONLYKEY-DERIVED-...` identity + an `age1onlykey1...`
recipient decoding to a **1216-byte** X-Wing key. No slot argument; device may or
may not blink (derive is no-touch by design). Re-running with the **same label**
must yield the **identical** recipient (determinism). **PASS / FAIL:** ▢

### TC-17 — Derived encrypt → decrypt round-trip (CLI only)
```bash
echo "derived pq $(date)" > d.txt
age -r "$DRECIP" -o d.age d.txt
grep -a mlkem768x25519 d.age && echo "stanza present"
age -d -i derived-age.txt d.age > d.out   # <-- decaps: the unproven 64B path
diff d.txt d.out && echo "DERIVED ROUNDTRIP OK"
```
**Expected:** encrypt works (recipient path); decrypt returns the plaintext.
**If decrypt fails**, capture the exact host error and any device log — this is
the `derive_decaps` / firmware `okcrypto_xwing_web_derive` framing to fix.
**PASS / FAIL / BLOCKED:** ▢

### TC-18 — ★ Cross-tool interop: encrypt in CLI, decrypt in web app
**This is the headline feature.** Same OnlyKey, same label, two different tools.
1. In the **CLI**, from TC-16/17 you have `$DRECIP` for label `age:personal` and `d.age`.
2. In the **web app** (section C), open/derive the **same label** `age:personal`
   and confirm it reports the **same recipient** as `$DRECIP` (byte-identical).
3. Load `d.age` into the web app and **decrypt** it with the OnlyKey.
**Expected:** the web app derives the identical recipient and decrypts `d.age` to
the original plaintext. **PASS / FAIL / BLOCKED:** ▢

### TC-19 — Reverse interop: encrypt in web app, decrypt in CLI
1. In the **web app**, derive label `age:work`, encrypt a file to it → `w.age`.
2. In the **CLI**: `age-plugin-onlykey --derived --label "age:work" --identity > w-id.txt`
   then `age -d -i w-id.txt w.age`.
**Expected:** CLI decrypts the web-app-produced file. **PASS / FAIL / BLOCKED:** ▢

---

# Gotchas — read before you start (where this will likely break)

1. **Derived decaps 64-byte framing (highest risk).** `tag(32)||ct_X(32)` won't
   fit one HID report; the CLI uses `send_large_message2`, but that framing puts
   a length byte where the firmware branch reads the keytype (`buffer[6]`).
   Expect **derived decrypt (TC-17/18/19)** to need a firmware+host fix here.
   Derived *encrypt/recipient* (TC-16) should be fine.
2. **RPID is pinned to `onlyagent.app`** in BOTH firmware (`okcrypto_xwing_web_derive`)
   and CLI (`derived_xwing.RPID`). If the web app derives under any other origin
   (e.g. `apps.crp.to`), CLI↔web keys **will not match** — TC-18/19 fail. Confirm
   the web app’s derive origin is `onlyagent.app`.
3. **Label→tag convention is `SHA256(utf8(label))`** (CLI `derived_label_tag`).
   The web app must fold the **same 32 bytes** into its derive request for the
   same identity, or the two derive different keys. This is the single most
   likely interop mismatch after RPID.
4. **ML-KEM seed expansion must agree everywhere**: `SHAKE256(seed,64)` → `(d,z)`
   → `keygen_internal`. kyber-py↔@noble verified byte-identical in software;
   confirm the **firmware** agrees on-device (a 1-byte disagreement = decrypt
   fails silently with a wrong key).
5. **No decrypt over FIDO2.** The device only ever returns pubkeys and
   shared-secret halves; ML-KEM decapsulation happens in the browser/host. If you
   see the device trying to accept a full 1120-byte ciphertext on the *derived*
   path, that's wrong — derived only sends `ct_X` (32 B).
6. **Two PQC systems coexist** and must not collide: composite **PGP-PQC** lives
   in RSA slots 1–4 (`okpqc.*`, section D); **X-Wing** (slot + derived) lives in
   `okcrypto_xwing_*`. Watch for duplicate-symbol / dispatch confusion at build
   (TC-01) and at runtime.

---

## Reporting
For each TC, capture: command output, device behavior (LED/button prompts),
and any errors. File failures with the repo, the `master` SHA under test, exact
command, and full output. Use the companion **OnlyKey-PQC-Test-Report.md**.
