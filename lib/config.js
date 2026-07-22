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

module.exports = { PINS, REPO_ROOT, VENV_BIN };
