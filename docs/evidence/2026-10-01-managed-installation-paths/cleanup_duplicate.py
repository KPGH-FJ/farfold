"""Remove this candidate's exact build duplicate after matching the formal app."""
import datetime
import hashlib
import json
import shutil
from pathlib import Path

base = Path(__file__).resolve().parent
repo = base.parents[2]
built = repo / "src-tauri/target/release/bundle/macos/Farfold.app"
formal = Path("/Applications/Farfold.app")
receipt = json.loads((base / "candidate-install.json").read_text())
if (base / "duplicate-app-cleanup.json").exists():
    raise SystemExit("Cleanup receipt already exists")
if built.is_symlink() or not built.is_dir():
    raise SystemExit("Expected exact build directory is not present")


def files(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


expected = receipt["files"]
actual = files(formal)
duplicate = files(built)
if expected != actual or expected != duplicate:
    raise SystemExit("Candidate, formal app and build duplicate differ")
shutil.rmtree(built)
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "removed": str(built),
    "matchedFiles": expected,
    "duplicateExists": built.exists(),
    "formalPreserved": files(formal) == actual,
    "binarySHA256": actual["Contents/MacOS/farfold"],
}
(base / "duplicate-app-cleanup.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
