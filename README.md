# onlykey-testing

Automated test suite for OnlyKey firmware + CLI + web app, driving a real
physical device over its DEBUG-serial button-injection channel. No human
button presses required for any test in this repo.

See [TEST-PLAN.md](TEST-PLAN.md) for the full test matrix, design
principles, and a detailed log of every firmware/CLI bug found and fixed
while building this suite out.

## Setup

Repos this suite depends on are expected as siblings of this directory:

```
onlykey/
  arduino-1.6.5-r5-teensy_127/   # firmware sketch (make docker-build)
  libraries/                     # firmware library sources (okcore.cpp, okcrypto.cpp, fido2/, ...)
  python-onlykey/                # onlykey-cli, age-plugin-onlykey
  lib-agent/                     # onlykey-agent, onlykey-gpg (SSH/GPG derived-key tooling)
  okpqc-venv/                    # Python venv with the above installed editable
  onlykey-testing/                # this repo
```

`okpqc-venv`'s editable installs:

```bash
okpqc-venv/bin/pip install -e ../python-onlykey -e ../lib-agent -e ../lib-agent/agents/onlykey
```

```bash
npm install
```

`FIDO2Client/` and `node-onlykey-fido2/` (if present as siblings) are
optional, read-only reference clones used while developing the FIDO2 tests
- not required to run this suite. The actual runtime FIDO2 client
(`@vincss-public-projects/fido2-client` in `package.json`) is pulled from
GitHub directly via `npm install`.

Requires a physical OnlyKey (6-button dev board / Classic / Color - not
DUO) connected over USB, with its DEBUG-serial (SEREMU) HID interface
enabled in the flashed firmware build.

**Reflashing the firmware wipes the device back to factory defaults** (no
PIN set, `checkStatus()` reports `uninitialized`) - confirmed live, a fresh
`make docker-build` + reflash is indistinguishable from a brand-new device
as far as this suite is concerned. Every test in this repo other than
`test/00-setup.test.js` assumes a PIN is already set, so re-run initial
setup (see below) after every reflash before running anything else.

A reflash also resets `derived_key_challenge_mode` ("derived keys per site
without touch") back to off, but `.derived-key-challenge-mode-cache.json`
(written by `lib/gui_helpers.js`'s `setDerivedKeyChallengeMode()` to avoid
needlessly re-entering config mode) doesn't know that - confirmed live,
this caused a real false-negative (cached "already 8" skipped re-enabling
it on a freshly-reflashed device that actually needed it). Delete that
cache file after a reflash, or just delete it whenever a GUI test
inexplicably gets `CTAP2_ERR_EXTENSION_NOT_SUPPORTED`.

## Running

```bash
npx mocha
```

Setup (`test/00-setup.test.js`) is conditional: if the device is already
initialized, it skips straight to whatever's next. To run initial PIN
setup against a genuinely fresh/wiped device (this sets real PINs,
including a self-destruct PIN, on the physical device):

```bash
ONLYKEY_CONFIRM_SETUP=yes npx mocha
```

To run a single spec file in isolation (bypassing `.mocharc.json`'s glob,
which otherwise unions with any file you pass on the command line):

```bash
echo '{"timeout": 30000, "slow": 10000}' > /tmp/empty.mocharc.json
npx mocha --config /tmp/empty.mocharc.json test/01-pqc-keygen.test.js
```

## Design principle

- **OnlyKey-App (Electron GUI)**: not driven headlessly. Instead, *emulate*
  it - send the same HID commands `OnlyKeyWizard.js`/`OnlyKeyComm.js` send,
  or fall back to `lib/hid.js`'s `SeremuChannel` (simulated button presses)
  for anything DEBUG-only with no app equivalent.
- **CLI tooling** (`onlykey-cli`, `age-plugin-onlykey`, `onlykey-agent`,
  `onlykey-gpg`): already scriptable - shell out to the real binaries
  directly (`child_process`/`execFile`/`spawn`), never reimplement their
  protocol.
- **Device-facing calls are bounded and response-driven**: every
  device-facing wait should cap out around 30 seconds and proceed based on
  an actual response/status from the device, not a blind `sleep()` guess.
  A genuinely wedged device and a slow-but-working call look identical from
  the outside otherwise - a hard timeout plus a real response is what tells
  them apart.

Full rationale in [TEST-PLAN.md](TEST-PLAN.md).

## Layout

- `lib/hid.js` - low-level `SeremuChannel`: opens the DEBUG-serial HID
  interface, sends simulated button presses, waits for matching debug
  output.
- `lib/device.js` - `OnlyKeyDevice`: setup/unlock flows built on `hid.js`.
- `lib/pqc_keygen.js` - drives `age-plugin-onlykey`'s PQC keygen, which
  requires the device to be in config mode and blocks on a 3-button
  confirmation challenge; injects the confirm presses automatically by
  parsing them out of the CLI's own stderr. Also exports the shared
  `enterConfigModeConfirmed()`/`unlockAndConfirm()` helpers most other
  device-facing tests build on.
- `lib/pqc_decrypt.js` - drives the age encrypt(host)/decrypt(device)
  round-trip for slot-based X-Wing identities.
- `lib/gpg_init.js` - drives `onlykey-gpg init` end-to-end, scraping and
  answering its 3-digit challenge live from stdout.
- `lib/age_pqc.js` - host-side X-Wing/ML-KEM math (recipient building,
  encapsulation, the derived split-decapsulation combiner) - the JS twin of
  `python-onlykey`'s `derived_xwing.py`, verified byte-for-byte identical
  against a fixed vector generated from the Python reference.
- `lib/fido2/` - a from-scratch (not copy-pasted) FIDO2/CTAP2 client built
  on `@vincss-public-projects/fido2-client`, covering both the OKCONNECT
  vendor-command-smuggling transport onlyagent.app's browser flow uses
  (`client.js`'s `ctaphidViaWebauthn()`/`deriveXwing()`) and genuine
  standard WebAuthn ceremonies (`makeCredential`/`getAssertion` directly).
- `lib/config.js` - shared test PINs, repo/venv paths.
- `lib/py/` - small Python helpers shelled out to from Node for things
  `python-onlykey`'s own client already implements correctly (PIN-advance
  messages, HID buffer draining, fixture/vector generation) rather than
  reimplementing them in JS.
- `test/` - Mocha specs, one file per feature area; see
  [TEST-PLAN.md](TEST-PLAN.md) for which maintainer test case(s) each file
  covers.
