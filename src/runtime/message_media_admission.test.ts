import { afterEach, expect, it, vi } from "vitest";
import {
  attachmentMedia,
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";

const limit = 16 * 1024 * 1024;
const encodedLimit = 4 * Math.ceil(limit / 3);
const source = (data: string, mimeType = "image/png") => ({
  kind: "image" as const,
  name: "Unchanged source",
  uri: "file:///owned/source.png",
  data,
  mimeType,
});

afterEach(() => vi.restoreAllMocks());

it.each(["image/png", "audio/wav"])(
  "refuses oversized %s before scanning its payload or constructing a URL",
  (mimeType) => {
    const data = "A".repeat(encodedLimit + 4);
    const input = source(data, mimeType);
    const probe = vi.spyOn(RegExp.prototype, "test");
    const media = attachmentMedia(input);
    const scanned = probe.mock.calls.some(([value]) => value === data);
    probe.mockRestore();
    expect(media === null).toBe(true);
    expect(scanned).toBe(false);
    expect(input.data === data).toBe(true);
    expect(input.uri).toBe("file:///owned/source.png");
  },
);

it.each(["A", "AA", "AAA", "A===", "AA=A", "Zh==", "Zm9=", "====", "YWJj\n"])(
  "refuses malformed or noncanonical base64 %j without changing its data",
  (data) => {
    const input = source(data);
    expect(attachmentMedia(input) === null).toBe(true);
    expect(input.data).toBe(data);
  },
);

it.each(["AAA=", "AAAA"])(
  "checks decoded bytes for the same encoded ceiling ending in %s",
  (tail) => {
    const data = "AAAA".repeat(Math.floor(limit / 3)) + tail;
    expect(data.length).toBe(encodedLimit);
    expect(attachmentMedia(source(data, "audio/wav")) === null).toBe(true);
    expect(attachmentMediaAdmission(source(data, "audio/wav"))).toEqual({
      status: "rejected",
      reason: "tooLarge",
    });
  },
);

it("admits the exact byte limit and canonical one/two/three-byte groups", () => {
  const data = "AAAA".repeat(Math.floor(limit / 3)) + "AA==";
  const media = attachmentMedia(source(data, "audio/wav"));
  expect(media?.kind).toBe("audio");
  expect(media?.src.length).toBe(data.length + "data:audio/wav;base64,".length);
  for (const value of ["Zg==", "Zm8=", "Zm9v"])
    expect(attachmentMedia(source(value, "audio/wav"))?.src).toBe(
      `data:audio/wav;base64,${value}`,
    );
});

it("retains declared payload bytes without trimming before media admission", () => {
  const data = "A".repeat(encodedLimit + 4);
  const probe = vi.spyOn(String.prototype, "trim");
  const normalized = normalizeMessageAttachment({
    type: "image",
    data,
    mimeType: "image/png",
    uri: "file:///owned/source.png",
  });
  const trimmed = probe.mock.contexts.some((value) => String(value) === data);
  probe.mockRestore();
  expect(trimmed).toBe(false);
  expect(normalized?.data === data).toBe(true);
  expect(normalized?.uri).toBe("file:///owned/source.png");
});

it("rejects an enormous malformed payload before any payload validation scan", () => {
  const data = "!" + "A".repeat(encodedLimit + 3);
  const probe = vi.spyOn(RegExp.prototype, "test");
  const result = attachmentMediaAdmission(source(data));
  const scanned = probe.mock.calls.some(([value]) => value === data);
  probe.mockRestore();
  expect(result).toEqual({ status: "rejected", reason: "tooLarge" });
  expect(scanned).toBe(false);
});

it("handles a malformed character at the end of a bounded maximal payload without regex backtracking", () => {
  const data = "A".repeat(encodedLimit - 4) + "!A==";
  const probe = vi.spyOn(RegExp.prototype, "test");
  const result = attachmentMediaAdmission(source(data));
  const scanned = probe.mock.calls.some(([value]) => value === data);
  probe.mockRestore();
  expect(result).toEqual({ status: "rejected", reason: "invalid" });
  expect(scanned).toBe(false);
});

it("preserves an embedded resource blob for the same admission, without trimming or decoding it", () => {
  const data = "A".repeat(encodedLimit + 4);
  const probe = vi.spyOn(String.prototype, "trim");
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/blob.wav",
      mimeType: "audio/wav",
      blob: data,
    },
  });
  const trimmed = probe.mock.contexts.some((value) => String(value) === data);
  probe.mockRestore();
  expect(trimmed).toBe(false);
  expect(attachment?.data === data).toBe(true);
  expect(attachmentMediaAdmission(attachment!)).toEqual({
    status: "rejected",
    reason: "tooLarge",
  });
});

it.each(["", " ", "AA-_", "Zg==\n", "Zg== ", "=AAA", "AA==AA=="])(
  "gives a fixed malformed-data result for %j without forgiving whitespace or URL alphabets",
  (data) => {
    expect(attachmentMediaAdmission(source(data))).toEqual({
      status: "rejected",
      reason: "invalid",
    });
  },
);

it("retains declared kinds, sources and bytes in original projection order after a refusal", async () => {
  const { applyUpdate, freshThreadState } =
    await import("./session_projection");
  const state = freshThreadState("media-order", "chosen", "/owned", "native");
  const payloads = [
    {
      type: "image",
      data: "Zg",
      mimeType: "image/png",
      uri: "file:///owned/first.png",
    },
    {
      type: "audio",
      data: "YXVkaW8=",
      mimeType: "audio/wav",
      uri: "file:///owned/second.wav",
    },
  ];
  for (const content of payloads)
    applyUpdate(state, { sessionUpdate: "agent_message_chunk", content });
  const item = state.items[0];
  if (item.kind !== "agent") throw new Error("missing Agent message");
  const before = JSON.stringify(item);
  expect(attachmentMediaAdmission(item.attachments![0]).status).toBe(
    "rejected",
  );
  expect(attachmentMediaAdmission(item.attachments![1]).status).toBe(
    "available",
  );
  expect(item.attachments?.map((a) => [a.kind, a.data, a.uri])).toEqual(
    payloads.map((p) => [p.type, p.data, p.uri]),
  );
  expect(JSON.stringify(item)).toBe(before);
});
