// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const native = new URL("../../src-tauri/native/", import.meta.url);
const program = readFileSync(new URL("browser_observation.js", native), "utf8");
const operation = readFileSync(
  new URL("browser_operation.js", native),
  "utf8",
).replace("/* FARFOLD_OBSERVATION_PROGRAM */", program);
const monitor = readFileSync(
  new URL("browser_manual_activity.js", native),
  "utf8",
);
function page() {
  const listeners = new Map<
    string,
    ((event: { isTrusted: boolean }) => void)[]
  >();
  const signals: string[] = [];
  const document = {
    querySelectorAll: () => [],
    querySelector: () => null,
    body: null,
    title: "Controlled page",
  };
  const context = vm.createContext({
    document,
    location: { href: "https://example.test/" },
    addEventListener: (
      type: string,
      listener: (event: { isTrusted: boolean }) => void,
    ) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    MutationObserver: class {
      observe() {}
      takeRecords() {
        return [];
      }
    },
    __farfoldManualActivity: (value: string) => signals.push(value),
  });
  const install = vm.runInContext(monitor, context) as () => number;
  const run = vm.runInContext(operation, context) as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  const observe = (revision: number, id = "observation-1") =>
    run(
      "observe",
      "epoch",
      id,
      "1",
      "",
      "",
      "",
      "",
      Date.now() + 5000,
      revision,
    );
  const act = (revision: number) =>
    run(
      "act",
      "epoch",
      "action-1",
      "1",
      "observation-1",
      "n1",
      "click",
      "",
      Date.now() + 5000,
      revision,
    );
  const event = (trusted: boolean) => {
    const event = {
      isTrusted: trusted,
      get key(): never {
        throw new Error("must not read keys");
      },
      get value(): never {
        throw new Error("must not read values");
      },
    };
    for (const listener of listeners.get("keydown") ?? []) listener(event);
  };
  return { install, observe, act, event, signals, document };
}
describe("fixed native browser operation programs", () => {
  it("blocks an old grant synchronously before a delayed native activity acknowledgement", async () => {
    const fixture = page();
    expect(fixture.install()).toBe(0);
    expect(await fixture.observe(0)).toMatchObject({
      blocked: false,
      observationId: "observation-1",
      text: "",
      nodes: [],
    });
    fixture.event(true);
    expect(fixture.signals).toEqual(["1"]);
    Object.defineProperty(fixture.document, "body", {
      get() {
        throw new Error("body must not be read under the old grant");
      },
    });
    await expect(fixture.observe(0)).rejects.toThrow("page changed");
    await expect(fixture.act(0)).rejects.toThrow("page changed");
  });
  it("allows a newly approved revision without treating programmatic events as user activity", async () => {
    const fixture = page();
    fixture.install();
    fixture.event(false);
    expect(fixture.signals).toEqual([]);
    fixture.event(true);
    expect(fixture.install()).toBe(1);
    expect(await fixture.observe(1, "after-review")).toMatchObject({
      blocked: false,
      observationId: "after-review",
    });
    fixture.event(true);
    expect(fixture.signals).toEqual(["1", "2"]);
    await expect(fixture.observe(1)).rejects.toThrow("page changed");
  });
});
