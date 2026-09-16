import { describe, expect, it, vi } from "vitest";
import { HostWorkspaceConnection } from "./host-workspace-connection";
import type { HostShadowHandle, HostShadowState } from "./host-shadow";

const snapshot: HostShadowState = {
  consumerGeneration: 1,
  streamId: "stream-1",
  latestSequence: 7,
  navigation: {
    sessionIndex: { schemaVersion: 3, sessions: [] },
    restoreState: null,
  },
  projections: {},
  pendingInteractions: [],
  eventCount: 0,
  reconciliationReasons: [],
  reconciliationRevisions: {},
  reconciledRevisions: {},
};
function handle(): HostShadowHandle {
  return { snapshot: () => snapshot, stop: vi.fn(async () => {}) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("shared workspace Host connection lifetime", () => {
  it("keeps a single owner when start is called while a channel is opening", async () => {
    const ready = deferred<HostShadowHandle>();
    const start = vi.fn(() => ready.promise);
    const owner = new HostWorkspaceConnection(vi.fn(), vi.fn(), start);
    const opening = owner.start();

    await expect(owner.start()).rejects.toThrow("already owned");
    expect(start).toHaveBeenCalledOnce();
    ready.resolve(handle());
    await opening;
    await expect(owner.start()).rejects.toThrow("already owned");
    await owner.stop();
  });

  it("releases a connection which finishes after the workspace unmounts", async () => {
    const ready = deferred<HostShadowHandle>();
    const onState = vi.fn();
    let publish!: (state: HostShadowState) => void;
    const owner = new HostWorkspaceConnection(onState, vi.fn(), (observer) => {
      publish = observer;
      return ready.promise;
    });
    const opening = owner.start();
    await owner.stop();
    publish(snapshot);
    const late = handle();
    ready.resolve(late);
    await expect(opening).rejects.toThrow("closed while connecting");
    expect(late.stop).toHaveBeenCalledOnce();
    expect(onState).not.toHaveBeenCalled();
  });

  it("reconnects from the last cursor even when the native QA operation fails", async () => {
    const first = handle(),
      second = handle();
    const start = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const owner = new HostWorkspaceConnection(vi.fn(), vi.fn(), start);
    await owner.start();
    await expect(
      owner.reconnectForQa(async () => {
        throw new Error("native failure");
      }),
    ).rejects.toThrow("native failure");
    expect(first.stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenLastCalledWith(expect.any(Function), {
      streamId: "stream-1",
      latestSequence: 7,
    });
    await owner.stop();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("does not restart after unmount during a paused QA operation", async () => {
    const operation = deferred<void>();
    const paused = deferred<void>();
    const start = vi.fn().mockResolvedValue(handle());
    const owner = new HostWorkspaceConnection(vi.fn(), vi.fn(), start);
    await owner.start();
    const replay = owner.reconnectForQa(() => {
      paused.resolve();
      return operation.promise;
    });
    await paused.promise;
    await expect(owner.reconnectForQa(async () => {})).rejects.toThrow(
      "正在重新连接",
    );
    await owner.stop();
    operation.resolve();
    await expect(replay).rejects.toThrow("closed during replay");
    expect(start).toHaveBeenCalledOnce();
  });

  it("reports an unavailable channel when reconnection fails", async () => {
    const unavailable = vi.fn();
    const start = vi
      .fn()
      .mockResolvedValueOnce(handle())
      .mockRejectedValueOnce(new Error("channel unavailable"));
    const owner = new HostWorkspaceConnection(vi.fn(), unavailable, start);
    await owner.start();
    await expect(owner.reconnectForQa(async () => {})).rejects.toThrow(
      "channel unavailable",
    );
    expect(unavailable).toHaveBeenCalledOnce();
    await owner.stop();
  });
});
