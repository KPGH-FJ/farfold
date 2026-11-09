import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (callback: () => () => void) => {
    harness.cleanup = callback();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
import {
  conversationReadState as read,
  useVisibleConversation,
} from "./conversation_read_state";
const reply = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "Reply" },
};
const page = {
  hidden: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
beforeEach(async () => {
  page.hidden = false;
  page.addEventListener.mockReset();
  page.removeEventListener.mockReset();
  vi.stubGlobal("document", page);
  await read.load();
});
afterEach(async () => {
  harness.cleanup?.();
  await read.flush();
  vi.unstubAllGlobals();
});

it("only the visible conversation consumes live replies; hidden windows and other routes do not", async () => {
  useVisibleConversation("visible", true);
  read.receiveUpdate("visible", reply);
  read.receiveUpdate("other", reply);
  expect(read.snapshot().unread.has("visible")).toBe(false);
  expect(read.snapshot().unread.has("other")).toBe(true);
  const visibilityChanged = page.addEventListener.mock
    .calls[0][1] as () => void;
  page.hidden = true;
  visibilityChanged();
  read.receiveUpdate("visible", reply);
  expect(read.snapshot().unread.has("visible")).toBe(true);
  page.hidden = false;
  visibilityChanged();
  expect(read.snapshot().unread.has("visible")).toBe(false);
  harness.cleanup?.();
  useVisibleConversation(null, true);
  read.receiveUpdate("visible", reply);
  expect(read.snapshot().unread.has("visible")).toBe(true);
  expect(page.removeEventListener).toHaveBeenCalledWith(
    "visibilitychange",
    visibilityChanged,
  );
});

it("the unread bit stays set when a visible page has only partial or failed history", () => {
  read.receiveUpdate("partial", reply);
  useVisibleConversation("partial", false);
  read.receiveUpdate("partial", reply);
  expect(read.snapshot().unread.has("partial")).toBe(true);
  harness.cleanup?.();
  useVisibleConversation("partial", true);
  expect(read.snapshot().unread.has("partial")).toBe(false);
});

it("keeps the visible conversation read when a retained page first receives readable content", async () => {
  useVisibleConversation(null, false);
  const stopBackground = harness.cleanup;
  useVisibleConversation("foreground", true);
  const stopForeground = harness.cleanup;
  read.receiveUpdate("foreground", reply);
  expect(read.snapshot().unread.has("foreground")).toBe(false);

  read.receiveUpdate("retained", reply);
  stopBackground?.();
  useVisibleConversation(null, true);
  read.receiveUpdate("foreground", reply);
  await read.flush();

  expect(read.snapshot().unread.has("retained")).toBe(true);
  expect(read.snapshot().unread.has("foreground")).toBe(false);
  stopForeground?.();
});

it("ignores an old visible page's delayed event and cleanup after another page takes over", () => {
  useVisibleConversation("former", true);
  const stopFormer = harness.cleanup;
  const syncFormer = page.addEventListener.mock.calls[0][1] as () => void;
  useVisibleConversation("current", true);

  syncFormer();
  read.receiveUpdate("current", reply);
  expect(read.snapshot().unread.has("current")).toBe(false);

  stopFormer?.();
  read.receiveUpdate("current", reply);
  read.receiveUpdate("former", reply);
  expect(read.snapshot().unread.has("current")).toBe(false);
  expect(read.snapshot().unread.has("former")).toBe(true);
});
