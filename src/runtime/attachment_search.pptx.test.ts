import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pptxSetup } from "./attachment_search.pptx.test-support";
import { deferred, tick } from "./attachment_search.test-support";
import {
  AttachmentSearch,
  ATTACHMENT_SEARCH_LIMITS as L,
} from "./attachment_search";
import { attachmentSearchIsPptx } from "./attachment_search_source";
import {
  pptxSearchText,
  snapshotPptxSearchCapture,
} from "./attachment_search_pptx";
import { pptxDisplayFixture, pptxTestCapture } from "./pptx_display_fixture";
import { pptxFixture, fixtureInput } from "./pptx_fixture";
import { parsePptx } from "./pptx_parse";
import {
  PptxError,
  type PptxCapture,
  type PptxPreview,
  type PptxShape,
} from "./pptx_types";
import {
  attachmentSearchLocationLabel,
  ATTACHMENT_SEARCH_STRINGS as S,
} from "./attachment_search_strings";

const sourceFields = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const;
const changedValue = (key: (typeof sourceFields)[number]) =>
  key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed";
function shape(h: ReturnType<typeof pptxSetup>) {
  const value = h.preview.slides[0].shapes[0];
  if (value.kind !== "shape" || !value.text) throw Error();
  return value as Extract<PptxShape, { kind: "shape" }> & {
    text: NonNullable<typeof value.text>;
  };
}

describe("explicit current PPTX attachment search", () => {
  it("searches parsed preview text through the bounded presentation route", async () => {
    const h = pptxSetup();
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0]).toMatchObject({
      state: "searched",
      matches: 1,
      presentation: { partial: true, slideCount: 2, imageReferences: 0 },
    });
    expect(h.services.readPptx).toHaveBeenCalledOnce();
    expect(h.services.parsePptx).toHaveBeenCalledOnce();
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().hits[0]).toMatchObject({
      before: "parsed ",
      match: "needle",
      after: " tail",
      location: {
        kind: "pptx",
        slidePart: "ppt/slides/slide1.xml",
        previewSlide: 1,
        previewTotal: 2,
        shape: 1,
        paragraph: 1,
        segment: 1,
        source: { part: "ppt/slides/slide1.xml", shapeId: "2", layer: "slide" },
      },
    });
  });

  it.each([
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    " Application/Vnd.Openxmlformats-Officedocument.Presentationml.Presentation ; source=current",
  ])(
    "recognizes MIME essence on an extensionless actual location: %s",
    async (mimeType) => {
      const h = pptxSetup(),
        item = h.s.items[0];
      if (item.kind !== "user") throw Error();
      const path = "/fixture/extensionless";
      item.attachments[0] = {
        name: "display.txt",
        uri: `file://${path}`,
        mimeType,
      };
      Object.assign(h.file, {
        path,
        resolvedPath: path,
        name: "extensionless",
      });
      h.files.set(path, h.file);
      h.captures.set(path, h.capture);
      h.previews.set(path, h.preview);
      await h.search.start("needle", h.refresh(), h.current);
      expect(h.search.snapshot().matches).toBe(1);
      expect(h.services.read).not.toHaveBeenCalled();
    },
  );
  it("uses the actual uppercase path, never a misleading display name", async () => {
    const h = pptxSetup(),
      item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0] = {
      name: "misleading.pptx",
      uri: "file:///fixture/file0.txt",
    };
    await h.search.start("compressed", h.refresh(), h.current);
    expect(h.services.readPptx).not.toHaveBeenCalled();
    expect(h.search.snapshot().matches).toBe(1);
    const path = "/fixture/UPPER.PPTX";
    item.attachments[0] = { name: "other", uri: `file://${path}` };
    Object.assign(h.file, { path, resolvedPath: path, name: "UPPER.PPTX" });
    h.files.set(path, h.file);
    h.captures.set(path, h.capture);
    h.previews.set(path, h.preview);
    await h.search.start("needle", h.refresh(), h.current);
    expect(h.search.snapshot().matches).toBe(1);
  });
  it("retains DOCX/XLSX/PDF declaration precedence and never routes by a display name", () => {
    const h = pptxSetup();
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/pdf",
    ])
      expect(attachmentSearchIsPptx({ ...h.candidates[0], mimeType })).toBe(
        false,
      );
    expect(
      attachmentSearchIsPptx({
        ...h.candidates[0],
        path: "/fixture/ordinary",
        name: "fake.pptx",
      }),
    ).toBe(false);
  });

  it.each(sourceFields)(
    "rejects changed captured source %s before parsing",
    async (key) => {
      const h = pptxSetup();
      h.services.readPptx.mockResolvedValue({
        ...h.capture,
        file: { ...h.file, [key]: changedValue(key) },
      });
      await h.search.start("needle", h.candidates, h.current);
      expect(h.search.snapshot().hits).toEqual([]);
      expect(h.services.parsePptx).not.toHaveBeenCalled();
      expect(h.search.snapshot().rows[0].code).toBe(
        key === "path" ? "invalid" : "changed",
      );
    },
  );
  it.each(sourceFields)("rejects changed parser source %s", async (key) => {
    const h = pptxSetup();
    h.services.parsePptx.mockResolvedValue({
      ...h.preview,
      file: { ...h.file, [key]: changedValue(key) },
    });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.services.check).not.toHaveBeenCalled();
  });
  it.each(sourceFields)("rejects changed postparse source %s", async (key) => {
    const h = pptxSetup();
    h.services.check.mockResolvedValue({
      kind: "verified",
      file: { ...h.file, [key]: changedValue(key) },
    });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().hits).toEqual([]);
  });
  it.each([
    ["readPending", "pending"],
    ["readBusy", "busy"],
    ["limit", "documentLimit"],
    ["encrypted", "encrypted"],
    ["changed", "changed"],
    ["unreadable", "unreadable"],
    ["invalid", "invalid"],
    ["unsupported", "unsupported"],
  ])(
    "keeps actual capture failure %s as %s without falling back",
    async (code, expected) => {
      const h = pptxSetup();
      h.services.readPptx.mockRejectedValue({ code });
      await h.search.start("needle", h.candidates, h.current);
      expect(h.search.snapshot().rows[0].code).toBe(expected);
      expect(h.services.read).not.toHaveBeenCalled();
      expect(h.services.parsePptx).not.toHaveBeenCalled();
    },
  );
  it.each(["limit", "busy", "timeout", "invalid", "unsupported"])(
    "preserves Worker failure %s without raw text fallback",
    async (code) => {
      const h = pptxSetup();
      h.services.parsePptx.mockRejectedValue(new PptxError(code as "limit"));
      await h.search.start("needle", h.candidates, h.current);
      expect(h.search.snapshot().rows[0].code).toBe(
        code === "limit" ? "documentLimit" : code,
      );
      expect(h.services.read).not.toHaveBeenCalled();
      expect(h.search.snapshot().hits).toEqual([]);
    },
  );
  it("a selected over-1MiB source is rejected before either reader", async () => {
    const h = pptxSetup();
    h.file.size = L.fileBytes + 1;
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe("tooLarge");
    expect(h.services.readPptx).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it("counts actual extracted UTF-8 for the shared budget, never compressed archive size", async () => {
    const text = "甲".repeat(2 * 1024 * 1024),
      h = pptxSetup([text, text, text]);
    await h.search.start("absent", h.candidates, h.current);
    expect(h.search.snapshot().rows.map((r) => r.state)).toEqual([
      "searched",
      "searched",
      "skipped",
    ]);
    expect(h.search.snapshot().rows[2].code).toBe("budget");
    expect(h.search.snapshot().rows[2].presentation?.partial).toBe(true);
    const perDocument = new TextEncoder().encode(
      text + "第二页文字",
    ).byteLength;
    expect(h.search.snapshot().bytes).toBe(perDocument * 2);
  });

  it("cancelled real capture keeps the flight busy until its original promise settles", async () => {
    const h = pptxSetup(),
      wait = deferred<PptxCapture>();
    h.services.readPptx.mockImplementationOnce(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    h.search.cancel();
    expect(h.search.active()).toBe(true);
    expect(await h.search.start("needle", h.candidates, h.current)).toBe(false);
    expect(h.services.readPptx).toHaveBeenCalledOnce();
    wait.resolve(h.capture);
    await run;
    expect(h.search.snapshot()).toMatchObject({
      phase: "cancelled",
      hits: [],
      matches: 0,
    });
    expect(h.services.parsePptx).not.toHaveBeenCalled();
    expect(h.search.active()).toBe(false);
  });
  it("a changed actual attachment object cannot publish a late capture", async () => {
    const h = pptxSetup(),
      wait = deferred<PptxCapture>();
    h.services.readPptx.mockImplementation(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    const item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0] = { ...item.attachments[0] };
    wait.resolve(h.capture);
    await run;
    expect(h.search.snapshot()).toMatchObject({ phase: "stale", hits: [] });
    expect(h.services.parsePptx).not.toHaveBeenCalled();
  });
  it("a cancelled parser observes the abort and cannot publish its late model", async () => {
    const h = pptxSetup(),
      wait = deferred<PptxPreview>();
    h.services.parsePptx.mockImplementationOnce(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    const signal = h.services.parsePptx.mock.calls[0][1];
    h.search.cancel();
    expect(signal.aborted).toBe(true);
    wait.resolve(h.preview);
    await run;
    expect(h.search.snapshot()).toMatchObject({
      phase: "cancelled",
      hits: [],
      matches: 0,
    });
    expect(h.services.check).not.toHaveBeenCalled();
  });
  it("serializes parser jobs but allows two bounded capture receipts", async () => {
    const h = pptxSetup(["needle", "needle"]),
      wait = deferred<PptxPreview>();
    h.services.parsePptx.mockImplementationOnce(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    expect(h.services.readPptx).toHaveBeenCalledTimes(2);
    expect(h.services.parsePptx).toHaveBeenCalledOnce();
    wait.resolve(h.preview);
    await run;
    expect(h.services.parsePptx).toHaveBeenCalledTimes(2);
    expect(h.search.snapshot().matches).toBe(2);
  });
  it("retiring a scope during parse clears all returned search permission", async () => {
    const h = pptxSetup(),
      wait = deferred<PptxPreview>();
    h.services.parsePptx.mockImplementation(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    h.search.retire();
    wait.resolve(h.preview);
    await run;
    expect(h.search.snapshot()).toMatchObject({
      phase: "idle",
      hits: [],
      rows: [],
    });
    expect(h.services.check).not.toHaveBeenCalled();
  });
  it("snapshots capture entries, parts and file before the asynchronous parser", async () => {
    const h = pptxSetup(),
      wait = deferred<PptxPreview>();
    h.services.parsePptx.mockImplementation(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    const captured = h.services.parsePptx.mock.calls[0][0];
    expect(captured).not.toBe(h.capture);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.file)).toBe(true);
    expect(Object.isFrozen(captured.parts)).toBe(true);
    expect(Object.isFrozen(captured.parts[0])).toBe(true);
    expect(Object.isFrozen(captured.entries)).toBe(true);
    h.capture.parts.length = 0;
    h.capture.entries.length = 0;
    expect(captured.parts.length).toBeGreaterThan(0);
    expect(captured.entries.length).toBeGreaterThan(0);
    wait.resolve(h.preview);
    await run;
    expect(h.search.snapshot().matches).toBe(1);
  });
  it("a malformed closed model has no partial hits or false zero-result success", async () => {
    const h = pptxSetup();
    Object.assign(shape(h), { html: "needle" });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe("invalid");
    expect(h.search.snapshot().rows[0].presentation).toBeUndefined();
    expect(h.search.snapshot().matches).toBe(0);
    expect(h.search.snapshot().hits).toEqual([]);
  });
  it("post-result navigation checks the exact file version before locating its message", async () => {
    const h = pptxSetup();
    await h.search.start("needle", h.candidates, h.current);
    h.services.check.mockResolvedValue({
      kind: "verified",
      file: { ...h.file, sha256: "b".repeat(64) },
    });
    expect(
      await h.search.verifyHit(h.search.snapshot().hits[0], h.current),
    ).toBe(false);
    expect(h.search.snapshot()).toMatchObject({
      phase: "stale",
      hits: [],
      error: "changed",
    });
  });
  it.each(["readPptx", "parsePptx"] as const)(
    "missing %s capability rejects without falling back",
    async (key) => {
      const h = pptxSetup(),
        search = new AttachmentSearch({ ...h.services, [key]: undefined });
      await search.start("needle", h.candidates, h.current);
      expect(search.snapshot().rows[0].code).toBe("unsupported");
      expect(h.services.read).not.toHaveBeenCalled();
    },
  );
});

describe("PPTX preview-text projection boundaries", () => {
  it("does not join breaks, paragraphs, shapes or slides; styled runs within a segment may join", () => {
    const h = pptxSetup("unused".split(" ")),
      first = shape(h),
      template = first.text.paragraphs[0].runs[0];
    if (template.kind !== "text") throw Error();
    first.text.paragraphs = [
      {
        alignment: "left",
        runs: [
          { ...template, text: "styled" },
          { ...template, text: " needle" },
          { kind: "break" },
          { ...template, text: "tail" },
        ],
      },
      { alignment: "left", runs: [{ ...template, text: "paragraph" }] },
    ];
    const second = structuredClone(first);
    second.id = "second";
    second.source.shapeId = "44";
    second.text.paragraphs = [
      { alignment: "left", runs: [{ ...template, text: "shape" }] },
    ];
    h.preview.slides[0].shapes.push(second);
    const { file: _file, ...model } = h.preview;
    const result = pptxSearchText(
      model,
      new Set(h.capture.parts.map((p) => p.name)),
    );
    expect(result.segments.map((s) => s.text)).toEqual([
      "styled needle",
      "tail",
      "paragraph",
      "shape",
      "第二页文字",
    ]);
    expect(result.segments[1].location).toMatchObject({
      previewSlide: 1,
      shape: 1,
      paragraph: 1,
      segment: 2,
    });
    expect(result.segments[2].location).toMatchObject({
      previewSlide: 1,
      shape: 1,
      paragraph: 2,
      segment: 1,
    });
    expect(result.segments[3].location).toMatchObject({
      previewSlide: 1,
      shape: 2,
    });
    expect(result.segments[4].location).toMatchObject({ previewSlide: 2 });
  });
  it("keeps the real author's preview order and source slide parts independently", () => {
    const capture = pptxFixture(),
      result = pptxSearchText(
        parsePptx(capture),
        new Set(capture.parts.map((p) => p.name)),
      );
    expect(result.presentation).toMatchObject({
      partial: true,
      slideCount: 2,
      imageReferences: 1,
    });
    const first = result.segments.find((s) =>
        s.text.includes("LAYOUT THEME 01"),
      )!,
      second = result.segments.find((s) =>
        s.text.includes("DIRECT OVERRIDE 02"),
      )!;
    expect(first.location).toMatchObject({
      previewSlide: 1,
      slidePart: "ppt/slides/slide2.xml",
    });
    expect(second.location).toMatchObject({
      previewSlide: 2,
      slidePart: "ppt/slides/slide1.xml",
    });
    expect(result.segments.map((s) => s.text)).not.toContain("quadrants.png");
  });
  it("keeps an unmodified standard writer's body text inside explicit partial scope", () => {
    const capture = fixtureInput(
      readFileSync(
        new URL("./fixtures/pptx/default-title-content.pptx", import.meta.url),
      ),
    );
    const result = pptxSearchText(
      parsePptx(capture),
      new Set(capture.parts.map((p) => p.name)),
    );
    expect(result.presentation.partial).toBe(true);
    expect(
      result.segments.some((s) => s.text.includes("PYTHON_PPTX_DEFAULT_TITLE")),
    ).toBe(true);
    expect(
      result.segments.some((s) => s.text.includes("Synthetic body line one")),
    ).toBe(true);
    expect(
      result.segments.some((s) => s.text.includes("Synthetic body line two")),
    ).toBe(true);
  });
  it("permits explicitly disclosed model formatting symbols and freezes exact locations", () => {
    const h = pptxSetup("• needle".split("unlikely"));
    const { file: _file, ...model } = h.preview;
    const result = pptxSearchText(
      model,
      new Set(h.capture.parts.map((p) => p.name)),
    );
    expect(result.segments[0].text).toBe("• needle");
    expect(result.presentation.partial).toBe(true);
    expect(Object.isFrozen(result.segments[0].location.source)).toBe(true);
    expect(attachmentSearchLocationLabel(result.segments[0].location)).toBe(
      "预览 1/2 · 对象 1 · 段落 1 · 片段 1",
    );
    expect(S.pptxFormatting).toContain("并非作者逐字全文或源字符位置");
    expect(S.pptxScope).toContain("备注");
  });
  it.each(["\0bad", "\uD800bad"])(
    "rejects invalid text %j rather than inventing a searchable replacement",
    (text) => {
      const h = pptxSetup([text]),
        { file: _file, ...model } = h.preview;
      expect(() =>
        pptxSearchText(model, new Set(h.capture.parts.map((p) => p.name))),
      ).toThrow(PptxError);
    },
  );
  it("does not manufacture a Unicode character from invalid separate runs", () => {
    const h = pptxSetup(),
      first = shape(h),
      template = first.text.paragraphs[0].runs[0];
    if (template.kind !== "text") throw Error();
    first.text.paragraphs[0].runs = [
      { ...template, text: "\uD83D" },
      { ...template, text: "\uDE42" },
    ];
    const { file: _file, ...model } = h.preview;
    expect(() =>
      pptxSearchText(model, new Set(h.capture.parts.map((p) => p.name))),
    ).toThrow(PptxError);
  });
  it("never searches image metadata, package keys or warnings and does not claim full text", () => {
    const model = pptxDisplayFixture(true),
      capture = pptxTestCapture();
    const result = pptxSearchText(
      model,
      new Set(capture.parts.map((p) => p.name)),
    );
    expect(result.presentation.imageReferences).toBe(1);
    expect(result.presentation.partial).toBe(true);
    expect(result.segments.map((s) => s.text).join("")).not.toMatch(
      /quadrants|ppt\/slides|shapeId|fontSubstitution/,
    );
  });
  it("rejects source parts absent from the original capture", () => {
    const input = pptxDisplayFixture();
    expect(() =>
      pptxSearchText(input, new Set(["ppt/slides/slide1.xml"])),
    ).toThrow(PptxError);
  });
  it.each([
    (c: PptxCapture) => {
      c.entries.push(c.entries[0]);
    },
    (c: PptxCapture) => {
      c.parts.push(c.parts[0]);
    },
    (c: PptxCapture) => {
      c.parts[0].name = "not-in-capture.xml";
    },
    (c: PptxCapture) => {
      c.inflatedBytes = 0;
    },
  ])("rejects malformed capture metadata before parsing", (edit) => {
    const capture = pptxTestCapture();
    edit(capture);
    expect(() => snapshotPptxSearchCapture(capture)).toThrow(PptxError);
  });
});
