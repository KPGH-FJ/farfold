"""Apply the existing nine checks to the next candidate and exact 4d3 baseline."""
import hashlib
import importlib.util
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
OUT = Path(__file__).resolve().parent
PRIOR = OUT.parent / "skill-management-candidate/verify-candidate.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "babc09057ab144137771918cf05ef97ad0ff6f6d545c398a6e6eec8172d1e51b"
spec = importlib.util.spec_from_file_location("mcp_prior_candidate", PRIOR)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
checks.OUT = OUT
checks.BASELINE_COMMIT = "4d3bd81e86cbd7a877055d321f89fb8de494fbf8"
checks.BASELINE = OUT.parent / "skill-management-candidate/candidate.json"
checks.BASELINE_SHA = "8d14ddd9dfd9f56978582be04652566cbe8da01a3a9540f4665f84ad289ea6eb"
checks.TOP += ["docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/actual-wire.json"]
checks.TOP += ["docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/final-wire.json"]


def arguments():
    checks.need(len(sys.argv) == 3 and re.fullmatch("[0-9a-f]{40}", sys.argv[1]), "Expected exact commit and engineering verification path")
    proof = checks.relative(sys.argv[2])
    checks.need(proof.is_relative_to(checks.BASE / "mcp-management-checks"), "Wrong engineering directory")
    return sys.argv[1], proof


def baseline():
    checks.need(checks.sha(checks.BASELINE) == checks.BASELINE_SHA, "Installed baseline receipt changed")
    prior = checks.read(checks.BASELINE)
    checks.need(prior["sourceCommit"] == checks.BASELINE_COMMIT and prior["phase"] == "internalCandidatePreparedNotInstalled", "Wrong installed baseline")
    actual = checks.bundle(checks.FORMAL)
    checks.need(actual == (prior["candidateFiles"], prior["candidateModes"]), "Formal application differs from 4d3bd81e")
    return actual


checks.arguments = arguments
checks.baseline = baseline
# The existing prepare/install helpers consume this same reviewed interface.
for name in dir(checks):
    if not name.startswith("_"):
        globals()[name] = getattr(checks, name)

if __name__ == "__main__":
    raise SystemExit(main())
