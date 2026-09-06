import { describe, expect, it } from "vitest";
import { signedPayload } from "./sign-update-metadata.mjs";

const metadata = {
  version: "1.2.3",
  url: "https://example.com/Farfold.app.tar.gz",
  signature: "artifact-signature",
  notes: "更新 · release",
};

describe("signed release metadata publication", () => {
  it("binds visible metadata and application scope to the exact signed bytes", () => {
    const { document, payload } = signedPayload(
      metadata,
      "ai.farfold.test",
      "aarch64",
      2000,
      1000,
    );
    expect(JSON.parse(payload.toString("utf8"))).toEqual(document);
    expect(document.farfold).toEqual({
      formatVersion: 1,
      bundleId: "ai.farfold.test",
      target: "darwin",
      arch: "aarch64",
      expiresAt: 2000,
    });
    expect(document.notes).toBe(metadata.notes);
  });

  it("rejects unsigned artifact metadata, transport drift, and invalid lifetime", () => {
    for (const changed of [
      { ...metadata, signature: "" },
      { ...metadata, url: "http://example.com/update" },
      { ...metadata, platforms: {} },
      { ...metadata, farfoldMetadata: {} },
      { ...metadata, notes: "x".repeat(65_536) },
    ]) {
      expect(() =>
        signedPayload(changed, "ai.farfold.test", "aarch64", 2000, 1000),
      ).toThrow();
    }
    for (const expires of [0, 1000, 999_999_999, Number.NaN]) {
      expect(() =>
        signedPayload(metadata, "ai.farfold.test", "aarch64", expires, 1000),
      ).toThrow();
    }
  });
});
