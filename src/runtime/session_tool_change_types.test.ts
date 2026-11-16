import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { sessionToolChangePort } from "./session_tool_change";
import {
  parseSessionManagedTools,
  parseSessionToolChangeOperation as parse,
  validSessionToolChange,
} from "./session_tool_change_types";
import { target } from "./session_tools.test-support";
import {
  changed,
  changeInput,
  changeOperation,
  managedItem,
} from "./session_tool_change.test-support";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
afterEach(() => vi.mocked(invoke).mockReset());
it("passes only exact user intent and target to mutation; status and items never replay or carry the URL", async () => {
  await sessionToolChangePort.start(target, changeInput);
  await sessionToolChangePort.status(target);
  const { operationId: _id, ...owner } = target;
  await sessionToolChangePort.items(owner);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["session_tool_change_start", { ...target, change: changeInput }],
    ["session_tool_change_status", target],
    ["session_tool_change_items", owner],
  ]);
});
it("accepts bounded explicit observations and strips remote error prose", () => {
  expect(parse(changed(target), target, "addHttp")).toEqual(changed(target));
  const raw = {
    ...changeOperation(target, {
      state: "unknown",
      settled: true,
      mutationSent: true,
    }),
    error: { code: "unknown", message: "PRIVATE_REMOTE_URL" },
  };
  expect(parse(raw, target, "addHttp").error).toEqual({ code: "unknown" });
  expect(JSON.stringify(parse(raw, target, "addHttp"))).not.toContain(
    "PRIVATE_REMOTE_URL",
  );
});
it.each([
  { operationId: "different" },
  { connectionId: "other" },
  { nativeSessionId: "other" },
  { agentId: "other" },
  { cwd: "/other" },
  { state: "succeeded" },
  { kind: "remove" },
  { settled: "true" },
  { mutationSent: undefined },
  { conversationSaved: undefined },
  { conversationSaved: "true" },
  { conversationSaved: false },
  { activity: "connected" },
  { persistence: "saved" },
  { report: {} },
  { error: { code: "other", message: "PRIVATE" } },
  { error: { code: "busy", message: "PRIVATE", url: "PRIVATE" } },
  { items: [{ ...managedItem, url: "PRIVATE" }] },
  { items: [managedItem, managedItem] },
  { items: [{ name: "name", itemRef: "" }] },
])(
  "rejects changed owners, unknown projections, and ambiguous item identities: %o",
  (patch) => {
    expect(() =>
      parse({ ...changed(target), ...patch }, target, "addHttp"),
    ).toThrow();
  },
);
it("requires explicit URL input and does not derive removal from names or empty lists", () => {
  expect(validSessionToolChange(changeInput)).toBe(true);
  expect(
    validSessionToolChange({
      ...changeInput,
      url: "https://user:pass@example.test",
    }),
  ).toBe(false);
  expect(
    validSessionToolChange({
      ...changeInput,
      url: "https://example.test/#private",
    }),
  ).toBe(false);
  expect(
    validSessionToolChange({ kind: "remove", name: "name" } as never),
  ).toBe(false);
  expect(parseSessionManagedTools([])).toEqual([]);
  expect(() => parseSessionManagedTools([managedItem, managedItem])).toThrow();
});
