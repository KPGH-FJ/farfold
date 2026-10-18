import { expect, it } from "vitest";
import { approvedDocument, documentBlock } from "./docx_draft.test-support";
import { localMessageAttachments, wirePromptBlocks } from "./prompt_blocks";
import { DOCUMENT_INPUT_MAX_BYTES } from "./document_input_types";
import type { PromptBlock } from "./session_types";

it("delivers only reviewed document text to a consumer that rereads resource URIs", () => {
  const approved = documentBlock();
  const queued: PromptBlock[] = [
    { type: "text", text: "use the reviewed text" },
    approved,
  ];
  const before = structuredClone(queued);
  const wire = wirePromptBlocks(queued);
  // Some official consumers use resource.uri rather than resource.text.
  // Their baseline Text path must receive the reviewed body without a URI to reread.
  const texts = wire.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  );
  const reads = wire.flatMap((block) =>
    block.type === "resource" ? [block.resource.uri] : [],
  );
  expect(texts).toEqual([
    "use the reviewed text",
    JSON.stringify({ fileName: approved.localDocumentText!.source.name }),
    approved.resource.text,
  ]);
  expect(reads).toEqual([]);
  expect(JSON.stringify(wire)).not.toContain("file:");
  expect(queued).toEqual(before);
  expect(localMessageAttachments(queued)[0]).toMatchObject({
    uri: approved.resource.uri,
    localDocumentText: approved.localDocumentText,
  });
});

it("keeps separate reviewed documents in order and sends each exact body once", () => {
  const first = documentBlock();
  const approvedSecond = approvedDocument("第二份文档\n  exact spacing 🙂\n");
  approvedSecond.local!.source.path = "/owned/second.docx";
  approvedSecond.local!.source.resolvedPath = "/owned/second.docx";
  approvedSecond.local!.source.name = "second.docx";
  const second = {
    type: "resource" as const,
    resource: {
      uri: "file:///owned/second.docx",
      mimeType: "text/plain",
      text: approvedSecond.text,
    },
    localDocumentText: approvedSecond.local,
  };
  const before = structuredClone([first, second]);
  expect(wirePromptBlocks([first, second])).toEqual([
    {
      type: "text",
      text: JSON.stringify({ fileName: first.localDocumentText!.source.name }),
    },
    { type: "text", text: first.resource.text },
    {
      type: "text",
      text: JSON.stringify({ fileName: second.localDocumentText!.source.name }),
    },
    { type: "text", text: second.resource.text },
  ]);
  expect([first, second]).toEqual(before);
  expect(localMessageAttachments([first, second]).map((a) => a.uri)).toEqual([
    first.resource.uri,
    second.resource.uri,
  ]);
});

it("does not flatten ordinary resources or historical text without local authority", () => {
  const ordinary = {
    type: "resource" as const,
    resource: {
      uri: "file:///owned/readme.txt",
      mimeType: "text/plain",
      text: "ordinary content",
      ignoredLocalField: "not sent",
    },
  };
  const historical = documentBlock();
  delete historical.localDocumentText;
  expect(wirePromptBlocks([ordinary, historical])).toEqual([
    {
      type: "resource",
      resource: {
        uri: ordinary.resource.uri,
        mimeType: "text/plain",
        text: ordinary.resource.text,
      },
    },
    { type: "resource", resource: historical.resource },
  ]);
});

it("rejects missing or malformed authority instead of turning it into plain text", () => {
  const unowned = documentBlock();
  unowned.localDocumentText = null;
  expect(() => wirePromptBlocks([unowned])).toThrow();
  const malformed = documentBlock();
  Object.assign(malformed.localDocumentText!, { schema: 99 });
  expect(() => wirePromptBlocks([malformed])).toThrow();
});

function namedDocument(name: string, text: string, pathName = name) {
  const approved = approvedDocument(text);
  approved.local!.source.name = name;
  approved.local!.source.path = `/owned/${pathName}`;
  approved.local!.source.resolvedPath = `/owned/${pathName}`;
  return {
    type: "resource" as const,
    resource: {
      uri: `file:///owned/${encodeURIComponent(pathName)}`,
      mimeType: "text/plain",
      text: approved.text,
    },
    localDocumentText: approved.local,
  };
}

it("distinguishes equal reviewed bodies by their chosen filenames when order changes", () => {
  const body = "相同的已确认正文\nexact spacing 🙂\n";
  const first = namedDocument("first.docx", body);
  const second = namedDocument("second.docx", body);
  const queued = [first, second];
  const before = structuredClone(queued);
  const wire = wirePromptBlocks(queued);
  expect(wire).not.toEqual(wirePromptBlocks([second, first]));
  expect(wire).toEqual([
    { type: "text", text: JSON.stringify({ fileName: "first.docx" }) },
    { type: "text", text: body },
    { type: "text", text: JSON.stringify({ fileName: "second.docx" }) },
    { type: "text", text: body },
  ]);
  expect(queued).toEqual(before);
  expect(localMessageAttachments(queued).map((item) => item.uri)).toEqual([
    first.resource.uri,
    second.resource.uri,
  ]);
});

it("quotes filename controls as source data without leaking source paths or authority", () => {
  const name = 'line\n"quoted"\t\u0001.docx';
  const body = "Reviewed body stays exact.\n";
  // Formatter-level metadata shape only: existing file-path admission still
  // rejects controls, and this test does not claim filesystem authorization.
  const queued = [namedDocument(name, body, "control-fixture.docx")];
  const before = structuredClone(queued);
  const wire = wirePromptBlocks(queued);
  expect(wire).toHaveLength(2);
  expect(wire).toEqual([
    { type: "text", text: JSON.stringify({ fileName: name }) },
    { type: "text", text: body },
  ]);
  const label = wire[0] as Extract<PromptBlock, { type: "text" }>;
  expect(JSON.parse(label.text)).toEqual({ fileName: name });
  expect(label.text).not.toMatch(/[\r\n\t\u0000-\u001f]/);
  const serialized = JSON.stringify(wire);
  for (const forbidden of [
    "file:",
    "/owned/",
    "localDocumentText",
    "sha256",
    "fixture-version",
  ])
    expect(serialized).not.toContain(forbidden);
  expect(queued).toEqual(before);
});

it("keeps the approved body limit separate from bounded filename metadata", () => {
  // Exercise the existing metadata decoder cap, not an OS filename fixture.
  const name = "\u0001".repeat(4096);
  const body = "a".repeat(DOCUMENT_INPUT_MAX_BYTES);
  const queued = [namedDocument(name, body, "metadata-limit.docx")];
  const before = structuredClone(queued);
  const wire = wirePromptBlocks(queued);
  expect(wire).toHaveLength(2);
  expect(wire).toEqual([
    { type: "text", text: JSON.stringify({ fileName: name }) },
    { type: "text", text: body },
  ]);
  const label = wire[0] as Extract<PromptBlock, { type: "text" }>;
  expect(Buffer.byteLength(label.text)).toBeLessThanOrEqual(6 * 4096 + 15);
  // Also include the second JSON escaping layer of this official Text block.
  expect(Buffer.byteLength(JSON.stringify(label))).toBeLessThanOrEqual(28730);
  expect(queued[0].localDocumentText!.utf8Bytes).toBe(DOCUMENT_INPUT_MAX_BYTES);
  expect(queued).toEqual(before);
});
