import { expect, it, vi } from "vitest";
import { KnownHistoryReader } from "./known_history_import";
import { freshThreadState } from "./session_projection";
import { IMPORT_STRINGS as S } from "./import_strings";
import type { HistoryPreview, HistoryPreviewInterest } from "./history_import";
import type { IndexRow } from "./sessions";

function fixture() {
  const state = freshThreadState("preview", "agent", "/canonical", "owned");
  state.items = [
    {
      kind: "agent",
      id: "reply",
      text: "Actual retained reply",
      attachments: [],
      streaming: false,
      time: 0,
    },
  ];
  const receipt: HistoryPreview = {
    agentId: "agent",
    cwd: "/canonical",
    nativeSessionId: "owned",
    purpose: "importPreview",
    previewToken: "exact-owner",
    replayComplete: true,
    state,
  };
  const saved = {
    id: "saved",
    agentId: "agent",
    cwd: "/canonical",
    nativeSessionId: "owned",
  } as IndexRow;
  const actions = {
    load: vi.fn().mockResolvedValue(receipt),
    close: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(saved),
  };
  let current = true;
  const reader = new KnownHistoryReader(vi.fn(), actions);
  return {
    reader,
    actions,
    receipt,
    saved,
    current: () => current,
    retire: () => {
      current = false;
    },
    read: () =>
      reader.read(
        "agent",
        { cwd: "/alias", nativeSessionId: "owned" },
        () => current,
      ),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps a typed ID out of the index until complete real content and a second explicit action", async () => {
  const f = fixture(),
    load = deferred<HistoryPreview>();
  f.actions.load.mockReturnValueOnce(load.promise);
  const read = f.read();
  await vi.waitFor(() => expect(f.actions.load).toHaveBeenCalledOnce());
  expect(f.reader.preview).toBeNull();
  await f.reader.add(vi.fn());
  expect(f.actions.commit).not.toHaveBeenCalled();
  load.resolve(f.receipt);
  await read;
  expect(f.reader.preview?.cwd).toBe("/canonical"); // A legitimate canonical path is not rejected as an alias.
  expect(f.actions.commit).not.toHaveBeenCalled();
  const refresh = vi.fn().mockResolvedValue(undefined);
  await f.reader.add(refresh);
  expect(f.actions.commit).toHaveBeenCalledExactlyOnceWith(f.receipt, null);
  expect(f.actions.close).toHaveBeenCalledExactlyOnceWith(f.receipt);
  expect(f.reader.state.saved).toBe(f.saved);
  expect(refresh).toHaveBeenCalledOnce();
  await f.reader.add(refresh);
  expect(f.actions.commit).toHaveBeenCalledOnce();
});

it("retires an invalidated owner before a late reply can display or commit", async () => {
  const f = fixture(),
    load = deferred<HistoryPreview>();
  f.actions.load.mockReturnValueOnce(load.promise);
  const read = f.read();
  await vi.waitFor(() => expect(f.actions.load).toHaveBeenCalledOnce());
  f.retire();
  const interest = f.actions.load.mock.calls[0][2] as HistoryPreviewInterest;
  expect(interest.inquiryCurrent?.()).toBe(false);
  load.resolve(f.receipt);
  await read;
  expect(f.reader.preview).toBeNull();
  expect(f.actions.close).toHaveBeenCalledExactlyOnceWith(f.receipt);
  await f.reader.add(vi.fn());
  expect(f.actions.commit).not.toHaveBeenCalled();
});

it.each(["empty", "incomplete", "other-id", "other-agent", "wrong-purpose"])(
  "does not admit a %s reply",
  async (kind) => {
    const f = fixture();
    if (kind === "empty") f.receipt.state.items = [];
    if (kind === "incomplete") f.receipt.replayComplete = false;
    if (kind === "other-id") f.receipt.nativeSessionId = "other";
    if (kind === "other-agent") f.receipt.agentId = "other";
    if (kind === "wrong-purpose")
      f.actions.load.mockResolvedValue({
        ...f.receipt,
        purpose: "searchReadOnly",
      });
    await f.read();
    expect(f.reader.preview).toBeNull();
    expect(f.reader.state.error).not.toBeNull();
    await f.reader.add(vi.fn());
    expect(f.actions.commit).not.toHaveBeenCalled();
    await f.reader.release();
    expect(f.actions.close).toHaveBeenCalledWith(
      await f.actions.load.mock.results[0].value,
    );
  },
);

it("holds unknown cleanup and cannot issue a new read over its owner", async () => {
  const f = fixture();
  await f.read();
  f.actions.close.mockRejectedValue(new Error("transport unavailable"));
  await f.read();
  expect(f.actions.load).toHaveBeenCalledOnce();
  expect(f.reader.state.error).toBe(S.cleanupFailed);
  f.actions.close.mockResolvedValue(undefined);
  await f.read();
  expect(f.actions.load).toHaveBeenCalledTimes(2);
});

it("preserves a confirmed index receipt when later cleanup fails", async () => {
  const f = fixture();
  await f.read();
  f.actions.close.mockRejectedValue(new Error("unknown"));
  await f.reader.add(vi.fn());
  expect(f.reader.state.saved).toBe(f.saved);
  expect(f.reader.state.error).toBe(S.cleanupFailed);
  await f.reader.add(vi.fn());
  expect(f.actions.commit).toHaveBeenCalledOnce();
});

it("rejects absent input and already retired context without dispatch", async () => {
  const f = fixture();
  await f.reader.read(
    "agent",
    { cwd: "", nativeSessionId: "owned" },
    f.current,
  );
  f.retire();
  await f.read();
  expect(f.actions.load).not.toHaveBeenCalled();
});

it("changing the typed target invalidates the previous body immediately", async () => {
  const f = fixture();
  await f.read();
  f.reader.reset();
  expect(f.reader.preview).toBeNull();
  await f.reader.add(vi.fn());
  expect(f.actions.commit).not.toHaveBeenCalled();
  await f.reader.release();
  expect(f.actions.close).toHaveBeenCalledExactlyOnceWith(f.receipt);
});

it("does not reissue a load while the first read is still in flight", async () => {
  const f = fixture(),
    load = deferred<HistoryPreview>();
  f.actions.load.mockReturnValueOnce(load.promise);
  const read = f.read();
  await vi.waitFor(() => expect(f.actions.load).toHaveBeenCalledOnce());
  await f.read();
  expect(f.actions.load).toHaveBeenCalledOnce();
  load.resolve(f.receipt);
  await read;
});

it.each(["reset", "retire"] as const)(
  "retains a confirmed old commit but never publishes into a %s view",
  async (method) => {
    const f = fixture(),
      commit = deferred<IndexRow>();
    f.actions.commit.mockReturnValueOnce(commit.promise);
    await f.read();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const adding = f.reader.add(refresh);
    f.reader[method]();
    commit.resolve(f.saved);
    await adding;
    expect(f.reader.lastSaved).toBe(f.saved);
    expect(f.reader.state.saved).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(f.actions.close).toHaveBeenCalledExactlyOnceWith(f.receipt);
  },
);
