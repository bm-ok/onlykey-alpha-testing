// Low-level HID access to an OnlyKey's DEBUG-serial (SEREMU) channel.
//
// This talks to HID interface 3 (serial-emulation text console), the same
// interface ../serial/capture.js and ../serial/serial.js use interactively.
// It exists here as a promise-based module so Mocha tests can drive it
// programmatically instead of a human typing into a REPL.

const nodeHID = require('node-hid');

const SEREMU_INTERFACE = 3;

function findSeremuDevice() {
    const devices = nodeHID.devices().filter(
        (d) => d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY' && d.interface === SEREMU_INTERFACE
    );
    return devices[0] || null;
}

// Whether any interface of the OnlyKey currently enumerates over USB - used
// by TC-07 to detect a real physical unplug/replug rather than trusting a
// fixed delay.
function isOnlyKeyPresent() {
    return nodeHID.devices().some((d) => d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY');
}

// Any interface, not just SEREMU - used by TC-07 to detect a real physical
// unplug/replug (device vanishing from HID enumeration entirely), as
// opposed to findSeremuDevice()'s narrower "is the debug channel specifically
// up" check.
function isOnlyKeyPresent() {
    return nodeHID.devices().some((d) => d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY');
}

class SeremuChannel {
    constructor() {
        this.handle = null;
        this.buffer = '';
        this.waiters = []; // { matcher, resolve, reject, timer }
    }

    // Opens the SEREMU interface, retrying while the device enumerates
    // (e.g. right after a firmware-triggered CPU_RESTART()). During
    // CPU_RESTART() the OS can briefly still list the pre-reset device node
    // (or hand back a handle that goes stale mid-enumeration) - open()
    // succeeding is not proof the handle is actually usable, so a dummy
    // zero-payload write is used as a liveness probe before trusting it.
    async connect({ retries = 20, retryDelayMs = 500 } = {}) {
        for (let attempt = 0; attempt < retries; attempt++) {
            const device = findSeremuDevice();
            if (device) {
                try {
                    this.handle = new nodeHID.HID(device.path);
                    // liveness probe - 2 bytes is the minimum write size this
                    // hidraw report accepts (1 byte => EINVAL regardless of
                    // device state); 0x00 data byte matches none of the
                    // firmware's DEBUG dispatch cases, so it's a no-op.
                    this.handle.write([0x00, 0x00]);
                    this._attachListeners();
                    return this;
                } catch (e) {
                    // interface exists but not usable yet (still enumerating) - retry
                    if (this.handle) {
                        try { this.handle.close(); } catch (_) { /* already gone */ }
                        this.handle = null;
                    }
                }
            }
            await sleep(retryDelayMs);
        }
        throw new Error('Could not open OnlyKey SEREMU (debug serial) interface - is it plugged in?');
    }

    _attachListeners() {
        this.handle.on('data', (data) => {
            const text = Array.from(data)
                .filter((b) => b !== 0)
                .map((b) => String.fromCharCode(b))
                .join('');
            this.buffer += text;
            this._checkWaiters();
        });
        this.handle.on('error', () => {
            this.handle = null;
        });
    }

    _checkWaiters() {
        this.waiters = this.waiters.filter((w) => {
            const match = this.buffer.match(w.matcher);
            if (match) {
                clearTimeout(w.timer);
                w.resolve(match);
                return false;
            }
            return true;
        });
    }

    // Resolves once the accumulated debug output matches `matcher` (a RegExp
    // or substring), or rejects after timeoutMs. Does not clear the buffer -
    // callers that want a clean slate should call clearBuffer() first.
    waitFor(matcher, timeoutMs = 5000) {
        const re = matcher instanceof RegExp ? matcher : new RegExp(escapeRegExp(matcher));
        const existing = this.buffer.match(re);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w.timer !== timer);
                reject(new Error(`Timed out waiting for /${re.source}/ in debug output`));
            }, timeoutMs);
            this.waiters.push({ matcher: re, resolve, reject, timer });
        });
    }

    clearBuffer() {
        this.buffer = '';
    }

    // How many times `matcher` occurs in the accumulated debug output.
    countMatches(matcher) {
        const re =
            matcher instanceof RegExp
                ? new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : `${matcher.flags}g`)
                : new RegExp(escapeRegExp(matcher), 'g');
        return (this.buffer.match(re) || []).length;
    }

    // Resolves once `matcher` has occurred at least `count` times, rejecting
    // after timeoutMs. waitFor() only models a first match, which is not
    // enough when the device emits one acknowledgement per byte sent and the
    // caller needs to know the whole burst has been consumed. Polls rather
    // than extending the waiter list, since the waiters are matched against
    // the whole buffer on every inbound report anyway.
    async waitForCount(matcher, count, timeoutMs = 8000, pollMs = 20) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const seen = this.countMatches(matcher);
            if (seen >= count) return seen;
            if (Date.now() >= deadline) {
                throw new Error(
                    `Timed out after ${timeoutMs}ms waiting for ${count} occurrences of ${matcher} in debug output (saw ${seen})`
                );
            }
            await sleep(pollMs);
        }
    }

    // Sends one or more raw bytes in a single HID report (report ID 0x00
    // prefix, matching serial.js). The firmware's DEBUG parser reads one
    // byte per loop iteration regardless of how many arrived per USB report,
    // so a digit byte + its terminator byte can be sent together here.
    send(bytes) {
        if (!this.handle) throw new Error('SEREMU channel not connected');
        this.handle.write([0x00, ...bytes]);
    }

    sendByte(byte) {
        this.send([byte]);
    }

    close() {
        if (this.handle) {
            try { this.handle.close(); } catch (e) { /* already gone */ }
            this.handle = null;
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { SeremuChannel, findSeremuDevice, isOnlyKeyPresent, sleep };
