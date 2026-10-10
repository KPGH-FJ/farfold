import { expect, it } from "vitest";
import type { VerifiedFile, VisualPreview } from "./file_delivery";
import {
  createVisualAreaFeedbackSource,
  registerVisualFeedbackFrame,
  retireVisualAreaFeedbackSource,
  retireVisualFeedbackFrame,
  visualAreaFeedbackSourceIsValid,
  visualAreaFeedbackTarget,
  visualAreaFeedbackTargetMatches,
  type VisualTargetConfirmation,
  type VisualFeedbackFrameInput,
} from "./visual_feedback_target";

function fixture(kind: "image" | "pdf" = "image") {
  const file: VerifiedFile = {
    root: "/work",
    path: `file.${kind === "pdf" ? "pdf" : "png"}`,
    resolvedPath: `/work/file.${kind === "pdf" ? "pdf" : "png"}`,
    name: `file.${kind === "pdf" ? "pdf" : "png"}`,
    size: 8,
    sha256: "a".repeat(64),
    version: "v1",
  };
  const preview: VisualPreview = {
    file: { ...file },
    mimeType: kind === "pdf" ? "application/pdf" : "image/png",
    data: "Y29udHJvbGw=",
  };
  const state: { current: boolean; onCurrent?: () => void } = { current: true };
  const common = {
    preview,
    expectedFile: file,
    drawOwner: {},
    pixelWidth: 800,
    pixelHeight: 600,
    isCurrent: () => {
      state.onCurrent?.();
      return state.current;
    },
  };
  const input: VisualFeedbackFrameInput =
    kind === "pdf"
      ? { ...common, kind, page: 2, pageCount: 3 }
      : { ...common, kind };
  const frame = registerVisualFeedbackFrame(input)!;
  const selection = { left: 100, top: 200, right: 800000, bottom: 900000 };
  const sourceInput = { frame, selection, expectedFile: file };
  const source = createVisualAreaFeedbackSource(sourceInput)!;
  return { file, preview, state, input, frame, selection, sourceInput, source };
}
it.each(["image", "pdf"] as const)(
  "binds actual %s frame and exact reading result without public body/DOM",
  (kind) => {
    const f = fixture(kind);
    const anchor = visualAreaFeedbackTarget(f.source)!;
    expect(anchor).toEqual({
      ...f.selection,
      kind: kind === "pdf" ? "pdf-area" : "image-area",
      space: "display-oriented-v1",
      ...(kind === "pdf" ? { page: 2, pageCount: 3 } : {}),
    });
    expect(
      visualAreaFeedbackTargetMatches(
        { source: f.source, anchor } as VisualTargetConfirmation,
        f.preview,
      ),
    ).toBe(true);
    expect(
      visualAreaFeedbackTargetMatches(
        { source: f.source, anchor } as VisualTargetConfirmation,
        { ...f.preview },
      ),
    ).toBe(false);
    expect(Object.keys(f.source).sort()).toEqual(["file", "kind"]);
    expect(Object.isFrozen(f.frame)).toBe(true);
    expect(Object.isFrozen(f.source.file)).toBe(true);
    expect(JSON.stringify(f.source)).not.toContain(f.preview.data);
  },
);
it("rejects copied, forged, conflicting or extra-field confirmations", () => {
  const f = fixture();
  const anchor = visualAreaFeedbackTarget(f.source)!;
  expect(visualAreaFeedbackTarget({ ...f.source })).toBeNull();
  expect(
    createVisualAreaFeedbackSource({ ...f.sourceInput, frame: { ...f.frame } }),
  ).toBeNull();
  for (const value of [
    { ...anchor, left: 101 },
    { ...anchor, verified: true },
    { ...anchor, kind: "pdf-area", page: 1, pageCount: 1 },
  ]) {
    expect(
      visualAreaFeedbackTargetMatches(
        { source: f.source, anchor: value } as VisualTargetConfirmation,
        f.preview,
      ),
    ).toBe(false);
  }
  expect(visualAreaFeedbackTarget(f.source)).toEqual(anchor);
});
it("a new selection on one frame retires the old source irreversibly", () => {
  const f = fixture();
  const other = createVisualAreaFeedbackSource({
    ...f.sourceInput,
    selection: { ...f.selection, left: 300 },
  })!;
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  expect(visualAreaFeedbackSourceIsValid(other)).toBe(true);
  retireVisualAreaFeedbackSource(f.source);
  expect(visualAreaFeedbackSourceIsValid(other)).toBe(true);
});
it("a replacement frame using one renderer owner cannot revive the prior frame", () => {
  const f = fixture();
  const next = registerVisualFeedbackFrame({ ...f.input, pixelWidth: 400 })!;
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  expect(createVisualAreaFeedbackSource(f.sourceInput)).toBeNull();
  retireVisualFeedbackFrame(f.frame);
  expect(
    createVisualAreaFeedbackSource({ ...f.sourceInput, frame: next }),
  ).not.toBeNull();
});
it("hidden/geometry-invalid state retires once; later true does not restore it", () => {
  const f = fixture();
  f.state.current = false;
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  f.state.current = true;
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  expect(createVisualAreaFeedbackSource(f.sourceInput)).toBeNull();
  expect(registerVisualFeedbackFrame(f.input)).not.toBeNull();
});
it("explicit retirement cascades only its own source", () => {
  const a = fixture(),
    b = fixture();
  retireVisualFeedbackFrame(a.frame);
  expect(visualAreaFeedbackTarget(a.source)).toBeNull();
  expect(visualAreaFeedbackTarget(b.source)).not.toBeNull();
});
it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "sha256",
  "version",
  "size",
] as const)(
  "mutation of saved reading field %s permanently invalidates ownership",
  (key) => {
    const f = fixture();
    const original = f.preview.file[key];
    Object.assign(f.preview.file, { [key]: key === "size" ? 9 : "changed" });
    expect(visualAreaFeedbackTarget(f.source)).toBeNull();
    Object.assign(f.preview.file, { [key]: original });
    expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  },
);
it.each([
  "previewFile",
  "expectedFile",
  "data",
  "mimeType",
  "selection",
  "frame",
])(
  "rejects same-value object replacement or captured data mutation: %s",
  (kind) => {
    const f = fixture();
    if (kind === "previewFile") f.preview.file = { ...f.preview.file };
    if (kind === "expectedFile") f.sourceInput.expectedFile = { ...f.file };
    if (kind === "data") f.preview.data = "Y2hhbmdlZA==";
    if (kind === "mimeType") f.preview.mimeType = "image/jpeg";
    if (kind === "selection") f.sourceInput.selection = { ...f.selection };
    if (kind === "frame") f.sourceInput.frame = { ...f.frame };
    expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  },
);
it("rejects coordinate mutation even if it is restored after observed failure", () => {
  const f = fixture();
  f.selection.left++;
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
  f.selection.left--;
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
});
it.each([
  { pixelWidth: 0 },
  { pixelHeight: NaN },
  { pixelWidth: 8193 },
  { pixelWidth: 8192, pixelHeight: 8192 },
  { page: 4 },
  { pageCount: 1001 },
])("refuses unavailable/unbounded render declaration %j", (patch) => {
  const f = fixture("pdf");
  expect(
    registerVisualFeedbackFrame({
      ...f.input,
      ...patch,
    } as VisualFeedbackFrameInput),
  ).toBeNull();
});
it("rechecks actual reading after renderer callback mutates it", () => {
  const f = fixture();
  f.input.isCurrent = () => {
    f.preview.data = "Y2hhbmdlZA==";
    return true;
  };
  expect(registerVisualFeedbackFrame(f.input)).toBeNull();
});
it("a callback that retires or replaces the frame cannot re-admit it", () => {
  const f = fixture();
  f.state.onCurrent = () => {
    retireVisualFeedbackFrame(f.frame);
  };
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
});
it("a throwing renderer callback retires the source without throwing to consumers", () => {
  const f = fixture();
  f.state.onCurrent = () => {
    throw new Error("fixture");
  };
  expect(visualAreaFeedbackTarget(f.source)).toBeNull();
});
it("rejects a confirmation mutated by the current-renderer callback", () => {
  const f = fixture();
  const anchor = visualAreaFeedbackTarget(f.source)!;
  f.state.onCurrent = () => Object.assign(anchor, { verified: true });
  expect(
    visualAreaFeedbackTargetMatches(
      { source: f.source, anchor } as VisualTargetConfirmation,
      f.preview,
    ),
  ).toBe(false);
});
