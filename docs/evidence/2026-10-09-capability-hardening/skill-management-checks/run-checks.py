"""Run the seven repository checks sequentially against one frozen source set."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[3]
PROTECTED = {
    "docs/evidence/2026-10-08-reliability-ui-review/README.md":
        "2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45",
    "docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md":
        "f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7",
}
original_argv = sys.argv
try:
    sys.argv = [str(BASE.parent / "notification-media-checks/run-checks.py")]
    collect_prior_inputs = runpy.run_path(sys.argv[0])["inputs"]
finally:
    sys.argv = original_argv


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    result = collect_prior_inputs()
    wire = "docs/evidence/2026-10-09-capability-hardening/skill-management/backend/actual-wire.json"
    assert not (ROOT / wire).is_symlink()
    result[wire] = sha(ROOT / wire)
    return dict(sorted(result.items()))


def write(path, value):
    with path.open("x") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    subprocess.run(
        ["corepack", "pnpm", "exec", "prettier", "--write", str(path)],
        cwd=ROOT, stdout=subprocess.DEVNULL, check=True,
    )


def protected():
    return {path: sha(ROOT / path) for path in PROTECTED} == PROTECTED


def execute(out, name, argv):
    log = out / (name + ".txt")
    started = time.monotonic()
    with log.open("xb") as stream:
        result = subprocess.run(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
    receipt = {
        "name": name, "argv": argv, "exitCode": result.returncode,
        "seconds": round(time.monotonic() - started, 3),
        "log": str(log.relative_to(ROOT)), "sha256": sha(log),
        "executedInThisRun": True,
    }
    print(json.dumps(receipt), flush=True)
    return receipt


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"run-[0-9]{2}", sys.argv[1]):
        raise ValueError("Use one fresh run-NN directory; prior evidence is immutable")
    out = BASE / sys.argv[1]
    out.mkdir(exist_ok=False)
    assert protected(), "Unrelated protected documents changed"
    before = inputs()
    write(out / "inputs-before.json", before)
    commands = [
        ("typecheck", ["corepack", "pnpm", "typecheck"]),
        ("frontend", ["corepack", "pnpm", "test"]),
        ("build", ["corepack", "pnpm", "build"]),
        ("cargo-fmt", ["cargo", "fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"]),
        ("clippy", ["cargo", "clippy", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--", "-D", "warnings"]),
        ("rust", ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"]),
        ("format", ["corepack", "pnpm", "format:check"]),
    ]
    checks = [execute(out, name, argv) for name, argv in commands]
    after = inputs()
    write(out / "inputs-after.json", after)
    counts = {}
    for check in checks:
        if check["name"] in ("frontend", "rust"):
            raw = re.sub(r"\x1b\[[0-9;]*m", "", (ROOT / check["log"]).read_text())
            counts[check["name"]] = [
                line.strip() for line in raw.splitlines()
                if re.match(r"\s*(Test Files|Tests)\s+", line) or line.startswith("test result:")
            ]
    receipt = {
        "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceBase": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "inputCount": len(before), "sourceStable": before == after,
        "changedInputs": sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p)),
        "protectedUnchanged": protected(), "checks": checks, "counts": counts,
        "allPassed": before == after and protected() and all(c["exitCode"] == 0 for c in checks),
        "boundary": "Seven commands executed sequentially on the recorded source set, including the actual Rust skill-management wire consumed by the frontend. This is engineering evidence; it does not establish installed UI, real Agent, Windows, or full product acceptance.",
    }
    write(out / "verification.json", receipt)
    print(json.dumps({key: receipt[key] for key in ("allPassed", "counts", "inputCount")}), flush=True)
    return 0 if receipt["allPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
