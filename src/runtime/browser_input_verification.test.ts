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
// WebKit injects only these named dictionary arguments into the script body.
// Derive their names from the production call, without supplying Windows-only
// bindings that would hide a missing macOS argument.
const macSource = readFileSync(new URL("BrowserWorkspace.m", native), "utf8");
const macArgumentsSource = macSource.match(
  /NSMutableDictionary \*arguments = \[([\s\S]*?)__weak FFPublicBrowser \*weakBrowser/,
)?.[1];
if (!macArgumentsSource) throw new Error("missing macOS observation arguments");
const macArgumentNames = [...macArgumentsSource.matchAll(/@"(\w+)":/g)].map(
  ([, name]) => name!,
);
const macOperation = `(async function (${macArgumentNames.join(",")}) {\n${program}\n})`;

// Run the production script against an owned input fixture. The fixture models
// native value access and website event handlers, not the verification decision.
function inputPage(tag = "INPUT", platform: "windows" | "macos" = "windows") {
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
  if (platform === "windows")
    (vm.runInContext(monitor, context) as () => void)();
  const run = vm.runInContext(
    platform === "macos" ? macOperation : operation,
    context,
  ) as (...args: unknown[]) => Promise<Record<string, unknown>>;
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
      ...(platform === "windows" ? [0] : []),
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
      ...(platform === "windows" ? [0] : []),
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
    listenerCount: (type: string) => listeners.get(type)?.length ?? 0,
    manualActivity: (type = "keydown", trusted = true) => {
      const event = {
        isTrusted: trusted,
        get key(): never {
          throw new Error("must not inspect keys");
        },
        get target(): never {
          throw new Error("must not inspect event targets");
        },
        get value(): never {
          throw new Error("must not inspect values");
        },
      };
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

describe("one-time native input verification", () => {
  it("uses the actual macOS named arguments to verify a static field without Windows-only bindings", async () => {
    expect(macArgumentNames).toEqual([
      "mode",
      "epochSeed",
      "observationSeed",
      "navigation",
      "observationId",
      "nodeRef",
      "kind",
      "inputText",
      "deadline",
    ]);
    const page = inputPage("INPUT", "macos");
    await page.observe();
    await page.observe();
    expect(await page.act()).toMatchObject({
      applied: true,
      outcome: "dispatched",
      verification: "matched",
    });
    expect(page.reads()).toBe(1);
    expect(page.writes()).toBe(1);
    expect(page.listenerCount("pointerdown")).toBe(1);
    expect(page.listenerCount("keydown")).toBe(1);
  });
  it.each(["pointerdown", "keydown"])(
    "never reads a field after trusted macOS %s during the approved input",
    async (type) => {
      const page = inputPage("INPUT", "macos");
      await page.observe();
      page.onInput(() => {
        page.forbidRead();
        page.manualActivity(type);
      });
      expect(await page.act()).toMatchObject({
        applied: true,
        outcome: "dispatched",
        verification: "unverified",
      });
      expect(page.reads()).toBe(0);
      expect(page.writes()).toBe(1);
    },
  );
  it("rejects a macOS observation withdrawn by trusted activity before dispatch", async () => {
    const page = inputPage("INPUT", "macos");
    await page.observe();
    page.manualActivity();
    page.forbidRead();
    expect(await page.act()).toMatchObject({
      applied: false,
      outcome: "rejected",
      verification: "unverified",
    });
    expect(page.reads()).toBe(0);
    expect(page.writes()).toBe(0);
  });
  it("keeps untrusted macOS programmatic activity from withdrawing the approved input", async () => {
    const page = inputPage("INPUT", "macos");
    await page.observe();
    page.onInput(() => page.manualActivity("pointerdown", false));
    expect(await page.act()).toMatchObject({
      applied: true,
      outcome: "dispatched",
      verification: "matched",
    });
    expect(page.reads()).toBe(1);
    expect(page.writes()).toBe(1);
  });
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

describe("shared authority retirement receipts", () => {
  it.each(["macos", "windows"] as const)(
    "marks protected input before dispatch for retirement on %s",
    async (platform) => {
      const page = inputPage("INPUT", platform);
      await page.observe();
      page.field.attrs.set("type", "password");
      page.forbidRead();
      expect(await page.act()).toMatchObject({
        outcome: "rejected",
        applied: false,
        verification: "unverified",
        sharingInvalidated: true,
      });
      expect(page.reads()).toBe(0);
      expect(page.writes()).toBe(0);
    },
  );

  it.each(["password", "otp", "new-protected-field"])(
    "marks protection introduced by an input handler without changing dispatch: %s",
    async (change) => {
      const page = inputPage();
      await page.observe();
      page.onInput(() => {
        page.forbidRead();
        if (change === "password") page.field.attrs.set("type", "password");
        if (change === "otp")
          page.field.attrs.set("autocomplete", "one-time-code");
        if (change === "new-protected-field") page.addProtected();
      });
      expect(await page.act()).toMatchObject({
        outcome: "dispatched",
        applied: true,
        verification: "unverified",
        sharingInvalidated: true,
      });
      expect(page.reads()).toBe(0);
      expect(page.writes()).toBe(1);
    },
  );

  it.each(["queued", "delivered"])(
    "retires sharing after transient protected mutations are restored: %s",
    async (delivery) => {
      const page = inputPage();
      await page.observe();
      page.onInput(() => page.transientProtection(delivery));
      expect(await page.act()).toMatchObject({
        outcome: "dispatched",
        applied: true,
        verification: "unverified",
        sharingInvalidated: true,
      });
      expect(page.field.type).toBe("text");
      expect(page.reads()).toBe(0);
      expect(page.writes()).toBe(1);
    },
  );

  it.each(["matched", "mismatched"])(
    "keeps safely compared ordinary input usable when %s",
    async (verification) => {
      const page = inputPage();
      await page.observe();
      if (verification === "mismatched")
        page.onInput(() => page.rewrite("DIFFERENT_OWNED_TEXT"));
      const result = await page.act();
      expect(result).toMatchObject({
        outcome: "dispatched",
        applied: true,
        verification,
      });
      expect(result).not.toHaveProperty("sharingInvalidated");
      expect(page.reads()).toBe(1);
      expect(page.writes()).toBe(1);
    },
  );

  it("does not retire sharing for an unrelated ordinary pre-dispatch rejection", async () => {
    const page = inputPage();
    await page.observe();
    page.field.attrs.set("aria-label", "Changed ordinary label");
    const result = await page.act();
    expect(result).toMatchObject({ outcome: "rejected", applied: false });
    expect(result).not.toHaveProperty("sharingInvalidated");
    expect(page.reads()).toBe(0);
    expect(page.writes()).toBe(0);
  });
});
