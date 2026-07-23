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
  arduino-1.6.5-r5-teensy_127/   # firmware
  0c-coder-python-onlykey/       # onlykey-cli, age-plugin-onlykey (correct fork - see below)
  okpqc-venv/                    # Python venv with the above installed editable
  onlykey-testing/                # this repo
```

There are two `python-onlykey` clones in this directory tree:
`0c-coder-python-onlykey` is the one that matches the build under test
(`OnlyKey-PQC-Test-Report.md`'s header table, master SHA `68c1c84` at time
of writing) - it has the composite-PGP-PQC and derived-X-Wing work that
`python-onlykey` (the original clone) doesn't. `okpqc-venv`'s editable
`onlykey` install must point at `0c-coder-python-onlykey`:

```bash
okpqc-venv/bin/pip install -e ../0c-coder-python-onlykey
```

```bash
npm install
```

Requires a physical OnlyKey (6-button dev board / Classic / Color - not
DUO) connected over USB, with its DEBUG-serial (SEREMU) HID interface
enabled in the flashed firmware build.

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
echo '{}' > /tmp/empty.mocharc.json
npx mocha --config /tmp/empty.mocharc.json test/01-pqc-keygen.test.js
```

## Design principle

- **OnlyKey-App (Electron GUI)**: not driven headlessly. Instead, *emulate*
  it - send the same HID commands `OnlyKeyWizard.js`/`OnlyKeyComm.js` send,
  or fall back to `lib/hid.js`'s `SeremuChannel` (simulated button presses)
  for anything DEBUG-only with no app equivalent.
- **CLI tooling** (`onlykey-cli`, `age-plugin-onlykey`, `onlykey-agent`):
  already scriptable - shell out to the real binaries directly
  (`child_process`/`execFile`/`spawn`), never reimplement their protocol.

Full rationale in [TEST-PLAN.md](TEST-PLAN.md).

## Layout

- `lib/hid.js` - low-level `SeremuChannel`: opens the DEBUG-serial HID
  interface, sends simulated button presses, waits for matching debug
  output.
- `lib/device.js` - `OnlyKeyDevice`: setup/unlock flows built on `hid.js`.
- `lib/pqc_keygen.js` - drives `age-plugin-onlykey`'s PQC keygen, which
  requires the device to be in config mode and blocks on a 3-button
  confirmation challenge; injects the confirm presses automatically by
  parsing them out of the CLI's own stderr.
- `lib/config.js` - shared test PINs, repo paths.
- `lib/py/pin_advance.py` - thin wrapper around `python-onlykey`'s own
  `OnlyKey`/`Message` classes for the bare `OKSETPIN`/`OKSETPDPIN`/
  `OKSETSDPIN` messages used during setup.
- `test/` - Mocha specs, one file per feature area.
