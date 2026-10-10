"""Hash-checked synthetic writer ZIP -> mocked capture bytes, not native IO proof."""
from pathlib import Path
import base64, hashlib, json, zipfile
base = Path(__file__).resolve().parent
fixtures = base.parent / "fixtures"
manifest = json.loads((fixtures / "manifest.json").read_text())
result = {}
for name, expected in manifest["files"].items():
    source = fixtures / name
    assert hashlib.sha256(source.read_bytes()).hexdigest() == expected["sha256"]
    with zipfile.ZipFile(source) as package:
        assert package.testzip() is None
        data = {i.filename: package.read(i) for i in package.infolist()}
    result[name] = {
        "sha256": expected["sha256"], "bytes": source.stat().st_size,
        "entries": list(data), "inflatedBytes": sum(map(len, data.values())),
        "parts": [{"name": k, "data": base64.b64encode(v).decode()} for k, v in data.items() if k.endswith((".xml", ".rels"))],
    }
(base / "capture-data.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({name: {"sha256": v["sha256"], "bytes": v["bytes"], "entries": len(v["entries"]), "inflatedBytes": v["inflatedBytes"]} for name, v in result.items()}, indent=2))
