"""Bounded loopback Messages fixture; no Agent or private configuration reads."""

import asyncio
import json

BODY_LIMIT = 1024 * 1024
HEADER_LIMIT = 32 * 1024
RESPONSE_LIMIT = 64 * 1024
REQUEST_LIMIT = 32
CONNECTION_LIMIT = 16
API_MODEL = "farfold-canary-api-model"
OVERRIDE_MODEL = "farfold-canary-overridden-model"
KEYS = {"a": "FARFOLD_LOCAL_MESSAGES_KEY_A", "b": "FARFOLD_LOCAL_MESSAGES_KEY_B"}
OVERRIDE_KEY = "FARFOLD_LOCAL_MESSAGES_OVERRIDE_KEY"
TOKEN = "FARFOLD_LOCAL_MESSAGES_BEARER_TOKEN"
PHASES = ("new", "load", "inline")


def prompt_marker(route, phase):
    assert route in KEYS and phase in PHASES
    return "FARFOLD_MESSAGES_" + route.upper() + "_" + phase.upper()


def receipt_marker(route, phase):
    assert route in KEYS and phase in PHASES
    return "FARFOLD_MESSAGES_RECEIPT_" + route.upper() + "_" + phase.upper()


def sse_body(route, phase):
    """Pure-text sequence from fixed Anthropic 3.0.111 Messages chunk schema."""
    text = receipt_marker(route, phase)
    events = [
        {"type": "message_start", "message": {
            "id": "msg_local_canary", "type": "message", "role": "assistant",
            "model": API_MODEL, "content": [], "stop_reason": None,
            "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0},
        }},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "text_delta", "text": text[:12]}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "text_delta", "text": text[12:]}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {
            "stop_reason": "end_turn", "stop_sequence": None,
        }, "usage": {"output_tokens": 1}},
        {"type": "message_stop"},
    ]
    return "".join(
        "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
        for event in events
    ).encode()


class SSECheck:
    """Small test-only incremental validator, not an Agent/session implementation."""

    def __init__(self):
        self.buffer = b""
        self.events = []
        self.text = ""
        self.failed = False

    def feed(self, chunk):
        self.buffer += chunk
        if len(self.buffer) > RESPONSE_LIMIT:
            self.failed = True
            return
        while b"\n\n" in self.buffer:
            frame, self.buffer = self.buffer.split(b"\n\n", 1)
            try:
                lines = frame.decode().splitlines()
                event = next(line[7:] for line in lines if line.startswith("event: "))
                data = json.loads("\n".join(line[6:] for line in lines if line.startswith("data: ")))
                if data.get("type") != event or len(self.events) >= 16:
                    raise ValueError()
                self.events.append(data)
                if event == "content_block_delta":
                    if data.get("index") != 0 or data.get("delta", {}).get("type") != "text_delta":
                        raise ValueError()
                    self.text += data["delta"]["text"]
            except (ValueError, KeyError, StopIteration, TypeError, UnicodeDecodeError):
                self.failed = True

    def check(self, route, phase):
        order = ["message_start", "content_block_start", "content_block_delta",
                 "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
        return (
            not self.failed and not self.buffer
            and [event.get("type") for event in self.events] == order
            and self.text == receipt_marker(route, phase)
            and self.events[0]["message"]["usage"]["input_tokens"] == 1
            and self.events[-2]["usage"]["output_tokens"] == 1
            and self.events[-2]["delta"]["stop_reason"] == "end_turn"
        )


class MessagesFixture:
    def __init__(self):
        self.server = None
        self.port = None
        self.writers = set()
        self.tasks = set()
        self.records = []
        self.phase = "new"
        self.permitted = set()
        self.request_counts = {route: 0 for route in KEYS}
        self.total = 0
        self.auto_requests = 0
        self.rejected_requests = 0
        self.wrong_api_paths = 0
        self.explicit_wrong_api_paths = 0
        self.handler_errors = 0
        self.limit_exceeded = 0

    async def start(self):
        self.server = await asyncio.start_server(
            self.handle, "127.0.0.1", 0, limit=HEADER_LIMIT + 1
        )
        address = self.server.sockets[0].getsockname()
        if address[0] != "127.0.0.1":
            raise RuntimeError("LISTENER_TARGET_REJECTED")
        self.port = address[1]

    def begin(self, phase, permitted=()):
        assert phase in PHASES and all(route in KEYS for route in permitted)
        self.phase = phase
        self.permitted = set(permitted)
        self.request_counts = {route: 0 for route in KEYS}

    async def handle(self, reader, writer):
        self.tasks.add(asyncio.current_task())
        self.writers.add(writer)
        try:
            if len(self.tasks) > CONNECTION_LIMIT:
                self.limit_exceeded += 1
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await asyncio.wait_for(writer.drain(), 3)
                return
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 3)
            phase = self.phase
            permitted = frozenset(self.permitted)
            self.total += 1
            if len(header) > HEADER_LIMIT:
                raise ValueError()
            lines = header.decode("latin1").split("\r\n")
            method, path, _ = lines[0].split(" ", 2)
            route = next((name for name in KEYS if path == f"/{name}/v1/messages"), None)
            wrong_route = next((name for name in KEYS if path in (
                f"/{name}/v1/responses", f"/{name}/v1/chat/completions",
            )), None)
            route_hint = route or wrong_route
            authorized_phase = route_hint in permitted if route_hint else bool(permitted)
            if not authorized_phase:
                self.auto_requests += 1
            if self.total > REQUEST_LIMIT:
                self.limit_exceeded += 1
                self.rejected_requests += 1
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await asyncio.wait_for(writer.drain(), 3)
                return
            headers = {}
            for line in lines[1:]:
                if not line:
                    continue
                key, value = line.split(":", 1)
                key = key.strip().lower()
                headers[key] = headers.get(key, "") + (", " if key in headers else "") + value.strip()
            length = int(headers.get("content-length", "-1"))
            if length < 0 or length > BODY_LIMIT or "transfer-encoding" in headers:
                raise ValueError()
            body = await asyncio.wait_for(reader.readexactly(length), 3)
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError()
            valid_path = method == "POST" and route is not None
            if route is None:
                if method == "POST" and wrong_route is not None:
                    self.wrong_api_paths += 1
                    if authorized_phase:
                        self.explicit_wrong_api_paths += 1
                self.rejected_requests += 1
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await asyncio.wait_for(writer.drain(), 3)
                return
            self.request_counts[route] += 1
            text = body.decode("utf8")
            other = "b" if route == "a" else "a"
            record = {
                "routeA": route == "a",
                "phaseNew": phase == "new",
                "phaseLoad": phase == "load",
                "phaseInline": phase == "inline",
                "validMessagesPath": valid_path,
                "authorizedByExplicitPrompt": authorized_phase,
                "modelMatchesSelection": payload.get("model") == API_MODEL,
                "overriddenModelObserved": payload.get("model") == OVERRIDE_MODEL,
                "keyMatchesRoute": headers.get("x-api-key") == KEYS[route],
                "otherRouteKeyPresent": KEYS[other] in headers.get("x-api-key", ""),
                "overrideKeyObserved": OVERRIDE_KEY in headers.get("x-api-key", ""),
                "bearerPresent": bool(headers.get("authorization")),
                "versionMatches": headers.get("anthropic-version") == "2023-06-01",
                "expectedPromptPresent": prompt_marker(route, phase) in text,
                "otherSourcePromptPresent": any(prompt_marker(other, phase) in text for phase in PHASES),
                "priorReceiptPresent": receipt_marker(route, "new") in text,
                "otherSourceReceiptPresent": any(receipt_marker(other, phase) in text for phase in PHASES),
                "bodyContainsAnyCanaryKey": any(key in text for key in [*KEYS.values(), OVERRIDE_KEY, TOKEN]),
                "streamRequested": payload.get("stream") is True,
                "requestBytes": len(body),
                "responseCompleted": False,
            }
            self.records.append(record)
            if not valid_path or not authorized_phase or self.request_counts[route] > 2:
                self.rejected_requests += 1
                writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await asyncio.wait_for(writer.drain(), 3)
                return
            response = sse_body(route, phase)
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: "
                + str(len(response)).encode() + b"\r\n\r\n"
            )
            # Deliberately cut frames and JSON tokens across TCP writes.
            for offset in range(0, len(response), 37):
                writer.write(response[offset:offset + 37])
                await asyncio.wait_for(writer.drain(), 3)
                await asyncio.sleep(0)
            record["responseCompleted"] = True
        except (ValueError, TypeError, UnicodeDecodeError, asyncio.IncompleteReadError,
                asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
            self.handler_errors += 1
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 2)
            except (asyncio.TimeoutError, ConnectionError):
                self.handler_errors += 1
            self.writers.discard(writer)
            self.tasks.discard(asyncio.current_task())

    async def close(self):
        self.server.close()
        await self.server.wait_closed()
        for writer in list(self.writers):
            writer.close()
        if self.tasks:
            try:
                await asyncio.wait_for(asyncio.gather(*list(self.tasks), return_exceptions=True), 5)
            except asyncio.TimeoutError:
                self.handler_errors += 1
                return False
        return not self.server.is_serving() and not self.writers and not self.tasks


async def fixture_request(fixture, route, phase, headers=None, path=None):
    reader, writer = await asyncio.open_connection("127.0.0.1", fixture.port)
    payload = {
        "model": API_MODEL, "stream": True,
        "messages": [{"role": "user", "content": prompt_marker(route, phase)}],
    }
    body = json.dumps(payload).encode()
    actual_headers = {"x-api-key": KEYS[route], "anthropic-version": "2023-06-01"}
    actual_headers.update(headers or {})
    header = (
        f"POST {path or '/' + route + '/v1/messages'} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        + "".join(key + ": " + value + "\r\n" for key, value in actual_headers.items())
        + "Content-Length: " + str(len(body)) + "\r\n\r\n"
    ).encode()
    writer.write(header + body)
    await writer.drain()
    raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 3)
    status_ok = raw.startswith(b"HTTP/1.1 200 ")
    validator = SSECheck()
    while True:
        part = await asyncio.wait_for(reader.read(13), 3)
        if not part:
            break
        validator.feed(part)
    writer.close()
    await writer.wait_closed()
    return status_ok and validator.check(route, phase)


async def self_test():
    fixture = MessagesFixture()
    await fixture.start()
    checks = {}
    try:
        fixture.begin("new", ("a", "b"))
        success = await asyncio.gather(*(fixture_request(fixture, route, "new") for route in KEYS))
        checks["twoSourcesFragmentedSSE"] = all(success)
        checks["twoSourceKeysAndModels"] = all(
            row["keyMatchesRoute"] and row["modelMatchesSelection"] and row["versionMatches"]
            and row["expectedPromptPresent"] and not row["otherSourcePromptPresent"]
            and not row["bodyContainsAnyCanaryKey"] and row["responseCompleted"]
            for row in fixture.records
        )
        truncated = SSECheck()
        truncated.feed(sse_body("a", "new")[:-1])
        checks["truncatedLastFrameRejected"] = not truncated.check("a", "new")
        malformed = SSECheck()
        malformed.feed(b"event: message_stop\ndata: not-json\n\n")
        checks["malformedJSONRejected"] = not malformed.check("a", "new")
        wrong = SSECheck()
        wrong.feed(sse_body("a", "new").replace(b"event: message_stop", b"event: ping"))
        checks["eventTypeMismatchRejected"] = not wrong.check("a", "new")
        fixture.begin("load")
        await fixture_request(fixture, "a", "load")
        checks["automaticRequestDenied"] = fixture.auto_requests == 1
        fixture.begin("inline", ("a",))
        await fixture_request(fixture, "a", "inline", {"X-Api-Key": OVERRIDE_KEY})
        row = fixture.records[-1]
        checks["caseInsensitiveHeaderConflictObserved"] = not row["keyMatchesRoute"] and row["overrideKeyObserved"]
        await fixture_request(fixture, "a", "inline", path="/a/v1/responses")
        checks["wrongAPIPathRejected"] = fixture.rejected_requests == 2
    finally:
        checks["listenerAndWritersClosed"] = await fixture.close()
    return {"agentStarted": False, "passed": all(checks.values()), "checks": checks,
            "localRequests": fixture.total, "handlerErrors": fixture.handler_errors}
