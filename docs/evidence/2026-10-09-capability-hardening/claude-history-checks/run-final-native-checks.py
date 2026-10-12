"""Recheck native source with test-only diagnostics; preserve both failed runs."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE / "run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "7511457423df6b3b8c22ffc28c960768221e4cd4ee10b8f611512f53415dbe2c"
spec = importlib.util.spec_from_file_location("sdk_history_diagnostic_checks", PRIOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner = module.runner
STYLE = sorted([
    "src-tauri/src/acp_client/history_search/launch.rs",
    "src-tauri/src/acp_client/history_search/source.rs",
])
DIAGNOSTIC = sorted([
    "src-tauri/src/agent_discovery.rs",
    "src-tauri/src/acp_client/preparation.rs",
])
EXPECTED = {
    "typecheck": ["corepack", "pnpm", "typecheck"],
    "frontend": ["corepack", "pnpm", "test"],
    "build": ["corepack", "pnpm", "build"],
    "format": ["corepack", "pnpm", "format:check"],
    "cargo-fmt": ["cargo", "fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"],
    "clippy": ["cargo", "clippy", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--", "-D", "warnings"],
    "rust": ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
}


def read(path):
    assert path.is_file() and not path.is_symlink()
    return json.loads(path.read_text())


def reference(path):
    return {"path": str(path.relative_to(runner.ROOT)), "sha256": runner.sha(path)}


def changed(first, second):
    assert first.keys() == second.keys()
    return sorted(k for k in first if first[k] != second[k])


def main():
    assert len(sys.argv) == 2 and sys.argv[1] == "run-03"
    original_path = BASE / "run-01/verification.json"
    previous_path = BASE / "run-02/verification.json"
    original, previous = read(original_path), read(previous_path)
    old_inputs = read(original_path.parent / "inputs-after.json")
    previous_inputs = read(previous_path.parent / "inputs-after.json")
    assert all(v["sourceStable"] and v["protectedUnchanged"] for v in (original, previous))
    assert old_inputs == read(original_path.parent / "inputs-before.json")
    assert previous_inputs == read(previous_path.parent / "inputs-before.json")
    assert changed(old_inputs, previous_inputs) == STYLE
    assert {c["name"]: c["exitCode"] for c in original["checks"]} == {
        "typecheck": 0, "frontend": 0, "build": 0, "cargo-fmt": 0,
        "clippy": 101, "rust": 0, "format": 0,
    }
    assert {c["name"]: c["exitCode"] for c in previous["checksExecutedHere"]} == {
        "cargo-fmt": 0, "clippy": 0, "rust": 101,
    }
    refs = [reference(original_path), reference(previous_path)]
    for receipt, checks in ((original_path, original["checks"]), (previous_path, previous["checksExecutedHere"])):
        for name in ("inputs-before.json", "inputs-after.json"):
            refs.append(reference(receipt.parent / name))
        for c in checks:
            path = runner.ROOT / c["log"]
            assert c["argv"] == EXPECTED[c["name"]] and c["executedInThisRun"]
            assert runner.sha(path) == c["sha256"]
            refs.append(reference(path))
    before = runner.inputs()
    assert changed(old_inputs, before) == sorted(STYLE + DIAGNOSTIC)
    assert changed(previous_inputs, before) == DIAGNOSTIC
    assert runner.protected()
    out = BASE / sys.argv[1]
    out.mkdir(exist_ok=False)
    runner.write(out / "inputs-before.json", before)
    actual = [runner.execute(out, name, EXPECTED[name]) for name in ("cargo-fmt", "clippy", "rust")]
    after = runner.inputs()
    runner.write(out / "inputs-after.json", after)
    reused = [c for c in original["checks"] if c["name"] in {"typecheck", "frontend", "build", "format"}]
    rust_counts = [line for line in (runner.ROOT / actual[-1]["log"]).read_text().splitlines() if line.startswith("test result:")]
    passed = before == after and runner.protected() and all(c["exitCode"] == 0 for c in actual)
    record = {
        "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceBase": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=runner.ROOT, text=True).strip(),
        "status": "nativeDiagnosticRecheckValidatedWithUnchangedFrontendChecks" if passed else "failed",
        "allSevenCommandsHavePassingEvidence": passed,
        "inputCount": len(before), "sourceStable": before == after,
        "changedInputs": sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k)),
        "changedInputsSinceOriginal": sorted(STYLE + DIAGNOSTIC),
        "changedInputsSincePrevious": DIAGNOSTIC,
        "protectedUnchanged": runner.protected(), "checksExecutedHere": actual,
        "frontendChecksReused": reused, "originalRun": reference(original_path),
        "previousRun": reference(previous_path), "retainedReferences": refs,
        "counts": {"frontend": original["counts"]["frontend"], "rust": rust_counts},
        "retainedFailures": {
            "run01": "Clippy exit101 on two equivalent-style issues; original six passing commands retained.",
            "run02": "Rust exit101: second validate in existing cancelled_selection_does_not_start_program_version_check returned Node version unavailable. Isolated unchanged-code sample passed; concrete original cause remains unlocated.",
            "run02BoundaryErratum": "Original numeric/status fields correctly say failed. Its fixed-template boundary first sentence incorrectly asserted all seven passing evidence; do not use that sentence as a success claim. Original receipt preserved unchanged.",
            "diagnosticChanges": "Test-only fixed cause/exit/errno/eof/byte diagnostics; no production behavior/deadline/return or assertion relaxation. Later green does not prove original failure repaired.",
        },
        "boundary": ("All seven commands have actual passing evidence." if passed else "Final native recheck failed; no all-seven success claim.") + " Three native commands executed after test-only diagnostic enrichment; four frontend checks retained on byte-identical frontend/configuration/fixture/wire inputs. Original failures and erratum are retained. Controlled engineering does not establish actual official SDK, installed App, Windows or whole P32 acceptance.",
    }
    module.prior_write(out / "verification.json", record)
    print(json.dumps({k: record[k] for k in ("status", "allSevenCommandsHavePassingEvidence", "inputCount", "counts")}), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
