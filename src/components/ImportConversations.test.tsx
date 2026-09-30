import { describe, expect, it, vi } from "vitest";
import { importConversationBatch } from "./ImportConversations";
import type { DiscoveredConversation } from "../runtime/history_import";
import type { IndexRow } from "../runtime/sessions";

vi.mock("../runtime/sessions", () => ({ threads: {} }));

function row(nativeSessionId: string): DiscoveredConversation {
  return {
    nativeSessionId,
    cwd: "/notes",
    title: nativeSessionId,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId: null,
    isOpen: false,
  };
}
function saved(item: DiscoveredConversation): IndexRow {
  return {
    id: `saved-${item.nativeSessionId}`,
    nativeSessionId: item.nativeSessionId,
    agentId: "example",
    cwd: item.cwd,
    title: item.title,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  };
}

describe("history import batch results", () => {
  it("does not report a saved conversation as failed when preview cleanup succeeds on retry", async () => {
    const save = vi.fn(async (item: DiscoveredConversation) => saved(item));
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("close timed out"))
      .mockResolvedValue(undefined);
    const onAdded = vi.fn();
    const result = await importConversationBatch([row("one"), row("two")], {
      save,
      release,
      onAdded,
    });
    expect(result).toEqual({ count: 2, failures: [], cleanupFailed: false });
    expect(save.mock.calls.map(([item]) => item.nativeSessionId)).toEqual([
      "one",
      "two",
    ]);
    expect(onAdded.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("keeps committed success while retaining only unattempted rows after persistent cleanup failure", async () => {
    const save = vi.fn(async (item: DiscoveredConversation) => saved(item));
    const release = vi.fn(async () => {
      throw new Error("preview still open");
    });
    const onAdded = vi.fn();
    const result = await importConversationBatch(
      [row("one"), row("two"), row("three")],
      { save, release, onAdded },
    );
    expect(result).toEqual({
      count: 1,
      failures: ["two", "three"],
      cleanupFailed: true,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("one", saved(row("one")));
  });

  it("retains a failed save for retry and continues after its preview is released", async () => {
    const save = vi.fn(async (item: DiscoveredConversation) => {
      if (item.nativeSessionId === "one") throw new Error("write failed");
      return saved(item);
    });
    const release = vi.fn(async () => undefined);
    const onAdded = vi.fn();
    expect(
      await importConversationBatch([row("one"), row("two")], {
        save,
        release,
        onAdded,
      }),
    ).toEqual({ count: 1, failures: ["one"], cleanupFailed: false });
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("two", saved(row("two")));
  });

  it("retains the failed and unattempted rows if both saving and cleanup fail", async () => {
    const save = vi.fn(async () => {
      throw new Error("write failed");
    });
    const release = vi.fn(async () => {
      throw new Error("preview still open");
    });
    const onAdded = vi.fn();
    expect(
      await importConversationBatch([row("one"), row("two")], {
        save,
        release,
        onAdded,
      }),
    ).toEqual({ count: 0, failures: ["one", "two"], cleanupFailed: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onAdded).not.toHaveBeenCalled();
  });
});
