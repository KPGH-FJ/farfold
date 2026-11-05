import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionOption } from "../runtime/session_types";

const h = vi.hoisted(() => ({
  pick: null as ((option: PermissionOption) => void) | null,
  invoke: vi.fn().mockResolvedValue({ status: "submitted" }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("../runtime/performance-trace", () => ({ traceAfterPaint: vi.fn() }));
vi.mock("./thread-items", async (original) => {
  const actual = await original<typeof import("./thread-items")>();
  return {
    ...actual,
    ApprovalCard: (props: Parameters<typeof actual.ApprovalCard>[0]) => {
      h.pick = props.onPick;
      return actual.ApprovalCard(props);
    },
  };
});
import { threads, type ThreadState } from "../runtime/sessions";
import { OpeningInquiryOwner } from "../runtime/opening_inquiries";
import { ThreadView } from "./ThreadView";
import { DecisionLine } from "./PermissionDecisionLine";
import { STRINGS } from "../runtime/strings";

let serial = 0;
const owners: OpeningInquiryOwner[] = [];
const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown): void;
};
function seed(kind: string) {
  const id = `meaning-${++serial}`;
  const state = threads.markOpenFailed(
    `a:/fixture:${id}`,
    "a",
    "/fixture",
    id,
    "fixture",
  );
  state.openError = null;
  state.running = true;
  const option = { optionId: "original-choice", name: "外部规则选项", kind };
  const request = {
    sessionId: id,
    options: [option],
    _meta: { opaque: [null, 42] },
  };
  channel.applyChannelEvent(state.key, {
    kind: "permissionRequest",
    requestId: id,
    toolCall: { toolCallId: id, title: "Controlled choice", kind: "execute" },
    options: [option],
    request,
  });
  return { state, option, request, pending: state.pendingPermissions[0] };
}
const render = (thread: ThreadState) =>
  renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
const replies = () =>
  h.invoke.mock.calls.filter(
    ([command]) => command === "session_permission_respond",
  );
beforeEach(() => {
  h.pick = null;
  h.invoke.mockReset().mockResolvedValue({ status: "submitted" });
  vi.useFakeTimers();
});
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.retire());
  vi.useRealTimers();
});

it.each(["future_choice", "allow_future", "reject_future"])(
  "replies with the exact %s choice without inventing approval or rejection meaning",
  async (kind) => {
    const { state, option, pending, request } = seed(kind);
    expect(render(state)).toContain(option.name);
    h.pick!(pending.options[0]);
    expect
      .soft(pending.decision)
      .toMatchObject({ allow: null, undoable: false });
    expect(render(state)).toContain(STRINGS.repair.interactionSubmitting);
    await vi.runAllTimersAsync();
    expect(replies()).toEqual([
      [
        "session_permission_respond",
        {
          sessionId: state.nativeSessionId,
          requestId: pending.requestId,
          optionId: option.optionId,
        },
      ],
    ]);
    expect(pending.requestSnapshot).toEqual(request);
    const decision = state.items.find((item) => item.kind === "decision");
    expect(decision).toMatchObject({ allow: null });
    if (decision?.kind !== "decision")
      throw new Error("expected actual submitted decision");
    expect(decision.label).toContain(option.name);
    expect(decision.label).not.toMatch(/已批准|已拒绝/);
    const line = renderToStaticMarkup(
      <DecisionLine
        decision={{ ...decision, undoable: false }}
        onUndo={() => {}}
      />,
    );
    expect(line).not.toMatch(/class="(?:ok|no)"|✓|✗/);
  },
);

it.each(["allow_once", "allow_always", "reject_once", "reject_always"])(
  "keeps the declared standard meaning and remember behavior for %s",
  async (kind) => {
    const { state, pending } = seed(kind);
    render(state);
    h.pick!(pending.options[0]);
    expect(pending.decision).toMatchObject({
      allow: kind.startsWith("allow_"),
      undoable: kind === "allow_always",
    });
    expect(render(state)).toContain(
      kind === "allow_always"
        ? STRINGS.thread.decisionWaiting
        : STRINGS.repair.interactionSubmitting,
    );
    await vi.runAllTimersAsync();
    const decision = state.items.find((item) => item.kind === "decision");
    expect(decision).toMatchObject({ allow: kind.startsWith("allow_") });
    expect(replies()).toHaveLength(1);
  },
);

it("does not turn an unknown delivery result into a neutral success record or repeat the original choice", async () => {
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_permission_respond")
      throw new Error("controlled unknown IPC delivery");
    return null;
  });
  const { state, pending } = seed("future_choice");
  render(state);
  const choose = h.pick!;
  choose(pending.options[0]);
  await vi.runAllTimersAsync();
  expect(pending.status).toBe("uncertain");
  expect(state.pendingPermissions).toEqual([pending]);
  expect(state.items.some((item) => item.kind === "decision")).toBe(false);
  choose(pending.options[0]);
  await vi.runAllTimersAsync();
  expect(replies()).toHaveLength(1);
});

it.each(["future_choice", "allow_future", "reject_future"])(
  "keeps an opening %s choice neutral before its receipt",
  (kind) => {
    const owner = new OpeningInquiryOwner("a", "/fixture", () => {});
    owners.push(owner);
    owner.addInterest();
    owner.receive({
      kind: "permissionRequest",
      requestId: "opening-choice",
      owner: {
        connectionId: "connection",
        sessionId: "native",
        requestId: "opening-choice",
      },
      toolCall: { toolCallId: "tool", title: "Opening choice", kind: "read" },
      options: [{ optionId: "original", name: "外部规则选项", kind }],
    });
    owner.decidePermission("opening-choice", "original");
    const decision = owner.snapshot().permissions[0].decision!;
    expect(decision).toMatchObject({ allow: null, undoable: false });
    expect(
      renderToStaticMarkup(
        <DecisionLine decision={decision} onUndo={() => {}} />,
      ),
    ).not.toMatch(/class="(?:ok|no)"|✓|✗/);
  },
);
