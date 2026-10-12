"""Verify the small frontend correction; retain exact unchanged Rust checks."""
import importlib.util
import json
import re
import sys
from pathlib import Path
sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("history_frontend_checks", BASE / "run-checks.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
r = module.runner
CHANGED = [".prettierignore", "src/components/HistorySearchPanel.test.tsx", "src/components/HistorySearchPanel.tsx"]
def main():
    out = BASE / "run-02"
    out.mkdir(exist_ok=False)
    original_path = BASE / "run-01/verification.json"
    original = json.loads(original_path.read_text())
    previous = json.loads((original_path.parent / "inputs-after.json").read_text())
    before = r.inputs()
    changed = sorted(p for p in previous.keys() | before.keys() if previous.get(p) != before.get(p))
    assert original["sourceStable"] and original["protectedUnchanged"] and not original["changedInputs"]
    assert changed == CHANGED and previous.keys() == before.keys()
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
    record = {"status": "frontendCorrectionValidatedWithUnchangedNativeChecks", "inputCount": len(before), "sourceStable": before == after, "protectedUnchanged": r.protected(), "changedInputsSinceOriginal": changed, "checksExecutedHere": checks, "nativeChecksReused": reused, "originalRun": {"path": str(original_path.relative_to(r.ROOT)), "sha256": r.sha(original_path)}, "originalNativeSourceAndWireUnchanged": True, "allSevenCommandsHavePassingEvidence": before == after and r.protected() and all(c["exitCode"] == 0 for c in checks), "counts": {"frontend": counts, "rust": original["counts"]["rust"]}, "boundary": "Four frontend-related commands executed after two React files changed. Three native commands retained on byte-identical Rust/configuration/fixture/wire inputs. Original format failure and its narrow correction remain separate; this is engineering, not real Agent or installed acceptance."}
    r.write(out / "verification.json", record)
    print(json.dumps({key: record[key] for key in ("allSevenCommandsHavePassingEvidence", "counts", "inputCount")}))
    return 0 if record["allSevenCommandsHavePassingEvidence"] else 1
if __name__ == "__main__":
    raise SystemExit(main())
