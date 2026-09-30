import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset().mockResolvedValue(null);
});
const progress = {
  step: 1,
  choice: "login" as const,
  authMethodId: "official",
  selection: { service: null, config: { model: "chosen", reasoning: "ultra" } },
};

it("retains public installation choices separately from conversation models across save and return", async () => {
  const installationInput = {
    declarationId: "fixture-model-v1",
    registryVersion: "1.0.0",
    launch: { kind: "uvx" as const, package: "fixture==1.0.0", args: ["-x"] },
    values: { model: "$system.chosen" },
  };
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  store.remember("a", "scope", { ...progress, installationInput });
  await store.flush();
  const saved = structuredClone(
    mock.invoke.mock.calls
      .filter(([name]) => name === "settings_set")
      .at(-1)![1].value,
  );
  vi.resetModules();
  mock.invoke.mockResolvedValue(saved);
  const { setupStorage: restored } = await import("./setup_storage");
  await restored.load();
  expect(restored.snapshot().progress.scope.installationInput).toEqual(
    installationInput,
  );
  expect(restored.snapshot().progress.scope.selection).toEqual(
    progress.selection,
  );
  expect(restored.completed("a")).toBe(false);
});

it("keeps legacy progress and flags malformed installation values without persisting the rejected text", async () => {
  mock.invoke.mockResolvedValue({
    version: 1,
    completed: [],
    pending: { a: "scope" },
    progress: {
      scope: {
        ...progress,
        installationInput: {
          declarationId: "model-v1",
          registryVersion: "1.0.0",
          launch: { kind: "uvx", package: "fixture==1.0.0", args: ["-x"] },
          values: { model: "sk-test-secret" },
        },
      },
      legacy: progress,
    },
  });
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  expect(store.snapshot().progress.legacy).toEqual(progress);
  const rejected = store.snapshot().progress.scope;
  expect(rejected.installationInput).toBeUndefined();
  expect(rejected.installationInputInvalid).toBe(true);
  expect(rejected.selection).toEqual(progress.selection);
  mock.invoke.mockResolvedValue(null);
  store.remember("a", "scope", { ...rejected, step: 0 });
  await store.flush();
  const saved = mock.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  expect(JSON.stringify(saved)).not.toContain("sk-test-secret");
  expect(saved.progress.scope.installationInputInvalid).toBe(true);
});

it("restores a registration page as UI progress only and ignores invalid or different-method records", async () => {
  const registration = {
    methodId: "official",
    url: "https://account.example.com/",
    page: "returned" as const,
  };
  mock.invoke.mockResolvedValue({
    version: 1,
    completed: [],
    pending: { a: "scope" },
    progress: { scope: { ...progress, registration } },
  });
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  expect(store.snapshot().progress.scope.registration).toEqual(registration);
  expect(store.completed("a")).toBe(false);
  expect(store.snapshot().progress.scope).not.toHaveProperty("authenticated");
  for (const invalid of [
    { ...registration, methodId: "other" },
    { ...registration, url: "http://insecure.example.com" },
    { ...registration, page: "logged-in" },
  ]) {
    vi.resetModules();
    mock.invoke.mockResolvedValue({
      version: 1,
      completed: [],
      pending: { a: "scope" },
      progress: { scope: { ...progress, registration: invalid } },
    });
    const { setupStorage: restored } = await import("./setup_storage");
    await restored.load();
    expect(restored.snapshot().progress.scope.registration).toBeUndefined();
    expect(restored.snapshot().progress.scope.selection).toEqual(
      progress.selection,
    );
  }
});

it("keeps one unfinished entry across use/manage, reloads choices without claiming login or request success", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  store.remember("a", "scope-one", progress);
  await store.flush();
  expect(store.scope("a", "scope-two")).toBe("scope-one");
  expect(store.completed("a")).toBe(false);
  const saved = structuredClone(
    mock.invoke.mock.calls
      .filter(([name]) => name === "settings_set")
      .at(-1)![1].value,
  );
  expect(saved).not.toHaveProperty("auth");
  expect(saved).not.toHaveProperty("test");
  vi.resetModules();
  mock.invoke.mockResolvedValue(saved);
  const { setupStorage: next } = await import("./setup_storage");
  await next.load();
  expect(next.snapshot().progress["scope-one"]).toEqual(progress);
  expect(next.scope("a", "scope-three")).toBe("scope-one");
  expect(next.completed("a")).toBe(false);
});

it("only publishes completion after saving and preserves it independently of later preparation", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  let finish!: () => void;
  mock.invoke.mockImplementation(async (name) => {
    if (name === "settings_set")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const saving = store.complete("a", progress.selection);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(store.completed("a")).toBe(false);
  expect(store.confirmedSelection("a")).toBeUndefined();
  finish();
  await saving;
  expect(store.completed("a")).toBe(true);
  expect(store.confirmedSelection("a")).toEqual(progress.selection);
  mock.invoke.mockResolvedValue(null);
  store.remember("a", "new-source", progress);
  await store.flush();
  expect(store.completed("a")).toBe(true);
  expect(store.scope("a", "other-source")).toBe("other-source");
});

it("preserves newer progress during slow writes and never overwrites unread or unknown data", async () => {
  mock.invoke.mockResolvedValue({ version: 2 });
  const { setupStorage: store } = await import("./setup_storage");
  await expect(store.load()).rejects.toThrow();
  expect(() => store.remember("a", "scope", progress)).toThrow();
  expect(
    mock.invoke.mock.calls.every(([name]) => name === "settings_get"),
  ).toBe(true);
  mock.invoke.mockResolvedValue(null);
  await store.load();
  let finish!: () => void;
  let count = 0;
  mock.invoke.mockImplementation(async () => {
    if (++count === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  store.remember("a", "scope", progress);
  await vi.waitFor(() => expect(finish).toBeDefined());
  store.remember("a", "scope", { ...progress, step: 2 });
  finish();
  await store.flush();
  expect(
    mock.invoke.mock.calls
      .filter(([name]) => name === "settings_set")
      .at(-1)![1].value.progress.scope.step,
  ).toBe(2);
});

it("failed completion remains unfinished and can be retried without discarding choices", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  store.remember("a", "scope", progress);
  await store.flush();
  mock.invoke.mockRejectedValue(new Error("disk full"));
  await expect(store.complete("a", progress.selection)).rejects.toThrow();
  expect(store.completed("a")).toBe(false);
  expect(store.confirmedSelection("a")).toBeUndefined();
  expect(store.snapshot().progress.scope).toEqual(progress);
  mock.invoke.mockResolvedValue(null);
  await store.complete("a", progress.selection);
  expect(store.completed("a")).toBe(true);
});

it("an old completion receipt cannot restore a removed Agent when the removal save fails", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  let release!: () => void;
  let writes = 0;
  mock.invoke.mockImplementation(async () => {
    if (++writes === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    else throw new Error("disk full");
  });
  const completing = store.complete("a", progress.selection);
  await vi.waitFor(() => expect(release).toBeDefined());
  const removing = store.forget("a");
  const results = Promise.allSettled([completing, removing]);
  await Promise.resolve();
  release();
  await results;
  expect(store.completed("a")).toBe(false);
  expect(store.snapshot().completed).not.toContain("a");
  expect(store.confirmedSelection("a")).toBeUndefined();
});

it("restores the confirmed source and all options independently of scoped edits", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  const selection = {
    service: { id: "api", model: "chosen", revision: "original-revision" },
    config: { model: "chosen", reasoning: "ultra", mode: "build" },
  };
  await store.complete("a", selection);
  store.remember("a", "other-scope", {
    ...progress,
    selection: { service: null, config: { model: "unfinished" } },
  });
  await store.flush();
  expect(store.scope("a", "fresh-scope")).toBe("fresh-scope");
  const copy = store.confirmedSelection("a")!;
  copy.config.model = "mutation";
  copy.service!.revision = "mutation";
  expect(store.confirmedSelection("a")).toEqual(selection);
  const saved = structuredClone(
    mock.invoke.mock.calls
      .filter(([name]) => name === "settings_set")
      .at(-1)![1].value,
  );
  vi.resetModules();
  mock.invoke.mockResolvedValue(saved);
  const { setupStorage: restored } = await import("./setup_storage");
  await restored.load();
  expect(restored.confirmedSelection("a")).toEqual(selection);
  expect(restored.scope("a", "fresh-scope")).toBe("fresh-scope");
});

it("preserves the last saved choice after a later confirmation fails and publishes only after retry", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.complete("a", progress.selection);
  const next = {
    service: null,
    config: { model: "second", reasoning: "high" },
  };
  mock.invoke.mockRejectedValue(new Error("disk full"));
  await expect(store.complete("a", next)).rejects.toThrow();
  expect(store.confirmedSelection("a")).toEqual(progress.selection);
  mock.invoke.mockResolvedValue(null);
  await store.complete("a", next);
  expect(store.confirmedSelection("a")).toEqual(next);
});

it("does not return an earlier confirmed choice after a later confirmation has been saved", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  const releases: (() => void)[] = [];
  mock.invoke.mockImplementation(
    async () => await new Promise<void>((resolve) => releases.push(resolve)),
  );
  const first = store.complete("a", progress.selection);
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const next = {
    service: null,
    config: { model: "later", reasoning: "ultra" },
  };
  const second = store.complete("a", next);
  await Promise.resolve();
  releases[0]();
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(store.confirmedSelection("a")).toEqual(progress.selection);
  releases[1]();
  expect(await first).toBeUndefined();
  expect(await second).toEqual(next);
  expect(store.confirmedSelection("a")).toEqual(next);
});

it("migrates only an exact completed legacy entry without rewriting storage during load", async () => {
  const scope = JSON.stringify(["a", "/work", progress.selection]);
  mock.invoke.mockResolvedValue({
    version: 1,
    completed: ["a"],
    pending: { a: scope },
    progress: { [scope]: { ...progress, step: 2 } },
  });
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  expect(store.confirmedSelection("a")).toEqual(progress.selection);
  expect(store.scope("a", "new-scope")).toBe("new-scope");
  expect(
    mock.invoke.mock.calls.every(([name]) => name === "settings_get"),
  ).toBe(true);
});

it("does not publish a pre-removal receipt while a re-added Agent's new confirmation is still saving", async () => {
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  const releases: (() => void)[] = [];
  mock.invoke.mockImplementation(
    async () => await new Promise<void>((resolve) => releases.push(resolve)),
  );
  const old = store.complete("a", progress.selection);
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const removed = store.forget("a");
  const selection = { service: null, config: { model: "re-added" } };
  const added = store.complete("a", selection);
  await Promise.resolve();
  releases[0]();
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(store.completed("a")).toBe(false);
  expect(store.confirmedSelection("a")).toBeUndefined();
  releases[1]();
  await removed;
  expect(await old).toBeUndefined();
  expect(await added).toEqual(selection);
  expect(store.confirmedSelection("a")).toEqual(selection);
});

it.each([
  "different-agent",
  "missing-scope-choice",
  "changed-progress",
  "unfinished-step",
  "inconsistent-source",
  "no-completion",
  "explicit-empty-confirmations",
])("requires confirmation for ambiguous legacy data: %s", async (reason) => {
  const selection =
    reason === "missing-scope-choice" ? null : progress.selection;
  const scope = JSON.stringify([
    reason === "different-agent" ? "other" : "a",
    "/work",
    selection,
  ]);
  const entry = {
    ...progress,
    step: reason === "unfinished-step" ? 1 : 2,
    choice: reason === "inconsistent-source" ? "api" : "existing",
    selection:
      reason === "changed-progress"
        ? { service: null, config: { model: "changed" } }
        : progress.selection,
  };
  mock.invoke.mockResolvedValue({
    version: 1,
    completed: reason === "no-completion" ? [] : ["a"],
    pending: { a: scope },
    progress: { [scope]: entry },
    ...(reason === "explicit-empty-confirmations" ? { selections: {} } : {}),
  });
  const { setupStorage: store } = await import("./setup_storage");
  await store.load();
  expect(store.confirmedSelection("a")).toBeUndefined();
});

it.each(["method", "account", "api"] as const)(
  "persists the %s access screen without publishing an unconfirmed choice",
  async (accessStage) => {
    const { setupStorage: store } = await import("./setup_storage");
    await store.load();
    const value = { ...progress, accessStage };
    store.remember("a", "scope", value);
    await store.flush();
    const saved = structuredClone(
      mock.invoke.mock.calls
        .filter(([name]) => name === "settings_set")
        .at(-1)![1].value,
    );
    vi.resetModules();
    mock.invoke.mockResolvedValue(saved);
    const { setupStorage: restored } = await import("./setup_storage");
    await restored.load();
    expect(restored.snapshot().progress.scope).toEqual(value);
    expect(restored.confirmedSelection("a")).toBeUndefined();
    expect(restored.completed("a")).toBe(false);
  },
);
