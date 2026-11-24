import { describe, expect, it } from "vitest";
import { classifyDeliveryPaths } from "./delivery-scope.mjs";

describe("delivery scope", () => {
  it("requires frontend engineering and installed evidence for the public wordmark", () => {
    expect(classifyDeliveryPaths(["public/brand/wordmark.svg"])).toEqual({
      frontend: true,
      native: false,
      product: true,
      governance: false,
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
    });
  });
});
