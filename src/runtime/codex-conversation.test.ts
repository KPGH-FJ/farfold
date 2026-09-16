import { describe, expect, it } from "vitest";
import {
  applyCodexEvent,
  codexConversation,
  type CodexEventScope,
} from "./codex-conversation";
import type { HostRoutedEvent } from "./host-shadow";
const scope: CodexEventScope = {
  installationId: "install",
  runtimeBuildId: "build",
  connectionId: "connection",
  generation: 2,
  nativeSessionId: "thread",
};
function event(
  sequence: number,
  kind: string,
  payload: unknown,
): HostRoutedEvent {
  return {
    streamId: "stream",
    sequence,
    runtime: {
      productId: "codex",
      installationId: "install",
      adapterId: "codex-app-server",
    },
    runtimeBuildId: "build",
    connectionId: "connection",
    runtimeGeneration: 2,
    kind,
    preservation: "native",
    receivedAtMs: 1,
    nativeEnvelope: { generation: 2, kind, payload },
  };
}
const rpc = (
  sequence: number,
  method: string,
  params: Record<string, unknown>,
) =>
  event(sequence, "codex_rpc", {
    method,
    params: { threadId: "thread", ...params },
  });
describe("Codex native conversation", () => {
  it("leaves supported requests to the shared interaction container and diagnoses unknown approvals", () => {
    let state = codexConversation();
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
    ])
      state = applyCodexEvent(
        state,
        rpc(state.latestSequence + 1, method, { turnId: "native" }),
        scope,
      );
    expect(state.diagnostics).toEqual([]);
    expect(state.turns).toEqual([]);
    state = applyCodexEvent(
      state,
      rpc(state.latestSequence + 1, "item/future/requestApproval", {
        turnId: "native",
      }),
      scope,
    );
    expect(state.diagnostics).toEqual([
      "不支持的原生交互：item/future/requestApproval；未自动批准。",
    ]);
  });
  it("scopes events by full binding and generation and rejects duplicate delivery", () => {
    const base = codexConversation();
    const started = rpc(1, "turn/started", {
      turn: { id: "native", status: "inProgress", items: [] },
    });
    for (const change of [
      { runtimeBuildId: "other" },
      { connectionId: "other" },
      { runtimeGeneration: 1 },
      { runtime: { ...started.runtime, productId: "pi" } },
    ])
      expect(applyCodexEvent(base, { ...started, ...change }, scope)).toBe(
        base,
      );
    const state = applyCodexEvent(base, started, scope);
    expect(state.turns).toHaveLength(1);
    expect(applyCodexEvent(state, started, scope)).toBe(state);
  });
  it("renders native deltas and tools but waits for Host confirmation to finish", () => {
    let state = applyCodexEvent(
      codexConversation(),
      event(1, "codex_turn_state", {
        nativeSessionId: "thread",
        hostTurnId: "host",
        phase: "submitting",
      }),
      scope,
    );
    state = applyCodexEvent(
      state,
      rpc(2, "turn/started", {
        turn: { id: "native", status: "inProgress", items: [] },
      }),
      scope,
    );
    state = applyCodexEvent(
      state,
      rpc(3, "item/started", {
        turnId: "native",
        item: { id: "answer", type: "agentMessage", text: "" },
      }),
      scope,
    );
    state = applyCodexEvent(
      state,
      rpc(4, "item/agentMessage/delta", {
        turnId: "native",
        itemId: "answer",
        delta: "真实答复",
      }),
      scope,
    );
    expect(state.turns[0].items[0].text).toBe("真实答复");
    state = applyCodexEvent(
      state,
      rpc(5, "turn/completed", {
        turn: { id: "native", status: "completed", items: [] },
      }),
      scope,
    );
    expect(state.phase).toBe("submitting");
    expect(state.turns[0].items[0].text).toBe("真实答复");
    state = applyCodexEvent(
      state,
      event(6, "codex_turn_state", {
        nativeSessionId: "thread",
        hostTurnId: "host",
        nativeTurnId: "native",
        phase: "completed",
      }),
      scope,
    );
    expect(state.phase).toBe("completed");
    state = applyCodexEvent(
      state,
      event(7, "transport_error", { message: "exit" }),
      scope,
    );
    expect(state.phase).toBe("completed");
  });
  it("late terminal state cannot complete another Host turn", () => {
    let state = applyCodexEvent(
      codexConversation(),
      event(1, "codex_turn_state", {
        nativeSessionId: "thread",
        hostTurnId: "new",
        phase: "submitting",
      }),
      scope,
    );
    state = applyCodexEvent(
      state,
      event(2, "codex_turn_state", {
        nativeSessionId: "thread",
        hostTurnId: "old",
        phase: "completed",
      }),
      scope,
    );
    expect(state.phase).toBe("submitting");
    state = applyCodexEvent(
      state,
      event(3, "transport_gap", { dropped: 3 }),
      scope,
    );
    expect(state.phase).toBe("unknown");
    expect(state.truncated).toBe(true);
  });
  it("does not invent a missing item to display orphaned deltas", () => {
    const state = applyCodexEvent(
      codexConversation(),
      rpc(1, "item/agentMessage/delta", {
        turnId: "native",
        itemId: "missing",
        delta: "not fabricated",
      }),
      scope,
    );
    expect(state.turns).toEqual([]);
    expect(state.truncated).toBe(true);
  });
});
