"""Nine read-only candidate checks. New source commit remains unconfigured.
Engineering is exact four-frontend execution plus three pinned native reuses.
Import loads helper definitions only; it never builds, installs or starts an App.
"""
import hashlib
import importlib.util
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent
PRIOR = OUT.parent / "skill-management-candidate/verify-candidate.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "babc09057ab144137771918cf05ef97ad0ff6f6d545c398a6e6eec8172d1e51b"
spec = importlib.util.spec_from_file_location("origin_fix_candidate_base", PRIOR)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
checks.OUT = OUT
checks.BASELINE_COMMIT = "63f646e748404a4499f9b92aad7efa9e3b74d93f"
checks.BASELINE = OUT.parent / "claude-history-candidate/candidate.json"
checks.BASELINE_SHA = "4c3b6a48813c9b217f04e8354b9b393b9d105698eac832b99c0e79ca7822ded4"
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
        "claude-history/backend/actual-wire.json",
    )
]
EXPECTED_COMMIT = '3bcd43dcd86713748d95f9255f2653e656772b3a'
ENGINEERING_PATH = checks.BASE / "claude-history-origin-fix/checks/run-02/verification.json"
ENGINEERING_SHA = "d4f94bd7a76b95f9db23dfc3eecd159963f36959cd1300c25ef2545bdd78be9d"
ORIGINAL_PATH = ENGINEERING_PATH.parent.parent / "verification.json"
ORIGINAL_SHA = "fbd9a6dd737ab4724ca2d09b8eba76931e91962324340368f7766c56efb2948b"
STRINGS = "src/runtime/history_search_strings.ts"
STRINGS_BEFORE = "dddebe073f30fa8d28a85d7de87d1a50cfaf578f5df0ddf0a29ced08af407b4f"
STRINGS_AFTER = "71417bd3f8569594b0db05e0c9dd70cd094a60ab36ec8988ecec3b869e604d11"
NATIVE = {"cargo-fmt", "clippy", "rust"}
FRONTEND = {"format", "typecheck", "frontend", "build"}
REUSE_REASON = "All 1577 other recorded inputs, including all backend/configuration/fixture/wire inputs, are byte-identical; the only change is the pinned frontend strings file."


def arguments():
    checks.need(isinstance(EXPECTED_COMMIT, str) and re.fullmatch("[0-9a-f]{40}", EXPECTED_COMMIT), "Preparation only: root has not pinned the new committed source")
    checks.need(len(sys.argv) == 3 and sys.argv[1] == EXPECTED_COMMIT, "Expected the exact approved source commit and proof")
    proof = checks.relative(sys.argv[2])
    checks.need(proof == ENGINEERING_PATH, "Wrong exact engineering path")
    return EXPECTED_COMMIT, proof


def archive_path(commit):
    return checks.ROOT / f"src-tauri/target/internal-candidate/2026-10-13-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip"


def baseline():
    checks.need(checks.sha(checks.BASELINE) == checks.BASELINE_SHA, "Formal baseline receipt changed")
    old = checks.read(checks.BASELINE)
    checks.need(old["sourceCommit"] == checks.BASELINE_COMMIT and old["phase"] == "internalCandidatePreparedNotInstalled", "Wrong exact 63f baseline")
    actual = checks.bundle(checks.FORMAL)
    checks.need(actual == (old["candidateFiles"], old["candidateModes"]), "Formal files/modes differ from 63f baseline")
    return actual


def engineering(path, inputs):
    checks.need(path == ENGINEERING_PATH and checks.sha(path) == ENGINEERING_SHA, "Wrong pinned run02 engineering proof")
    checks.need(checks.sha(ORIGINAL_PATH) == ORIGINAL_SHA, "Original seven-check proof changed")
    final, original = checks.read(path), checks.read(ORIGINAL_PATH)
    refs = {str(p.relative_to(checks.ROOT)): checks.sha(p) for p in (path, ORIGINAL_PATH)}

    def referenced(value, expected):
        actual = checks.relative(value["path"])
        checks.need(actual == expected and checks.sha(actual) == value["sha256"], "Engineering reference differs or escapes its exact path")
        if "bytes" in value:
            checks.need(actual.stat().st_size == value["bytes"], "Referenced byte count differs")
        refs[value["path"]] = value["sha256"]
        return actual

    def manifests(record, directory):
        checks.need(record["allPassed"] is True and record["sourceStable"] is True and record["protectedUnchanged"] is True and record["inputCount"] == 1578, "Incomplete or unstable engineering run")
        checks.need(len(record["inputRefs"]) == len(record["protectionRefs"]) == 2, "Missing input/protection pair")
        values = [checks.read(referenced(item, directory / name)) for item, name in zip(record["inputRefs"], ("inputs-before.json", "inputs-after.json"))]
        protections = [checks.read(referenced(item, directory / name)) for item, name in zip(record["protectionRefs"], ("protected-before.json", "protected-after.json"))]
        checks.need(values[0] == values[1] and len(values[0]) == 1578 and protections[0] == protections[1], "Before/after inputs or protection differ")
        expected_protected = {"PRODUCT.md", "docs/evidence/2026-10-08-reliability-ui-review/README.md", "docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md"}
        checks.need(set(protections[0]) == expected_protected and all(checks.sha(checks.ROOT / p) == h for p, h in protections[0].items()), "Protected files changed")
        referenced(record["originalExecutionReceipt"], directory / "verification.execution.raw.txt")
        return values[0]

    before = manifests(original, ORIGINAL_PATH.parent)
    current = manifests(final, path.parent)
    checks.need(current == inputs and set(before) == set(inputs) and len(inputs) == 1578, "Current exact input set differs")
    checks.need(original["changedInputs"] == [] and final["changedInputsDuringRun"] == [], "Input drift during execution")
    checks.need(sorted(p for p in before if before[p] != inputs[p]) == [STRINGS] and before[STRINGS] == STRINGS_BEFORE and inputs[STRINGS] == STRINGS_AFTER, "Unexpected change outside the reviewed frontend string")
    checks.need(final["changesSinceRun01"] == [{"path": STRINGS, "before": STRINGS_BEFORE, "after": STRINGS_AFTER}] and final["unchangedOtherInputCount"] == 1577, "Reuse boundary was changed")
    referenced(final["priorVerification"], ORIGINAL_PATH)
    referenced(final["docsFrozenObservation"], path.parent / "docs-after.json")
    referenced(final["runner"], path.parent / "run_frontend_followup.py.raw.txt")
    referenced(original["runner"], ORIGINAL_PATH.parent / "run_checks.py.raw.txt")
    checks.need(len(original["checks"]) == len(final["checks"]) == 7 and {c["name"] for c in original["checks"]} == {c["name"] for c in final["checks"]} == set(checks.COMMANDS), "Seven-command set differs")
    for item in original["checks"]:
        checks.need(item["argv"] == checks.COMMANDS[item["name"]] and item["exitCode"] == 0 and item["executedInThisRun"] is True, "Original execution not a passing exact command")
        referenced({"path": item["log"], "sha256": item["sha256"]}, ORIGINAL_PATH.parent / (item["name"] + ".txt"))
    for item in final["checks"]:
        name = item["name"]
        checks.need(item["argv"] == checks.COMMANDS[name] and item["exitCode"] == 0, "Final command or exit differs")
        if name in FRONTEND:
            checks.need(item["executedInThisRun"] is True and item["executionRun"] == "run-02", "Frontend execution incorrectly reused")
            referenced({"path": item["log"], "sha256": item["sha256"]}, path.parent / (name + ".txt"))
            original_log = checks.ROOT / "output/2026-10-13-claude-history-origin-fix-checks/run-02" / (name + ".txt")
            referenced(item["originalLog"], original_log)
            checks.need(item["sha256"] == item["originalLog"]["sha256"], "Published frontend log is not exact original bytes")
        else:
            prior_item = next(c for c in original["checks"] if c["name"] == name)
            expected = {**prior_item, "executedInThisRun": False, "executedInRun01": True, "executionRun": "run-01", "reuseReason": REUSE_REASON, "originalReceipt": {"path": str(ORIGINAL_PATH.relative_to(checks.ROOT)), "sha256": ORIGINAL_SHA, "bytes": ORIGINAL_PATH.stat().st_size}}
            checks.need(item == expected, "Native result is not the exact original execution with explicit reuse fields")
    ansi = re.compile(r"\x1b\[[0-9;]*m")
    frontend_counts = [line.strip() for line in ansi.sub("", (path.parent / "frontend.txt").read_text()).splitlines() if re.match(r"\s*(Test Files|Tests)\s+", line)]
    rust_counts = [line.strip() for line in (ORIGINAL_PATH.parent / "rust.txt").read_text().splitlines() if line.startswith("test result:")]
    checks.need(frontend_counts and final["counts"]["frontend"] == frontend_counts, "Frontend count differs from actual log")
    checks.need(rust_counts and all(line.startswith("test result: ok.") for line in rust_counts) and final["counts"]["rustReusedFromRun01"] == original["counts"]["rust"] == rust_counts, "Native reused counts differ from the original log")
    return {"receipt": str(path.relative_to(checks.ROOT)), "sha256": checks.sha(path), "inputCount": len(inputs), "references": refs, "boundary": "Four actual frontend commands in run02; three exact native executions reused from the complete seven-check run01. Only the pinned frontend strings input differs; all other 1577 inputs are identical. Earlier failure records, including formal63 positive-match failure, remain separate and are not repaired or accepted by this engineering proof."}


checks.arguments = arguments
checks.archive_path = archive_path
checks.baseline = baseline
checks.engineering = engineering
for name in dir(checks):
    if not name.startswith("_"):
        globals()[name] = getattr(checks, name)
if __name__ == "__main__":
    raise SystemExit(main())
