import { describe, expect, it } from "vitest";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";
import {
  parseWindowsTestResult,
  requiredAffectedCommands,
  requiredWindowsAffectedCommands,
  windowsAffectedTests,
} from "./delivery-check.mjs";

describe("delivery scope", () => {
  it("requires frontend engineering and installed evidence for the public wordmark", () => {
    expect(classifyDeliveryPaths(["public/brand/wordmark.svg"])).toEqual({
      frontend: true,
      native: false,
      product: true,
      governance: false,
      macNative: false,
      windowsNative: false,
      macProduct: true,
      windowsProduct: false,
    });
  });

  it("treats test and workflow changes as governance and still checks frontend tests", () => {
    expect(
      classifyDeliveryPaths([
        "src/components/Composer.send-ownership.test.tsx",
        ".github/workflows/delivery.yml",
      ]),
    ).toEqual({
      frontend: true,
      native: false,
      product: false,
      governance: true,
      macNative: false,
      windowsNative: false,
      macProduct: false,
      windowsProduct: false,
    });
  });

  it("requires installed evidence for native source even in a mixed change", () => {
    expect(
      classifyDeliveryPaths([
        "docs/development-delivery.md",
        "src-tauri/src/lib.rs",
      ]),
    ).toMatchObject({ native: true, product: true, governance: true });
  });

  it("recognizes docs-only changes with no engineered product inputs", () => {
    expect(classifyDeliveryPaths(["docs/evidence/notes.md"])).toEqual({
      frontend: false,
      native: false,
      product: false,
      governance: false,
      macNative: false,
      windowsNative: false,
      macProduct: false,
      windowsProduct: false,
    });
  });

  it("keeps the cfg(test) worktree module out of installed acceptance on both platforms", () => {
    expect(classifyDeliveryPaths(["src-tauri/src/worktrees/tests.rs"])).toEqual(
      {
        frontend: false,
        native: true,
        product: false,
        governance: true,
        macNative: true,
        windowsNative: true,
        macProduct: false,
        windowsProduct: false,
      },
    );
  });

  it("requires only Windows-appropriate evidence for Windows worktree production or test paths", () => {
    expect(
      classifyDeliveryPaths(["src-tauri/src/worktrees/create_windows.rs"]),
    ).toEqual({
      frontend: false,
      native: true,
      product: true,
      governance: false,
      macNative: false,
      windowsNative: true,
      macProduct: false,
      windowsProduct: true,
    });
    expect(
      classifyDeliveryPaths([
        "src-tauri/src/worktrees/create_windows_tests.rs",
      ]),
    ).toMatchObject({
      native: true,
      product: false,
      governance: true,
      macNative: false,
      windowsNative: true,
      macProduct: false,
      windowsProduct: false,
    });
  });

  it("retains both platform obligations when a Windows change includes common product assets", () => {
    expect(
      classifyDeliveryPaths([
        "src-tauri/src/worktrees/create_windows.rs",
        "public/brand/wordmark.svg",
      ]),
    ).toMatchObject({
      frontend: true,
      macNative: false,
      windowsNative: true,
      macProduct: true,
      windowsProduct: true,
    });
    expect(
      classifyDeliveryPaths(["src-tauri/src/worktrees/create.rs"]),
    ).toMatchObject({
      macNative: true,
      windowsNative: true,
      macProduct: true,
      windowsProduct: false,
    });
  });
});

describe("Windows engineering producer requirements", () => {
  it("keeps primary tooling and selects explicit Windows cases by full name", () => {
    const base = "1".repeat(40);
    const head = "2".repeat(40);
    const scope = classifyDeliveryPaths([
      "src-tauri/src/worktrees/create_windows.rs",
    ]);
    expect(requiredAffectedCommands(scope, base, head)).toEqual([
      ["git", "diff", "--check", base, head],
      ["corepack", "pnpm", "docs:check"],
      ["corepack", "pnpm", "test", "scripts"],
    ]);
    const commands = requiredWindowsAffectedCommands(base, head);
    expect(commands[0]).toEqual(["git", "diff", "--check", base, head]);
    expect(commands.slice(3).map((command) => command.slice(-4))).toEqual(
      windowsAffectedTests.map((name) => [
        name,
        "--",
        "--exact",
        "--nocapture",
      ]),
    );
    expect(windowsAffectedTests).toContain(
      "worktrees::tests::existing_branch_and_checkout_transforms_modes_links_are_preserved",
    );
    expect(windowsAffectedTests).toContain(
      "worktrees::create::windows::tests::public_create_materializes_selected_old_oid_and_source_profile_without_touching_source",
    );
  });

  it("rejects successful empty Cargo filters and retains failure or ignored counts", () => {
    expect(
      parseWindowsTestResult(
        "\r\nrunning 0 tests\r\n\r\ntest result: ok. 0 passed; 0 failed; 0 ignored; 1 filtered out\r\n",
      ),
    ).toBeNull();
    expect(
      parseWindowsTestResult(
        "\nrunning 1 test\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 5 filtered out\n",
      ),
    ).toEqual({ passed: 0, failed: 1, ignored: 0 });
    expect(
      parseWindowsTestResult(
        "\nrunning 1 test\n\ntest result: ok. 0 passed; 0 failed; 1 ignored; 5 filtered out\n",
      ),
    ).toEqual({ passed: 0, failed: 0, ignored: 1 });
    expect(
      parseWindowsTestResult(
        "\r\nrunning 1 test\r\n\r\ntest result: ok. 1 passed; 0 failed; 0 ignored; 5 filtered out\r\n",
      ),
    ).toEqual({ passed: 1, failed: 0, ignored: 0 });
  });
});
