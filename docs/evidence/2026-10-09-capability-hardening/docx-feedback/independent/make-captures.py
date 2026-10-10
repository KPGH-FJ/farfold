"""Materialize only the nine hash-pinned public DOCX evidence inputs.

This is a test-only ZIP reader; it is not proof of native capture defenses.
"""
from pathlib import Path
import base64
import hashlib
import json
import zipfile
OUT = Path(__file__).resolve().parent
REPO = OUT.parents[4]
original = json.loads((OUT.parent / 'fixtures/oracle.json').read_text())
extra = json.loads((OUT / 'oracle-supplement.json').read_text())
expected = {x['file']: x['sha256'] for x in original['fixtures']}
expected.update({x['file']['path']: x['file']['sha256'] for x in extra['supplement']})
result = {}
for relative, digest in expected.items():
    path = REPO / relative
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        entries = archive.namelist()
        assert len(entries) == len(set(entries))
        parts = []
        total = 0
        for name in entries:
            raw = archive.read(name)
            total += len(raw)
            if name.endswith(('.xml', '.rels')) or raw.startswith(b'\x89PNG\r\n\x1a\n') or raw.startswith(b'\xff\xd8\xff'):
                parts.append({'name': name, 'data': base64.b64encode(raw).decode()})
        assert total < 2 * 1024 * 1024
    result[path.name] = {'file': {'root': '/controlled', 'path': '/controlled/' + path.name,
                                'resolvedPath': '/controlled/' + path.name, 'name': path.name,
                                'version': 'controlled:' + digest, 'sha256': digest, 'size': path.stat().st_size},
                         'parts': parts, 'entries': entries, 'inflatedBytes': total}
raw = (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode()
path = OUT / 'captures.json'
if path.exists():
    assert json.loads(path.read_text()) == result
else:
    path.write_bytes(raw)
print(json.dumps({'fixtures': len(result), 'captureBytes': len(raw), 'nativeCaptureProven': False}))
