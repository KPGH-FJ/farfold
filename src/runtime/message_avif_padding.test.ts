import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { MESSAGE_AVIF_PROGRESSIVE_TEST_DATA as CONTROL } from "./message_avif_layers_fixtures.test-support";
import { MessageRasterReader } from "./message_raster_reader";

const original = Buffer.from(CONTROL, "base64");
type Box = { at: number; size: number; kind: string };
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end;) {
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > end)
      throw Error("Owned fixture layout differs");
    result.push({ at, size, kind: bytes.toString("ascii", at + 4, at + 8) });
    at += size;
  }
  return result;
}
function metadata(bytes: Buffer) {
  const meta = boxes(bytes, 0, bytes.length).find(
    (box) => box.kind === "meta",
  )!;
  const children = boxes(bytes, meta.at + 12, meta.at + meta.size);
  const iinf = children.find((box) => box.kind === "iinf")!;
  return { meta, children, iinf };
}
const old = metadata(original);
function padding(kind: string, bytes = 8) {
  const result = Buffer.alloc(bytes);
  result.writeUInt32BE(bytes);
  result.write(kind, 4, "ascii");
  return result;
}
// The official control uses idat-relative extents. Only ancestor sizes change;
// all original item, property, location and AV1 bytes are preserved. New variants
// are structural policy controls, not browser/native decoding evidence.
function padded(extra: Buffer, before = false) {
  const at = before ? old.iinf.at + 14 : old.iinf.at + old.iinf.size;
  const bytes = Buffer.concat([
    original.subarray(0, at),
    extra,
    original.subarray(at),
  ]);
  for (const parent of [old.meta, old.iinf])
    bytes.writeUInt32BE(parent.size + extra.length, parent.at);
  return bytes;
}
function common(bytes: Buffer, mimeType = "image/avif") {
  return attachmentMediaAdmission({
    kind: "image",
    name: "Owned AVIF padding control",
    mimeType,
    data: bytes.toString("base64"),
  });
}

it("pins the official control and preserves all image-bearing bytes around trailing padding", () => {
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "077ab2ad1e46dd912a973e4f024cb1eb242a08298be2dbf1a52a058e88c48a4a",
  );
  for (const kind of ["free", "skip"]) {
    const bytes = padded(padding(kind)),
      next = metadata(bytes);
    expect(bytes.readUInt16BE(next.iinf.at + 12)).toBe(2);
    expect(
      bytes.subarray(next.iinf.at + 14, next.iinf.at + old.iinf.size),
    ).toEqual(original.subarray(old.iinf.at + 14, old.iinf.at + old.iinf.size));
    for (const name of ["iloc", "iprp", "idat"]) {
      const a = old.children.find((box) => box.kind === name)!,
        b = next.children.find((box) => box.kind === name)!;
      expect(bytes.subarray(b.at, b.at + b.size)).toEqual(
        original.subarray(a.at, a.at + a.size),
      );
    }
  }
});

it.each(["free", "skip"])(
  "ignores bounded %s before or after infe without counting it as an item",
  (kind) => {
    for (const before of [false, true]) {
      const bytes = padded(padding(kind), before);
      expect(messageAvifAdmission(bytes.toString("base64"), true)).toBe(
        "withinBudget",
      );
      for (const mime of ["image/avif", "image/jpeg", "image/webp"])
        expect(common(bytes, mime)).toEqual({
          status: "available",
          media: {
            kind: "image",
            src: `data:${mime};base64,${bytes.toString("base64")}`,
          },
        });
    }
  },
);

it("applies the same policy to an embedded resource without rewriting it", () => {
  const data = padded(padding("free")).toString("base64");
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/control.avif",
      mimeType: "image/avif",
      blob: data,
    },
  })!;
  const before = JSON.stringify(attachment);
  expect(attachmentMediaAdmission(attachment).status).toBe("available");
  expect(JSON.stringify(attachment)).toBe(before);
});

it("keeps unknown entries, wrong item counts and out-of-bounds padding invalid", () => {
  const badSize = padding("free");
  badSize.writeUInt32BE(12);
  const wrongCount = padded(padding("skip"));
  wrongCount.writeUInt16BE(3, old.iinf.at + 12);
  for (const bytes of [padded(padding("junk")), padded(badSize), wrongCount]) {
    expect(messageAvifAdmission(bytes.toString("base64"), true)).toBe(
      "invalid",
    );
    expect(common(bytes)).toEqual({ status: "rejected", reason: "invalid" });
  }
});

it("charges padding boxes to the existing shared record limit", () => {
  const bytes = padded(
    Buffer.concat(Array.from({ length: 65_536 }, () => padding("free"))),
  );
  expect(common(bytes)).toEqual({ status: "rejected", reason: "tooComplex" });
});

it("keeps structural reads bounded while skipping opaque padding payload", () => {
  const read = vi.spyOn(MessageRasterReader.prototype, "u8");
  const decode = vi.spyOn(globalThis, "atob");
  try {
    const bytes = padded(padding("skip", 1024 * 1024));
    expect(common(bytes).status).toBe("available");
    expect(read.mock.calls.length).toBeLessThan(1000);
    // The existing PNG signature probe may decode its fixed tiny prefix.
    // It must never receive the large padding or complete encoded payload.
    expect(decode.mock.calls.every(([data]) => data.length <= 64)).toBe(true);
  } finally {
    read.mockRestore();
    decode.mockRestore();
  }
});
