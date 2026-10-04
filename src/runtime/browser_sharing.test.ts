import { describe, expect, it, vi } from "vitest";
import {
  BrowserSharingController,
  createBrowserSharingClient,
  type BrowserSharingClient,
  type BrowserShareInfo,
} from "./browser_sharing";
import type { BrowserWorkspaceState } from "./browser_workspace";

const scope = {
  taskKey: "task-a",
  target: { agentId: "agent-a", cwd: "/work", nativeSessionId: "session-a" },
};
const page: BrowserWorkspaceState = {
  taskKey: scope.taskKey,
  label: "page-a",
  url: "https://example.org/",
  phase: "ready",
  revision: 3,
};
const pending = {
  requestId: "request-a",
  taskKey: page.taskKey,
  label: page.label,
  url: page.url,
  pageRevision: page.revision,
  phase: "awaiting_permission" as const,
};
const info = (patch: Partial<BrowserShareInfo> = {}): BrowserShareInfo => ({
  taskKey: scope.taskKey,
  label: page.label,
  agentId: scope.target.agentId,
  phase: "unshared",
  revision: 1,
  reason: null,
  pendingRequest: null,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let changed: ((key: string) => void) | undefined;
  const unlisten = vi.fn();
  const client = {
    status: vi.fn(async () => info()),
    allow: vi.fn(async () => info({ phase: "shared", revision: 3 })),
    stop: vi.fn(async () => info({ revision: 4 })),
    respond: vi.fn(async () => info({ phase: "shared", revision: 3 })),
    listenChanged: vi.fn(
      async (listener: (key: string) => void): Promise<() => void> => {
        changed = listener;
        return unlisten;
      },
    ),
  } satisfies BrowserSharingClient;
  const controller = new BrowserSharingController(client, scope);
  controller.setPage(page);
  return {
    client,
    controller,
    unlisten,
    changed: (key = scope.taskKey) => changed?.(key),
  };
}

describe("browser sharing boundary", () => {
  it("maps real commands without sending a prompt or reading page content", async () => {
    const invoke = vi.fn(async () => info()) as unknown as Parameters<
      typeof createBrowserSharingClient
    >[0];
    const client = createBrowserSharingClient(invoke, async () => () => {});
    const input = { ...scope, label: page.label };
    await client.respond({
      ...input,
      requestId: pending.requestId,
      allow: true,
    });
    await client.allow({ ...input, expectedPageRevision: page.revision });
    await client.stop({ ...input, expectedRevision: 4 });
    expect(invoke).toHaveBeenNthCalledWith(1, "browser_share_respond", {
      ...input,
      requestId: pending.requestId,
      allow: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "browser_share_allow", {
      ...input,
      expectedPageRevision: 3,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "browser_share_stop", {
      ...input,
      expectedRevision: 4,
    });
  });

  it("establishes listening before the initial query and does not grant on mount", async () => {
    const { controller, client } = setup();
    const listening = deferred<() => void>();
    client.listenChanged.mockReturnValueOnce(listening.promise);
    const started = controller.start();
    expect(client.status).not.toHaveBeenCalled();
    expect(controller.getSnapshot().ready).toBe(false);
    listening.resolve(() => {});
    await started;
    expect(client.status).toHaveBeenCalledWith({ ...scope, label: page.label });
    expect(client.allow).not.toHaveBeenCalled();
    expect(client.respond).not.toHaveBeenCalled();
  });

  it("queries exact conversation without a visible pane and uses the pending page identity", async () => {
    const { controller, client } = setup();
    controller.setPage(null);
    client.status.mockResolvedValue(info({ pendingRequest: pending }));
    await controller.start();
    expect(client.status).toHaveBeenCalledWith({ ...scope, label: "" });
    await controller.respond(pending.requestId, true);
    expect(client.respond).toHaveBeenCalledWith({
      ...scope,
      label: pending.label,
      requestId: pending.requestId,
      allow: true,
    });
    expect(controller.getSnapshot().pendingRequest).toBeNull();
    expect(controller.getSnapshot().notice).toBe("已允许读取本页。");
  });

  it("cancels only the current request and never calls whole-sharing stop", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValue(info({ pendingRequest: pending }));
    client.respond.mockResolvedValue(info({ revision: 2 }));
    await controller.start();
    await controller.respond("stale-request", false);
    expect(client.respond).not.toHaveBeenCalled();
    await controller.respond(pending.requestId, false);
    expect(client.respond).toHaveBeenCalledWith({
      ...scope,
      label: page.label,
      requestId: pending.requestId,
      allow: false,
    });
    expect(client.stop).not.toHaveBeenCalled();
    expect(controller.getSnapshot().notice).toBe("已取消本次网页读取。");
  });

  it("destroys stale request actions on a new page before querying", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValue(info({ pendingRequest: pending }));
    await controller.start();
    const query = deferred<BrowserShareInfo>();
    client.status.mockReturnValueOnce(query.promise);
    controller.setPage({ ...page, revision: 4 });
    expect(controller.getSnapshot().pendingRequest).toBeNull();
    await controller.respond(pending.requestId, true);
    expect(client.respond).not.toHaveBeenCalled();
    query.resolve(info({ revision: 3, pendingRequest: pending }));
    await vi.waitFor(() => expect(controller.getSnapshot().ready).toBe(true));
    expect(controller.getSnapshot().pendingRequest).toBeNull();
  });

  it("rejects wrong task, page and stale request identities", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValue(
      info({ pendingRequest: { ...pending, taskKey: "other" } }),
    );
    await controller.start();
    expect(controller.getSnapshot().pendingRequest).toBeNull();
    client.status.mockResolvedValue(
      info({
        revision: 2,
        pendingRequest: { ...pending, label: "other-page" },
      }),
    );
    await controller.refresh();
    await controller.respond(pending.requestId, true);
    expect(client.respond).not.toHaveBeenCalled();
  });

  it("ignores unrelated events and a query that arrives after a newer query", async () => {
    const { controller, client, changed } = setup();
    await controller.start();
    changed("other-task");
    expect(client.status).toHaveBeenCalledTimes(1);
    const old = deferred<BrowserShareInfo>();
    client.status.mockReturnValueOnce(old.promise);
    const first = controller.refresh();
    client.status.mockResolvedValueOnce(
      info({ revision: 4, phase: "unavailable" }),
    );
    changed();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().info?.revision).toBe(4),
    );
    old.resolve(info({ revision: 3, pendingRequest: pending }));
    await first;
    expect(controller.getSnapshot().info?.phase).toBe("unavailable");
    expect(controller.getSnapshot().pendingRequest).toBeNull();
    expect(controller.getSnapshot().notice).toBe("");
  });

  it("does not regress a known revision from a command response", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ revision: 8 }));
    await controller.start();
    client.allow.mockResolvedValueOnce(info({ phase: "shared", revision: 7 }));
    await controller.allow();
    expect(controller.getSnapshot().info?.revision).toBe(8);
    expect(controller.getSnapshot().pendingRequest).toBeNull();
  });

  it("accepts authoritative status after a tool owner restarts its local revision", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ revision: 8, phase: "shared" }));
    await controller.start();
    client.status.mockResolvedValueOnce(
      info({ revision: 0, phase: "unavailable" }),
    );
    await controller.refresh();
    expect(controller.getSnapshot().info?.phase).toBe("unavailable");
    client.status.mockResolvedValueOnce(
      info({ revision: 1, pendingRequest: pending }),
    );
    await controller.refresh();
    expect(controller.getSnapshot().pendingRequest?.requestId).toBe(
      pending.requestId,
    );
    client.status.mockResolvedValueOnce(info({ revision: 8, phase: "shared" }));
    await controller.refresh();
    client.status.mockResolvedValueOnce(
      info({ revision: 1, pendingRequest: pending }),
    );
    await controller.refresh();
    expect(controller.getSnapshot().pendingRequest?.requestId).toBe(
      pending.requestId,
    );
  });

  it("serializes events during approval and uses the final backend state", async () => {
    const { controller, client, changed } = setup();
    client.status.mockResolvedValueOnce(info({ pendingRequest: pending }));
    await controller.start();
    const response = deferred<BrowserShareInfo>();
    client.respond.mockReturnValueOnce(response.promise);
    const action = controller.respond(pending.requestId, true);
    changed();
    expect(client.status).toHaveBeenCalledTimes(1);
    client.status.mockResolvedValueOnce(
      info({ revision: 4, phase: "unavailable", reason: "tool_disconnected" }),
    );
    response.resolve(info({ revision: 3, phase: "shared" }));
    await action;
    expect(controller.getSnapshot().info?.phase).toBe("unavailable");
    expect(controller.getSnapshot().pendingRequest).toBeNull();
    expect(controller.getSnapshot().notice).toBe("");
  });

  it("allows only one response while a request is being resolved", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ pendingRequest: pending }));
    await controller.start();
    const response = deferred<BrowserShareInfo>();
    client.respond.mockReturnValueOnce(response.promise);
    const action = controller.respond(pending.requestId, true);
    await controller.respond(pending.requestId, false);
    expect(client.respond).toHaveBeenCalledOnce();
    response.resolve(info({ phase: "shared", revision: 2 }));
    await action;
  });

  it("does not replace a pending tool request with a manual grant", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ pendingRequest: pending }));
    await controller.start();
    await controller.allow();
    expect(client.allow).not.toHaveBeenCalled();
  });

  it("requires real stop confirmation, preserves failure and can recheck then retry", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ phase: "shared", revision: 3 }));
    await controller.start();
    const stopped = deferred<BrowserShareInfo>();
    client.stop.mockReturnValueOnce(stopped.promise);
    const action = controller.stop();
    expect(controller.getSnapshot().info?.phase).toBe("shared");
    expect(controller.getSnapshot().operation).toBe("stop");
    expect(controller.getSnapshot().notice).toBe("");
    stopped.reject(new Error("internal secret failure"));
    await action;
    expect(controller.getSnapshot().error).toBe("停止尚未确认，请重试。");
    expect(controller.getSnapshot().ready).toBe(false);
    client.status.mockResolvedValueOnce(
      info({ phase: "stop_failed", revision: 4 }),
    );
    await controller.refresh();
    client.stop.mockResolvedValueOnce(info({ revision: 5 }));
    await controller.stop();
    expect(client.stop).toHaveBeenLastCalledWith({
      ...scope,
      label: page.label,
      expectedRevision: 4,
    });
    expect(controller.getSnapshot().notice).toBe("已停止共享。");
  });

  it("does not show successful stop if a resolved response is still unconfirmed", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ phase: "shared" }));
    await controller.start();
    client.stop.mockResolvedValueOnce(
      info({ phase: "stop_failed", revision: 2 }),
    );
    await controller.stop();
    expect(controller.getSnapshot().notice).toBe("");
    expect(controller.getSnapshot().info?.phase).toBe("stop_failed");
  });

  it("removes old buttons when querying fails, and does not expose backend errors", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ pendingRequest: pending }));
    await controller.start();
    client.status.mockRejectedValueOnce(new Error("secret raw output"));
    await controller.refresh();
    expect(controller.getSnapshot().pendingRequest).toBeNull();
    expect(controller.getSnapshot().error).toBe(
      "未能确认读取权限，请重新检查。",
    );
    await controller.respond(pending.requestId, true);
    expect(client.respond).not.toHaveBeenCalled();
  });

  it("unsubscribes late listeners and survives effect cleanup and restart", async () => {
    const { controller, client, unlisten } = setup();
    const first = deferred<() => void>();
    client.listenChanged.mockReturnValueOnce(first.promise);
    const starting = controller.start();
    controller.dispose();
    await controller.start();
    first.resolve(unlisten);
    await starting;
    expect(unlisten).toHaveBeenCalledOnce();
    expect(client.status).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().ready).toBe(true);
  });

  it("clears successful permission feedback when its status can no longer be checked", async () => {
    const { controller, client } = setup();
    await controller.start();
    await controller.allow();
    expect(controller.getSnapshot().notice).toBe("已允许读取本页。");
    client.status.mockRejectedValueOnce(new Error("unavailable"));
    await controller.refresh();
    expect(controller.getSnapshot().notice).toBe("");
    expect(controller.getSnapshot().error).toBe(
      "未能确认读取权限，请重新检查。",
    );
  });

  it("does not accept an approval response after leaving its owner", async () => {
    const { controller, client } = setup();
    client.status.mockResolvedValueOnce(info({ pendingRequest: pending }));
    await controller.start();
    const result = deferred<BrowserShareInfo>();
    client.respond.mockReturnValueOnce(result.promise);
    const action = controller.respond(pending.requestId, true);
    controller.dispose();
    result.resolve(info({ phase: "shared", revision: 2 }));
    await action;
    expect(controller.getSnapshot().ready).toBe(false);
    expect(controller.getSnapshot().info).toBeNull();
  });
});
