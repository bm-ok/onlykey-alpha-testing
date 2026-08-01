// Loads onlykey.github.io's vendored PQC-aware openpgp.js fork in Node.
//
// The web app's openpgp_loader.js does the same job via webpack's
// `raw-loader!`, which does not exist outside a bundle. The vendored file is a
// plain script (`var openpgp = (function(exports){...})({})`) with no
// module.exports, so require() would yield an empty object either way - it has
// to be evaluated and the binding returned explicitly. python-onlykey's
// openpgp_bridge/bridge.js already does exactly this with readFileSync.
//
// Deliberately reads the web app's copy by relative path rather than keeping a
// second one here: a divergent duplicate of the crypto under test would be
// worse than useless.

const fs = require('fs');
const path = require('path');

const VENDORED_OPENPGP = path.resolve(
    __dirname,
    '..', '..', '..',
    'onlykey.github.io', 'src', 'onlykey-fido2', 'onlykey', 'vendor', 'openpgp', 'openpgp.js'
);

function loadOpenpgp() {
    if (!fs.existsSync(VENDORED_OPENPGP)) {
        throw new Error(`Vendored openpgp.js not found at ${VENDORED_OPENPGP}`);
    }
    const source = fs.readFileSync(VENDORED_OPENPGP, 'utf8');
    // eslint-disable-next-line no-new-func
    return new Function(`${source}\n;return openpgp;`)();
}

module.exports = { loadOpenpgp, VENDORED_OPENPGP };
