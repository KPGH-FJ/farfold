"""Run seven checks once on the frozen explicitly selected history-search increment."""
import hashlib
import importlib.util
from pathlib import Path
import sys
sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE.parent / "attachment-archive-checks/run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "d5594b185b148165bc91a72271a5917342c8c8eea05d36d5648e8606d3b0b73f"
spec = importlib.util.spec_from_file_location("history_search_prior_checks", PRIOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner = module.runner
prior_inputs = runner.inputs
runner.BASE = BASE

def inputs():
    result = prior_inputs()
    directory = BASE.parent / "history-search/backend"
    for name in ("actual-wire.json", "final-wire.json"):
        wire = directory / name
        assert wire.is_file() and not wire.is_symlink()
        result[str(wire.relative_to(runner.ROOT))] = runner.sha(wire)
    return dict(sorted(result.items()))
runner.inputs = inputs
prior_write = module.prior_write

def write(path, value):
    if path.name == "verification.json":
        value["boundary"] = "Seven repository commands on recorded inputs including actual Rust history-search wire. Engineering only; official read-only history queries, native installed UI, Windows and whole P32 have separate evidence."
    prior_write(path, value)
runner.write = write
if __name__ == "__main__":
    raise SystemExit(runner.main())
