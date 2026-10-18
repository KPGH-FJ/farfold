import { expect, it } from "vitest";
import { approvedDocument, documentBlock } from "./docx_draft.test-support";
import { localMessageAttachments, wirePromptBlocks } from "./prompt_blocks";
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
  expect(texts).toEqual(["use the reviewed text", approved.resource.text]);
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
    { type: "text", text: first.resource.text },
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
