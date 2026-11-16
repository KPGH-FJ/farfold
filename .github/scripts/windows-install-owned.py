"""Bounded installer-only ownership; never a Farfold/App launch interface."""

import argparse
import ctypes as C
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import sys
import time

LIMIT = 32
WAIT_OBJECT_0 = 0
WAIT_FAILED = 0xFFFFFFFF
QUERY_LIMITED = 0x1000
SYNCHRONIZE = 0x00100000


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def absolute_local(value):
    if not isinstance(value, str) or any(c in value for c in '\"\r\n\0/'):
        raise ValueError("invalid-local-path")
    path = PureWindowsPath(value)
    if not re.match(r"^[A-Za-z]:\\", value) or not path.is_absolute():
        raise ValueError("local-absolute-drive-path-required")
    if ".." in path.parts or value.endswith((" ", ".", "\\")):
        raise ValueError("noncanonical-local-path")
    return str(path)


def command_line(executable, phase, install_dir):
    executable, install_dir = absolute_local(executable), absolute_local(install_dir)
    if phase == "fixture":
        root = PureWindowsPath(install_dir).parent / "fixture"
        if executable.casefold() != str(root / "farfold.exe").casefold():
            raise ValueError("owned-console-fixture-location-required")
        return f'"{executable}" "{root / "ready.json"}" "{root / "stop.signal"}"'
    if PureWindowsPath(executable).name.casefold() == "farfold.exe":
        raise ValueError("app-launch-forbidden")
    if phase == "install":
        if not PureWindowsPath(executable).name.casefold().endswith("-setup.exe"):
            raise ValueError("nsis-setup-image-required")
        return f'"{executable}" /S /D={install_dir}'
    if phase == "uninstall":
        expected = str(PureWindowsPath(install_dir) / "uninstall.exe")
        if executable.casefold() != expected.casefold():
            raise ValueError("owned-uninstaller-image-required")
        # NSIS requires _?= last and unquoted; no temporary self-copy child.
        return f'"{executable}" /S _?={install_dir}'
    raise ValueError("installer-phase-required")


def managed_fixture(data):
    """Distinguish the compiled, source-owned console fixture from the Rust App."""
    if len(data) < 512 or data[:2] != b"MZ":
        return False
    offset = int.from_bytes(data[60:64], "little")
    if offset + 256 > len(data) or data[offset:offset + 4] != b"PE\0\0":
        return False
    optional = offset + 24
    magic = int.from_bytes(data[optional:optional + 2], "little")
    directory = optional + (112 if magic == 0x20B else 96 if magic == 0x10B else 0)
    if directory == optional or directory + 120 > len(data):
        return False
    clr = int.from_bytes(data[directory + 112:directory + 116], "little")
    return (clr != 0 and b"FarfoldInstallerOwnedFixture" in data
            and "FARFOLD_OWNED_INSTALL_FIXTURE_V1".encode("utf-16-le") in data)


def terminal_proof(accounting, member_waits, expected_members):
    return (
        accounting.get("ok") == 1
        and accounting.get("written", 0) >= 48
        and accounting.get("active") == 0
        and accounting.get("total") == expected_members
        and len(member_waits) == expected_members
        and all(x.get("wait") == WAIT_OBJECT_0 and x.get("exitQueryError") is None
                for x in member_waits)
    )


def ordinary_file(path):
    path = Path(path)
    for part in [path, *path.parents]:
        value = part.lstat()
        if value.st_file_attributes & 0x400:
            raise RuntimeError("reparse-path-forbidden")
    if not stat.S_ISREG(path.stat().st_mode):
        raise RuntimeError("ordinary-image-required")


def load_base(expected):
    path = Path(__file__).with_name("windows-job-query-observer.py")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected) or digest(path) != expected.lower():
        raise RuntimeError("shared-api-source-binding-changed")
    spec = importlib.util.spec_from_file_location("owned_install_job_api", path)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    return base


def run(args):
    if os.name != "nt" or C.sizeof(C.c_void_p) != 8:
        raise RuntimeError("requires-Windows-x64-Python")
    line = command_line(args.executable, args.phase, args.install_dir)
    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.exe_sha256):
        raise ValueError("image-sha256-required")
    ordinary_file(args.executable)
    if digest(args.executable) != args.exe_sha256.lower():
        raise RuntimeError("selected-image-bytes-changed")
    if args.phase == "fixture" and not managed_fixture(Path(args.executable).read_bytes()):
        raise RuntimeError("source-owned-managed-fixture-required")
    if args.phase == "fixture" and args.expected_exit != 0:
        raise ValueError("fixture-must-exit-naturally-zero")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    base = load_base(args.shared_sha256)
    api = base.Api()
    if C.sizeof(base.Accounting) != 48 or C.sizeof(base.Startup) != 104:
        raise RuntimeError("native-layout-mismatch")
    k = api.k
    for name, types, result in [
        ("OpenProcess", [base.DWORD, C.c_int, base.DWORD], base.HANDLE),
        ("IsProcessInJob", [base.HANDLE, base.HANDLE, C.POINTER(C.c_int)], C.c_int),
        ("QueryFullProcessImageNameW", [base.HANDLE, base.DWORD, C.c_wchar_p,
                                       C.POINTER(base.DWORD)], C.c_int),
        ("GetProcessTimes", [base.HANDLE, C.c_void_p, C.c_void_p, C.c_void_p,
                             C.c_void_p], C.c_int),
    ]:
        function = getattr(k, name)
        function.argtypes, function.restype = types, result
    job, leader, assigned, resumed = None, None, False, False
    members, events, failure = {}, [], None
    natural, cleanup_proven, last_accounting, last_waits = False, False, {}, []
    leader_exit, forced = None, False
    started = time.time()

    def record(kind, **data):
        if len(events) >= 256:
            raise RuntimeError("bounded-event-record-limit")
        events.append({"at": time.time(), "kind": kind, **data})

    def identity(handle, pid):
        inside = C.c_int()
        ok = int(k.IsProcessInJob(handle, job, C.byref(inside)))
        if ok != 1 or not inside.value:
            raise RuntimeError("original-handle-not-in-private-job")
        image, count = C.create_unicode_buffer(32768), base.DWORD(32768)
        if not k.QueryFullProcessImageNameW(handle, 0, image, C.byref(count)):
            raise RuntimeError(f"original-image-query-{C.get_last_error()}")
        if not 0 < count.value < len(image) or count.value != len(image.value):
            raise RuntimeError("original-image-query-layout")
        path = absolute_local(image.value)
        if args.phase != "fixture" and PureWindowsPath(path).name.casefold() == "farfold.exe":
            raise RuntimeError("forbidden-App-image-observed")
        # Only this NSIS image (or its identical helper) may execute in the Job.
        ordinary_file(path)
        if digest(path) != args.exe_sha256.lower():
            raise RuntimeError("unexpected-installer-descendant-image")
        times = [C.c_uint64() for _ in range(4)]
        if not k.GetProcessTimes(handle, *(C.byref(v) for v in times)):
            raise RuntimeError("original-creation-time-query")
        return {"pid": int(pid), "image": path, "creationTime": times[0].value,
                "inPrivateJob": True}

    def observe():
        nonlocal last_accounting, last_waits
        accounting = base.accounting(api, job)
        if accounting["ok"] != 1 or accounting["written"] < 48:
            raise RuntimeError("job-accounting-query-unknown")
        if accounting["total"] > LIMIT:
            raise RuntimeError("private-job-member-limit")
        # Exact raw layout: DWORD assigned, DWORD listed, ULONG_PTR ids[LIMIT].
        buffer = C.create_string_buffer(8 + LIMIT * C.sizeof(base.ULONG_PTR))
        written = base.DWORD()
        ok = int(k.QueryInformationJobObject(job, 3, buffer, len(buffer), C.byref(written)))
        error = C.get_last_error() if not ok else None
        assigned_count = C.c_uint32.from_buffer(buffer, 0).value
        listed = C.c_uint32.from_buffer(buffer, 4).value
        ids = list((base.ULONG_PTR * LIMIT).from_buffer(buffer, 8))[:min(listed, LIMIT)]
        layout = base.classify(ok, assigned_count, listed, written.value,
                               LIMIT, C.sizeof(base.ULONG_PTR), ids)
        if (not ok or layout["classification"] != "successful-equal-counts-layout"
                or len(set(ids)) != len(ids)):
            raise RuntimeError(f"job-member-list-unknown-{error}")
        for pid in ids:
            if pid in members:
                continue
            handle = k.OpenProcess(QUERY_LIMITED | SYNCHRONIZE, False, pid)
            if not handle:
                raise RuntimeError("unretained-original-job-member")
            try:
                member = identity(handle, pid)
            except Exception:
                k.CloseHandle(handle)
                raise
            member["handle"] = handle
            members[pid] = member
            record("original-member-retained", **{k: v for k, v in member.items() if k != "handle"})
        waits = []
        for member in members.values():
            info = base.ProcessInfo()
            info.process, info.pid = member["handle"], member["pid"]
            waits.append(api.wait(info))
        state = {"accounting": accounting, "memberList": {"ok": ok, "error": error,
                 "assigned": assigned_count, "listed": listed, "written": written.value,
                 "ids": ids}, "waits": waits}
        if not events or state != events[-1].get("state"):
            record("owned-state", state=state)
        last_accounting, last_waits = accounting, waits
        return terminal_proof(accounting, waits, len(members))

    try:
        job = api.job()
        leader, startup = base.ProcessInfo(), base.Startup()
        startup.cb = C.sizeof(startup)
        mutable = C.create_unicode_buffer(line)
        if not k.CreateProcessW(args.executable, mutable, None, None, False,
                                0x00000004 | base.CREATE_NO_WINDOW, None,
                                str(Path(args.executable).parent),
                                C.byref(startup), C.byref(leader)):
            leader = None
            raise RuntimeError(f"create-suspended-{C.get_last_error()}")
        assigned = bool(k.AssignProcessToJobObject(job, leader.process))
        record("suspended-original-created", pid=int(leader.pid), assigned=assigned,
               commandLine=line, image=args.executable)
        if not assigned:
            raise RuntimeError(f"private-job-assignment-{C.get_last_error()}")
        member = identity(leader.process, leader.pid)
        if member["image"].casefold() != absolute_local(args.executable).casefold():
            raise RuntimeError("suspended-original-image-mismatch")
        member["handle"] = leader.process
        members[int(leader.pid)] = member
        previous = int(k.ResumeThread(leader.thread))
        resumed = previous == 1
        record("original-resume", previousSuspendCount=previous)
        if not resumed:
            raise RuntimeError("original-resume-unknown")
        deadline = time.monotonic() + args.timeout
        stop_deadline = None
        while time.monotonic() < deadline:
            if observe():
                leader_exit = api.wait(leader)["exitCodeIfSignaled"]
                natural = True
                break
            # All active work ended but a transient member was never retained.
            if last_accounting.get("active") == 0 and last_accounting.get("total") != len(members):
                raise RuntimeError("unobserved-transient-member-unknown")
            if args.phase == "fixture" and (Path(args.executable).parent / "stop.signal").exists():
                stop_deadline = stop_deadline or time.monotonic() + 5
                if time.monotonic() >= stop_deadline:
                    raise RuntimeError("owned-fixture-stop-not-acknowledged")
            time.sleep(0.025)
        if not natural:
            raise RuntimeError("bounded-installer-timeout")
        if leader_exit != args.expected_exit:
            raise RuntimeError(f"installer-natural-exit-{leader_exit}")
        cleanup_proven = True
    except Exception as error:
        failure = str(error)
        if leader is not None:
            forced = True
            # Before assignment only the exact original suspended process exists.
            if not assigned:
                k.TerminateProcess(leader.process, 97)
            if job:
                k.TerminateJobObject(job, 97)
            end = time.monotonic() + 30
            while time.monotonic() < end:
                try:
                    cleanup_proven = (observe() if assigned else
                                      api.wait(leader)["wait"] == WAIT_OBJECT_0
                                      and terminal_proof(base.accounting(api, job), [], 0))
                    if cleanup_proven:
                        break
                except Exception:
                    cleanup_proven = False
                time.sleep(0.025)
    finally:
        close_results = []
        if leader is not None:
            close_results.append(int(k.CloseHandle(leader.thread)))
        for member in members.values():
            close_results.append(int(k.CloseHandle(member["handle"])))
        if leader is not None and int(leader.pid) not in members:
            close_results.append(int(k.CloseHandle(leader.process)))
        if job:
            close_results.append(int(k.CloseHandle(job)))
    handles_closed = bool(close_results) and all(x == 1 for x in close_results)
    if not handles_closed and failure is None:
        failure = "original-handle-close-not-confirmed"
    result = {
        "phase": args.phase, "commandLine": line, "executable": args.executable,
        "selectedImageSha256": args.exe_sha256.lower(), "sharedApiSha256": args.shared_sha256.lower(),
        "startedAtEpoch": started, "finishedAtEpoch": time.time(),
        "assignedBeforeResume": assigned and resumed, "naturalReturned": natural,
        "naturalExitCode": leader_exit, "expectedNaturalExitCode": args.expected_exit,
        "forced": forced, "terminalProof": cleanup_proven,
        "finalAccounting": last_accounting, "finalOriginalWaits": last_waits,
        "originalMembers": [{k: v for k, v in m.items() if k != "handle"}
                            for m in members.values()],
        "handlesClosed": handles_closed, "closeHandleReturns": close_results,
        "failure": failure, "events": events,
        "passed": (natural and leader_exit == args.expected_exit and cleanup_proven
                   and handles_closed and not forced and failure is None),
        "controlledConsoleFixture": args.phase == "fixture",
        "AppLaunchAllowed": False,
    }
    (output / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in ["phase", "passed", "naturalExitCode", "failure"]}))
    return 0 if result["passed"] else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["install", "uninstall", "fixture"], required=True)
    parser.add_argument("--executable", required=True)
    parser.add_argument("--install-dir", required=True)
    parser.add_argument("--exe-sha256", required=True)
    parser.add_argument("--shared-sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=int, choices=[30, 180], default=180)
    parser.add_argument("--expected-exit", type=int, choices=[0, 2], default=0)
    args = parser.parse_args()
    try:
        return run(args)
    except Exception as error:
        print(json.dumps({"passed": False, "failure": str(error),
                          "executionState": "not-confirmed"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
