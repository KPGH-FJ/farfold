"""Reuse nine read-only candidate checks for the frozen history-search increment."""
import hashlib
import importlib.util
from pathlib import Path
import re
import sys
sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent
PRIOR = OUT.parent / "skill-management-candidate/verify-candidate.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "babc09057ab144137771918cf05ef97ad0ff6f6d545c398a6e6eec8172d1e51b"
spec = importlib.util.spec_from_file_location("history_search_candidate_checks", PRIOR)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
checks.OUT = OUT
checks.BASELINE_COMMIT = "a5a24810fd494a9f31e69881c74c55ca2d1fbd49"
checks.BASELINE = OUT.parent / "attachment-archive-candidate/candidate.json"
checks.BASELINE_SHA = "32a237585cec8085f776f654f094632d829322e02d3c44157b95f01882d8ef69"
checks.TOP += [
    "docs/evidence/2026-10-09-capability-hardening/" + suffix
    for suffix in (
        "mcp-management/backend/actual-wire.json",
        "mcp-management/backend/final-wire.json",
        "mcp-add/backend/actual-wire.json",
        "mcp-remove/backend/actual-wire.json",
        "mcp-http-add/backend/actual-wire.json",
        "attachment-archive/backend/actual-wire.json",
        "attachment-archive/backend/canonical-wire.json",
        "history-search/backend/actual-wire.json",
        "history-search/backend/final-wire.json",
    )
]
def arguments():
    checks.need(len(sys.argv) == 3 and re.fullmatch("[0-9a-f]{40}", sys.argv[1]), "Expected exact commit and engineering path")
    proof = checks.relative(sys.argv[2])
    checks.need(proof == checks.BASE / "history-search-checks/run-02/verification.json", "Wrong engineering proof")
    return sys.argv[1], proof

def archive_path(commit):
    return checks.ROOT / f"src-tauri/target/internal-candidate/2026-10-12-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip"
def engineering(path, inputs):
    final = checks.read(path)
    checks.need(final["status"] == "frontendCorrectionValidatedWithUnchangedNativeChecks" and final["allSevenCommandsHavePassingEvidence"] is True and final["sourceStable"] is True and final["protectedUnchanged"] is True, "Incomplete final engineering evidence")
    checks.need(final["inputCount"] == len(inputs) and final["originalNativeSourceAndWireUnchanged"] is True, "Wrong final input boundary")
    expected_changed = [".prettierignore", "src/components/HistorySearchPanel.test.tsx", "src/components/HistorySearchPanel.tsx"]
    checks.need(final["changedInputsSinceOriginal"] == expected_changed, "Unexpected source follow-up")
    refs = {str(path.relative_to(checks.ROOT)): checks.sha(path)}
    def referenced(value):
        p = checks.relative(value["path"])
        checks.need(p.is_relative_to(checks.BASE) and checks.sha(p) == value["sha256"], "Engineering reference drift")
        refs[value["path"]] = value["sha256"]
        return p
    original_path = referenced(final["originalRun"])
    original = checks.read(original_path)
    original_before_path, original_after_path = [original_path.parent / name for name in ("inputs-before.json", "inputs-after.json")]
    original_before, original_after = checks.read(original_before_path), checks.read(original_after_path)
    checks.need(original["sourceStable"] is True and original["protectedUnchanged"] is True and original["changedInputs"] == [] and original_before == original_after, "Original inputs unstable")
    checks.need(set(original_before) == set(inputs) and sorted(name for name in inputs if original_before[name] != inputs[name]) == expected_changed, "Native inputs or wires changed")
    for p in (original_before_path, original_after_path):
        refs[str(p.relative_to(checks.ROOT))] = checks.sha(p)
    for name in ("inputs-before.json", "inputs-after.json"):
        p = path.parent / name
        checks.need(checks.read(p) == inputs, "Final frozen source differs")
        refs[str(p.relative_to(checks.ROOT))] = checks.sha(p)
    actual, reused = final["checksExecutedHere"], final["nativeChecksReused"]
    checks.need(len(actual) == 4 and {v["name"] for v in actual} == {"typecheck", "frontend", "build", "format"}, "Four final frontend commands missing")
    checks.need(len(reused) == 3 and {v["name"] for v in reused} == {"cargo-fmt", "clippy", "rust"}, "Three native commands missing")
    checks.need(len(original["checks"]) == 7 and {v["name"] for v in original["checks"]} == set(checks.COMMANDS), "Original seven commands incomplete")
    for item in actual + reused:
        checks.need(item["argv"] == checks.COMMANDS[item["name"]] and item["exitCode"] == 0 and item["executedInThisRun"] is True, "Command did not pass as specified")
        p = referenced({"path": item["log"], "sha256": item["sha256"]})
        checks.need(p.parent == (path.parent if item in actual else original_path.parent), "Wrong actual/reused log scope")
        checks.need(item in actual or item in original["checks"], "Reused check is not original")
    for item in original["checks"]:
        referenced({"path": item["log"], "sha256": item["sha256"]})
    return {"receipt": str(path.relative_to(checks.ROOT)), "sha256": checks.sha(path), "inputCount": len(inputs), "references": refs, "boundary": "Four frontend commands rerun after two React files changed; three native checks reused on byte-identical Rust/configuration/fixture/wire inputs. Original seven run and format failure retained."}

checks.engineering = engineering
checks.arguments = arguments
checks.archive_path = archive_path
for name in dir(checks):
    if not name.startswith("_"):
        globals()[name] = getattr(checks, name)
if __name__ == "__main__":
    raise SystemExit(main())
