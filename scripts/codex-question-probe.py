#!/usr/bin/env python3
"""Fixed 0.143.0 native protocol test with a loopback-only scripted Provider.

This proves protocol behavior, NOT real-model or installed-Farfold availability.
Reference: openai/codex rust-v0.143.0 app-server/tests/suite/v2/request_user_input.rs
Run explicitly with --binary; never discovers, installs or imports authentication.
"""
import argparse
import contextlib
import gzip
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

VERSION = "codex-cli 0.143.0"
SHA256 = "9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f"
MAX_FRAME = 4 * 1024 * 1024


def sse(item, ident):
    frames = [
        {"type": "response.created", "response": {"id": ident}},
        {"type": "response.output_item.done", "output_index": 0, "item": item},
        {"type": "response.completed", "response": {"id": ident, "status": "completed", "output": []}},
    ]
    return "".join(f"event: {f['type']}\ndata: {json.dumps(f)}\n\n" for f in frames).encode()


def question(call_id):
    return sse({"type": "function_call", "id": f"fc_{call_id}", "call_id": call_id,
                "name": "request_user_input", "arguments": json.dumps({"questions": [{
                    "id": "direction", "header": "Direction", "question": "Which direction should this test use?",
                    "options": [{"label": "North", "description": "Use the northern route."},
                                {"label": "South", "description": "Use the southern route."}]}]})}, f"resp_{call_id}")


@contextlib.contextmanager
def provider():
    requests, failures = [], []
    responses = [question("question_1"), sse({"id": "answer_1", "type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "CODEX-NATIVE-QUESTION-ROUNDTRIP", "annotations": []}]}, "resp_answer"),
                 question("question_2")]

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                assert self.path == "/v1/responses", self.path
                count = int(self.headers.get("Content-Length", "0"))
                assert 0 < count <= MAX_FRAME
                body = self.rfile.read(count)
                if self.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                assert len(body) <= MAX_FRAME
                assert not self.headers.get("Authorization"), "test must have no credentials"
                requests.append(json.loads(body))
                assert responses, "unexpected extra model request"
                data = responses.pop(0)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as error:
                failures.append(str(error))
                self.send_error(500)

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 10
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server.server_address[1], requests, failures
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


class AppServer:
    def __init__(self, binary, state, cwd, experimental):
        self.queue = queue.Queue(maxsize=4096)
        self.pending, self.events = [], []
        self.ident = 0
        env = {"HOME": str(state.parent / "home"), "CODEX_HOME": str(state),
               "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": str(state.parent)}
        self.error_file = (state.parent / "stderr.log").open("w")
        self.child = subprocess.Popen([str(binary), "app-server"], cwd=cwd, env=env,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=self.error_file)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            self.request("initialize", {"clientInfo": {"name": "farfold_native_question_probe", "version": "0.1.6"},
                                      "capabilities": {"experimentalApi": experimental}})
            self.write({"method": "initialized", "params": {}})
        except BaseException:
            self.close()
            raise

    def _read(self):
        try:
            while True:
                line = self.child.stdout.readline(MAX_FRAME + 1)
                if not line:
                    raise EOFError("native app server closed stdout")
                if len(line) > MAX_FRAME or not line.endswith(b"\n"):
                    raise ValueError("oversized or incomplete native frame")
                self.queue.put(json.loads(line), timeout=1)
        except Exception as error:
            try:
                self.queue.put(error, timeout=1)
            except queue.Full:
                pass

    def write(self, frame):
        self.child.stdin.write(json.dumps(frame).encode() + b"\n")
        self.child.stdin.flush()

    def wait(self, predicate, timeout=20):
        for i, frame in enumerate(self.pending):
            if predicate(frame):
                return self.pending.pop(i)
        deadline = time.monotonic() + timeout
        while True:
            frame = self.queue.get(timeout=max(.01, deadline - time.monotonic()))
            if isinstance(frame, Exception):
                raise frame
            if len(self.events) >= 4096:
                raise ValueError("native event budget exceeded")
            self.events.append(frame)
            if predicate(frame):
                return frame
            self.pending.append(frame)

    def request(self, method, params, error=False):
        self.ident += 1
        ident = f"host_{self.ident}"
        self.write({"id": ident, "method": method, "params": params})
        frame = self.wait(lambda f: f.get("id") == ident and "method" not in f)
        if error:
            return frame["error"]
        assert "error" not in frame, frame
        return frame["result"]

    def notification(self, method, **ids):
        return self.wait(lambda f: f.get("method") == method and "id" not in f
                         and all(f.get("params", {}).get(k) == v for k, v in ids.items()))["params"]

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)
        self.reader.join(timeout=2)
        self.child.stdout.close()
        self.error_file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def run(binary):
    binary = binary.resolve(strict=True)
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == SHA256, "unsupported native build"
    version = subprocess.check_output([str(binary), "--version"], timeout=5, text=True).strip()
    assert version == VERSION, version
    record = {"binary": str(binary), "version": version, "sha256": SHA256,
              "evidenceLayer": "real native App Server with loopback scripted Provider; no real model or Farfold UI"}
    with tempfile.TemporaryDirectory(prefix="farfold-codex-question-") as tmp, provider() as (port, requests, failures):
        root = Path(tmp).resolve()
        state, cwd = root / "codex", root / "project"
        for path in (root / "home", state, cwd):
            path.mkdir(mode=0o700)
        config = state / "config.toml"
        config.write_text(f'''cli_auth_credentials_store = "file"
model = "farfold-protocol-fixture"
model_provider = "farfold_fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
[features]
default_mode_request_user_input = false
[model_providers.farfold_fixture]
name = "Farfold loopback protocol test only"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
''')
        config.chmod(0o600)
        mode = {"mode": "plan", "settings": {"model": "farfold-protocol-fixture", "developer_instructions": None}}
        with AppServer(binary, state, cwd, False) as app:
            rejected = app.request("turn/start", {"threadId": "00000000-0000-0000-0000-000000000000",
                                   "input": [], "collaborationMode": mode}, error=True)
            assert rejected["message"] == "turn/start.collaborationMode requires experimentalApi capability"
            record["stableRejection"] = rejected
        with AppServer(binary, state, cwd, True) as app:
            presets = app.request("collaborationMode/list", {})["data"]
            assert any(p.get("mode") == "plan" for p in presets)
            feature = next(f for f in app.request("experimentalFeature/list", {"limit": 100})["data"]
                           if f["name"] == "default_mode_request_user_input")
            assert feature["enabled"] is False
            record["defaultModeFeature"] = feature
            started = app.request("thread/start", {"cwd": str(cwd), "sandbox": "read-only", "approvalPolicy": "on-request"})
            thread_id = started["thread"]["id"]
            assert Path(started["thread"]["cwd"]).resolve() == cwd
            turn = app.request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "Run the question protocol check."}], "collaborationMode": mode})["turn"]
            req = app.wait(lambda f: f.get("method") == "item/tool/requestUserInput" and "id" in f)
            params = req["params"]
            assert (params["threadId"], params["turnId"], params["itemId"]) == (thread_id, turn["id"], "question_1")
            assert params["questions"][0]["id"] == "direction"
            answer = {"answers": {"direction": {"answers": ["North"]}}}
            app.write({"id": req["id"], "result": answer})
            resolved = app.notification("serverRequest/resolved", threadId=thread_id, requestId=req["id"])
            completed = app.notification("turn/completed", threadId=thread_id)
            assert completed["turn"]["status"] == "completed", completed
            assert len(requests) == 2 and not failures, failures
            outputs = [i for i in requests[1]["input"] if i.get("type") == "function_call_output" and i.get("call_id") == "question_1"]
            assert len(outputs) == 1 and json.loads(outputs[0]["output"]) == answer, outputs
            record["roundTrip"] = {"request": req, "resolved": resolved, "turn": completed["turn"]}
            history = app.request("thread/read", {"threadId": thread_id, "includeTurns": True})["thread"]
            record["historyTurnIds"] = [t["id"] for t in history["turns"]]
        with AppServer(binary, state, cwd, True) as app:
            resumed = app.request("thread/resume", {"threadId": thread_id})["thread"]
            assert resumed["id"] == thread_id and Path(resumed["cwd"]).resolve() == cwd
            assert [t["id"] for t in resumed["turns"]] == record["historyTurnIds"]
            turn = app.request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "Check interruption while a question is pending."}], "collaborationMode": mode})["turn"]
            req = app.wait(lambda f: f.get("method") == "item/tool/requestUserInput" and "id" in f)
            assert req["params"]["turnId"] == turn["id"] and req["params"]["itemId"] == "question_2"
            app.request("turn/interrupt", {"threadId": thread_id, "turnId": turn["id"]})
            resolved = app.notification("serverRequest/resolved", threadId=thread_id, requestId=req["id"])
            completed = app.notification("turn/completed", threadId=thread_id)
            assert completed["turn"]["status"] == "interrupted", completed
            app.write({"id": req["id"], "result": answer})
            # A later correlated read fences processing of the stale reply; it must not restart work.
            after = app.request("thread/read", {"threadId": thread_id, "includeTurns": True})["thread"]
            assert after["turns"][-1]["status"] == "interrupted", after["turns"][-1]
            assert len(requests) == 3 and not failures, failures
            record["coldResume"] = {"threadId": thread_id, "cwdMatches": True, "turnIdsMatch": True}
            record["interrupt"] = {"request": req, "resolved": resolved, "turn": completed["turn"], "staleReplyDidNotResume": True}
        record["scriptedProviderRequests"] = len(requests)
        assert not (state / "auth.json").exists()
    record["temporaryEnvironmentRemoved"] = not Path(tmp).exists()
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = run(args.binary)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("version", "evidenceLayer", "scriptedProviderRequests", "coldResume", "temporaryEnvironmentRemoved")}, ensure_ascii=False, indent=2))
