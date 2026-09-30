"""Observe only bounded public bundle metadata while a managed candidate exists."""
import datetime
import json
import plistlib
import stat
import subprocess
import sys
import time
from pathlib import Path

base = Path(__file__).resolve().parent
destination = base / sys.argv[1]
if destination.exists():
    raise SystemExit("Refusing to overwrite an observation")
parent = Path.home() / "Library/Application Support/ai.farfold.desktop/agents/registry:junie"
started = datetime.datetime.now().astimezone().isoformat()
deadline = time.monotonic() + min(float(sys.argv[2]) if len(sys.argv) > 2 else 60, 60)
observed = {}
while True:
    try:
        candidates = list(parent.iterdir())[:32]
    except FileNotFoundError:
        candidates = []
    for root in candidates:
        try:
            if root.resolve() != root or not root.is_dir():
                continue
            app = root / "Applications/junie.app"
            binary = app / "Contents/MacOS/junie"
            info = app / "Contents/Info.plist"
            if binary.resolve() != binary or info.resolve() != info or not binary.is_file():
                continue
            attributes = binary.stat()
            snapshot = {"root": str(root), "entry": str(binary), "bytes": attributes.st_size,
                        "mode": oct(stat.S_IMODE(attributes.st_mode)), "publicBundle": {}}
            if info.is_file() and info.stat().st_size <= 65536:
                try:
                    plist = plistlib.loads(info.read_bytes())
                    snapshot["publicBundle"] = {
                        key: value for key in ["CFBundleIdentifier", "CFBundleExecutable", "CFBundleShortVersionString", "CFBundleVersion"]
                        if isinstance(value := plist.get(key), str) and len(value) <= 256
                    }
                except (ValueError, plistlib.InvalidFileException):
                    pass
            key = str(root)
            previous = observed.get(key)
            if previous is None or previous["snapshot"] != snapshot:
                record = {"at": datetime.datetime.now().astimezone().isoformat(), "snapshot": snapshot}
                # Static system inspection, never execute the candidate program.
                result = subprocess.run(["/usr/bin/file", "-b", str(binary)], capture_output=True, text=True, timeout=2)
                record["fileDescription"] = result.stdout.strip()[:512]
                record["fileExitCode"] = result.returncode
                observed[key] = record
        except (FileNotFoundError, ProcessLookupError):
            continue
    if time.monotonic() >= deadline:
        break
    time.sleep(0.25)
result = {"started": started, "finished": datetime.datetime.now().astimezone().isoformat(),
          "scope": "Latest sampled public bundle metadata; not proof of executed bytes or complete archive contents",
          "candidates": list(observed.values())}
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"file": destination.name, "candidatesObserved": len(observed)}))
