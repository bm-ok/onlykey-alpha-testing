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
- **The suite behaves like a compiler: it stops at the first error.** The
  only thing a test may wait out is the device settling. Anything already
  known to have failed must end the run at the moment it becomes known - not
  after a poll loop finishes, and never by someone checking on a run in
  progress. If you find yourself polling a running test to see how it is
  doing, the test is wrong, not the checking.

  What this rules out, each of which was a real defect here:
  - Collecting page errors during a 90s DOM poll and asserting on them
    *afterwards*. Use `lib/gui_wait.js` - `armFailFast()` records the first
    page exception into `window.__guiFatal`, and `waitInPage()` breaks on it
    immediately.
  - An exception inside a promise chain that cannot reject. A throw in
    `ctaphid_via_webauthn`'s decode step skipped its `resolve()`, so the
    promise never settled and the caller waited forever with the browser's
    WebAuthn prompt on screen. Callback and decode paths must always settle.
  - Running the whole suite to exercise one spec. Use
    `npm run test:one -- <file>` (a config with no `spec` glob and
    `bail: true`); a bare `--spec` *merges* with `.mocharc.json`'s glob
    rather than replacing it, so `npx mocha test/17-...` runs all of them.

  Fail fast on what the *device* says, not on a guess: `"Error incorrect
  challenge was entered"` is transient - OKPING emits it between the last
  challenge digit landing and the result being stored - while `"Timeout
  occured while waiting for confirmation"` is the device abandoning the
  operation, and is terminal.

- **FIDO2 work is proven in Node first, then confirmed under nwjs.** Paired
  specs share a number and name the transport:

      test/17-nodejs-composite-pgp.test.js    <- build and debug here
      test/17-nwjs-composite-pgp.test.js      <- confirm here, after it passes

  Node drives the identical firmware through `lib/fido2/` with no browser, no
  page handshake and no webpack bundle in the way, so a failure names one
  variable. The GUI run takes ~55s to say less. Write the Node spec first, get
  it green, and only then reach for nwjs.

  The pair also cross-checks: a fault visible in **both** is firmware; a fault
  only nwjs shows is the page. Measured 2026-08-01 - a composite-sign
  regression read as a "browser transit-key mismatch" through nwjs, and under
  Node was plainly *both* halves failing, including the 64-byte Ed25519 one.
  That is far below any response-staging limit, which killed the buffer-size
  theory the GUI runs had pointed at for an hour.

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
