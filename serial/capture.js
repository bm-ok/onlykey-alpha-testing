// AI/agent-friendly HID capture tool for OnlyKey.
//
// Unlike serial.js (a colored, interactive REPL hard-wired to interface 2),
// this discovers every CRYPTOTRUST/ONLYKEY HID interface present, logs each
// report as a plain, timestamped, labeled line (hex + best-effort ASCII) to
// both stdout and a log file, and exits after a fixed duration by default so
// the resulting log file can just be handed to an AI for triage.
//
// Usage:
//   node capture.js [--duration <seconds>] [--send "<text>"] [--interactive]
//
//   --duration N     Capture for N seconds then exit (default 10). Ignored
//                     in --interactive mode (runs until Ctrl+C instead).
//   --send "<text>"  Send a text command to the client/SEREMU interface
//                     (report ID 0x00 prefix, matching serial.js) after
//                     interfaces are found, then keep capturing.
//   --interactive    Also open a readline prompt so a human can type
//                     commands to send, same as serial.js used to.

const fs = require('fs');
const path = require('path');
const nodeHID = require('node-hid');

const INTERFACE_NAMES = {
    0: 'keyboard',
    1: 'client',  // RawHID  - main command/response channel
    2: 'debug',   // RawHID2 - hidprint()/RawHID.send2() debug channel
    3: 'seremu',  // Serial-emulation text console
};

function interfaceLabel(ifaceNum) {
    const name = INTERFACE_NAMES[ifaceNum];
    return name ? `${ifaceNum} ${name}` : `iface-${ifaceNum}`;
}

function toHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function toAscii(bytes) {
    return Array.from(bytes)
        .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
        .join('');
}

function formatReport(ifaceNum, data) {
    const bytes = Array.from(data);
    return `${new Date().toISOString()} [${interfaceLabel(ifaceNum)}] ${toHex(bytes)} (${bytes.length} bytes)  ascii: "${toAscii(bytes)}"`;
}

function parseArgs(argv) {
    const args = { duration: 10, send: null, interactive: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--duration') {
            args.duration = Number(argv[++i]);
        } else if (a === '--send') {
            args.send = argv[++i];
        } else if (a === '--interactive') {
            args.interactive = true;
        }
    }
    return args;
}

class Logger {
    constructor(logDir) {
        fs.mkdirSync(logDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.join(logDir, `capture-${stamp}.log`);
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    }

    line(text) {
        process.stdout.write(text + '\n');
        this.stream.write(text + '\n');
    }

    close() {
        this.stream.end();
    }
}

class Capture {
    constructor(logger) {
        this.logger = logger;
        this.opened = new Map(); // interface number -> node-hid HID handle
    }

    scan() {
        const devices = nodeHID.devices().filter(
            (d) => d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY'
        );
        for (const device of devices) {
            if (this.opened.has(device.interface)) continue;
            this.open(device);
        }
    }

    open(device) {
        let handle;
        try {
            handle = new nodeHID.HID(device.path);
        } catch (e) {
            return; // interface busy or not readable yet, retry on next scan
        }
        this.opened.set(device.interface, handle);
        this.logger.line(`${new Date().toISOString()} [${interfaceLabel(device.interface)}] connected (path=${device.path})`);
        handle.on('data', (data) => {
            this.logger.line(formatReport(device.interface, data));
        });
        handle.on('error', (err) => {
            this.logger.line(`${new Date().toISOString()} [${interfaceLabel(device.interface)}] disconnected (${err.message})`);
            this.opened.delete(device.interface);
        });
    }

    send(ifaceNum, text) {
        const handle = this.opened.get(ifaceNum);
        if (!handle) {
            this.logger.line(`${new Date().toISOString()} [${interfaceLabel(ifaceNum)}] cannot send, interface not connected`);
            return;
        }
        const bytes = [0x00]; // report ID prefix, matching serial.js
        for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
        bytes.push('\n'.charCodeAt(0));
        handle.write(bytes);
        this.logger.line(`${new Date().toISOString()} >> sent to [${interfaceLabel(ifaceNum)}]: ${text}`);
    }

    closeAll() {
        for (const handle of this.opened.values()) {
            try { handle.close(); } catch (e) { /* already gone */ }
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const logger = new Logger(path.join(__dirname, 'logs'));
    const capture = new Capture(logger);

    logger.line(`${new Date().toISOString()} capture started (duration=${args.interactive ? 'until Ctrl+C' : args.duration + 's'})`);

    capture.scan();
    const scanTimer = setInterval(() => capture.scan(), 500);

    if (args.send !== null) {
        // Give newly-discovered interfaces a moment to open before sending.
        setTimeout(() => capture.send(3, args.send), 750);
    }

    function shutdown() {
        clearInterval(scanTimer);
        capture.closeAll();
        logger.line(`${new Date().toISOString()} capture stopped`);
        logger.line(`log file: ${logger.filePath}`);
        logger.close();
        process.exit(0);
    }

    if (args.interactive) {
        const readline = require('readline');
        const rl = readline.createInterface(process.stdin, process.stdout);
        rl.on('line', (line) => {
            if (line.trim().length) capture.send(3, line);
        });
        rl.on('close', shutdown);
        process.on('SIGINT', () => rl.close());
    } else {
        process.on('SIGINT', shutdown);
        setTimeout(shutdown, args.duration * 1000);
    }
}

main();
