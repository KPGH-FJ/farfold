"""Run the seven checks once on the frozen HTTP addition source and actual wire."""
import hashlib
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
PRIOR = BASE.parent / "mcp-remove-checks/run-checks.py"
assert hashlib.sha256(PRIOR.read_bytes()).hexdigest() == "ae810699a6deab02c7bed4be9d2069a1897819fbe97f24381bad22457429d1e2"
spec = importlib.util.spec_from_file_location("mcp_http_add_prior_checks", PRIOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner = module.runner
prior_inputs = runner.inputs
runner.BASE = BASE


def inputs():
    result = prior_inputs()
    wire = "docs/evidence/2026-10-09-capability-hardening/mcp-http-add/backend/actual-wire.json"
    assert not (runner.ROOT / wire).is_symlink()
    result[wire] = runner.sha(runner.ROOT / wire)
    return dict(sorted(result.items()))


runner.inputs = inputs
prior_write = module.prior_write


def write(path, value):
    if path.name == "verification.json":
        value["boundary"] = "Seven commands executed sequentially on the recorded source set, including unchanged historical extension wires and actual synthetic Rust HTTP-add wire consumed by frontend tests. Engineering evidence only; not installed UI, real Agent, connection/authentication, Windows, or whole market acceptance."
    prior_write(path, value)


runner.write = write

if __name__ == "__main__":
    raise SystemExit(runner.main())
