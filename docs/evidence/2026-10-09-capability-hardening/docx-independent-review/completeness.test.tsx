import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { parseDocx } from "../../../../src/runtime/docx_parse";
import {
  docxFixture,
  replaceDocxPart,
} from "../../../../src/runtime/docx_fixture";
import { checkedDocxDocument } from "../../../../src/runtime/docx_validation";
import { DocxDocumentView } from "../../../../src/components/DocxDocumentView";
import { DocumentImages } from "../../../../src/runtime/document_images";

const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  // Only collect the production component's resource effects. This is not a
  // browser/UI lifecycle test; setState, layout, decoding and pixels are not mocked as proof.
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
afterEach(() => {
  hooks.effects = [];
  vi.restoreAllMocks();
});

it("marks the actual position of omitted hidden run content without exposing its text", () => {
  const input = replaceDocxPart(
    docxFixture("01-text-values"),
    "word/document.xml",
    (s) =>
      s.replace(
        /<w:body>[\s\S]*<\/w:body>/,
        "<w:body><w:p><w:r><w:t>before</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN-CONTROLLED</w:t></w:r><w:r><w:t>after</w:t></w:r></w:p></w:body>",
      ),
  );
  const result = parseDocx(input);
  checkedDocxDocument(result);
  console.log("HIDDEN_POSITION", JSON.stringify(result));
  expect(JSON.stringify(result)).not.toContain("HIDDEN-CONTROLLED");
  expect(result.partial).toBe(true);
  expect(result.blocks[0]).toMatchObject({
    runs: [
      { kind: "text", text: "before" },
      { kind: "notice", code: "hiddenContent" },
      { kind: "text", text: "after" },
    ],
  });
});

it("shares the retained image resource rather than cloning its bytes per repeated reference", () => {
  const input = replaceDocxPart(
    docxFixture("05-inline-png-jpeg"),
    "word/document.xml",
    (s) => {
      const drawing = s.match(/<w:drawing>[\s\S]*?<\/w:drawing>/)![0];
      return s.replace(
        /<w:body>[\s\S]*<\/w:body>/,
        `<w:body><w:p>${`<w:r>${drawing}</w:r>`.repeat(3)}</w:p></w:body>`,
      );
    },
  );
  const result = parseDocx(input);
  checkedDocxDocument(result);
  expect(result.images).toHaveLength(1);
  const sizes: number[] = [];
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    sizes.push(blob.size);
    return `blob:controlled-${sizes.length}`;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  renderToStaticMarkup(
    <DocxDocumentView
      document={{
        ...result,
        file: {
          root: "/fixture",
          path: "/fixture/a.docx",
          resolvedPath: "/fixture/a.docx",
          name: "a.docx",
          size: 2000,
          version: "v1",
          sha256: "fixture",
        },
      }}
    />,
  );
  const cleanup = hooks.effects.map((effect) => effect());
  for (const close of cleanup) close?.();
  console.log(
    "IMAGE_RESOURCE_COPIES",
    JSON.stringify({
      uniqueResources: result.images.length,
      displayReferences: 3,
      sourceBytes: result.images[0].bytes.byteLength,
      blobs: sizes.length,
      totalBlobBytes: sizes.reduce((a, b) => a + b, 0),
      revoked: revoke.mock.calls.length,
    }),
  );
  expect(create).toHaveBeenCalledTimes(1);
});

it("keeps shared URLs until the final visible consumer releases, with idempotent cleanup", () => {
  const image = parseDocx(docxFixture("05-inline-png-jpeg")).images[0];
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:shared");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const pool = new DocumentImages([image]);
  const a = pool.acquire(image.id)!,
    b = pool.acquire(image.id)!,
    c = pool.acquire(image.id)!;
  expect([a.url, b.url, c.url]).toEqual([
    "blob:shared",
    "blob:shared",
    "blob:shared",
  ]);
  expect(create).toHaveBeenCalledOnce();
  a.release();
  a.release();
  b.release();
  expect(revoke).not.toHaveBeenCalled();
  c.release();
  c.release();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:shared");
});

it("creates a new URL on later display and cannot let old cleanup revoke it", () => {
  const image = parseDocx(docxFixture("05-inline-png-jpeg")).images[0];
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:first")
    .mockReturnValueOnce("blob:second");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const pool = new DocumentImages([image]);
  const first = pool.acquire(image.id)!;
  first.release();
  const next = pool.acquire(image.id)!;
  expect(next.url).toBe("blob:second");
  expect(create).toHaveBeenCalledTimes(2);
  first.release();
  expect(revoke).toHaveBeenCalledTimes(1);
  next.release();
  expect(revoke.mock.calls.map(([url]) => url)).toEqual([
    "blob:first",
    "blob:second",
  ]);
});

it("isolates resources with the same id between distinct displayed documents", () => {
  const images = parseDocx(docxFixture("05-inline-png-jpeg")).images;
  vi.spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:file-a")
    .mockReturnValueOnce("blob:file-b");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const a = new DocumentImages([images[0]]).acquire(images[0].id)!;
  const b = new DocumentImages([{ ...images[1], id: images[0].id }]).acquire(
    images[0].id,
  )!;
  expect(a.url).not.toBe(b.url);
  a.release();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:file-a");
  b.release();
  expect(revoke.mock.calls.map(([url]) => url)).toEqual([
    "blob:file-a",
    "blob:file-b",
  ]);
});

it("does not retain a poisoned pool entry when URL allocation fails", () => {
  const image = parseDocx(docxFixture("05-inline-png-jpeg")).images[0];
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementationOnce(() => {
      throw Error("controlled allocation failure");
    })
    .mockReturnValueOnce("blob:retry");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const pool = new DocumentImages([image]);
  expect(() => pool.acquire(image.id)).toThrow("controlled allocation failure");
  expect(revoke).not.toHaveBeenCalled();
  const retry = pool.acquire(image.id)!;
  expect(retry.url).toBe("blob:retry");
  retry.release();
  expect(create).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:retry");
});
