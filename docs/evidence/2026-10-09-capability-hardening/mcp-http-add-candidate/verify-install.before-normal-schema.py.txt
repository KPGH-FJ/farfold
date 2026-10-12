"""Keep ten installation checks; bind the accepted, historical 8fa557c0 baseline."""
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


v = module("mcp_http_add_install_candidate", OUT / "verify-candidate.py")
# Load the plain implementation, not a wrapper with another module's globals.
previous = module("mcp_http_add_plain_install", OUT.parent / "skill-management-candidate/verify-install.py", "b9d2137705c6ef402d7a308a666742c33b4a9966650be50841213923fea65388")
previous.v = v
previous.PRIVATE = v.ROOT / "output/2026-10-11-mcp-http-add-install"
DOC_SNAPSHOT_COMMIT = '55441316981b59ef9805255e27b12b0c6761aa34'
DOC_SNAPSHOTS = {'docs/status.md': 'a77cb83479cabc06873f78ec6d53d39e8c43ed38a1eecea08850d28074808577', 'docs/architecture.md': '8cd5c2802f56d5c7fd348ae2038e227b629d975d91fb3da427baef7c834c4a5e', 'plans/agent-access.md': '3942049dcdddb481c0227c9dd8c57888b2aa46b80ff7b059e1897816d2a82484', 'docs/evidence/2026-10-09-capability-hardening/README.md': '821cea6eb540b328a0e7fcb4f2f3ef1cfcac519a5412fb3da1b762da7ea1ac03'}
PRIOR_REFS = {'output/2026-10-11-mcp-remove-native/final-normal-exit.json': '111cfa0ed155bbbe15149d33d1ce82e7bd620d4d158769d4d91bddc9a930e93b', 'output/2026-10-11-mcp-remove-native/root-data-acceptance.json': '04d4d70a105a27e7c84101a45145c59bd15d1680b4fb3d255c23e08d155ff10c', 'output/2026-10-11-mcp-remove-independent/native-final-independent.json': '9babc1638c29043fe6edc9654a6c375c84f0331f09bd6138754dfbdb31c915f0', 'docs/evidence/2026-10-09-capability-hardening/mcp-remove-candidate/native-independent.json': '8d29e2b94202126da55b11782f755f964d1d9d9015a39c60b265a935f47eb891', 'docs/evidence/2026-10-09-capability-hardening/mcp-remove-candidate/installed-mcp-remove.json': '6b3d946ec68ef88a75123ece438606c5c3c44af7ce5366e4dc0dff125f647a77', 'output/2026-10-11-mcp-remove-root/record-gate.json': '165ca90f286f582f04e89826d2836410ad20dc94309442f33c0a0f5734c23554'}
EXACT_DELTA = {'table': 'agents', 'id': 'codex', 'column': 'updated_at', 'before': 1791659928954, 'after': 1791663025176}

def historical_ref(name, expected):
    if name in DOC_SNAPSHOTS:
        v.need(expected == DOC_SNAPSHOTS[name], "Unexpected historical document hash")
        raw = subprocess.run(["git", "show", DOC_SNAPSHOT_COMMIT + ":" + name], cwd=v.ROOT, check=True, capture_output=True).stdout
        v.need(hashlib.sha256(raw).hexdigest() == expected, "Historical document blob differs: " + name)
    else:
        v.need(v.sha(v.relative(name)) == expected, "Prior referenced file changed: " + name)


def record_refs(record):
    refs = record["refs"] if "refs" in record else record["references"]
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
    installed = records["installed-mcp-remove.json"]
    gate = records["record-gate.json"]
    v.need(exit_record["normalQuitObserved"] is True and exit_record["forcedQuit"] is False and exit_record["formalProcessCountAfter"] == 0, "Prior app was not normally closed")
    v.need(exit_record["sourceInputCount"] == 1497 and exit_record["sourceInputsUnchanged"] is True and exit_record["formalFiveFilesUnchanged"] is True, "Prior native source/bundle identity differs")
    v.need(accepted["decision"] == "acceptExactObservedTimestampDeltaOnly" and accepted["acceptedDelta"] == EXACT_DELTA and accepted["allOtherRowsAndColumnsEqual"] is True and accepted["settingsAndWholeUnsentAndCatalogueEqual"] is True, "Prior exact data acceptance differs")
    v.need(independent["status"] == "boundedInstalledRemovalEvidenceIndependentlyReviewed" and native["status"] == "boundedInstalledNativeEvidenceIndependentlyReviewed", "Prior independent review differs")
    v.need(independent["result"] == native["result"] == "noAdditionalBlockingFindingWithinObservedScope" and independent["acceptedDataDelta"] == EXACT_DELTA, "Prior independent findings/delta differ")
    expected_names = {"Candidate, installation and source identity", "Explicit review and withdrawal", "Removal and separate observation", "Official fixture restoration", "Retained data and normal quit", "Public claims and execution limits"}
    checks = independent["checks"]
    v.need(len(checks) == 6 and {x["name"] for x in checks} == expected_names and all(x["passed"] is True for x in checks), "Prior independent checks incomplete")
    expected_private = {"Exact installed identity and source", "Review and withdrawal", "One explicit removal and separate readonly observation", "Fresh complete report and restored draft", "Official fixture semantics and owned cleanup", "Normal quit and exact retained data"}
    private_checks = native["checks"]
    v.need(len(private_checks) == 6 and {x["name"] for x in private_checks} == expected_private and all(x["passed"] is True for x in private_checks), "Prior private native checks incomplete")
    identity = next(x for x in private_checks if x["name"] == "Exact installed identity and source")
    v.need(identity["currentInputs"] == 1497 and identity["formalFiveFilesMatchCandidate"] is True and identity["freshExactProcessAbsent"] is True, "Prior independent identity differs")
    v.need(gate["result"] == "passedBoundedRecordConsistencyGate" and gate["allDirectReferenceHashesMatch"] is True and gate["publicInstalledRefsChecked"] == len(installed["refs"]), "Prior record gate incomplete")
    plan = gate["originalPlan"]
    v.need(plan["originalUniqueItems"] == 122 and plan["orderedIdsTitlesCompletionConditionsEqualHead"] is True and plan["newItems"] == 16 and plan["entireNewRowsEqualHead"] is True, "Prior original requirements differ")
    v.need(installed["phase"] == "installedBoundedDisabledMcpRemovalVerified" and installed["engineering"]["inputCount"] == 1497 and installed["engineering"]["stableThroughNormalQuit"] is True and installed["engineering"]["sevenChecks"] == "passed", "Prior installed scope differs")
    v.need(gate["documents"] == DOC_SNAPSHOTS and gate["productMatchesHeadAndPrecommit"] is True, "Prior document snapshot differs")
    for name, expected in DOC_SNAPSHOTS.items():
        historical_ref(name, expected)
    historical_ref("PRODUCT.md", gate["productContractSha256"])
    for name, expected in gate["protectedDirtyDocuments"].items():
        historical_ref(name, expected)
    close = installed["closeout"]
    v.need(close["normalQuit"] is True and close["forcedQuit"] is False and close["originalWholeSessions"] == 131 and close["newRetainedSessions"] == 0 and close["dismissedSessions"] == 168 and close["all53SettingsRawEqual"] is True and close["wholeUnsentObjectEqual"] is True and close["unsentGroups"] == [8, 8, 3] and close["worktreeCatalogueWholeEqual"] is True, "Prior installed data scope differs")
    # Historical private review is hash-bound, not recursively treated as current
    # production source. All public/direct native and acceptance references remain
    # checked. Only the four fixed document paths may use the fixed Git commit.
    for record in (exit_record, accepted, independent, installed, gate):
        for name, expected in record_refs(record):
            historical_ref(name, expected)
    comparison_path = "output/2026-10-11-mcp-remove-native-preparation/data-review/final-data-comparison-independent.json"
    timestamp_path = "output/2026-10-11-mcp-remove-native-preparation/data-review/timestamp-delta-independent.json"
    v.need(comparison_path in accepted["refs"] and timestamp_path in accepted["refs"], "Prior accepted data references missing")
    data, delta = load(v.relative(comparison_path)), load(v.relative(timestamp_path))
    v.need(data["baseline"] == {"wholeSessionRows": 131, "dismissedRows": 168, "agents": 40, "settings": 53, "unsentGroups": {"composers": 8, "feedback": 8, "queues": 3}, "catalogueSchema": 3}, "Prior data baseline differs")
    v.need(data["sourceCommit"] == delta["sourceCommit"] == v.BASELINE_COMMIT and data["oldWholeRowsExact"] is True and data["sessionDifferences"] == data["addedSessions"] == [] and data["unsentWholeObjectEqual"] is True and data["allSettingsRawValuesEqual"] is True and data["databaseSchemaEqual"] is True and data["retainedInputsUnchanged"] is True, "Prior preservation differs")
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
    changes2 = delta["agentDifferences"]
    v.need(len(changes2) == 1 and changes2[0]["table"] == "agents" and changes2[0]["id"] == "codex" and set(changes2[0]["columns"]) == {"updated_at"}, "Prior numeric delta identity differs")
    cell = changes2[0]["columns"]["updated_at"]
    v.need(cell["beforePresent"] is True and cell["afterPresent"] is True and cell["before"] == EXACT_DELTA["before"] and cell["after"] == EXACT_DELTA["after"], "Prior exact timestamp values differ")
    v.need(delta["beforeAgents"] == delta["afterAgents"] == 40 and delta["allOtherAgentCellsExact"] is True and delta["allTablesMatchPriorComparison"] is True and delta["originalInputsHashSizeModeUnchanged"] is True, "Prior timestamp evidence differs")
    delta_refs = dict(record_refs(delta))
    v.need(delta_refs.get(comparison_path) == delta["comparisonSha256"] == accepted["refs"][comparison_path], "Prior delta comparison reference differs")
    for field in ("beforeSha256", "afterSha256"):
        v.need(cell[field] == changes[0]["columns"]["updated_at"][field], "Prior timestamp value hash differs")
    v.need(close["onlyAcceptedMetadataDelta"] == native["data"]["acceptedDelta"] == EXACT_DELTA and close["allOtherAgentRowsAndColumnsExact"] is True and native["data"]["allOtherAgentCellsEqual"] is True, "Prior exact accepted scope differs")
    return {"passed": True, "baselineCommit": v.BASELINE_COMMIT, "currentSessionBaseline": 131, "priorUnsentGroups": {"composers": 8, "feedback": 8, "queues": 3}, "rawSettingsPreserved": 53, "reviewedDelta": EXACT_DELTA, "historicalDocumentCommit": DOC_SNAPSHOT_COMMIT, "historicalDocumentHashes": DOC_SNAPSHOTS, "boundary": "Prior immutable native/record/data evidence only. Four document snapshots use fixed 55441316 Git blobs. No fabricated new quit or release; fresh installation snapshots are required separately. Old source need not remain current."}


previous.verify_prior_baseline = verify_prior_baseline

if __name__ == "__main__":
    raise SystemExit(previous.main())
