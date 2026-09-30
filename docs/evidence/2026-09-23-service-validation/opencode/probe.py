"""Bounded OpenCode configuration/routing check; controlled HTTP service only.

Reuses the existing real ACP Probe. No Keychain lookup, user config writes,
production code edits, or public model service requests. Fixture keys live only
in memory. Native test sessions are new and confined to this evidence cwd.
"""
import asyncio
import datetime
import getpass
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "existing_probe", ROOT.parents[1] / "2026-09-21-acceptance-fixes/probe.py"
)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.ROOT = ROOT
RESPONSES = "--responses" in sys.argv
RUN = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ("-responses" if RESPONSES else "")
REPORT = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "evidence_layer": "real OpenCode ACP + controlled local HTTP service",
    "real_model_success": False,
    "run": RUN,
    "phases": [],
}


def save():
    (ROOT / (RUN + "-result.json")).write_text(
        json.dumps(REPORT, ensure_ascii=False, indent=2) + "\n"
    )


class Probe(base.Probe):
    """Keep ACP implementation; use exact child/process-group ownership to close."""

    async def read(self):
        original = self.proc.stdout
        self.session_text = {}

        async def observed_lines():
            async for line in original:
                try:
                    message = json.loads(line)
                    if await self.observe(message):
                        continue
                    params = message.get("params", {})
                    update = params.get("update", {})
                    if update.get("sessionUpdate") == "agent_message_chunk":
                        sid = params.get("sessionId")
                        self.session_text[sid] = self.session_text.get(sid, "") + update.get("content", {}).get("text", "")
                except (ValueError, UnicodeDecodeError):
                    pass
                yield line

        self.proc.stdout = observed_lines()
        try:
            await super().read()
        finally:
            self.proc.stdout = original

    async def observe(self, message):
        if not RESPONSES:
            return False
        params = message.get("params", {})
        if message.get("method") == "session/request_permission":
            call = params.get("toolCall", {})
            command = call.get("rawInput", {}).get("command")
            safe = getattr(self, "safe_commands", {})
            expected = safe.get(params.get("sessionId"))
            option = next((o for o in params.get("options", []) if o.get("kind") == "allow_once"), None)
            allowed = expected is not None and command == expected and option is not None and params.get("sessionId") not in getattr(self, "approved_sessions", set())
            if not hasattr(self, "approved_sessions"):
                self.approved_sessions = set()
                self.approved_calls = set()
                self.completed_calls = set()
            if allowed:
                self.approved_sessions.add(params["sessionId"])
                self.approved_calls.add(call.get("toolCallId"))
                outcome = {"outcome": "selected", "optionId": option["optionId"]}
            else:
                outcome = {"outcome": "cancelled"}
            await self.send({"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": outcome}})
            self.note(permission_exact_safe_command=allowed)
            return True
        update = params.get("update", {})
        if update.get("sessionUpdate") in ("tool_call", "tool_call_update"):
            if update.get("toolCallId") in getattr(self, "approved_calls", set()) and update.get("status") == "completed":
                if "FARFOLD_RESPONSES_TOOL_" in json.dumps(update.get("content", [])):
                    self.completed_calls.add(update["toolCallId"])
                    self.note(controlled_tool_completed=True)
        return False

    async def close(self):
        if self.proc.returncode is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(self.proc.wait(), 2)
            except asyncio.TimeoutError:
                os.killpg(self.proc.pid, signal.SIGKILL)
                await asyncio.wait_for(self.proc.wait(), 3)
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)
        processes = subprocess.check_output(["ps", "-axo", "pid=,pgid="], text=True)
        self.group_survivors = [int(row.split()[0]) for row in processes.splitlines() if int(row.split()[1]) == self.proc.pid]
        self.note(process_reaped=self.proc.returncode is not None, owned_process_group_survivors=self.group_survivors)
        (ROOT / (self.name + ".json")).write_text(
            json.dumps({"events": self.events, "counts": dict(self.counts)}, indent=2)
            + "\n"
        )


class Fixture:
    def __init__(self):
        self.keys = {name: secrets.token_urlsafe(24) for name in ("a", "b")}
        self.phase = "new"
        self.started = set()
        self.barrier = asyncio.Event()
        self.records = []
        self.active = 0
        self.max_active = 0
        self.receipts = {}
        self.tasks = set()
        self.request_counts = {}

    @staticmethod
    def tool_marker(route):
        return f"FARFOLD_RESPONSES_TOOL_{route.upper()}_{RUN}"

    @classmethod
    def tool_command(cls, route):
        return "printf '" + cls.tool_marker(route) + "\\n'"

    def responses_body(self, route, data):
        tool_output = any(self.tool_marker(route) in str(item.get("output", "")) for item in data.get("input", []) if isinstance(item, dict) and item.get("type") == "function_call_output")
        call_tool = self.phase == "tool" and not tool_output
        response_id = "resp_" + route + "_" + self.phase + "_" + str(self.request_counts[(self.phase, route)])
        if call_tool:
            if not any(t.get("name") == "bash" for t in data.get("tools", [])):
                raise ValueError("bash_tool_not_advertised")
            item = {"type": "function_call", "id": "fc_" + route, "call_id": "call_" + route,
                    "name": "bash", "arguments": json.dumps({"command": self.tool_command(route), "description": "Controlled transport check"}), "status": "completed"}
        else:
            receipt = f"CONTROLLED_{route.upper()}_{self.phase.upper()}_{secrets.token_hex(4)}"
            self.receipts[(self.phase, route)] = receipt
            item = {"id": "msg_" + route, "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": receipt, "annotations": []}]}
        response = {"id": response_id, "object": "response", "created_at": int(time.time()), "status": "completed", "model": data["model"], "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
        events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}]
        if call_tool:
            events.extend([
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "arguments": "", "status": "in_progress"}},
                {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]},
                {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]},
            ])
        else:
            events.extend([
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
                {"type": "response.content_part.added", "item_id": item["id"], "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}},
                {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": receipt},
                {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": receipt},
                {"type": "response.content_part.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "part": item["content"][0]},
            ])
        events.extend([{"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": response}])
        return "".join("event: " + e["type"] + "\ndata: " + json.dumps({**e, "sequence_number": i}) + "\n\n" for i, e in enumerate(events)).encode()

    def reset(self, phase):
        self.phase = phase
        self.started.clear()
        self.barrier = asyncio.Event()
        self.max_active = 0

    async def handle(self, reader, writer):
        self.tasks.add(asyncio.current_task())
        started = time.monotonic()
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = header.decode().split("\r\n")
            method, path, _ = lines[0].split(" ", 2)
            headers = dict(
                (k.lower(), v.strip()) for k, v in
                (line.split(":", 1) for line in lines[1:] if ":" in line)
            )
            length = int(headers.get("content-length", "0"))
            if length > 2 ** 20:
                raise ValueError("fixture_body_limit")
            data = json.loads(await asyncio.wait_for(reader.readexactly(length), 10))
            route = path.split("/")[1]
            expected_path = "responses" if RESPONSES else "chat/completions"
            if route not in self.keys or method != "POST" or path != f"/{route}/v1/{expected_path}":
                raise ValueError("unexpected_fixture_route")
            authorized = headers.get("authorization") == "Bearer " + self.keys[route]
            encoded = json.dumps(data)
            prompt_marker = f"FARFOLD_{route.upper()}_{self.phase.upper()}_{RUN}"
            other = "b" if route == "a" else "a"
            record = {
                "phase": self.phase,
                "route": route,
                "method": method,
                "path": path,
                "model": data.get("model"),
                "key_matches_route": authorized,
                "expected_prompt_marker": prompt_marker in encoded,
                "other_service_prompt_present": f"FARFOLD_{other.upper()}_" in encoded,
                "prior_receipt_present": self.receipts.get(("new", route), "no-prior") in encoded,
                "stream": data.get("stream"),
                "tool_names": [tool.get("name") for tool in data.get("tools", [])],
                "own_tool_output_present": any(self.tool_marker(route) in str(item.get("output", "")) for item in data.get("input", []) if isinstance(item, dict) and item.get("type") == "function_call_output"),
                "other_tool_output_present": self.tool_marker(other) in encoded,
            }
            count_key = (self.phase, route)
            self.request_counts[count_key] = self.request_counts.get(count_key, 0) + 1
            record["request_number"] = self.request_counts[count_key]
            if record["request_number"] > (2 if self.phase == "tool" else 1):
                raise ValueError("unexpected_repeated_fixture_request")
            self.records.append(record)
            if not authorized or not record["expected_prompt_marker"]:
                raise ValueError("fixture_auth_or_prompt_mismatch")
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.started.add(route)
            if self.started == {"a", "b"}:
                self.barrier.set()
            await asyncio.wait_for(self.barrier.wait(), 15)
            if RESPONSES:
                body = self.responses_body(route, data)
            else:
                receipt = f"CONTROLLED_{route.upper()}_{self.phase.upper()}_{secrets.token_hex(4)}"
                self.receipts[(self.phase, route)] = receipt
                chunks = [
                    {"id": "fixture-" + route, "object": "chat.completion.chunk", "created": int(time.time()), "model": data["model"], "choices": [{"index": 0, "delta": {"role": "assistant", "content": receipt}, "finish_reason": None}]},
                    {"id": "fixture-" + route, "object": "chat.completion.chunk", "created": int(time.time()), "model": data["model"], "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
                ]
                body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                body += "data: [DONE]\n\n"
                body = body.encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
            self.active -= 1
            record["completed"] = True
            record["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        except Exception as exc:
            self.records.append({"phase": self.phase, "fixture_error": type(exc).__name__})
        finally:
            writer.close()
            await writer.wait_closed()
            self.tasks.discard(asyncio.current_task())


async def rpc(probe, method, params, ident, seconds=45):
    await probe.acp(method, params, ident)
    response = await probe.response(ident, seconds)
    if not response or "result" not in response:
        raise RuntimeError(f"{method}:" + str((response or {}).get("error", {}).get("code", "timeout")))
    return response["result"]


def model_option(result):
    return next((o for o in result.get("configOptions", []) if o.get("category") == "model" or o.get("id") == "model"), {})


def option_values(options):
    values = []
    for option in options:
        if "value" in option:
            values.append(option["value"])
        values.extend(option_values(option.get("options", [])))
    return values


async def main():
    with sqlite3.connect("file:" + str(base.DB) + "?mode=ro", uri=True) as db:
        command, args, saved_env = db.execute("SELECT command,args,env FROM agents WHERE id='opencode'").fetchone()
    REPORT["real_service_precondition"] = {"keychain_read": False, "public_model_requests": False, "result": "controlled local service only"}
    REPORT["launch"] = {"command": command, "args": json.loads(args)}
    env = dict(os.environ)
    env.update(json.loads(saved_env))
    if any(str(value).startswith("__keychain__") for value in env.values()):
        raise RuntimeError("unresolved_keychain_reference")
    fixture = Fixture()
    server = await asyncio.start_server(fixture.handle, "127.0.0.1", 0, limit=2**21)
    port = server.sockets[0].getsockname()[1]
    providers = {}
    for name in ("a", "b"):
        provider_id = "farfold-controlled-" + name
        env_name = "FARFOLD_CONTROLLED_KEY_" + name.upper()
        env[env_name] = fixture.keys[name]
        providers[provider_id] = {
            "npm": "@ai-sdk/openai" if RESPONSES else "@ai-sdk/openai-compatible",
            "name": "Farfold controlled " + name.upper(),
            "options": {"baseURL": f"http://127.0.0.1:{port}/{name}/v1", "apiKey": "{env:" + env_name + "}"},
            "models": {"shared-model-id": {"name": "Controlled model " + name.upper(), "limit": {"context": 32000, "output": 1024}}},
        }
        if RESPONSES:
            # Match the production compiler's minimal model entry exactly.
            providers[provider_id]["models"]["shared-model-id"].pop("limit")
    config = {"provider": providers, "agent": {"title": {"disable": True}}, "permission": {"*": "deny", "bash": "ask"} if RESPONSES else "deny", "compaction": {"auto": False}}
    if RESPONSES:
        config["model"] = "farfold-controlled-a/shared-model-id"
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    REPORT["configuration"] = {"mechanism": "OPENCODE_CONFIG_CONTENT", "providers": list(providers), "api": "Responses" if RESPONSES else "Chat Completions", "provider_definitions": providers, "process_default_model": config.get("model"), "key_reference": "environment only", "user_default_model_changed": False, "fixture_port": port}
    (ROOT / (RUN + "-project")).mkdir(exist_ok=True)
    cwd = str(ROOT / (RUN + "-project"))
    sessions = {}
    try:
        for phase in ("new", "load"):
            fixture.reset(phase)
            probe = Probe(RUN + "-" + phase)
            result = {"phase": phase, "sessions": []}
            REPORT["phases"].append(result)
            try:
                await probe.start([command, *json.loads(args)], env)
                init = await rpc(probe, "initialize", {"protocolVersion": 1, "clientInfo": {"name": "farfold-service-validation", "version": "1"}, "clientCapabilities": {}}, 1)
                REPORT["agent_info"] = init.get("agentInfo")
                if RESPONSES and init.get("agentInfo", {}).get("version") != "1.18.31":
                    raise RuntimeError("unexpected_agent_version_no_prompt_sent")
                for index, name in enumerate(("a", "b")):
                    selected = "farfold-controlled-" + name + "/shared-model-id"
                    params = {"cwd": cwd, "mcpServers": []}
                    if phase == "load":
                        params["sessionId"] = sessions[name]
                    opened = await rpc(probe, "session/" + phase, params, 10 + index)
                    if phase == "new":
                        sessions[name] = opened["sessionId"]
                    option = model_option(opened)
                    offered = option_values(option.get("options", []))
                    row = {"service": name, "session_id": sessions[name], "provider_model_offered": selected in offered, "opened_model": option.get("currentValue")}
                    result["sessions"].append(row)
                    if phase == "new":
                        if RESPONSES:
                            row["process_default_model_applied"] = option.get("currentValue") == config["model"]
                            if not row["process_default_model_applied"]:
                                raise RuntimeError("startup_model_not_applied_no_prompt_sent")
                        if RESPONSES and name == "a":
                            row["selected_without_config_rpc"] = True
                            row["selected_model"] = option.get("currentValue")
                        else:
                            changed = await rpc(probe, "session/set_config_option", {"sessionId": sessions[name], "configId": option["id"], "value": selected}, 20 + index)
                            row["selected_model"] = model_option(changed).get("currentValue")
                        if row["selected_model"] != selected:
                            raise RuntimeError("selection_mismatch_no_prompt_sent")
                    else:
                        row["restored_same_source"] = option.get("currentValue") == selected
                        if not row["restored_same_source"]:
                            raise RuntimeError("restored_model_drift_no_continuation")
                responses = await asyncio.gather(*(rpc(probe, "session/prompt", {"sessionId": sessions[name], "prompt": [{"type": "text", "text": f"Reply only FARFOLD_{name.upper()}_{phase.upper()}_{RUN}. Do not call tools or inspect files."}]}, 30 + index, 60) for index, name in enumerate(("a", "b"))))
                result["stop_reasons"] = [r.get("stopReason") for r in responses]
                result["concurrent_service_requests"] = fixture.max_active
                result["receipts_delivered"] = {name: fixture.receipts.get((phase, name), "absent") in probe.session_text.get(sessions[name], "") for name in ("a", "b")}
                result["other_session_receipt_present"] = {name: fixture.receipts.get((phase, "b" if name == "a" else "a"), "absent") in probe.session_text.get(sessions[name], "") for name in ("a", "b")}
                observations = [r for r in fixture.records if r["phase"] == phase]
                result["passed"] = (
                    all(result["receipts_delivered"].values())
                    and not any(result["other_session_receipt_present"].values())
                    and fixture.max_active == 2
                    and len(observations) == 2
                    and all(r.get("key_matches_route") and r.get("expected_prompt_marker") and not r.get("other_service_prompt_present") and r.get("completed") for r in observations)
                    and all(r["provider_model_offered"] for r in result["sessions"])
                    and (phase == "new" or all(r.get("prior_receipt_present") for r in observations))
                    and all(reason == "end_turn" for reason in result["stop_reasons"])
                )
                if RESPONSES and phase == "load":
                    result["cold_tool_history_preserved"] = all(r.get("own_tool_output_present") and not r.get("other_tool_output_present") for r in observations)
                    result["passed"] = result["passed"] and result["cold_tool_history_preserved"]
                if RESPONSES and phase == "new" and result["passed"]:
                    fixture.reset("tool")
                    probe.safe_commands = {sessions[name]: fixture.tool_command(name) for name in ("a", "b")}
                    done = await asyncio.gather(*(rpc(probe, "session/prompt", {"sessionId": sessions[name], "prompt": [{"type": "text", "text": f"FARFOLD_{name.upper()}_TOOL_{RUN}. Run exactly {fixture.tool_command(name)} once. Do not run another command or inspect files, settings, credentials, or network."}]}, 40 + index, 60) for index, name in enumerate(("a", "b"))))
                    tool_records = [r for r in fixture.records if r["phase"] == "tool"]
                    tool_result = {
                        "stop_reasons": [r.get("stopReason") for r in done],
                        "approved_exact_commands": len(getattr(probe, "approved_sessions", set())),
                        "completed_exact_tools": len(getattr(probe, "completed_calls", set())),
                        "concurrent_service_requests": fixture.max_active,
                        "requests": len(tool_records),
                        "outputs_received_by_own_service": sum(bool(r.get("own_tool_output_present")) for r in tool_records),
                        "other_service_output_present": any(r.get("other_tool_output_present") for r in tool_records),
                        "receipts_delivered": {name: fixture.receipts.get(("tool", name), "absent") in probe.session_text.get(sessions[name], "") for name in ("a", "b")},
                        "other_session_receipt_present": {name: fixture.receipts.get(("tool", "b" if name == "a" else "a"), "absent") in probe.session_text.get(sessions[name], "") for name in ("a", "b")},
                    }
                    tool_result["passed"] = len(tool_records) == 4 and tool_result["approved_exact_commands"] == 2 and tool_result["completed_exact_tools"] == 2 and tool_result["outputs_received_by_own_service"] == 2 and not tool_result["other_service_output_present"] and all(tool_result["receipts_delivered"].values()) and not any(tool_result["other_session_receipt_present"].values()) and all(r.get("key_matches_route") and r.get("completed") and not r.get("other_service_prompt_present") for r in tool_records) and all(reason == "end_turn" for reason in tool_result["stop_reasons"])
                    result["tool"] = tool_result
                    result["passed"] = result["passed"] and tool_result["passed"]
            except Exception as exc:
                result["error"] = str(exc)
                result["passed"] = False
            finally:
                if hasattr(probe, "proc"):
                    await probe.close()
                    result["process_reaped"] = probe.proc.returncode is not None
                    result["owned_process_group_survivors"] = probe.group_survivors
                    if probe.group_survivors:
                        result["passed"] = False
                result["protocol_failures"] = [event["structured_failure"] for event in probe.events if "structured_failure" in event]
                if result["protocol_failures"]:
                    result["passed"] = False
                REPORT["http_observations"] = fixture.records
                save()
            if not result.get("passed"):
                break
    finally:
        server.close()
        await server.wait_closed()
        for task in list(fixture.tasks):
            task.cancel()
        await asyncio.gather(*list(fixture.tasks), return_exceptions=True)
        REPORT["passed"] = len(REPORT["phases"]) == 2 and all(p.get("passed") for p in REPORT["phases"])
        save()
        print(json.dumps({"evidence": str(ROOT / (RUN + "-result.json")), "passed": REPORT["passed"], "phases": [{k: p.get(k) for k in ("phase", "passed", "error")} for p in REPORT["phases"]]}), flush=True)


if __name__ == "__main__":
    if "--real-atria" in sys.argv:
        # Import only the optional real-service path; credentials never enter argv.
        from real_atria import run
        key = getpass.getpass("Atria test Key: ") if sys.stdin.isatty() else sys.stdin.readline().strip()
        if not key or len(key) > 16384 or any(ord(c) < 32 for c in key):
            raise SystemExit("Invalid test credential input")
        asyncio.run(asyncio.wait_for(run(sys.modules[__name__], key), 360))
    else:
        asyncio.run(asyncio.wait_for(main(), 240))
