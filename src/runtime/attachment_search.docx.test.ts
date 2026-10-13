import { describe, expect, it, vi } from "vitest";
import { deferred, setup, tick } from "./attachment_search.test-support";
import { AttachmentSearch } from "./attachment_search";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
import { DocxError, type DocxCapture, type DocxPreview } from "./docx_types";
import type { VerifiedFile } from "./file_delivery";

function docxSetup(texts = ["author needle tail"], plain: string[] = []) {
  const h = setup([...texts.map(() => "compressed source"), ...plain]);
  const captures = new Map<string, DocxCapture>(),
    previews = new Map<string, DocxPreview>();
  texts.forEach((text, i) => {
    const item = h.s.items[i];
    if (item.kind !== "user" && item.kind !== "agent") throw Error();
    const path = `/fixture/chosen${i}.docx`;
    item.attachments![0] = { name: `chosen${i}.docx`, uri: `file://${path}` };
    const file = {
      ...h.files.get(`/fixture/file${i}.txt`)!,
      path,
      resolvedPath: path,
      name: `chosen${i}.docx`,
    };
    h.files.set(path, file);
    captures.set(path, {
      file,
      parts: [{ name: "word/document.xml", data: "eA==" }],
      entries: ["word/document.xml"],
      inflatedBytes: 1,
    });
    previews.set(path, {
      file,
      blocks: [
        {
          kind: "paragraph",
          id: "p1",
          style: {},
          source: { part: "word/document.xml", elementPath: [0, 0] },
          runs: [{ kind: "text", text, style: {} }],
        },
      ],
      stories: [],
      images: [],
      warnings: [],
      partial: false,
    });
  });
  const services = {
    ...h.services,
    readDocx: vi.fn(async (f: VerifiedFile) => captures.get(f.path)!),
    parseDocx: vi.fn(async (c: DocxCapture, _signal: AbortSignal) =>
      previews.get(c.file.path)!,
    ),
  };
  let candidates = attachmentSearchCandidates([h.s.key], h.states).candidates;
  const refresh = () =>
    (candidates = attachmentSearchCandidates([h.s.key], h.states).candidates);
  const current = () =>
    candidates.every((c) => attachmentSearchSourceCurrent(c, h.states));
  const file = captures.values().next().value!.file,
    capture = captures.get(file.path)!,
    preview = previews.get(file.path)!;
  return {
    ...h,
    file,
    capture,
    preview,
    captures,
    previews,
    services,
    candidates,
    current,
    refresh,
    search: new AttachmentSearch(services),
  };
}

describe("explicit current DOCX attachment search", () => {
  it("searches selected DOCX author text through the bounded document route", async () => {
    const h = docxSetup();
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(1);
    expect(h.services.readDocx).toHaveBeenCalledOnce();
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().hits[0]).toMatchObject({
      source: h.candidates[0],
      before: "author ",
      match: "needle",
      after: " tail",
      location: { region: "body", paragraph: 1 },
    });
    expect(h.search.snapshot().bytes).toBe(18);
  });
  it.each([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    " Application/Vnd.Openxmlformats-Officedocument.Wordprocessingml.Document ; charset=UTF-8",
  ])(
    "uses shared MIME essence for extensionless DOCX: %s",
    async (mimeType) => {
      const h = docxSetup(),
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
  it("uses actual uppercase DOCX location, never a misleading display name alone", async () => {
    const h = docxSetup(),
      item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0] = {
      name: "chosen.docx",
      uri: "file:///fixture/file0.txt",
    };
    await h.search.start("compressed", h.refresh(), h.current);
    expect(h.services.readDocx).not.toHaveBeenCalled();
    expect(h.services.read).toHaveBeenCalledOnce();
    const path = "/fixture/UPPER.DOCX";
    item.attachments[0] = { name: "other", uri: `file://${path}` };
    Object.assign(h.file, { path, resolvedPath: path, name: "UPPER.DOCX" });
    h.files.set(path, h.file);
    h.captures.set(path, h.capture);
    h.previews.set(path, h.preview);
    await h.search.start("needle", h.refresh(), h.current);
    expect(h.search.snapshot().matches).toBe(1);
  });
  it("MIME mutation invalidates ownership and cannot publish a late capture", async () => {
    const h = docxSetup(),
      wait = deferred<DocxCapture>();
    h.services.readDocx.mockImplementation(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    const item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0].mimeType = "text/plain";
    expect(h.current()).toBe(false);
    wait.resolve(h.capture);
    await run;
    expect(h.search.snapshot()).toMatchObject({ phase: "stale", hits: [] });
    expect(h.services.parseDocx).not.toHaveBeenCalled();
  });
  it.each([
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ] as const)(
    "rejects changed capture source %s before parsing",
    async (key) => {
      const h = docxSetup();
      h.services.readDocx.mockResolvedValue({
        ...h.capture,
        file: {
          ...h.file,
          [key]:
            key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed",
        },
      });
      await h.search.start("needle", h.candidates, h.current);
      expect(h.search.snapshot().rows[0].code).toBe(
        key === "path" ? "invalid" : "changed",
      );
      expect(h.services.parseDocx).not.toHaveBeenCalled();
    },
  );
  it.each([
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ] as const)("rejects changed parsed source %s", async (key) => {
    const h = docxSetup();
    h.services.parseDocx.mockResolvedValue({
      ...h.preview,
      file: {
        ...h.file,
        [key]:
          key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed",
      },
    });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.services.check).not.toHaveBeenCalled();
  });
  it.each([
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ] as const)(
    "rejects changed final revision %s and hides author text",
    async (key) => {
      const h = docxSetup();
      h.services.check.mockResolvedValue({
        kind: "verified",
        file: {
          ...h.file,
          [key]:
            key === "size" ? 9 : key === "sha256" ? "b".repeat(64) : "/changed",
        },
      });
      await h.search.start("needle", h.candidates, h.current);
      expect(h.search.snapshot().hits).toEqual([]);
      expect(h.search.snapshot().rows[0].state).toBe("error");
    },
  );
  it.each([
    ["readPending", "pending"],
    ["readBusy", "busy"],
    ["limit", "documentLimit"],
    ["encrypted", "encrypted"],
    ["invalid", "invalid"],
    ["unsupported", "unsupported"],
    ["unreadable", "unreadable"],
    ["changed", "changed"],
  ])("preserves native %s reason as %s", async (code, expected) => {
    const h = docxSetup();
    h.services.readDocx.mockRejectedValue({ code });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe(expected);
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.services.parseDocx).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it.each(["busy", "timeout", "limit", "unsupported"] as const)(
    "retains Worker %s reason without ordinary text fallback",
    async (code) => {
      const h = docxSetup();
      h.services.parseDocx.mockRejectedValue(new DocxError(code));
      await h.search.start("needle", h.candidates, h.current);
      expect(h.search.snapshot().rows[0].code).toBe(
        code === "limit" ? "documentLimit" : code,
      );
      expect(h.services.read).not.toHaveBeenCalled();
    },
  );
  it("serializes same-batch parsers while bounded reads may prefetch two", async () => {
    const h = docxSetup(["first needle", "second needle", "third needle"]),
      first = deferred<DocxPreview>();
    let active = 0,
      max = 0;
    h.services.parseDocx.mockImplementation(async (c) => {
      active++;
      max = Math.max(max, active);
      try {
        return c.file === h.capture.file
          ? await first.promise
          : h.previews.get(c.file.path)!;
      } finally {
        active--;
      }
    });
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    expect(h.services.readDocx).toHaveBeenCalledTimes(2);
    expect(h.services.parseDocx).toHaveBeenCalledOnce();
    first.resolve(h.preview);
    await run;
    expect(max).toBe(1);
    expect(h.search.snapshot().matches).toBe(3);
    expect(h.services.parseDocx).toHaveBeenCalledTimes(3);
  });
  it("cancels Worker work and drops a late result without starting another parser", async () => {
    const h = docxSetup(["needle", "needle"]),
      wait = deferred<DocxPreview>();
    let signal: AbortSignal | undefined;
    h.services.parseDocx.mockImplementation((_c, s) => {
      signal = s;
      return wait.promise;
    });
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    h.search.cancel();
    expect(signal?.aborted).toBe(true);
    wait.resolve(h.preview);
    await run;
    expect(h.services.parseDocx).toHaveBeenCalledOnce();
    expect(h.search.snapshot()).toMatchObject({ phase: "cancelled", hits: [] });
    expect(h.services.check).not.toHaveBeenCalled();
  });
  it("waits for already started native captures on cancel and retains late unknown state", async () => {
    const h = docxSetup(["needle", "needle", "needle"]),
      wait = deferred<DocxCapture>();
    h.services.readDocx.mockImplementation(() => wait.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    h.search.cancel();
    expect(h.search.active()).toBe(true);
    expect(h.search.snapshot().phase).toBe("cancelling");
    expect(h.services.readDocx).toHaveBeenCalledTimes(2);
    wait.reject({ code: "readPending" });
    await run;
    expect(h.search.snapshot()).toMatchObject({ phase: "pending", hits: [] });
    expect(h.services.parseDocx).not.toHaveBeenCalled();
  });
  it("accounts actual extracted UTF8 instead of compressed size or UTF16 in mixed batches", async () => {
    const text = "界".repeat(3_000_000) + " needle",
      h = docxSetup([text, text], ["needle"]);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot()).toMatchObject({ bytes: 9_000_013, matches: 2 });
    expect(h.search.snapshot().rows.map((r) => r.state)).toEqual([
      "searched",
      "skipped",
      "searched",
    ]);
    expect(h.search.snapshot().rows[1].code).toBe("budget");
  });
  it("accepts exact16MiB extracted bytes and skips only the one-byte excess", async () => {
    const h = docxSetup(
      ["界".repeat(4 * 1024 * 1024), "a".repeat(4 * 1024 * 1024)],
      ["x"],
    );
    await h.search.start("zz", h.candidates, h.current);
    expect(h.search.snapshot().bytes).toBe(16 * 1024 * 1024);
    expect(h.search.snapshot().rows.map((r) => r.state)).toEqual([
      "searched",
      "searched",
      "skipped",
    ]);
    expect(h.services.read).toHaveBeenCalledOnce();
  });
  it("does not parse a capture beyond the existing inflation budget", async () => {
    const h = docxSetup();
    h.capture.inflatedBytes = 64 * 1024 * 1024 + 1;
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe("documentLimit");
    expect(h.services.parseDocx).not.toHaveBeenCalled();
  });
  it("rechecks revision before navigating a DOCX author snippet", async () => {
    const h = docxSetup();
    await h.search.start("needle", h.candidates, h.current);
    h.services.check.mockResolvedValue({
      kind: "verified",
      file: { ...h.file, version: "new" },
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
  it("reconsiders later text after an earlier reserved read fails", async () => {
    const h = docxSetup(
      ["界".repeat(4 * 1024 * 1024), "a".repeat(3 * 1024 * 1024)],
      ["b".repeat(1024 * 1024), "needle" + "c".repeat(512 * 1024 - 6)],
    );
    const wait = deferred<{ file: VerifiedFile; text: string }>();
    const read = h.services.read.getMockImplementation()!;
    h.services.read.mockImplementation((f) =>
      f.path.endsWith("file2.txt") ? wait.promise : read(f),
    );
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    wait.reject({ code: "unreadable" });
    await run;
    expect(h.search.snapshot().rows.map((r) => r.state)).toEqual([
      "searched",
      "searched",
      "error",
      "searched",
    ]);
    expect(h.search.snapshot()).toMatchObject({
      bytes: 15 * 1024 * 1024 + 512 * 1024,
      matches: 1,
    });
  });
});
