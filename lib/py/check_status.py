"""Minimal, direct device-status probe - bypasses onlykey-cli's argument-
parsing/subcommand `main()` entirely (same pattern drain_hid.py already
uses: construct `onlykey.client.OnlyKey` directly, call only the one method
needed). Exists because `onlykey-cli` should only ever be invoked from this
harness in tests that are actually exercising the CLI itself (setpqc,
storedkeymode, derivedkeymode - real onlykey-cli subcommands TC-11/TC-16
etc. need to verify) - not as a general-purpose "ask the device what state
it's in" utility called from the harness's own internal plumbing
(checkStatus()/waitForDeviceReady()/ensureUnlocked(), device.js). Using the
full onlykey-cli executable for that conflated two different things: CLI
correctness (worth testing) and device state (needed constantly, unrelated
to CLI correctness) - and when onlykey-cli's own module-import-time
`OnlyKey()` construction (cli.py line ~30) hit its pre-existing `_connect()`
HID-enumeration race (confirmed live this session: `AttributeError: 'OnlyKey'
object has no attribute '_hid'`), the resulting crash was indistinguishable
from a real device problem in every status check across the whole harness -
wasted real debugging time chasing a phantom "device is broken" when it was
just this unrelated, already-known CLI-construction race.

Replicates exactly what the `settime` subcommand does internally
(only_key.set_time(time.time()); print(only_key.read_string())) - same
proven-working mechanism (a write is genuinely required to elicit a
response; the device doesn't proactively push status), just without the
CLI wrapper's overhead (argparse setup, its own atexit handler, etc.)
around it.

One deliberate deviation from `settime`'s own call: read_string()'s
default read timeout is 100ms (client.py). Confirmed live this session (by
reading OnlyKey.ino directly) that a LOCKED device does not answer
OKSETTIME/OKCONNECT (okcore.cpp's set_time() has no branch at all for
unlocked==false - it silently returns nothing) - the "INITIALIZED" string
locked-state detection actually depends on is a periodic, independent
firmware task (`Task taskInitialized(1000, sendInitialized)`,
OnlyKey.ino) that broadcasts "INITIALIZED" over the main HID interface
once every 1000ms purely because the device is locked, NOT as a reply to
anything this script sends. So a short read timeout has a real chance of
landing in the gap between two broadcasts and missing it entirely - not a
round-trip-latency problem, a "did my read window overlap the next
1-second broadcast" problem. Set comfortably above 1000ms so a single call
reliably spans at least one full broadcast regardless of phase.
"""
import sys
import time

from onlykey.client import OnlyKey

READ_TIMEOUT_MS = 2500

try:
    dev = OnlyKey()
    dev.set_time(time.time())
    print(dev.read_string(timeout_ms=READ_TIMEOUT_MS))
except Exception as e:
    print(f'{type(e).__name__}: {e}', file=sys.stderr)
    sys.exit(1)
finally:
    try:
        dev.close()
    except Exception:
        pass
