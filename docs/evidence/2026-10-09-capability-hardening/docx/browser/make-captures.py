"""Controlled fixture materializer, not Farfold's archive reader. Public inputs only."""
from pathlib import Path
import json, zipfile, base64, hashlib
base = Path(__file__).resolve().parents[2]
data = {}
for folder in ['docx-fixtures', 'docx-compatibility', 'docx/public-samples']:
    for path in sorted((base / folder).glob('*.docx')):
        if folder == 'docx-fixtures' and int(path.name[:2]) > 19:
            continue
        with zipfile.ZipFile(path) as archive:
            parts, total = [], 0
            for name in archive.namelist():
                raw = archive.read(name)
                total += len(raw)
                if name.lower().endswith(('.xml', '.rels')) or raw.startswith(b'\x89PNG\r\n\x1a\n') or raw.startswith(b'\xff\xd8\xff'):
                    parts.append(dict(name=name, data=base64.b64encode(raw).decode()))
            data[folder + '/' + path.stem] = dict(file=dict(root='/authored', path='/authored/' + path.name, resolvedPath='/authored/' + path.name, name=path.name, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), version='synthetic-' + path.stem, size=path.stat().st_size), parts=parts, entries=archive.namelist(), inflatedBytes=total)
(base / 'docx/browser/captures.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
