"""Reuse the nine candidate checks with exact archive engineering follow-up evidence."""
import hashlib
import importlib.util
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent
PRIOR = OUT.parent / "skill-management-candidate/verify-candidate.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "babc09057ab144137771918cf05ef97ad0ff6f6d545c398a6e6eec8172d1e51b"
spec = importlib.util.spec_from_file_location("archive_candidate_checks", PRIOR)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
checks.OUT = OUT
checks.BASELINE_COMMIT = "8cfb2ccb58a4154219505a324e92e1a5af0d4500"
checks.BASELINE = OUT.parent / "mcp-http-add-candidate/candidate.json"
checks.BASELINE_SHA = "761230f77c1528b8f21af61d001fa11db930b3ca3c56d2aae8c9761e8568ca8b"
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
    )
]


def arguments():
    checks.need(len(sys.argv) == 3 and re.fullmatch("[0-9a-f]{40}", sys.argv[1]), "Expected exact commit and engineering path")
    proof = checks.relative(sys.argv[2])
    checks.need(proof == checks.BASE / "attachment-archive-checks/final-verification.json", "Wrong engineering proof")
    return sys.argv[1], proof


def archive_path(commit):
    return checks.ROOT / f"src-tauri/target/internal-candidate/2026-10-12-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip"


def engineering(path, inputs):
    final = checks.read(path)
    checks.need(final["status"] == "sevenChecksPassedWithNarrowFormattingFollowup" and final["allSevenCommandsHavePassingEvidence"] is True and final["protectedUnchanged"] is True, "Incomplete final engineering evidence")
    checks.need(final["inputCount"] == len(inputs) and final["changedInputsAfterFullRun"] == [".prettierignore"] and final["productSourceUnchangedSinceFullChecks"] is True, "Wrong source follow-up boundary")
    refs = {str(path.relative_to(checks.ROOT)): checks.sha(path)}

    def referenced(value):
        p = checks.relative(value["path"])
        checks.need(p.is_relative_to(checks.BASE) and checks.sha(p) == value["sha256"], "Engineering reference drift")
        refs[value["path"]] = value["sha256"]
        return p

    original_path = referenced(final["originalRun"])
    original = checks.read(original_path)
    before_path = original_path.parent / "inputs-before.json"
    after_path = original_path.parent / "inputs-after.json"
    before, after = checks.read(before_path), checks.read(after_path)
    checks.need(original["sourceStable"] is True and original["protectedUnchanged"] is True and original["changedInputs"] == [] and before == after, "Original inputs were unstable")
    checks.need(set(before) == set(inputs) and [name for name in inputs if before[name] != inputs[name]] == [".prettierignore"], "Product inputs changed since original checks")
    for p in (before_path, after_path):
        refs[str(p.relative_to(checks.ROOT))] = checks.sha(p)
    checks.need(checks.read(referenced(final["finalInputs"])) == inputs, "Final inputs differ from commit")
    passed = final["successfulCommands"]
    checks.need(len(passed) == 6 and {item["name"] for item in passed} == set(checks.COMMANDS) - {"format"}, "Wrong six reused commands")
    checks.need(len(original["checks"]) == 7 and {item["name"] for item in original["checks"]} == set(checks.COMMANDS), "Original seven commands incomplete")
    for item in passed:
        checks.need(item in original["checks"] and item["argv"] == checks.COMMANDS[item["name"]] and item["exitCode"] == 0 and item["executedInThisRun"] is True, "Reused command did not pass")
        p = referenced({"path": item["log"], "sha256": item["sha256"]})
        checks.need(p.parent == original_path.parent, "Wrong reused log directory")
    followup_path = referenced(final["formatFollowup"])
    followup = checks.read(followup_path)
    checks.need(followup["command"] == checks.COMMANDS["format"] and followup["exitCode"] == 0, "Formatting follow-up did not pass")
    referenced(followup["log"])
    referenced(final["originalFailureBytesPreserved"])
    return {"receipt": str(path.relative_to(checks.ROOT)), "sha256": checks.sha(path), "inputCount": len(inputs), "references": refs, "boundary": "Six source checks reused on identical product inputs; formatting passed after only the recorded .prettierignore change. No commands claimed rerun."}


checks.arguments = arguments
checks.archive_path = archive_path
checks.engineering = engineering
for name in dir(checks):
    if not name.startswith("_"):
        globals()[name] = getattr(checks, name)

if __name__ == "__main__":
    raise SystemExit(main())
