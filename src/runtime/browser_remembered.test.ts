import { describe, expect, it, vi } from "vitest";
import {
  RememberedBrowserPages,
  createRememberedBrowserPagesClient,
  rememberablePage,
  ownerForRememberedPages,
  type RememberedBrowserList,
  type RememberedBrowserPagesClient,
} from "./browser_remembered";

const owner = { sessionId: "agent:/work:native", createdAt: 42 };
const page = {
  taskKey: owner.sessionId,
  label: "live-page",
  revision: 7,
  phase: "ready" as const,
  url: "https://www.rust-lang.org/learn?q=ownership#examples",
};

it("uses only an existing exact canonical index row after establishment", () => {
  // Production sessions.open builds key from returned canonical cwd; touch_session_row
  // uses the same agent/cwd/native triple. An alias must not become a durable owner.
  const thread = {
    identity: "established" as const,
    key: "agent:/private/tmp/work:native",
    agentId: "agent",
    cwd: "/private/tmp/work",
    nativeSessionId: "native",
  };
  const row = {
    id: thread.key,
    agentId: thread.agentId,
    cwd: thread.cwd,
    nativeSessionId: thread.nativeSessionId,
    createdAt: 42,
    updatedAt: 50,
    title: null,
    configOptions: null,
    pinned: false,
    archived: false,
  };
  expect(ownerForRememberedPages(thread, row)).toEqual({
    sessionId: row.id,
    createdAt: 42,
  });
  expect(
    ownerForRememberedPages({ ...thread, identity: "draft" }, row),
  ).toBeNull();
  expect(ownerForRememberedPages(thread, undefined)).toBeNull();
  expect(
    ownerForRememberedPages({ ...thread, key: "agent:/tmp/work:native" }, row),
  ).toBeNull();
  expect(
    ownerForRememberedPages(thread, { ...row, nativeSessionId: "different" }),
  ).toBeNull();
  expect(
    ownerForRememberedPages(thread, { ...row, agentId: "other" }),
  ).toBeNull();
  expect(
    ownerForRememberedPages(thread, { ...row, cwd: "/tmp/work" }),
  ).toBeNull();
  expect(
    ownerForRememberedPages(thread, { ...row, createdAt: NaN }),
  ).toBeNull();
});
const list = (
  revision = 0,
  items: RememberedBrowserList["items"] = [],
): RememberedBrowserList => ({
  owner: { ...owner },
  revision,
  items,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const client: RememberedBrowserPagesClient = {
    list: vi.fn(async () => list()),
    remember: vi.fn(async () => list(1, [{ id: "one", url: page.url }])),
    forget: vi.fn(async () => list(2)),
  };
  return { client, model: new RememberedBrowserPages(client, owner) };
}

it("bridges only the locked metadata IPC arguments", async () => {
  const invoke = vi.fn(async () => list());
  const client = createRememberedBrowserPagesClient(invoke as any);
  await client.list({ owner });
  await client.remember({
    owner,
    expectedRevision: 0,
    label: page.label,
    pageRevision: 7,
    confirmedUrl: page.url,
  });
  await client.forget({ owner, expectedRevision: 1, itemId: "one" });
  expect(invoke.mock.calls).toEqual([
    ["browser_pages_list", { owner }],
    [
      "browser_pages_remember",
      {
        owner,
        expectedRevision: 0,
        label: page.label,
        pageRevision: 7,
        confirmedUrl: page.url,
      },
    ],
    ["browser_pages_forget", { owner, expectedRevision: 1, itemId: "one" }],
  ]);
});

it("startup only reads the dormant list and opens nothing", async () => {
  const { client, model } = fixture();
  vi.mocked(client.list).mockResolvedValue(
    list(8, [{ id: "one", url: page.url }]),
  );
  await model.start();
  expect(client.list).toHaveBeenCalledExactlyOnceWith({ owner });
  expect(client.remember).not.toHaveBeenCalled();
  expect(client.forget).not.toHaveBeenCalled();
  expect(model.opening("one")).toEqual({
    owner,
    itemId: "one",
    expectedRevision: 8,
  });
  expect(model.opening("missing")).toBeNull();
});

it("remembers the confirmed exact page, revision and URL without page content", async () => {
  const { client, model } = fixture();
  await model.start();
  expect(await model.remember(page)).toBe(true);
  expect(client.remember).toHaveBeenCalledExactlyOnceWith({
    owner,
    expectedRevision: 0,
    label: page.label,
    pageRevision: 7,
    confirmedUrl: page.url,
  });
  expect(model.getSnapshot().list.items).toEqual([
    { id: "one", url: page.url },
  ]);
});

it("unknown writes never retry and require an explicit successful metadata recheck", async () => {
  const { client, model } = fixture();
  await model.start();
  vi.mocked(client.remember).mockRejectedValue(Error("lost reply"));
  expect(await model.remember(page)).toBe(false);
  expect(model.getSnapshot().error).toBe("unknown");
  expect(await model.remember(page)).toBe(false);
  expect(await model.forget(null)).toBe(false);
  expect(model.opening("one")).toBeNull();
  expect(client.remember).toHaveBeenCalledTimes(1);
  expect(client.list).toHaveBeenCalledTimes(1);
  // The original operation could have succeeded. Recheck observes that value
  // without replaying its write or attributing the writer.
  vi.mocked(client.list).mockResolvedValue(
    list(1, [{ id: "one", url: page.url }]),
  );
  await model.refresh();
  expect(model.getSnapshot().ready).toBe(true);
  expect(model.getSnapshot().error).toBe("");
  expect(client.remember).toHaveBeenCalledTimes(1);
});

it("StrictMode restart ignores the preceding effect's late read", async () => {
  const { client, model } = fixture();
  const first = deferred<RememberedBrowserList>();
  const second = deferred<RememberedBrowserList>();
  vi.mocked(client.list)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const a = model.start();
  model.retire();
  const b = model.start();
  second.resolve(list(3, [{ id: "new", url: page.url }]));
  await b;
  first.resolve(list(0, [{ id: "old", url: "https://www.rust-lang.org/old" }]));
  await a;
  expect(model.getSnapshot().list.items.map((item) => item.id)).toEqual([
    "new",
  ]);
  expect(model.getSnapshot().busy).toBeNull();
});

it("late write after retirement cannot publish or replay on restart", async () => {
  const { client, model } = fixture();
  await model.start();
  const pending = deferred<RememberedBrowserList>();
  vi.mocked(client.remember).mockReturnValue(pending.promise);
  const writing = model.remember(page);
  model.retire();
  await model.start();
  pending.resolve(list(1, [{ id: "old", url: page.url }]));
  expect(await writing).toBe(false);
  expect(model.getSnapshot().list.items).toEqual([]);
  expect(client.remember).toHaveBeenCalledTimes(1);
  expect(client.list).toHaveBeenCalledTimes(2);
});

it.each([
  { ...list(), owner: { ...owner, createdAt: owner.createdAt + 1 } },
  { ...list(), owner: { ...owner, sessionId: "another-conversation" } },
  list(-1),
  list(1, [
    { id: "same", url: page.url },
    { id: "same", url: page.url },
  ]),
])("rejects wrong or malformed list identity %#", async (returned) => {
  const { client, model } = fixture();
  vi.mocked(client.list).mockResolvedValue(returned);
  await model.start();
  expect(model.getSnapshot().ready).toBe(false);
  expect(model.getSnapshot().error).toBe("load");
  expect(await model.remember(page)).toBe(false);
});

it("forgetting one or all records only performs a CAS metadata operation", async () => {
  const { client, model } = fixture();
  vi.mocked(client.list).mockResolvedValue(
    list(1, [{ id: "one", url: page.url }]),
  );
  await model.start();
  await model.forget("one");
  await model.forget(null);
  expect(client.forget).toHaveBeenNthCalledWith(1, {
    owner,
    expectedRevision: 1,
    itemId: "one",
  });
  expect(client.forget).toHaveBeenNthCalledWith(2, {
    owner,
    expectedRevision: 2,
    itemId: null,
  });
  expect(client.remember).not.toHaveBeenCalled();
});

describe("current-page eligibility", () => {
  it("allows a ready public page including its ordinary query and fragment", () => {
    expect(rememberablePage(page)).toBe(true);
  });
  it.each([
    null,
    { ...page, phase: "loading" as const },
    { ...page, localFileName: "file.html" },
    { ...page, previewMode: "development" as const },
    ...[
      "file:///file.html",
      "http://127.0.0.1:1541/",
      "https://localhost/",
      "https://[::1]/",
      "https://127.0.0.1/",
      "https://user:secret@www.rust-lang.org/",
    ].map((url) => ({ ...page, url })),
  ])("does not offer remembering a non-public/not-ready page %#", (value) => {
    expect(rememberablePage(value)).toBe(false);
  });
});
