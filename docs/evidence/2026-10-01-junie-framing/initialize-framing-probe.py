"""Reviewed one-shot byte-shape probe. Default mode never starts a process.

No network/download code. --execute consumes the exact public release archive,
extracts only into a newly owned temp directory, and sends one initialize line.
Raw child output and environment values are never printed or persisted.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time

BASE = Path(__file__).resolve().parent
REPO = BASE.parents[2]
MAX_BYTES = 1024 * 1024
MAX_LINE = 64 * 1024
MAX_RECORDS = 128
OBSERVE_SECONDS = 45
TOTAL_CHILD_SECONDS = 60
REQUEST = json.loads((BASE / "initialize-input.json").read_text())
SOURCE = json.loads((BASE / "public-source-precheck.json").read_text())


def now():
    return datetime.datetime.now().astimezone().isoformat()


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def classify(raw, complete):
    """Return only fixed enums/bools/integers; never return an input substring."""
    item = {"bytes": len(raw), "newlineTerminated": complete,
            "utf8": True, "utf8ErrorOffset": None,
            "bomAtStart": raw.startswith(b"\xef\xbb\xbf"),
            "blank": not raw.strip(b" \t\r"),
            "ansiEscape": b"\x1b[" in raw or b"\x1b]" in raw,
            "carriageReturnAtEnd": raw.endswith(b"\r"),
            "containsNul": b"\0" in raw,
            "jsonSyntax": "not_checked", "jsonErrorOffset": None,
            "errorAtEnd": False, "jsonRoot": "not_available",
            "messageShape": "not_available"}
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        item.update(utf8=False, utf8ErrorOffset=error.start)
        return item
    try:
        def reject_constant(_):
            raise ValueError()
        value = json.loads(text, parse_constant=reject_constant)
    except json.JSONDecodeError as error:
        # Python's message may contain input data: use only an exact whitelist.
        categories = {
            "Expecting value": "expected_value",
            "Extra data": "trailing_data",
            "Expecting property name enclosed in double quotes": "expected_key",
            "Expecting ':' delimiter": "expected_colon",
            "Expecting ',' delimiter": "expected_comma",
            "Unterminated string starting at": "unterminated_string",
            "Invalid control character at": "invalid_control",
            "Invalid \\escape": "invalid_escape",
            "Invalid \\uXXXX escape": "invalid_unicode_escape",
            "Unexpected UTF-8 BOM (decode using utf-8-sig)": "bom_rejected",
        }
        item.update(jsonSyntax=categories.get(error.msg, "other_syntax"),
                    jsonErrorOffset=len(text[:error.pos].encode("utf-8")),
                    errorAtEnd=error.pos >= len(text))
        return item
    except (ValueError, RecursionError):
        item["jsonSyntax"] = "constant_or_depth_rejected"
        return item
    item["jsonSyntax"] = "valid_json"
    item["jsonRoot"] = ("object" if isinstance(value, dict) else
                        "array" if isinstance(value, list) else "scalar")
    if isinstance(value, dict):
        if "method" in value:
            item["messageShape"] = "request" if "id" in value else "notification"
        elif value.get("id") == REQUEST["id"]:
            item["messageShape"] = ("initialize_error" if "error" in value else
                                    "initialize_result" if "result" in value else
                                    "matched_id_without_result")
        else:
            item["messageShape"] = "other_object"
    elif isinstance(value, list):
        item["messageShape"] = "batch_not_handled"
    return item


class Capture:
    def __init__(self):
        self.counts = {"stdout": 0, "stderr": 0}
        self.buffers = {"stdout": b"", "stderr": b""}
        self.records = []
        self.stop = None

    def feed(self, stream, chunk):
        self.counts[stream] += len(chunk)
        if self.counts[stream] > MAX_BYTES:
            self.stop = "output_limit"
            return
        self.buffers[stream] += chunk
        while b"\n" in self.buffers[stream] and self.stop is None:
            raw, self.buffers[stream] = self.buffers[stream].split(b"\n", 1)
            self.record(stream, raw, True)
        if len(self.buffers[stream]) > MAX_LINE:
            self.stop = "line_limit"
            self.buffers[stream] = b""

    def record(self, stream, raw, complete):
        if len(raw) > MAX_LINE or len(self.records) >= MAX_RECORDS:
            self.stop = "record_or_line_limit"
            return
        item = classify(raw, complete)
        item["stream"] = stream
        self.records.append(item)
        if stream == "stdout" and item["messageShape"] in (
                "request", "initialize_error", "initialize_result",
                "matched_id_without_result", "batch_not_handled"):
            self.stop = item["messageShape"]

    def finish(self):
        for stream, raw in self.buffers.items():
            if raw:
                self.record(stream, raw, False)
        self.buffers = {"stdout": b"", "stderr": b""}


def processes():
    # No argv/environment is requested. lstart+comm identify sampled processes.
    completed = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart=,comm="],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=True)
    if len(completed.stdout) > 2 * MAX_BYTES:
        raise RuntimeError()
    rows = {}
    for line in completed.stdout.decode("utf-8", errors="replace").splitlines():
        parts = line.split(None, 8)
        if len(parts) == 9 and all(p.isdigit() for p in parts[:3]):
            rows[int(parts[0])] = (int(parts[1]), int(parts[2]),
                                   " ".join(parts[3:8]), parts[8])
    return rows


def track(rows, pgid, tracked):
    selected = {pid for pid, row in rows.items() if row[1] == pgid}
    parents = set(selected) | {pid for pid, identity in tracked.items()
                               if pid in rows and rows[pid][2:] == identity}
    while True:
        children = {pid for pid, row in rows.items() if row[0] in parents}
        if children <= parents:
            break
        parents |= children
    for pid in parents:
        if pid in rows:
            tracked[pid] = rows[pid][2:]


def save(receipt):
    target = BASE / "framing-observation.json"
    temporary = BASE / "framing-observation.partial.json"
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    temporary.replace(target)


def execute(archive):
    if (BASE / "framing-observation.json").exists():
        raise RuntimeError()  # One observation; no automatic retry.
    if any(digest(REPO / path) != sha for path, sha in SOURCE["sourceHashes"].items()):
        raise RuntimeError()
    if digest(BASE / "initialize-input.json") != SOURCE["wireInput"]["sha256"]:
        raise RuntimeError()
    if archive.stat().st_size != SOURCE["release"]["archiveBytes"]:
        raise RuntimeError()
    if digest(archive) != SOURCE["release"]["archiveSha256"]:
        raise RuntimeError()  # Public archive provenance, not a binary admission pin.
    data = Path.home() / "Library/Application Support/ai.farfold.desktop"
    cwd = data
    expected_cwd = Path("/Users/tw/Library/Application Support/ai.farfold.desktop")
    if not cwd.is_dir() or cwd != expected_cwd or cwd.resolve() != expected_cwd:
        raise RuntimeError()
    rows = processes()
    if any(row[3] == "/Applications/Farfold.app/Contents/MacOS/farfold"
           for row in rows.values()):
        raise RuntimeError()
    owned = Path(tempfile.mkdtemp(prefix="farfold-junie-framing-")).resolve()
    root = owned / "extracted"
    root.mkdir()
    receipt = {"startedAt": now(), "outcome": "preparing",
               "archiveSourceVerified": True, "extractionRoot": str(root),
               "parser": "python_json_shape_only", "sdkAcceptanceVerified": False,
               "cwd": str(cwd), "environmentInherited": True, "homeOverridden": False,
               "sentInitialize": 0, "sentOtherMessages": 0,
               "childStarted": False, "childReaped": False,
               "termRequested": False, "killRequested": False,
               "cleanupConfirmed": False, "tempRetained": True}
    process = None
    selector = selectors.DefaultSelector()
    capture = Capture()
    tracked = {}
    deadline = None
    previous_term = signal.getsignal(signal.SIGTERM)
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        save(receipt)
        subprocess.run(["/usr/bin/ditto", "-x", "-k", str(archive), str(root)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=60, check=True)
        entry = root / SOURCE["registry"]["entry"]
        if not entry.resolve(strict=True).is_relative_to(root):
            raise RuntimeError()
        if not stat.S_ISREG(entry.stat().st_mode) or not os.access(entry, os.X_OK):
            raise RuntimeError()
        deadline = time.monotonic() + TOTAL_CHILD_SECONDS
        observe_until = time.monotonic() + OBSERVE_SECONDS
        process = subprocess.Popen([str(entry), *SOURCE["registry"]["args"]],
                                   cwd=cwd, env=None, start_new_session=True,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)
        receipt.update(childStarted=True, pid=process.pid, outcome="observing")
        # Every post-Popen setup operation is inside the same finally guard.
        rows = processes()
        track(rows, process.pid, tracked)
        save(receipt)
        for stream in ("stdout", "stderr"):
            pipe = getattr(process, stream)
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, stream)
        wire = json.dumps(REQUEST, separators=(",", ":")).encode("utf-8") + b"\n"
        os.set_blocking(process.stdin.fileno(), False)
        if os.write(process.stdin.fileno(), wire) != len(wire):
            raise RuntimeError()
        receipt["sentInitialize"] = 1
        receipt["initializeWireBytes"] = len(wire)
        while time.monotonic() < observe_until and not capture.stop and selector.get_map():
            for key, _ in selector.select(timeout=0.2):
                try:
                    chunk = os.read(key.fileobj.fileno(), 16384)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    capture.feed(key.data, chunk)
            track(processes(), process.pid, tracked)
        receipt["outcome"] = capture.stop or (
            "timeout" if time.monotonic() >= observe_until else "eof")
    except BaseException as error:
        receipt["outcome"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "probe_error"
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if process is not None:
            try:
                track(processes(), process.pid, tracked)
                os.killpg(process.pid, signal.SIGTERM)
                receipt["termRequested"] = True
            except ProcessLookupError:
                pass
            except Exception:
                receipt["cleanupObservationFailed"] = True
            try:
                process.wait(timeout=min(3, max(0.01, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            # After reaping the leader, a numeric PGID alone is not ownership.
            try:
                os.killpg(process.pid, 0)
                rows = processes()
                group_owned = process.returncode is None or any(
                    pid in rows and rows[pid][1] == process.pid and rows[pid][2:] == identity
                    for pid, identity in tracked.items())
                if group_owned:
                    os.killpg(process.pid, signal.SIGKILL)
                    receipt["killRequested"] = True
                else:
                    receipt["groupOwnershipUnconfirmed"] = True
            except ProcessLookupError:
                pass
            except Exception:
                receipt["cleanupObservationFailed"] = True
            try:
                process.wait(timeout=min(2, max(0.01, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            # Final draining is bounded by 16 reads / 256 KiB / 1 second.
            drain_until = min(deadline, time.monotonic() + 1)
            for _ in range(16):
                if time.monotonic() >= drain_until or not selector.get_map():
                    break
                for key, _ in selector.select(timeout=0):
                    try:
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        elif not capture.stop:
                            capture.feed(key.data, chunk)
                    except (BlockingIOError, OSError):
                        continue
            receipt.update(childReaped=process.returncode is not None,
                           childExitCode=process.returncode)
            try:
                rows = processes()
                track(rows, process.pid, tracked)
                alive = [pid for pid, identity in tracked.items()
                         if pid in rows and rows[pid][2:] == identity]
                group_alive = any(row[1] == process.pid for row in rows.values())
                receipt.update(sampledIdentityCount=len(tracked),
                               sampledIdentities=[{"pid": pid, "started": identity[0]}
                                                  for pid, identity in tracked.items()],
                               sampledIdentitiesStillAlive=alive, groupStillPresent=group_alive,
                               cleanupConfirmed=process.returncode is not None
                               and not alive and not group_alive)
            except Exception:
                receipt["cleanupObservationFailed"] = True
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe:
                    pipe.close()
        else:
            receipt["cleanupConfirmed"] = True
        selector.close()
        capture.finish()
        receipt.update(finishedAt=now(), bytes=capture.counts, shapes=capture.records,
                       outputBodiesPersisted=False, scope="sampled identities and owned group only")
        # Do not delete an extraction tree when a sampled child may still use it.
        if receipt["cleanupConfirmed"]:
            try:
                shutil.rmtree(owned)
                receipt["tempRetained"] = False
            except OSError:
                receipt["tempCleanupFailed"] = True
        save(receipt)
        signal.signal(signal.SIGTERM, previous_term)
    print(json.dumps({"receipt": "framing-observation.json", "outcome": receipt["outcome"],
                      "cleanupConfirmed": receipt["cleanupConfirmed"]}))
    if not receipt["cleanupConfirmed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    if not args.execute:
        print("Prepared only. No archive read, extraction, or Agent execution.")
    elif args.archive is None:
        parser.error("--archive is required with --execute")
    else:
        try:
            execute(args.archive.resolve(strict=True))
        except Exception:
            raise SystemExit("Probe precondition failed; no raw error details emitted.")
