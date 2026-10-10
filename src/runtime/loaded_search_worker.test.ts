import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLoadedSearchParser } from "./loaded_search_worker";

class ControlledWorker {
  static all: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    ControlledWorker.all.push(this);
  }
  reply(value: unknown) {
    this.onmessage?.({ data: value } as MessageEvent);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  ControlledWorker.all = [];
  vi.stubGlobal("Worker", ControlledWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("creates one lazy query worker, reuses it serially, and releases it at query end", async () => {
  const parser = createLoadedSearchParser();
  expect(ControlledWorker.all).toHaveLength(0);
  const first = parser.parse("**first**");
  const worker = ControlledWorker.all[0];
  worker.reply({ id: 1, fields: ["first"] });
  expect(await first).toEqual(["first"]);
  const second = parser.parse("second");
  worker.reply({ id: 1, fields: ["old"] });
  worker.reply({ id: 2, fields: ["second"] });
  expect(await second).toEqual(["second"]);
  expect(ControlledWorker.all).toHaveLength(1);
  parser.dispose();
  parser.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("terminates ongoing parsing on query cancellation and cannot accept its late callback", async () => {
  const abort = new AbortController(),
    parser = createLoadedSearchParser(abort.signal);
  const result = parser.parse("long Markdown");
  const worker = ControlledWorker.all[0],
    late = worker.onmessage!;
  abort.abort();
  late({ data: { id: 1, fields: ["late"] } } as MessageEvent);
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(parser.parse("again")).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(vi.getTimerCount()).toBe(0);
});
it("an unrelated new query owns its own worker and cannot be cancelled by the old owner", async () => {
  const old = createLoadedSearchParser(),
    next = createLoadedSearchParser();
  const first = old.parse("old"),
    firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const second = next.parse("new");
  old.dispose();
  ControlledWorker.all[1].reply({ id: 1, fields: ["new"] });
  await firstRejected;
  expect(await second).toEqual(["new"]);
  expect(ControlledWorker.all[1].terminate).not.toHaveBeenCalled();
  next.dispose();
});
it.each([
  { id: 1, failed: true },
  { id: 1, fields: [42] },
  { id: 1, fields: ["x".repeat(2048)] },
  { id: 1, fields: [], extra: true },
])(
  "rejects a malformed or resource-exceeding reply and terminates: %j",
  async (reply) => {
    const parser = createLoadedSearchParser(),
      result = parser.parse("short");
    ControlledWorker.all[0].reply(reply);
    await expect(result).rejects.toThrow("Search parser failed");
    expect(ControlledWorker.all[0].terminate).toHaveBeenCalledOnce();
  },
);
it("bounds an unresponsive worker and releases its timer and process", async () => {
  const parser = createLoadedSearchParser(),
    result = parser.parse("stuck");
  const rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(ControlledWorker.all[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["onerror", "onmessageerror"] as const)(
  "ends a failed worker on %s without exposing its input",
  async (event) => {
    const parser = createLoadedSearchParser(),
      result = parser.parse("private controlled input");
    ControlledWorker.all[0][event]!();
    await expect(result).rejects.toThrow(/^Search parser failed$/);
    expect(ControlledWorker.all[0].terminate).toHaveBeenCalledOnce();
  },
);
it("does not instantiate a worker for a query that is already cancelled", async () => {
  const abort = new AbortController();
  abort.abort();
  const parser = createLoadedSearchParser(abort.signal);
  await expect(parser.parse("text")).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(ControlledWorker.all).toHaveLength(0);
});
