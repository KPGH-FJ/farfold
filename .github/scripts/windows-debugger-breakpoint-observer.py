"""Observe fixed Windows loader breakpoints; diagnostic only, never acceptance.

The launching thread alone owns WaitForDebugEvent/ContinueDebugEvent. An outer
supervisor Job bounds a worker; the worker owns each command's original Job and
retains every CREATE_PROCESS exact object through EXIT continuation and signal.
No process memory/context reads or writes, attach-by-PID, user commands or Agents.
"""
import argparse
import ctypes as C
import hashlib
import importlib.util
import json
from pathlib import Path, PureWindowsPath
import subprocess
import sys
import tempfile
import time


SHARED_API_SHA256 = "93777c5d669317331b6ea221f4964fa042973644dd0cb50394bd0d3662c30f19"
SHARED_PATH = Path(__file__).with_name("windows-job-query-observer.py")
if hashlib.sha256(SHARED_PATH.read_bytes()).hexdigest() != SHARED_API_SHA256:
    raise RuntimeError("reviewed-shared-api-sha256-mismatch")
SPEC = importlib.util.spec_from_file_location("owned_job_observer", SHARED_PATH)
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
DWORD, HANDLE, ULONG_PTR = BASE.DWORD, BASE.HANDLE, BASE.ULONG_PTR

DEBUG_PROCESS, CREATE_SUSPENDED, DETACHED_PROCESS = 1, 4, 8
DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED = 0x00010002, 0x80010001
# Microsoft SDK ntstatus.h gives WX86_BREAKPOINT its separate status 0x4000001F.
# This probe observes, rather than assumes, the loader's actual event sequence.
EXCEPTION_BREAKPOINT, STATUS_WX86_BREAKPOINT = 0x80000003, 0x4000001F
WAIT_OBJECT_0, WAIT_TIMEOUT, WAIT_FAILED = 0, 258, 0xFFFFFFFF
ERROR_SEM_TIMEOUT = 121
MACHINE_I386, MACHINE_AMD64 = 0x014C, 0x8664
MAX_MEMBERS, MAX_EVENTS_PER_CASE = 16, 512
MAX_CASES, MAX_RECORDS, MAX_RAW_BYTES = 4, 4096, 2 * 1024 * 1024
CASE_SECONDS, CLEANUP_SECONDS = 8, 5
WORK_SECONDS, WORKER_SECONDS, PARENT_SECONDS, TOTAL_SECONDS = 40, 50, 55, 60
POLICIES = ("candidate-native-only", "known-loader-classes-once")


class ExceptionRecord(C.Structure):
    _fields_ = [("code", DWORD), ("flags", DWORD), ("record", C.c_void_p),
                ("address", C.c_void_p), ("parameterCount", DWORD),
                ("parameters", ULONG_PTR * 15)]


class ExceptionInfo(C.Structure):
    _fields_ = [("record", ExceptionRecord), ("firstChance", DWORD)]


class CreateInfo(C.Structure):
    _fields_ = [("file", HANDLE), ("process", HANDLE), ("thread", HANDLE),
                ("imageBase", C.c_void_p), ("debugOffset", DWORD), ("debugSize", DWORD),
                ("threadLocalBase", C.c_void_p), ("startAddress", C.c_void_p),
                ("imageName", C.c_void_p), ("unicode", C.c_uint16)]


class LoadInfo(C.Structure):
    _fields_ = [("file", HANDLE), ("imageBase", C.c_void_p),
                ("debugOffset", DWORD), ("debugSize", DWORD),
                ("imageName", C.c_void_p), ("unicode", C.c_uint16)]


class DebugUnion(C.Union):
    _fields_ = [("exception", ExceptionInfo), ("create", CreateInfo),
                ("load", LoadInfo), ("exitCode", DWORD), ("raw", C.c_byte * 160)]


class DebugEvent(C.Structure):
    _fields_ = [("kind", DWORD), ("pid", DWORD), ("tid", DWORD), ("data", DebugUnion)]


class Api(BASE.Api):
    def __init__(self):
        super().__init__()
        assert C.sizeof(ExceptionRecord) == 152 and C.sizeof(ExceptionInfo) == 160
        assert C.sizeof(CreateInfo) == 72 and C.sizeof(LoadInfo) == 40
        assert DebugEvent.data.offset == 16 and C.sizeof(DebugEvent) == 176
        for name, args, result in [
            ("WaitForDebugEvent", [C.POINTER(DebugEvent), DWORD], C.c_int),
            ("ContinueDebugEvent", [DWORD, DWORD, DWORD], C.c_int),
            ("DebugSetProcessKillOnExit", [C.c_int], C.c_int),
            ("GetCurrentProcess", [], HANDLE),
            ("GetCurrentThreadId", [], DWORD),
            ("DuplicateHandle", [HANDLE, HANDLE, HANDLE, C.POINTER(HANDLE), DWORD, C.c_int, DWORD], C.c_int),
            ("GetProcessId", [HANDLE], DWORD),
            ("IsProcessInJob", [HANDLE, HANDLE, C.POINTER(C.c_int)], C.c_int),
            ("IsWow64Process2", [HANDLE, C.POINTER(C.c_uint16), C.POINTER(C.c_uint16)], C.c_int),
            ("GetSystemDirectoryW", [C.POINTER(C.c_wchar), C.c_uint], C.c_uint),
            ("GetSystemWow64DirectoryW", [C.POINTER(C.c_wchar), C.c_uint], C.c_uint),
            ("QueryFullProcessImageNameW", [HANDLE, DWORD, C.POINTER(C.c_wchar), C.POINTER(DWORD)], C.c_int),
        ]:
            function = getattr(self.k, name)
            function.argtypes, function.restype = args, result
        try:
            self.wow64_directory2 = self.k.GetSystemWow64Directory2W
        except AttributeError:
            self.wow64_directory2 = None
        if self.wow64_directory2 is not None:
            self.wow64_directory2.argtypes = [C.POINTER(C.c_wchar), C.c_uint, C.c_uint16]
            self.wow64_directory2.restype = C.c_uint
        # The shared API's legacy 32768-WCHAR directory result is not authority
        # for this mode. Validate a bounded fresh reply before loading any DLL
        # by path or selecting a process cwd/executable.
        self.initial_system_reply = directory_reply(self.k.GetSystemDirectoryW, "GetSystemDirectoryW")
        if not self.initial_system_reply["nonemptyAbsoluteCountMatched"]:
            raise DirectoryReplyError(self.initial_system_reply)
        self.system = Path(self.initial_system_reply["bufferValue"])
        # CompareObjectHandles is documented in KernelBase.dll, unlike the
        # Kernel32 exports above. Bind its exact system DLL rather than assume a
        # noncontractual Kernel32 forwarder exists on this Windows image.
        self.handle_api = C.WinDLL(str(self.system / "KernelBase.dll"), use_last_error=True)
        self.same_object = self.handle_api.CompareObjectHandles
        self.same_object.argtypes, self.same_object.restype = [HANDLE, HANDLE], C.c_int

    def create_debug(self, command, cwd):
        if not command.is_absolute() or command.name.casefold() != "cmd.exe":
            raise RuntimeError("fixed-debug-command-not-absolute")
        info, start = BASE.ProcessInfo(), BASE.Startup()
        start.cb = C.sizeof(start)
        argv = C.create_unicode_buffer(subprocess.list2cmdline([str(command), "/d", "/c", "exit", "0"]))
        ok = self.k.CreateProcessW(str(command), argv, None, None, False,
                                  DEBUG_PROCESS | CREATE_SUSPENDED | DETACHED_PROCESS,
                                  None, str(cwd), C.byref(start), C.byref(info))
        error = C.get_last_error() if not ok else None
        if not ok:
            raise RuntimeError(f"create-fixed-debug-command-{error}")
        info.assigned = False
        return info

    def duplicate(self, original):
        duplicate = HANDLE()
        current = self.k.GetCurrentProcess()
        ok = self.k.DuplicateHandle(current, original, current, C.byref(duplicate),
                                    0x00100000 | 0x00001000, False, 0)
        error = C.get_last_error() if not ok else None
        if not ok:
            raise RuntimeError(f"duplicate-create-process-object-{error}")
        return duplicate.value

    def object_wait(self, handle):
        result = int(self.k.WaitForSingleObject(handle, 0))
        error = C.get_last_error() if result == WAIT_FAILED else None
        code, code_error = DWORD(), None
        if result == WAIT_OBJECT_0 and not self.k.GetExitCodeProcess(handle, C.byref(code)):
            code_error = C.get_last_error()
        return {"wait": result, "waitError": error,
                "exitCodeIfSignaled": code.value if result == WAIT_OBJECT_0 and code_error is None else None,
                "exitQueryError": code_error}


def path_reply(count, value, capacity):
    """A positive API count alone never authorizes a relative executable path."""
    units = len(value.encode("utf-16-le", errors="surrogatepass")) // 2
    valid = bool(0 < count < capacity and units == count and value
                 and PureWindowsPath(value).is_absolute())
    return {"returnedCount": count, "capacityWchars": capacity,
            "bufferUtf16Units": units, "bufferValue": value[:1024],
            "bufferValueTruncated": len(value) > 1024,
            "nonemptyAbsoluteCountMatched": valid}


class DirectoryReplyError(RuntimeError):
    def __init__(self, reply):
        super().__init__("fixed-system32-directory-reply-invalid")
        self.reply = reply


def directory_reply(function, name, capacity=1024, machine=None):
    buffer = C.create_unicode_buffer(capacity)
    args = (buffer, capacity) if machine is None else (buffer, capacity, machine)
    count = int(function(*args))
    error = C.get_last_error() if not count else None
    return {"api": name, "requestedMachine": machine, "nativeError": error,
            **path_reply(count, buffer.value, capacity)}


def process_image_reply(api, handle):
    buffer, count = C.create_unicode_buffer(1024), DWORD(1024)
    ok = int(api.k.QueryFullProcessImageNameW(handle, 0, buffer, C.byref(count)))
    error = C.get_last_error() if not ok else None
    return {"ok": ok, "nativeError": error, **path_reply(int(count.value), buffer.value, len(buffer))}


class Journal(BASE.Journal):
    def add(self, value):
        data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if self.count >= MAX_RECORDS or self.size + len(data) > MAX_RAW_BYTES:
            raise RuntimeError("debug-observation-bound")
        self.file.write(data)
        self.file.flush()
        self.hash.update(data)
        self.count += 1
        self.size += len(data)


def decision(policy, code, first_chance, process_machine, seen):
    """Match the current candidate or exactly one first-chance trap per class.

    WX86 is admitted only for a proven x86 process; second-chance traps and every
    repeated or other exception remain NOT_HANDLED. No exception addresses read.
    """
    recognized = code == EXCEPTION_BREAKPOINT or (
        policy == "known-loader-classes-once" and code == STATUS_WX86_BREAKPOINT
        and process_machine == MACHINE_I386)
    if first_chance and recognized and code not in seen:
        seen.add(code)
        return DBG_CONTINUE
    return DBG_EXCEPTION_NOT_HANDLED


def list_snapshot(api, job):
    capacity = MAX_MEMBERS
    length = 8 + capacity * C.sizeof(ULONG_PTR)
    buffer, written = C.create_string_buffer(length), DWORD()
    ok = int(api.k.QueryInformationJobObject(job, 3, buffer, length, C.byref(written)))
    error = C.get_last_error() if not ok else None
    assigned = DWORD.from_buffer(buffer, 0).value
    listed = DWORD.from_buffer(buffer, 4).value
    valid = bool(ok and listed <= capacity and 8 + listed * C.sizeof(ULONG_PTR) <= written.value <= length)
    ids = ([ULONG_PTR.from_buffer(buffer, 8 + i * C.sizeof(ULONG_PTR)).value
            for i in range(listed)] if valid else None)
    return {"ok": ok, "error": error, "assigned": assigned, "listed": listed,
            "written": written.value, "validLayout": valid, "ids": ids}


def completion(api, job, original, members):
    before = BASE.accounting(api, job)
    listing = list_snapshot(api, job)
    objects = []
    for pid, item in members.items():
        wait = api.object_wait(item["handle"])
        membership = None
        if wait["wait"] == WAIT_OBJECT_0:
            belongs = C.c_int()
            ok = int(api.k.IsProcessInJob(item["handle"], job, C.byref(belongs)))
            error = C.get_last_error() if not ok else None
            membership = {"ok": ok, "nativeError": error, "belongsToOriginalJob": bool(belongs.value),
                          "queriedAfterThisExactObjectSignaled": True}
        objects.append({"pid": pid, "exitContinued": item["exitContinued"], **wait,
                        "originalJobMembershipAfterSignal": membership})
    leader = api.wait(original)
    after = BASE.accounting(api, job)
    complete = bool(members and int(original.pid) in members
                    and all(row["exitContinued"] and row["wait"] == WAIT_OBJECT_0
                            and row["exitQueryError"] is None for row in objects)
                    and leader["wait"] == WAIT_OBJECT_0 and leader["exitQueryError"] is None
                    and all(row["ok"] and row["written"] == C.sizeof(BASE.Accounting)
                            and row["active"] == 0 and row["total"] == len(members)
                            for row in (before, after))
                    and listing["validLayout"] and listing["assigned"] == 0 and listing["listed"] == 0)
    return {"completeOriginalObjects": complete, "objects": objects, "originalLeader": leader,
            "accountingBefore": before, "list": listing, "accountingAfter": after,
            "nonAtomicObservations": True}


def run_case(api, job, command, architecture, policy, cwd, journal, work_end, worker_end):
    start = time.monotonic()
    original, pending = None, None
    members, exceptions, errors = {}, [], []
    forced, events, final = False, 0, None
    kill_requested, continuation_failures = False, 0
    case_end = min(work_end, start + CASE_SECONDS)
    cleanup_end = min(worker_end, case_end + CLEANUP_SECONDS)
    prefix = {"architecture": architecture, "policy": policy,
              "debuggerOwnerThreadId": int(api.k.GetCurrentThreadId())}

    def record(kind, **fields):
        journal.add({"kind": kind, **prefix, "elapsedMs": round((time.monotonic() - start) * 1000, 3), **fields})

    def terminate(reason):
        nonlocal forced, kill_requested
        if kill_requested:
            return
        forced, kill_requested = True, True
        if original is not None and not original.assigned:
            ok = int(api.k.TerminateProcess(original.process, 97))
            error = C.get_last_error() if not ok else None
            record("unassigned-original-object-termination", ok=ok, error=error)
        ok = int(api.k.TerminateJobObject(job, 97))
        error = C.get_last_error() if not ok else None
        record("original-job-termination", reason=reason, ok=ok, error=error)

    try:
        original = api.create_debug(command, cwd)
        # Microsoft requires an established debugging connection before this
        # call. TRUE is also the default; never detach on debugger exit.
        ok = int(api.k.DebugSetProcessKillOnExit(True))
        error = C.get_last_error() if not ok else None
        record("debugger-kill-on-exit", enabled=True, ok=ok, error=error)
        if not ok:
            errors.append("debugger-kill-on-exit-not-confirmed")
            terminate("debugger-kill-on-exit-failure")
        record("original-suspended-command", pid=int(original.pid), creationFlags=13,
               command=str(command), fixedArgs=["/d", "/c", "exit", "0"])
        ok = int(api.k.AssignProcessToJobObject(job, original.process))
        error = C.get_last_error() if not ok else None
        original.assigned = bool(ok)
        record("original-job-assignment", ok=ok, error=error)
        if not ok:
            errors.append("original-job-assignment-failed")
            terminate("assignment-failure")
        image = process_image_reply(api, original.process)
        image_matches = bool(image["ok"] and image["nonemptyAbsoluteCountMatched"]
                             and PureWindowsPath(image["bufferValue"]) == PureWindowsPath(str(command)))
        record("original-process-image-before-resume", pid=int(original.pid),
               expectedCommand=str(command), matchesExpectedAbsoluteCommand=image_matches, **image)
        if not image_matches:
            errors.append("original-process-image-does-not-match-fixed-absolute-command")
            terminate("original-image-identity-failure")
        if original.assigned and image_matches and not kill_requested:
            resumed = int(api.k.ResumeThread(original.thread))
            error = C.get_last_error() if resumed == 0xFFFFFFFF else None
            record("original-thread-resumed", previousSuspendCount=resumed, error=error)
            if resumed != 1:
                errors.append("original-thread-resume-unconfirmed")
                terminate("resume-failure")
        else:
            record("original-thread-resume-skipped", assignedToOriginalJob=original.assigned,
                   imageMatched=image_matches, terminationAlreadyRequested=kill_requested)
        while time.monotonic() < cleanup_end:
            if not kill_requested and time.monotonic() >= case_end:
                errors.append("case-observation-deadline")
                terminate("case-deadline")
            if pending is None:
                if events >= MAX_EVENTS_PER_CASE:
                    errors.append("debug-event-count-bound")
                    terminate("debug-event-bound")
                    break
                raw = DebugEvent()
                ok = int(api.k.WaitForDebugEvent(C.byref(raw), 25))
                error = C.get_last_error() if not ok else None
                if not ok:
                    if error == ERROR_SEM_TIMEOUT:
                        if members and all(item["exitContinued"] for item in members.values()):
                            final = completion(api, job, original, members)
                            if final["completeOriginalObjects"]:
                                break
                        continue
                    # Some Windows versions report no debuggee after the final
                    # EXIT. Accept only the complete exact-object certificate.
                    final = completion(api, job, original, members)
                    record("debug-wait-error", error=error, completeOriginalObjects=final["completeOriginalObjects"])
                    if final["completeOriginalObjects"]:
                        break
                    errors.append(f"debug-wait-{error}")
                    terminate("debug-wait-error")
                    time.sleep(0.001)
                    continue
                pending = {"raw": raw, "handled": False, "status": DBG_CONTINUE, "closedImage": False}
                events += 1
            raw = pending["raw"]
            pid, tid, kind = int(raw.pid), int(raw.tid), int(raw.kind)
            if not pending["handled"]:
                # Set before handler work: if any observation raises, the same
                # event stays pending and is continued during bounded cleanup.
                pending["handled"] = True
                record("debug-event", event=kind, pid=pid, tid=tid, beforeContinue=True)
                if kind in (3, 6):  # CREATE_PROCESS / LOAD_DLL image file only.
                    image = raw.data.create.file if kind == 3 else raw.data.load.file
                    if image:
                        closed = int(api.k.CloseHandle(image))
                        error = C.get_last_error() if not closed else None
                        pending["closedImage"] = True
                        record("debug-image-handle-close", event=kind, ok=closed, error=error)
                        if not closed:
                            errors.append("debug-image-close-failed")
                if kind == 3:
                    handle = api.duplicate(raw.data.create.process)
                    if len(members) >= MAX_MEMBERS or pid in members:
                        api.k.CloseHandle(handle)
                        errors.append("debug-member-count-or-identity-bound")
                        terminate("debug-member-bound")
                    else:
                        item = {"handle": handle, "exitContinued": False, "seen": set(), "machine": None}
                        members[pid] = item  # Own before subsequent fallible API.
                        exact_pid = int(api.k.GetProcessId(handle))
                        in_job = C.c_int()
                        ok = int(api.k.IsProcessInJob(handle, job, C.byref(in_job)))
                        error = C.get_last_error() if not ok else None
                        machine, native = C.c_uint16(), C.c_uint16()
                        machine_ok = int(api.k.IsWow64Process2(handle, C.byref(machine), C.byref(native)))
                        machine_error = C.get_last_error() if not machine_ok else None
                        item["machine"] = machine.value if machine_ok else None
                        same_leader = (bool(api.same_object(handle, original.process))
                                       if pid == int(original.pid) else None)
                        distinct = all(bool(api.same_object(handle, other["handle"])) is False
                                       for other_pid, other in members.items() if other_pid != pid)
                        record("original-create-object", pid=pid, exactPid=exact_pid,
                               inOriginalJobQuery=ok, inOriginalJobError=error, inOriginalJob=bool(in_job.value),
                               sameOriginalLeader=same_leader, distinctOriginalObject=distinct,
                               machineQuery=machine_ok, machineError=machine_error,
                               processMachine=machine.value if machine_ok else None,
                               nativeMachine=native.value if machine_ok else None)
                        if exact_pid != pid or not ok or not in_job.value or not distinct or not machine_ok:
                            errors.append("create-original-object-validation-failed")
                            terminate("create-validation-failure")
                        if pid == int(original.pid) and (not same_leader or native.value != MACHINE_AMD64
                                or (architecture == "SysWOW64" and machine.value != MACHINE_I386)
                                or (architecture == "System32" and machine.value != 0)):
                            errors.append("fixed-system-command-architecture-or-owner-mismatch")
                            terminate("fixed-command-identity-failure")
                elif kind == 1:
                    info = raw.data.exception
                    member = members.get(pid)
                    if member is None:
                        errors.append("exception-without-original-create-object")
                        pending["status"] = DBG_EXCEPTION_NOT_HANDLED
                    else:
                        pending["status"] = decision(policy, int(info.record.code), bool(info.firstChance),
                                                     member["machine"], member["seen"])
                    row = {"pid": pid, "code": int(info.record.code), "codeHex": f"0x{info.record.code:08x}",
                           "firstChance": int(info.firstChance), "continuation": pending["status"],
                           "beforeContinue": True}
                    exceptions.append(row)
                    record("debug-exception", **row)
                elif kind == 5 and pid not in members:
                    errors.append("exit-without-original-create-object")
                elif kind == 9:  # RIP_EVENT is never accepted as normal.
                    errors.append("debug-rip-event")
                    terminate("debug-rip-event")
                elif kind not in (2, 4, 5, 6, 7, 8):
                    errors.append("unknown-debug-event")
                    terminate("unknown-debug-event")
            ok = int(api.k.ContinueDebugEvent(pid, tid, pending["status"]))
            error = C.get_last_error() if not ok else None
            record("debug-event-continue", event=kind, pid=pid, tid=tid, status=pending["status"], ok=ok, error=error)
            if not ok:
                continuation_failures += 1
                errors.append(f"debug-continue-{error}")
                terminate("debug-continue-failure")
                if continuation_failures >= 4:
                    break  # Pending stays explicit; supervisor remains owner.
                continue
            if kind == 5 and pid in members:
                members[pid]["exitContinued"] = True
            pending = None
            if members and all(item["exitContinued"] for item in members.values()):
                final = completion(api, job, original, members)
                if final["completeOriginalObjects"]:
                    break
    except Exception as error:
        errors.append(str(error) if type(error) is RuntimeError else type(error).__name__)
        # Exceptional cleanup stays on this same debugger owner thread. Keep a
        # failed pending event and drive the target to termination, never wait
        # synchronously for a process whose EXIT is not yet continued.
        terminate("observer-exception")
    finally:
        if original is not None:
            # A small independent bounded cleanup pump also handles exceptions
            # inside event observation without inventing a successful sample.
            if final is None or not final["completeOriginalObjects"]:
                terminate("incomplete-final-observation")
                while time.monotonic() < cleanup_end:
                    if pending is None:
                        raw = DebugEvent()
                        ok = int(api.k.WaitForDebugEvent(C.byref(raw), 25))
                        if not ok:
                            error = C.get_last_error()
                            if error != ERROR_SEM_TIMEOUT:
                                break
                            continue
                        pending = {"raw": raw, "handled": False, "status": DBG_CONTINUE, "closedImage": False}
                    raw = pending["raw"]
                    kind, pid = int(raw.kind), int(raw.pid)
                    if not pending["handled"]:
                        pending["handled"] = True
                        if kind in (3, 6):
                            image = raw.data.create.file if kind == 3 else raw.data.load.file
                            if image:
                                api.k.CloseHandle(image)
                                pending["closedImage"] = True
                        if kind == 3 and pid not in members and len(members) < MAX_MEMBERS:
                            try:
                                members[pid] = {"handle": api.duplicate(raw.data.create.process),
                                                "exitContinued": False, "seen": set(), "machine": None}
                            except Exception:
                                errors.append("cleanup-create-object-duplicate-failed")
                        if kind == 1:
                            pending["status"] = DBG_EXCEPTION_NOT_HANDLED
                    ok = int(api.k.ContinueDebugEvent(raw.pid, raw.tid, pending["status"]))
                    error = C.get_last_error() if not ok else None
                    record("cleanup-debug-event-continue", event=kind, pid=pid, ok=ok, error=error)
                    if not ok:
                        break
                    if kind == 5 and pid in members:
                        members[pid]["exitContinued"] = True
                    pending = None
                    final = completion(api, job, original, members)
                    if final["completeOriginalObjects"]:
                        break
            final = completion(api, job, original, members)
        duplicate_closes = []
        for pid, item in members.items():
            ok = int(api.k.CloseHandle(item["handle"]))
            error = C.get_last_error() if not ok else None
            duplicate_closes.append({"pid": pid, "ok": ok, "error": error})
        original_closes = api.close(original) if original is not None else None
        record("original-object-case-final", final=final, forced=forced, errors=errors,
               pendingEvent=pending is not None, events=events, originalHandleCloses=original_closes,
               retainedCreateObjectCloses=duplicate_closes)
    settled = bool(final and final["completeOriginalObjects"] and pending is None
                   and original_closes and original_closes["threadClose"] and original_closes["processClose"]
                   and all(row["ok"] for row in duplicate_closes))
    natural_zero = bool(settled and not forced and not errors
                        and all(row["exitCodeIfSignaled"] == 0 for row in final["objects"]))
    return {**prefix, "command": str(command), "exceptions": exceptions, "events": events,
            "originalObjectsSettled": settled, "forced": forced, "errors": errors,
            "naturalExitZero": natural_zero,
            "observationCompleted": settled and not forced and not errors,
            "final": final, "pendingEvent": pending is not None,
            "elapsedSeconds": time.monotonic() - start}


def commands(api, journal):
    replies = [directory_reply(api.k.GetSystemDirectoryW, "GetSystemDirectoryW"),
               directory_reply(api.k.GetSystemWow64DirectoryW, "GetSystemWow64DirectoryW"),
               directory_reply(api.k.GetSystemWow64DirectoryW, "GetSystemWow64DirectoryW", 32768)]
    if api.wow64_directory2 is not None:
        replies.append(directory_reply(api.wow64_directory2, "GetSystemWow64Directory2W", machine=MACHINE_I386))
    else:
        replies.append({"api": "GetSystemWow64Directory2W", "requestedMachine": MACHINE_I386,
                        "unavailable": True, "nonemptyAbsoluteCountMatched": False})
    for reply in replies:
        journal.add({"kind": "system-directory-api-reply", **reply})
    system, wow64, _, wow64_i386 = replies
    if (not system["nonemptyAbsoluteCountMatched"]
            or PureWindowsPath(system["bufferValue"]) != PureWindowsPath(str(api.system))):
        raise RuntimeError("fixed-system32-directory-reply-invalid-or-inconsistent")
    result = [("System32", Path(system["bufferValue"]) / "cmd.exe")]
    unsupported = None
    if not wow64["nonemptyAbsoluteCountMatched"] or not wow64_i386["nonemptyAbsoluteCountMatched"]:
        unsupported = {"architecture": "SysWOW64", "reason": "system-wow64-directory-reply-invalid-or-unavailable"}
    elif PureWindowsPath(wow64["bufferValue"]) != PureWindowsPath(wow64_i386["bufferValue"]):
        unsupported = {"architecture": "SysWOW64", "reason": "system-wow64-directory-apis-disagree"}
    else:
        path = Path(wow64_i386["bufferValue"]) / "cmd.exe"
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            unsupported = {"architecture": "SysWOW64", "reason": "fixed-wow64-command-unavailable"}
        else:
            result.append(("SysWOW64", path))
    if not result[0][1].is_absolute() or not result[0][1].is_file() or result[0][1].is_symlink():
        raise RuntimeError("fixed-system32-command-unavailable")
    return result, unsupported, replies


def worker(output):
    api, journal = None, Journal(output / "events.jsonl")
    start = time.monotonic()
    cases, fixed, unsupported, failure, job_closes, directory_replies = [], [], None, None, [], []
    complete = False
    try:
        api = Api()
        journal.add({"kind": "system-directory-before-dll-load", **api.initial_system_reply})
        journal.add({"kind": "debugger-owner", "killOnDebuggerExitDefaultPreserved": True,
                     "sameLaunchingThreadOwnsEveryWaitAndContinue": True,
                     "createSuspendedBeforeOriginalJobAssignment": True,
                     "debugSchedulingDiffersFromProduct": True})
        fixed, unsupported, directory_replies = commands(api, journal)
        with tempfile.TemporaryDirectory(prefix="farfold-breakpoint-observer-") as cwd:
            for architecture, command in fixed:
                for policy in POLICIES:
                    if time.monotonic() >= start + WORK_SECONDS:
                        raise RuntimeError("worker-work-budget")
                    job = api.job()
                    try:
                        cases.append(run_case(api, job, command, architecture, policy, cwd, journal,
                                              start + WORK_SECONDS, start + WORKER_SECONDS))
                    finally:
                        ok = int(api.k.CloseHandle(job))
                        error = C.get_last_error() if not ok else None
                        row = {"architecture": architecture, "policy": policy, "ok": ok, "error": error}
                        job_closes.append(row)
                        journal.add({"kind": "original-command-job-close", **row})
                    if not cases[-1]["originalObjectsSettled"]:
                        raise RuntimeError("original-command-objects-not-settled")
        complete = (len(cases) == len(fixed) * len(POLICIES)
                    and all(case["observationCompleted"] for case in cases)
                    and all(row["ok"] for row in job_closes))
    except Exception as error:
        failure = {"type": type(error).__name__,
                   "phase": str(error) if isinstance(error, RuntimeError) else "worker-exception"}
        if isinstance(error, DirectoryReplyError):
            failure["directoryApiReply"] = error.reply
    finally:
        journal.close()
    # A nonzero candidate exit is an observed result, not a diagnostic failure.
    # The control is a comparison, not claimed production support or acceptance.
    comparisons = []
    for architecture in ("System32", "SysWOW64"):
        paired = {case["policy"]: case for case in cases if case["architecture"] == architecture}
        if len(paired) == len(POLICIES):
            comparisons.append({"architecture": architecture,
                "policies": [{"policy": policy,
                              "naturalExitZero": paired[policy]["naturalExitZero"],
                              "originalObjectsSettled": paired[policy]["originalObjectsSettled"],
                              "originalExitCode": ((paired[policy]["final"] or {}).get("originalLeader") or {}).get("exitCodeIfSignaled"),
                              "firstChanceCodes": [row["codeHex"] for row in paired[policy]["exceptions"]
                                                   if row["firstChance"]]}
                             for policy in POLICIES]})
    controls = [case for case in cases if case["policy"] == "known-loader-classes-once"]
    result = {"observationCompleted": complete, "productionAcceptance": False,
              "cases": cases, "unsupported": [unsupported] if unsupported else [], "failure": failure,
              "directoryApiReplies": directory_replies,
              "comparison": comparisons,
              "originalJobCloses": job_closes,
              "rawRecords": journal.count, "rawBytes": journal.size,
              "rawSha256": journal.hash.hexdigest(), "elapsedSeconds": time.monotonic() - start,
              "knownLoaderControlCaseCount": len(controls),
              "knownLoaderControlExpectedCaseCount": len(fixed),
              "knownLoaderControlAllNaturalZero": bool(controls and len(controls) == len(fixed)
                                                        and all(case["naturalExitZero"] for case in controls)),
              "debugSchedulingDiffersFromProduct": True,
              "scope": "Fixed official system cmd loader events only; no selected Git/Agent/product acceptance."}
    BASE.write_json(output / "worker-summary.json", result)
    return 0 if complete else 1


def supervisor(output):
    start = time.monotonic()
    output = output.absolute()
    if any(path.is_symlink() for path in [output, *output.parents]):
        raise RuntimeError("output-symlink-refused")
    output.mkdir(mode=0o700, exist_ok=False)
    api, control, child = None, None, None
    status = {"observationCompleted": False, "productionAcceptance": False,
              "toolSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "sharedApiSha256": SHARED_API_SHA256,
              "limits": {"caseSeconds": CASE_SECONDS, "caseCleanupSeconds": CLEANUP_SECONDS,
                         "workerWorkSeconds": WORK_SECONDS, "workerSeconds": WORKER_SECONDS,
                         "supervisorWaitSeconds": PARENT_SECONDS, "totalSeconds": TOTAL_SECONDS,
                         "maxCases": MAX_CASES, "maxMembersPerCase": MAX_MEMBERS,
                         "maxEventsPerCase": MAX_EVENTS_PER_CASE, "maxRawRecords": MAX_RECORDS,
                         "maxRawBytes": MAX_RAW_BYTES, "maxFixedCommandSpawns": MAX_CASES,
                         "maxObserverSpawns": 1},
              "scope": "System32/SysWOW64 cmd /d /c exit 0; original owned objects only."}
    try:
        api = Api()
        status["systemDirectoryApiReply"] = api.initial_system_reply
        control = api.job()
        args = ["-I", "-S", "-B", str(Path(__file__).absolute()), "--worker", "--output", str(output)]
        child = api.create(Path(sys.executable).absolute(), args)
        ok = int(api.k.AssignProcessToJobObject(control, child.process))
        error = C.get_last_error() if not ok else None
        child.assigned = bool(ok)
        status["observerAssignment"] = {"ok": ok, "error": error}
        if not ok:
            raise RuntimeError("observer-containment-assignment-failed")
        resumed = int(api.k.ResumeThread(child.thread))
        error = C.get_last_error() if resumed == 0xFFFFFFFF else None
        status["observerResume"] = {"previousSuspendCount": resumed, "error": error}
        if resumed != 1:
            raise RuntimeError("observer-resume-unconfirmed")
        status["observerTerminal"] = api.wait(child, max(0, int((start + PARENT_SECONDS - time.monotonic()) * 1000)))
    except Exception as error:
        status["failure"] = {"type": type(error).__name__,
                             "phase": str(error) if isinstance(error, RuntimeError) else "supervisor-exception"}
        if isinstance(error, DirectoryReplyError):
            status["failure"]["directoryApiReply"] = error.reply
    finally:
        if child is not None:
            current = api.wait(child)
            if current["wait"] != WAIT_OBJECT_0:
                ok = int(api.k.TerminateProcess(child.process, 98))
                error = C.get_last_error() if not ok else None
                status["observerOriginalObjectTermination"] = {"ok": ok, "error": error}
                if control:
                    ok = int(api.k.TerminateJobObject(control, 98))
                    error = C.get_last_error() if not ok else None
                    status["outerOriginalJobTermination"] = {"ok": ok, "error": error}
                current = api.wait(child, max(0, int((start + TOTAL_SECONDS - time.monotonic()) * 1000)))
            status["observerFinalWait"] = current
            status["observerOriginalHandleCloses"] = api.close(child)
        if control:
            ok = int(api.k.CloseHandle(control))
            error = C.get_last_error() if not ok else None
            status["originalOuterJobClose"] = {"ok": ok, "error": error}
    summary, raw_path = output / "worker-summary.json", output / "events.jsonl"
    if summary.is_file() and summary.stat().st_size <= 65536:
        raw = summary.read_bytes()
        result = json.loads(raw)
        status["workerSummarySha256"] = hashlib.sha256(raw).hexdigest()
        status["workerSummary"] = result
        terminal = status.get("observerTerminal", {})
        status["observationCompleted"] = bool(
            "failure" not in status and "observerOriginalObjectTermination" not in status
            and terminal.get("wait") == WAIT_OBJECT_0 and terminal.get("exitCodeIfSignaled") == 0
            and status.get("observerFinalWait", {}).get("wait") == WAIT_OBJECT_0
            and all(status.get("observerOriginalHandleCloses", {}).get(name) for name in ("threadClose", "processClose"))
            and status.get("originalOuterJobClose", {}).get("ok")
            and result.get("observationCompleted") is True
            and raw_path.is_file() and raw_path.stat().st_size <= MAX_RAW_BYTES
            and hashlib.sha256(raw_path.read_bytes()).hexdigest() == result.get("rawSha256"))
    status["elapsedSeconds"] = time.monotonic() - start
    status["nativeCallBoundary"] = "Wait/loop budgets finite; external workflow timeout preserves incomplete evidence if a native call fails to return."
    BASE.write_json(output / "summary.json", status)
    print(json.dumps({"observationCompleted": status["observationCompleted"], "summary": str(output / "summary.json")}))
    return 0 if status["observationCompleted"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    return worker(args.output) if args.worker else supervisor(args.output)


if __name__ == "__main__":
    raise SystemExit(main())
