"""Replace only the formal app, requiring a stopped app and a matching source freeze."""
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
repo = base.parents[2]
candidate = sys.argv[1]
source = base / f"{candidate}-source.json"
frozen = json.loads(source.read_text())["files"]
changed = [name for name, value in frozen.items() if hashlib.sha256((repo / name).read_bytes()).hexdigest() != value]
if changed:
    raise SystemExit(f"Frozen source changed: {changed}")
commands = subprocess.check_output(["ps", "-axo", "comm="], text=True).splitlines()
if "/Applications/Farfold.app/Contents/MacOS/farfold" in [line.strip() for line in commands]:
    raise SystemExit("Formal app is still running")
built = repo / "src-tauri/target/release/bundle/macos/Farfold.app"
installed = Path("/Applications/Farfold.app")
subprocess.run(["ditto", str(built), str(installed)], check=True)
expected = {
    str(path.relative_to(built)): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in built.rglob("*") if path.is_file()
}
actual = {
    str(path.relative_to(installed)): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in installed.rglob("*") if path.is_file()
}
differences = [name for name in sorted(set(expected) | set(actual)) if expected.get(name) != actual.get(name)]
signature = subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(installed)], capture_output=True, text=True)
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "sourceManifest": source.name,
    "path": str(installed),
    "binarySHA256": actual["Contents/MacOS/farfold"],
    "files": actual,
    "copyDifferences": differences,
    "signatureExitCode": signature.returncode,
    "signatureOutput": signature.stdout + signature.stderr,
}
(base / f"{candidate}-install.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
if differences or signature.returncode:
    raise SystemExit(1)
