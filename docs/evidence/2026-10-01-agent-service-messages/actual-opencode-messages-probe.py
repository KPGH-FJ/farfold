#!/usr/bin/env python3
"""Explicit opt-in real OpenCode probe; default runs only loopback fixture tests.

No database, user configuration, Keychain, private HOME, install or binary hash
lookup is performed. Native test history belongs to OpenCode and is preserved.
Actual execution must be separately authorized; --self-test never starts it.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import sys

sys.dont_write_bytecode = True
from actual_opencode_messages_fixture import (
    API_MODEL, KEYS, OVERRIDE_KEY, OVERRIDE_MODEL, TOKEN,
    MessagesFixture, prompt_marker, receipt_marker, self_test,
)

EVIDENCE = Path(__file__).resolve().parent
COMMAND = "/Users/tw/.opencode/bin/opencode"
EXPECTED_VERSION = "1.18.31"
MAP_KEY = "farfold-canary-map-key"
RPC_LIMIT = 1024 * 1024
TEXT_LIMIT = 64 * 1024
QUIET_SECONDS = 0.4
CASES = (
    "model_id_override", "model_provider_override", "model_api_override",
    "provider_headers_override", "model_headers_override",
    "empty_provider_headers_keeps_model_headers", "nonempty_auth_token",
)
ENV_NAMES = {"a": "FARFOLD_CONTROLLED_KEY_A", "b": "FARFOLD_CONTROLLED_KEY_B"}
FAILURES = {
    "RPC_ENDED", "RPC_TIMEOUT", "RPC_REJECTED", "RPC_WRITE_FAILED",
    "RPC_TOO_LARGE", "UNEXPECTED_VERSION", "LOAD_UNSUPPORTED",
    "SESSION_ID_MISSING", "MODEL_OPTION_UNAVAILABLE", "MODEL_NOT_OFFERED",
    "MODEL_SELECTION_MISMATCH", "HISTORY_NOT_REPLAYED", "AUTOMATIC_HTTP",
    "PROMPT_NOT_COMPLETED", "SOURCE_RECEIPT_MISMATCH", "PROCESS_CLOSE_UNKNOWN",
    "START_FAILED", "TASK_CWD_REJECTED", "TASK_CWD_CHANGED", "TOTAL_TIMEOUT",
}


class ProbeFailure(Exception):
    def __init__(self, code):
        if code not in FAILURES:
            code = "RPC_REJECTED"
        self.code = code
        super().__init__(code)


def safe_output(path):
    output = Path(path).resolve()
    if output.parent != EVIDENCE or not output.name.startswith("actual-opencode-messages-"):
        raise ProbeFailure("TASK_CWD_REJECTED")
    if output.exists():
        raise ProbeFailure("TASK_CWD_REJECTED")
    return output


def model_option(result):
    options = result.get("configOptions", []) if isinstance(result, dict) else []
    candidates = [item for item in options if isinstance(item, dict)
                  and (item.get("category") == "model" or item.get("id") == "model")]
    if len(candidates) != 1 or candidates[0].get("type") != "select":
        raise ProbeFailure("MODEL_OPTION_UNAVAILABLE")
    return candidates[0]


def offered(option):
    values = []
    pending = list(option.get("options", []))
    steps = 0
    while pending and steps < 2048:
        steps += 1
        item = pending.pop()
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("value"), str):
            values.append(item["value"])
        pending.extend(item.get("options", []) if isinstance(item.get("options", []), list) else [])
    return values


def protected_choices(result, expected=None):
    # Read-only memory check. Historical IDs remain protected when their current
    # category changes; this does not write/migrate any Agent or Farfold record.
    choices = {}
    for item in result.get("configOptions", []):
        if not isinstance(item, dict):
            continue
        identifier = item.get("id")
        if item.get("category") not in ("model", "thought_level") and identifier not in (expected or {}):
            continue
        if not isinstance(identifier, str) or identifier in choices:
            raise ProbeFailure("MODEL_SELECTION_MISMATCH")
        if item.get("type") != "select" or not isinstance(item.get("currentValue"), str):
            raise ProbeFailure("MODEL_OPTION_UNAVAILABLE")
        choices[identifier] = (item["type"], item["currentValue"])
    return choices


class ACPProbe:
    def __init__(self, cwd, environment):
        self.cwd = cwd
        self.environment = environment
        self.process = None
        self.reader = None
        self.pending = {}
        self.identifier = 0
        self.allowed_sessions = set()
        self.text = {}
        self.protected = {}
        self.counts = {"rpcErrors": 0, "malformedLines": 0, "deniedRequests": 0,
                       "notifications": 0, "textLimitExceeded": 0}
        self.closed = False
        self.term_requested = False
        self.kill_requested = False
        self.write_lock = asyncio.Lock()

    async def start(self):
        try:
            self.process = await asyncio.create_subprocess_exec(
                COMMAND, "acp", cwd=str(self.cwd), env=self.environment,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=RPC_LIMIT + 1,
            )
        except OSError:
            raise ProbeFailure("START_FAILED") from None
        self.reader = asyncio.create_task(self.read())

    async def send(self, message):
        try:
            encoded = (json.dumps(message) + "\n").encode()
            if len(encoded) > RPC_LIMIT:
                raise ProbeFailure("RPC_TOO_LARGE")
            async with self.write_lock:
                self.process.stdin.write(encoded)
                await asyncio.wait_for(self.process.stdin.drain(), 3)
        except (OSError, ConnectionError, asyncio.TimeoutError):
            raise ProbeFailure("RPC_WRITE_FAILED") from None

    async def read(self):
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                if len(line) > RPC_LIMIT:
                    raise ProbeFailure("RPC_TOO_LARGE")
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    self.counts["malformedLines"] += 1
                    continue
                if not isinstance(message, dict):
                    self.counts["malformedLines"] += 1
                    continue
                identifier = message.get("id")
                if ("result" in message or "error" in message) and isinstance(identifier, (str, int)) and identifier in self.pending:
                    future = self.pending.pop(identifier)
                    if not future.done():
                        if "error" in message:
                            self.counts["rpcErrors"] += 1
                            future.set_exception(ProbeFailure("RPC_REJECTED"))
                        else:
                            future.set_result(message["result"])
                    continue
                params = message.get("params", {})
                params = params if isinstance(params, dict) else {}
                update = params.get("update", {})
                if isinstance(update, dict) and update.get("sessionUpdate") == "agent_message_chunk":
                    session = params.get("sessionId")
                    content = update.get("content", {})
                    if session in self.allowed_sessions and isinstance(content, dict):
                        text = content.get("text")
                        if isinstance(text, str):
                            combined = self.text.get(session, "") + text
                            if len(combined.encode()) > TEXT_LIMIT:
                                self.counts["textLimitExceeded"] += 1
                            self.text[session] = combined[-TEXT_LIMIT:]
                if "method" in message and identifier is not None:
                    self.counts["deniedRequests"] += 1
                    if message["method"] == "session/request_permission":
                        answer = {"result": {"outcome": {"outcome": "cancelled"}}}
                    else:
                        answer = {"error": {"code": -32601, "message": "Not supported by controlled probe"}}
                    await self.send({"jsonrpc": "2.0", "id": identifier, **answer})
                else:
                    self.counts["notifications"] += 1
        except (ValueError, OSError, ConnectionError, ProbeFailure):
            # No exception or protocol body is written to output.
            pass
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ProbeFailure("RPC_ENDED"))
            self.pending.clear()

    async def rpc(self, method, params, seconds=30):
        self.identifier += 1
        identifier = self.identifier
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            await self.send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
            result = await asyncio.wait_for(future, seconds)
            if not isinstance(result, dict):
                raise ProbeFailure("RPC_REJECTED")
            return result
        except asyncio.TimeoutError:
            raise ProbeFailure("RPC_TIMEOUT") from None
        finally:
            self.pending.pop(identifier, None)
            if not future.done():
                future.cancel()

    async def initialize(self):
        result = await self.rpc("initialize", {
            "protocolVersion": 1,
            "clientInfo": {"name": "farfold-messages-canary", "version": "1"},
            "clientCapabilities": {},
        })
        if result.get("agentInfo", {}).get("version") != EXPECTED_VERSION:
            raise ProbeFailure("UNEXPECTED_VERSION")
        return result.get("agentCapabilities", {}).get("loadSession") is True

    async def group_count(self):
        process = await asyncio.create_subprocess_exec(
            "ps", "-axo", "pgid=", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), 2)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return None
        except asyncio.CancelledError:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise
        if process.returncode != 0 or len(stdout) > 1024 * 1024:
            return None
        try:
            return sum(int(value) == self.process.pid for value in stdout.split())
        except ValueError:
            return None

    async def close(self):
        if self.closed:
            return True
        if self.process is None:
            self.closed = True
            return True
        try:
            members = await self.group_count()
            if self.process.returncode is None or (members is not None and members > 0):
                self.term_requested = True
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except asyncio.TimeoutError:
                self.kill_requested = True
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(self.process.wait(), 3)
            members = await self.group_count()
            if members is not None and members > 0:
                self.kill_requested = True
                os.killpg(self.process.pid, signal.SIGKILL)
                # A bounded observation window, not an assumed successful kill.
                for _ in range(10):
                    members = await self.group_count()
                    if members == 0:
                        break
                    await asyncio.sleep(0.05)
            self.closed = self.process.returncode is not None and members == 0
        except (OSError, asyncio.TimeoutError):
            self.closed = False
        finally:
            if self.reader is not None:
                self.reader.cancel()
                await asyncio.gather(self.reader, return_exceptions=True)
        return self.closed

    def summary(self):
        return {**self.counts, "childStarted": self.process is not None,
                "processReaped": self.process is not None and self.process.returncode is not None,
                "groupEndedConfirmed": self.process is not None and self.closed,
                "termRequested": self.term_requested, "killRequested": self.kill_requested}


def configuration(fixture, provider_ids, case=None):
    providers = {}
    for route in KEYS:
        base = f"http://127.0.0.1:{fixture.port}/{route}/v1"
        providers[provider_ids[route]] = {
            "npm": "@ai-sdk/anthropic", "name": "Messages local canary",
            "options": {"baseURL": base, "apiKey": "{env:" + ENV_NAMES[route] + "}"},
            "models": {MAP_KEY: {
                "id": API_MODEL, "name": "Canary display label",
                "provider": {"npm": "@ai-sdk/anthropic", "api": base},
            }},
        }
    if case:
        provider = providers[provider_ids["a"]]
        model = provider["models"][MAP_KEY]
        if case == "model_id_override":
            model["id"] = OVERRIDE_MODEL
        elif case == "model_provider_override":
            model["provider"]["npm"] = "@ai-sdk/openai"
        elif case == "model_api_override":
            # Explicit provider options.baseURL may take precedence over this.
            model["provider"]["api"] = f"http://127.0.0.1:{fixture.port}/b/v1"
        elif case == "provider_headers_override":
            provider["options"]["headers"] = {"X-Api-Key": OVERRIDE_KEY}
        elif case in ("model_headers_override", "empty_provider_headers_keeps_model_headers"):
            model["headers"] = {"x-api-key": OVERRIDE_KEY}
            if case == "empty_provider_headers_keeps_model_headers":
                # Separate official fields, not a claim to emulate disk layers:
                # empty provider headers does not cancel model-level headers.
                provider["options"]["headers"] = {}
        elif case == "nonempty_auth_token":
            provider["options"]["authToken"] = TOKEN
        else:
            raise ProbeFailure("TASK_CWD_REJECTED")
    return {
        "provider": providers,
        "model": provider_ids["a"] + "/" + MAP_KEY,
        "agent": {"title": {"disable": True}},
        "permission": "deny", "compaction": {"auto": False},
    }


def environment(config):
    inherited = os.environ.copy()
    # Replace only task-specific official inline config and useless canary keys.
    # No inherited key value is inspected, logged or stored; HOME is unchanged.
    inherited["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    for route, name in ENV_NAMES.items():
        inherited[name] = KEYS[route]
    return inherited


async def open_new(probe, cwd, selected):
    result = await probe.rpc("session/new", {"cwd": str(cwd), "mcpServers": []})
    session = result.get("sessionId")
    if not isinstance(session, str) or not session:
        raise ProbeFailure("SESSION_ID_MISSING")
    probe.allowed_sessions.add(session)
    option = model_option(result)
    if selected not in offered(option):
        raise ProbeFailure("MODEL_NOT_OFFERED")
    if option.get("currentValue") != selected:
        result = await probe.rpc("session/set_config_option", {
            "sessionId": session, "configId": option["id"], "value": selected,
        })
        option = model_option(result)
    if option.get("currentValue") != selected:
        raise ProbeFailure("MODEL_SELECTION_MISMATCH")
    probe.protected[session] = protected_choices(result)
    return session


async def send_prompt(probe, session, route, phase):
    result = await probe.rpc("session/prompt", {"sessionId": session, "prompt": [{
        "type": "text", "text": prompt_marker(route, phase) + ". Reply only with the supplied receipt. Do not call tools, inspect files, settings or network.",
    }]}, seconds=45)
    return result.get("stopReason") == "end_turn"


def selected_request(row):
    return all(row[key] for key in (
        "validMessagesPath", "authorizedByExplicitPrompt", "modelMatchesSelection",
        "keyMatchesRoute", "versionMatches", "expectedPromptPresent",
        "streamRequested", "responseCompleted",
    )) and not any(row[key] for key in (
        "otherRouteKeyPresent", "bearerPresent", "otherSourcePromptPresent",
        "otherSourceReceiptPresent", "bodyContainsAnyCanaryKey",
    ))


def preparation_http_clean(fixture, before):
    return (fixture.total == before and fixture.auto_requests == 0
            and fixture.handler_errors == 0 and fixture.limit_exceeded == 0
            and not fixture.tasks and not fixture.writers)


async def positive(cwd, fixture, provider_ids, processes, rows):
    config = configuration(fixture, provider_ids)
    sessions = {}
    baseline = {}
    for phase in ("new", "load"):
        fixture.begin(phase)
        before = fixture.total
        probe = ACPProbe(cwd, environment(config))
        processes.append(probe)
        row = {"newPhase": phase == "new", "loadPhase": phase == "load",
               "modelsMatched": False, "protectedChoicesMatched": False,
               "historyMatched": phase == "new",
               "noAutomaticHTTPBeforeExplicitPrompt": False, "quietWindowMilliseconds": 400,
               "promptsCompleted": False, "receiptsMatched": False, "requestsMatched": False}
        rows.append(row)
        await probe.start()
        if not await probe.initialize():
            raise ProbeFailure("LOAD_UNSUPPORTED")
        for route in KEYS:
            selected = provider_ids[route] + "/" + MAP_KEY
            if phase == "new":
                sessions[route] = await open_new(probe, cwd, selected)
                baseline[route] = probe.protected[sessions[route]]
            else:
                probe.allowed_sessions.add(sessions[route])
                result = await probe.rpc("session/load", {
                    "cwd": str(cwd), "mcpServers": [], "sessionId": sessions[route],
                })
                if model_option(result).get("currentValue") != selected:
                    raise ProbeFailure("MODEL_SELECTION_MISMATCH")
                if protected_choices(result, baseline[route]) != baseline[route]:
                    raise ProbeFailure("MODEL_SELECTION_MISMATCH")
                if receipt_marker(route, "new") not in probe.text.get(sessions[route], ""):
                    raise ProbeFailure("HISTORY_NOT_REPLAYED")
        row["modelsMatched"] = True
        row["protectedChoicesMatched"] = True
        row["protectedChoiceCount"] = sum(len(values) for values in baseline.values())
        row["historyMatched"] = True
        await asyncio.sleep(QUIET_SECONDS)
        row["noAutomaticHTTPBeforeExplicitPrompt"] = preparation_http_clean(fixture, before)
        if not row["noAutomaticHTTPBeforeExplicitPrompt"]:
            raise ProbeFailure("AUTOMATIC_HTTP")
        fixture.permitted = set(KEYS)
        start = len(fixture.records)
        complete = await asyncio.gather(*(
            send_prompt(probe, sessions[route], route, phase) for route in KEYS
        ))
        row["promptsCompleted"] = all(complete)
        row["receiptsMatched"] = all(
            receipt_marker(route, phase) in probe.text.get(sessions[route], "")
            and receipt_marker("b" if route == "a" else "a", phase) not in probe.text.get(sessions[route], "")
            for route in KEYS
        )
        records = fixture.records[start:]
        row["requestCount"] = len(records)
        row["requestsMatched"] = len(records) == 2 and all(selected_request(item) for item in records)
        if phase == "load":
            row["priorReceiptInOwnRequest"] = all(item["priorReceiptPresent"] for item in records)
        if not all(row[key] for key in ("promptsCompleted", "receiptsMatched", "requestsMatched")):
            raise ProbeFailure("SOURCE_RECEIPT_MISMATCH")
        if phase == "load" and not row["priorReceiptInOwnRequest"]:
            raise ProbeFailure("HISTORY_NOT_REPLAYED")
        row["closedBeforeNextPhase"] = await probe.close()
        if not row["closedBeforeNextPhase"]:
            raise ProbeFailure("PROCESS_CLOSE_UNKNOWN")
    return rows


def classify_inline(case, result, observations):
    result["selectionPreservedInObservedRequest"] = len(observations) == 1 and selected_request(observations[0])
    result["selectionChangedInObservedRequest"] = bool(observations) and any(
        not row["modelMatchesSelection"] or not row["keyMatchesRoute"] or row["bearerPresent"]
        for row in observations
    )
    result["observationCompleted"] = (
        result["agentInitialized"] and result["modelOptionMatched"]
        and result["explicitPromptDispatched"] and result["closedConfirmed"]
        and result["noAutomaticHTTPBeforeExplicitPrompt"]
        and all(row["authorizedByExplicitPrompt"] for row in observations)
        and (result["promptCompleted"] or result.get("fixedFailure") == "RPC_REJECTED")
    )
    if case == "model_id_override":
        expected = len(observations) == 1 and observations[0]["overriddenModelObserved"]
    elif case == "model_provider_override":
        expected = result["wrongAPIPathObserved"] or result["promptRejectedBeforeHTTP"]
    elif case == "model_api_override":
        expected = result["selectionPreservedInObservedRequest"]
    elif case in ("provider_headers_override", "model_headers_override", "empty_provider_headers_keeps_model_headers"):
        expected = len(observations) == 1 and observations[0]["overrideKeyObserved"] and not observations[0]["keyMatchesRoute"]
    elif case == "nonempty_auth_token":
        expected = result["promptRejectedBeforeHTTP"]
    else:
        expected = False
    result["expectedOutcomeMatched"] = result["observationCompleted"] and expected


async def inline_case(case, cwd, fixture, provider_ids, processes, rows):
    fixture.begin("inline")
    start = len(fixture.records)
    before = fixture.total
    prompt_before = None
    wrong_api_before = None
    probe = ACPProbe(cwd, environment(configuration(fixture, provider_ids, case)))
    processes.append(probe)
    result = {"case": case, "agentInitialized": False, "modelOptionMatched": False,
              "explicitPromptDispatched": False, "promptCompleted": False,
              "selectionPreservedInObservedRequest": False, "selectionChangedInObservedRequest": False,
              "promptRejectedBeforeHTTP": False, "wrongAPIPathObserved": False,
              "noAutomaticHTTPBeforeExplicitPrompt": False, "quietWindowMilliseconds": 400,
              "requests": 0, "closedConfirmed": False,
              "observationCompleted": False, "expectedOutcomeMatched": False}
    rows.append(result)
    stage = "initialize"
    try:
        await probe.start()
        await probe.initialize()
        result["agentInitialized"] = True
        stage = "model"
        session = await open_new(probe, cwd, provider_ids["a"] + "/" + MAP_KEY)
        result["modelOptionMatched"] = True
        await asyncio.sleep(QUIET_SECONDS)
        result["noAutomaticHTTPBeforeExplicitPrompt"] = preparation_http_clean(fixture, before)
        if not result["noAutomaticHTTPBeforeExplicitPrompt"]:
            raise ProbeFailure("AUTOMATIC_HTTP")
        prompt_before = fixture.total
        wrong_api_before = fixture.explicit_wrong_api_paths
        fixture.permitted = {"a"}
        stage = "prompt"
        result["explicitPromptDispatched"] = True
        result["promptCompleted"] = await send_prompt(probe, session, "a", "inline")
    except ProbeFailure as error:
        result["fixedFailure"] = error.code
        result["promptRejectedBeforeHTTP"] = (
            stage == "prompt" and error.code == "RPC_REJECTED" and fixture.total == prompt_before
        )
    finally:
        result["closedConfirmed"] = await probe.close()
        observations = fixture.records[start:]
        result["requests"] = fixture.total - before
        result["wrongAPIPathObserved"] = (
            wrong_api_before is not None and fixture.explicit_wrong_api_paths > wrong_api_before
        )
        result["promptRejectedBeforeHTTP"] = (
            result["promptRejectedBeforeHTTP"] and fixture.total == prompt_before
            and fixture.auto_requests == 0 and fixture.handler_errors == 0
            and fixture.limit_exceeded == 0
        )
        classify_inline(case, result, observations)
    return result


async def actual(task_cwd):
    # Root chooses and therefore retains the exact path for manual recovery if
    # cleanup cannot be confirmed. No directory search/prefix deletion is used.
    cwd = Path(task_cwd)
    parent = Path("/tmp").resolve()
    if not cwd.is_absolute() or cwd.parent.resolve() != parent or not cwd.name.startswith("farfold-actual-messages-"):
        raise ProbeFailure("TASK_CWD_REJECTED")
    try:
        cwd.mkdir(mode=0o700)
    except OSError:
        raise ProbeFailure("TASK_CWD_REJECTED") from None
    cwd = cwd.resolve()
    if cwd.parent != parent:
        raise ProbeFailure("TASK_CWD_REJECTED")
    inode = cwd.stat().st_ino
    provider_ids = {route: "farfold_messages_" + cwd.name.replace("-", "_") + "_" + route for route in KEYS}
    fixture = MessagesFixture()
    processes = []
    report = {"schema": 1, "agentStarted": False, "actualOpenCodeExecuted": False,
              "realCloudRequestAuthorized": False, "nativeTestHistoryPreserved": True,
              "positivePassed": False, "positivePhases": [], "inlineCases": [],
              "listenerClosed": False, "taskCwdDeleted": False,
              "allProcessGroupsEndedConfirmed": False}
    async def exercise():
        await positive(cwd, fixture, provider_ids, processes, report["positivePhases"])
        report["positivePassed"] = True
        for case in CASES:
            row = await inline_case(case, cwd, fixture, provider_ids, processes, report["inlineCases"])
            if not row["closedConfirmed"]:
                raise ProbeFailure("PROCESS_CLOSE_UNKNOWN")
    try:
        await fixture.start()
        await asyncio.wait_for(exercise(), 720)
    except ProbeFailure as error:
        report["fixedFailure"] = error.code
    except asyncio.TimeoutError:
        report["fixedFailure"] = "TOTAL_TIMEOUT"
    except Exception:
        # Unknown local/protocol failures remain unknown, never their text.
        report["unexpectedLocalFailure"] = True
    finally:
        report["agentStarted"] = any(probe.process is not None for probe in processes)
        report["actualOpenCodeExecuted"] = report["agentStarted"]
        try:
            results = await asyncio.wait_for(asyncio.gather(
                *(probe.close() for probe in processes), return_exceptions=True
            ), 45)
            report["allProcessGroupsEndedConfirmed"] = all(item is True for item in results)
        except asyncio.TimeoutError:
            report["processCleanupTimeout"] = True
        report["processes"] = [probe.summary() for probe in processes]
        report["processCount"] = len(processes)
        if fixture.server is not None:
            try:
                report["listenerClosed"] = await asyncio.wait_for(fixture.close(), 7)
            except Exception:
                report["httpFixtureCloseFailed"] = True
        report["requests"] = fixture.total
        report["automaticRequests"] = fixture.auto_requests
        report["rejectedRequests"] = fixture.rejected_requests
        report["httpHandlerErrors"] = fixture.handler_errors
        report["httpLimitExceeded"] = fixture.limit_exceeded
        report["httpObservations"] = fixture.records
        if report["allProcessGroupsEndedConfirmed"]:
            if cwd.is_symlink() or not cwd.exists() or cwd.stat().st_ino != inode or cwd.parent != parent:
                report["taskCwdIdentityChanged"] = True
            else:
                try:
                    shutil.rmtree(cwd)
                    report["taskCwdDeleted"] = not cwd.exists()
                except OSError:
                    report["taskCwdDeleteFailed"] = True
        report["keptCwdBecauseCleanupUnknown"] = not report["taskCwdDeleted"]
    report["inlineObservationsCompleted"] = len(report["inlineCases"]) == len(CASES) and all(
        row["observationCompleted"] for row in report["inlineCases"]
    )
    report["expectedInlineOutcomesMatched"] = report["inlineObservationsCompleted"] and all(
        row["expectedOutcomeMatched"] for row in report["inlineCases"]
    )
    report["passed"] = (
        report["positivePassed"] and report["expectedInlineOutcomesMatched"]
        and report["allProcessGroupsEndedConfirmed"] and report["listenerClosed"]
        and report["taskCwdDeleted"] and not report.get("unexpectedLocalFailure", False)
        and report["automaticRequests"] == 0 and report["httpHandlerErrors"] == 0
        and report["httpLimitExceeded"] == 0
    )
    return report


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--run-agent", action="store_true")
    parser.add_argument("--task-cwd")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.self_test and args.run_agent:
        raise ProbeFailure("TASK_CWD_REJECTED")
    if args.run_agent and not args.task_cwd:
        raise ProbeFailure("TASK_CWD_REJECTED")
    name = "actual-opencode-messages-result.json" if args.run_agent else "actual-opencode-messages-selftest.json"
    output = safe_output(args.out or EVIDENCE / name)
    if args.run_agent:
        report = await actual(args.task_cwd)
    else:
        report = {"schema": 1, **await asyncio.wait_for(self_test(), 20)}
        from actual_opencode_messages_selftests import run as harness_tests
        report["harnessSelfTests"] = await asyncio.wait_for(harness_tests(), 20)
        from actual_opencode_messages_timing_selftests import run as timing_tests
        report["timingSelfTests"] = await asyncio.wait_for(timing_tests(), 20)
        report["passed"] = report["passed"] and report["timingSelfTests"]["passed"]
        report["passed"] = report["passed"] and report["harnessSelfTests"]["passed"]
    report["exitCode"] = 0 if report["passed"] else 1
    output.write_text(json.dumps(report, indent=2) + "\n")
    # Output fixed status/counts only, never process paths, IDs, messages, args,
    # environment values, header values, model payloads or protocol JSON.
    print(json.dumps({key: report[key] for key in (
        "agentStarted", "passed", "exitCode", "localRequests", "requests",
        "positivePassed", "listenerClosed", "taskCwdDeleted",
    ) if key in report}))
    return report["exitCode"]


if __name__ == "__main__":
    try:
        status = asyncio.run(main())
    except ProbeFailure:
        print(json.dumps({"argumentOrSafetyCheckFailed": True, "exitCode": 2}))
        status = 2
    except Exception:
        print(json.dumps({"localFailure": True, "exitCode": 2}))
        status = 2
    raise SystemExit(status)
