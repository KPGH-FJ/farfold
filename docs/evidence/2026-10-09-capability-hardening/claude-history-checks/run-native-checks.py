"""Recheck native inputs after two equivalent Clippy corrections; keep run-01."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE / "run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "7511457423df6b3b8c22ffc28c960768221e4cd4ee10b8f611512f53415dbe2c"
spec = importlib.util.spec_from_file_location("sdk_history_final_checks", PRIOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner = module.runner
DELTA = sorted([
    "src-tauri/src/acp_client/history_search/launch.rs",
    "src-tauri/src/acp_client/history_search/source.rs",
])


def read(path):
    return json.loads(path.read_text())


def reference(path):
    return {"path": str(path.relative_to(runner.ROOT)), "sha256": runner.sha(path)}


def main():
    assert len(sys.argv) == 2 and sys.argv[1] == "run-02"
    original_path = BASE / "run-01/verification.json"
    original = read(original_path)
    old_inputs = read(original_path.parent / "inputs-after.json")
    assert original["sourceStable"] and original["protectedUnchanged"]
    assert old_inputs == read(original_path.parent / "inputs-before.json")
    assert len(original["checks"]) == 7
    assert {c["name"]: c["exitCode"] for c in original["checks"]} == {
        "typecheck": 0, "frontend": 0, "build": 0, "cargo-fmt": 0,
        "clippy": 101, "rust": 0, "format": 0,
    }
    original_refs = [reference(original_path)]
    for c in original["checks"]:
        path = runner.ROOT / c["log"]
        assert runner.sha(path) == c["sha256"] and c["executedInThisRun"]
        original_refs.append(reference(path))
    before = runner.inputs()
    assert before.keys() == old_inputs.keys()
    assert sorted(k for k in before if before[k] != old_inputs[k]) == DELTA
    assert runner.protected()
    out = BASE / sys.argv[1]
    out.mkdir(exist_ok=False)
    runner.write(out / "inputs-before.json", before)
    commands = [
        ("cargo-fmt", ["cargo", "fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"]),
        ("clippy", ["cargo", "clippy", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--", "-D", "warnings"]),
        ("rust", ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"]),
    ]
    actual = [runner.execute(out, name, argv) for name, argv in commands]
    after = runner.inputs()
    runner.write(out / "inputs-after.json", after)
    reused = [c for c in original["checks"] if c["name"] in {"typecheck", "frontend", "build", "format"}]
    rust_counts = [line for line in (runner.ROOT / actual[-1]["log"]).read_text().splitlines() if line.startswith("test result:")]
    passed = before == after and runner.protected() and all(c["exitCode"] == 0 for c in actual)
    record = {
        "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "nativeLintCorrectionValidatedWithUnchangedFrontendChecks" if passed else "failed",
        "allSevenCommandsHavePassingEvidence": passed,
        "inputCount": len(before), "sourceStable": before == after,
        "changedInputs": sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k)),
        "changedInputsSinceOriginal": DELTA, "protectedUnchanged": runner.protected(),
        "checksExecutedHere": actual, "frontendChecksReused": reused,
        "originalRun": reference(original_path), "originalReferences": original_refs,
        "counts": {"frontend": original["counts"]["frontend"], "rust": rust_counts},
        "boundary": "All seven commands have actual passing evidence. Three native commands rerun after two equivalent Clippy corrections; four frontend commands retained on byte-identical frontend/configuration/fixture/wire inputs. The complete original run, including Clippy exit 101, remains immutable. No actual official SDK, installed App, Windows or whole P32 acceptance is inferred.",
    }
    module.prior_write(out / "verification.json", record)
    print(json.dumps({k: record[k] for k in ("status", "allSevenCommandsHavePassingEvidence", "inputCount", "counts")}), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
