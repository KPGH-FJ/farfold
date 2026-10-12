"""Native recheck after atomic test-fixture readiness; preserve prior failures."""
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
spec = importlib.util.spec_from_file_location("sdk_history_fixture_checks", PRIOR)
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
FIXTURE = ["src-tauri/src/acp_client/extension_inventory/skills_lifecycle_tests.rs"]
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
    assert len(sys.argv) == 2 and sys.argv[1] == "run-04"
    earlier, inputs, refs = [], [], []
    for name in ("run-01", "run-02", "run-03"):
        path = BASE / name / "verification.json"
        record = read(path)
        assert record["sourceStable"] and record["protectedUnchanged"]
        before, after = [read(path.parent / x) for x in ("inputs-before.json", "inputs-after.json")]
        assert before == after and record["changedInputs"] == []
        checks = record["checks"] if name == "run-01" else record["checksExecutedHere"]
        expected_exits = ({k: 101 if k == "clippy" else 0 for k in EXPECTED} if name == "run-01" else {"cargo-fmt": 0, "clippy": 0, "rust": 101})
        assert {c["name"]: c["exitCode"] for c in checks} == expected_exits
        refs.append(reference(path))
        refs.extend(reference(path.parent / x) for x in ("inputs-before.json", "inputs-after.json"))
        for c in checks:
            p = runner.ROOT / c["log"]
            assert c["argv"] == EXPECTED[c["name"]] and c["executedInThisRun"]
            assert p == path.parent / (c["name"] + ".txt") and runner.sha(p) == c["sha256"]
            refs.append(reference(p))
        earlier.append(record)
        inputs.append(before)
    assert changed(inputs[0], inputs[1]) == STYLE
    assert changed(inputs[1], inputs[2]) == DIAGNOSTIC
    before = runner.inputs()
    assert changed(inputs[2], before) == FIXTURE
    assert changed(inputs[0], before) == sorted(STYLE + DIAGNOSTIC + FIXTURE)
    assert runner.protected()
    out = BASE / sys.argv[1]
    out.mkdir(exist_ok=False)
    runner.write(out / "inputs-before.json", before)
    actual = [runner.execute(out, name, EXPECTED[name]) for name in ("cargo-fmt", "clippy", "rust")]
    after = runner.inputs()
    runner.write(out / "inputs-after.json", after)
    reused = [
        {**c, "executedInThisRun": False, "executedInOriginalRun": True, "executionRun": "run-01"}
        for c in earlier[0]["checks"]
        if c["name"] in {"typecheck", "frontend", "build", "format"}
    ]
    rust_counts = [line for line in (runner.ROOT / actual[-1]["log"]).read_text().splitlines() if line.startswith("test result:")]
    passed = before == after and runner.protected() and all(c["exitCode"] == 0 for c in actual)
    record = {
        "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceBase": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=runner.ROOT, text=True).strip(),
        "status": "nativeFixtureCorrectionValidatedWithUnchangedFrontendChecks" if passed else "failed",
        "allSevenCommandsHavePassingEvidence": passed, "inputCount": len(before),
        "sourceStable": before == after, "protectedUnchanged": runner.protected(),
        "changedInputs": sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k)),
        "changedInputsSinceOriginal": sorted(STYLE + DIAGNOSTIC + FIXTURE),
        "changedInputsSincePrevious": FIXTURE,
        "checksExecutedHere": actual, "frontendChecksReused": reused,
        "originalRun": reference(BASE / "run-01/verification.json"),
        "intermediateRun": reference(BASE / "run-02/verification.json"),
        "previousRun": reference(BASE / "run-03/verification.json"),
        "retainedReferences": refs,
        "counts": {"frontend": earlier[0]["counts"]["frontend"], "rust": rust_counts},
        "retainedFailures": {
            "run01": "Clippy101; two equivalent style corrections.",
            "run02": "Old cancellation fixture returned Node version unavailable; exact isolated sample and later full-suite sample passed, but original concrete cause remains unlocated. Test-only diagnostics were added; no production fix claim.",
            "run03": "Old skills lifecycle fixture parsed an empty PID before cancellation. Producer made the final marker visible before writing the PID; two same-file peers now write and close a temporary marker before atomic replacement. Original assertion/deadline/production semantics retained.",
            "run02BoundaryErratum": "Numeric/status fields correctly said failed; its fixed-template first sentence wrongly asserted all seven passing evidence. Original remains unchanged and is not success proof.",
            "reuseFlagErratum": "run02/run03 copied original check objects retained executedInThisRun=true under frontendChecksReused; this final record explicitly marks those four checks executedInThisRun=false, executedInOriginalRun=true and executionRun=run-01. Original receipts remain unchanged.",
        },
        "boundary": ("All seven commands have actual passing evidence." if passed else "Native recheck failed; no all-seven success claim.") + " Three native commands executed after atomic test-fixture readiness correction. Four frontend commands retained on byte-identical frontend/configuration/fixture/wire inputs; changes are exactly five enumerated native files. Original failures and source manifests remain immutable. No actual official SDK, installed App, Windows or whole P32 acceptance is inferred.",
    }
    module.prior_write(out / "verification.json", record)
    print(json.dumps({k: record[k] for k in ("status", "allSevenCommandsHavePassingEvidence", "inputCount", "counts")}), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
