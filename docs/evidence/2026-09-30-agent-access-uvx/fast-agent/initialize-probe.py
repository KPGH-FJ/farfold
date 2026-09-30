"""One bounded, real initialize diagnostic; never saves raw Agent output."""

from __future__ import annotations

import builtins
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from uuid import uuid4


EVIDENCE = Path(__file__).resolve().parent
RECEIPT = EVIDENCE / "initialize-probe.json"
BASE = Path("/Users/tw/Library/Application Support/ai.farfold.desktop")
UV = BASE / "uv/uv-0.12.18/uv"
PYTHON = BASE / "python/cpython-3.12.13+20260807-aarch64/bin/python3.12"
CACHE = BASE / "uv/cache"
CONFIG_NAMES = (
    "fast-agent.yaml", "fast-agent.config.yaml", "fastagent.config.yaml",
    "fast-agent.secrets.yaml", "fastagent.secrets.yaml",
)
OVERRIDE_ROOTS = (
    "LOGGER", "OTEL", "MCP", "SESSION_HISTORY", "DEFAULT_MODEL", "MODEL_REFERENCES",
    "ENVIRONMENTS", "DEFAULT_ENVIRONMENT", "SKILLS", "PLUGINS", "SHELL_EXECUTION",
    "CLI_MODEL_OVERRIDE", "HARNESS_APP",
)
OVERRIDE_EXACT = {
    "FAST_AGENT_HOME", "FAST_AGENT_RUNTIME_HOME", "FAST_AGENT_MODEL",
    "FAST_AGENT_INTERACTIVE_DEBUG_TRACE", "PYTHONPATH", "PYTHONHOME",
    "PYTHONSTARTUP", "UV_CONFIG_FILE", "UV_TARGET", "UV_PREFIX",
    "UV_SYSTEM_PYTHON", "UV_PYTHON", "UV_PROJECT_ENVIRONMENT",
}
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
PUBLIC_TOKEN = re.compile(r"^[A-Za-z0-9_. /-]{1,100}$")
ALLOWED_EXCEPTIONS = {
    key for key, value in vars(builtins).items()
    if isinstance(value, type) and issubclass(value, BaseException)
} | {
    "ModelConfigError", "AgentConfigError", "ConfigFileError", "ServerInitializationError",
    "ConfigDiscoveryError", "AmbiguousConfigFilesError", "AmbiguousSecretsFilesError",
    "ValidationError", "CancelledError", "AuthenticationError", "APIKeyError",
    "ProviderKeyError", "ProviderInitializationError", "BadParameter", "UsageError",
}
CAPABILITY_KEYS = {
    "loadSession", "promptCapabilities", "image", "audio", "embeddedContext",
    "mcpCapabilities", "http", "sse", "sessionCapabilities", "list", "resume", "fork",
}
OWNED_PROCESSES = []
TRACKED_IDENTITIES = {}


def now():
    return datetime.now(timezone.utc).isoformat()


def save():
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


def preflight(cwd=None):
    overrides = sorted(
        name for name in os.environ
        if name.upper() in OVERRIDE_EXACT
        or any(name.upper() == root or name.upper().startswith(root + "__") for root in OVERRIDE_ROOTS)
    )
    home_ok = os.environ.get("HOME") == "/Users/tw" and Path.home() == Path("/Users/tw")
    global_presence = {name: (Path.home() / ".fast-agent" / name).exists() for name in CONFIG_NAMES}
    cwd_empty = cwd is None or not any(cwd.iterdir())
    return {
        "at": now(), "homeUnchanged": home_ok, "environmentOverrideNames": overrides,
        "globalConfigExists": global_presence, "taskCwdEmpty": cwd_empty,
        "allowed": home_ok and not overrides and not any(global_presence.values()) and cwd_empty,
    }


def processes():
    rows = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart="], capture_output=True, text=True, timeout=3,
    )
    if rows.returncode != 0:
        raise RuntimeError("process_inventory_failed")
    result = {}
    for line in rows.stdout.splitlines():
        values = line.split()
        if len(values) >= 8 and all(value.isdigit() for value in values[:3]):
            pid, ppid, pgid = map(int, values[:3])
            result[pid] = (ppid, pgid, " ".join(values[3:]))
    return result


def group_members(group):
    return sorted(pid for pid, (_, pgid, _) in processes().items() if pgid == group)


def observe_descendants(group, tracked):
    snapshot = processes()
    owned = {pid for pid, (_, pgid, _) in snapshot.items() if pgid == group}
    owned.update(pid for pid, identity in tracked.items() if snapshot.get(pid, (None, None, None))[2] == identity)
    while True:
        children = {pid for pid, (ppid, _, _) in snapshot.items() if ppid in owned}
        expanded = owned | children
        if expanded == owned:
            break
        owned = expanded
    for pid in owned:
        tracked.setdefault(pid, snapshot[pid][2])
        TRACKED_IDENTITIES.setdefault(pid, snapshot[pid][2])


def surviving_identities(tracked):
    snapshot = processes()
    return sorted(pid for pid, identity in tracked.items() if snapshot.get(pid, (None, None, None))[2] == identity)


def stop_group(proc):
    if proc.stdin is not None and not proc.stdin.closed:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
    for sig, grace in ((None, 1.5), (signal.SIGTERM, 2), (signal.SIGKILL, 2)):
        if sig is not None:
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
        until = time.monotonic() + grace
        while time.monotonic() < until:
            proc.poll()
            if not group_members(proc.pid):
                return []
            time.sleep(0.05)
    proc.poll()
    return group_members(proc.pid)


def safe_capabilities(value):
    if not isinstance(value, dict):
        return {}
    return {
        key: safe_capabilities(item) if isinstance(item, dict) else item
        for key, item in value.items()
        if key in CAPABILITY_KEYS and (isinstance(item, (dict, bool)) or item is None)
    }


def safe_declaration(result):
    if not isinstance(result, dict):
        return {"invalidResultShape": True}
    info = result.get("agentInfo", {})
    return {
        "protocolVersion": result.get("protocolVersion") if isinstance(result.get("protocolVersion"), int) else None,
        "agentInfo": {
            key: value for key, value in info.items()
            if key in {"name", "version"} and isinstance(value, str) and PUBLIC_TOKEN.fullmatch(value)
        } if isinstance(info, dict) else {},
        "agentCapabilities": safe_capabilities(result.get("agentCapabilities")),
        "authMethods": [
            {
                "id": method.get("id") if isinstance(method.get("id"), str) and PUBLIC_TOKEN.fullmatch(method["id"]) else None,
                "type": method.get("type") if method.get("type") in {"agent", "terminal", "env_var"} else None,
                "descriptionPresent": bool(method.get("description")),
            }
            for method in result.get("authMethods", []) if isinstance(method, dict)
        ] if isinstance(result.get("authMethods", []), list) else [],
    }


def safe_stderr(data, site):
    clean = ANSI.sub("", data.decode("utf-8", errors="replace"))
    classes = sorted({
        name for name in ALLOWED_EXCEPTIONS
        if re.search(r"(?m)(?:^|[│|\s])" + re.escape(name) + r"(?=:|\s*$)", clean)
    })
    frames = []
    # Keep only existing public dependency files inside this exact venv.
    pattern = r'site-packages/([A-Za-z0-9_./-]+\.py)(?:["\s]*, line |:)(\d+)'
    for match in re.finditer(pattern, clean):
        relative, line = match.groups()
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts or not (site / path).is_file():
            continue
        frame = {"modulePath": relative, "line": int(line)}
        if frame not in frames:
            frames.append(frame)
    return {"exceptionClasses": classes, "publicDependencyFrames": frames[:100]}


def bounded_process(argv, cwd, seconds, *, initialize=False, site=None):
    started = time.monotonic()
    item = {"argv": [str(part) for part in argv], "startedAt": now(), "limitSeconds": seconds,
            "activeReadLimitSeconds": seconds - 6, "cleanupReserveSeconds": 6}
    proc = subprocess.Popen(
        argv, cwd=cwd, stdin=subprocess.PIPE if initialize else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    OWNED_PROCESSES.append(proc)
    item["pid"] = proc.pid
    receipt["commands"].append(item)
    save()
    selector = selectors.DefaultSelector()
    for label, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, label)
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": 256 * 1024, "stderr": 512 * 1024}
    total = {"stdout": 0, "stderr": 0}
    stdout_pending = bytearray()
    reason = None
    tracked = {}
    next_inventory = started
    try:
        observe_descendants(proc.pid, tracked)
        if initialize:
            payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": 1, "clientInfo": {"name": "farfold-startup-probe", "version": "0"},
                "clientCapabilities": {},
            }}
            try:
                proc.stdin.write((json.dumps(payload) + "\n").encode())
                proc.stdin.flush()
                item["sentMethods"] = ["initialize"]
            except BrokenPipeError:
                item["sentMethods"] = []
                item["stdinClosedBeforeSend"] = True
        while selector.get_map() and reason is None:
            if time.monotonic() - started >= seconds - 6:
                reason = "time_limit"
                break
            if time.monotonic() >= next_inventory:
                observe_descendants(proc.pid, tracked)
                next_inventory = time.monotonic() + 0.5
            for key, _ in selector.select(0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                label = key.data
                total[label] += len(data)
                available = limits[label] - len(buffers[label])
                buffers[label].extend(data[:available])
                if total[label] > limits[label]:
                    reason = "output_limit"
                    break
                if initialize and label == "stdout":
                    stdout_pending.extend(data)
                    while b"\n" in stdout_pending:
                        line, _, rest = stdout_pending.partition(b"\n")
                        stdout_pending = bytearray(rest)
                        try:
                            message = json.loads(line)
                        except (ValueError, UnicodeError):
                            reason = "non_protocol_stdout"
                            break
                        if not isinstance(message, dict):
                            reason = "invalid_protocol_shape"
                            break
                        if "method" in message:
                            reason = "unexpected_agent_request_or_notification"
                            break
                        if message.get("id") != 1:
                            reason = "unexpected_response_id"
                            break
                        if "result" in message:
                            item["initialize"] = safe_declaration(message["result"])
                            reason = "initialize_response"
                        elif "error" in message:
                            error = message["error"]
                            code = error.get("code") if isinstance(error, dict) else None
                            item["protocolErrorCode"] = code if isinstance(code, int) else None
                            reason = "initialize_error_response"
                        else:
                            reason = "invalid_protocol_shape"
                        break
                if reason is not None:
                    break
        if reason is None:
            reason = "process_streams_closed"
    finally:
        observe_descendants(proc.pid, tracked)
        remaining = stop_group(proc)
        # Drain remaining buffered bytes after termination without persisting raw text.
        drain_deadline = time.monotonic() + 0.25
        drain_reads = 0
        drain_limit_reached = False
        for key in list(selector.get_map().values()):
            while drain_reads < 16 and time.monotonic() < drain_deadline:
                try:
                    data = os.read(key.fileobj.fileno(), 65536)
                except BlockingIOError:
                    break
                drain_reads += 1
                if not data:
                    break
                label = key.data
                total[label] += len(data)
                buffers[label].extend(data[:max(0, limits[label] - len(buffers[label]))])
            else:
                drain_limit_reached = True
        selector.close()
        proc.stdout.close()
        proc.stderr.close()
        item.update({
            "finishedAt": now(), "seconds": round(time.monotonic() - started, 3),
            "endReason": reason, "exitCode": proc.poll(), "outputBytes": total,
            "trackedProcessIdentities": [{"pid": pid, "startTime": identity} for pid, identity in sorted(tracked.items())],
            "remainingProcessGroupIds": remaining, "remainingTrackedProcessIds": surviving_identities(tracked),
            "drainLimitReached": drain_limit_reached,
        })
        if site is not None:
            item["safeError"] = safe_stderr(buffers["stderr"], site)
        save()
        if remaining or item["remainingTrackedProcessIds"]:
            raise RuntimeError("owned_process_group_remains")
    return item


receipt = {"scope": "One real initialize only; no authentication/session/prompt; raw output never persisted.",
           "startedAt": now(), "commands": [], "status": "preflight"}
temp = None
owner = uuid4().hex
with RECEIPT.open("x", encoding="utf-8") as handle:
    json.dump(receipt, handle)
try:
    receipt["preflight"] = preflight()
    save()
    if not receipt["preflight"]["allowed"]:
        receipt["status"] = "preflight_changed_stopped"
    else:
        temp = Path(tempfile.mkdtemp(prefix="farfold-fast-agent-initialize-"))
        (temp / "probe-owner").write_text(owner, encoding="utf-8")
        cwd = temp / "cwd"
        cwd.mkdir()
        venv = temp / "venv"
        receipt.update({"taskTemp": str(temp), "cwd": str(cwd), "homePreserved": True})
        prefix = [str(UV), "--no-config", "--no-python-downloads", "--cache-dir", str(CACHE)]
        made = bounded_process(prefix + ["venv", "--offline", "--python", str(PYTHON), str(venv)], cwd, 30)
        if made["exitCode"] != 0:
            receipt["status"] = "venv_failed_no_probe"
        else:
            installed = bounded_process(prefix + ["pip", "install", "--offline", "--python", str(venv / "bin/python"), "fast-agent-acp==0.10.1"], cwd, 60)
            if installed["exitCode"] != 0:
                receipt["status"] = "offline_install_failed_no_probe"
            else:
                site = venv / "lib/python3.12/site-packages"
                versions = {}
                for metadata in site.glob("*.dist-info/METADATA"):
                    head = metadata.read_text(encoding="utf-8").split("\n\n", 1)[0]
                    name = re.search(r"(?m)^Name: ([A-Za-z0-9_.-]+)$", head)
                    version = re.search(r"(?m)^Version: ([A-Za-z0-9_.+-]+)$", head)
                    if name and version and name[1] in {"fast-agent-acp", "fast-agent-mcp", "agent-client-protocol"}:
                        versions[name[1]] = version[1]
                script = venv / "bin/fast-agent-acp"
                script_text = script.read_text(encoding="utf-8")
                entry_ok = "from fast_agent.cli.commands.acp import main" in script_text
                versions_ok = versions == {"fast-agent-acp": "0.10.1", "fast-agent-mcp": "0.10.1", "agent-client-protocol": "0.10.1"}
                receipt["packageCheck"] = {"versions": versions, "expectedEntrypoint": entry_ok}
                receipt["preLaunchPreflight"] = preflight(cwd)
                if not entry_ok or not versions_ok or not receipt["preLaunchPreflight"]["allowed"]:
                    receipt["status"] = "package_or_preflight_changed_stopped"
                else:
                    receipt["status"] = "probe_running"
                    save()
                    probe = bounded_process([str(script), "-x"], cwd, 60, initialize=True, site=site)
                    receipt["status"] = probe["endReason"]
except BaseException as exc:
    receipt["status"] = "orchestrator_error"
    receipt["orchestratorExceptionClass"] = type(exc).__name__ if type(exc).__name__ in ALLOWED_EXCEPTIONS else "unclassified"
finally:
    # Also covers failures while setting up selectors or writing the first receipt.
    for owned_process in OWNED_PROCESSES:
        stop_group(owned_process)
    if temp is not None:
        cwd = temp / "cwd"
        receipt["officialTaskDirectories"] = [
            str(path.relative_to(cwd)) for path in cwd.rglob("*")
            if path.is_dir() and not path.is_symlink()
        ]
        receipt["officialTaskWrites"] = [
            {"path": str(path.relative_to(cwd)), "bytes": path.stat().st_size}
            for path in cwd.rglob("*") if path.is_file() and not path.is_symlink()
        ]
        remaining = sorted(set(
            [pid for item in receipt["commands"] for pid in group_members(item["pid"])]
            + surviving_identities(TRACKED_IDENTITIES)
        ))
        cleanup_allowed = (
            not remaining and temp.parent.resolve() == Path(tempfile.gettempdir()).resolve()
            and (temp / "probe-owner").read_text(encoding="utf-8") == owner
            and temp.name.startswith("farfold-fast-agent-initialize-")
        )
        if cleanup_allowed:
            shutil.rmtree(temp)
        receipt["cleanup"] = {"exactPath": str(temp), "removed": not temp.exists(), "remainingOwnedProcessIds": remaining}
    receipt["finishedAt"] = now()
    save()
    print(json.dumps({"status": receipt["status"], "receipt": str(RECEIPT), "cleanup": receipt.get("cleanup")}))
