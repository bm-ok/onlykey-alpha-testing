"""Fetches an X-Wing recipient for a slot and validates it cryptographically
before printing it - getpubkey can still occasionally return a well-formed
but content-corrupted key (same length, wrong bytes; see TC-04 finding #12
in TEST-PLAN.md) even after the transport packet-loss fix (finding #11), so
a length check alone isn't enough. Exit codes: 0 = ok (recipient on
stdout), 1 = truncated read, 2 = read the wrong content (failed modulus
validation), matching what onlykey-testing/test/03-pqc-decrypt.test.js's
retry loop expects.
"""
import sys

from onlykey.age_plugin.onlykey_hid import OnlyKeyPQ, XWING_PK_SIZE
from onlykey.age_plugin.cli import encode_recipient, wrap_callback

slot = int(sys.argv[1])
dev = OnlyKeyPQ()
pk = dev.xwing_getpubkey(slot)
if len(pk) != XWING_PK_SIZE:
    print(f"Error: got {len(pk)} bytes, expected {XWING_PK_SIZE}", file=sys.stderr)
    sys.exit(1)

recipient = encode_recipient(pk)
try:
    wrap_callback([recipient], [], [(0, b"0" * 16)])
except Exception as exc:
    print(f"Error: recipient failed cryptographic validation: {exc}", file=sys.stderr)
    sys.exit(2)

print(recipient)
