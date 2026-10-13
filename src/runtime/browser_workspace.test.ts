import { describe, expect, it, vi } from "vitest";
import {
  createBrowserWorkspaceClient,
  BrowserWorkspaceRetiredError,
  BrowserWorkspaceScope,
  browserWorkspaceBounds,
  publicBrowserUrl,
  type BrowserWorkspacePageClient as BrowserWorkspaceClient,
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceState,
} from "./browser_workspace";

const bounds = { x: 400, y: 100, width: 440, height: 500 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function page(
  taskKey = "task-a",
  label = "page-a",
  revision = 1,
): BrowserWorkspaceState {
  return {
    taskKey,
    label,
    revision,
    url: "https://example.com/",
    phase: "ready",
  };
}

function fakeClient() {
  return {
    open: vi.fn(async () => page()),
    openHtml: vi.fn(async () => ({
      ...page(),
      url: "about:blank",
      localFileName: "game.html",
    })),
    navigate: vi.fn(async () => page("task-a", "page-a", 2)),
    resize: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<BrowserWorkspaceSnapshot> => ({
      ...page(),
      title: "Public page",
      text: "Public text",
      observedAtMs: 1,
    })),
    close: vi.fn(async () => {}),
    clearHtmlStorage: vi.fn(async () => {}),
    listenState: vi.fn(async () => () => {}),
  } satisfies BrowserWorkspaceClient;
}

describe("browser workspace ownership", () => {
  it("closes a page that finishes opening after its owner leaves", async () => {
    const client = fakeClient();
    const pending = deferred<BrowserWorkspaceState>();
    client.open.mockReturnValue(pending.promise);
    const owner = new BrowserWorkspaceScope(client, "task-a");
    const opening = owner.open("https://example.com/", bounds);
    const rejected = expect(opening).rejects.toBeInstanceOf(
      BrowserWorkspaceRetiredError,
    );
    await vi.waitFor(() => expect(client.open).toHaveBeenCalledOnce());
    const closing = owner.close();
    expect(client.close).not.toHaveBeenCalled();
    pending.resolve(page());
    await closing;
    await rejected;
    expect(client.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
    });
    expect(owner.current).toBeNull();
  });

  it("waits for previous closure before opening another task", async () => {
    const client = fakeClient();
    const old = new BrowserWorkspaceScope(client, "task-a");
    await old.open("https://example.com/", bounds);
    const closed = deferred<void>();
    client.close.mockReturnValueOnce(closed.promise);
    client.open.mockResolvedValueOnce(page("task-b", "page-b"));
    const next = new BrowserWorkspaceScope(client, "task-b", old);
    const opening = next.open("https://example.com/", bounds);
    await Promise.resolve();
    expect(client.open).toHaveBeenCalledTimes(1);
    closed.resolve();
    await opening;
    expect(client.open).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
    });
  });

  it("preserves a failed closure for retry and blocks its successor", async () => {
    const client = fakeClient();
    const old = new BrowserWorkspaceScope(client, "task-a");
    await old.open("https://example.com/", bounds);
    client.close.mockRejectedValueOnce(new Error("close failed"));
    const next = new BrowserWorkspaceScope(client, "task-b", old);
    await expect(next.open("https://example.com/", bounds)).rejects.toThrow(
      "close failed",
    );
    expect(client.open).toHaveBeenCalledTimes(1);
    client.open.mockResolvedValueOnce(page("task-b", "page-b"));
    await next.open("https://example.com/", bounds);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it("accepts only the current owner and nondecreasing revisions", async () => {
    const client = fakeClient();
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    expect(owner.accept(page("task-b", "page-a", 9))).toBe(false);
    expect(owner.accept(page("task-a", "old-page", 9))).toBe(false);
    expect(owner.accept(page("task-a", "page-a", 3))).toBe(true);
    expect(owner.accept(page("task-a", "page-a", 2))).toBe(false);
    expect(owner.current?.revision).toBe(3);
  });

  it("retains an event that arrives before the open response", async () => {
    const client = fakeClient();
    const pending = deferred<BrowserWorkspaceState>();
    client.open.mockReturnValueOnce(pending.promise);
    const owner = new BrowserWorkspaceScope(client, "task-a");
    const opening = owner.open("https://example.com/", bounds);
    await Promise.resolve();
    owner.accept(page("task-a", "page-a", 3));
    owner.accept(page("task-a", "unrelated", 99));
    pending.resolve({ ...page(), phase: "loading" });
    expect((await opening).phase).toBe("ready");
    expect(owner.current?.revision).toBe(3);
  });

  it("allows only one concurrent open while predecessor closure is pending", async () => {
    const client = fakeClient();
    const owner = new BrowserWorkspaceScope(client, "task-a");
    const first = owner.open("https://example.com/", bounds);
    await expect(
      owner.open("https://example.com/second", bounds),
    ).rejects.toBeInstanceOf(BrowserWorkspaceRetiredError);
    await first;
    expect(client.open).toHaveBeenCalledTimes(1);
  });

  it("does not replace newer navigation events with an older command response", async () => {
    const client = fakeClient();
    const pending = deferred<BrowserWorkspaceState>();
    client.navigate.mockReturnValueOnce(pending.promise);
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    const navigating = owner.navigate("https://example.com/next");
    owner.accept(page("task-a", "page-a", 4));
    pending.resolve({ ...page("task-a", "page-a", 3), phase: "loading" });
    expect((await navigating).revision).toBe(4);
  });

  it("discards a snapshot if a newer navigation event arrives while reading", async () => {
    const client = fakeClient();
    const pending = deferred<BrowserWorkspaceSnapshot>();
    client.snapshot.mockReturnValue(pending.promise);
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    const reading = owner.snapshot();
    owner.accept({ ...page("task-a", "page-a", 2), phase: "loading" });
    pending.resolve({
      ...page(),
      title: "Old",
      text: "Old body",
      observedAtMs: 1,
    });
    await expect(reading).rejects.toBeInstanceOf(BrowserWorkspaceRetiredError);
  });

  it("discards a snapshot after closure, including same-task new-page identities", async () => {
    const client = fakeClient();
    const pending = deferred<BrowserWorkspaceSnapshot>();
    client.snapshot.mockReturnValue(pending.promise);
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    const reading = owner.snapshot();
    await owner.close();
    pending.resolve({
      ...page("task-a", "another-page"),
      title: "Old",
      text: "Old body",
      observedAtMs: 1,
    });
    await expect(reading).rejects.toBeInstanceOf(BrowserWorkspaceRetiredError);
    expect(client.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
    });
  });

  it("does not read when navigation was blocked", async () => {
    const client = fakeClient();
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    owner.accept({ ...page("task-a", "page-a", 2), phase: "blocked" });
    await expect(owner.snapshot()).rejects.toBeInstanceOf(
      BrowserWorkspaceRetiredError,
    );
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  it("rejects a newer page snapshot when reading began on the old page", async () => {
    const client = fakeClient();
    const pending = deferred<BrowserWorkspaceSnapshot>();
    client.snapshot.mockReturnValue(pending.promise);
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    const reading = owner.snapshot();
    owner.accept(page("task-a", "page-a", 2));
    pending.resolve({
      ...page("task-a", "page-a", 2),
      title: "New",
      text: "New body",
      observedAtMs: 1,
    });
    await expect(reading).rejects.toBeInstanceOf(BrowserWorkspaceRetiredError);
  });
});

it("uses logical coordinates unchanged and rejects invisible rectangles", () => {
  expect(browserWorkspaceBounds(bounds)).toEqual(bounds);
  expect(browserWorkspaceBounds({ ...bounds, width: 0 })).toBeNull();
  expect(browserWorkspaceBounds({ ...bounds, x: Number.NaN })).toBeNull();
});

it("requires an explicit HTTPS address without embedded credentials", () => {
  expect(publicBrowserUrl(" https://example.com/docs ")).toBe(
    "https://example.com/docs",
  );
  expect(publicBrowserUrl("example.com")).toBeNull();
  expect(publicBrowserUrl("http://example.com")).toBeNull();
  expect(publicBrowserUrl("https://person:secret@example.com")).toBeNull();
  expect(publicBrowserUrl("javascript:alert(1)")).toBeNull();
});

it("hides and restores the same page without replacing its read identity", async () => {
  const client = fakeClient();
  const owner = new BrowserWorkspaceScope(client, "task-a");
  await owner.open("https://example.com/", bounds);
  const before = owner.current;
  await owner.setVisible(false);
  await owner.setVisible(true, bounds);
  expect(owner.current).toBe(before);
  expect(client.setVisible.mock.calls).toEqual([
    [{ taskKey: "task-a", label: "page-a", visible: false }],
    [{ taskKey: "task-a", label: "page-a", visible: true, bounds }],
  ]);
  expect(client.close).not.toHaveBeenCalled();
  expect((await owner.snapshot()).text).toBe("Public text");
});

it("waits for late open and hide acknowledgement before a requested restore", async () => {
  const client = fakeClient();
  const opened = deferred<BrowserWorkspaceState>();
  const hidden = deferred<void>();
  client.open.mockReturnValueOnce(opened.promise);
  client.setVisible.mockReturnValueOnce(hidden.promise);
  const owner = new BrowserWorkspaceScope(client, "task-a");
  const opening = owner.open("https://example.com/", bounds);
  const hiding = owner.setVisible(false);
  const showing = owner.setVisible(true, bounds);
  expect(client.setVisible).not.toHaveBeenCalled();
  opened.resolve(page());
  await opening;
  await vi.waitFor(() => expect(client.setVisible).toHaveBeenCalledOnce());
  hidden.resolve();
  await hiding;
  await showing;
  expect(client.setVisible).toHaveBeenCalledTimes(2);
  expect(client.setVisible).toHaveBeenLastCalledWith({
    taskKey: "task-a",
    label: "page-a",
    visible: true,
    bounds,
  });
});

it.each([false, true])(
  "retires an owner after unconfirmed visibility %s and still permits exact close",
  async (visible) => {
    const client = fakeClient();
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.open("https://example.com/", bounds);
    client.setVisible.mockRejectedValueOnce(new Error("missing ACK"));
    await expect(
      owner.setVisible(visible, visible ? bounds : undefined),
    ).rejects.toThrow("missing ACK");
    await expect(owner.setVisible(true, bounds)).rejects.toThrow();
    expect(client.setVisible).toHaveBeenCalledOnce();
    expect(owner.isRetired).toBe(true);
    await owner.close();
    expect(client.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
    });
  },
);

it("cannot restore an invisible rectangle or revive a page after close began", async () => {
  const client = fakeClient();
  const owner = new BrowserWorkspaceScope(client, "task-a");
  await owner.open("https://example.com/", bounds);
  await expect(
    owner.setVisible(true, { ...bounds, width: 0 }),
  ).rejects.toThrow();
  expect(client.setVisible).not.toHaveBeenCalled();
  await owner.close();
  expect(owner.accept(page("task-a", "page-a", 99))).toBe(false);
  await expect(owner.setVisible(true, bounds)).rejects.toThrow();
  expect(client.setVisible).not.toHaveBeenCalled();
});

it("retains the identity of a failed native creation until exact close confirms", async () => {
  const client = fakeClient();
  client.open.mockResolvedValueOnce({
    ...page(),
    phase: "error",
    error: "creation not confirmed",
  });
  const closed = deferred<void>();
  client.close.mockReturnValueOnce(closed.promise);
  const owner = new BrowserWorkspaceScope(client, "task-a");
  expect((await owner.open("https://example.com/", bounds)).phase).toBe(
    "error",
  );
  const closing = owner.close();
  await vi.waitFor(() =>
    expect(client.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
    }),
  );
  expect(owner.current?.label).toBe("page-a");
  closed.resolve();
  await closing;
  expect(owner.current).toBeNull();
});

const verifiedHtml = {
  root: "/fixture",
  path: "game.html",
  resolvedPath: "/fixture/game.html",
  name: "game.html",
  size: 120,
  sha256: "fixture-sha",
  version: "fixture-v1",
};

it("passes the exact verified HTML receipt to the isolated native command", async () => {
  const invoke = vi.fn(async () => ({ ...page(), localFileName: "game.html" }));
  const client = createBrowserWorkspaceClient(invoke as any, vi.fn(), vi.fn());
  await client.openHtml({
    taskKey: "task-a",
    file: verifiedHtml,
    bounds,
    projectDirectory: "/project",
  });
  expect(invoke).toHaveBeenCalledWith("browser_workspace_open_html", {
    taskKey: "task-a",
    file: verifiedHtml,
    projectDirectory: "/project",
    bounds,
  });
});

it("waits for public close acknowledgement before opening a local document", async () => {
  const client = fakeClient();
  const old = new BrowserWorkspaceScope(client, "task-a");
  await old.open("https://example.com/", bounds);
  const closed = deferred<void>();
  client.close.mockReturnValueOnce(closed.promise);
  const next = new BrowserWorkspaceScope(client, "task-a", old);
  const opening = next.openHtml(verifiedHtml, bounds, "/project");
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
  expect(client.openHtml).not.toHaveBeenCalled();
  closed.resolve();
  await opening;
  expect(client.openHtml).toHaveBeenCalledWith({
    taskKey: "task-a",
    file: verifiedHtml,
    projectDirectory: "/project",
    bounds,
  });
  await expect(next.snapshot()).rejects.toBeInstanceOf(
    BrowserWorkspaceRetiredError,
  );
  expect(client.snapshot).not.toHaveBeenCalled();
});

it("closes a late local creation and does not give its successor a public navigation", async () => {
  const client = fakeClient();
  const opened = deferred<Awaited<ReturnType<typeof client.openHtml>>>();
  client.openHtml.mockReturnValueOnce(opened.promise);
  const old = new BrowserWorkspaceScope(client, "task-a");
  const opening = old.openHtml(verifiedHtml, bounds, "/project");
  const rejection = expect(opening).rejects.toBeInstanceOf(
    BrowserWorkspaceRetiredError,
  );
  await vi.waitFor(() => expect(client.openHtml).toHaveBeenCalledOnce());
  const next = new BrowserWorkspaceScope(client, "task-a", old);
  const successor = next.open("https://example.com/", bounds);
  expect(client.open).not.toHaveBeenCalled();
  opened.resolve({ ...page(), url: "about:blank", localFileName: "game.html" });
  await successor;
  await rejection;
  expect(client.close).toHaveBeenCalledOnce();
  expect(client.navigate).not.toHaveBeenCalled();
  expect(client.open).toHaveBeenCalledOnce();
});

it("clears only the exact persistent local owner once and makes cleanup await its receipt", async () => {
  const client = fakeClient();
  client.openHtml.mockResolvedValueOnce({
    ...page(),
    url: "about:blank",
    localFileName: "game.html",
    localStoragePersistent: true,
  });
  const owner = new BrowserWorkspaceScope(client, "task-a");
  await owner.openHtml(verifiedHtml, bounds, "/project");
  const cleared = deferred<void>();
  client.clearHtmlStorage.mockReturnValue(cleared.promise);
  const first = owner.clearHtmlStorage();
  expect(owner.clearHtmlStorage()).toBe(first);
  const closing = owner.close();
  await vi.waitFor(() =>
    expect(client.clearHtmlStorage).toHaveBeenCalledOnce(),
  );
  expect(client.clearHtmlStorage).toHaveBeenCalledWith({
    taskKey: "task-a",
    label: "page-a",
  });
  expect(client.close).not.toHaveBeenCalled();
  await expect(owner.navigate("https://example.com/")).rejects.toBeInstanceOf(
    BrowserWorkspaceRetiredError,
  );
  cleared.resolve();
  await Promise.all([first, closing]);
  expect(owner.current).toBeNull();
  expect(client.close).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  "cannot clear a local store without a true persistence receipt (%s)",
  async (persistent) => {
    const client = fakeClient();
    client.openHtml.mockResolvedValueOnce({
      ...page(),
      localFileName: "game.html",
      localStoragePersistent: persistent,
    });
    const owner = new BrowserWorkspaceScope(client, "task-a");
    await owner.openHtml(verifiedHtml, bounds, "/project");
    expect(() => owner.clearHtmlStorage()).toThrow(
      BrowserWorkspaceRetiredError,
    );
    expect(client.clearHtmlStorage).not.toHaveBeenCalled();
  },
);

it("does not clear public-page data and retains exact closure after a failed local deletion", async () => {
  const client = fakeClient();
  const publicPage = new BrowserWorkspaceScope(client, "task-a");
  await publicPage.open("https://example.com/", bounds);
  expect(() => publicPage.clearHtmlStorage()).toThrow(
    BrowserWorkspaceRetiredError,
  );
  client.openHtml.mockResolvedValueOnce({
    ...page(),
    localFileName: "game.html",
    localStoragePersistent: true,
  });
  const local = new BrowserWorkspaceScope(client, "task-a", publicPage);
  await local.openHtml(verifiedHtml, bounds, "/project");
  client.clearHtmlStorage.mockRejectedValueOnce(new Error("delete failed"));
  await expect(local.clearHtmlStorage()).rejects.toThrow("delete failed");
  expect(local.isRetired).toBe(true);
  expect(local.current?.label).toBe("page-a");
  await local.close();
  expect(local.current).toBeNull();
  expect(client.clearHtmlStorage).toHaveBeenCalledOnce();
});

it("maps an explicit clear to the identity-only trusted command", async () => {
  const invoke = vi.fn(async () => undefined);
  const client = createBrowserWorkspaceClient(invoke as any, vi.fn(), vi.fn());
  await client.clearHtmlStorage({ taskKey: "task-a", label: "local-a" });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "browser_workspace_clear_html_storage",
    { taskKey: "task-a", label: "local-a" },
  );
});

it("orders a clear with an already showing page and a later hide without treating it as a new page", async () => {
  const client = fakeClient();
  client.openHtml.mockResolvedValueOnce({
    ...page(),
    localFileName: "game.html",
    localStoragePersistent: true,
  });
  const owner = new BrowserWorkspaceScope(client, "task-a");
  await owner.openHtml(verifiedHtml, bounds, "/project");
  const shown = deferred<void>();
  const cleared = deferred<void>();
  client.setVisible.mockReturnValueOnce(shown.promise);
  client.clearHtmlStorage.mockReturnValueOnce(cleared.promise);
  const showing = owner.setVisible(true, bounds);
  await vi.waitFor(() => expect(client.setVisible).toHaveBeenCalledOnce());
  const clearing = owner.clearHtmlStorage();
  const hiding = owner.setVisible(false);
  shown.resolve();
  await showing;
  expect(client.setVisible).toHaveBeenCalledOnce();
  cleared.resolve();
  await Promise.all([clearing, hiding]);
  expect(owner.current).toBeNull();
  expect(client.close).not.toHaveBeenCalled();
  expect(client.openHtml).toHaveBeenCalledOnce();
});

it("keeps development URLs separate from public addresses and retains explicitly selected default ports", async () => {
  const { developmentBrowserUrl } = await import("./browser_workspace");
  expect(developmentBrowserUrl("http://127.0.0.1:3000")).toBe(
    "http://127.0.0.1:3000/",
  );
  expect(developmentBrowserUrl("https://[::1]:443/")).toBe(
    "https://[::1]:443/",
  );
  for (const input of [
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:70000",
    "http://127.0.0.1:3000/private?token=x",
    "http://name@127.0.0.1:3000",
  ])
    expect(developmentBrowserUrl(input)).toBeNull();
  expect(publicBrowserUrl("http://127.0.0.1:3000")).toBeNull();
});

it("an explicitly selected directory keeps ownership, supports reads and closes a late-created page", async () => {
  const client = fakeClient();
  const pending = deferred<BrowserWorkspaceState>();
  const directory = {
    ...page(),
    localFileName: "index.html",
    previewMode: "directory" as const,
  };
  const openDirectory = vi.fn(() => pending.promise);
  const owner = new BrowserWorkspaceScope(
    { ...client, openDirectory },
    "task-a",
  );
  const opening = owner.openDirectory(
    "/fixture/index.html",
    bounds,
    "/fixture",
  );
  const rejected = expect(opening).rejects.toBeInstanceOf(
    BrowserWorkspaceRetiredError,
  );
  await vi.waitFor(() => expect(openDirectory).toHaveBeenCalledOnce());
  const closing = owner.close();
  pending.resolve(directory);
  await closing;
  await rejected;
  expect(client.close).toHaveBeenCalledWith({
    taskKey: "task-a",
    label: "page-a",
  });
  expect(client.snapshot).not.toHaveBeenCalled();
});
