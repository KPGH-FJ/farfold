"""Run all seven checks once after the next official history slice freezes."""
import hashlib
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE.parent / "history-search-checks/run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "d3ff672917db69804734753896fa755c1285562161efb4edb96472a182e2b47d"
spec = importlib.util.spec_from_file_location("sdk_history_prior_checks", PRIOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner = module.runner
prior_inputs = runner.inputs
runner.BASE = BASE


def inputs():
    result = prior_inputs()
    wire = BASE.parent / "claude-history/backend/actual-wire.json"
    assert wire.is_file() and not wire.is_symlink(), "Actual SDK serde wire must precede integration checks"
    result[str(wire.relative_to(runner.ROOT))] = runner.sha(wire)
    return dict(sorted(result.items()))


runner.inputs = inputs
prior_write = module.prior_write


def write(path, value):
    if path.name == "verification.json":
        value["boundary"] = "Seven commands actually executed on frozen source and official-history serde wires, including the new SDK partial-projection branch. Controlled fixtures, actual official SDK calls, installed App, Windows and whole P32 have separate evidence. No previous native commands are reused when the native source changes."
    prior_write(path, value)


runner.write = write
if __name__ == "__main__":
    raise SystemExit(runner.main())
