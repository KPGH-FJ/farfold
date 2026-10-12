"""Check the actual metadata-refresh correction; retain byte-identical native checks."""
import importlib.util
import json
import re
import sys
from pathlib import Path
sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("history_refresh_checks", BASE / "run-checks.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
r = module.runner
ADDED = ["src/runtime/session_index_refresh.ts", "src/runtime/sessions.index-refresh.test.ts"]
DELTA = sorted(ADDED + ["src/runtime/sessions.ts"])
ORIGINAL_DELTA = sorted(DELTA + [".prettierignore", "src/components/HistorySearchPanel.test.tsx", "src/components/HistorySearchPanel.tsx"])
def main():
    out = BASE / "run-03"
    out.mkdir(exist_ok=False)
    original_path = BASE / "run-01/verification.json"
    original = json.loads(original_path.read_text())
    previous_path = BASE / "run-02/verification.json"
    previous_record = json.loads(previous_path.read_text())
    original_inputs = json.loads((original_path.parent / "inputs-after.json").read_text())
    previous_inputs = json.loads((previous_path.parent / "inputs-after.json").read_text())
    before = r.inputs()
    changed = sorted(p for p in previous_inputs.keys() | before.keys() if previous_inputs.get(p) != before.get(p))
    original_changed = sorted(p for p in original_inputs.keys() | before.keys() if original_inputs.get(p) != before.get(p))
    assert original["sourceStable"] and original["protectedUnchanged"] and not original["changedInputs"]
    assert previous_record["sourceStable"] and previous_record["allSevenCommandsHavePassingEvidence"]
    assert changed == DELTA and original_changed == ORIGINAL_DELTA
    assert set(before) - set(original_inputs) == set(ADDED) and not set(original_inputs) - set(before)
    reused = [c for c in original["checks"] if c["name"] in ("cargo-fmt", "clippy", "rust")]
    assert len(reused) == 3 and all(c["exitCode"] == 0 and c["executedInThisRun"] for c in reused)
    assert all(r.sha(r.ROOT / c["log"]) == c["sha256"] for c in reused)
    assert r.protected()
    r.write(out / "inputs-before.json", before)
    commands = [("typecheck", ["corepack", "pnpm", "typecheck"]), ("frontend", ["corepack", "pnpm", "test"]), ("build", ["corepack", "pnpm", "build"]), ("format", ["corepack", "pnpm", "format:check"])]
    checks = [r.execute(out, name, argv) for name, argv in commands]
    after = r.inputs()
    r.write(out / "inputs-after.json", after)
    raw = re.sub(r"\x1b\[[0-9;]*m", "", (out / "frontend.txt").read_text())
    counts = [line.strip() for line in raw.splitlines() if re.match(r"\s*(Test Files|Tests)\s+", line)]
    record = {"status": "metadataRefreshCorrectionValidatedWithUnchangedNativeChecks", "inputCount": len(before), "sourceStable": before == after, "protectedUnchanged": r.protected(), "changedInputsSincePrevious": changed, "changedInputsSinceOriginal": original_changed, "addedInputsSinceOriginal": ADDED, "checksExecutedHere": checks, "nativeChecksReused": reused, "originalRun": {"path": str(original_path.relative_to(r.ROOT)), "sha256": r.sha(original_path)}, "previousRun": {"path": str(previous_path.relative_to(r.ROOT)), "sha256": r.sha(previous_path)}, "originalNativeSourceAndWireUnchanged": True, "allSevenCommandsHavePassingEvidence": before == after and r.protected() and all(c["exitCode"] == 0 for c in checks), "counts": {"frontend": counts, "rust": original["counts"]["rust"]}, "boundary": "Four frontend-related commands executed after shared metadata identity correction and two new frontend files. Three native commands retained on byte-identical Rust/configuration/fixture/wire inputs. Original format and installed result-loss failures remain separate; this is engineering, not installed acceptance."}
    r.write(out / "verification.json", record)
    print(json.dumps({key: record[key] for key in ("allSevenCommandsHavePassingEvidence", "counts", "inputCount")}))
    return 0 if record["allSevenCommandsHavePassingEvidence"] else 1
if __name__ == "__main__":
    raise SystemExit(main())
