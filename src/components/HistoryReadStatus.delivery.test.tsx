import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { historyReads } from "../runtime/session_history_admission";
import { HISTORY_READ as S } from "../runtime/history_read_strings";
import { HistoryReadStatus } from "./HistoryReadStatus";
afterEach(() => {
  h.invoke.mockReset();
});
function elements(
  tree: ReactNode,
): { type: unknown; props: Record<string, unknown> }[] {
  return Children.toArray(tree).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [
      { type: child.type, props: child.props },
      ...elements(child.props.children),
    ];
  });
}
it("shows a retained failed delivery on the common app status independently of the original thread and retries only its exact receipt", async () => {
  const token = "visible-delivery";
  const owner = historyReads.begin(
    "original",
    { agentId: "owned", cwd: "/owned", nativeSessionId: "original" },
    token,
    "preview",
  )!;
  owner.dispatch();
  owner.channel.onmessage({
    kind: "session_history_admission",
    openToken: token,
    phase: "starting",
    historyDelivery: { receiptId: 401, openToken: token },
  });
  h.invoke.mockRejectedValueOnce(new Error("controlled delivery failure"));
  historyReads.finish("original", owner);
  await vi.waitFor(() =>
    expect(
      historyReads.getSnapshot().find((read) => read.token === token)
        ?.releaseRetry,
    ).toBe(true),
  );
  const tree = HistoryReadStatus({ releaseOnly: true, active: true });
  const status = elements(tree).find((node) => node.props.role === "status");
  const retry = elements(tree).find(
    (node) => node.type === "button" && node.props.children === S.retryRelease,
  );
  expect(status).toBeDefined();
  expect(renderToStaticMarkup(tree)).toContain(S.releaseUnconfirmed);
  expect(retry).toBeDefined();
  expect(retry!.props.disabled).toBe(false);
  h.invoke.mockImplementation((_name, args) =>
    Promise.resolve({
      receiptId: args.receiptId,
      openToken: args.openToken,
      outcome: "acknowledged",
    }),
  );
  (retry!.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(
      elements(HistoryReadStatus({ releaseOnly: true, active: true })).some(
        (node) => node.props.role === "status",
      ),
    ).toBe(false),
  );
  expect(h.invoke.mock.calls.map(([name]) => name)).toEqual([
    "session_history_delivery_ack",
    "session_history_delivery_ack",
  ]);
  expect(h.invoke.mock.calls[0][1]).toEqual(h.invoke.mock.calls[1][1]);
});
