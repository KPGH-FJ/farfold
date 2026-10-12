"""Run seven checks once for the frozen selected-attachment archive increment."""
import hashlib
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE.parent / "mcp-http-add-checks/run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "1ae5566cc38f5de18bbee98340fb29cc782eaeab0e765272773c79ee994c8552"
spec = importlib.util.spec_from_file_location("archive_prior_checks", PRIOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner = module.runner
prior_inputs = runner.inputs
runner.BASE = BASE


def inputs():
    result = prior_inputs()
    directory = BASE.parent / "attachment-archive/backend"
    wires = [directory / name for name in ("canonical-wire.json", "actual-wire.json")]
    for wire in wires:
        assert wire.is_file(), "Actual Rust wire must be present before integration checks"
        assert not wire.is_symlink()
        result[str(wire.relative_to(runner.ROOT))] = runner.sha(wire)
    return dict(sorted(result.items()))


runner.inputs = inputs
prior_write = module.prior_write


def write(path, value):
    if path.name == "verification.json":
        value["boundary"] = "Seven repository commands executed on the recorded source set and actual Rust archive wire consumed by the frontend. Engineering only: controlled browser and real filesystem tests have their own scope; no installed archive, official Agent, Windows, or whole product acceptance is inferred."
    prior_write(path, value)


runner.write = write

if __name__ == "__main__":
    raise SystemExit(runner.main())
