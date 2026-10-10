"""Reuse the recorded seven-check runner for one frozen MCP-remove source set."""
import hashlib
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE.parent / "skill-management-checks/run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "a02f97d1d73275896841f78267e13fb70d2922478af02b1feda583afbef22fae"
spec = importlib.util.spec_from_file_location("mcp_remove_prior_checks", PRIOR)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
prior_inputs = runner.inputs
runner.BASE = BASE


def inputs():
    result = prior_inputs()
    for filename in ("actual-wire.json", "final-wire.json"):
        wire = "docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/" + filename
        assert not (runner.ROOT / wire).is_symlink()
        result[wire] = runner.sha(runner.ROOT / wire)
    wire = "docs/evidence/2026-10-09-capability-hardening/mcp-add/backend/actual-wire.json"
    assert not (runner.ROOT / wire).is_symlink()
    result[wire] = runner.sha(runner.ROOT / wire)
    wire = "docs/evidence/2026-10-09-capability-hardening/mcp-remove/backend/actual-wire.json"
    assert not (runner.ROOT / wire).is_symlink()
    result[wire] = runner.sha(runner.ROOT / wire)
    return dict(sorted(result.items()))


runner.inputs = inputs
prior_write = runner.write


def write(path, value):
    if path.name == "verification.json":
        value["boundary"] = "Seven commands executed sequentially on the recorded source set, including the actual Rust skill-management and MCP-management and MCP-add and MCP-remove wire consumed by the frontend. Engineering evidence only; not installed UI, real Agent, Windows, or full product acceptance."
    prior_write(path, value)


runner.write = write

if __name__ == "__main__":
    raise SystemExit(runner.main())
