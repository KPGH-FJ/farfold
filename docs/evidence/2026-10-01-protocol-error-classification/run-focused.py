#!/usr/bin/env python3
"""Run only a named controlled Rust group and retain its exact exit receipt."""
import datetime
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
name, test_filter = sys.argv[1:]
command = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", test_filter, "--", "--nocapture"]
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
with (HERE / f"{name}.log").open("w") as output:
    result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=False)
receipt = {"command": command, "cwd": str(ROOT), "startedAt": started,
           "endedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "exitCode": result.returncode, "log": f"{name}.log",
           "scope": "controlled fixtures only; no installed app or official Agent"}
(HERE / f"{name}.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(receipt, ensure_ascii=False))
raise SystemExit(result.returncode)
