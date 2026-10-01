"""HTTP phase and report regressions only; never start OpenCode or a child."""

import asyncio
from pathlib import Path
import uuid

from actual_opencode_messages_selftests import runtime_module
from actual_opencode_messages_fixture import MessagesFixture, fixture_request


def completed_inline():
    return {
        "agentInitialized": True, "modelOptionMatched": True,
        "explicitPromptDispatched": True, "closedConfirmed": True,
        "promptCompleted": False, "fixedFailure": "RPC_REJECTED",
        "promptRejectedBeforeHTTP": False, "wrongAPIPathObserved": False,
        "noAutomaticHTTPBeforeExplicitPrompt": False,
    }


def unauthorized_override():
    return {
        "validMessagesPath": True, "authorizedByExplicitPrompt": False,
        "modelMatchesSelection": False, "keyMatchesRoute": False,
        "versionMatches": True, "expectedPromptPresent": True,
        "streamRequested": True, "responseCompleted": False,
        "otherRouteKeyPresent": False, "bearerPresent": False,
        "otherSourcePromptPresent": False, "otherSourceReceiptPresent": False,
        "bodyContainsAnyCanaryKey": False, "overriddenModelObserved": True,
        "overrideKeyObserved": True,
    }


async def run():
    checks = {}
    runtime = runtime_module()
    for case, name in (
        ("model_id_override", "prePromptModelOverrideNotProof"),
        ("provider_headers_override", "prePromptHeaderOverrideNotProof"),
    ):
        row = completed_inline()
        runtime.classify_inline(case, row, [unauthorized_override()])
        checks[name] = not row["expectedOutcomeMatched"]
    row = {**completed_inline(), "wrongAPIPathObserved": True}
    runtime.classify_inline("model_provider_override", row, [])
    checks["prePromptWrongAPIPathNotProof"] = not row["expectedOutcomeMatched"]

    fixture = MessagesFixture()
    await fixture.start()
    try:
        fixture.begin("new")
        await fixture_request(fixture, "a", "new", path="/unknown-path")
        checks["unknownPathBeforePromptCountsAutomatic"] = fixture.auto_requests == 1
        fixture.begin("inline", ("a",))
        for _ in range(40):
            await fixture_request(fixture, "a", "inline")
        checks["observationsHaveFixedBound"] = len(fixture.records) <= 32
    finally:
        checks["timingFixtureClosed"] = await fixture.close()

    class ArrayReader:
        async def readuntil(self, end):
            return b"POST /a/v1/messages HTTP/1.1\r\nContent-Length: 2\r\n\r\n"

        async def readexactly(self, length):
            return b"[]"

    class NoSocketWriter:
        def write(self, body):
            pass

        async def drain(self):
            pass

        def close(self):
            pass

        async def wait_closed(self):
            pass

    fixture = MessagesFixture()
    try:
        await fixture.handle(ArrayReader(), NoSocketWriter())
    except Exception:
        pass  # Only the fixed count below is reported, never exception data.
    checks["arrayJSONRecordedAsHandlerError"] = fixture.handler_errors == 1
    fixture = MessagesFixture()
    fixture.tasks.add(asyncio.current_task())
    checks["inflightHTTPBlocksPromptPermission"] = not runtime.preparation_http_clean(fixture, 0)

    async def fake_positive(cwd, fixture, providers, processes, rows):
        rows.append({"completed": True})

    async def fake_inline(case, cwd, fixture, providers, processes, rows):
        row = {"case": case, "closedConfirmed": True,
               "observationCompleted": True, "expectedOutcomeMatched": True}
        rows.append(row)
        return row

    for attribute, check in (
        ("auto_requests", "overallRejectsAutomaticHTTP"),
        ("handler_errors", "overallRejectsHandlerError"),
        ("close_handler_error", "overallCountsLateCloseHandlerError"),
    ):
        runtime = runtime_module()

        class CountedFixture(MessagesFixture):
            async def start(self):
                await super().start()
                if attribute != "close_handler_error":
                    setattr(self, attribute, 1)

            async def close(self):
                result = await super().close()
                if attribute == "close_handler_error":
                    self.handler_errors += 1
                return result

        runtime.MessagesFixture = CountedFixture
        runtime.positive = fake_positive
        runtime.inline_case = fake_inline
        path = Path("/tmp") / ("farfold-actual-messages-timing-" + uuid.uuid4().hex)
        report = await runtime.actual(str(path))
        checks[check] = not report["passed"] and report["taskCwdDeleted"] and not report["agentStarted"]

    runtime = runtime_module()
    config = runtime.configuration(type("LocalFixture", (), {"port": 1})(), {"a": "a", "b": "b"})
    checks["positiveDoesNotInventModelLimit"] = all(
        "limit" not in provider["models"][runtime.MAP_KEY]
        for provider in config["provider"].values()
    )

    fixture = MessagesFixture()
    await fixture.start()
    runtime = runtime_module()
    runtime.QUIET_SECONDS = 0

    class NoChildProbe:
        def __init__(self, cwd, environment):
            self.process = None
            self.protected = {}
            self.text = {}

        async def start(self):
            pass

        async def initialize(self):
            await fixture_request(fixture, "a", "new", path="/unknown-path")
            return True

        async def close(self):
            return True

    async def fake_open(probe, cwd, selected):
        probe.protected[selected] = {"model": ("select", selected)}
        route = "a" if selected.startswith("a/") else "b"
        probe.text[selected] = runtime.receipt_marker(route, "new")
        return selected

    async def fake_prompt(probe, session, route, phase):
        return True

    runtime.ACPProbe = NoChildProbe
    runtime.open_new = fake_open
    runtime.send_prompt = fake_prompt
    rows = []
    failure = None
    try:
        await runtime.positive(Path("/tmp"), fixture, {"a": "a", "b": "b"}, [], rows)
    except runtime.ProbeFailure as error:
        failure = error.code
    finally:
        await fixture.close()
    checks["initializeWrongPathStopsBeforePrompt"] = (
        failure == "AUTOMATIC_HTTP" and len(rows) == 1
        and not rows[0]["noAutomaticHTTPBeforeExplicitPrompt"]
    )

    fixture = MessagesFixture()
    await fixture.start()

    class EarlyHeaderProbe(NoChildProbe):
        async def initialize(self):
            await fixture_request(fixture, "a", "inline", {"X-Api-Key": runtime.OVERRIDE_KEY})
            return True

    runtime.ACPProbe = EarlyHeaderProbe
    rows = []
    try:
        result = await runtime.inline_case(
            "provider_headers_override", Path("/tmp"), fixture, {"a": "a", "b": "b"}, [], rows,
        )
        checks["inlinePreparationRequestStopsBeforePrompt"] = (
            result.get("fixedFailure") == "AUTOMATIC_HTTP"
            and not result["explicitPromptDispatched"]
            and not result["expectedOutcomeMatched"]
        )
    finally:
        await fixture.close()
    return {"agentStarted": False, "passed": all(checks.values()), "checks": checks}
