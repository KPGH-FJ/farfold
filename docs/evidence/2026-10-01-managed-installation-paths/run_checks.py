"""Record checked command exits and complete raw output for this candidate."""
import datetime
import json
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
repo = base.parents[2]
group = sys.argv[1]
label = sys.argv[2] if len(sys.argv) > 2 else group
commands = {
    "frontend": [
        ["corepack", "pnpm", "typecheck"],
        ["corepack", "pnpm", "run", "test", "--maxWorkers=4"],
        ["corepack", "pnpm", "build"],
    ],
    "rust": [
        # Frozen source already passed cargo fmt --check; see fmt.json.
        ["cargo", "clippy", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--", "-D", "warnings"],
        ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
    ],
    "format": [["corepack", "pnpm", "format:check"]],
    "bundle": [["corepack", "pnpm", "tauri:build:internal"]],
}[group]
results = []
for index, command in enumerate(commands):
    log = base / f"{label}-{index}.log"
    started = datetime.datetime.now().astimezone()
    with log.open("w") as output:
        result = subprocess.run(command, cwd=repo, stdout=output, stderr=subprocess.STDOUT)
    record = {"command": command, "started": started.isoformat(), "finished": datetime.datetime.now().astimezone().isoformat(), "exitCode": result.returncode, "log": log.name}
    results.append(record)
    receipt = base / f"checks-{label}.json"
    receipt.write_text(json.dumps(results, indent=2) + "\n")
    subprocess.run(["corepack", "pnpm", "exec", "prettier", "--write", str(receipt)], cwd=repo, stdout=subprocess.DEVNULL, check=True)
    print(json.dumps(record), flush=True)
    if result.returncode:
        print(log.read_text()[-8000:])
        raise SystemExit(result.returncode)
