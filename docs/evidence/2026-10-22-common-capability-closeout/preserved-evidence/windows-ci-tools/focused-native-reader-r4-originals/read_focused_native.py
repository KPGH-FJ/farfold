#!/usr/bin/env python3
"""Local, read-only P27 / seven-case recovery artifact reader.

Exit 0 means a new report was written, never that the selected controls passed.
No network, test process, application, database or artifact mutation is performed.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import fnmatch
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
DEPENDENCY = Path(__file__).with_name("summarize_closeout.py")
DEPENDENCY_SHA = "1e98966cd84b72064be0e6c41b7da2c658cc21eb30d90de55488c4358e51a2e4"
spec = importlib.util.spec_from_file_location("focused_closeout_dependency", DEPENDENCY)
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
if legacy.sha(DEPENDENCY.read_bytes()) != DEPENDENCY_SHA:
    raise RuntimeError("Existing raw/privilege reader changed; review the dependency before use")

P27_CASE = "browser_sharing::windows_native_screenshot_tests::real_windows_public_screenshot_keeps_permission_pixels_and_retirement"
P27_CHECKS = ["actual-permitted-PNG-center", "text-grant-does-not-authorize-screenshot",
              "denial-preserves-text", "closed", "design", "frame",
              "same-scope-revoked-at-actual-capture-callback"]
RECOVERY = {
    "Ordinary": ["create-public-selected", "ordinary-public-backup-cold-recover-keeps-original-and-rechecks",
                 "ordinary-public-confirm-delete-then-offline-cold-recover-preserves-all-material"],
    "FullSecurityManual": ["public-retained-cold-recover", "remove-late-ea", "remove-late-security",
                           "public-remove-cold-recover"],
}
DIAGNOSTIC = "windows_process::current_members::tests::native_list_failure_diagnostic_preserves_api_error_and_exact_parse_categories"
SHA = re.compile(r"^[0-9a-fA-F]{64}$")


class Artifacts(legacy.Artifacts):
    def json(self, name):
        item, body = self.read(name)
        if body is None:
            return item, None
        try:
            return item, json.loads(body.decode("utf-8-sig"), object_pairs_hook=legacy.strict_object)
        except (UnicodeError, ValueError) as error:
            item["parseError"] = str(error)
            return item, None


def obj(value):
    return value if isinstance(value, dict) else {}


def source(repo, head, path):
    return legacy.git(repo, "show", head + ":" + path)


def input_paths(all_paths, patterns):
    # Git ls-files' default pathspec '*' includes '/', unlike ls-tree literal
    # prefixes. Reproduce the build script selection from the immutable tree.
    return sorted(p for p in all_paths if any(p == pattern or p.startswith(pattern + "/")
                  or fnmatch.fnmatchcase(p, pattern) for pattern in patterns))


def terminal(observed, case, exit_code):
    """Raw facts stay visible even when aggregate identity/stability is unverified."""
    outcomes, summaries = observed["namedOutcomes"], observed["summaries"]
    outcome = outcomes[0]["outcome"] if len(outcomes) == 1 and outcomes[0]["name"] == case else None
    summary = summaries[0] if len(summaries) == 1 else None
    state = "incomplete_or_inconsistent"
    if summary:
        counts = (summary["passed"], summary["failed"], summary["ignored"])
        if outcome == "ok" and counts == (1, 0, 0) and summary["status"] == "ok":
            state = "named_pass" if type(exit_code) is int and exit_code == 0 else "named_pass_exit_unverified"
        elif outcome == "FAILED" and counts == (0, 1, 0) and summary["status"] == "FAILED":
            state = "named_failure" if type(exit_code) is int and exit_code != 0 else "named_failure_exit_unverified"
        elif not outcomes and counts == (0, 0, 0):
            state = "zero_tests"
        elif outcome == "ignored" and counts == (0, 0, 1):
            state = "ignored_not_run"
    return {"classification": state, "exactOutcome": outcome, "exitCode": exit_code,
            "summaries": summaries, "namedOutcomes": outcomes}


def markers(stderr, tag):
    result = []
    for line_no, line in enumerate((stderr or "").splitlines(), 1):
        if line.startswith(tag + " "):
            value = {"line": line_no}
            try:
                value["data"] = json.loads(line[len(tag) + 1:], object_pairs_hook=legacy.strict_object)
            except ValueError as error:
                value["parseError"] = str(error)
            result.append(value)
    return result


def source_inputs(repo, head, artifacts, suite):
    _, before = artifacts.json("inputs-before.json")
    _, after = artifacts.json("inputs-after.json")
    issues = []
    if not isinstance(before, dict) or not before or not isinstance(after, dict) or before != after:
        issues.append("source input maps absent, empty or different")
    if suite == "p27":
        paths = ["src-tauri", ".github/scripts/windows-p27-native.ps1", ".github/scripts/windows-native-loader-diagnostics.ps1",
                 ".github/scripts/windows-pe-resource-inspection.py", ".github/workflows/windows-p27-native.yml"]
    else:
        paths = ["src-tauri/src", "src-tauri/native", "src-tauri/examples", "src-tauri/Cargo.toml",
                 "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/*.json", "src-tauri/*.manifest",
                 ".github/scripts/windows-capability-closeout*", ".github/scripts/windows-recovery-followup*",
                 ".github/scripts/windows-native-loader-diagnostics.ps1", ".github/workflows/windows-recovery-followup.yml"]
    expected = input_paths(legacy.git(repo, "ls-tree", "-r", "--name-only", head).decode().splitlines(), paths)
    mismatches = []
    if isinstance(before, dict):
        if set(before) != set(expected):
            issues.append("input path inventory differs from exact requested-head build selection")
        for path in expected:
            blob = source(repo, head, path)
            forms = {"gitBlob": legacy.sha(blob)}
            try:
                if b"\x00" not in blob:
                    blob.decode("utf-8")
                    forms = legacy.hash_forms(blob)
            except UnicodeError:
                pass
            if not legacy.matching_form(before.get(path), forms):
                mismatches.append(path)
        if mismatches:
            issues.append("input hashes differ from requested-head Git bytes / deterministic checkout line endings")
    return {"verified": not issues, "pathCount": len(expected), "hashMismatchPaths": mismatches, "issues": issues}


def context(repo, run_id, head, attempt, artifacts, suite):
    _, identity = artifacts.json("identity.json")
    _, selection = artifacts.json("build-selection.json")
    identity, selection = obj(identity), obj(selection)
    issues = []
    if (identity.get("sourceHead") != head or str(identity.get("runId")) != run_id
            or str(identity.get("runAttempt")) != attempt):
        issues.append("identity sourceHead/runId/runAttempt mismatch or absent")
    if selection.get("sourceHead") != head:
        issues.append("selected build sourceHead mismatch or absent")
    keys = ("testBinarySha256", "helperBinarySha256") if suite == "p27" else ("testBinarySha256", "fixtureSha256")
    if any(not SHA.fullmatch(str(selection.get(k, ""))) for k in keys):
        issues.append("selected executable hash missing or malformed")
    build_logs = ["test-build.stdout.jsonl", "test-build.stderr.log",
                  ("helper" if suite == "p27" else "fixture") + "-build.stdout.log",
                  ("helper" if suite == "p27" else "fixture") + "-build.stderr.log"]
    build_text = {}
    for name in build_logs:
        _, build_text[name] = artifacts.text(name)
        if build_text[name] is None:
            issues.append("original build log missing or invalid: " + name)
    test_executables = set()
    for line in (build_text["test-build.stdout.jsonl"] or "").splitlines():
        try:
            event = json.loads(line, object_pairs_hook=legacy.strict_object)
            if (event.get("reason") == "compiler-artifact" and obj(event.get("target")).get("name") == "farfold_lib"
                    and obj(event.get("profile")).get("test") is True and event.get("executable")):
                test_executables.add(event["executable"])
        except (ValueError, TypeError, AttributeError):
            issues.append("original compiler-artifact JSON invalid")
    if test_executables != {selection.get("testBinary")}:
        issues.append("selected libtest path differs from unique original compiler-artifact")
    inputs = source_inputs(repo, head, artifacts, suite)
    issues.extend(inputs["issues"])
    workflow_path = ".github/workflows/windows-" + ("p27-native" if suite == "p27" else "recovery-followup") + ".yml"
    workflow = source(repo, head, workflow_path)
    step, deadlines = None, []
    for line in workflow.decode().splitlines():
        if line.startswith("      - name: "):
            step = line[len("      - name: "):]
        if line.startswith("        timeout-minutes: "):
            deadlines.append({"step": step, "minutes": int(line.split(": ", 1)[1])})
    script_path = ".github/scripts/windows-" + ("p27-native" if suite == "p27" else "recovery-followup-build") + ".ps1"
    script = source(repo, head, script_path)
    contracts = {"workflow": {"path": workflow_path, "gitBlobSha256": legacy.sha(workflow)},
                 "script": {"path": script_path, "gitBlobSha256": legacy.sha(script)},
                 "workflowStepDeadlines": deadlines}
    if suite == "p27":
        waits = re.findall(r"\$process\.WaitForExit\((\d+)\)", script.decode())
        contracts["heldProcessWaitsMs"] = [int(v) for v in waits]
        driver = source(repo, head, "src-tauri/src/browser_sharing/windows_native_screenshot_tests.rs")
        body = re.sub(r"\s+", "", driver.decode())
        timeouts = re.findall(r"timeout\(Duration::from_secs\((\d+)\),run_cases\(&task_handle\)\)", body)
        contracts["driverBodyDeadlineSeconds"] = int(timeouts[0]) if len(timeouts) == 1 else None
    return {"identity": identity, "buildSelection": selection, "sourceInputs": inputs,
            "originalCompilerTestExecutables": sorted(test_executables),
            "sourceContracts": contracts, "issues": issues}


def p27(repo, head, artifacts, base):
    _, record = artifacts.json("execution.json")
    record = obj(record)
    _, stdout = artifacts.text("native.stdout.log")
    _, stderr = artifacts.text("native.stderr.log")
    observed = legacy.parse_log(stdout, stderr, None)
    completed = markers(stderr, "FARFOLD_P27_NATIVE_COMPLETED")
    failed = markers(stderr, "FARFOLD_P27_NATIVE_FAILED")
    phases = markers(stderr, "FARFOLD_P27_NATIVE_PHASE")
    value = obj(completed[0].get("data")) if len(completed) == 1 else {}
    issues = list(base["issues"])
    if record.get("sourceHead") != head or record.get("exactCase") != P27_CASE or base["identity"].get("exactCase") != P27_CASE:
        issues.append("P27 exact FQN / head receipt absent or mismatched")
    if record.get("actual") != (value or None) or record.get("completedRecordCount") != len(completed):
        issues.append("execution receipt differs from raw completion marker")
    checks_exact = value.get("checks") == P27_CHECKS
    if record.get("checksExact") is not checks_exact:
        issues.append("recorded checksExact differs from raw check names/order")
    raw = terminal(observed, P27_CASE, record.get("exitCode"))
    native, helper = obj(value.get("native")), obj(value.get("helper"))
    positive = (checks_exact and value.get("positiveCenterRgb") == [12, 132, 44]
                and type(value.get("positivePngBytes")) is int and value["positivePngBytes"] > 0
                and bool(SHA.fullmatch(str(value.get("positivePngSha256", ""))))
                and native.get("actualCallbackRevocations") == 1 and native.get("revokedCallbackHadPng") is True
                and isinstance(native.get("runtimeVersion"), str) and bool(native["runtimeVersion"].strip())
                and value.get("cleanupAcknowledged") is True
                and str(helper.get("binarySha256", "")).lower() == str(base["buildSelection"].get("helperBinarySha256", "")).lower()
                and type(helper.get("naturalExit")) is int and helper["naturalExit"] == 0
                and helper.get("stderrBytes") == 0)
    natural = record.get("naturalCompletionObserved") is True and record.get("timedOut") is False
    if record.get("inputsStable") is not True:
        issues.append("P27 process receipt lacks stable inputs")
    raw_pass = raw["classification"] == "named_pass"
    wrapper_pass = (natural and raw_pass and record.get("inputsStable") is True and len(completed) == 1
                    and checks_exact and helper.get("naturalExit") == 0
                    and str(helper.get("binarySha256", "")).lower() == str(base["buildSelection"].get("helperBinarySha256", "")).lower()
                    and value.get("cleanupAcknowledged") is True and native.get("actualCallbackRevocations") == 1
                    and native.get("revokedCallbackHadPng") is True and bool(str(native.get("runtimeVersion", "")).strip()))
    if record.get("passed") is not wrapper_pass:
        issues.append("wrapper passed flag differs from its raw qualification")
    if stdout is None or stderr is None or failed or len(completed) != 1 or not positive:
        issues.append("P27 completion / pixels / helper / native capability controls incomplete")
    verified = not issues and natural and raw_pass and positive
    return {"exactCase": P27_CASE, "expectedChecks": P27_CHECKS, "rawTerminal": raw,
            "rawCompletion": completed, "rawFailure": failed, "rawPhases": phases,
            "recordedExecution": record, "groupComplete": len(completed) == 1 and natural and raw_pass,
            "actualPermissionScope": "one explicit screenshot request, separate text grant; original driver assertions, no new grant inferred",
            "timeout": {"outerTimedOut": record.get("timedOut"), "naturalCompletion": record.get("naturalCompletionObserved"),
                        "sourceDeadlines": base.get("sourceContracts")},
            "issues": issues, "status": "verified_passed" if verified else "unverified_or_failed",
            "allSelectedCasesVerifiedPassed": verified}


def recovery(repo, head, artifacts, base):
    workflow = source(repo, head, ".github/workflows/windows-recovery-followup.yml").decode()
    for mode, names in RECOVERY.items():
        invocation = "-Mode " + mode + " -CaseNames @(" + ", ".join("'" + n + "'" for n in names) + ")"
        if workflow.count(invocation) != 1:
            raise ValueError("Unrecognized exact recovery workflow selection; review reader scope first")
    if workflow.count("$case = '" + DIAGNOSTIC + "'") != 1:
        raise ValueError("Unrecognized exact diagnostic FQN")
    manifest_blob = source(repo, head, legacy.MANIFEST)
    runner_blob = source(repo, head, legacy.RUNNER)
    helper_blob = source(repo, head, legacy.MANUAL_HELPER)
    manifest = json.loads(manifest_blob, object_pairs_hook=legacy.strict_object)
    all_cases = manifest["cases"]
    policy = legacy.execution_policy(runner_blob, helper_blob)
    selection = base["buildSelection"]
    shared = list(base["issues"])
    if any(type(selection.get(k)) is not int or selection[k] != 0 for k in ("testBuildExit", "fixtureBuildExit")) or selection.get("sourceInputsStable") is not True:
        shared.append("build exits / input-stability receipt missing or invalid")
    rows, groups = [], []
    for mode, names in RECOVERY.items():
        selected = [c for c in all_cases if c["name"] in names]
        if len(selected) != len(names) or any(c["manual"] != (mode == "FullSecurityManual") for c in selected):
            raise ValueError("Focused FQNs are not distinct exact members of the head manifest mode")
        _, aggregate = artifacts.json(f"capability-closeout-{mode}.result.json")
        aggregate = obj(aggregate)
        issues = list(shared)
        expected = {"schema": 1, "head": head, "finalHead": head, "headStable": True, "inputsStable": True,
                    "mode": mode, "focusedSubsetOnly": True, "selectedTests": len(selected), "groupCount": len(selected),
                    "plannedOrdinaryTests": sum(not c["manual"] for c in all_cases),
                    "plannedManualTests": sum(c["manual"] for c in all_cases), "plannedTotalTests": len(all_cases),
                    "ordinaryDefaultTokenAdjusted": False, "fullSecurityFallbackUsed": False}
        for key, value in expected.items():
            if aggregate.get(key) != value:
                issues.append("aggregate." + key + " differs / absent")
        if sorted(aggregate.get("selectedCaseNames", [])) != sorted(names):
            issues.append("aggregate selected names differ from exact workflow subset")
        for key in ("testBinarySha256", "fixtureSha256"):
            if str(aggregate.get(key, "")).lower() != str(selection.get(key, "")).lower():
                issues.append("aggregate " + key + " differs from selected build")
        for key, blob in (("caseManifestSha256", manifest_blob), ("runnerScriptSha256", runner_blob)):
            if not legacy.matching_form(aggregate.get(key), legacy.hash_forms(blob)):
                issues.append("aggregate " + key + " differs from requested-head source")
        embedded = aggregate.get("groups", [])
        if not isinstance(embedded, list):
            embedded = []
        if sorted(g.get("group", "") for g in embedded if isinstance(g, dict)) != sorted(names):
            issues.append("aggregate embedded case set differs")
        mode_rows = [legacy.summarize_case(artifacts, c, not issues, embedded, policy) for c in selected]
        for row in mode_rows:
            row["rawTerminal"] = terminal(row["observed"], row["filter"], row["actualExitCode"])
        passed = bool(mode_rows) and all(r["status"] == "passed" for r in mode_rows)
        if aggregate.get("exactAllGroupsPassed") is not passed and not issues:
            issues.append("aggregate pass flag differs from recomputed exact cases")
            for row in mode_rows:
                if row["status"] == "passed":
                    row["status"] = "unverified_evidence"
        groups.append({"mode": mode, "expectedNames": names, "expectedCount": len(names),
                       "groupComplete": bool(aggregate) and aggregate.get("groupCount") == len(names)
                                        and sorted(g.get("group", "") for g in embedded if isinstance(g, dict)) == sorted(names),
                       "headerVerified": not issues, "issues": issues, "counts": dict(Counter(r["status"] for r in mode_rows)),
                       "recordedAllPassed": aggregate.get("exactAllGroupsPassed")})
        rows.extend(mode_rows)
    _, receipt = artifacts.json("original-list-control.result.json")
    receipt = obj(receipt)
    _, out = artifacts.text("original-list-control.stdout.log")
    _, err = artifacts.text("original-list-control.stderr.log")
    observed = legacy.parse_log(out, err, None)
    raw = terminal(observed, DIAGNOSTIC, receipt.get("exitCode"))
    diagnostic_pass = (not shared and receipt.get("head") == head and receipt.get("filter") == DIAGNOSTIC
                       and receipt.get("exactPassed") is True and raw["classification"] == "named_pass" and err is not None)
    return {"groups": groups, "cases": rows,
            "diagnosticControl": {"exactCase": DIAGNOSTIC, "rawTerminal": raw, "recorded": receipt,
                                  "verifiedPassed": diagnostic_pass},
            "allSelectedCasesVerifiedPassed": diagnostic_pass and all(r["status"] == "passed" for r in rows)
                                                 and all(g["headerVerified"] for g in groups),
            "scope": "seven exact original cases plus one independent diagnostic; never the complete current cohort or legacy 304/27"}


def report(repo, suite, run_id, head, attempt, artifact_dir):
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("head must be an explicit full lowercase commit, not a mutable ref")
    if not run_id.isdecimal() or not attempt.isdecimal():
        raise ValueError("run-id and attempt must be decimal")
    actual_head = legacy.git(repo, "rev-parse", "--verify", head + "^{commit}").decode().strip()
    if actual_head != head:
        raise ValueError("requested commit did not resolve exactly")
    artifacts = Artifacts(artifact_dir)
    base = context(repo, run_id, head, attempt, artifacts, suite)
    result = p27(repo, head, artifacts, base) if suite == "p27" else recovery(repo, head, artifacts, base)
    changed = artifacts.changes()
    if changed:
        result["allSelectedCasesVerifiedPassed"] = False
    return {"schema": 1, "createdAtUtc": datetime.now(timezone.utc).isoformat(),
            "requested": {"suite": suite, "runId": run_id, "head": head, "runAttempt": attempt},
            "context": base, "actual": result, "rawFiles": [v[0] for v in artifacts.cache.values()],
            "inputsStableDuringRead": not changed, "changedDuringRead": changed,
            "allSelectedCasesVerifiedPassed": result["allSelectedCasesVerifiedPassed"],
            "wholeCurrentCohortPassed": False, "installedProductPassed": False,
            "executableBytesRehashedLocally": False,
            "limits": ["Missing aggregate retains raw individual outcomes but withholds verified pass.",
                       "No network metadata is inferred; continue-on-error/workflow success is not a test verdict.",
                       "Original binary hashes are receipt identity, not a local re-execution or binary rehash.",
                       "Recovery source maps cover before/after build; each mode additionally rechecks its binary/fixture/runner/manifest, not every source file throughout execution.",
                       "P27 controlled HTTPS interception is not remote-site TLS, installed UI or real-Agent proof."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("p27", "recovery"), required=True)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--attempt", default="1")
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        repo = args.repo.resolve(strict=True)
        raw = args.artifact_dir.resolve(strict=True)
        output = args.output.resolve()
        if not raw.is_dir() or output.is_relative_to(raw) or not output.is_relative_to((repo / "output").resolve()):
            raise ValueError("new output must be under repo/output, outside original artifacts")
        if output.exists():
            raise ValueError("output exists; preserve it and use a fresh name")
        result = report(repo, args.suite, args.run_id, args.head, args.attempt, raw)
        result["reader"] = {"path": str(Path(__file__).resolve()), "sha256": legacy.sha(Path(__file__).read_bytes()),
                            "dependency": {"path": str(DEPENDENCY), "sha256": DEPENDENCY_SHA}}
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as file:
            json.dump(result, file, ensure_ascii=False, indent=2)
            file.write("\n")
        print(json.dumps({"output": str(output), "sha256": legacy.sha(output.read_bytes()),
                          "allSelectedCasesVerifiedPassed": result["allSelectedCasesVerifiedPassed"]}))
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("Local focused reader error: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
