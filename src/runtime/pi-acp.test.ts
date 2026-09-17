import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import {
  abortPiAcpTurn,
  intervenePiAcpTurn,
  readPiAcpWorkspace,
  readPiAcpWorkspaceSnapshot,
  piAcpPendingDialogs,
  piAcpProviderProjection,
  respondPiAcpDialog,
  setPiAcpConfigOption,
  applyPiAcpProvider,
  submitPiAcpTurn,
  piAcpTargetForBinding,
  piAcpCleanupTargetForBinding,
  piAcpNativeEvent,
  piAcpControlOutput,
  piAcpControlScope,
  appendPiAcpControlOutput,
  piAcpActiveTurn,
  type PiAcpStatus,
} from "./pi-acp";
import type {
  HostRoutedEvent,
  HostSessionBinding,
  HostPendingInteraction,
} from "./host-shadow";
import type { HostProviderProjectionSnapshot } from "./provider-projection";
import {
  stopHostPiAcpRuntime,
  stopHostPiRuntime,
} from "./host-runtime-lifecycle";
import { sessionStartInput } from "./session-start";

const target = {
  farfoldSessionId: "host",
  nativeSessionId: "native",
  runtimeGeneration: 9,
};
const turn = { ...target, turnId: "turn" };

const binding: HostSessionBinding = {
  farfoldSessionId: "host",
  nativeSessionId: "native",
  runtimeProductId: "pi",
  installationId: "bundled-pi-acp",
  adapterId: "pi-acp-stdio-v1",
  runtimeBuildId: "build",
  connectionId: "connection",
  projectId: "project",
  projectPath: "/project",
  projectName: "Project",
  workingCopyId: "wc",
  workingCopyPath: "/project",
  workingCopyKind: "root",
  branchName: null,
  nativeLocatorRegistered: false,
  title: "Pi",
  titleSource: "native",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
const status: PiAcpStatus = {
  running: true,
  generation: 9,
  runtime: {
    productId: "pi",
    installationId: binding.installationId,
    adapterId: binding.adapterId,
  },
  runtimeBuildId: binding.runtimeBuildId,
  runtimeConnectionId: binding.connectionId,
  cwd: binding.workingCopyPath,
  nativeSession: {
    version: 1,
    sessionId: "native",
    sessionFile: "/private/native.jsonl",
    cwd: "/project",
  },
  configOptions: [],
  managedProvider: null,
  modelSource: null,
  nativeAdmissionReady: false,
  nativeFirstUse: null,
  lastConfirmedModelSource: null,
  configurationState: "confirmed",
  lastError: null,
  droppedEvents: 0,
};

describe("Pi ACP Host bindings", () => {
  it("accepts only bound tagged Adapter control text; native mirrors and stale envelopes stay out", () => {
    const event = {
      runtime: status.runtime,
      runtimeBuildId: binding.runtimeBuildId,
      connectionId: binding.connectionId,
      runtimeGeneration: 9,
      preservation: "native",
      nativeEnvelope: {
        kind: "acp",
        generation: 9,
        payload: {
          method: "session/update",
          params: {
            sessionId: "native",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Session: native" },
              _meta: {
                farfoldPi: {
                  version: 1,
                  origin: "adapter_control",
                  id: "control-1",
                },
              },
            },
          },
        },
      },
    } as unknown as HostRoutedEvent;
    expect(piAcpControlOutput(event, binding, 9)).toEqual({
      id: "control-1",
      text: "Session: native",
    });
    expect(piAcpControlOutput(event, binding, 8)).toBeNull();
    for (const key of [
      "runtimeBuildId",
      "connectionId",
      "nativeSessionId",
      "installationId",
      "adapterId",
    ] as const)
      expect(
        piAcpControlOutput(event, { ...binding, [key]: "other" }, 9),
      ).toBeNull();
    const mirror = structuredClone(event);
    (mirror.nativeEnvelope as any).payload.params.update._meta = {};
    expect(piAcpControlOutput(mirror, binding, 9)).toBeNull();
    expect(piAcpNativeEvent(event, binding, 9)).toBeNull();
    const outputs = [{ id: "control-1", text: "Session: native" }];
    expect(appendPiAcpControlOutput(outputs, outputs[0])).toBe(outputs);
    expect(
      appendPiAcpControlOutput(outputs, { id: "control-2", text: "Next" }),
    ).toHaveLength(2);
    expect(piAcpControlScope(binding, 9)).not.toBe(
      piAcpControlScope(binding, 10),
    );
    expect(piAcpControlScope(binding, 9)).not.toBe(
      piAcpControlScope({ ...binding, nativeSessionId: "other" }, 9),
    );
  });
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("reads one native snapshot section at a time and never substitutes an RPC response", async () => {
    let active = 0;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      expect(active++).toBe(0);
      await Promise.resolve();
      active--;
      const { section } = (args as { input: { section: string } }).input;
      return section === "state" ? { sessionId: "native" } : { section };
    });
    const result = await readPiAcpWorkspaceSnapshot(target, () => true);
    expect(result?.map(([section]) => section)).toEqual([
      "state",
      "models",
      "thinking_levels",
      "messages",
      "commands",
      "stats",
    ]);
    expect(invoke).toHaveBeenCalledTimes(6);
    for (const [command, args] of vi.mocked(invoke).mock.calls) {
      expect(command).toBe("pi_acp_workspace");
      expect(args).toMatchObject({ input: target });
    }
    expect(result?.[0][1]).toEqual({ sessionId: "native" });
  });

  it.each(["connection change", "live message arrived"])(
    "discards the whole read and stops dispatch after %s",
    async () => {
      let current = true;
      vi.mocked(invoke).mockImplementation(async () => {
        current = false;
        return { sessionId: "native" };
      });
      expect(
        await readPiAcpWorkspaceSnapshot(target, () => current),
      ).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(await readPiAcpWorkspaceSnapshot(target, () => false)).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects wrong native state and partial read failures without publishing history", async () => {
    vi.mocked(invoke).mockResolvedValue({ sessionId: "other" });
    await expect(
      readPiAcpWorkspaceSnapshot(target, () => true),
    ).rejects.toThrow("原生会话");
    expect(invoke).toHaveBeenCalledTimes(1);
    vi.mocked(invoke)
      .mockReset()
      .mockResolvedValueOnce({ sessionId: "native" })
      .mockRejectedValueOnce(new Error("read failed"));
    await expect(
      readPiAcpWorkspaceSnapshot(target, () => true),
    ).rejects.toThrow("read failed");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("uses shared dialog request identities and excludes other generations and native sessions", () => {
    const dialog: HostPendingInteraction = {
      runtime: status.runtime!,
      runtimeGeneration: 9,
      interactionId: "7",
      nativeSessionId: "native",
      kind: "pi_extension_dialog",
      state: "pending",
      piAcp: {
        requestKey: "7",
        nativeRequestId: "ui",
        nativeSessionId: "native",
        nativeEvent: {
          type: "extension_ui_request",
          method: "confirm",
          id: "ui",
          title: "Continue?",
        },
      },
    };
    expect(piAcpPendingDialogs(status, binding, [dialog])).toEqual([dialog]);
    const wrong = [
      { ...dialog, runtimeGeneration: 8 },
      { ...dialog, nativeSessionId: "other" },
      { ...dialog, runtime: { ...dialog.runtime, installationId: "other" } },
      { ...dialog, piAcp: { ...dialog.piAcp!, nativeRequestId: "old-ui" } },
      { ...dialog, piAcp: undefined },
    ];
    expect(piAcpPendingDialogs(status, binding, wrong)).toEqual([]);
    expect(
      piAcpPendingDialogs({ ...status, running: false }, binding, [dialog]),
    ).toEqual([]);
  });

  it("projects only the bound Provider version, never a different model or saved-current version", () => {
    const managed = {
      providerConnectionId: "provider",
      providerConfigVersionId: "v1",
      runtimeProviderId: "native-provider",
      runtimeModelId: "native-provider/model",
    };
    const connected: PiAcpStatus = {
      ...status,
      managedProvider: managed,
      modelSource: { kind: "managed_version", binding: managed },
    };
    const snapshot: HostProviderProjectionSnapshot = {
      connection: {
        providerConnectionId: "provider",
        providerKey: "key",
        label: "Provider",
        source: "farfold_managed",
        currentConfigVersionId: "v2",
        createdAt: 1,
        updatedAt: 2,
      },
      projections: [
        {
          ...managed,
          runtimeProductId: "pi",
          installationId: binding.installationId,
          runtimeConnectionId: binding.connectionId,
          configVersionId: "v1",
          saveState: "saved",
          applyState: "applied",
          requestState: "verified_success",
          requestVerifiedVersionId: "v1",
          activeTaskPolicy: "current_task_keeps_bound_config",
          detail: null,
          updatedAt: 1,
        },
      ],
    };
    expect(piAcpProviderProjection(connected, binding, snapshot)).toMatchObject(
      {
        providerConfigVersionId: "v1",
        requestVerifiedVersionId: "v1",
        requestState: "verified_success",
      },
    );
    expect(
      piAcpProviderProjection(
        { ...connected, configurationState: "unknown" } as PiAcpStatus,
        binding,
        snapshot,
      ),
    ).toBeNull();
    for (const field of [
      "configVersionId",
      "runtimeConnectionId",
      "runtimeProviderId",
      "runtimeModelId",
      "installationId",
    ] as const) {
      expect(
        piAcpProviderProjection(connected, binding, {
          ...snapshot,
          projections: [{ ...snapshot.projections[0], [field]: "other" }],
        }),
      ).toBeNull();
    }
    expect(piAcpProviderProjection(connected, binding, null)).toBeNull();
    expect(piAcpProviderProjection(status, binding, snapshot)).toBeNull();
    for (const modelSource of [
      null,
      {
        kind: "native_observation" as const,
        runtimeProviderId: managed.runtimeProviderId,
        runtimeModelId: managed.runtimeModelId,
        nativeModelId: "model",
      },
    ]) {
      expect(
        piAcpProviderProjection(
          { ...connected, modelSource },
          binding,
          snapshot,
        ),
      ).toBeNull();
    }
  });

  it("reads exact active/unknown task identity from the shared coordinator, not native idle events", async () => {
    const active = {
      ...turn,
      runtimeProductId: "pi",
      installationId: binding.installationId,
      runtimeConnectionId: binding.connectionId,
      outcomeUnknown: true,
      abortRequested: true,
    };
    vi.mocked(invoke).mockResolvedValue({ activeTurns: [active] });
    expect(await piAcpActiveTurn(binding, 9)).toEqual(active);
    expect(invoke).toHaveBeenCalledWith("turn_coordinator_snapshot");
    expect(await piAcpActiveTurn(binding, 10)).toBeNull();
    expect(
      await piAcpActiveTurn({ ...binding, connectionId: "other" }, 9),
    ).toBeNull();
    expect(
      await piAcpActiveTurn({ ...binding, nativeSessionId: "other" }, 9),
    ).toBeNull();
  });

  it("finds only the full live binding, allowing a not-yet-persisted native Session", () => {
    expect(piAcpTargetForBinding(status, binding)).toEqual(target);
    for (const field of [
      "runtimeProductId",
      "installationId",
      "adapterId",
      "runtimeBuildId",
      "connectionId",
      "nativeSessionId",
      "workingCopyPath",
    ] as const) {
      expect(
        piAcpTargetForBinding(status, { ...binding, [field]: "different" }),
      ).toBeNull();
    }
    expect(
      piAcpTargetForBinding(status, { ...binding, archivedAt: 2 }),
    ).toBeNull();
    expect(
      piAcpTargetForBinding({ ...status, running: false }, binding),
    ).toBeNull();
    expect(
      piAcpTargetForBinding({ ...status, generation: 0 }, binding),
    ).toBeNull();
  });

  it("allows exact identity cleanup after idle process exit but never treats it as a live task target", async () => {
    const dead = { ...status, running: false, lastError: "EOF" };
    expect(piAcpTargetForBinding(dead, binding)).toBeNull();
    expect(piAcpCleanupTargetForBinding(dead, binding)).toEqual(target);
    vi.mocked(invoke).mockResolvedValue({
      runtimeProductId: "pi",
      status: dead,
    });
    await stopHostPiAcpRuntime(piAcpCleanupTargetForBinding(dead, binding)!);
    expect(invoke).toHaveBeenCalledWith("host_managed_runtime_stop", {
      input: { runtimeProductId: "pi", session: target },
    });
    for (const field of [
      "runtimeBuildId",
      "connectionId",
      "nativeSessionId",
      "workingCopyPath",
      "installationId",
      "adapterId",
    ] as const) {
      expect(
        piAcpCleanupTargetForBinding(dead, { ...binding, [field]: "other" }),
      ).toBeNull();
    }
    expect(
      piAcpCleanupTargetForBinding({ ...dead, runtime: null }, binding),
    ).toBeNull();
    expect(
      piAcpCleanupTargetForBinding({ ...dead, generation: 0 }, binding),
    ).toBeNull();
  });

  it("preserves unknown native envelopes only for the exact ACP connection, generation and Session", () => {
    const native = {
      type: "future_event",
      nested: { future: false },
      text: "",
    };
    const event: HostRoutedEvent = {
      streamId: "stream",
      sequence: 7,
      runtime: status.runtime!,
      runtimeBuildId: "build",
      connectionId: "connection",
      runtimeGeneration: 9,
      kind: "acp",
      preservation: "native",
      receivedAtMs: 1,
      nativeEnvelope: {
        generation: 9,
        kind: "acp",
        payload: {
          method: "_pi/event",
          params: { version: 1, sessionId: "native", event: native },
        },
      },
    };
    expect(piAcpNativeEvent(event, binding, 9)).toBe(native);
    expect(
      piAcpNativeEvent({ ...event, connectionId: "other" }, binding, 9),
    ).toBeNull();
    expect(
      piAcpNativeEvent({ ...event, runtimeBuildId: "other" }, binding, 9),
    ).toBeNull();
    expect(piAcpNativeEvent(event, binding, 10)).toBeNull();
    expect(
      piAcpNativeEvent(event, { ...binding, nativeSessionId: "other" }, 9),
    ).toBeNull();
    expect(
      piAcpNativeEvent(
        { ...event, preservation: "oversized_dropped" },
        binding,
        9,
      ),
    ).toBeNull();
  });

  it("preserves the exact target across ordinary tasks, reads and configuration", async () => {
    await submitPiAcpTurn({ ...target, text: "Task" });
    await readPiAcpWorkspace({ ...target, section: "entries" });
    await setPiAcpConfigOption({
      ...target,
      configId: "thought_level",
      value: "off",
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      [
        "host_turn_submit",
        {
          input: {
            farfoldSessionId: target.farfoldSessionId,
            nativeSessionId: target.nativeSessionId,
            text: "Task",
          },
        },
      ],
      ["pi_acp_workspace", { input: { ...target, section: "entries" } }],
      [
        "pi_acp_set_config_option",
        { input: { ...target, configId: "thought_level", value: "off" } },
      ],
    ]);
  });

  it("applies an exact saved version to the same session without accepting a runtime alias or restarting", async () => {
    const provider = {
      providerConnectionId: "provider",
      providerConfigVersionId: "version",
    };
    vi.mocked(invoke).mockResolvedValue(status);
    expect(await applyPiAcpProvider({ ...target, provider })).toBe(status);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["pi_acp_apply_provider", { input: { ...target, provider } }],
    ]);
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("refresh outcome unknown"),
    );
    await expect(applyPiAcpProvider({ ...target, provider })).rejects.toThrow(
      "refresh outcome unknown",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("uses the exact turn token for stop and native interventions without creating another prompt", async () => {
    await abortPiAcpTurn(turn);
    for (const kind of ["steer", "follow_up"] as const) {
      await intervenePiAcpTurn({ ...turn, kind, message: kind });
      expect(invoke).toHaveBeenLastCalledWith("host_pi_acp_intervene", {
        input: { ...turn, kind, message: kind },
      });
    }
    expect(invoke).toHaveBeenCalledWith("host_turn_abort", {
      input: {
        farfoldSessionId: turn.farfoldSessionId,
        nativeSessionId: turn.nativeSessionId,
      },
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([name]) => name !== "host_turn_submit"),
    ).toBe(true);
  });

  it("keeps ACP/native request IDs and false, empty text and cancellation distinct", async () => {
    for (const answer of [
      { kind: "confirm", confirmed: false },
      { kind: "text", value: "" },
      { kind: "cancel" },
    ] as const) {
      const input = {
        ...target,
        requestId: "7",
        nativeRequestId: "dialog-native",
        answer,
      };
      await respondPiAcpDialog(input);
      expect(invoke).toHaveBeenLastCalledWith("pi_acp_respond_dialog", {
        input,
      });
    }
  });

  it("distinguishes idle disconnect from exact-turn recovery and rejects legacy status", async () => {
    for (const input of [target, turn]) {
      vi.mocked(invoke).mockResolvedValueOnce({
        runtimeProductId: "pi",
        status: { running: false, nativeSession: null, configOptions: [] },
      });
      await stopHostPiAcpRuntime(input);
      expect(invoke).toHaveBeenLastCalledWith("host_managed_runtime_stop", {
        input: {
          runtimeProductId: "pi",
          ...("turnId" in input ? { recovery: input } : { session: input }),
        },
      });
    }
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "pi",
      status: { state: "stopped" },
    });
    await expect(stopHostPiAcpRuntime(target)).rejects.toThrow("Pi ACP");
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "pi",
      status: { nativeSession: null, configOptions: [] },
    });
    await expect(stopHostPiRuntime()).rejects.toThrow();
  });

  it("creates Pi ACP through the ordinary Host entry without substituting legacy identity", () => {
    const options = {
      runtimeProductId: "pi",
      projectTrust: "ignore",
      adapterId: "pi-acp-stdio-v1",
      managedProvider: {
        providerConnectionId: "provider",
        providerConfigVersionId: "version",
      },
    } as const;
    expect(sessionStartInput("/tmp/project", options)).toEqual({
      installationId: "bundled-pi-acp",
      connectionId: "pi-acp-managed-local-v1",
      workingCopyPath: "/tmp/project",
      options,
    });
    expect(() =>
      sessionStartInput("/tmp/project", {
        ...options,
        managedProvider: undefined,
      }),
    ).toThrow("Provider");
    expect(
      sessionStartInput("/tmp/project", {
        runtimeProductId: "pi",
        projectTrust: "ignore",
        adapterId: "pi-acp-stdio-v1",
        nativeFirstUse: true,
      }),
    ).toEqual({
      installationId: "bundled-pi-acp",
      connectionId: "pi-acp-managed-local-v1",
      workingCopyPath: "/tmp/project",
      options: {
        runtimeProductId: "pi",
        projectTrust: "ignore",
        adapterId: "pi-acp-stdio-v1",
        nativeFirstUse: true,
      },
    });
    expect(() =>
      sessionStartInput("/tmp/project", {
        ...options,
        nativeFirstUse: true,
      }),
    ).toThrow("Provider");
    expect(() =>
      sessionStartInput("/tmp/project", options, {
        installationId: "bundled-pi",
        connectionId: "legacy",
      }),
    ).toThrow("连接");
  });
});
