import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: number }) => void>(),
  hooks: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  cursor: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
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
  h.listeners.clear();
  h.hooks.length = 0;
  h.effects.length = 0;
});

it.each(["review", "stay", "leave"] as const)(
  "keeps an undoable approval pending when a native quit attempt reaches %s",
  async (exit) => {
    vi.useFakeTimers();
    const { DraftStartup } = await import("./DraftStartup");
    const { threads } = await import("../runtime/sessions");
    const { composerDrafts, draftPersistence } =
      await import("../runtime/drafts");
    const { EXIT_IMPACT } = await import("../runtime/exit_impact");
    const { permissionDecision } =
      await import("../runtime/permission_options");
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
      return command === "session_permission_respond"
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
    const seed = (id: string) => {
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
      ).applyChannelEvent(key, {
        kind: "permissionRequest",
        requestId: `permission-${id}`,
        toolCall: { toolCallId: `tool-${id}`, title: `Tool ${id}` },
        options: [
          { optionId: "always", name: "Allow always", kind: "allow_always" },
        ],
      });
      return state;
    };

    try {
      await vi.waitFor(() =>
        expect(h.invoke).toHaveBeenCalledWith("app_drafts_ready"),
      );
      const a = seed("A");
      const b = seed("B");
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

      h.listeners.get("app:save-before-exit")!({ payload: 95 });
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

      await vi.advanceTimersByTimeAsync(5000);
      expect.soft(approvalCalls()).toEqual([]);
      expect.soft(a.pendingPermissions[0]).toBe(approval);
      expect.soft(approval.status).toBe("pending");
      expect.soft(approval.decision).toBeNull();
      expect(b.pendingPermissions[0]).toBe(sibling);
      expect(sibling.decision).toBeNull();
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
            token: 95,
            confirmActivity: true,
          }),
        );
      } else {
        if (exit === "review") click("stay");
        expect(h.invoke).toHaveBeenCalledWith("app_exit_cancel", { token: 95 });
        expect(h.invoke).not.toHaveBeenCalledWith(
          "app_exit_after_save",
          expect.anything(),
        );
      }
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
      releaseWrite();
      cleanup.forEach((dispose) => dispose?.());
    }
  },
);
