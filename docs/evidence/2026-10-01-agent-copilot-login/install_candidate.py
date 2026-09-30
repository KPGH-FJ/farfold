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
roots = ["src", "public", "src-tauri/src", "src-tauri/capabilities", "src-tauri/resources", "src-tauri/icons"]
inputs = [path for root in roots for path in (repo / root).rglob("*") if path.is_file()]
inputs += [repo / name for name in ["package.json", "pnpm-lock.yaml", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json"]]
current = {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs if path.is_file()}
changed = [name for name in sorted(set(frozen) | set(current)) if frozen.get(name) != current.get(name)]
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
