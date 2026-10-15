import { describe, expect, it, vi } from "vitest";
import { BrowserTabs } from "./browser_tabs";
import {
  BrowserWorkspaceScope,
  BrowserWorkspaceSelectionChangedError,
  type BrowserWorkspaceClient,
  type BrowserWorkspaceState,
  type BrowserWorkspaceTabsState,
} from "./browser_workspace";

const bounds = { x: 0, y: 0, width: 600, height: 400 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(taskKey = "task") {
  const state: BrowserWorkspaceTabsState = {
    taskKey,
    pages: [],
    selection: { label: null, revision: 0 },
  };
  let listener: (event: { taskKey: string }) => void = () => {};
  let id = 0;
  const clone = () => structuredClone(state);
  const page = (url: string): BrowserWorkspaceState => {
    const p: BrowserWorkspaceState = {
      taskKey,
      label: `page-${++id}`,
      url,
      phase: "ready",
      revision: 0,
    };
    state.pages.push(p);
    listener({ taskKey });
    return p;
  };
  const client: BrowserWorkspaceClient = {
    tabs: vi.fn(async () => clone()),
    select: vi.fn(async ({ label, expectedSelected }) => {
      if (
        expectedSelected.label !== state.selection.label ||
        expectedSelected.revision !== state.selection.revision
      )
        throw Error("stale");
      if (state.selection.label !== label)
        state.selection = { label, revision: state.selection.revision + 1 };
      listener({ taskKey });
      return clone();
    }),
    listenTabsChanged: vi.fn(async (next) => {
      listener = next;
      return () => {
        listener = () => {};
      };
    }),
    open: vi.fn(async ({ url }) => page(url)),
    openHtml: vi.fn(async () => page("file")),
    openDirectory: vi.fn(async () => page("directory")),
    openDevelopment: vi.fn(async ({ url }) => page(url)),
    navigate: vi.fn(async ({ label, url }) => {
      const p = state.pages.find((p) => p.label === label)!;
      p.url = url;
      ++p.revision;
      return { ...p };
    }),
    resize: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}),
    snapshot: vi.fn(async ({ label }) => ({
      taskKey,
      label,
      revision: 0,
      url: "https://a.example",
      title: "A",
      text: "body",
      observedAtMs: 1,
    })),
    close: vi.fn(async ({ label }) => {
      state.pages = state.pages.filter((p) => p.label !== label);
      if (state.selection.label === label)
        state.selection = {
          label: null,
          revision: state.selection.revision + 1,
        };
      listener({ taskKey });
    }),
    clearHtmlStorage: vi.fn(async () => {}),
    listenState: vi.fn(async () => () => {}),
  };
  const tabs = new BrowserTabs(client, taskKey);
  const open = async (url = "https://a.example") => {
    const tab = tabs.getSnapshot().selected;
    const result = await tabs.pageClient(tab).open({ taskKey, url, bounds });
    await tabs.refresh();
    return { tab, result };
  };
  return {
    tabs,
    client,
    state,
    page,
    clone,
    open,
    emit: (key = taskKey) => listener({ taskKey: key }),
  };
}

it("retains three independent pages and selecting does not navigate or close", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open("https://b.example");
  await f.tabs.add();
  const c = await f.open("https://c.example");
  expect(f.tabs.getSnapshot().tabs.map((t) => t.page?.label)).toEqual([
    a.result.label,
    b.result.label,
    c.result.label,
  ]);
  await f.tabs.select(a.tab);
  expect(f.state.selection.label).toBe(a.result.label);
  expect(f.client.close).not.toHaveBeenCalled();
  expect(f.client.navigate).not.toHaveBeenCalled();
});
it("does not adopt a reservation twice while its opening reply is held", async () => {
  const f = fixture();
  await f.tabs.start();
  const reply = deferred<BrowserWorkspaceState>();
  vi.mocked(f.client.open).mockImplementationOnce(async ({ url }) => {
    f.page(url);
    return reply.promise;
  });
  const opening = f.open();
  await Promise.resolve();
  await f.tabs.refresh();
  expect(f.tabs.getSnapshot().tabs).toHaveLength(1);
  expect(f.tabs.getSnapshot().tabs[0].opening).toBe(true);
  reply.resolve(f.state.pages[0]);
  await opening;
  expect(f.tabs.getSnapshot().tabs).toHaveLength(1);
  expect(f.client.close).not.toHaveBeenCalled();
});
it("recovers an exact orphan reservation after rejected open without guessing its owner", async () => {
  const f = fixture();
  await f.tabs.start();
  vi.mocked(f.client.open).mockImplementationOnce(async ({ url }) => {
    f.page(url);
    throw Error("uncertain");
  });
  await expect(f.open()).rejects.toThrow("uncertain");
  await f.tabs.refresh();
  const orphan = f.tabs
    .getSnapshot()
    .tabs.find((t) => t.page?.label === "page-1")!;
  expect(orphan).toBeDefined();
  await f.tabs.close(orphan.id);
  expect(f.client.close).toHaveBeenCalledWith({
    taskKey: "task",
    label: "page-1",
  });
});
it("late hidden open retains its page and does not take the newer blank selection", async () => {
  const f = fixture();
  await f.tabs.start();
  const reply = deferred<BrowserWorkspaceState>();
  vi.mocked(f.client.open).mockReturnValueOnce(reply.promise);
  const opening = f.open();
  await f.tabs.add();
  const selected = f.tabs.getSnapshot().selected;
  reply.resolve(f.page("https://a.example"));
  await opening;
  expect(f.tabs.getSnapshot().selected).toBe(selected);
  expect(f.state.selection.label).toBeNull();
  expect(f.client.close).not.toHaveBeenCalled();
});
it("leaving the task during opening never selects that late result", async () => {
  const f = fixture();
  await f.tabs.start();
  const reply = deferred<BrowserWorkspaceState>();
  vi.mocked(f.client.open).mockReturnValueOnce(reply.promise);
  const opening = f.open();
  f.tabs.setActive(false);
  reply.resolve(f.page("https://a.example"));
  await opening;
  expect(f.client.select).not.toHaveBeenCalled();
  expect(f.tabs.getSnapshot().tabs[0].page?.label).toBe("page-1");
});
it("ordinary hiding and returning does not select, navigate or close", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  vi.mocked(f.client.select).mockClear();
  f.tabs.setActive(false);
  await f.tabs
    .pageClient(a.tab)
    .setVisible({ taskKey: "task", label: a.result.label, visible: false });
  f.tabs.setActive(true);
  await f.tabs.pageClient(a.tab).setVisible({
    taskKey: "task",
    label: a.result.label,
    visible: true,
    bounds,
  });
  expect(f.client.select).not.toHaveBeenCalled();
  expect(f.client.close).not.toHaveBeenCalled();
});
it("does not publish a new selected tab until explicit selection ACK", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  const held = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.select).mockReturnValueOnce(held.promise);
  const adding = f.tabs.add();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.tabs.getSnapshot().selected).toBe(a.tab);
  expect(f.tabs.canPresent(a.tab)).toBe(false);
  f.state.selection = { label: null, revision: 2 };
  held.resolve(f.clone());
  await adding;
  expect(f.tabs.getSnapshot().selected).not.toBe(a.tab);
});
it("failed selection retains pages, stays blocked after refresh, and retries only explicitly", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open();
  vi.mocked(f.client.select).mockImplementationOnce(async () => {
    ++f.state.selection.revision;
    throw Error("hide failed");
  });
  await f.tabs.select(a.tab);
  expect(f.tabs.getSnapshot().selected).toBe(b.tab);
  expect(f.tabs.getSnapshot().failed).toBe(true);
  const calls = vi.mocked(f.client.select).mock.calls.length;
  await f.tabs.refresh();
  expect(vi.mocked(f.client.select).mock.calls).toHaveLength(calls);
  expect(f.tabs.canPresent(b.tab)).toBe(false);
  await f.tabs.select(a.tab);
  expect(f.tabs.getSnapshot().failed).toBe(false);
  expect(f.state.selection.label).toBe(a.result.label);
});
it("stale show is withdrawn without retiring the exact page scope", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  const scope = new BrowserWorkspaceScope(f.tabs.pageClient(a.tab), "task");
  scope.adopt(a.result);
  await f.tabs.add();
  await expect(scope.setVisible(true, bounds)).rejects.toBeInstanceOf(
    BrowserWorkspaceSelectionChangedError,
  );
  expect(scope.isRetired).toBe(false);
  await f.tabs.select(a.tab);
  await scope.setVisible(true, bounds);
  expect(scope.isRetired).toBe(false);
});
it("native show failure for the still-selected owner remains a real scope failure", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  const scope = new BrowserWorkspaceScope(f.tabs.pageClient(a.tab), "task");
  scope.adopt(a.result);
  vi.mocked(f.client.setVisible).mockRejectedValueOnce(Error("native"));
  await expect(scope.setVisible(true, bounds)).rejects.toThrow("native");
  expect(scope.isRetired).toBe(true);
});
it("A to B to A rejects a completed manual read despite unchanged URL and page revision", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  const reply = deferred<any>();
  vi.mocked(f.client.snapshot).mockReturnValueOnce(reply.promise);
  const reading = f.tabs
    .pageClient(a.tab)
    .snapshot({ taskKey: "task", label: a.result.label });
  await f.tabs.add();
  await f.tabs.select(a.tab);
  reply.resolve({
    ...a.result,
    text: "old private result",
    title: "A",
    observedAtMs: 1,
  });
  await expect(reading).rejects.toThrow();
});
it("closing a selected page uses exact scope close and selects a retained sibling after ACK", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open();
  const held = deferred<void>();
  const closer = vi.fn(async () => {
    await held.promise;
    await f.tabs
      .pageClient(b.tab)
      .close({ taskKey: "task", label: b.result.label });
  });
  f.tabs.registerCloser(b.tab, closer);
  const closing = f.tabs.close(b.tab);
  await Promise.resolve();
  expect(f.tabs.getSnapshot().tabs.find((t) => t.id === b.tab)?.closing).toBe(
    true,
  );
  expect(f.tabs.getSnapshot().selected).toBe(b.tab);
  held.resolve();
  await closing;
  expect(closer).toHaveBeenCalledTimes(1);
  expect(f.tabs.getSnapshot().selected).toBe(a.tab);
  expect(f.state.selection.label).toBe(a.result.label);
});
it("failed close retains its owner and does not release a sibling or fabricate capacity failure", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  vi.mocked(f.client.close).mockRejectedValueOnce(Error("close"));
  await f.tabs.close(a.tab);
  expect(
    f.tabs.getSnapshot().tabs.find((t) => t.id === a.tab)?.page?.label,
  ).toBe(a.result.label);
  expect(f.tabs.getSnapshot().failed).toBe(true);
  await f.tabs.close(a.tab);
  expect(f.tabs.getSnapshot().tabs).toHaveLength(1);
  expect(f.tabs.getSnapshot().tabs[0].page).toBeNull();
});
it("more than three tabs can be created without automatic eviction", async () => {
  const f = fixture();
  await f.tabs.start();
  for (let i = 0; i < 5; i++) {
    if (i) await f.tabs.add();
    await f.open(`https://p${i}.example`);
  }
  expect(f.tabs.getSnapshot().tabs).toHaveLength(5);
  expect(f.client.close).not.toHaveBeenCalled();
});
it("ignores another task's tabs event and rejects a foreign opening reply", async () => {
  const f = fixture();
  await f.tabs.start();
  const calls = vi.mocked(f.client.tabs).mock.calls.length;
  f.emit("other");
  expect(vi.mocked(f.client.tabs).mock.calls).toHaveLength(calls);
  vi.mocked(f.client.open).mockResolvedValueOnce({
    taskKey: "other",
    label: "foreign",
    url: "https://a.example",
    revision: 0,
    phase: "ready",
  });
  await expect(f.open()).rejects.toThrow();
  expect(f.client.close).not.toHaveBeenCalled();
});
it("metadata refresh never overrides an unresolved close owner", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  const held = deferred<void>();
  vi.mocked(f.client.close).mockReturnValueOnce(held.promise);
  const closing = f.tabs.close(a.tab);
  await Promise.resolve();
  await f.tabs.refresh();
  expect(f.tabs.getSnapshot().tabs.find((t) => t.id === a.tab)?.closing).toBe(
    true,
  );
  held.reject(Error("unknown"));
  await closing;
  expect(
    f.tabs.getSnapshot().tabs.find((t) => t.id === a.tab)?.page?.label,
  ).toBe(a.result.label);
});
it("a listener arriving after cleanup is immediately released", async () => {
  const f = fixture();
  const wait = deferred<() => void>();
  const stop = vi.fn();
  vi.mocked(f.client.listenTabsChanged).mockReturnValueOnce(wait.promise);
  const started = f.tabs.start();
  f.tabs.retire();
  wait.resolve(stop);
  await started;
  expect(stop).toHaveBeenCalledOnce();
});
it("selection bridge uses fresh exact revision after a rejected request", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  f.state.selection.revision = 12;
  await f.tabs.select(a.tab);
  expect(f.client.select).toHaveBeenLastCalledWith({
    taskKey: "task",
    label: a.result.label,
    expectedSelected: { label: null, revision: 12 },
  });
});

it("finishes the explicit selection while hidden without stranding its busy state", async () => {
  const f = fixture();
  await f.tabs.start();
  await f.open();
  const held = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.select).mockReturnValueOnce(held.promise);
  const adding = f.tabs.add();
  await Promise.resolve();
  await Promise.resolve();
  f.tabs.setActive(false);
  f.state.selection = { label: null, revision: 2 };
  held.resolve(f.clone());
  await adding;
  f.tabs.setActive(true);
  expect(f.tabs.getSnapshot().changing).toBe(false);
  expect(f.tabs.getSnapshot().selected).toBe(f.tabs.getSnapshot().tabs[1].id);
  expect(f.client.setVisible).not.toHaveBeenCalled();
});

it("a late page after teardown remains owned by its scope through failed close and retry", async () => {
  const f = fixture();
  await f.tabs.start();
  const id = f.tabs.getSnapshot().selected;
  const scope = new BrowserWorkspaceScope(f.tabs.pageClient(id), "task");
  const held = deferred<BrowserWorkspaceState>();
  vi.mocked(f.client.open).mockReturnValueOnce(held.promise);
  const opening = scope.open("https://a.example", bounds);
  await Promise.resolve();
  await Promise.resolve();
  f.tabs.retire();
  vi.mocked(f.client.close).mockRejectedValueOnce(Error("close unknown"));
  const closing = scope.close();
  held.resolve(f.page("https://a.example"));
  await expect(opening).rejects.toThrow();
  await expect(closing).rejects.toThrow("close unknown");
  expect(scope.current?.label).toBe("page-1");
  await scope.close();
  expect(scope.current).toBeNull();
  expect(f.client.select).not.toHaveBeenCalled();
});
it("an explicitly selected hidden late-open page can be activated without recreating it", async () => {
  const f = fixture();
  await f.tabs.start();
  const held = deferred<BrowserWorkspaceState>();
  vi.mocked(f.client.open).mockReturnValueOnce(held.promise);
  const opening = f.open();
  f.tabs.setActive(false);
  held.resolve(f.page("https://a.example"));
  const a = await opening;
  f.tabs.setActive(true);
  await f.tabs.select(a.tab);
  expect(f.state.selection.label).toBe(a.result.label);
  expect(f.client.open).toHaveBeenCalledOnce();
});
it("clearing one document acknowledges only that page and leaves siblings alive", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open();
  vi.mocked(f.client.clearHtmlStorage).mockImplementationOnce(
    async ({ label }) => {
      f.state.pages = f.state.pages.filter((p) => p.label !== label);
      f.state.selection = { label: null, revision: 4 };
    },
  );
  await f.tabs
    .pageClient(b.tab)
    .clearHtmlStorage({ taskKey: "task", label: b.result.label });
  expect(
    f.tabs.getSnapshot().tabs.find((t) => t.id === b.tab)?.page,
  ).toBeNull();
  expect(
    f.tabs.getSnapshot().tabs.find((t) => t.id === a.tab)?.page?.label,
  ).toBe(a.result.label);
  expect(f.client.close).not.toHaveBeenCalled();
});

it("does not silently proceed without tabs events, and retries subscription only on explicit selection", async () => {
  const f = fixture();
  vi.mocked(f.client.listenTabsChanged).mockRejectedValueOnce(
    Error("listen failed"),
  );
  await f.tabs.start();
  expect(f.tabs.getSnapshot().failed).toBe(true);
  expect(f.client.select).not.toHaveBeenCalled();
  await f.tabs.select(f.tabs.getSnapshot().selected);
  expect(f.client.listenTabsChanged).toHaveBeenCalledTimes(2);
  expect(f.tabs.getSnapshot().failed).toBe(false);
});
it("StrictMode-style start replay never lets the first late listener supersede the second", async () => {
  const f = fixture();
  const first = deferred<() => void>();
  const stop = vi.fn();
  vi.mocked(f.client.listenTabsChanged).mockReturnValueOnce(first.promise);
  const old = f.tabs.start();
  f.tabs.retire();
  await f.tabs.start();
  first.resolve(stop);
  await old;
  expect(stop).toHaveBeenCalledOnce();
  expect(f.tabs.getSnapshot().ready).toBe(true);
  await f.tabs.add();
  expect(f.tabs.getSnapshot().selected).toBe("tab-2");
});

it.each([false, true])(
  "finishes selected close while hidden with a valid successor (last=%s)",
  async (last) => {
    const f = fixture();
    await f.tabs.start();
    const a = await f.open();
    if (!last) {
      await f.tabs.add();
      await f.open("https://b.example");
    }
    const selected = f.tabs.getSnapshot().selected;
    const held = deferred<void>();
    const close = f.client.close;
    vi.mocked(close).mockImplementationOnce(async ({ label }) => {
      await held.promise;
      f.state.pages = f.state.pages.filter((page) => page.label !== label);
      f.state.selection = {
        label: null,
        revision: f.state.selection.revision + 1,
      };
    });
    const closing = f.tabs.close(selected);
    await Promise.resolve();
    f.tabs.setActive(false);
    held.resolve();
    await closing;
    f.tabs.setActive(true);
    const next = f.tabs.getSnapshot();
    expect(next.tabs.some((tab) => tab.id === next.selected)).toBe(true);
    expect(next.selected).not.toBe(selected);
    expect(next.changing).toBe(false);
    expect(f.state.selection.label).toBe(last ? null : a.result.label);
    expect(f.client.setVisible).not.toHaveBeenCalled();
  },
);

it("keeps selected-close locked through its successor ACK, then respects the next explicit choice", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open();
  await f.tabs.add();
  const c = await f.open();
  const held = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.select).mockReturnValueOnce(held.promise);
  const closing = f.tabs.close(c.tab);
  await vi.waitFor(() =>
    expect(f.client.select).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: b.result.label }),
    ),
  );
  expect(f.tabs.getSnapshot().changing).toBe(true);
  await f.tabs.select(a.tab);
  expect(f.tabs.getSnapshot().selected).toBe(b.tab);
  f.state.selection = {
    label: b.result.label,
    revision: f.state.selection.revision + 1,
  };
  held.resolve(f.clone());
  await closing;
  await f.tabs.select(a.tab);
  expect(f.tabs.getSnapshot().selected).toBe(a.tab);
  expect(f.state.selection.label).toBe(a.result.label);
});

it("reopens remembered metadata through a fresh scope and preserves the previous tab", async () => {
  const f = fixture();
  f.client.openRemembered = vi.fn(async () =>
    f.page("https://www.rust-lang.org/learn"),
  );
  await f.tabs.start();
  const previous = await f.open();
  const id = await f.tabs.add();
  expect(id).toBeTruthy();
  const scope = new BrowserWorkspaceScope(f.tabs.pageClient(id!), "task");
  const request = {
    owner: { sessionId: "task", createdAt: 1 },
    expectedRevision: 4,
    itemId: "saved",
  };
  const page = await scope.openRemembered(request, bounds);
  expect(page.label).not.toBe(previous.result.label);
  expect(f.client.openRemembered).toHaveBeenCalledExactlyOnceWith({
    ...request,
    bounds,
  });
  expect(f.client.navigate).not.toHaveBeenCalled();
  expect(f.client.close).not.toHaveBeenCalled();
  expect(f.tabs.getSnapshot().tabs.filter((tab) => tab.page)).toHaveLength(2);
  await scope.close();
  expect(f.client.close).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task",
    label: page.label,
  });
});

it("retirement keeps the exact late remembered owner available for close retry", async () => {
  const f = fixture();
  const pending = deferred<BrowserWorkspaceState>();
  f.client.openRemembered = vi.fn(() => pending.promise);
  await f.tabs.start();
  const id = f.tabs.getSnapshot().selected;
  const scope = new BrowserWorkspaceScope(f.tabs.pageClient(id), "task");
  const opening = scope.openRemembered(
    {
      owner: { sessionId: "task", createdAt: 1 },
      expectedRevision: 4,
      itemId: "saved",
    },
    bounds,
  );
  await Promise.resolve();
  await Promise.resolve();
  const closing = scope.close();
  f.tabs.retire();
  pending.resolve(f.page("https://www.rust-lang.org/learn"));
  await expect(opening).rejects.toThrow();
  await closing;
  expect(f.client.close).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task",
    label: "page-1",
  });
});

it("never reopens a remembered record for a different task scope", async () => {
  const f = fixture();
  f.client.openRemembered = vi.fn();
  const scope = new BrowserWorkspaceScope(f.client, "task");
  await expect(
    scope.openRemembered(
      {
        owner: { sessionId: "other", createdAt: 1 },
        expectedRevision: 0,
        itemId: "saved",
      },
      bounds,
    ),
  ).rejects.toThrow();
  expect(f.client.openRemembered).not.toHaveBeenCalled();
});
