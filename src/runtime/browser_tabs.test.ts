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
it("keeps an acknowledged tab selected when the switching snapshot arrives late", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open("https://b.example");
  await f.tabs.select(a.tab);

  const switchingRead = deferred<BrowserWorkspaceTabsState>();
  const began = deferred<BrowserWorkspaceTabsState>();
  const finish = deferred<void>();
  vi.mocked(f.client.select).mockImplementationOnce(
    async ({ label, expectedSelected }) => {
      expect(expectedSelected).toEqual(f.state.selection);
      const revision = expectedSelected.revision + 1;
      // The native begin event can expose the old label at the new revision.
      f.state.selection = { label: a.result.label, revision };
      ++f.state.pages.find(({ label }) => label === a.result.label)!.revision;
      const switching = f.clone();
      vi.mocked(f.client.tabs).mockReturnValueOnce(switchingRead.promise);
      f.emit();
      began.resolve(switching);
      await finish.promise;
      f.state.selection = { label, revision };
      return f.clone();
    },
  );
  vi.mocked(f.client.select).mockClear();
  const selecting = f.tabs.select(b.tab);
  const switching = await began.promise;
  expect(f.tabs.getSnapshot()).toMatchObject({
    selected: a.tab,
    changing: true,
  });
  expect(f.tabs.canPresent(a.tab)).toBe(false);
  finish.resolve();
  await selecting;
  expect(f.state.selection).toEqual({
    label: b.result.label,
    revision: switching.selection.revision,
  });
  expect(f.tabs.canPresent(b.tab)).toBe(true);
  expect(f.tabs.canPresent(a.tab)).toBe(false);

  // Deliver the earlier read after the select ACK, before the completion event.
  switchingRead.resolve(switching);
  await switchingRead.promise;
  const afterLateRead = {
    selected: f.tabs.getSnapshot().selected,
    ready: f.tabs.canPresent(b.tab),
    oldReady: f.tabs.canPresent(a.tab),
    failed: f.tabs.getSnapshot().failed,
  };
  const scope = new BrowserWorkspaceScope(f.tabs.pageClient(b.tab), "task");
  scope.adopt(b.result);
  const show = await Promise.allSettled([scope.setVisible(true, bounds)]);

  const bState = f.state.pages.find(({ label }) => label === b.result.label)!;
  bState.url = "https://b.example/next";
  ++bState.revision;
  const completionRead = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.tabs).mockReturnValueOnce(completionRead.promise);
  f.emit();
  completionRead.resolve(f.clone());
  await completionRead.promise;
  expect(
    f.tabs.getSnapshot().tabs.find(({ id }) => id === b.tab)?.page?.url,
  ).toBe(bState.url);
  expect(f.client.select).toHaveBeenCalledTimes(1);
  expect(f.client.navigate).not.toHaveBeenCalled();
  expect(f.client.close).not.toHaveBeenCalled();
  expect(afterLateRead).toEqual({
    selected: b.tab,
    ready: true,
    oldReady: false,
    failed: false,
  });
  expect(show).toEqual([{ status: "fulfilled", value: undefined }]);
  expect(f.client.setVisible).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task",
    label: b.result.label,
    visible: true,
    bounds,
  });
});

it("keeps a newer page event when a read of the same selected label arrives late", async () => {
  const f = fixture();
  await f.tabs.start();
  const { tab, result } = await f.open();
  const earlier = f.clone();
  const held = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.tabs).mockReturnValueOnce(held.promise);
  const refreshing = f.tabs.refresh();

  const page = f.state.pages.find(({ label }) => label === result.label)!;
  page.url = "https://a.example/new";
  ++page.revision;
  f.tabs.observe(tab, { ...page });
  expect(f.tabs.getSnapshot().tabs[0].page).toEqual(page);
  expect(earlier.selection).toEqual(f.state.selection);

  held.resolve(earlier);
  await refreshing;

  expect(f.tabs.getSnapshot().selected).toBe(tab);
  expect(f.tabs.canPresent(tab)).toBe(true);
  expect(f.tabs.getSnapshot().tabs[0].page).toEqual(page);
});

it("discards a failed tabs read after a newer read succeeds", async () => {
  const f = fixture();
  await f.tabs.start();
  const { tab } = await f.open();
  const held = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.tabs).mockReturnValueOnce(held.promise);
  const old = f.tabs.refresh();
  await f.tabs.refresh();

  held.reject(Error("old read failed"));
  await expect(old).resolves.toBeUndefined();
  expect(f.tabs.canPresent(tab)).toBe(true);

  vi.mocked(f.client.tabs).mockRejectedValueOnce(Error("current read failed"));
  await expect(f.tabs.refresh()).rejects.toThrow("current read failed");
});

it("does not publish an old background failure over a newer explicit selection", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  await f.open("https://b.example");

  const old = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.tabs).mockReturnValueOnce(old.promise);
  f.emit();
  old.reject(Error("old read failed"));
  // The old read settles first. An extra Promise catch would report its
  // failure after the newer selection has already started.
  const selection = new Promise<void>((resolve) => {
    queueMicrotask(() => resolve(f.tabs.select(a.tab)));
  });
  await selection;

  expect(f.tabs.getSnapshot().selected).toBe(a.tab);
  expect(f.tabs.canPresent(a.tab)).toBe(true);
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

it.each([
  ["close", "fails"],
  ["clearHtmlStorage", "fails"],
  ["close", "stays pending"],
  ["clearHtmlStorage", "stays pending"],
] as const)(
  "keeps the acknowledged %s when the next tabs read %s",
  async (action, readOutcome) => {
    const f = fixture();
    await f.tabs.start();
    const a = await f.open();
    if (action === "clearHtmlStorage") {
      a.result.localFileName = "owned.html";
      a.result.localStoragePersistent = true;
    }
    const scope = new BrowserWorkspaceScope(f.tabs.pageClient(a.tab), "task");
    scope.adopt(a.result);
    await f.tabs.add();
    const b = await f.open("https://b.example");
    await f.tabs.select(a.tab);

    const held = deferred<BrowserWorkspaceTabsState>();
    const readStarted = deferred<void>();
    const native = vi.mocked(f.client[action]);
    native.mockImplementationOnce(async (input) => {
      expect(input).toEqual({ taskKey: "task", label: a.result.label });
      f.state.pages = f.state.pages.filter(
        (page) => page.label !== input.label,
      );
      f.state.selection = {
        label: null,
        revision: f.state.selection.revision + 1,
      };
      vi.mocked(f.client.tabs).mockImplementationOnce(() => {
        readStarted.resolve();
        return readOutcome === "fails"
          ? Promise.reject(Error("metadata unavailable"))
          : held.promise;
      });
    });

    const operation = scope[action]();
    if (readOutcome === "stays pending") {
      await readStarted.promise;
      const settlement = await Promise.race([
        operation.then(() => "acknowledged"),
        new Promise<string>((resolve) => setImmediate(() => resolve("held"))),
      ]);
      held.resolve(f.clone());
      await operation;
      expect(settlement).toBe("acknowledged");
    }
    await expect(operation).resolves.toBeUndefined();

    expect(native).toHaveBeenCalledOnce();
    expect(scope.current).toBeNull();
    expect(
      f.tabs.getSnapshot().tabs.find(({ id }) => id === a.tab)?.page,
    ).toBeNull();
    expect(
      f.tabs.getSnapshot().tabs.find(({ id }) => id === b.tab)?.page,
    ).toEqual(b.result);
  },
);

it("keeps the selected sibling available when a confirmed background close cannot refresh", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open("https://b.example");
  vi.mocked(f.client.close).mockImplementationOnce(async ({ label }) => {
    expect(label).toBe(a.result.label);
    f.state.pages = f.state.pages.filter((page) => page.label !== label);
    vi.mocked(f.client.tabs).mockRejectedValueOnce(
      Error("metadata unavailable"),
    );
  });
  vi.mocked(f.client.select).mockClear();

  await f.tabs.close(a.tab);

  expect(f.tabs.getSnapshot().tabs.map((tab) => tab.id)).toEqual([b.tab]);
  expect(f.tabs.getSnapshot().selected).toBe(b.tab);
  expect(f.tabs.canPresent(b.tab)).toBe(true);
  expect(f.client.select).not.toHaveBeenCalled();
});

it("uses one required read after closing the selected tab and rejects the earlier list", async () => {
  const f = fixture();
  await f.tabs.start();
  const a = await f.open();
  await f.tabs.add();
  const b = await f.open("https://b.example");
  const earlier = f.clone();
  const old = deferred<BrowserWorkspaceTabsState>();
  const readStarted = deferred<void>();
  const required = deferred<BrowserWorkspaceTabsState>();
  const duplicate = deferred<BrowserWorkspaceTabsState>();
  vi.mocked(f.client.tabs).mockReturnValueOnce(old.promise);
  const oldRead = f.tabs.refresh();
  vi.mocked(f.client.tabs).mockClear();
  vi.mocked(f.client.tabs)
    .mockImplementationOnce(() => {
      readStarted.resolve();
      return required.promise;
    })
    .mockReturnValueOnce(duplicate.promise);
  vi.mocked(f.client.close).mockImplementationOnce(async ({ label }) => {
    expect(label).toBe(b.result.label);
    f.state.pages = f.state.pages.filter((page) => page.label !== label);
    f.state.selection = {
      label: null,
      revision: earlier.selection.revision + 1,
    };
  });
  vi.mocked(f.client.select).mockClear();
  vi.mocked(f.client.select).mockImplementationOnce(
    async ({ label, expectedSelected }) => {
      expect(expectedSelected).toEqual(f.state.selection);
      f.state.selection = { label, revision: expectedSelected.revision + 1 };
      return f.clone();
    },
  );

  const closing = f.tabs.close(b.tab);
  await readStarted.promise;
  expect(f.tabs.getSnapshot().changing).toBe(true);
  old.resolve(earlier);
  await oldRead;
  expect(f.tabs.getSnapshot().tabs.map((tab) => tab.id)).toEqual([a.tab]);
  required.resolve(f.clone());
  const settlement = await Promise.race([
    closing.then(() => "selected"),
    new Promise<string>((resolve) => setImmediate(() => resolve("held"))),
  ]);
  duplicate.resolve(f.clone());
  await closing;

  expect(settlement).toBe("selected");
  expect(f.client.tabs).toHaveBeenCalledExactlyOnceWith({ taskKey: "task" });
  expect(f.client.select).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task",
    label: a.result.label,
    expectedSelected: { label: null, revision: earlier.selection.revision + 1 },
  });
  expect(f.tabs.canPresent(a.tab)).toBe(true);
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
