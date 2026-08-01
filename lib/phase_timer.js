// Per-phase wall-clock timing for the long device tests.
//
// Mocha reports one duration per `it()`, which for TC-11 is a single number
// covering a key generation, two config-mode cycles (four device restarts), a
// browser round trip per chunk and four button challenges. That number says a
// run is slow without saying which part is slow, so every discussion about
// cutting the runtime has been guesswork.
//
// Usage:
//     const t = phaseTimer('TC-11');
//     await t.time('generate key', () => clickGenerateAndCollect());
//     ...
//     t.report();   // prints the table, slowest first
//
// Deliberately does nothing clever: no sampling, no nesting, no output unless
// report() is called. A timing helper that can fail is worse than no timing.
function phaseTimer(label) {
    const phases = [];
    const started = Date.now();

    async function time(name, fn) {
        const t0 = Date.now();
        try {
            return await fn();
        } finally {
            phases.push({ name, ms: Date.now() - t0 });
        }
    }

    // For phases that aren't a single call - mark() closes the previous span.
    let markedAt = started;
    function mark(name) {
        phases.push({ name, ms: Date.now() - markedAt });
        markedAt = Date.now();
    }

    function report() {
        const total = Date.now() - started;
        const rows = phases.slice().sort((a, b) => b.ms - a.ms);
        const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
        console.log(`\n[${label}] phase timing - total ${(total / 1000).toFixed(1)}s`);
        for (const r of rows) {
            const pct = total ? ((r.ms / total) * 100).toFixed(0) : '0';
            console.log(`  ${r.name.padEnd(width)}  ${(r.ms / 1000).toFixed(1)}s  ${pct.padStart(3)}%`);
        }
        const accounted = phases.reduce((s, r) => s + r.ms, 0);
        console.log(`  ${'(unaccounted)'.padEnd(width)}  ${((total - accounted) / 1000).toFixed(1)}s`);
        return { total, phases: rows };
    }

    return { time, mark, report, phases };
}

module.exports = { phaseTimer };
