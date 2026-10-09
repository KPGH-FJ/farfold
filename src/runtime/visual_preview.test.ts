import { expect, it } from "vitest";
import { checkedVisualPreview, visualFileKind } from "./visual_preview";
import type { VerifiedFile } from "./file_delivery";

const file: VerifiedFile = {
  root: "/work",
  path: "/work/report.pdf",
  resolvedPath: "/work/report.pdf",
  name: "report.pdf",
  size: 8,
  sha256: "a".repeat(64),
  version: "b".repeat(64),
};
it("routes only explicitly supported visual files without turning SVG or HTML into pictures", () => {
  for (const name of [
    "picture.png",
    "picture.JPG",
    "picture.jpeg",
    "picture.gif",
    "picture.webp",
  ])
    expect(visualFileKind(name)).toBe("image");
  expect(visualFileKind("report.PDF")).toBe("pdf");
  for (const name of [
    "active.svg",
    "active.html",
    "report.docx",
    "chart.xlsx",
    "slides.pptx",
    "image.heic",
  ])
    expect(visualFileKind(name)).toBeNull();
});
it("requires the complete captured file identity and actual PDF signature", () => {
  const data = btoa("%PDF-1.7");
  expect(
    checkedVisualPreview(file, { file, mimeType: "application/pdf", data })
      .bytes,
  ).toEqual(new TextEncoder().encode("%PDF-1.7"));
  for (const change of [
    { version: "new" },
    { path: "/other.pdf" },
    { sha256: "other" },
    { root: "/other" },
    { size: 9 },
  ])
    expect(() =>
      checkedVisualPreview(file, {
        file: { ...file, ...change },
        mimeType: "application/pdf",
        data,
      }),
    ).toThrow();
  expect(() =>
    checkedVisualPreview(file, {
      file,
      mimeType: "application/pdf",
      data: btoa("<script>"),
    }),
  ).toThrow();
  expect(() =>
    checkedVisualPreview(file, { file, mimeType: "text/html", data }),
  ).toThrow();
});
it("rejects malformed base64 and truncated data before decoding or rendering", () => {
  for (const data of ["!!", btoa("%PDF"), ""])
    expect(() =>
      checkedVisualPreview(file, { file, mimeType: "application/pdf", data }),
    ).toThrow();
});
