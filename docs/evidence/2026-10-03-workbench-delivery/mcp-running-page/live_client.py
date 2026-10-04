"""Single controlled live run against an already-running synthetic native page.

Creates two anonymous authorization pipes and one host-only control pipe.
Capability bytes never appear in argv, environment, MCP, evidence or diagnostics.
"""
import json
import os
import secrets
import select
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from page_server import PROTOCOL_VERSION, SCOPE

ROOT = Path(__file__).resolve().parent
NATIVE = ROOT.parent / "browser-running-page-probe" / "running-page-probe"


class JsonLines:
    def __init__(self, stream):
        self.stream = stream
        self.buffer = bytearray()

    def read(self, timeout=20):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.stream], [], [], remaining)[0]:
                raise RuntimeError("controlled response deadline exceeded")
            chunk = os.read(self.stream.fileno(), 4096)
            if not chunk:
                raise RuntimeError("controlled process ended before response")
            self.buffer.extend(chunk)
            if len(self.buffer) > 65536:
                raise RuntimeError("controlled response too large")
        line, _, rest = self.buffer.partition(b"\n")
        self.buffer = bytearray(rest)
        return json.loads(line)


def stop(process):
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    run_id = "running-mcp-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    evidence_path = ROOT / (run_id + ".json")
    log = {"kind": "controlled-MCP-to-same-running-real-native-page", "runId": run_id,
           "realAgent": False, "productionSharing": False, "pass": False,
           "mcpRequests": [], "mcpResponses": [], "hostEvents": [], "hostBoundaryChecks": []}
    capability = secrets.token_hex(32)
    native = shim = None
    control_writer = None
    with evidence_path.open("x") as evidence, tempfile.TemporaryDirectory(prefix="p-", dir=ROOT) as directory:
        socket_path = Path(directory) / "s"
        assert stat.S_IMODE(Path(directory).stat().st_mode) == 0o700
        control_reader, control_writer = os.pipe()
        try:
            native = subprocess.Popen([str(NATIVE), str(socket_path), str(control_reader)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                pass_fds=(control_reader,), bufsize=0)
            os.close(control_reader)
            native.stdin.write((capability + "\n").encode())
            native.stdin.close()
            native_lines = JsonLines(native.stdout)

            def event(expected):
                result = native_lines.read(timeout=25)
                # Only explicit synthetic fixture metadata can enter evidence.
                safe = {key: result[key] for key in ("event", "instanceId", "revision", "readId",
                    "nativeCreateCount", "nativeReadCount", "sameNativeInstance", "ephemeral") if key in result}
                log["hostEvents"].append(safe)
                assert result.get("event") == expected, "unexpected controlled host event"
                return result

            ready = event("ready")
            instance_id = ready["instanceId"]
            assert ready["sameNativeInstance"] is True and ready["ephemeral"] is True
            assert socket_path.is_socket()
            assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
            assert socket_path.stat().st_uid == os.getuid()
            log["localTransport"] = {"kind": "AF_UNIX", "directoryMode": "0700", "socketMode": "0600",
                "sameOwner": True, "capabilityHandoff": "anonymous pipes only", "nativeStarts": 1}

            def control(command):
                assert command in {"mutate", "hold-next-read", "revoke", "close", "quit"}
                os.write(control_writer, (command + "\n").encode())

            def direct_boundary(name, changes, expected_error):
                request = {"op": "snapshot", "requestId": run_id + "-boundary", **SCOPE,
                           "capability": capability, **changes}
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(12)
                    connection.connect(str(socket_path))
                    connection.sendall(json.dumps(request).encode() + b"\n")
                    with connection.makefile("rb") as stream:
                        result = json.loads(stream.readline(65537))
                # Never record request or arbitrary fields: request contains auth.
                assert result.get("ok") is False and "text" not in result
                assert result.get("error") == expected_error
                log["hostBoundaryChecks"].append({"name": name, "rejected": True,
                    "error": result.get("error")})

            direct_boundary("server_rejects_wrong_capability", {"capability": "0" * 64}, "UNAUTHORIZED")
            direct_boundary("server_rejects_wrong_scope", {"taskKey": "not-granted"}, "SCOPE_MISMATCH")

            auth_reader, auth_writer = os.pipe()
            shim = subprocess.Popen([sys.executable, str(ROOT / "page_server.py"), str(socket_path), str(auth_reader)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                pass_fds=(auth_reader,), bufsize=0)
            os.close(auth_reader)
            os.write(auth_writer, (capability + "\n").encode())
            os.close(auth_writer)
            shim_lines = JsonLines(shim.stdout)

            def send(method, params=None, request_id=None):
                message = {"jsonrpc": "2.0", "method": method}
                if params is not None:
                    message["params"] = params
                if request_id is not None:
                    message["id"] = request_id
                log["mcpRequests"].append({"atMs": int(time.time() * 1000), "message": message})
                shim.stdin.write((json.dumps(message) + "\n").encode())
                return request_id

            def receive(request_id):
                response = shim_lines.read()
                assert response.get("id") == request_id and response.get("jsonrpc") == "2.0"
                log["mcpResponses"].append({"atMs": int(time.time() * 1000), "message": response})
                return response

            def call(request_id, **changes):
                args = {"requestId": run_id + "-" + str(request_id), **SCOPE, **changes}
                send("tools/call", {"name": "read_page_snapshot", "arguments": args}, request_id)
                return receive(request_id)["result"]

            send("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                 "clientInfo": {"name": "farfold-running-page-controlled-client", "version": "0.0.0"}}, 1)
            assert receive(1)["result"]["protocolVersion"] == PROTOCOL_VERSION
            send("notifications/initialized")
            send("tools/list", {}, 2)
            tools = receive(2)["result"]["tools"]
            assert [tool["name"] for tool in tools] == ["read_page_snapshot"]
            assert call(3, taskKey="not-granted")["isError"] is True
            assert call(4, generation=0)["isError"] is True

            first = call(5)
            assert first["isError"] is False
            first_page = first["structuredContent"]
            assert first_page["instanceId"] == instance_id
            assert first_page["text"] == "Running page version one"
            assert first_page["revision"] == 1 and first_page["nativeReadCount"] == 1
            assert first_page["nativeCreateCount"] == 1
            control("mutate")
            mutation = event("mutated")
            assert mutation["instanceId"] == instance_id
            assert mutation["sameNativeInstance"] is True
            second = call(6)
            assert second["isError"] is False
            second_page = second["structuredContent"]
            assert second_page["instanceId"] == instance_id
            assert second_page["text"] == "Running page version two"
            assert second_page["revision"] == 2 and second_page["nativeReadCount"] == 2
            assert second_page["nativeCreateCount"] == 1
            assert second_page["readId"] != first_page["readId"]
            for result in (first, second):
                assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
                assert "SYNTHETIC_SECRET_INPUT" not in result["structuredContent"]["text"]
            log["sameRunningPage"] = {"instanceId": instance_id, "nativeStarts": 1,
                "nativeCreateCount": 1, "firstRevision": 1, "secondRevision": 2,
                "firstReadCount": 1, "secondReadCount": 2, "bodyChangedInPlace": True}

            control("hold-next-read")
            event("hold-armed")
            send("tools/call", {"name": "read_page_snapshot",
                "arguments": {"requestId": run_id + "-7", **SCOPE}}, 7)
            held = event("held")
            assert held["instanceId"] == instance_id and held["nativeReadCount"] == 3
            control("revoke")
            event("revoked")
            late = receive(7)["result"]
            assert late["isError"] is True and "structuredContent" not in late
            assert call(8)["isError"] is True
            control("close")
            closed = event("closed")
            assert closed["nativeCreateCount"] == 1 and closed["nativeReadCount"] == 3
            assert call(9)["isError"] is True
            direct_boundary("server_closed_gate_after_revoke", {}, "CLOSED")
            control("quit")
            finished = event("finished")
            assert finished["nativeCreateCount"] == 1 and finished["nativeReadCount"] == 3
            log["lateResult"] = {"realNativeReadCount": 3, "heldBeforeSend": True,
                "revokeDiscardedUnsentContent": True, "doesNotRecallSentContent": True,
                "postRevokeRejected": True, "postCloseRejected": True, "recreated": False}
            assert native.wait(timeout=5) == 0
            shim.stdin.close()
            assert shim.wait(timeout=5) == 0
            log["pass"] = True
        finally:
            if control_writer is not None:
                os.close(control_writer)
            stop(shim)
            stop(native)
            serialized = json.dumps(log, ensure_ascii=False, indent=2)
            if capability in serialized:
                log["pass"] = False
                serialized = json.dumps({"pass": False, "error": "evidence withheld"})
            evidence.write(serialized + "\n")
    print(json.dumps({"pass": log["pass"], "evidence": str(evidence_path)}))


if __name__ == "__main__":
    main()
