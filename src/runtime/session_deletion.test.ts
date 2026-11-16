import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import { requestSessionDeletion } from "./session_deletion";
const target = {
  agentId: "fixture",
  cwd: "/owned",
  nativeSessionId: "owned-native",
};
beforeEach(() => {
  h.invoke.mockReset();
});
it("delegates close and deletion together without discarding the original owner first", async () => {
  h.invoke.mockResolvedValue("deleted");
  const closed = vi.fn();
  await expect(requestSessionDeletion(target, target, closed)).resolves.toBe(
    "deleted",
  );
  expect(h.invoke.mock.calls).toEqual([["session_delete", target]]);
  expect(closed).toHaveBeenCalledOnce();
});
it("retains a still-open view after a typed pre-dispatch close refusal", async () => {
  h.invoke.mockRejectedValue({ code: "localNotRemoved", agent: null });
  const closed = vi.fn();
  await expect(requestSessionDeletion(target, target, closed)).rejects.toThrow(
    /未从对话列表移除/,
  );
  expect(closed).not.toHaveBeenCalled();
  expect(h.invoke.mock.calls).toEqual([["session_delete", target]]);
});
it("preserves the closed fact separately when official deletion succeeded but local removal failed", async () => {
  h.invoke.mockRejectedValue({
    code: "localNotRemoved",
    agent: "deleted",
    connectionClosed: true,
  });
  const closed = vi.fn();
  await expect(requestSessionDeletion(target, target, closed)).rejects.toThrow(
    /未从对话列表移除.*确认已删除/,
  );
  expect(closed).toHaveBeenCalledOnce();
});
it("keeps a confirmed close when the subsequent official request could not be dispatched", async () => {
  h.invoke.mockRejectedValue({
    code: "localNotRemoved",
    agent: null,
    connectionClosed: true,
  });
  const closed = vi.fn();
  await expect(requestSessionDeletion(target, target, closed)).rejects.toThrow(
    /未向 Agent/,
  );
  expect(closed).toHaveBeenCalledOnce();
});
it("does not accept a numeric closed flag as proof", async () => {
  h.invoke.mockRejectedValue({
    code: "localNotRemoved",
    agent: null,
    connectionClosed: 1,
  });
  const closed = vi.fn();
  await expect(
    requestSessionDeletion(target, target, closed),
  ).rejects.toThrow();
  expect(closed).not.toHaveBeenCalled();
});
it("refuses a mismatched loaded identity without sending any command", async () => {
  await expect(
    requestSessionDeletion(
      target,
      { ...target, nativeSessionId: "other" },
      vi.fn(),
    ),
  ).rejects.toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});
