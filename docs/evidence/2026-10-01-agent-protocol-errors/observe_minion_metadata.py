"""Bounded, read-only sampling of two public distributions in Minion candidates.

Run only alongside an explicitly requested installation:
  python3 observe_minion_metadata.py minion-metadata.json 60

No package import, process execution, configuration, environment or log reading.
Only Name/Version headers are retained. The result is a sampled combination,
not proof of executed package bytes, successful installation or failure cause.
"""

import contextlib
import datetime
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time


BASE = Path(__file__).resolve().parent
PARENT = Path(
    "/Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:minion-code"
)
MAX_ROOTS = 32
MAX_LIBRARIES = 8
MAX_PACKAGE_ENTRIES = 1024
MAX_MATCHES_PER_ROOT = 8
MAX_READS = 512
MAX_HEADER_BYTES = 64 * 1024
MAX_SNAPSHOTS = 128
NAMES = {"minion-code", "agent-client-protocol"}
DIST_INFO = re.compile(
    r"(?:minion_code|agent_client_protocol)-[A-Za-z0-9][A-Za-z0-9_.!+\-]{0,127}\.dist-info"
)
COUNTERS = {"metadataReads": 0, "directoryLimitHits": 0, "readErrors": 0}


class DeadlineReached(Exception):
    pass


class ReadLimitReached(Exception):
    pass


def timestamp():
    return datetime.datetime.now().astimezone().isoformat()


def timeout(_signal, _frame):
    raise DeadlineReached()


@contextlib.contextmanager
def directory(name, parent_fd=None):
    # Every traversed descendant must be a real directory, never a symlink.
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        yield fd
    finally:
        os.close(fd)


def entries(fd, limit):
    names = []
    with os.scandir(fd) as found:
        for entry in found:
            if len(names) == limit:
                COUNTERS["directoryLimitHits"] += 1
                break
            names.append(entry.name)
    return names


def public_headers(info_fd):
    if COUNTERS["metadataReads"] >= MAX_READS:
        raise ReadLimitReached()
    COUNTERS["metadataReads"] += 1
    fd = os.open("METADATA", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=info_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        # Unbuffered readline stops at the header separator; it does not read
        # the METADATA description/README body. The total header budget is 64 KiB.
        with os.fdopen(fd, "rb", buffering=0, closefd=False) as stream:
            fields = {}
            remaining = MAX_HEADER_BYTES
            while remaining:
                line = stream.readline(remaining)
                remaining -= len(line)
                if not line or not line.endswith(b"\n") or line in (b"\n", b"\r\n"):
                    break
                for key in (b"Name", b"Version"):
                    if line.startswith(key + b":"):
                        if key in fields:
                            return None
                        value = line[len(key) + 1 :].strip()
                        if len(value) > 128:
                            return None
                        fields[key] = value.decode("ascii")
                if len(fields) == 2:
                    name, version = fields[b"Name"], fields[b"Version"]
                    normalized = re.sub(r"[-_.]+", "-", name).lower()
                    if normalized not in NAMES or not re.fullmatch(
                        r"[A-Za-z0-9][A-Za-z0-9.!+_\-]{0,127}", version
                    ):
                        return None
                    return {"name": name, "version": version}
    finally:
        os.close(fd)
    return None


def sample(root_fd):
    distributions = {}
    matched = 0
    with directory("venv", root_fd) as venv_fd, directory("lib", venv_fd) as lib_fd:
        for library in entries(lib_fd, MAX_LIBRARIES):
            if not re.fullmatch(r"python\d+(?:\.\d+){0,2}", library):
                continue
            with directory(library, lib_fd) as python_fd, directory(
                "site-packages", python_fd
            ) as packages_fd:
                for name in entries(packages_fd, MAX_PACKAGE_ENTRIES):
                    if not DIST_INFO.fullmatch(name):
                        continue
                    matched += 1
                    if matched > MAX_MATCHES_PER_ROOT:
                        return {"status": "metadata_limit", "distributions": []}
                    with directory(name, packages_fd) as info_fd:
                        value = public_headers(info_fd)
                    if value is None:
                        continue
                    key = re.sub(r"[-_.]+", "-", value["name"]).lower()
                    if key in distributions:
                        return {"status": "ambiguous_metadata", "distributions": []}
                    distributions[key] = value
    return {
        "status": "pair_observed" if distributions.keys() == NAMES else "partial",
        "distributions": [distributions[key] for key in sorted(distributions)],
    }


def main():
    if not 2 <= len(sys.argv) <= 3:
        raise SystemExit("Usage: observe_minion_metadata.py output.json [seconds<=60]")
    filename = sys.argv[1]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-]{0,100}\.json", filename):
        raise SystemExit("Output must be a JSON filename inside this evidence directory")
    seconds = float(sys.argv[2]) if len(sys.argv) == 3 else 60.0
    if not math.isfinite(seconds) or not 0 < seconds <= 60:
        raise SystemExit("Sampling duration must be greater than zero and at most 60 seconds")
    destination = BASE / filename
    # Exclusive creation prevents overwriting a previous receipt or a symlink.
    with destination.open("x", encoding="utf-8") as output:
        started = timestamp()
        snapshots = []
        previous = {}
        reason = "duration_limit"
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, seconds)
        deadline = time.monotonic() + seconds
        try:
            while time.monotonic() < deadline:
                try:
                    if PARENT.resolve(strict=True) != PARENT:
                        reason = "parent_not_canonical"
                        break
                    with directory(str(PARENT)) as parent_fd:
                        for name in entries(parent_fd, MAX_ROOTS):
                            if not re.fullmatch(r"install-[A-Za-z0-9_\-]{1,80}", name):
                                continue
                            root = PARENT / name
                            try:
                                if root.resolve(strict=True) != root or root.parent != PARENT:
                                    continue
                                with directory(name, parent_fd) as root_fd:
                                    value = sample(root_fd)
                                if previous.get(name) == value:
                                    continue
                                previous[name] = value
                                snapshots.append({"at": timestamp(), "root": str(root), **value})
                                if len(snapshots) >= MAX_SNAPSHOTS:
                                    reason = "snapshot_limit"
                                    raise ReadLimitReached()
                            except (OSError, UnicodeError):
                                # A failing installation may remove its own candidate mid-read.
                                COUNTERS["readErrors"] += 1
                except OSError:
                    COUNTERS["readErrors"] += 1
                time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        except DeadlineReached:
            pass
        except ReadLimitReached:
            if reason != "snapshot_limit":
                reason = "metadata_read_limit"
        except KeyboardInterrupt:
            reason = "interrupted"
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            result = {
                "started": started,
                "finished": timestamp(),
                "durationLimitSeconds": seconds,
                "stoppedBecause": reason,
                "scope": "Sampled public Name/Version only; not proof of execution or failure cause",
                "limits": {
                    "rootsPerScan": MAX_ROOTS,
                    "librariesPerRoot": MAX_LIBRARIES,
                    "entriesPerSitePackages": MAX_PACKAGE_ENTRIES,
                    "matchingMetadataPerRoot": MAX_MATCHES_PER_ROOT,
                    "totalMetadataReads": MAX_READS,
                    "headerBytesPerRead": MAX_HEADER_BYTES,
                    "snapshots": MAX_SNAPSHOTS,
                },
                "counters": COUNTERS,
                "samples": snapshots,
            }
            json.dump(result, output, ensure_ascii=False, indent=2)
            output.write("\n")
    print(json.dumps({"file": filename, "samples": len(snapshots)}))


if __name__ == "__main__":
    main()
