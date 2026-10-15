import { expect, it } from "vitest";
import { pptxDisplayFixture, pptxTestFile } from "./pptx_display_fixture";
import {
  createPptxFeedbackSource,
  pptxFeedbackTarget,
  retirePptxFeedbackSource,
} from "./pptx_feedback_target";
import { officeFeedbackTargetMatches } from "./office_feedback_target";
import { parsePptx } from "./pptx_parse";
import { pptxFixture, replacePptxPart } from "./pptx_fixture";
const make = () => {
  const preview = { ...pptxDisplayFixture(), file: { ...pptxTestFile } };
  const source = createPptxFeedbackSource({
    preview,
    slide: preview.slides[1],
    expectedFile: preview.file,
  })!;
  return { preview, source };
};
it("pins actual whole-slide membership rather than equal text, number or copied source", () => {
  const { preview, source } = make();
  const anchor = pptxFeedbackTarget(source)!;
  expect(anchor).toEqual({
    kind: "pptx-slide",
    part: preview.slides[1].part,
    previewSlide: 2,
    previewSlideCount: 2,
  });
  expect(officeFeedbackTargetMatches({ source, anchor })).toBe(true);
  expect(
    officeFeedbackTargetMatches({
      source,
      anchor: { ...anchor, previewSlide: 1 },
    }),
  ).toBe(false);
  expect(pptxFeedbackTarget({ ...source })).toBeNull();
  expect(
    createPptxFeedbackSource({
      preview,
      slide: { ...preview.slides[1] },
      expectedFile: preview.file,
    }),
  ).toBeNull();
});
it("accepts actual parser slide objects and preserves source part despite a reordered preview", () => {
  const preview = { ...parsePptx(pptxFixture()), file: { ...pptxTestFile } };
  preview.slides.reverse();
  const source = createPptxFeedbackSource({
    preview,
    slide: preview.slides[0],
    expectedFile: preview.file,
  })!;
  expect(pptxFeedbackTarget(source)).toMatchObject({
    part: preview.slides[0].part,
    previewSlide: 1,
  });
});
it.each(["part", "order", "duplicate", "file", "list"])(
  "permanently retires an observed %s mutation",
  (kind) => {
    const { preview, source } = make(),
      original = [...preview.slides];
    if (kind === "part") preview.slides[1].part = "ppt/slides/changed.xml";
    if (kind === "order") preview.slides.reverse();
    if (kind === "duplicate") preview.slides.push(preview.slides[1]);
    if (kind === "file") preview.file = { ...preview.file };
    if (kind === "list") preview.slides = [...preview.slides];
    expect(pptxFeedbackTarget(source)).toBeNull();
    preview.slides = original;
    expect(pptxFeedbackTarget(source)).toBeNull();
  },
);
it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "version",
  "sha256",
] as const)("requires the exact %s file field", (key) => {
  const preview = { ...pptxDisplayFixture(), file: { ...pptxTestFile } };
  const changed = {
    ...preview.file,
    [key]: key === "size" ? preview.file.size + 1 : "changed",
  };
  expect(
    createPptxFeedbackSource({
      preview,
      slide: preview.slides[0],
      expectedFile: changed,
    }),
  ).toBeNull();
});
it("retirement is idempotent and cannot revoke a fresh selection", () => {
  const { preview, source } = make();
  const next = createPptxFeedbackSource({
    preview,
    slide: preview.slides[1],
    expectedFile: preview.file,
  })!;
  retirePptxFeedbackSource(source);
  retirePptxFeedbackSource(source);
  expect(pptxFeedbackTarget(source)).toBeNull();
  expect(pptxFeedbackTarget(next)).not.toBeNull();
});
it("keeps the actual source part when a hidden preceding slide is absent from preview ordinals", () => {
  const input = pptxFixture(),
    original = parsePptx(input);
  const filtered = parsePptx(
    replacePptxPart(input, original.slides[0].part, (xml) =>
      xml.replace('showMasterSp="1"', 'showMasterSp="1" show="0"'),
    ),
  );
  expect(filtered.slides).toHaveLength(1);
  const preview = { ...filtered, file: { ...pptxTestFile } };
  const source = createPptxFeedbackSource({
    preview,
    slide: preview.slides[0],
    expectedFile: preview.file,
  })!;
  expect(pptxFeedbackTarget(source)).toEqual({
    kind: "pptx-slide",
    part: original.slides[1].part,
    previewSlide: 1,
    previewSlideCount: 1,
  });
});
