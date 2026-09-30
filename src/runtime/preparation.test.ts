import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  cancelDependencyInstall,
  installAgentDependency,
  officialLink,
  accountLinksForMethod,
  type PreparationInfo,
  getAgentPreparation,
} from "./preparation";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
const invokeMock = vi.mocked(invoke);
const ready: PreparationInfo = { dependencies: [], links: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => invokeMock.mockReset());

it("refreshes version diagnostics explicitly and keeps candidate installation in the existing cancellation owner", async () => {
  invokeMock.mockResolvedValue(ready);
  await getAgentPreparation("versioned");
  expect(invokeMock).toHaveBeenLastCalledWith("agent_preparation", {
    agentId: "versioned",
    refresh: false,
  });
  await getAgentPreparation("versioned", true);
  expect(invokeMock).toHaveBeenLastCalledWith("agent_preparation", {
    agentId: "versioned",
    refresh: true,
  });
  const request = deferred<PreparationInfo>();
  invokeMock.mockImplementation(
    (command) =>
      (command === "agent_dependency_install"
        ? request.promise
        : Promise.resolve()) as never,
  );
  const installing = installAgentDependency(
    "versioned",
    "program",
    vi.fn(),
    "prepare_candidate",
  );
  expect(invokeMock).toHaveBeenLastCalledWith(
    "agent_dependency_install",
    expect.objectContaining({
      mode: "prepare_candidate",
      dependencyId: "program",
    }),
  );
  await expect(
    installAgentDependency("versioned", "program", vi.fn()),
  ).rejects.toThrow("正在准备");
  await cancelDependencyInstall("versioned");
  expect(invokeMock).toHaveBeenLastCalledWith(
    "agent_dependency_cancel",
    expect.objectContaining({ agentId: "versioned" }),
  );
  request.resolve(ready);
  await installing;
});

it("cancels an early request again once its backend job starts, then ignores late progress", async () => {
  const request = deferred<PreparationInfo>();
  let channel!: { onmessage: (value: unknown) => void };
  invokeMock.mockImplementation((command, args) => {
    if (command === "agent_dependency_install") {
      channel = (args as { onProgress: typeof channel }).onProgress;
      return request.promise as never;
    }
    return Promise.resolve() as never;
  });
  const work = installAgentDependency("early", "program", vi.fn());
  await cancelDependencyInstall("early");
  channel.onmessage({ stage: "download" });
  channel.onmessage({ stage: "cancelling" });
  expect(
    invokeMock.mock.calls.filter(([c]) => c === "agent_dependency_cancel"),
  ).toHaveLength(2);
  request.resolve(ready);
  await work;
  channel.onmessage({ stage: "check" });
  await cancelDependencyInstall("early");
  expect(
    invokeMock.mock.calls.filter(([c]) => c === "agent_dependency_cancel"),
  ).toHaveLength(2);
});

it("keeps a same-Agent install owned until both install and cancellation settle", async () => {
  const request = deferred<PreparationInfo>();
  const cancellation = deferred<void>();
  invokeMock.mockImplementation(
    (command) =>
      (command === "agent_dependency_install"
        ? request.promise
        : cancellation.promise) as never,
  );
  const work = installAgentDependency("owned", "program", vi.fn());
  const cancel = cancelDependencyInstall("owned");
  request.resolve(ready);
  await Promise.resolve();
  await expect(
    installAgentDependency("owned", "program", vi.fn()),
  ).rejects.toThrow("正在准备");
  cancellation.resolve();
  await cancel;
  await work;
  invokeMock.mockResolvedValue(ready);
  await expect(
    installAgentDependency("owned", "program", vi.fn()),
  ).resolves.toEqual(ready);
});

it("only opens public HTTPS preparation links", () => {
  expect(officialLink("https://example.test/accounts")).toBe(true);
  for (const url of [
    "file:///tmp/a",
    "javascript:alert(1)",
    "http://example.test",
    "https://secret@example.test",
    "not a url",
  ])
    expect(officialLink(url)).toBe(false);
});

it("keeps account registration guidance with the selected declared method", () => {
  const links: PreparationInfo["links"] = [
    {
      label: "Account A",
      url: "https://a.example.test",
      kind: "account",
      methodIds: ["a"],
    },
    {
      label: "Account B",
      url: "https://b.example.test",
      kind: "account",
      methodIds: ["b"],
    },
    {
      label: "Guide",
      url: "https://guide.example.test",
      kind: "documentation",
    },
    {
      label: "Invalid",
      url: "file:///tmp/private",
      kind: "account",
      methodIds: ["a"],
    },
  ];
  expect(accountLinksForMethod(links, "a").map((item) => item.label)).toEqual([
    "Account A",
    "Guide",
  ]);
  expect(accountLinksForMethod(links, "b").map((item) => item.label)).toEqual([
    "Account B",
    "Guide",
  ]);
  expect(
    accountLinksForMethod(links, "future-method").map((item) => item.label),
  ).toEqual(["Guide"]);
  expect(accountLinksForMethod(links).map((item) => item.label)).toEqual([
    "Guide",
  ]);
});
