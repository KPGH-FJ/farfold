"""Keep ten installation checks; bind the accepted, historical 51c5159f baseline."""
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


v = module("mcp_remove_install_candidate", OUT / "verify-candidate.py")
# Load the plain implementation, not a wrapper with another module's globals.
previous = module("mcp_remove_plain_install", OUT.parent / "skill-management-candidate/verify-install.py", "b9d2137705c6ef402d7a308a666742c33b4a9966650be50841213923fea65388")
previous.v = v
previous.PRIVATE = v.ROOT / "output/2026-10-11-mcp-remove-install"
DOC_SNAPSHOT_COMMIT = 'e8c3294f45a6bf46ad792503333f2c7ad2b34594'
DOC_SNAPSHOTS = {'docs/status.md': '4e7a384befeb9b7287f71ada1215331103a2ffcffebd800f84ab83aa98227c32', 'docs/architecture.md': '95f0b4362003a3a647d3169e32851714173417713f8957c143db2893b263feeb', 'plans/agent-access.md': 'fab8f3cac8f1d4e68d911cc789db1818149a022a823c9df02446af41c7d85002', 'docs/evidence/2026-10-09-capability-hardening/README.md': '266d6f59b884a2d42306c230aa30c3a752105131082e293f546a2d1277b7f552'}
PRIOR_REFS = {'output/2026-10-11-mcp-add-native/final-normal-exit.json': 'b4030159bf4b0257d363b0d4012c8f52c9aa1d82d00f63f87f7dad42937e09fb', 'output/2026-10-11-mcp-add-native/root-data-acceptance.json': '73262b1a8e943ca6369d651a8e06c87ef0ab5d55bc5c583fd1d65e2272b41262', 'output/2026-10-11-mcp-add-independent/native-final-independent.json': '664e81d2676ab7ea07d62df2464ea284caa1563f139a71592b02c743061d9dde', 'docs/evidence/2026-10-09-capability-hardening/mcp-add-candidate/native-independent.json': '0f9589bf409a2ece0ac5afa1687e7374bf32bbb16e056a60204403e26bc4e855', 'docs/evidence/2026-10-09-capability-hardening/mcp-add-candidate/installed-mcp-add.json': '680e943d7f303fae274de2409789d3b9098330c8ae7fdc914cf19f47e9e44b60', 'docs/evidence/2026-10-09-capability-hardening/mcp-add-candidate/record-gate.json': '24e2faa357e47a015ce935af8d90028f46e980ea443e1e4240b83ae5a8235cb9'}
EXACT_DELTA = {'table': 'agents', 'id': 'codex', 'column': 'updated_at', 'before': 1791655910815, 'after': 1791659928954}

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
    installed = records["installed-mcp-add.json"]
    gate = records["record-gate.json"]
    v.need(exit_record["normalQuitObserved"] is True and exit_record["forcedQuit"] is False and exit_record["formalProcessCountAfter"] == 0, "Prior app was not normally closed")
    v.need(exit_record["sourceInputCount"] == 1480 and exit_record["sourceInputsUnchanged"] is True and exit_record["formalFiveFilesUnchanged"] is True, "Prior native source/bundle identity differs")
    v.need(accepted["decision"] == "acceptExactObservedTimestampDeltaOnly" and accepted["acceptedDelta"] == EXACT_DELTA and accepted["allOtherRowsAndColumnsEqual"] is True and accepted["settingsAndWholeUnsentAndCatalogueEqual"] is True, "Prior exact data acceptance differs")
    v.need(independent["result"] == "passedWithinBoundedNativeScope" and native["status"] == "passedForThisInstalledNativeSliceWithExactAcceptedDelta", "Prior independent review differs")
    v.need(independent["findings"] == native["unresolvedBlockingFindings"] == [] and independent["acceptedDelta"] == EXACT_DELTA, "Prior independent findings/delta differ")
    v.need(native["sourceInputs"] == {"count": 1480, "unchangedBeforeAfter": True} and native["formalBundle"] == {"fiveFilesAndModesMatchCandidate": True, "exactProcessAbsentAtReview": True}, "Prior independent source/bundle differs")
    expected_checks = {"sourceAndCandidateInstallChain", "retainedNativeReferences", "reviewWithdrawalThenFreshExplicitConfirmation", "disabledAdditionAndReadOnlyObservationDistinguished", "duplicateNameNoSecondWrite", "markerAbsent", "officialTwoScopeSemanticCleanup", "exactDataDeltaAcceptedOnly", "noPrivateContentsEmbedded", "fullProductNotClaimed"}
    v.need(set(independent["checks"]) == expected_checks and all(x is True for x in independent["checks"].values()), "Prior independent checks incomplete")
    v.need(gate["result"] == "passedCurrentRecordGate" and gate["findings"] == [] and gate["engineering"] == installed["engineering"] and gate["allInstalledRecordRefsMatch"] is True and gate["installedRecordRefCount"] == len(installed["refs"]), "Prior record gate incomplete")
    v.need(gate["originalPlan"]["items"] == 122 and gate["originalPlan"]["orderedIdsTitlesCompletionConditionsExact"] is True and gate["originalPlan"]["allNewRowsExact"] is True, "Prior original requirements differ")
    v.need(installed["phase"] == "installedBoundedDefaultDisabledStdioAdditionVerified" and installed["engineering"]["inputCount"] == 1480 and installed["engineering"]["stableThroughNormalQuit"] is True and installed["engineering"]["sevenChecks"] == "passed", "Prior installed scope differs")
    v.need({r["path"]: r["sha256"] for r in gate["documents"]} == DOC_SNAPSHOTS, "Prior document snapshot differs")
    for doc in gate["documents"]:
        historical_ref(doc["path"], doc["sha256"])
        for ref in doc["newParagraphLinks"]:
            historical_ref(ref["path"], ref["sha256"])
    for ref in [gate["productContract"], *gate["protectedExistingDirtyDocuments"], gate["nativeRecord"], gate["independentNativeRecord"], independent["record"], independent["independentNativeReview"]]:
        historical_ref(ref["path"], ref["sha256"])
    close = installed["closeout"]
    v.need(close["normalQuit"] is True and close["forcedQuit"] is False and close["originalWholeSessions"] == 131 and close["newRetainedSessions"] == 0 and close["dismissedSessions"] == 168 and close["all53SettingsRawEqual"] is True and close["wholeUnsentObjectEqual"] is True and close["unsentGroups"] == [8, 8, 3] and close["worktreeCatalogueWholeEqual"] is True, "Prior installed data scope differs")
    # Historical private review is hash-bound, not recursively treated as current
    # source: its launch.rs reference describes the old candidate. Public/direct
    # native, acceptance and record-gate references remain checked individually.
    for record in (exit_record, accepted, independent, installed, gate):
        for name, expected in record_refs(record):
            historical_ref(name, expected)
    comparison_path = "output/2026-10-11-mcp-add-native-preparation/data-review/final-data-comparison-independent.json"
    timestamp_path = "output/2026-10-11-mcp-add-native-preparation/data-review/timestamp-delta-independent.json"
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
    v.need({key: delta["difference"][key] for key in EXACT_DELTA} == EXACT_DELTA and delta["agentRowsCompared"] == 40 and delta["columnsCompared"] == ["id", "name", "source", "command", "args", "env", "version", "handshake", "created_at", "updated_at"] and delta["allOtherAgentFieldsExact"] is True and delta["originalInputsHashSizeModeUnchanged"] is True, "Prior timestamp evidence differs")
    delta_refs = dict(record_refs(delta))
    v.need(delta_refs.get(comparison_path) == accepted["refs"][comparison_path], "Prior delta comparison reference differs")
    for field, column in (("beforeSha256", "beforeSha256"), ("afterSha256", "afterSha256")):
        v.need(delta["difference"][field] == changes[0]["columns"]["updated_at"][column], "Prior timestamp value hash differs")
    v.need(close["onlyAcceptedMetadataDelta"] == native["dataRetention"]["exactAcceptedDelta"] == EXACT_DELTA and close["allOtherAgentRowsAndColumnsExact"] is True, "Prior exact accepted scope differs")

    return {"passed": True, "baselineCommit": v.BASELINE_COMMIT, "currentSessionBaseline": 131, "priorUnsentGroups": {"composers": 8, "feedback": 8, "queues": 3}, "rawSettingsPreserved": 53, "reviewedDelta": EXACT_DELTA, "historicalDocumentCommit": DOC_SNAPSHOT_COMMIT, "historicalDocumentHashes": DOC_SNAPSHOTS, "boundary": "Prior immutable native/record/data evidence only; four current-document snapshots use the fixed record commit. No fabricated freeze-release or new normal quit. Current installation data is compared separately; prior source is not required to remain current."}


previous.verify_prior_baseline = verify_prior_baseline

if __name__ == "__main__":
    raise SystemExit(previous.main())
