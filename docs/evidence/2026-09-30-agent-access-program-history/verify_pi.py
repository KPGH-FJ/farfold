"""Compare the exact known Pi configuration files without exposing their contents."""
import datetime
import hashlib
import json
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
before = json.loads((base / "pi-external-before.json").read_text())
files = []
for item in before["files"]:
    path = Path(item["path"])
    current = {"path": str(path), "exists": path.is_file()}
    if current["exists"]:
        content = path.read_bytes()
        current.update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
    current["unchanged"] = all(current.get(key) == value for key, value in item.items())
    files.append(current)
daily = Path(before["dailyCli"]["path"])
manifest = daily.resolve().parent.parent / "package.json"
package = json.loads(manifest.read_text())
cli = {
    "path": str(daily),
    "target": str(daily.resolve()),
    "packageName": package["name"],
    "packageVersion": package["version"],
}
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "scope": before["scope"],
    "files": files,
    "dailyCli": cli,
    "dailyCliMetadataUnchanged": cli == before["dailyCli"],
}
(base / sys.argv[1]).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"filesUnchanged": all(item["unchanged"] for item in files),
                  "dailyCliMetadataUnchanged": result["dailyCliMetadataUnchanged"]}))
