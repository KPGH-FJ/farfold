"""Optional explicitly authorized Atria validation. No secrets are serialized."""
import json
import os
import sqlite3


async def run(base, key):
    provider = "farfold-atria-validation-" + base.RUN
    model = "Atria-Dawn-Preview"
    selected = provider + "/" + model
    marker = "FARFOLD_ATRIA_TEXT_" + base.RUN
    tool_marker = "FARFOLD_ATRIA_TOOL_OK"
    safe_command = "printf '" + tool_marker + "\\n'"
    report = base.REPORT
    report.update({
        "evidence_layer": "real OpenCode ACP + user-authorized Atria service",
        "endpoint": "https://api.atria-asi.ai/v1",
        "api": "Chat Completions",
        "model": model,
        "provider_id": provider,
        "probe_prompt_limit": 3,
        "probe_auto_retry": False,
        "agent_internal_http_retry": "Official Agent behavior; not disabled or claimed single-attempt",
        "secret_source": "runtime stdin/getpass only; no Keychain access",
        "tool_command": safe_command,
    })

    class RealProbe(base.Probe):
        def __init__(self, name):
            super().__init__(name)
            self.approved_tools = set()
            self.tool_completed = False
            self.denied_count = 0

        async def observe(self, message):
            params = message.get("params", {})
            if message.get("method") == "session/request_permission":
                call = params.get("toolCall", {})
                command = call.get("rawInput", {}).get("command")
                option = next((o for o in params.get("options", []) if o.get("kind") == "allow_once"), None)
                allowed = command == safe_command and option is not None and not self.approved_tools
                if allowed:
                    self.approved_tools.add(call.get("toolCallId"))
                    outcome = {"outcome": "selected", "optionId": option["optionId"]}
                else:
                    self.denied_count += 1
                    outcome = {"outcome": "cancelled"}
                await self.send({"jsonrpc": "2.0", "id": message["id"], "result": {"outcome": outcome}})
                self.note(permission_exact_safe_command=allowed)
                return True
            update = params.get("update", {})
            if update.get("sessionUpdate") in ("tool_call", "tool_call_update"):
                if update.get("toolCallId") in self.approved_tools and update.get("status") == "completed":
                    self.tool_completed = tool_marker in json.dumps(update.get("content", []))
                    self.note(approved_tool_completed=self.tool_completed)
            return False

    with sqlite3.connect("file:" + str(base.base.DB) + "?mode=ro", uri=True) as db:
        command, args, saved_env = db.execute("SELECT command,args,env FROM agents WHERE id='opencode'").fetchone()
    env = dict(os.environ)
    env.update(json.loads(saved_env))
    env["FARFOLD_ATRIA_VALIDATION_KEY"] = key
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
        "provider": {provider: {
            "npm": "@ai-sdk/openai-compatible", "name": "Atria authorized validation",
            "options": {"baseURL": report["endpoint"], "apiKey": "{env:FARFOLD_ATRIA_VALIDATION_KEY}", "timeout": 90000},
            "models": {model: {"name": model, "limit": {"context": 32000, "output": 1024}}},
        }},
        "agent": {"title": {"disable": True}},
        "permission": {"*": "deny", "bash": "ask"},
        "compaction": {"auto": False},
    })
    report["launch"] = {"command": command, "args": json.loads(args)}
    cwd = base.ROOT / (base.RUN + "-atria-project")
    cwd.mkdir(exist_ok=True)
    sid = None
    for phase in ("new", "load"):
        probe = RealProbe(base.RUN + "-atria-" + phase)
        row = {"phase": phase}
        report["phases"].append(row)
        try:
            await probe.start([command, *json.loads(args)], env)
            init = await base.rpc(probe, "initialize", {"protocolVersion": 1, "clientInfo": {"name": "farfold-atria-validation", "version": "1"}, "clientCapabilities": {}}, 1)
            report["agent_info"] = init.get("agentInfo")
            params = {"cwd": str(cwd), "mcpServers": []}
            if sid:
                params["sessionId"] = sid
            opened = await base.rpc(probe, "session/" + phase, params, 2)
            sid = opened.get("sessionId", sid)
            row["session_id"] = sid
            option = base.model_option(opened)
            row["model_offered"] = selected in base.option_values(option.get("options", []))
            row["opened_model"] = option.get("currentValue")
            if phase == "new":
                changed = await base.rpc(probe, "session/set_config_option", {"sessionId": sid, "configId": option["id"], "value": selected}, 3)
                row["selected_model"] = base.model_option(changed).get("currentValue")
                if row["selected_model"] != selected:
                    raise RuntimeError("selection_mismatch_no_prompt_sent")
                first = await base.rpc(probe, "session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Reply with only " + marker + ". Do not use tools."}]}, 4, 100)
                row["text_stop"] = first.get("stopReason")
                row["text_marker"] = marker in probe.session_text.get(sid, "")
                if not row["text_marker"] or first.get("stopReason") != "end_turn":
                    raise RuntimeError("first_prompt_failed_no_followup")
                tool = await base.rpc(probe, "session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Run exactly this one shell command once: " + safe_command + ". Do not run any other command or access any file, environment, credentials, or network. Report its output only."}]}, 5, 100)
                row["tool_stop"] = tool.get("stopReason")
                row["safe_command_approved"] = len(probe.approved_tools) == 1
                row["safe_tool_output_observed"] = probe.tool_completed
                row["unexpected_permission_requests_denied"] = probe.denied_count
                row["passed"] = probe.tool_completed and tool.get("stopReason") == "end_turn"
            else:
                row["same_source_restored"] = option.get("currentValue") == selected
                if not row["same_source_restored"]:
                    raise RuntimeError("restore_drift_no_continuation_sent")
                probe.session_text[sid] = ""
                done = await base.rpc(probe, "session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Without using tools, repeat the exact FARFOLD_ATRIA_TEXT_ marker from my first message and then the exact output of the single printf command in this conversation. Do not invent anything."}]}, 6, 100)
                text = probe.session_text.get(sid, "")
                row["restored_marker_recalled"] = marker in text
                row["restored_tool_output_recalled"] = tool_marker in text
                row["stop"] = done.get("stopReason")
                row["passed"] = row["restored_marker_recalled"] and row["restored_tool_output_recalled"] and done.get("stopReason") == "end_turn"
        except Exception as exc:
            row["error"] = str(exc).replace(key, "[REDACTED]")
            row["passed"] = False
        finally:
            if hasattr(probe, "proc"):
                await probe.close()
                row["process_reaped"] = probe.proc.returncode is not None
                row["owned_process_group_survivors"] = probe.group_survivors
                if probe.group_survivors:
                    row["passed"] = False
            base.save()
        if not row.get("passed"):
            break
    report["passed"] = len(report["phases"]) == 2 and all(r.get("passed") for r in report["phases"])
    report["real_model_success"] = report["passed"]
    base.save()
    print(json.dumps({"evidence": str(base.ROOT / (base.RUN + "-result.json")), "passed": report["passed"], "phases": report["phases"]}), flush=True)
