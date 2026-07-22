#!/usr/bin/env python3
# Sends a bare OKSETPIN/OKSETPDPIN/OKSETSDPIN message (no payload) to advance
# the firmware's PIN-entry state machine, mirroring what OnlyKeyWizard.js
# does on Classic hardware (OnlyKeyComm.js: sendSetPin/sendSetPin2/sendSetSDPin)
# instead of waiting on the firmware's internal 20s inactivity timer
# (fadeoffafter20sec(), okcore.cpp) to advance it.
import sys

from onlykey.client import OnlyKey, Message

MESSAGES = {
    "primary": Message.OKSETPIN,
    "secondary": Message.OKSETPDPIN,
    "sd": Message.OKSETSDPIN,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in MESSAGES:
        print(f"usage: {sys.argv[0]} <{'|'.join(MESSAGES)}>", file=sys.stderr)
        sys.exit(2)
    OnlyKey().send_message(msg=MESSAGES[sys.argv[1]])


if __name__ == "__main__":
    main()
