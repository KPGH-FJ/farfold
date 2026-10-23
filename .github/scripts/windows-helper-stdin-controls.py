"""Run seven exact helper input controls against the existing P27 build.

No build, download, Agent, environment mutation, PID lookup or process-tree kill.
The existing raw root is read-only; this owns one new child evidence directory.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


SOURCE_PATTERNS = (
    "src-tauri",
    ".github/scripts/windows-p27-native.ps1",
    ".github/scripts/windows-native-loader-diagnostics.ps1",
    ".github/scripts/windows-pe-resource-inspection.py",
    ".github/workflows/windows-p27-native.yml",
    ".github/scripts/windows-helper-stdin-controls.py",
    ".github/scripts/windows-helper-stdin-cases.json",
)
INPUT_PREFIX = "browser_sharing::helper_io::windows::input::tests::"
WORKER_PREFIX = "browser_sharing::helper::windows_input_tests::"
EXPECTED_CASES = (
    (INPUT_PREFIX + "standard_readonly_pipe_preserves_single_chunk_demand_and_limit", False),
    (INPUT_PREFIX + "paused_native_phases_keep_real_completion_and_dirty_ownership", False),
    (INPUT_PREFIX + "eof_and_inflight_retirement_do_not_fabricate_completion", False),
    (INPUT_PREFIX + "overlapped_and_non_pipe_inputs_are_rejected_before_data_io", False),
    (WORKER_PREFIX + "same_binary_helper_idle_stop_keeps_mcp_and_fifo", True),
    (WORKER_PREFIX + "real_worker_pending_peek_keeps_fifo_and_original_one_second_deadline", False),
    (WORKER_PREFIX + "real_worker_positive_unpublished_and_reading_stop_close_before_ack", False),
)
BYTE_LIMIT = 1024 * 1024
CASE_SECONDS = 90
RETIRE_SECONDS = 5
GROUP_SECONDS = 720
SUMMARY = re.compile(
    r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; "
    r"(\d+) measured; (\d+) filtered out; finished in (\d+(?:\.\d+)?)s$"
)
TEST_LINE = re.compile(r"^test (\S+) \.\.\. (ok|FAILED|ignored(?:, .*)?)$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        before = os.fstat(source.fileno())
        while block := source.read(1024 * 1024):
            hasher.update(block)
        after = os.fstat(source.fileno())
    # Compare fields from the same descriptor API, not Windows path/FD ctime.
    require(
        (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
        "file changed while hashing",
    )
    return hasher.hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def read_json(path, limit=4 * 1024 * 1024):
    with path.open("rb") as source:
        raw = source.read(limit + 1)
    require(len(raw) <= limit, "JSON input exceeds its read bound")
    return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_object), digest(raw)


def write_json(path, value):
    # Exclusive output creation prevents changing any earlier execution receipt.
    with path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=True, indent=2)
        output.write("\n")


def git(repo, *args):
    result = subprocess.run(
        ["git", *args], cwd=repo, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
    )
    require(result.returncode == 0, "source identity command failed")
    require(len(result.stdout) <= 4 * 1024 * 1024, "source inventory exceeds read bound")
    return result.stdout


def source_inputs(repo, expected_head):
    require(git(repo, "rev-parse", "HEAD").decode("ascii").strip() == expected_head,
            "source head changed")
    listed = git(repo, "ls-files", "-z", "--", *SOURCE_PATTERNS).decode("utf-8")
    require(listed.endswith("\0"), "source inventory is incomplete")
    paths = listed[:-1].split("\0")
    require(len(paths) > 20 and len(paths) == len(set(paths)), "source inventory is not unique")
    require(all(path in paths for path in SOURCE_PATTERNS[1:]), "required source input missing")
    require(any(path.startswith("src-tauri/") for path in paths), "crate inputs missing")
    result = {}
    for name in sorted(paths):
        require("\\" not in name and not name.startswith("/")
                and ".." not in name.split("/"), "invalid tracked source path")
        result[name] = file_hash(repo / name)
    return result


def check_map(value):
    require(type(value) is dict and len(value) > 20, "build source map missing")
    require(all(type(k) is str and type(v) is str and re.fullmatch(r"[a-f0-9]{64}", v)
                for k, v in value.items()), "build source map has invalid hashes")


def load_cases(path):
    manifest, sha = read_json(path, 65536)
    require(type(manifest) is dict and type(manifest.get("schema")) is int
            and manifest["schema"] == 1, "case schema mismatch")
    require(manifest.get("group") == "helper-stdin-controls", "case group mismatch")
    cases = manifest.get("cases")
    require(type(cases) is list and len(cases) == 7, "expected seven exact parents")
    for case, (expected, ignored) in zip(cases, EXPECTED_CASES):
        require(type(case) is dict and case.get("test") == expected
                and type(case.get("ignored")) is bool and case["ignored"] is ignored,
                "case identity or ignored condition mismatch")
        require(type(case.get("requiresSameBuildHelper")) is bool
                and case["requiresSameBuildHelper"] is ignored,
                "helper requirement mismatch")
        require(type(case.get("name")) is str
                and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", case["name"]), "invalid case name")
    require(len({case["name"] for case in cases}) == 7, "duplicate case name")
    return cases, sha


def select_programs(repo, selection, expected_head):
    require(type(selection) is dict and selection.get("sourceHead") == expected_head,
            "build selection head mismatch")
    programs = {}
    for key, sha_key in (("testBinary", "testBinarySha256"), ("helperBinary", "helperBinarySha256")):
        name, sha = selection.get(key), selection.get(sha_key)
        require(type(name) is str and type(sha) is str
                and re.fullmatch(r"[a-f0-9]{64}", sha), "selected program identity missing")
        path = Path(name)
        require(path.is_absolute(), "selected program path is not absolute")
        actual = path.resolve(strict=True)
        if key == "testBinary":
            require(actual.parent == (repo / "src-tauri/target/debug/deps").resolve(strict=True)
                    and actual.name.startswith("farfold_lib-") and actual.suffix.lower() == ".exe",
                    "unexpected selected libtest location")
        else:
            require(actual == (repo / "src-tauri/target/debug/farfold.exe").resolve(strict=True),
                    "unexpected selected helper location")
        require(file_hash(actual) == sha, "selected program bytes changed")
        programs[key] = {"path": str(actual), "sha256": sha}
    return programs


def programs_unchanged(programs):
    return all(file_hash(Path(value["path"])) == value["sha256"] for value in programs.values())


def parse_stdout(raw, exact):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return {"valid": False, "reason": "stdout-not-utf8"}
    summary_lines = [line for line in lines if line.startswith("test result:")]
    test_lines = [line for line in lines if line.startswith("test ") and not line.startswith("test result:")]
    summaries = [SUMMARY.fullmatch(line) for line in summary_lines]
    tests = [TEST_LINE.fullmatch(line) for line in test_lines]
    runs = [line for line in lines if re.fullmatch(r"running \d+ tests?", line)]
    valid = (
        len(summaries) == 1 and summaries[0] is not None
        and len(tests) == 1 and tests[0] is not None
        and tests[0].group(1) == exact and tests[0].group(2) == "ok"
        and summaries[0].group(1) == "ok"
        and tuple(map(int, summaries[0].group(2, 3, 4, 5))) == (1, 0, 0, 0)
        and runs == ["running 1 test"]
    )
    return {
        "valid": valid, "summaryCount": len(summary_lines), "testLineCount": len(test_lines),
        "exactTest": tests[0].group(1) if len(tests) == 1 and tests[0] else None,
        "outcome": tests[0].group(2) if len(tests) == 1 and tests[0] else None,
        "summary": summary_lines[0] if len(summary_lines) == 1 else None,
    }


class Capture:
    """A reader owns its pipe; the relay never closes a pending read's handle."""

    def __init__(self, pipe, overflow):
        self.pipe, self.overflow = pipe, overflow
        self.lock, self.done = threading.Lock(), threading.Event()
        self.data, self.total, self.error = bytearray(), 0, None
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self):
        try:
            with self.pipe:
                while block := self.pipe.read(8192):
                    with self.lock:
                        self.total += len(block)
                        self.data.extend(block[:max(0, BYTE_LIMIT - len(self.data))])
                        if self.total > BYTE_LIMIT:
                            self.overflow.set()
        except BaseException as error:
            with self.lock:
                self.error = type(error).__name__
        finally:
            self.done.set()

    def snapshot(self):
        with self.lock:
            return bytes(self.data), {"observedBytes": self.total, "capturedBytes": len(self.data),
                                     "readError": self.error, "eofOrErrorObserved": self.done.is_set()}


def raw_passed(record):
    return (
        record["naturalCompletionObserved"] is True and record["timedOut"] is False
        and record["terminationRequested"] is False and record["outputOverBound"] is False
        and type(record["exitCode"]) is int and record["exitCode"] == 0
        and record["outputSettled"] is True and record["startError"] is None
        and record["libtest"]["valid"] is True
        and all(record[kind]["readError"] is None
                and record[kind]["eofOrErrorObserved"] is True for kind in ("stdout", "stderr"))
    )


def execute(binary, repo, case, directory):
    arguments = [str(binary), case["test"], "--exact", "--nocapture", "--test-threads=1"]
    if case["ignored"]:
        arguments.append("--ignored")
    record = {"name": case["name"], "exactCase": case["test"], "arguments": arguments[1:],
              "explicitIgnoredSelection": case["ignored"], "originalPid": None,
              "naturalCompletionObserved": False, "timedOut": False, "outputOverBound": False,
              "terminationRequested": False, "terminationSettled": None, "exitCode": None,
              "outputSettled": False, "startError": None, "passed": False}
    started = time.monotonic()
    process = None
    streams = {}
    overflow = threading.Event()
    drain_deadline = None
    try:
        process = subprocess.Popen(arguments, cwd=repo, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        record["originalPid"] = process.pid
        for kind, pipe in (("stdout", process.stdout), ("stderr", process.stderr)):
            streams[kind] = Capture(pipe, overflow)
        while True:
            status = process.poll()
            if status is not None:
                record["naturalCompletionObserved"] = True
                record["exitCode"] = status
                break
            if overflow.is_set() or time.monotonic() - started >= CASE_SECONDS:
                record["outputOverBound"] = overflow.is_set()
                record["timedOut"] = time.monotonic() - started >= CASE_SECONDS
                record["terminationRequested"] = True
                drain_deadline = time.monotonic() + RETIRE_SECONDS
                try:
                    process.kill()  # Windows Popen owns the original process handle.
                except OSError as error:
                    record["terminationError"] = {"type": type(error).__name__, "winerror": getattr(error, "winerror", None)}
                try:
                    record["exitCode"] = process.wait(timeout=max(0, drain_deadline - time.monotonic()))
                    record["terminationSettled"] = True
                except subprocess.TimeoutExpired:
                    record["terminationSettled"] = False
                break
            overflow.wait(0.02)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        record["startError"] = {"type": type(error).__name__, "winerror": getattr(error, "winerror", None)}
        if process is not None:
            record["terminationRequested"] = True
            drain_deadline = time.monotonic() + RETIRE_SECONDS
            try:
                process.kill()
                record["exitCode"] = process.wait(timeout=max(0, drain_deadline - time.monotonic()))
                record["terminationSettled"] = True
            except (OSError, subprocess.TimeoutExpired):
                record["terminationSettled"] = False
    if drain_deadline is None:
        drain_deadline = time.monotonic() + RETIRE_SECONDS
    for stream in streams.values():
        stream.done.wait(max(0, drain_deadline - time.monotonic()))
    record["outputSettled"] = len(streams) == 2 and all(stream.done.is_set() for stream in streams.values())
    captured = {}
    for kind in ("stdout", "stderr"):
        raw, state = streams[kind].snapshot() if kind in streams else (b"", {"observedBytes": 0, "capturedBytes": 0, "readError": None, "eofOrErrorObserved": False})
        with (directory / (kind + ".log")).open("xb") as output:
            output.write(raw)
        record[kind] = {**state, "sha256": digest(raw), "path": kind + ".log"}
        captured[kind] = raw
    record["outputOverBound"] = record["outputOverBound"] or overflow.is_set()
    record["elapsedSeconds"] = round(time.monotonic() - started, 6)
    record["libtest"] = parse_stdout(captured["stdout"], case["test"])
    record["rawPassed"] = raw_passed(record)
    # Do not launch another parent while a prior parent or inherited pipe is unknown.
    settled = (record["naturalCompletionObserved"] or record["terminationSettled"] is True) and record["outputSettled"]
    return record, settled, process


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--raw-dir", default="windows-p27-native-raw")
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", args.expected_head), "invalid expected head")
    repo, raw = Path.cwd().resolve(), Path(args.raw_dir).resolve(strict=True)
    output = raw / "helper-stdin-controls"
    output.mkdir(exist_ok=False)
    report = {"schema": 1, "group": "helper-stdin-controls", "sourceHead": args.expected_head,
              "caseCount": 7, "passed": False, "inputsStable": False, "programsStable": False,
              "cases": [], "errors": [], "scope": "Seven exact helper input parent controls; separate from native P27, recovery seven, attributes eight, and real-Agent acceptance."}
    programs, cases, build_before, held = None, None, None, []
    group_deadline = time.monotonic() + GROUP_SECONDS
    try:
        require(os.name == "nt", "actual execution requires Windows")
        cases, report["manifestSha256"] = load_cases(repo / SOURCE_PATTERNS[-1])
        build_before, report["buildInputsSha256"] = read_json(raw / "inputs-before.json")
        check_map(build_before)
        before = source_inputs(repo, args.expected_head)
        write_json(output / "inputs-before.json", before)
        require(before == build_before, "current source inventory or bytes differ from build inputs")
        selection, report["buildSelectionSha256"] = read_json(raw / "build-selection.json", 65536)
        programs = select_programs(repo, selection, args.expected_head)
        report["programs"] = programs
        report["sourceInputCount"] = len(before)
        for index, case in enumerate(cases):
            require(time.monotonic() + CASE_SECONDS + 2 * RETIRE_SECONDS < group_deadline,
                    "group remaining observation budget insufficient")
            require(source_inputs(repo, args.expected_head) == build_before, "source changed before case")
            require(programs_unchanged(programs), "program bytes changed before case")
            directory = output / f"{index + 1:02d}-{case['name']}"
            directory.mkdir()
            result, settled, original = execute(Path(programs["testBinary"]["path"]), repo, case, directory)
            if original is not None:
                held.append(original)
            try:
                result["inputsStable"] = source_inputs(repo, args.expected_head) == build_before
                result["programsStable"] = programs_unchanged(programs)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                result["inputCheckError"] = type(error).__name__
                result["inputsStable"] = result["programsStable"] = False
            result["passed"] = result["rawPassed"] and result["inputsStable"] and result["programsStable"]
            write_json(directory / "result.json", result)
            report["cases"].append({"name": case["name"], "exactCase": case["test"], "state": "passed" if result["passed"] else "failed-or-incomplete", "passed": result["passed"], "result": str(directory.relative_to(output) / "result.json"), "resultSha256": file_hash(directory / "result.json")})
            require(settled, "original process or output remained unsettled; no later parent launched")
            require(result["inputsStable"] and result["programsStable"], "source/program identity changed; no later parent launched")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report["errors"].append({"type": type(error).__name__, "detail": str(error) if isinstance(error, ValueError) else None})
    finally:
        try:
            after = source_inputs(repo, args.expected_head)
            write_json(output / "inputs-after.json", after)
            report["inputsStable"] = build_before is not None and after == build_before
            report["programsStable"] = programs is not None and programs_unchanged(programs)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            report["errors"].append({"phase": "final-identity", "type": type(error).__name__})
        expected = cases or [{"name": f"case-{i + 1}", "test": fqn} for i, (fqn, _) in enumerate(EXPECTED_CASES)]
        for case in expected[len(report["cases"]):]:
            report["cases"].append({"name": case["name"], "exactCase": case["test"], "state": "not-run", "passed": False})
        report["passedCount"] = sum(item["passed"] is True for item in report["cases"])
        report["notRunCount"] = sum(item["state"] == "not-run" for item in report["cases"])
        report["failedOrIncompleteCount"] = 7 - report["passedCount"] - report["notRunCount"]
        report["passed"] = report["passedCount"] == 7 and report["inputsStable"] is True and report["programsStable"] is True and not report["errors"]
        write_json(output / "aggregate.json", report)
    print(json.dumps({"group": report["group"], "passed": report["passed"], "passedCount": report["passedCount"], "failedOrIncompleteCount": report["failedOrIncompleteCount"], "notRunCount": report["notRunCount"]}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
