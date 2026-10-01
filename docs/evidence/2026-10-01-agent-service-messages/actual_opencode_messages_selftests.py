"""Test harness bookkeeping only; never spawn OpenCode or any child process."""

import asyncio
import copy
import importlib.util
from pathlib import Path
import uuid


def runtime_module():
    source = Path(__file__).with_name("actual-opencode-messages-probe.py")
    spec = importlib.util.spec_from_file_location("messages_canary_test_runtime", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def run():
    runtime = runtime_module()
    checks = {}
    template = {
        "agentInitialized": True, "modelOptionMatched": True,
        "explicitPromptDispatched": True, "closedConfirmed": True,
        "promptCompleted": False, "fixedFailure": "RPC_REJECTED",
        "promptRejectedBeforeHTTP": True, "wrongAPIPathObserved": False,
        "noAutomaticHTTPBeforeExplicitPrompt": True,
    }
    for name, changes in (
        ("initializeRejectionNotRiskProof", {"agentInitialized": False, "explicitPromptDispatched": False}),
        ("modelRejectionNotRiskProof", {"modelOptionMatched": False, "explicitPromptDispatched": False}),
        ("timeoutNotExpectedRejection", {"fixedFailure": "RPC_TIMEOUT", "promptRejectedBeforeHTTP": False}),
    ):
        row = {**template, **changes}
        runtime.classify_inline("nonempty_auth_token", row, [])
        checks[name] = not row["expectedOutcomeMatched"]
    row = copy.deepcopy(template)
    runtime.classify_inline("nonempty_auth_token", row, [])
    checks["explicitPromptRejectionIsNarrowExpectedObservation"] = row["expectedOutcomeMatched"]
    row = {**template, "fixedFailure": "RPC_TIMEOUT", "promptRejectedBeforeHTTP": False,
           "wrongAPIPathObserved": True}
    runtime.classify_inline("model_provider_override", row, [])
    checks["wrongPathWithoutCompletedObservationNotPass"] = not row["expectedOutcomeMatched"]

    class NoChildProbe:
        def __init__(self, cwd, environment):
            self.process = None

        async def start(self):
            pass

        async def initialize(self):
            await asyncio.Event().wait()

        async def close(self):
            return True  # No OS child was created by this test.

        def summary(self):
            return {"childStarted": False, "processReaped": False,
                    "groupEndedConfirmed": False}

    real_wait_for = asyncio.wait_for

    async def short_deadline(awaitable, timeout):
        return await real_wait_for(awaitable, 0.02 if timeout == 720 else timeout)

    # The test-only replacement does not affect product or harness source.
    runtime.ACPProbe = NoChildProbe
    path = Path("/tmp") / ("farfold-actual-messages-selftest-" + uuid.uuid4().hex)
    try:
        asyncio.wait_for = short_deadline
        report = await runtime.actual(str(path))
    finally:
        asyncio.wait_for = real_wait_for
    checks["deadlineReportRetained"] = report.get("fixedFailure") == "TOTAL_TIMEOUT"
    checks["partialPositivePhaseRetained"] = len(report["positivePhases"]) == 1
    checks["deadlineNotPassed"] = not report["passed"] and not report["positivePassed"]
    checks["deadlineChildNotStarted"] = not report["agentStarted"] and not report["actualOpenCodeExecuted"]
    checks["deadlineCleanupConfirmed"] = report["taskCwdDeleted"] and report["listenerClosed"] and not path.exists()
    return {"agentStarted": False, "passed": all(checks.values()), "checks": checks}
