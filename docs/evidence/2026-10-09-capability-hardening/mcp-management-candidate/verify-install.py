"""Reuse installation checks with the exact, accepted 4d3 native data baseline."""
import hashlib
import importlib.util
from pathlib import Path
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


v = module("mcp_install_candidate", OUT / "verify-candidate.py")
previous = module("mcp_prior_install", OUT.parent / "skill-management-candidate/verify-install.py", "b9d2137705c6ef402d7a308a666742c33b4a9966650be50841213923fea65388")
previous.v = v
previous.PRIVATE = v.ROOT / "output/2026-10-11-mcp-management-install"
PRIOR_REFS = {
    "output/2026-10-11-skill-management-native/final-normal-exit.json": "a4f961bf8cfde97dd6fa8e7469831134e593b76315a0cf1dc0b05284cce8eebf",
    "output/2026-10-11-skill-management-native/freeze-release.json": "cb67d8fbc009ac05ae00d559b4027abc2d5344033f35348b639142a29a8f8d99",
    "output/2026-10-11-skill-management-native/root-data-acceptance.json": "db3f33e5a042c3cd66d980e4a1c125ccd2c414a63caee6c4ac605fa49c6cea35",
    "docs/evidence/2026-10-09-capability-hardening/skill-management-candidate/native-independent.json": "abf77920f365645bf834de2fe42291cdd438df69a839466406b18021d45bf527",
    "docs/evidence/2026-10-09-capability-hardening/skill-management-candidate/installed-skill-management.json": "b8dcc142bfbd6c1c8842a540cd71f86935489768b40d5cdefb76133f4daa6d79",
}


def verify_prior_baseline(normal, load):
    v.need(normal["userAuthorizedContinuousDevelopment"] is True and normal["normalQuitObserved"] is True and normal["forcedQuit"] is False and normal["formalProcessCountAfter"] == 0 and normal["sourceCommit"] == v.BASELINE_COMMIT, "Prior normal exit missing")
    v.need(normal["refs"] == PRIOR_REFS and bool(normal["normalQuitEvidence"]), "Prior baseline references differ")
    records = {}
    for name, expected in PRIOR_REFS.items():
        path = v.relative(name)
        v.need(v.sha(path) == expected, "Prior baseline evidence changed: " + name)
        records[path.name] = load(path)
    v.need(all(r["sourceCommit"] == v.BASELINE_COMMIT for r in records.values()), "Prior source identity differs")
    exit_record = records["final-normal-exit.json"]
    release = records["freeze-release.json"]
    accepted = records["root-data-acceptance.json"]
    independent = records["native-independent.json"]
    v.need(exit_record["normalQuitObserved"] is True and exit_record["forcedQuit"] is False and exit_record["formalProcessCountAfter"] == 0, "Prior app was not normally closed")
    v.need(exit_record["sourceInputCount"] == 1439 and exit_record["sourceInputsUnchanged"] is True and exit_record["formalFiveFilesUnchanged"] is True, "Prior native source/bundle identity differs")
    v.need(release["released"] is True and release["inputCount"] == 1439 and release["allInputsStillEqual"] is True, "Prior source freeze was not released")
    v.need(accepted["status"] == "acceptedExactObservedDeltasForThisBoundedJourney" and accepted["newMetadataSessions"] == 0, "Prior observed deltas were not accepted")
    preserved = accepted["preserved"]
    v.need(preserved == {"wholeSessionRows": 131, "dismissedSessions": 168, "agents": 40, "settings": 53, "allRawSettingsEqual": True, "unsentWholeObjectEqual": True, "unsentGroups": [8, 8, 3], "catalogueWholeEqual": True, "schemaEqual": True, "storedModelReasoningServiceUnchanged": True}, "Prior data preservation differs")
    v.need(accepted["acceptedAgentDelta"] == {"id": "codex", "name": "Codex", "onlyColumn": "updated_at", "before": 1791645810048, "after": 1791651774403}, "Prior exact timestamp delta differs")
    v.need(independent["result"] == "independentEvidenceReviewPassedWithKnownNew16Unresolved", "Prior independent review differs")
    v.need(independent["checks"]["old131WholeSessionRowsEqual"] is True and independent["checks"]["all53SettingsRawEqual"] is True and independent["checks"]["newRetainedSessionRows"] == 0, "Prior independent data scope differs")
    for record in (exit_record, release, accepted, records["installed-skill-management.json"]):
        for name, expected in record["refs"].items():
            path = v.relative(name)
            v.need(v.sha(path) == expected, "Prior referenced file changed: " + name)
    for ref in independent["refs"]:
        v.need(v.sha(v.relative(ref["path"])) == ref["sha256"], "Prior independent reference changed")
    return {"passed": True, "baselineCommit": v.BASELINE_COMMIT, "currentSessionBaseline": 131, "priorUnsentGroups": {"composers": 8, "feedback": 8, "queues": 3}, "rawSettingsPreserved": 53, "reviewedDelta": "Only the exact Codex updated_at change recorded in the prior bounded journey.", "boundary": "Immutable prior normal exit, data acceptance and independent evidence reviewed. Current installation data is compared separately. No new native action or full product acceptance is inferred."}


previous.verify_prior_baseline = verify_prior_baseline

if __name__ == "__main__":
    raise SystemExit(previous.main())
