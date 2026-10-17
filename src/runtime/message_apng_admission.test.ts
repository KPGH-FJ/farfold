import { expect, it, vi } from "vitest";
import { attachmentMediaAdmission } from "./message_attachments";
import {
  apngTestFile,
  MESSAGE_APNG_TEST_DATA,
  pngTestChunks,
  pngTestFile,
} from "./message_apng_fixtures.test-support";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";

function admission(file: Buffer, mimeType = "image/png") {
  return attachmentMediaAdmission({
    name: "Owned APNG",
    uri: "file:///owned/animation.png",
    mimeType,
    data: file.toString("base64"),
  });
}

it("keeps the exact owned tiny APNG available without changing its source", () => {
  expect(admission(Buffer.from(MESSAGE_APNG_TEST_DATA, "base64"))).toEqual({
    status: "available",
    media: {
      kind: "image",
      src: `data:image/png;base64,${MESSAGE_APNG_TEST_DATA}`,
    },
  });
});

it("admits the standard image/apng MIME through the same PNG declaration gate", () => {
  expect(
    admission(Buffer.from(MESSAGE_APNG_TEST_DATA, "base64"), "image/apng"),
  ).toEqual({
    status: "available",
    media: {
      kind: "image",
      src: `data:image/apng;base64,${MESSAGE_APNG_TEST_DATA}`,
    },
  });
});

it("rejects excessive frames declared as image/apng before preview creation", () => {
  expect(admission(apngTestFile({ frames: 129 }), "image/apng")).toEqual({
    status: "rejected",
    reason: "tooComplex",
  });
});

it.each([
  Buffer.from("not a PNG"),
  Buffer.from("GIF89a"),
  Buffer.from([255, 216, 255]),
])(
  "does not accept a non-PNG signature merely because it declares image/apng %#",
  (data) => {
    expect(admission(data, "image/apng")).toEqual({
      status: "rejected",
      reason: "invalid",
    });
  },
);

it("rejects 129 small APNG frames before creating a preview source", () => {
  expect(admission(apngTestFile({ frames: 129 }))).toEqual({
    status: "rejected",
    reason: "tooComplex",
  });
});

it("charges APNG frames at the whole canvas instead of the encoded byte size", () => {
  expect(
    admission(apngTestFile({ width: 4096, height: 4096, frames: 5 })),
  ).toEqual({ status: "rejected", reason: "tooComplex" });
});

it("checks a later frame rectangle instead of trusting the first IHDR", () => {
  const chunks = pngTestChunks();
  chunks.filter((chunk) => chunk.kind === "fcTL")[1].data.writeUInt32BE(1, 12);
  expect(admission(pngTestFile(chunks))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it("rejects a skipped APNG shared control/data sequence number", () => {
  const chunks = pngTestChunks();
  chunks.find((chunk) => chunk.kind === "fdAT")!.data.writeUInt32BE(3);
  expect(admission(pngTestFile(chunks))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it("does not trust a frame count whose animation-control CRC was changed", () => {
  const bytes = Buffer.from(MESSAGE_APNG_TEST_DATA, "base64");
  bytes[49] ^= 1;
  expect(admission(bytes)).toEqual({ status: "rejected", reason: "invalid" });
});

it("rejects an animation declaration moved after the default IDAT", () => {
  const chunks = pngTestChunks();
  const control = chunks.splice(1, 1)[0];
  chunks.splice(3, 0, control);
  expect(admission(pngTestFile(chunks))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it.each([true, false])(
  "keeps 128 actual animation frames with defaultIncluded=%s",
  (defaultIncluded) => {
    expect(
      admission(apngTestFile({ frames: 128, defaultIncluded })).status,
    ).toBe("available");
  },
);

it("includes a separate default image in the full-canvas pixel sum", () => {
  expect(
    admission(apngTestFile({ width: 1024, height: 1024, frames: 64 })).status,
  ).toBe("available");
  expect(
    admission(
      apngTestFile({
        width: 1024,
        height: 1024,
        frames: 63,
        defaultIncluded: false,
      }),
    ).status,
  ).toBe("available");
  expect(
    admission(
      apngTestFile({
        width: 1024,
        height: 1024,
        frames: 64,
        defaultIncluded: false,
      }),
    ),
  ).toEqual({ status: "rejected", reason: "tooComplex" });
});

it.each(["png", "apng", "jpeg", "gif", "webp", "avif", "bmp"])(
  "applies APNG admission across the allowed image/%s declaration",
  (mime) => {
    const file = apngTestFile({ frames: 129 });
    const attachment = {
      name: "Original source",
      uri: "file:///owned/original.png",
      mimeType: `image/${mime}`,
      data: file.toString("base64"),
    };
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "rejected",
      reason: "tooComplex",
    });
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it.each([
  "no animation control",
  "duplicate animation control",
  "zero declared frames",
  "count mismatch",
  "control too short",
  "frame too short",
  "zero frame width",
  "invalid disposal",
  "invalid blend",
  "duplicate sequence",
  "data before control",
  "data without bytes",
  "default frame offset",
  "default frame dimensions",
  "missing default data",
  "split nonconsecutive IDAT",
  "duplicate IHDR",
] as const)("rejects the malformed APNG structure: %s", (kind) => {
  const chunks = pngTestChunks();
  const controls = chunks.filter((chunk) => chunk.kind === "fcTL");
  switch (kind) {
    case "no animation control":
      chunks.splice(1, 1);
      break;
    case "duplicate animation control":
      chunks.splice(2, 0, chunks[1]);
      break;
    case "zero declared frames":
      chunks[1].data.writeUInt32BE(0);
      break;
    case "count mismatch":
      chunks[1].data.writeUInt32BE(3);
      break;
    case "control too short":
      chunks[1].data = chunks[1].data.subarray(0, 7);
      break;
    case "frame too short":
      controls[1].data = controls[1].data.subarray(0, 25);
      break;
    case "zero frame width":
      controls[1].data.writeUInt32BE(0, 4);
      break;
    case "invalid disposal":
      controls[1].data[24] = 3;
      break;
    case "invalid blend":
      controls[1].data[25] = 2;
      break;
    case "duplicate sequence":
      controls[1].data.writeUInt32BE(0);
      break;
    case "data before control": {
      const [frame, data] = chunks.splice(4, 2);
      chunks.splice(4, 0, data, frame);
      break;
    }
    case "data without bytes":
      chunks.find((chunk) => chunk.kind === "fdAT")!.data = Buffer.alloc(4);
      chunks.find((chunk) => chunk.kind === "fdAT")!.data.writeUInt32BE(2);
      break;
    case "default frame offset":
      controls[0].data.writeUInt32BE(1, 12);
      break;
    case "default frame dimensions":
      controls[0].data.writeUInt32BE(1, 4);
      break;
    case "missing default data":
      chunks.splice(3, 1);
      break;
    case "split nonconsecutive IDAT":
      chunks.splice(4, 0, { kind: "raNd", data: Buffer.alloc(0) }, chunks[3]);
      break;
    case "duplicate IHDR":
      chunks.splice(1, 0, chunks[0]);
      break;
  }
  expect(admission(pngTestFile(chunks))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it("checks later frame CRC and complete chunk boundaries without trusting size fields", () => {
  const original = Buffer.from(MESSAGE_APNG_TEST_DATA, "base64");
  const changed = Buffer.from(original);
  const at = changed.indexOf("fcTL", changed.indexOf("fcTL") + 4);
  changed[at + 4 + 26] ^= 1;
  expect(admission(changed)).toEqual({ status: "rejected", reason: "invalid" });
  for (const file of [
    original.subarray(0, -1),
    Buffer.concat([original, Buffer.from([0])]),
  ])
    expect(admission(file)).toEqual({ status: "rejected", reason: "invalid" });
  const oversized = Buffer.from(original);
  oversized.writeUInt32BE(0xffffffff, 33);
  expect(admission(oversized)).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it("retains zero delay, zero denominator, infinite loops and first-frame previous disposal", () => {
  const chunks = pngTestChunks();
  const frame = chunks.find((chunk) => chunk.kind === "fcTL")!.data;
  frame.writeUInt16BE(0, 20);
  frame.writeUInt16BE(0, 22);
  frame[24] = 2;
  chunks[1].data.writeUInt32BE(0, 4);
  expect(admission(pngTestFile(chunks)).status).toBe("available");
});

it("allows empty data fragments and ancillary chunks between APNG frame fragments", () => {
  const chunks = pngTestChunks();
  const data = chunks[5].data;
  const empty = Buffer.alloc(4);
  empty.writeUInt32BE(2);
  data.writeUInt32BE(3);
  chunks.splice(
    5,
    0,
    { kind: "fdAT", data: empty },
    {
      kind: "raNd",
      data: Buffer.from("fcTL and acTL here are only opaque bytes"),
    },
  );
  expect(admission(pngTestFile(chunks)).status).toBe("available");
});

it("keeps static PNG ancillary payloads opaque instead of scanning for animation strings", () => {
  const chunks = pngTestChunks(PNG_IMAGE_TEST_DATA);
  chunks.splice(1, 0, {
    kind: "raNd",
    data: Buffer.from("acTL fcTL fdAT are not chunk headers"),
  });
  expect(admission(pngTestFile(chunks)).status).toBe("available");
});

it("does not use a browser decoder or extract a full binary string", () => {
  const atob = vi.spyOn(globalThis, "atob");
  try {
    expect(
      admission(Buffer.from(MESSAGE_APNG_TEST_DATA, "base64")).status,
    ).toBe("available");
    expect(atob.mock.calls).toEqual([[MESSAGE_APNG_TEST_DATA.slice(0, 44)]]);
  } finally {
    atob.mockRestore();
  }
});

it.each([PNG_IMAGE_TEST_DATA, MESSAGE_APNG_TEST_DATA])(
  "counts all PNG chunks at the exact shared record boundary %#",
  (source) => {
    const chunks = pngTestChunks(source);
    const extra = Array.from({ length: 65_536 - chunks.length }, () => ({
      kind: "raNd",
      data: Buffer.alloc(0),
    }));
    chunks.splice(1, 0, ...extra);
    expect(admission(pngTestFile(chunks)).status).toBe("available");
    chunks.splice(1, 0, { kind: "raNd", data: Buffer.alloc(0) });
    expect(admission(pngTestFile(chunks))).toEqual({
      status: "rejected",
      reason: "tooComplex",
    });
  },
);
