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

// Execute the actual fixed program with one owned button and a controlled
// clock. This covers script decisions; the separate real WebKit receipts cover
// native execution and do not turn these DOM fixtures into installed evidence.
function buttonPage() {
  let now = 100_000;
  let clicks = 0;
  let pendingMutation = false;
  let mutation: (() => void) | undefined;
  const listeners = new Map<string, (() => void)[]>();
  const button = {
    tagName: "BUTTON",
    isConnected: true,
    disabled: false,
    readOnly: false,
    parentElement: null,
    outerHTML: '<button aria-label="Increase">Increase</button>',
    closest: () => null,
    getAttribute: (name: string) => (name === "aria-label" ? "Increase" : null),
    matches: (selector: string) => selector.startsWith("button"),
    getBoundingClientRect: () => ({
      x: 16,
      y: 16,
      left: 16,
      top: 16,
      right: 116,
      bottom: 56,
      width: 100,
      height: 40,
    }),
    contains: () => false,
    click: () => {
      clicks++;
      pendingMutation = true;
    },
  };
  const location = { href: "https://example.test/" };
  const context = vm.createContext({
    location,
    innerWidth: 640,
    innerHeight: 480,
    document: {
      querySelectorAll: (selector: string) =>
        selector === "*" || selector.startsWith("button") ? [button] : [],
      querySelector: () => null,
      elementFromPoint: () => button,
      body: null,
      title: "Controlled button",
    },
    getComputedStyle: () => ({
      visibility: "visible",
      opacity: "1",
      display: "block",
    }),
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      takeRecords() {
        const records = pendingMutation ? [{}] : [];
        pendingMutation = false;
        return records;
      }
    },
    __farfoldManualActivity: () => {},
  });
  (vm.runInContext(monitor, context) as () => void)();
  const run = vm.runInContext(operation, context) as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  const observe = () =>
    run(
      "observe",
      "epoch",
      "observation-1",
      "1",
      "",
      "",
      "",
      "",
      now + 5000,
      0,
    );
  const act = (
    overrides: { id?: string; navigation?: string; deadline?: number } = {},
  ) =>
    run(
      "act",
      "epoch",
      "action",
      overrides.navigation ?? "1",
      overrides.id ?? "observation-1",
      "n1",
      "click",
      "",
      overrides.deadline ?? now + 5000,
      0,
    );
  return {
    observe,
    act,
    advance: (ms: number) => {
      now += ms;
    },
    clicks: () => clicks,
    now: () => now,
    location,
    button,
    context,
    queueMutation: () => {
      pendingMutation = true;
    },
    deliverMutation: () => mutation?.(),
    event: (type: string) => {
      const forbidden = new Proxy(
        {},
        {
          get: () => {
            throw new Error("event content must not be read");
          },
        },
      );
      for (const listener of listeners.get(type) ?? [])
        (listener as (event: unknown) => void)(forbidden);
    },
  };
}

describe("native action rejection diagnostics", () => {
  it("executes the static button and preserves one-use dispatch semantics", async () => {
    const fixture = buttonPage();
    expect(await fixture.observe()).toMatchObject({
      nodes: [{ ref: "n1", actions: ["click"] }],
    });
    fixture.advance(300);
    const success = await fixture.act();
    expect(success).toMatchObject({
      applied: true,
      outcome: "dispatched",
      observationAgeMs: 300,
    });
    expect(success).not.toHaveProperty("guardClass");
    expect(success).not.toHaveProperty("observationInvalidatedBy");
    expect(fixture.clicks()).toBe(1);
    expect(await fixture.act()).toMatchObject({
      applied: false,
      outcome: "rejected",
      guardClass: "observation_missing",
    });
    expect(fixture.clicks()).toBe(1);
  });
  it.each([
    "deadline",
    "expired",
    "observation_id",
    "navigation",
    "url",
    "version",
  ])(
    "classifies %s without dispatching or changing the rejection meaning",
    async (classification) => {
      const fixture = buttonPage();
      await fixture.observe();
      fixture.advance(classification === "expired" ? 31_000 : 300);
      const overrides: Parameters<typeof fixture.act>[0] = {};
      if (classification === "deadline") overrides.deadline = fixture.now() - 1;
      if (classification === "observation_id") overrides.id = "other";
      if (classification === "navigation") overrides.navigation = "other";
      if (classification === "url")
        fixture.location.href = "https://example.test/changed";
      if (classification === "version")
        vm.runInContext(
          "globalThis.__farfold_observation_v1.version++",
          fixture.context,
        );
      expect(await fixture.act(overrides)).toMatchObject({
        applied: false,
        outcome: "rejected",
        reason: "页面或操作目标已变化，请重新观察",
        guardClass: classification,
        observationAgeMs: classification === "expired" ? 31_000 : 300,
      });
      expect(fixture.clicks()).toBe(0);
    },
  );
  it.each(["input", "change", "scroll", "resize"])(
    "records only fixed %s invalidation without reading event contents",
    async (type) => {
      const fixture = buttonPage();
      await fixture.observe();
      fixture.advance(300);
      fixture.event(type);
      fixture.deliverMutation();
      expect(await fixture.act()).toMatchObject({
        applied: false,
        outcome: "rejected",
        guardClass: "observation_missing",
        observationInvalidatedBy: type,
        observationAgeMs: 300,
      });
      expect(fixture.clicks()).toBe(0);
    },
  );
  it.each(["queued", "delivered"])(
    "reports %s mutation and lets a new explicit observation clear old diagnostics",
    async (kind) => {
      const fixture = buttonPage();
      await fixture.observe();
      fixture.advance(300);
      if (kind === "queued") fixture.queueMutation();
      else fixture.deliverMutation();
      expect(await fixture.act()).toMatchObject({
        applied: false,
        guardClass: "observation_missing",
        observationInvalidatedBy: "mutation",
        observationAgeMs: 300,
      });
      expect(fixture.clicks()).toBe(0);
      await fixture.observe();
      const fresh = await fixture.act();
      expect(fresh).toMatchObject({
        applied: true,
        outcome: "dispatched",
        observationAgeMs: 0,
      });
      expect(fresh).not.toHaveProperty("observationInvalidatedBy");
    },
  );
  it("omits unknown or out-of-range ages and keeps target HTML protection", async () => {
    const missing = buttonPage();
    expect(await missing.act()).not.toHaveProperty("observationAgeMs");
    const old = buttonPage();
    await old.observe();
    old.advance(300_001);
    const expired = await old.act();
    expect(expired).toMatchObject({ applied: false, guardClass: "expired" });
    expect(expired).not.toHaveProperty("observationAgeMs");
    const changed = buttonPage();
    await changed.observe();
    changed.button.outerHTML = "<button>Changed</button>";
    expect(await changed.act()).toMatchObject({
      applied: false,
      outcome: "rejected",
      reason: "操作目标已变化，请重新观察",
    });
    expect(changed.clicks()).toBe(0);
  });
});
