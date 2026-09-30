#!/usr/bin/env python3
"""Targeted official restore probes; retain model/effort fields, never raw traffic."""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess

SESSION = "01a0f170-373c-7700-8bad-f9b90bc68b66"
CWD = "/Users/tw/Library/Application Support/ai.farfold.desktop/conversations"
DATABASE = "file:/Users/tw/Library/Application Support/ai.farfold.desktop/farfold.sqlite3?mode=ro"
ROLLOUT = Path("/Users/tw/.codex/sessions/2026/09/30/rollout-2026-09-30T16-30-58-01a0f170-373c-7700-8bad-f9b90bc68b66.jsonl")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def target_metadata():
    contexts = []
    with ROLLOUT.open() as stream:
        for line in stream:
            value = json.loads(line)
            if value.get("type") == "turn_context":
                payload = value.get("payload", {})
                contexts.append({"model": payload.get("model"), "effort": payload.get("effort")})
    return {"bytes": ROLLOUT.stat().st_size, "sha256": hashlib.sha256(ROLLOUT.read_bytes()).hexdigest(), "turnContexts": contexts}


def process_table():
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,pgid="], capture_output=True, text=True, check=True)
    return {int(pid): (int(parent), int(group)) for pid, parent, group in (line.split() for line in result.stdout.splitlines())}


def descendants(root, table):
    owners = {root}
    while True:
        expanded = owners | {pid for pid, (parent, _) in table.items() if parent in owners}
        if expanded == owners:
            return owners
        owners = expanded


def option_fields(value):
    options = value.get("configOptions")
    selected = []
    if isinstance(options, list):
        for option in options:
            if not isinstance(option, dict):
                continue
            if option.get("category") in ["model", "thought_level"] or option.get("id") in ["model", "reasoning_effort", "thought_level"]:
                current = option.get("currentValue")
                selected.append({"id": option.get("id"), "category": option.get("category"), "currentValue": current if isinstance(current, (str, bool, int, float)) else None})
    models = value.get("models", {})
    return {"configOptionsPresent": isinstance(options, list), "selectedOptions": selected, "currentModelId": models.get("currentModelId") if isinstance(models, dict) else None}


async def probe(kind):
    connection = sqlite3.connect(DATABASE, uri=True)
    row = connection.execute("select command,args,env from agents where id=?", ("codex",)).fetchone()
    if row is None:
        raise RuntimeError("registered_target_missing")
    original_command = [row[0], *json.loads(row[1])]
    registered_env = json.loads(row[2])
    if not isinstance(registered_env, dict) or set(registered_env) != {"CODEX_PATH"}:
        raise RuntimeError("registered_environment_requires_separate_review")
    environment = dict(os.environ)
    environment.update(registered_env)
    if environment.get("APP_SERVER_LOGS"):
        raise RuntimeError("raw_official_logging_already_enabled")
    command = original_command if kind == "acp" else [registered_env["CODEX_PATH"], "app-server"]
    result = {"probe": kind, "at": utc_now(), "sessionId": SESSION, "command": command, "cwd": CWD, "requests": [], "modelReceipts": [], "notificationCount": 0, "stderrBytes": 0, "rolloutBefore": target_metadata()}
    process = await asyncio.create_subprocess_exec(*command, cwd=CWD, env=environment, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024, start_new_session=True)
    owners = {process.pid}
    pending = {}
    reader_error = None

    async def send(value):
        process.stdin.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
        await process.stdin.drain()

    async def stderr_reader():
        while chunk := await process.stderr.read(8192):
            result["stderrBytes"] += len(chunk)

    async def stdout_reader():
        nonlocal reader_error
        try:
            while line := await process.stdout.readline():
                value = json.loads(line)
                if "method" in value:
                    result["notificationCount"] += 1
                    params = value.get("params", {})
                    if kind == "acp" and value["method"] == "session/update" and params.get("sessionId") == SESSION:
                        update = params.get("update", {})
                        if isinstance(update, dict) and "configOptions" in update:
                            result["modelReceipts"].append({"source": "session/update", **option_fields(update)})
                    if "id" in value:
                        await send({"jsonrpc": "2.0", "id": value["id"], "error": {"code": -32601, "message": "Restore probe does not perform client actions"}})
                elif value.get("id") in pending:
                    future = pending.pop(value["id"])
                    if not future.done():
                        future.set_result(value)
        except Exception as error:
            reader_error = type(error).__name__
            for future in pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("protocol_reader_stopped"))

    async def observe_owners():
        while process.returncode is None:
            owners.update(descendants(process.pid, process_table()))
            await asyncio.sleep(0.3)

    async def request(identifier, method, params):
        future = asyncio.get_running_loop().create_future()
        pending[identifier] = future
        result["requests"].append({"id": identifier, "method": method})
        await send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
        response = await asyncio.wait_for(future, timeout=90)
        if "error" in response:
            result["protocolErrorCode"] = response["error"].get("code")
            raise RuntimeError("official_request_failed")
        return response.get("result", {})

    tasks = [asyncio.create_task(stdout_reader()), asyncio.create_task(stderr_reader()), asyncio.create_task(observe_owners())]
    try:
        if kind == "acp":
            init = await request(1, "initialize", {"protocolVersion": 1, "clientInfo": {"name": "farfold", "version": "0.1.7"}, "clientCapabilities": {"elicitation": {"form": {}}, "auth": {"terminal": True}, "_meta": {"terminal-auth": True, "jetbrains": {"air": {"version": 1, "capabilities": ["sessionFailure"]}}}}})
            result["loadSessionCapability"] = init.get("agentCapabilities", {}).get("loadSession")
            load = await request(2, "session/load", {"sessionId": SESSION, "cwd": CWD, "mcpServers": []})
            result["modelReceipts"].append({"source": "session/load", **option_fields(load)})
        else:
            await request(1, "initialize", {"clientInfo": {"name": "farfold", "version": "0.1.7"}, "capabilities": {"experimentalApi": True}})
            await send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
            load = await request(2, "thread/resume", {"threadId": SESSION, "cwd": CWD, "excludeTurns": True})
            result["modelReceipts"].append({"source": "thread/resume", "model": load.get("model"), "reasoningEffort": load.get("reasoningEffort"), "returnedTargetMatches": load.get("thread", {}).get("id") == SESSION})
        result["outcome"] = "completed"
        await asyncio.sleep(1)
    except Exception as error:
        result["outcome"] = "failed"
        result["failureType"] = type(error).__name__
    finally:
        owners.update(descendants(process.pid, process_table()))
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), timeout=4)
        except asyncio.TimeoutError:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
        table = process_table()
        leftovers = owners & table.keys()
        for pid in leftovers:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if leftovers:
            await asyncio.sleep(1)
        table = process_table()
        for pid in owners & table.keys():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await asyncio.sleep(0.2)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        result["readerErrorType"] = reader_error
        result["ownedPids"] = sorted(owners)
        result["remainingOwnedPids"] = sorted(owners & process_table().keys())
        result["processExitCode"] = process.returncode
        result["rolloutAfter"] = target_metadata()
        result["finishedAt"] = utc_now()
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["acp", "app-server"])
    args = parser.parse_args()
    data = asyncio.run(probe(args.kind))
    destination = Path(__file__).with_name(f"{args.kind}-restore-fields.json")
    destination.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"evidence": str(destination), "outcome": data["outcome"], "modelReceipts": data["modelReceipts"], "remainingOwnedPids": data["remainingOwnedPids"]}, ensure_ascii=False))
