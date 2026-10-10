"""NEW-11 frontend checks; reuse Rust only for the exact prior input set."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[3]
OUT = BASE / "run-01"
PRIOR = BASE.parent / "worktree-native-followup-checks/run-02"
CANDIDATE = BASE.parent / "worktree-native-followup-candidate"
COMMIT = "9cbb3db9c43296865d954e45d13d483c55c51f94"
ALLOWED = {
    "src/components/EmptyState.tsx",
    "src/components/EmptyState.archived-draft.test.tsx",
    "src/App.prepared-draft-retirement.test.tsx",
}
OWNER = BASE.parent / "worktree-native-followup/new11/frontend/implementation.json"
previous = runpy.run_path(str(BASE.parent / "worktree-native-followup-checks/run-checks.py"))
inputs = previous["inputs"]
protected = previous["protected"]
write = previous["write"]
execute = previous["execute"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ref(path):
    return {"path": str(path.relative_to(ROOT)), "sha256": sha(path)}


def changed(a, b):
    return sorted(p for p in a.keys() | b.keys() if a.get(p) != b.get(p))


def head():
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def reuse(before):
    old = json.loads((PRIOR / "inputs-before.json").read_text())
    prior = json.loads((PRIOR / "verification.json").read_text())
    candidate = json.loads((CANDIDATE / "candidate.json").read_text())
    assert prior["allPassed"] and prior["sourceStable"] and prior["protectedUnchanged"]
    assert old == json.loads((PRIOR / "inputs-after.json").read_text())
    assert candidate["sourceCommit"] == COMMIT and head() == COMMIT
    assert candidate["engineeringVerification"]["sha256"] == sha(PRIOR / "verification.json")
    assert candidate["engineeringVerification"]["inputsSha256"] == sha(PRIOR / "inputs-before.json")
    assert candidate["engineeringVerification"]["inputsAfterSha256"] == sha(PRIOR / "inputs-after.json")
    assert json.loads((CANDIDATE / "candidate-inputs.json").read_text()) == old
    assert set(changed(old, before)) == ALLOWED, changed(old, before)
    assert all(before.get(p) == h for p, h in old.items() if p not in ALLOWED)
    assert all(p.startswith("src/") and "/fixtures/" not in p for p in ALLOWED)
    owner = json.loads(OWNER.read_text())
    assert {r["path"] for r in owner["ownedFiles"]} == ALLOWED
    assert all(before[r["path"]] == r["sha256"] for r in owner["ownedFiles"])
    rust_status = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=all", "--", "src-tauri",
         ".cargo", "rust-toolchain", "rust-toolchain.toml"], cwd=ROOT, text=True)
    assert not rust_status.strip(), rust_status
    absent = [".cargo", "rust-toolchain", "rust-toolchain.toml", "src-tauri/.cargo",
              "src-tauri/rust-toolchain", "src-tauri/rust-toolchain.toml"]
    assert all(not (ROOT / p).exists() for p in absent)
    checks = []
    # Verify all seven original raw receipts, even though only three are reused.
    for item in prior["checks"]:
        assert item["exitCode"] == 0 and item["executedInThisRun"]
        assert sha(ROOT / item["log"]) == item["sha256"]
        if item["name"] in ("cargo-fmt", "clippy", "rust"):
            checks.append({**item, "executedInThisRun": False, "reused": True,
                           "originalExecutionReceipt": ref(PRIOR / "verification.json"),
                           "reason": "Exact Rust/native/Cargo/config/lock/shared-fixture inputs unchanged; only the three allowlisted frontend paths differ."})
    assert {c["name"] for c in checks} == {"cargo-fmt", "clippy", "rust"}
    rust = next(c for c in checks if c["name"] == "rust")
    assert "test result: ok. 1348 passed; 0 failed; 6 ignored;" in (ROOT / rust["log"]).read_text()
    reused = {
        "priorReceipt": ref(PRIOR / "verification.json"),
        "priorInputsBefore": ref(PRIOR / "inputs-before.json"),
        "priorInputsAfter": ref(PRIOR / "inputs-after.json"),
        "candidate": ref(CANDIDATE / "candidate.json"),
        "candidateInputs": ref(CANDIDATE / "candidate-inputs.json"),
        "candidateCommit": COMMIT, "changedInputs": changed(old, before),
        "previousInputCount": len(old), "currentInputCount": len(before),
        "allOtherInputHashesIdentical": True,
        "rustInputCount": sum(p.startswith("src-tauri/") for p in old),
        "nonFrontendInputCount": sum(not p.startswith("src/") for p in old),
        "sharedFixtureHashesUnchanged": True, "rustWorkingTreeClean": True,
        "absentRepositoryCargoToolchainOverrides": absent,
        "allSevenOriginalLogHashesMatch": True,
        "boundary": "Actual previous Rust fmt/clippy/test evidence is reused, not executed now. This is not a fresh dependency/toolchain/environment revalidation or installed product acceptance.",
    }
    return checks, reused


def summaries(checks):
    result = {}
    for check in checks:
        if check["name"] in ("frontend", "rust"):
            raw = re.sub(r"\x1b\[[0-9;]*m", "", (ROOT / check["log"]).read_text())
            result[check["name"]] = [line.strip() for line in raw.splitlines()
                if re.match(r"\s*(Test Files|Tests)\s+", line) or line.startswith("test result:")]
    return result


def source():
    OUT.mkdir(exist_ok=False)
    assert protected()
    before = inputs()
    checks, reuse_receipt = reuse(before)
    write(OUT / "inputs-before.json", before)
    write(OUT / "rust-reuse.json", reuse_receipt)
    closure = {"sourceBase": head(), "fileCount": len(ALLOWED), "files": {
        p: {"sha256": before[p], "lines": len((ROOT / p).read_text().splitlines())}
        for p in sorted(ALLOWED)}, "ownerReceipt": ref(OWNER)}
    assert all(v["lines"] <= 1500 for v in closure["files"].values())
    write(BASE / "source-closure.json", closure)
    for name, argv in [("typecheck", ["corepack", "pnpm", "typecheck"]),
                       ("frontend", ["corepack", "pnpm", "test"]),
                       ("build", ["corepack", "pnpm", "build"])]:
        checks.append(execute(OUT, name, argv))
    after = inputs()
    write(OUT / "inputs-after-source.json", after)
    record = {"checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sourceBase": head(), "inputCount": len(before), "sourceStable": before == after,
              "changedDuringChecks": changed(before, after), "protectedUnchanged": protected(),
              "checks": checks, "counts": summaries(checks), "formatPending": True,
              "sourceChecksPassed": before == after and protected() and head() == COMMIT
                 and all(c["exitCode"] == 0 for c in checks)}
    write(OUT / "source-verification.json", record)
    print(json.dumps({k: record[k] for k in ("sourceChecksPassed", "inputCount", "counts")}), flush=True)
    return 0 if record["sourceChecksPassed"] else 1


def final():
    before = json.loads((OUT / "inputs-before.json").read_text())
    record = json.loads((OUT / "source-verification.json").read_text())
    assert record["sourceChecksPassed"] and before == inputs() and protected()
    reuse(before)
    for item in record["checks"]:
        assert sha(ROOT / item["log"]) == item["sha256"]
    attempt = 1
    while (OUT / f"format-{attempt:02}.txt").exists():
        attempt += 1
    fmt = execute(OUT, f"format-{attempt:02}", ["corepack", "pnpm", "format:check"])
    fmt["name"] = "format"
    after = inputs()
    after_path = OUT / f"inputs-after-final-{attempt:02}.json"
    write(after_path, after)
    checks = record["checks"] + [fmt]
    result = {"checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sourceBase": head(), "inputCount": len(before), "sourceStable": before == after,
              "changedInputs": changed(before, after), "protectedUnchanged": protected(),
              "inputsBefore": ref(OUT / "inputs-before.json"), "inputsAfter": ref(after_path),
              "sourceClosure": ref(BASE / "source-closure.json"), "runner": ref(Path(__file__).resolve()),
              "rustReuse": ref(OUT / "rust-reuse.json"),
              "sourceStageReceipt": ref(OUT / "source-verification.json"),
              "checks": checks, "counts": summaries(checks),
              "previousFrontendCounts": json.loads((PRIOR / "verification.json").read_text())["counts"]["frontend"],
              "executedCheckCount": 4, "reusedCheckCount": 3,
              "allPassed": before == after and protected() and head() == COMMIT
                 and len(checks) == 7 and all(c["exitCode"] == 0 for c in checks),
              "boundary": "Full frontend/type/build/repository format executed for NEW-11. Three Rust checks explicitly reuse exact-input prior run-02 evidence (1348 passed, 6 ignored). Browser, installed, real-Agent and H17 acceptance remain separate."}
    write(OUT / f"verification-final-{attempt:02}.json", result)
    if result["allPassed"]:
        write(BASE / "final-verification.json", result)
    print(json.dumps({k: result[k] for k in ("allPassed", "inputCount", "counts")}), flush=True)
    return 0 if result["allPassed"] else 1


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("source", "final"):
        raise SystemExit("Specify source or final; source output is immutable.")
    raise SystemExit(source() if sys.argv[1] == "source" else final())
