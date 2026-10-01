"""Temporarily move only this evidence slice's exact, verified plain-text file."""
import datetime
import hashlib
import json
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
target = json.loads((base / "target.json").read_text())
action = sys.argv[1]
assert action in ("hide", "restore")
original, held = Path(target["file"]), Path(target["heldFile"])
source, destination = (original, held) if action == "hide" else (held, original)
owned = Path(target["ownedDirectory"])
receipt = base / f"file-{action}.json"
assert not receipt.exists()
assert not owned.is_symlink() and owned.resolve() == owned
assert source.parent == owned and destination.parent == owned
assert source.is_file() and not source.is_symlink()
assert not destination.exists() and not destination.is_symlink()
content = source.read_bytes()
assert len(content) == target["bytes"]
assert hashlib.sha256(content).hexdigest() == target["sha256"]
source.rename(destination)
assert not source.exists() and destination.is_file()
assert hashlib.sha256(destination.read_bytes()).hexdigest() == target["sha256"]
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "action": action, "from": str(source), "to": str(destination),
    "bytes": len(content), "sha256": target["sha256"],
    "originalExists": original.exists(), "heldExists": held.exists(),
}
receipt.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
