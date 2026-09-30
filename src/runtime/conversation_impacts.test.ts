import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { IndexRow } from "./sessions";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  deps: [] as unknown[][],
  cleanup: [] as (() => void)[],
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (value: unknown) => {
        h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
      },
    ];
  },
  useEffect: (fn: () => () => void, deps: unknown[]) => {
    const i = h.cursor++;
    if (!h.deps[i] || deps.some((v, n) => v !== h.deps[i][n])) {
      h.cleanup[i]?.();
      h.deps[i] = deps;
      h.cleanup[i] = fn();
    }
  },
}));
import {
  credentialImpact,
  useStoredConversationIndex,
} from "./conversation_impacts";
const row = (id: string, source?: unknown): IndexRow =>
  ({
    id,
    agentId: "agent",
    cwd: "/work",
    nativeSessionId: id,
    title: id,
    pinned: false,
    archived: id === "archived",
    createdAt: 0,
    updatedAt: 0,
    configOptions:
      source === undefined ? undefined : { _farfoldService: source },
  }) as IndexRow;
const view = (owner: string | null) => {
  h.cursor = 0;
  return useStoredConversationIndex(owner);
};
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.deps = [];
  h.cleanup = [];
  h.invoke.mockReset();
});
afterEach(() => {
  h.cleanup.forEach((fn) => fn?.());
});
it("includes archived old revisions of the same service and reports unknown old records without guessing", () => {
  const affected = row("archived", {
    kind: "configured",
    identity: { id: "service", revision: "older" },
  });
  const rows = [
    affected,
    row("other", { kind: "configured", identity: { id: "other" } }),
    row("local", { kind: "existing" }),
    row("missing"),
    row("malformed", { kind: "configured" }),
  ];
  expect(credentialImpact(rows, "service")).toEqual({
    affected: [affected],
    unknown: 2,
  });
});
it("rejects a late index response after switching the deletion target and preserves a retryable read failure", async () => {
  let old!: (value: IndexRow[]) => void;
  h.invoke
    .mockReturnValueOnce(
      new Promise<IndexRow[]>((done) => {
        old = done;
      }),
    )
    .mockRejectedValueOnce(Error("read failed"));
  view("first");
  view("second");
  await settle();
  old([row("old-target")]);
  await settle();
  const failed = view("second");
  expect(failed.rows).toBeNull();
  expect(failed.error).toBe(true);
  h.invoke.mockResolvedValue([row("fresh")]);
  failed.retry();
  view("second");
  await settle();
  expect(view("second")).toMatchObject({ rows: [row("fresh")], error: false });
  expect(view(null).rows).toBeNull();
});
