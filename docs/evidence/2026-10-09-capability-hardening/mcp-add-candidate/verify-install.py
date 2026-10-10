"""Keep ten installation checks; bind the accepted, historical 26a55 baseline."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent


def module(name, path, digest=None):
    if digest is not None:
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


v = module("mcp_add_install_candidate", OUT / "verify-candidate.py")
# Load the plain implementation, not a wrapper with another module's globals.
previous = module("mcp_add_plain_install", OUT.parent / "skill-management-candidate/verify-install.py", "b9d2137705c6ef402d7a308a666742c33b4a9966650be50841213923fea65388")
previous.v = v
previous.PRIVATE = v.ROOT / "output/2026-10-11-mcp-add-install"
DOC_SNAPSHOT_COMMIT = "f83cbff482d2ea5fe7d9c37de0eb91ca9648d360"
DOC_SNAPSHOTS = {
    "docs/status.md": "eda25b2c30f117ecca0265caca0a0774627c168a2c4478e13a193b08bd7566fd",
    "docs/architecture.md": "b192a7daa6215c88aebb096bad27ac4c2ba1508856bd7d55f1473336031b449b",
    "plans/agent-access.md": "6e47477866b81e29cc36f44f6d1764e9e0689f16804705bdd2099e3b93b2973b",
    "docs/evidence/2026-10-09-capability-hardening/README.md": "31bde8b3eaaa366e7e0f2a826e5d4af9d66c86f231ccf0f597357c4bc71db4e1",
}
PRIOR_REFS = {
    "output/2026-10-11-mcp-management-native/final-normal-exit.json": "f83f88508639d8826d6187a96f3d2d4a968bf4a580e622ca3f4f8e2beb692151",
    "output/2026-10-11-mcp-management-native/root-data-acceptance.json": "1d4dc669b38b54aca66fe1b2152fa39db6354d7194c8d351c496a70f8863092a",
    "output/2026-10-11-mcp-management-native/native-final-independent.json": "16ac9a6bd054d587ac8f9472a8698ce65a77e5252598a3b7ba6a491836820323",
    "docs/evidence/2026-10-09-capability-hardening/mcp-management-candidate/native-independent.json": "e0d4ff7f1d090cc9bc903b24897d53fc0421da56c4f409fba19995ead15d9d04",
    "docs/evidence/2026-10-09-capability-hardening/mcp-management-candidate/installed-mcp-management.json": "bb41cee97c80a8346ac7139355dcaa156dfdabaeecd4357ddafe53095e1a50e7",
    "docs/evidence/2026-10-09-capability-hardening/mcp-management-candidate/record-gate.json": "09b87532f369b9b3ab5a41f007323fb3a23630e7790bb0a81fc946b750bf9d04",
}
EXACT_DELTA = {"table": "agents", "id": "codex", "column": "updated_at", "before": 1791651774403, "after": 1791655910815}


def historical_ref(name, expected):
    if name in DOC_SNAPSHOTS:
        v.need(expected == DOC_SNAPSHOTS[name], "Unexpected historical document hash")
        raw = subprocess.run(["git", "show", DOC_SNAPSHOT_COMMIT + ":" + name], cwd=v.ROOT, check=True, capture_output=True).stdout
        v.need(hashlib.sha256(raw).hexdigest() == expected, "Historical document blob differs: " + name)
    else:
        v.need(v.sha(v.relative(name)) == expected, "Prior referenced file changed: " + name)


def record_refs(record):
    refs = record["refs"]
    if isinstance(refs, dict):
        return refs.items()
    v.need(isinstance(refs, list), "Unexpected prior reference shape")
    v.need(len({r["path"] for r in refs}) == len(refs), "Duplicate prior reference")
    return ((r["path"], r["sha256"]) for r in refs)


def verify_prior_baseline(normal, load):
    v.need(normal["userAuthorizedContinuousDevelopment"] is True and normal["normalQuitObserved"] is True and normal["forcedQuit"] is False and normal["formalProcessCountAfter"] == 0 and normal["sourceCommit"] == v.BASELINE_COMMIT, "Prior normal exit missing")
    v.need(normal["refs"] == PRIOR_REFS and bool(normal["normalQuitEvidence"]), "Prior baseline references differ")
    records = {}
    for name, expected in PRIOR_REFS.items():
        historical_ref(name, expected)
        records[Path(name).name] = load(v.relative(name))
    v.need(all(r["sourceCommit"] == v.BASELINE_COMMIT for r in records.values()), "Prior source identity differs")
    exit_record = records["final-normal-exit.json"]
    accepted = records["root-data-acceptance.json"]
    independent = records["native-independent.json"]
    native = records["native-final-independent.json"]
    installed = records["installed-mcp-management.json"]
    gate = records["record-gate.json"]
    v.need(exit_record["normalQuitObserved"] is True and exit_record["forcedQuit"] is False and exit_record["formalProcessCountAfter"] == 0, "Prior app was not normally closed")
    v.need(exit_record["sourceInputCount"] == 1461 and exit_record["sourceInputsUnchanged"] is True and exit_record["formalFiveFilesUnchanged"] is True, "Prior native source/bundle identity differs")
    v.need(accepted["decision"] == "acceptExactObservedTimestampDeltaOnly" and accepted["acceptedDelta"] == EXACT_DELTA and accepted["allOtherRowsAndColumnsEqual"] is True and accepted["settingsAndWholeUnsentAndCatalogueEqual"] is True, "Prior exact data acceptance differs")
    v.need(independent["status"] == native["status"] == "passedWithinStatedScope" and independent["findings"] == native["findings"] == [], "Prior independent review differs")
    v.need(independent["evidence"]["currentFrozenInputHashesMatched"] == native["frozenInputs"]["count"] == 1461 and native["frozenInputs"]["allCurrentInputHashesMatchCandidate"] is True, "Prior independent input scope differs")
    v.need(independent["evidence"]["formalCandidateFilesMatched"] == native["frozenInputs"]["formalCandidateFilesMatched"] == 5, "Prior independent bundle scope differs")
    v.need(all(c["passed"] is True for c in independent["checks"]) and len(independent["checks"]) == 6, "Prior independent checks incomplete")
    v.need(gate["status"] == "passedReadOnlyRecordGate" and gate["findings"] == [] and gate["integrity"]["currentFrozenSourceInputsMatched"] == 1461 and gate["integrity"]["sevenRecordedCheckLogHashesMatched"] is True, "Prior record gate incomplete")
    v.need(gate["originalPlan"]["original122IdTitleCompletionCellsExact"] is True and gate["originalPlan"]["originalOrderExact"] is True, "Prior original requirements differ")
    v.need(installed["phase"] == "installedBoundedMcpPreferenceAndSharedExpiryRecoveryVerified" and installed["engineering"]["inputCount"] == 1461, "Prior installed scope differs")
    close = installed["closeout"]
    v.need(close["normalQuit"] is True and close["forceQuit"] is False and close["originalWholeSessions"] == 131 and close["newRetainedSessions"] == 0 and close["dismissedSessions"] == 168 and close["all53SettingsRawEqual"] is True and close["wholeUnsentObjectEqual"] is True and close["unsentGroups"] == [8, 8, 3] and close["worktreeCatalogueWholeEqual"] is True, "Prior installed data scope differs")
    # Historical private review is hash-bound, not recursively treated as current
    # source: its launch.rs reference describes the old candidate. Public/direct
    # native, acceptance and record-gate references remain checked individually.
    for record in (exit_record, accepted, independent, installed, gate):
        for name, expected in record_refs(record):
            historical_ref(name, expected)
    comparison_path = "output/2026-10-11-mcp-management-native-preparation/data-review/final-data-comparison-independent.json"
    timestamp_path = "output/2026-10-11-mcp-management-native-preparation/data-review/timestamp-delta-independent.json"
    v.need(comparison_path in accepted["refs"] and timestamp_path in accepted["refs"], "Prior accepted data references missing")
    data, delta = load(v.relative(comparison_path)), load(v.relative(timestamp_path))
    v.need(data["baseline"] == {"wholeSessionRows": 131, "dismissedRows": 168, "agents": 40, "settings": 53, "unsentGroups": {"composers": 8, "feedback": 8, "queues": 3}, "catalogueSchema": 3}, "Prior data baseline differs")
    v.need(data["oldWholeRowsExact"] is True and data["sessionDifferences"] == data["addedSessions"] == [] and data["unsentWholeObjectEqual"] is True and data["allSettingsRawValuesEqual"] is True and data["databaseSchemaEqual"] is True and data["retainedInputsUnchanged"] is True, "Prior preservation differs")
    v.need(data["allSettingsDifferences"] == [] and data["catalogue"]["beforeSha256"] == data["catalogue"]["afterSha256"], "Prior settings/catalogue differ")
    tables = data["allTables"]
    v.need(set(tables) == {"agents", "dismissed_sessions", "sessions", "settings"}, "Prior table set differs")
    for name, count in (("agents", 40), ("dismissed_sessions", 168), ("sessions", 131), ("settings", 53)):
        t = tables[name]
        v.need(t["beforeRows"] == t["afterRows"] == count and t["schemaEqual"] is True, "Prior table counts/schema differ")
        if name != "agents":
            v.need(t["wholeRowsEqual"] is True and t["rowDifferences"] == [], "Prior non-Agent rows differ")
    changes = data["agentColumnComparison"]["changedRows"]
    v.need(len(changes) == 1 and changes[0]["identity"] == {"id": "codex", "name": "Codex"} and set(changes[0]["columns"]) == {"updated_at"}, "Prior Agent delta differs")
    v.need({key: delta[key] for key in EXACT_DELTA} == EXACT_DELTA and delta["canonicalValueHashesMatchedFullComparison"] is True and delta["allOtherColumnsEqualPerFullComparison"] is True and delta["retainedInputsUnchanged"] is True, "Prior timestamp evidence differs")
    v.need(delta["comparisonRef"] == {"path": comparison_path, "sha256": accepted["refs"][comparison_path]}, "Prior delta comparison reference differs")
    return {"passed": True, "baselineCommit": v.BASELINE_COMMIT, "currentSessionBaseline": 131, "priorUnsentGroups": {"composers": 8, "feedback": 8, "queues": 3}, "rawSettingsPreserved": 53, "reviewedDelta": EXACT_DELTA, "historicalDocumentCommit": DOC_SNAPSHOT_COMMIT, "historicalDocumentHashes": DOC_SNAPSHOTS, "boundary": "Prior immutable native/record/data evidence only; four current-document snapshots use the fixed record commit. No fabricated freeze-release or new normal quit. Current installation data is compared separately; prior source is not required to remain current."}


previous.verify_prior_baseline = verify_prior_baseline

if __name__ == "__main__":
    raise SystemExit(previous.main())
