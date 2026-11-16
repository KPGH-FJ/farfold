"""Explicit one-time test-binary build; never part of ordinary frontend CI."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import time

ROOT = Path("/Users/tw/Desktop/farfold")
OUT = ROOT / "output/2026-11-04-p01-storage-bridge"
DRIVER = "meta_store::recovery_tests::explicit_frontend_storage_bridge"
RUN = Path(tempfile.mkdtemp(prefix="build-", dir=OUT))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot():
    files = set((ROOT / "src-tauri/src").rglob("*.rs"))
    files.update((ROOT / "src-tauri/native").rglob("*.m"))
    files.update(ROOT / name for name in [
        "package.json", "pnpm-lock.yaml", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
        "src-tauri/build.rs", "src/runtime/drafts.ts", "src/runtime/draft_storage.ts",
        "src/runtime/storage_recovery.ts", "vitest.config.ts",
    ])
    files.update(OUT / name for name in ["frontend-storage-bridge.test.ts", "vitest.config.mts", "build-driver.py"])
    return {path.relative_to(ROOT).as_posix(): sha(path) for path in sorted(files)}


def save(name, value):
    with (RUN / name).open("x") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    (RUN / name).chmod(0o600)


before = snapshot()
save("source-before.json", {"files": before})
command = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--lib", "--no-run", "--message-format=json"]
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
clock = time.monotonic()
with (RUN / "cargo-no-run.stdout.jsonl").open("xb") as stdout, (RUN / "cargo-no-run.stderr.log").open("xb") as stderr:
    result = subprocess.run(command, cwd=ROOT, stdout=stdout, stderr=stderr)
after = snapshot()
save("source-after.json", {"files": after})
changes = [name for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)]
save("cargo-no-run.result.json", {"command": command, "startedAt": started, "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "durationSeconds": round(time.monotonic() - clock, 3), "naturalExitCode": result.returncode, "sourceChangesAtEndpoints": changes})
if result.returncode:
    raise SystemExit(result.returncode)
assert not changes, "Inputs changed; keep original evidence and review the actual scope"
artifacts = []
for line in (RUN / "cargo-no-run.stdout.jsonl").read_text().splitlines():
    row = json.loads(line)
    if row.get("reason") == "compiler-artifact" and row.get("profile", {}).get("test") and row.get("target", {}).get("name") == "farfold_lib" and row.get("executable"):
        artifacts.append(row)
assert len(artifacts) == 1
artifact = artifacts[0]
binary = Path(artifact["executable"])
assert binary.parent == ROOT / "src-tauri/target/debug/deps" and binary.is_file() and not binary.is_symlink()
listing = subprocess.run([str(binary), DRIVER, "--exact", "--ignored", "--list"], cwd=ROOT, capture_output=True, text=True, timeout=10)
(RUN / "ignored-driver-list.stdout.log").write_text(listing.stdout)
(RUN / "ignored-driver-list.stderr.log").write_text(listing.stderr)
assert listing.returncode == 0 and f"{DRIVER}: test" in listing.stdout and "1 test, 0 benchmarks" in listing.stdout
current = OUT / "driver-binding-exit.json"
previous = None
if current.exists() or current.is_symlink():
    assert stat.S_ISREG(current.lstat().st_mode) and not current.is_symlink()
    original = current.read_bytes()
    preserved = RUN / "previous-driver-binding-exit.json"
    with preserved.open("xb") as stream:
        stream.write(original)
    preserved.chmod(0o600)
    previous = {"path": str(preserved.relative_to(ROOT)), "sha256": hashlib.sha256(original).hexdigest()}
binding = {"driverName": DRIVER, "executable": str(binary), "executableSha256": sha(binary), "defaultIgnoredVerified": True, "ignoredListNaturalExitCode": listing.returncode, "artifactTarget": artifact["target"], "artifactProfile": artifact["profile"], "sourceInputs": len(after), "sourceEndpointHashesMatch": True, "buildDirectory": str(RUN.relative_to(ROOT)), "previousBindingPreserved": previous, "scope": "Explicit current-host test build only; no app, Agent, installed validation or all-platform freeze claim."}
save("driver-binding-exit.json", binding)
staged = OUT / f".driver-binding-{RUN.name}.json"
with staged.open("xb") as stream:
    stream.write((RUN / "driver-binding-exit.json").read_bytes())
staged.chmod(0o600)
os.replace(staged, current)
print(json.dumps({"naturalExitCode": 0, "executable": str(binary), "defaultIgnoredVerified": True, "sourceInputs": len(after), "buildDirectory": str(RUN.relative_to(ROOT)), "binding": str(current.relative_to(ROOT))}))
