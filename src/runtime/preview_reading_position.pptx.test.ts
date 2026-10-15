import { expect, it } from "vitest";
import {
  restoredPptxSlide,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "./preview_reading_position";
import { pptxDisplayFixture, pptxTestFile } from "./pptx_display_fixture";
it("restores the same actual slide part after a reordered revision", () => {
  const preview = { ...pptxDisplayFixture(), file: pptxTestFile };
  const ref: PreviewReadingPositionRef = { current: null };
  saveReadingPosition(ref, preview.file, {
    kind: "presentation",
    slide: { part: preview.slides[1].part, index: 1 },
  });
  preview.slides.reverse();
  expect(restoredPptxSlide(preview, ref)).toBe(0);
});
it("clamps a removed slide without pretending that it is the same source", () => {
  const preview = { ...pptxDisplayFixture(), file: pptxTestFile };
  const ref: PreviewReadingPositionRef = {
    current: {
      root: preview.file.root,
      resolvedPath: preview.file.resolvedPath,
      kind: "presentation",
      slide: { part: "removed", index: 999 },
    },
  };
  expect(restoredPptxSlide(preview, ref)).toBe(1);
  preview.slides.pop();
  expect(restoredPptxSlide(preview, ref)).toBe(0);
});
it("never borrows a reading position from another file or invalid index", () => {
  const preview = { ...pptxDisplayFixture(), file: pptxTestFile };
  const ref: PreviewReadingPositionRef = {
    current: {
      root: "/other",
      resolvedPath: preview.file.resolvedPath,
      kind: "presentation",
      slide: { part: preview.slides[1].part, index: 1 },
    },
  };
  expect(restoredPptxSlide(preview, ref)).toBe(0);
  ref.current = {
    root: preview.file.root,
    resolvedPath: preview.file.resolvedPath,
    kind: "presentation",
    slide: { part: "missing", index: NaN },
  };
  expect(restoredPptxSlide(preview, ref)).toBe(0);
});
