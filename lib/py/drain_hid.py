"""Drains any stale queued HID input reports before a different CLI tool
opens the same device - see TC-13 GPG investigation in TEST-PLAN.md.

Root cause: python-onlykey's read_bytes()/read_string() (client.py) use a
short 100ms read timeout; if a device response arrives slightly late, the
caller gives up and moves on, but the report still lands in Linux's
per-device (not strictly per-fd) hidraw kernel buffer - so it can sit there
until whatever process opens the device *next* reads it, corrupting an
unrelated request with old data. Observed live: onlykey-testing's
checkStatus()-based unlock-confirmation loop (lib/device.js, several
`onlykey-cli settime` round-trips) left the literal "UNLOCKEDv3.0.4-testc"
status string sitting in the queue, and onlykey-agent's very next requests
(getpubkey, OKSIGN) read that stale string back instead of real key/
signature bytes - producing a corrupted OpenPGP key that crashed `gpg
--import` with a confusing, unrelated "out of core" error instead of any
clear failure.

Reads with a short timeout in a loop until two consecutive reads come back
empty, i.e. the queue is actually drained, not just "probably empty".
"""
import sys

from onlykey.client import OnlyKey

dev = OnlyKey()
empty_streak = 0
drained = 0
while empty_streak < 3 and drained < 20:
    data = dev._hid.read(64, timeout_ms=500)
    if data:
        drained += 1
        empty_streak = 0
    else:
        empty_streak += 1
dev.close()
print(f"drained {drained} stale report(s)", file=sys.stderr)
