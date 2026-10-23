"""Bounded, owned Windows Job API observation; not a production acceptance test.

Run once after review: python -B observer.py --output <exclusive-new-directory>
The supervisor owns a separate containment Job. Only the worker's inner Job is
queried. No Agent, project command, user document or process-by-PID cleanup.
"""
import argparse
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ITERATIONS, MEMBERS, PAIR_ROUNDS = 12, 3, 6
SMALL_CAPACITY, FULL_CAPACITY = 1, 256
CREATE_NO_WINDOW, DETACHED_PROCESS = 0x08000000, 0x00000008
MAX_SPAWNS = ITERATIONS * MEMBERS
MAX_TOTAL_CREATED = MAX_SPAWNS + 1  # One original observer plus command fixtures.
MAX_RECORDS, MAX_LOG_BYTES = 512, 512 * 1024
WORK_SECONDS, CLEANUP_SECONDS = 45, 5
PARENT_SECONDS, TOTAL_SECONDS = 55, 60
WAIT_OBJECT_0, WAIT_TIMEOUT, WAIT_FAILED = 0, 258, 0xFFFFFFFF
DWORD, ULONG_PTR, HANDLE = C.c_uint32, C.c_size_t, C.c_void_p


class Startup(C.Structure):
    _fields_ = [("cb", DWORD), ("reserved", C.c_wchar_p),
                ("desktop", C.c_wchar_p), ("title", C.c_wchar_p),
                *[(n, DWORD) for n in ("x", "y", "width", "height", "xc", "yc", "fill", "flags")],
                ("show", C.c_uint16), ("reservedBytes", C.c_uint16),
                ("reservedPointer", C.c_void_p), ("stdin", HANDLE),
                ("stdout", HANDLE), ("stderr", HANDLE)]


class ProcessInfo(C.Structure):
    _fields_ = [("process", HANDLE), ("thread", HANDLE), ("pid", DWORD), ("tid", DWORD)]


class BasicLimits(C.Structure):
    _fields_ = [("processTime", C.c_int64), ("jobTime", C.c_int64),
                ("flags", DWORD), ("minWorkingSet", ULONG_PTR),
                ("maxWorkingSet", ULONG_PTR), ("activeLimit", DWORD),
                ("affinity", ULONG_PTR), ("priority", DWORD), ("scheduling", DWORD)]


class ExtendedLimits(C.Structure):
    _fields_ = [("basic", BasicLimits), ("io", C.c_uint64 * 6),
                ("processMemory", ULONG_PTR), ("jobMemory", ULONG_PTR),
                ("peakProcessMemory", ULONG_PTR), ("peakJobMemory", ULONG_PTR)]


class Accounting(C.Structure):
    _fields_ = [("times", C.c_int64 * 4), ("faults", DWORD),
                ("total", DWORD), ("active", DWORD), ("limitTerminated", DWORD)]


def bounds():
    assert MAX_SPAWNS == 36
    assert MAX_TOTAL_CREATED == 37
    assert WORK_SECONDS + CLEANUP_SECONDS < PARENT_SECONDS
    assert PARENT_SECONDS + CLEANUP_SECONDS == TOTAL_SECONDS == 60
    assert FULL_CAPACITY >= MEMBERS and SMALL_CAPACITY < MEMBERS
    # Two initial queries, two after each resume, and six alternating pairs.
    assert ITERATIONS * (2 + 2 * MEMBERS + 2 * PAIR_ROUNDS) == 240


def classify(ok, assigned, listed, written, capacity, pointer_bytes, ids):
    """Classify raw values, never infer process termination or complete history."""
    values = [ok, assigned, listed, written, capacity, pointer_bytes]
    if any(type(x) is not int for x in values):
        raise ValueError("integer fields required")
    if pointer_bytes not in (4, 8) or not 0 <= capacity <= FULL_CAPACITY:
        raise ValueError("bounded native layout required")
    if not -(2 ** 31) <= ok < 2 ** 31 or any(not 0 <= x <= 0xFFFFFFFF for x in [assigned, listed, written]):
        raise ValueError("native field range")
    if ok == 0:
        return {"classification": "api-error", "boundedReturnedPrefix": None}
    if listed > capacity or written > 8 + capacity * pointer_bytes or 8 + listed * pointer_bytes > written:
        return {"classification": "successful-invalid-layout", "boundedReturnedPrefix": None}
    if len(ids) != listed:
        raise ValueError("exact returned prefix required")
    return {"classification": ("successful-equal-counts-layout" if assigned == listed
                               else "successful-incomplete-counts"), "boundedReturnedPrefix": ids}


class Api:
    def __init__(self):
        if os.name != "nt" or C.sizeof(HANDLE) != 8:
            raise RuntimeError("requires-Windows-64-bit-Python")
        # Fixed-width integers avoid non-Windows ctypes.wintypes ABI assumptions.
        assert C.sizeof(Startup) == 104 and C.sizeof(ProcessInfo) == 24
        assert C.sizeof(BasicLimits) == 64 and C.sizeof(ExtendedLimits) == 144
        assert C.sizeof(Accounting) == 48
        self.k = C.WinDLL("kernel32", use_last_error=True)
        for name, args, result in [
            ("CreateJobObjectW", [C.c_void_p, C.c_wchar_p], HANDLE),
            ("SetInformationJobObject", [HANDLE, C.c_int, C.c_void_p, DWORD], C.c_int),
            ("AssignProcessToJobObject", [HANDLE, HANDLE], C.c_int),
            ("TerminateJobObject", [HANDLE, C.c_uint], C.c_int),
            ("QueryInformationJobObject", [HANDLE, C.c_int, C.c_void_p, DWORD, C.POINTER(DWORD)], C.c_int),
            ("CreateProcessW", [C.c_wchar_p, C.c_wchar_p, C.c_void_p, C.c_void_p,
                                C.c_int, DWORD, C.c_void_p, C.c_wchar_p,
                                C.POINTER(Startup), C.POINTER(ProcessInfo)], C.c_int),
            ("ResumeThread", [HANDLE], DWORD),
            ("TerminateProcess", [HANDLE, C.c_uint], C.c_int),
            ("WaitForSingleObject", [HANDLE, DWORD], DWORD),
            ("GetExitCodeProcess", [HANDLE, C.POINTER(DWORD)], C.c_int),
            ("CloseHandle", [HANDLE], C.c_int),
            ("GetSystemDirectoryW", [C.c_wchar_p, C.c_uint], C.c_uint),
        ]:
            f = getattr(self.k, name); f.argtypes = args; f.restype = result
        buf = C.create_unicode_buffer(32768)
        n = self.k.GetSystemDirectoryW(buf, len(buf))
        if not 0 < n < len(buf):
            raise RuntimeError("system-directory-query")
        self.system = Path(buf.value)

    def job(self):
        h = self.k.CreateJobObjectW(None, None)
        if not h:
            raise RuntimeError("create-private-job")
        limits = ExtendedLimits(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE
        if not self.k.SetInformationJobObject(h, 9, C.byref(limits), C.sizeof(limits)):
            error = C.get_last_error(); self.k.CloseHandle(h)
            raise RuntimeError(f"set-private-job-{error}")
        return h

    def create(self, executable, argv, creation_flags=CREATE_NO_WINDOW):
        if type(creation_flags) is not int or creation_flags not in (CREATE_NO_WINDOW, DETACHED_PROCESS):
            raise ValueError("fixed-creation-mode-required")
        info, start = ProcessInfo(), Startup(); start.cb = C.sizeof(start)
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(executable), *argv]))
        ok = self.k.CreateProcessW(str(executable), command, None, None, False,
                                  0x00000004 | creation_flags, None, str(self.system),
                                  C.byref(start), C.byref(info))  # SUSPENDED | one fixed mode
        error = C.get_last_error() if not ok else None
        if not ok:
            raise RuntimeError(f"create-owned-suspended-{error}")
        info.assigned = False
        return info

    def wait(self, process, milliseconds=0):
        value = int(self.k.WaitForSingleObject(process.process, milliseconds))
        error = C.get_last_error() if value == WAIT_FAILED else None
        code, code_error = None, None
        if value == WAIT_OBJECT_0:
            raw = DWORD()
            if self.k.GetExitCodeProcess(process.process, C.byref(raw)):
                code = raw.value
            else:
                code_error = C.get_last_error()
        return {"pid": int(process.pid), "wait": value, "waitError": error,
                "exitCodeIfSignaled": code, "exitQueryError": code_error}

    def close(self, process):
        thread = int(self.k.CloseHandle(process.thread))
        thread_error = C.get_last_error() if not thread else None
        proc = int(self.k.CloseHandle(process.process))
        proc_error = C.get_last_error() if not proc else None
        return {"threadClose": thread, "threadError": thread_error,
                "processClose": proc, "processError": proc_error}


def write_json(path, value):
    raw = (json.dumps(value, ensure_ascii=True, indent=2) + "\n").encode()
    if len(raw) > 65536:
        raise RuntimeError("summary-size-bound")
    with path.open("xb") as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())


class Journal:
    def __init__(self, path):
        self.file = path.open("xb"); self.count = self.size = 0
        self.hash = hashlib.sha256()

    def add(self, value):
        data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if self.count >= MAX_RECORDS or self.size + len(data) > MAX_LOG_BYTES:
            raise RuntimeError("raw-observation-bound")
        self.file.write(data); self.file.flush()
        self.hash.update(data); self.count += 1; self.size += len(data)

    def close(self):
        self.file.flush(); os.fsync(self.file.fileno()); self.file.close()


def accounting(api, job):
    value, written = Accounting(), DWORD()
    ok = int(api.k.QueryInformationJobObject(job, 1, C.byref(value), C.sizeof(value), C.byref(written)))
    error = C.get_last_error() if not ok else None
    return {"ok": ok, "error": error, "written": written.value,
            "active": value.active if ok else None, "total": value.total if ok else None,
            "limitTerminated": value.limitTerminated if ok else None}


def sample(api, job, originals, capacity, iteration, phase, journal):
    before = [api.wait(p) for p in originals]
    counts_before = accounting(api, job)
    length = 8 + capacity * C.sizeof(ULONG_PTR)
    storage, written = C.create_string_buffer(length), DWORD()
    begin_wall, begin = time.time_ns(), time.monotonic_ns()
    ok = int(api.k.QueryInformationJobObject(job, 3, storage, length, C.byref(written)))
    error = C.get_last_error() if not ok else None  # Before any other native call.
    end, end_wall = time.monotonic_ns(), time.time_ns()
    assigned = DWORD.from_buffer(storage, 0).value
    listed = DWORD.from_buffer(storage, 4).value
    ids = []
    if ok and listed <= capacity and 8 + listed * C.sizeof(ULONG_PTR) <= written.value <= length:
        ids = [ULONG_PTR.from_buffer(storage, 8 + i * C.sizeof(ULONG_PTR)).value for i in range(listed)]
    parsed = classify(ok, assigned, listed, written.value, capacity, C.sizeof(ULONG_PTR), ids)
    after = [api.wait(p) for p in originals]
    counts_after = accounting(api, job)
    row = {"kind": "original-inner-job-list-query", "iteration": iteration, "phase": phase,
           "capacity": capacity, "bufferBytes": length, "queryBeginMonotonicNs": begin,
           "queryEndMonotonicNs": end, "queryBeginWallNs": begin_wall, "queryEndWallNs": end_wall,
           "ok": ok, "nativeError": error, "assigned": assigned, "listed": listed,
           "written": written.value, "fieldsFromSuccessfulCall": ok != 0, **parsed,
           "originalProcessWaitBefore": before, "originalProcessWaitAfter": after,
           "accountingBefore": counts_before, "accountingAfter": counts_after,
           "nonAtomicObservations": True}
    journal.add(row)
    return parsed["classification"]


def cleanup(api, job, originals, journal, iteration):
    """One shared five-second budget, never a fresh five seconds per process."""
    end = time.monotonic() + CLEANUP_SECONDS
    # Give the exact owned objects up to one second of the same budget to exit.
    natural = min(end, time.monotonic() + 1)
    while time.monotonic() < natural and any(api.wait(p)["wait"] != WAIT_OBJECT_0 for p in originals):
        time.sleep(0.001)
    forced = any(api.wait(p)["wait"] != WAIT_OBJECT_0 for p in originals)
    unassigned_termination = {}
    termination = None
    if forced:
        for index, process in enumerate(originals):
            if not process.assigned and api.wait(process)["wait"] != WAIT_OBJECT_0:
                ok = int(api.k.TerminateProcess(process.process, 97))
                error = C.get_last_error() if not ok else None
                unassigned_termination[index] = {"ok": ok, "error": error}
        ok = int(api.k.TerminateJobObject(job, 97)); error = C.get_last_error() if not ok else None
        termination = {"ok": ok, "error": error}
    rows = []
    for index, process in enumerate(originals):
        row = api.wait(process, max(0, int((end - time.monotonic()) * 1000)))
        # Assign failure leaves a suspended process outside the inner Job. Its
        # exact original hProcess, never a PID reopen, remains cleanup authority.
        if index in unassigned_termination:
            row["originalObjectTermination"] = unassigned_termination[index]
        rows.append({"fixtureIndex": index, **row})
    settled = all(r["wait"] == WAIT_OBJECT_0 for r in rows)
    # Close even if the bounded journal refuses a further record. A missing
    # cleanup record makes the experiment incomplete, never a completed sample.
    closes = []
    try:
        for process in originals:
            closes.append(api.close(process))
    finally:
        journal.add({"kind": "original-object-cleanup", "iteration": iteration, "forced": forced,
                     "jobTermination": termination, "objects": rows, "originalHandleCloses": closes})
    return (not forced and settled and all(r["exitCodeIfSignaled"] == 0 for r in rows)
            and all(r["threadClose"] and r["processClose"] for r in closes))


def worker(output, detached=False):
    api = Api(); job = api.job(); journal = Journal(output / "samples.jsonl")
    deadline = time.monotonic() + WORK_SECONDS
    creation_flags = DETACHED_PROCESS if detached else CREATE_NO_WINDOW
    spawned, finished, classifications = 0, 0, {}
    complete, failure = False, None
    try:
        command = api.system / "cmd.exe"
        if not command.is_file() or command.is_symlink():
            raise RuntimeError("exact-system-command-unavailable")
        for iteration in range(ITERATIONS):
            originals = []
            try:
                for index in range(MEMBERS):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("work-budget-exhausted")
                    process = api.create(command, ["/d", "/c", "exit", "0"], creation_flags)
                    originals.append(process); spawned += 1
                    journal.add({"kind": "original-process-created", "iteration": iteration,
                                 "fixtureIndex": index, "pid": int(process.pid), "suspended": True})
                    ok = int(api.k.AssignProcessToJobObject(job, process.process))
                    error = C.get_last_error() if not ok else None
                    process.assigned = ok != 0
                    journal.add({"kind": "original-process-assigned", "iteration": iteration,
                                 "fixtureIndex": index, "ok": ok, "error": error})
                    if not ok:
                        raise RuntimeError("inner-job-assignment-failed")
                pairs = [SMALL_CAPACITY, FULL_CAPACITY]
                if iteration % 2:
                    pairs.reverse()
                def observe(phase):
                    for capacity in pairs:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("work-budget-exhausted")
                        result = sample(api, job, originals, capacity, iteration, phase, journal)
                        classifications[result] = classifications.get(result, 0) + 1
                observe("all-suspended-after-assignment")
                for index, process in enumerate(originals):
                    result = int(api.k.ResumeThread(process.thread))
                    error = C.get_last_error() if result == 0xFFFFFFFF else None
                    journal.add({"kind": "original-thread-resumed", "iteration": iteration,
                                 "fixtureIndex": index, "previousSuspendCount": result, "error": error})
                    if result != 1:
                        raise RuntimeError("original-thread-resume-unconfirmed")
                    observe("after-original-resume-" + str(index))
                for round_index in range(PAIR_ROUNDS):
                    time.sleep(min(0.001 * (2 ** round_index), max(0, deadline - time.monotonic())))
                    observe("concurrent-exit-round-" + str(round_index))
            finally:
                clean = cleanup(api, job, originals, journal, iteration)
            if not clean:
                raise RuntimeError("original-process-cleanup-not-natural-zero")
            finished += 1
        complete = spawned == MAX_SPAWNS and finished == ITERATIONS
    except Exception as e:
        failure = {"type": type(e).__name__, "phase": str(e) if type(e) is RuntimeError else "observer-exception"}
    finally:
        job_close = int(api.k.CloseHandle(job))
        job_close_error = C.get_last_error() if not job_close else None
        journal.close()
    complete = complete and job_close != 0
    write_json(output / "worker-summary.json", {
        "observationCompleted": complete, "spawnCount": spawned, "completedIterations": finished,
        "classificationCounts": classifications, "failure": failure,
        "samplesBytes": journal.size, "samplesRecords": journal.count, "samplesSha256": journal.hash.hexdigest(),
        "originalInnerJobClose": {"ok": job_close, "error": job_close_error},
        "queriedJob": "private-inner-command-only-job; excludes observer and outer containment Job",
        "systemCommand": str(api.system / "cmd.exe"), "fixedArgs": ["/d", "/c", "exit", "0"],
        "pointerBits": C.sizeof(HANDLE) * 8, "nonAtomicObservations": True,
        "detached": detached, "commandCreationFlags": creation_flags | 0x00000004,
        "mismatchRequiredForCompletion": False, "productionAcceptance": False})
    return 0 if complete else 1


def supervisor(output, detached=False):
    start = time.monotonic(); deadline = start + TOTAL_SECONDS
    output = output.absolute()
    if any(p.is_symlink() for p in [output, *output.parents]):
        raise RuntimeError("output-symlink-refused")
    output.mkdir(mode=0o700, exist_ok=False)
    api, control, child = Api(), None, None
    status = {"observationCompleted": False, "productionAcceptance": False,
              "detached": detached, "commandCreationFlags": (DETACHED_PROCESS if detached else CREATE_NO_WINDOW) | 0x00000004,
              "observerCreationFlags": CREATE_NO_WINDOW | 0x00000004,
              "toolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "limits": {"totalObservationAndWaitBudgetSeconds": 60, "parentBeforeCleanupSeconds": 55,
                         "maxCommandSpawns": MAX_SPAWNS, "maxObserverSpawns": 1,
                         "maxTotalCreatedProcesses": MAX_TOTAL_CREATED,
                         "maxRecords": MAX_RECORDS, "maxRawBytes": MAX_LOG_BYTES},
              "scope": "Fixed owned local system-command fixtures only; no Agent/project command/user data. No atomic or exhaustive scheduling claim."}
    try:
        control = api.job()
        worker_args = ["-I", "-S", "-B", str(Path(__file__).absolute()), "--worker", "--output", str(output)]
        if detached:
            worker_args.append("--detached")
        child = api.create(Path(sys.executable).absolute(), worker_args)
        ok = int(api.k.AssignProcessToJobObject(control, child.process)); error = C.get_last_error() if not ok else None
        status["observerAssignment"] = {"ok": ok, "error": error}
        if not ok:
            raise RuntimeError("observer-containment-assignment-failed")
        resumed = int(api.k.ResumeThread(child.thread)); error = C.get_last_error() if resumed == 0xFFFFFFFF else None
        status["observerResume"] = {"previousSuspendCount": resumed, "error": error}
        if resumed != 1:
            raise RuntimeError("observer-resume-unconfirmed")
        wait_ms = max(0, int((start + PARENT_SECONDS - time.monotonic()) * 1000))
        status["observerTerminal"] = api.wait(child, wait_ms)
        status["parentObservationTimedOut"] = status["observerTerminal"]["wait"] == WAIT_TIMEOUT
    except Exception as e:
        status["failure"] = {"type": type(e).__name__, "phase": str(e) if type(e) is RuntimeError else "supervisor-exception"}
    finally:
        if child is not None:
            current = api.wait(child)
            if current["wait"] != WAIT_OBJECT_0:
                # Original hProcess handles a pre-assignment suspended failure;
                # original outer Job covers already-started fixture descendants.
                ok = int(api.k.TerminateProcess(child.process, 98)); error = C.get_last_error() if not ok else None
                status["observerOriginalObjectTermination"] = {"ok": ok, "error": error}
                if control:
                    ok = int(api.k.TerminateJobObject(control, 98)); error = C.get_last_error() if not ok else None
                    status["outerOriginalJobTermination"] = {"ok": ok, "error": error}
                status["observerAfterCleanup"] = api.wait(child, max(0, int((deadline - time.monotonic()) * 1000)))
            else:
                status["observerFinalWait"] = current
            status["observerOriginalHandleCloses"] = api.close(child)
        if control:
            ok = int(api.k.CloseHandle(control)); error = C.get_last_error() if not ok else None
            status["originalOuterJobClose"] = {"ok": ok, "error": error}
    summary = output / "worker-summary.json"
    if summary.is_file() and summary.stat().st_size <= 65536:
        raw = summary.read_bytes(); result = json.loads(raw)
        status["workerSummarySha256"] = hashlib.sha256(raw).hexdigest()
        status["workerSummary"] = result
        terminal = status.get("observerTerminal", {})
        samples = output / "samples.jsonl"
        status["observationCompleted"] = (
            "failure" not in status and "observerOriginalObjectTermination" not in status
            and status.get("parentObservationTimedOut") is False
            and all(status["observerOriginalHandleCloses"][x] for x in ["threadClose", "processClose"])
            and type(status.get("originalOuterJobClose", {}).get("ok")) is int
            and status["originalOuterJobClose"]["ok"] != 0
            and terminal.get("wait") == WAIT_OBJECT_0 and type(terminal.get("exitCodeIfSignaled")) is int
            and terminal["exitCodeIfSignaled"] == 0 and result.get("observationCompleted") is True
            and type(result.get("spawnCount")) is int and result["spawnCount"] == MAX_SPAWNS
            and result.get("completedIterations") == ITERATIONS
            and samples.is_file() and samples.stat().st_size <= MAX_LOG_BYTES
            and hashlib.sha256(samples.read_bytes()).hexdigest() == result.get("samplesSha256"))
    status["elapsedSeconds"] = time.monotonic() - start
    status["nativeCallBoundary"] = "Wait/loop budgets are finite. Windows native calls themselves have no universal return-time promise; external workflow timeout must preserve incomplete evidence, never convert it to completed."
    write_json(output / "summary.json", status)
    print(json.dumps({"observationCompleted": status["observationCompleted"], "summary": str(output / "summary.json")}))
    return 0 if status["observationCompleted"] else 1


def main():
    bounds()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--detached", action="store_true", help="Use DETACHED_PROCESS for fixed command fixtures only")
    args = parser.parse_args()
    return worker(args.output, args.detached) if args.worker else supervisor(args.output, args.detached)


if __name__ == "__main__":
    raise SystemExit(main())
