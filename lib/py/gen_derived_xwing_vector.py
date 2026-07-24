"""Regenerates test/fixtures/derived-xwing-vector.json from fixed inputs, using
python-onlykey's derived_xwing.py/xwing.py as the reference implementation the
JS port (lib/age_pqc.js) is checked against for byte-for-byte cross-language
agreement, not just internal self-consistency. Run with VENV_BIN's python3
(python-onlykey installed editable there via project-setup.sh):

    ./okpqc-venv/bin/python lib/py/gen_derived_xwing_vector.py > test/fixtures/derived-xwing-vector.json
"""
import base64
import json

from onlykey.age_plugin import derived_xwing as dx
from onlykey.age_plugin import xwing

# Fixed inputs (deterministic - not from a real device, just fixed bytes)
sk_x = bytes(range(32))                      # fixed X25519 "device" private scalar
mlkem_seed = bytes([0xAA] * 32)               # fixed ML-KEM seed
pk_x = xwing.x25519_scalarmult_base(sk_x)

recipient = dx.build_recipient(pk_x, mlkem_seed)
ss_enc, ct = xwing.xwing_encaps_host(recipient)

ct_x = dx.ct_x_of(ct)
ss_x = xwing.x25519_scalarmult(sk_x, ct_x)
ss_dec = dx.split_decapsulate(ss_x, ct, pk_x, mlkem_seed)

assert ss_dec == ss_enc, "python self-check failed"

pk_m, sk_m = dx.mlkem_keypair_from_seed(mlkem_seed)

vector = {
    "sk_x": base64.b64encode(sk_x).decode(),
    "pk_x": base64.b64encode(pk_x).decode(),
    "mlkem_seed": base64.b64encode(mlkem_seed).decode(),
    "pk_m": base64.b64encode(bytes(pk_m)).decode(),
    "recipient": base64.b64encode(recipient).decode(),
    "ciphertext": base64.b64encode(ct).decode(),
    "ct_x": base64.b64encode(ct_x).decode(),
    "ss_x": base64.b64encode(ss_x).decode(),
    "shared_secret": base64.b64encode(ss_enc).decode(),
}

print(json.dumps(vector, indent=2))
