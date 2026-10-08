import { expect, it } from "vitest";
import {
  userMessageBlocks,
  userMessageDraftAttachments,
} from "./message_actions";
import type { Attachment } from "./session_types";

const image: Attachment = {
  kind: "image",
  name: "shot.png",
  uri: "/p/shot.png",
  mimeType: "image/png",
  data: "aW1n",
};
const textFile: Attachment = {
  kind: "resource",
  name: "a.ts",
  uri: "/p/a.ts",
  mimeType: "text/typescript",
  text: "code",
};
const link: Attachment = {
  kind: "resource_link",
  name: "doc",
  uri: "https://example.test/doc",
};

it("restores a user message to sendable blocks without dropping uri attachments", () => {
  expect(userMessageBlocks("  再看一下  ", [image, textFile, link])).toEqual([
    { type: "text", text: "再看一下" },
    {
      type: "image",
      data: "aW1n",
      mimeType: "image/png",
      uri: "/p/shot.png",
    },
    {
      type: "resource",
      resource: { uri: "/p/a.ts", mimeType: "text/typescript", text: "code" },
    },
    {
      type: "resource_link",
      name: "doc",
      uri: "https://example.test/doc",
    },
  ]);
});

it("keeps only the text when attachments have no resendable payload", () => {
  const orphan: Attachment = { kind: "image", name: "gone.png" };
  expect(userMessageBlocks("hi", [orphan])).toEqual([
    { type: "text", text: "hi" },
  ]);
  expect(userMessageBlocks("   ", [orphan])).toEqual([]);
});

it("restores draft attachments as editable image/file chips", () => {
  const [img, file] = userMessageDraftAttachments([image, textFile]);
  expect(img).toMatchObject({
    kind: "image",
    name: "shot.png",
    uri: "/p/shot.png",
    data: "aW1n",
    mimeType: "image/png",
  });
  expect(file).toMatchObject({
    kind: "file",
    name: "a.ts",
    uri: "/p/a.ts",
    mimeType: "text/typescript",
    content: "code",
  });
  expect(img.id).not.toBe(file.id);
});
