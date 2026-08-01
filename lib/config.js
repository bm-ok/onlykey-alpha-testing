const path = require('path');

// Test PINs for the disposable hardware this suite drives. Buttons are 1-6
// only (6 capacitive touch buttons), so PIN digits are restricted to 1-6.
// All three must be distinct - the firmware chains primary -> secondary ->
// self-destruct PIN entry as one continuous setup flow.
const PINS = {
    primary: '1111111',
    secondary: '2222222',
    selfDestruct: '6666666',
};

// Repo root is the parent of this testing repo - all sibling repos hang off it.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENV_BIN = path.join(REPO_ROOT, 'okpqc-venv', 'bin');

// The one wait budget in this suite: 5 seconds with NO RESPONSE.
//
// It is an inactivity cap, not a total cap. An operation that keeps making
// observable progress - a chunk arriving, a status line changing - may take as
// long as it needs; thirty seconds of silence is a failure. That distinction
// is what lets the budget be short: a total cap has to be sized for the
// slowest legitimate operation (a 3309-byte ML-DSA-65 signature retrieved in
// seven chunks), whereas an inactivity cap only has to be sized for the
// longest legitimate GAP, which is far smaller and does not grow with payload
// size.
//
// Device-side work is milliseconds and a poll round trip is ~370ms measured, so
// five seconds of total silence already means wedged, not busy. Longer values
// were padding for slow OPERATIONS - but a slow operation still answers while
// it works (pending status, a chunk), and every one of those answers re-arms
// this budget. Sizing it for the operation instead of for the silence is what
// turned a wedged device into a two-minute wait.
const NO_RESPONSE_TIMEOUT_MS = 5000;

module.exports = { PINS, REPO_ROOT, VENV_BIN, NO_RESPONSE_TIMEOUT_MS };
