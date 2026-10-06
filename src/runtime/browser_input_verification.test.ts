// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const native = new URL("../../src-tauri/native/", import.meta.url);
const operation = readFileSync(
  new URL("browser_operation.js", native),
  "utf8",
).replace(
  "/* FARFOLD_OBSERVATION_PROGRAM */",
  readFileSync(new URL("browser_observation.js", native), "utf8"),
);
const monitor = readFileSync(
  new URL("browser_manual_activity.js", native),
  "utf8",
);

// Run the production script against an owned input fixture. The fixture models
// native value access and website event handlers, not the verification decision.
function inputPage(tag = "INPUT") {
  let stored = "OLD_VALUE_NOT_TO_EXPORT";
  let reads = 0,
    writes = 0,
    forbidRead = false;
  let handler: (() => void) | undefined;
  let pendingMutation = false;
  let mutation: (() => void) | undefined;
  const listeners = new Map<
    string,
    ((event: { isTrusted: boolean }) => void)[]
  >();
  class Field {
    tagName = tag;
    attrs = new Map([
      ["type", "text"],
      ["aria-label", "Message"],
    ]);
    isConnected = true;
    disabled = false;
    readOnly = false;
    parentElement = null;
    labels = [];
    id = "message";
    get type() {
      return this.attrs.get("type");
    }
    get outerHTML() {
      return `<${this.tagName.toLowerCase()} ${[...this.attrs].map(([key, value]) => `${key}="${value}"`).join(" ")}>`;
    }
    get value() {
      reads++;
      if (forbidRead) throw new Error("protected field value must not be read");
      return stored;
    }
    set value(text: string) {
      writes++;
      stored = text;
    }
    getAttribute(name: string) {
      return this.attrs.get(name) ?? null;
    }
    closest() {
      return null;
    }
    matches(selector: string) {
      return selector.startsWith("input,textarea");
    }
    getBoundingClientRect() {
      return {
        x: 16,
        y: 16,
        left: 16,
        top: 16,
        right: 116,
        bottom: 56,
        width: 100,
        height: 40,
      };
    }
    contains() {
      return false;
    }
    dispatchEvent(event: { type: string; isTrusted: boolean }) {
      if (event.type === "input") handler?.();
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    }
  }
  const field = new Field(),
    fields = [field];
  const location = { href: "https://example.test/" };
  const context = vm.createContext({
    location,
    innerWidth: 640,
    innerHeight: 480,
    HTMLInputElement: Field,
    HTMLTextAreaElement: Field,
    Event: class {
      isTrusted = false;
      constructor(public type: string) {}
    },
    document: {
      querySelectorAll: () => fields.filter((item) => item.isConnected),
      querySelector: () => field,
      elementFromPoint: () => fields.find((item) => item.isConnected),
      body: null,
      title: "Controlled input",
    },
    getComputedStyle: () => ({
      visibility: "visible",
      opacity: "1",
      display: "block",
    }),
    addEventListener: (
      type: string,
      listener: (event: { isTrusted: boolean }) => void,
    ) => {
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
      Date.now() + 5000,
      0,
    );
  const act = (text = "APPROVED_TEXT_NOT_TO_EXPORT") =>
    run(
      "act",
      "epoch",
      "action",
      "1",
      "observation-1",
      "n1",
      "input",
      text,
      Date.now() + 5000,
      0,
    );
  return {
    observe,
    act,
    field,
    location,
    reads: () => reads,
    writes: () => writes,
    onInput: (next: () => void) => {
      handler = next;
    },
    forbidRead: () => {
      forbidRead = true;
    },
    rewrite: (text: string) => {
      stored = text;
    },
    replace: () => {
      field.isConnected = false;
      fields.push(new Field());
    },
    addProtected: () => {
      const added = new Field();
      added.attrs.set("type", "password");
      fields.push(added);
    },
    transientProtection: (delivery: string) => {
      field.attrs.set("type", "password");
      field.attrs.set("type", "text");
      if (delivery === "queued") pendingMutation = true;
      else mutation?.();
    },
    manualActivity: () => {
      for (const listener of listeners.get("keydown") ?? [])
        listener({ isTrusted: true });
    },
  };
}

describe("one-time native input verification", () => {
  it.each(["INPUT", "TEXTAREA"])(
    "verifies the approved %s write without exporting or storing a value",
    async (tag) => {
      const page = inputPage(tag);
      expect(await page.observe()).toMatchObject({
        nodes: [{ ref: "n1", actions: ["input"] }],
      });
      expect(page.reads()).toBe(0);
      const reply = await page.act();
      expect(reply).toMatchObject({
        outcome: "dispatched",
        applied: true,
        verification: "matched",
      });
      expect(page.writes()).toBe(1);
      expect(page.reads()).toBe(1);
      expect(JSON.stringify(reply)).not.toMatch(
        /APPROVED_TEXT_NOT_TO_EXPORT|OLD_VALUE_NOT_TO_EXPORT|actualValue/,
      );
      expect(await page.act()).toMatchObject({
        outcome: "rejected",
        applied: false,
        verification: "unverified",
      });
      expect(page.writes()).toBe(1);
      page.forbidRead();
      const nextObservation = await page.observe();
      expect(nextObservation).toMatchObject({
        blocked: false,
        nodes: [{ actions: ["input"] }],
      });
      expect(page.reads()).toBe(1);
      expect(JSON.stringify(nextObservation)).not.toContain(
        "APPROVED_TEXT_NOT_TO_EXPORT",
      );
    },
  );
  it("reports a website handler changing the ordinary field without returning either value", async () => {
    const page = inputPage();
    await page.observe();
    page.onInput(() => {
      void Promise.resolve().then(() =>
        page.rewrite("WEBSITE_REWRITE_NOT_TO_EXPORT"),
      );
    });
    const reply = await page.act();
    expect(reply).toMatchObject({
      outcome: "dispatched",
      applied: true,
      verification: "mismatched",
    });
    expect(page.reads()).toBe(1);
    expect(JSON.stringify(reply)).not.toMatch(
      /APPROVED_TEXT|WEBSITE_REWRITE|actualValue/,
    );
  });
  it("uses the captured native accessor without calling a website's own value getter", async () => {
    const page = inputPage();
    Object.defineProperty(page.field, "value", {
      get() {
        throw new Error("website value getter must not run");
      },
    });
    await page.observe();
    expect(await page.act()).toMatchObject({
      outcome: "dispatched",
      applied: true,
      verification: "matched",
    });
    expect(page.reads()).toBe(1);
    expect(page.writes()).toBe(1);
  });
  it.each([
    "password",
    "otp",
    "replaced",
    "navigation",
    "manual",
    "new-protected-field",
  ])(
    "does not read the field when an input handler causes %s",
    async (change) => {
      const page = inputPage();
      await page.observe();
      page.onInput(() => {
        page.forbidRead();
        if (change === "password") page.field.attrs.set("type", "password");
        if (change === "otp")
          page.field.attrs.set("autocomplete", "one-time-code");
        if (change === "replaced") page.replace();
        if (change === "navigation")
          page.location.href = "https://example.test/changed";
        if (change === "manual") page.manualActivity();
        if (change === "new-protected-field") page.addProtected();
      });
      expect(await page.act()).toMatchObject({
        outcome: "dispatched",
        applied: true,
        verification: "unverified",
      });
      expect(page.reads()).toBe(0);
      expect(page.writes()).toBe(1);
    },
  );
  it("keeps a native value-access error unverified without changing dispatch or leaking it", async () => {
    const page = inputPage();
    await page.observe();
    page.onInput(page.forbidRead);
    const reply = await page.act();
    expect(reply).toMatchObject({
      outcome: "dispatched",
      applied: true,
      verification: "unverified",
    });
    expect(page.reads()).toBe(1);
    expect(JSON.stringify(reply)).not.toContain("protected field");
  });
  it.each(["queued", "delivered"])(
    "does not read a temporarily protected field after its %s mutations are restored",
    async (delivery) => {
      const page = inputPage();
      await page.observe();
      page.onInput(() => page.transientProtection(delivery));
      expect(await page.act()).toMatchObject({
        outcome: "dispatched",
        applied: true,
        verification: "unverified",
      });
      expect(page.reads()).toBe(0);
      expect(page.writes()).toBe(1);
    },
  );
  it("rejects a target changed to sensitive input before dispatch without reading or writing it", async () => {
    const page = inputPage();
    await page.observe();
    page.field.attrs.set("type", "password");
    page.forbidRead();
    expect(await page.act()).toMatchObject({
      outcome: "rejected",
      applied: false,
      verification: "unverified",
    });
    expect(page.reads()).toBe(0);
    expect(page.writes()).toBe(0);
  });
});
