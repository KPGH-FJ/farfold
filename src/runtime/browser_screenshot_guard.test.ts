// @vitest-environment node
// Production program on a controlled DOM peer. This does not prove macOS27
// public-world behavior, actual system screenshots or installed-app delivery.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const program = readFileSync(
  new URL("../../src-tauri/native/browser_observation.js", import.meta.url),
  "utf8",
);
function fixture(capable: boolean) {
  let hostRoot: object | null = null;
  let mutation = false;
  const root = { querySelectorAll: () => [] };
  const host = {
    get shadowRoot() {
      return hostRoot;
    },
  };
  const context = vm.createContext({
    mode: "observe",
    epochSeed: "epoch",
    observationSeed: "observation",
    navigation: "1",
    inspectClosedRoots: true,
    location: { href: "https://public.example.org/" },
    innerWidth: 640,
    innerHeight: 480,
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 0,
    addEventListener() {},
    MutationObserver: class {
      observe() {}
      takeRecords() {
        const records = mutation ? [{}] : [];
        mutation = false;
        return records;
      }
    },
    document: {
      body: null,
      title: "Owned public fixture",
      querySelectorAll: (selector: string) => (selector === "*" ? [host] : []),
      querySelector: () => null,
      createElement: () => {
        let closed: object;
        return {
          attachShadow: () => {
            closed = {};
            return closed;
          },
          get shadowRoot() {
            return capable ? closed! : null;
          },
        };
      },
    },
  });
  const run = () =>
    vm.runInContext(`(async function(){${program}\n})()`, context) as Promise<
      Record<string, unknown>
    >;
  return {
    run,
    context,
    attach() {
      hostRoot = root;
    },
    remove() {
      hostRoot = null;
      mutation = true;
    },
  };
}
describe("production screenshot guard revisions", () => {
  it("refuses document-wide editing before reading or returning its text", async () => {
    const page = fixture(true);
    page.context.document.designMode = "on";
    page.context.document.title = "PROTECTED_OWNED_DOCUMENT_TEXT";
    const result = await page.run();
    expect(result.blocked).toBe(true);
    expect(result).not.toHaveProperty("title");
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("nodes");
    expect(JSON.stringify(result)).not.toContain(
      "PROTECTED_OWNED_DOCUMENT_TEXT",
    );
  });
  it("rejects a document becoming editable during the post-capture check", async () => {
    const page = fixture(true);
    expect((await page.run()).blocked).toBe(false);
    page.context.document.designMode = "on";
    page.context.mode = "check";
    const result = await page.run();
    expect(result.blocked).toBe(true);
    expect(result.screenshotReason).toBe(
      "页面含可编辑内容或嵌入页面，暂不能安全截图",
    );
    expect(result).not.toHaveProperty("text");
  });
  it("requires actual detached closed-root access rather than a claimed selector capability", async () => {
    expect(await fixture(false).run()).toMatchObject({
      blocked: false,
      closedRootInspection: false,
    });
    expect(await fixture(true).run()).toMatchObject({
      blocked: false,
      closedRootInspection: true,
      screenshotReason: null,
      viewport: { width: 640, height: 480, scale: 2, x: 0, y: 0 },
    });
  });
  it("refuses even an empty newly attached root during the post-capture check", async () => {
    const page = fixture(true);
    const before = await page.run();
    page.attach();
    page.context.mode = "check";
    const after = await page.run();
    expect(after.screenshotReason).toBe(
      "页面含可编辑内容或嵌入页面，暂不能安全截图",
    );
    expect(after.documentVersion).not.toBe(before.documentVersion);
  });
  it("keeps host removal as a sticky invalidation even if no closed tree remains", async () => {
    const page = fixture(true);
    const before = await page.run();
    page.attach();
    page.remove();
    page.context.mode = "check";
    const after = await page.run();
    expect(after.screenshotReason).toBeNull();
    expect(after.documentVersion).not.toBe(before.documentVersion);
  });
});
