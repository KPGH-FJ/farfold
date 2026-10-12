"""Nine candidate checks for the registered-history partial slice.
Import reads pinned helper bytes only. The actual passing run-04 is pinned below;
candidate/build/install execution remains a separate root-directed action.
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
spec = importlib.util.spec_from_file_location("history_search_candidate_checks", PRIOR)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
checks.OUT = OUT
checks.BASELINE_COMMIT = "500a057002dd422887223a06bec998baf9bfd3b7"
checks.BASELINE = OUT.parent / "history-search-refresh-candidate/candidate.json"
checks.BASELINE_SHA = "8e76f031883de6df608ee3d72d2a11d746df9a755a0fc5acde51a9e566bd019b"
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
FINAL_PATH = checks.BASE / "claude-history-checks/run-04/verification.json"
# Root reported actual exit0; this exact proof was then independently read.
# Pinning the evidence does not execute or authorize a candidate/build/install.
ENGINEERING_PATH = FINAL_PATH
ENGINEERING_SHA = "aac295538d88224e4fd910c98c835ee2d8849305c692b1dcb10946bec862b5cc"
PRIOR_RUNS = [checks.BASE / f"claude-history-checks/run-{i:02d}/verification.json" for i in (1, 2, 3)]
STYLE = sorted([
    "src-tauri/src/acp_client/history_search/launch.rs",
    "src-tauri/src/acp_client/history_search/source.rs",
])
DIAGNOSTIC = sorted([
    "src-tauri/src/agent_discovery.rs",
    "src-tauri/src/acp_client/preparation.rs",
])
FIXTURE = ["src-tauri/src/acp_client/extension_inventory/skills_lifecycle_tests.rs"]
DELTA = sorted(STYLE + DIAGNOSTIC + FIXTURE)
RETAINED_FAILURES = {
    "run01": "Clippy101; two equivalent style corrections.",
    "run02": "Old cancellation fixture returned Node version unavailable; exact isolated sample and later full-suite sample passed, but original concrete cause remains unlocated. Test-only diagnostics were added; no production fix claim.",
    "run03": "Old skills lifecycle fixture parsed an empty PID before cancellation. Producer made the final marker visible before writing the PID; two same-file peers now write and close a temporary marker before atomic replacement. Original assertion/deadline/production semantics retained.",
    "run02BoundaryErratum": "Numeric/status fields correctly said failed; its fixed-template first sentence wrongly asserted all seven passing evidence. Original remains unchanged and is not success proof.",
    "reuseFlagErratum": "run02/run03 copied original check objects retained executedInThisRun=true under frontendChecksReused; this final record explicitly marks those four checks executedInThisRun=false, executedInOriginalRun=true and executionRun=run-01. Original receipts remain unchanged.",
}


def arguments():
    checks.need(len(sys.argv) == 3 and re.fullmatch("[0-9a-f]{40}", sys.argv[1]), "Expected exact commit and engineering path")
    checks.need(ENGINEERING_PATH == FINAL_PATH and isinstance(ENGINEERING_SHA, str) and re.fullmatch("[0-9a-f]{64}", ENGINEERING_SHA), "Preparation only: final passing engineering proof and digest have not been pinned")
    proof = checks.relative(sys.argv[2])
    checks.need(proof == FINAL_PATH, "Wrong exact engineering proof")
    return sys.argv[1], proof


def archive_path(commit):
    return checks.ROOT / f"src-tauri/target/internal-candidate/2026-10-13-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip"


def baseline():
    checks.need(checks.sha(checks.BASELINE) == checks.BASELINE_SHA, "Installed baseline receipt changed")
    prior = checks.read(checks.BASELINE)
    checks.need(prior["sourceCommit"] == checks.BASELINE_COMMIT and prior["phase"] == "internalCandidatePreparedNotInstalled", "Wrong 500a baseline source")
    actual = checks.bundle(checks.FORMAL)
    checks.need(actual == (prior["candidateFiles"], prior["candidateModes"]), "Formal bundle differs from exact 500a baseline files or modes")
    return actual


def engineering(path, inputs):
    checks.need(ENGINEERING_PATH == FINAL_PATH and path == FINAL_PATH and isinstance(ENGINEERING_SHA, str) and re.fullmatch("[0-9a-f]{64}", ENGINEERING_SHA), "Final engineering proof is not approved")
    checks.need(checks.sha(path) == ENGINEERING_SHA, "Approved engineering proof digest changed")
    final = checks.read(path)
    checks.need(final["status"] == "nativeFixtureCorrectionValidatedWithUnchangedFrontendChecks" and final["allSevenCommandsHavePassingEvidence"] is True and final["sourceStable"] is True and final["protectedUnchanged"] is True, "Incomplete final engineering evidence")
    checks.need(final["inputCount"] == len(inputs) and final["changedInputs"] == [] and final["changedInputsSinceOriginal"] == DELTA and final["changedInputsSincePrevious"] == FIXTURE, "Wrong correction boundary")
    checks.need(final["retainedFailures"] == RETAINED_FAILURES, "Original failure or unresolved-cause boundary changed")
    refs = {str(path.relative_to(checks.ROOT)): checks.sha(path)}

    def referenced(value, expected_path):
        p = checks.relative(value["path"])
        checks.need(p == expected_path and checks.sha(p) == value["sha256"], "Engineering reference drift or wrong scope")
        refs[value["path"]] = value["sha256"]
        return p

    def manifests(directory, record):
        values = []
        for name in ("inputs-before.json", "inputs-after.json"):
            p = directory / name
            values.append(checks.read(p))
            refs[str(p.relative_to(checks.ROOT))] = checks.sha(p)
        checks.need(record["sourceStable"] is True and record["protectedUnchanged"] is True and record["changedInputs"] == [] and values[0] == values[1], "Run inputs unstable")
        checks.need(set(values[0]) == set(inputs) and record["inputCount"] == len(inputs), "Inputs were added or removed")
        return values[0]

    def commands(items, directory, exits):
        checks.need(len(items) == len(exits) and {c["name"] for c in items} == set(exits), "Actual command set differs")
        for item in items:
            checks.need(item["argv"] == checks.COMMANDS[item["name"]] and item["executedInThisRun"] is True and item["exitCode"] == exits[item["name"]], "Command execution or retained failure differs")
            referenced({"path": item["log"], "sha256": item["sha256"]}, directory / (item["name"] + ".txt"))

    def changed(first, second):
        checks.need(first.keys() == second.keys(), "Input inventory differs")
        return sorted(name for name in first if first[name] != second[name])

    prior, prior_inputs, prior_refs = [], [], {}
    for index, (key, expected_path) in enumerate(zip(("originalRun", "intermediateRun", "previousRun"), PRIOR_RUNS)):
        p = referenced(final[key], expected_path)
        record = checks.read(p)
        prior.append(record)
        prior_inputs.append(manifests(p.parent, record))
        if index == 0:
            checks.need(record["allPassed"] is False, "Original Clippy failure was relabelled passing")
            items = record["checks"]
            exits = {name: 101 if name == "clippy" else 0 for name in checks.COMMANDS}
        else:
            checks.need(record["status"] == "failed" and record["allSevenCommandsHavePassingEvidence"] is False, "Prior native failure was relabelled passing")
            items = record["checksExecutedHere"]
            exits = {"cargo-fmt": 0, "clippy": 0, "rust": 101}
        commands(items, p.parent, exits)
        for ref_path in (p, p.parent / "inputs-before.json", p.parent / "inputs-after.json", *(checks.relative(item["log"]) for item in items)):
            name = str(ref_path.relative_to(checks.ROOT))
            prior_refs[name] = refs[name]
    checks.need(changed(prior_inputs[0], prior_inputs[1]) == STYLE and changed(prior_inputs[1], prior_inputs[2]) == DIAGNOSTIC, "Prior correction chain differs")
    checks.need(changed(prior_inputs[2], inputs) == FIXTURE and changed(prior_inputs[0], inputs) == DELTA, "Changes outside five reviewed native files")
    checks.need(manifests(path.parent, final) == inputs, "Final frozen input manifest mismatch")
    commands(final["checksExecutedHere"], path.parent, {"cargo-fmt": 0, "clippy": 0, "rust": 0})
    expected_frontend_checks = [{**c, "executedInThisRun": False, "executedInOriginalRun": True, "executionRun": "run-01"} for c in prior[0]["checks"] if c["name"] in {"typecheck", "frontend", "build", "format"}]
    checks.need(final["frontendChecksReused"] == expected_frontend_checks and len(expected_frontend_checks) == 4, "Frontend reuse is not the exact four original executions")
    declared = final["retainedReferences"]
    checks.need(len(declared) == 22 and len(prior_refs) == 22 and {v["path"]: v["sha256"] for v in declared} == prior_refs, "All three prior manifests or actual raw logs were not retained exactly")
    expected_frontend = [line.strip() for line in (PRIOR_RUNS[0].parent / "frontend.txt").read_text().splitlines() if line.strip().startswith(("Test Files", "Tests"))]
    expected_rust = [line for line in (path.parent / "rust.txt").read_text().splitlines() if line.startswith("test result:")]
    checks.need(expected_rust and all(line.startswith("test result: ok.") for line in expected_rust), "Native raw log does not contain only passing test results")
    checks.need(expected_frontend and final["counts"]["frontend"] == prior[0]["counts"]["frontend"] == expected_frontend and final["counts"]["rust"] == expected_rust, "Counts do not match actual logs")
    return {"receipt": str(path.relative_to(checks.ROOT)), "sha256": checks.sha(path), "inputCount": len(inputs), "references": refs, "boundary": "Three actual native checks from run-04; four frontend checks reused exactly from run-01, with only five enumerated native input changes. All prior manifests and actual raw logs retained, including run-01 Clippy failure, run-02 unexplained Node cancellation-fixture failure and run-03 PID-readiness failure. Passing this proof does not establish that the original Node failure was fixed, or any installed/official-SDK/Windows/whole-P32 acceptance."}


checks.baseline = baseline
checks.engineering = engineering
checks.arguments = arguments
checks.archive_path = archive_path
for name in dir(checks):
    if not name.startswith("_"):
        globals()[name] = getattr(checks, name)
if __name__ == "__main__":
    raise SystemExit(main())
