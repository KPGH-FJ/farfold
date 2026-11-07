import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  listeners: new Map<string, (event: { payload: number }) => void>(),
  hooks: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  cursor: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    callback: (event: { payload: number }) => void,
  ) => {
    h.listeners.set(name, callback);
    return () => h.listeners.delete(name);
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = h.cursor++;
    if (i === h.hooks.length) h.hooks.push(initial);
    return [h.hooks[i], (next: unknown) => (h.hooks[i] = next)];
  },
  useRef(current: unknown) {
    return (h.hooks[h.cursor++] ??= { current });
  },
  useEffect(effect: () => void | (() => void)) {
    h.effects.push(effect);
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));

function buttonByText(
  node: ReactNode,
  label: string,
): (() => void) | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child))
      continue;
    if (child.type === "button" && child.props.children === label)
      return child.props.onClick;
    const nested = buttonByText(child.props.children, label);
    if (nested) return nested;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  h.invoke.mockReset();
  h.openUrl.mockReset();
  h.listeners.clear();
  h.hooks.length = 0;
  h.effects.length = 0;
});

type ExitChoice = "review" | "stay" | "leave";

async function mountQuitProbe() {
  vi.useFakeTimers();
  const { DraftStartup } = await import("./DraftStartup");
  const { threads } = await import("../runtime/sessions");
  const { composerDrafts, draftPersistence } =
    await import("../runtime/drafts");
  const { EXIT_IMPACT } = await import("../runtime/exit_impact");
  let releaseWrite!: () => void;
  const heldWrite = new Promise<void>((resolve) => (releaseWrite = resolve));
  let holdWrite = false;
  let writing = false;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (
      command === "settings_set" &&
      args.key === "unsentWork.v1" &&
      holdWrite
    ) {
      writing = true;
      await heldWrite;
      writing = false;
    }
    return command === "session_permission_respond" ||
      command === "session_elicitation_respond"
      ? { status: "submitted" }
      : null;
  });
  const render = () => {
    h.cursor = 0;
    return DraftStartup({ children: null });
  };
  const click = (label: "stay" | "exit") => {
    const button = buttonByText(render(), EXIT_IMPACT[label]);
    expect(button).toBeDefined();
    button!();
  };
  render();
  const cleanup = h.effects.splice(0).map((effect) => effect());
  await vi.waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith("app_drafts_ready"),
  );
  return {
    threads,
    seed(id: string, event: unknown) {
      const key = `agent:/approval-exit:${id}`;
      const state = threads.markOpenFailed(
        key,
        "agent",
        "/approval-exit",
        id,
        "fixture",
      );
      state.openError = null;
      state.connectionId = `owned-${id}`;
      state.running = true;
      (
        threads as unknown as {
          applyChannelEvent(key: string, event: unknown): void;
        }
      ).applyChannelEvent(key, event);
      return state;
    },
    async requestExit(exit: ExitChoice, token: number) {
      h.listeners.get("app:save-before-exit")!({ payload: token });
      expect(draftPersistence.snapshot().interactionLocked).toBe(true);
      if (exit === "stay") {
        click("stay");
        await vi.waitFor(() =>
          expect(draftPersistence.snapshot().interactionLocked).toBe(false),
        );
      } else if (exit === "leave") {
        holdWrite = true;
        composerDrafts.update("new", (draft) => ({
          ...draft,
          text: "Keep unsent draft",
        }));
        click("exit");
        await vi.waitFor(() => expect(writing).toBe(true));
        expect(h.invoke).not.toHaveBeenCalledWith(
          "app_exit_after_save",
          expect.anything(),
        );
      }
    },
    async finishExit(exit: ExitChoice, token: number) {
      if (exit === "leave") {
        expect(writing).toBe(true);
        expect(draftPersistence.snapshot().interactionLocked).toBe(true);
        expect(h.invoke).not.toHaveBeenCalledWith(
          "app_exit_after_save",
          expect.anything(),
        );
        releaseWrite();
        await vi.waitFor(() =>
          expect(h.invoke).toHaveBeenCalledWith("app_exit_after_save", {
            token,
            confirmActivity: true,
          }),
        );
      } else {
        if (exit === "review") click("stay");
        expect(h.invoke).toHaveBeenCalledWith("app_exit_cancel", { token });
        expect(h.invoke).not.toHaveBeenCalledWith(
          "app_exit_after_save",
          expect.anything(),
        );
      }
    },
    dispose() {
      releaseWrite();
      cleanup.forEach((dispose) => dispose?.());
    },
  };
}

it.each(["review", "stay", "leave"] as const)(
  "keeps an undoable approval pending when a native quit attempt reaches %s",
  async (exit) => {
    const { permissionDecision } =
      await import("../runtime/permission_options");
    const { threads, seed, requestExit, finishExit, dispose } =
      await mountQuitProbe();
    const permission = (id: string) => ({
      kind: "permissionRequest",
      requestId: `permission-${id}`,
      toolCall: { toolCallId: `tool-${id}`, title: `Tool ${id}` },
      options: [
        { optionId: "always", name: "Allow always", kind: "allow_always" },
      ],
    });
    try {
      const a = seed("A", permission("A"));
      const b = seed("B", permission("B"));
      const approval = a.pendingPermissions[0];
      const sibling = b.pendingPermissions[0];
      const choice = permissionDecision(approval.options[0]);
      const approve = () =>
        threads.decidePermission(
          a.key,
          approval.requestId,
          choice.optionId,
          choice.label,
          choice.allow,
          choice.undoable,
        );
      const approvalCalls = () =>
        h.invoke.mock.calls.filter(
          ([cmd]) => cmd === "session_permission_respond",
        );
      approve();
      expect(approval.decision?.undoable).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(approvalCalls()).toEqual([]);

      await requestExit(exit, 95);

      await vi.advanceTimersByTimeAsync(5000);
      expect.soft(approvalCalls()).toEqual([]);
      expect.soft(a.pendingPermissions[0]).toBe(approval);
      expect.soft(approval.status).toBe("pending");
      expect.soft(approval.decision).toBeNull();
      expect(b.pendingPermissions[0]).toBe(sibling);
      expect(sibling.decision).toBeNull();
      await finishExit(exit, 95);
      if (exit === "stay") {
        approve();
        expect(approval.decision?.undoable).toBe(true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(approvalCalls()).toEqual([
          [
            "session_permission_respond",
            {
              sessionId: "A",
              requestId: approval.requestId,
              optionId: choice.optionId,
            },
          ],
        ]);
        expect(a.pendingPermissions).toEqual([]);
        expect(b.pendingPermissions[0]).toBe(sibling);
        expect(sibling.decision).toBeNull();
      }
    } finally {
      dispose();
    }
  },
);

it.each(["review", "stay", "leave"] as const)(
  "keeps a URL inquiry pending when its opener settles after native quit reaches %s",
  async (exit) => {
    const { threads, seed, requestExit, finishExit, dispose } =
      await mountQuitProbe();
    const question = (id: string) => ({
      kind: "elicitation",
      requestId: `inquiry-${id}`,
      mode: "url",
      message: `Open browser for ${id}`,
      url: `https://example.test/controlled-${id}`,
    });
    let opened!: () => void;
    h.openUrl.mockReturnValueOnce(
      new Promise<void>((resolve) => (opened = resolve)),
    );
    const replies = () =>
      h.invoke.mock.calls.filter(
        ([cmd]) => cmd === "session_elicitation_respond",
      );
    const a = seed("A", question("A"));
    const b = seed("B", question("B"));
    const inquiry = a.pendingElicitations[0];
    const sibling = b.pendingElicitations[0];
    const accepting = threads.respondElicitation(
      a.key,
      inquiry.requestId,
      "accept",
    );
    try {
      expect(h.openUrl).toHaveBeenCalledExactlyOnceWith(question("A").url);
      expect(inquiry.opening).toBe(true);
      expect(replies()).toEqual([]);
      await requestExit(exit, 97);
      opened();
      await accepting;
      expect.soft(replies()).toEqual([]);
      expect.soft(a.pendingElicitations[0]).toBe(inquiry);
      expect.soft(inquiry.status).toBe("pending");
      expect.soft(inquiry.handoff).toBeUndefined();
      expect(inquiry.opening).toBe(false);
      expect(b.pendingElicitations[0]).toBe(sibling);
      expect(sibling.status).toBe("pending");
      await finishExit(exit, 97);
      if (exit === "stay") {
        await threads.respondElicitation(a.key, inquiry.requestId, "decline");
        expect(replies()).toEqual([
          [
            "session_elicitation_respond",
            {
              sessionId: "A",
              requestId: inquiry.requestId,
              action: "decline",
              content: null,
            },
          ],
        ]);
        expect(a.pendingElicitations).toEqual([]);
        expect(b.pendingElicitations[0]).toBe(sibling);
      }
      expect(h.openUrl).toHaveBeenCalledTimes(1);
    } finally {
      opened();
      dispose();
      await accepting;
    }
  },
);

it("applies the actual late receipt of a URL acceptance already sent before quit", async () => {
  const { threads, seed, requestExit, finishExit, dispose } =
    await mountQuitProbe();
  const a = seed("A", {
    kind: "elicitation",
    requestId: "inquiry-A",
    mode: "url",
    url: "https://example.test/controlled-A",
  });
  const inquiry = a.pendingElicitations[0];
  const response = { status: "submitted" };
  let acknowledge!: (reply: typeof response) => void;
  const heldReply = new Promise<typeof response>(
    (resolve) => (acknowledge = resolve),
  );
  const originalInvoke = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((command, args) =>
    command === "session_elicitation_respond"
      ? heldReply
      : originalInvoke(command, args),
  );
  h.openUrl.mockResolvedValueOnce(undefined);
  const accepting = threads.respondElicitation(
    a.key,
    inquiry.requestId,
    "accept",
  );
  try {
    const args = {
      sessionId: "A",
      requestId: inquiry.requestId,
      action: "accept",
      content: null,
    };
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "session_elicitation_respond",
        args,
      ),
    );
    expect(inquiry.status).toBe("submitting");
    expect(inquiry.handoff).toBeUndefined();
    await requestExit("leave", 98);
    acknowledge(response);
    await accepting;
    expect(a.pendingElicitations[0]).toBe(inquiry);
    expect(inquiry.handoff).toBe("waiting");
    expect(
      h.invoke.mock.calls.filter(
        ([cmd]) => cmd === "session_elicitation_respond",
      ),
    ).toEqual([["session_elicitation_respond", args]]);
    await finishExit("leave", 98);
  } finally {
    acknowledge(response);
    dispose();
    await accepting;
  }
});
