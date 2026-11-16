import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ status: "submitted" }),
}));
import { invoke } from "@tauri-apps/api/core";
import { ApprovalCard } from "../components/thread-items";
import { InteractionActions } from "./interaction_actions";
import { applyPermissionRequest, freshThreadState } from "./session_projection";
import { permissionShortcut } from "./permission_shortcuts";

const ambiguous = [
  { optionId: "same", name: "Allow", kind: "allow_once" },
  { optionId: "same", name: "Reject", kind: "reject_once" },
  { optionId: "safe", name: "Reject separately", kind: "reject_always" },
];
function setup(options: unknown = ambiguous) {
  const state = freshThreadState("options", "agent", "/work", "native");
  const request = {
    sessionId: "native",
    options,
    toolCall: { toolCallId: "tool", title: "Original", kind: "execute" },
    _meta: { opaque: [null, "unchanged"] },
  };
  applyPermissionRequest(state, {
    requestId: "permission",
    toolCall: request.toolCall,
    options,
    request,
  });
  const actions = new InteractionActions(() => state, vi.fn());
  return { state, request, actions, pending: state.pendingPermissions[0] };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("does not send an ambiguous identifier from a direct approval action", async () => {
  vi.useFakeTimers();
  const { state, actions, pending, request } = setup();
  actions.decide(state.key, pending.requestId, "same", "Reject", false);
  await vi.runAllTimersAsync();
  expect(invoke).not.toHaveBeenCalled();
  expect(pending.decision).toBeNull();
  expect(pending.status).toBe("pending");
  expect(pending.requestSnapshot).toEqual(request);
});

it("disables only ambiguous buttons and keeps the original request inspectable", () => {
  const { pending, request } = setup();
  const html = renderToStaticMarkup(
    <ApprovalCard {...pending} onPick={() => {}} />,
  );
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(buttons).toHaveLength(3);
  expect(
    buttons.filter((button) => button.includes('disabled=""')),
  ).toHaveLength(2);
  expect(
    buttons.find((button) => button.includes("Reject separately")),
  ).not.toContain("disabled");
  expect(pending.requestSnapshot).toEqual(request);
});

it("does not use an approval shortcut for a duplicate identifier", () => {
  for (const key of ["Enter", "Backspace"]) {
    expect(
      permissionShortcut(
        { key, metaKey: true } as KeyboardEvent,
        true,
        ambiguous,
        "MacIntel",
      ),
    ).toBeNull();
  }
});

it("does not coerce a non-string identifier into a different advertised option", async () => {
  vi.useFakeTimers();
  const { pending, state, actions, request } = setup([
    { optionId: 17, name: "Malformed approval", kind: "allow_once" },
    { optionId: "17", name: "Real rejection", kind: "reject_once" },
  ]);
  expect(
    permissionShortcut(
      { key: "Enter", metaKey: true } as KeyboardEvent,
      true,
      pending.options,
      "MacIntel",
    ),
  ).toBeNull();
  const malformed = pending.options.find(
    (option) => option.kind === "allow_once",
  );
  if (malformed)
    actions.decide(
      state.key,
      pending.requestId,
      malformed.optionId,
      "Approve",
      true,
    );
  await vi.runAllTimersAsync();
  expect(invoke).not.toHaveBeenCalled();
  expect(pending.requestSnapshot).toEqual(request);
  const html = renderToStaticMarkup(
    <ApprovalCard {...pending} onPick={() => {}} />,
  );
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(
    buttons.find((button) => button.includes("Malformed approval")),
  ).toContain('disabled=""');
  expect(
    buttons.find((button) => button.includes("Real rejection")),
  ).not.toContain("disabled");
  actions.decide(state.key, pending.requestId, "17", "Reject", false);
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("session_permission_respond", {
    sessionId: "native",
    requestId: "permission",
    optionId: "17",
  });
});

it("does not add an invented nonempty-ID requirement to valid string choices", async () => {
  vi.useFakeTimers();
  const { pending, state, actions } = setup([
    { optionId: "", name: "Explicit empty string ID", kind: "reject_once" },
    { name: "Missing ID", kind: "allow_once" },
  ]);
  const html = renderToStaticMarkup(
    <ApprovalCard {...pending} onPick={() => {}} />,
  );
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(buttons.find((button) => button.includes("Missing ID"))).toContain(
    'disabled=""',
  );
  expect(
    buttons.find((button) => button.includes("Explicit empty string ID")),
  ).not.toContain("disabled");
  expect(
    permissionShortcut(
      { key: "Enter", metaKey: true } as KeyboardEvent,
      true,
      pending.options,
      "MacIntel",
    ),
  ).toBeNull();
  actions.decide(state.key, pending.requestId, "", "Reject", false);
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("session_permission_respond", {
    sessionId: "native",
    requestId: "permission",
    optionId: "",
  });
});

it("still sends a uniquely identified choice once, without affecting another request", async () => {
  vi.useFakeTimers();
  const { pending, state, actions } = setup();
  applyPermissionRequest(state, {
    requestId: "another",
    toolCall: {},
    options: ambiguous,
  });
  const another = state.pendingPermissions[1];
  actions.decide(
    state.key,
    pending.requestId,
    "safe",
    "Reject separately",
    false,
  );
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("session_permission_respond", {
    sessionId: "native",
    requestId: "permission",
    optionId: "safe",
  });
  expect(state.pendingPermissions).toEqual([another]);
  actions.decide(
    state.key,
    pending.requestId,
    "safe",
    "Reject separately",
    false,
  );
  await vi.runAllTimersAsync();
  expect(invoke).toHaveBeenCalledTimes(1);
});
