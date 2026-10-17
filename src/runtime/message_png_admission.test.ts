import { expect, it, vi } from "vitest";
import { attachmentMediaAdmission } from "./message_attachments";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";
import { MESSAGE_RASTER_TEST_DATA } from "./message_raster_fixtures.test-support";

// Only IHDR is changed; never send a large-canvas fixture to an image decoder.
function pngHeader(width = 2, height = 1, change?: (bytes: Buffer) => void) {
  const bytes = Buffer.from(PNG_IMAGE_TEST_DATA, "base64");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  change?.(bytes);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return bytes.toString("base64");
}
const image = (data: string, mimeType = "image/png") => ({
  kind: "image" as const,
  name: "Original image",
  uri: "file:///owned/original.png",
  mimeType,
  data,
});

it.each(["png", "jpeg", "gif", "webp", "avif", "bmp"])(
  "refuses a PNG signature with an excessive canvas even when declared image/%s",
  (mime) => {
    const attachment = image(pngHeader(8193, 1), `image/${mime}`);
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "rejected",
      reason: "tooManyPixels",
    });
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it.each([
  [8192, 2049],
  [2049, 8192],
  [1, 8193],
  [0x7fffffff, 0x7fffffff],
])("refuses the excessive declared canvas %s × %s", (width, height) => {
  expect(attachmentMediaAdmission(image(pngHeader(width, height)))).toEqual({
    status: "rejected",
    reason: "tooManyPixels",
  });
});

it.each([
  [4096, 4096],
  [8192, 2048],
  [2048, 8192],
  [8192, 1],
  [1, 8192],
])("only admits the declared canvas boundary %s × %s", (width, height) => {
  // The header is within budget, not proof of valid image data or decoding.
  expect(attachmentMediaAdmission(image(pngHeader(width, height))).status).toBe(
    "available",
  );
});

it.each([
  [0, 1],
  [1, 0],
  [0x80000000, 1],
  [1, 0xffffffff],
])("refuses invalid PNG dimensions %s × %s", (width, height) => {
  expect(attachmentMediaAdmission(image(pngHeader(width, height)))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it.each([
  (bytes: Buffer) => {
    bytes[0] = 0;
  },
  (bytes: Buffer) => {
    bytes.write("IDAT", 12, "ascii");
  },
  (bytes: Buffer) => {
    bytes.writeUInt32BE(12, 8);
  },
  (bytes: Buffer) => {
    bytes.writeUInt32BE(14, 8);
  },
  (bytes: Buffer) => {
    bytes[24] = 4;
  },
  (bytes: Buffer) => {
    bytes[25] = 1;
  },
  (bytes: Buffer) => {
    bytes[26] = 1;
  },
  (bytes: Buffer) => {
    bytes[27] = 1;
  },
  (bytes: Buffer) => {
    bytes[28] = 2;
  },
])("refuses an invalid signature or IHDR field %#", (change) => {
  expect(attachmentMediaAdmission(image(pngHeader(2, 1, change)))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
});

it("refuses a changed IHDR CRC and every truncated header without a fallback", () => {
  const bytes = Buffer.from(PNG_IMAGE_TEST_DATA, "base64");
  bytes[29] ^= 1;
  expect(attachmentMediaAdmission(image(bytes.toString("base64")))).toEqual({
    status: "rejected",
    reason: "invalid",
  });
  for (let length = 0; length < 33; length++)
    expect(
      attachmentMediaAdmission(
        image(bytes.subarray(0, length).toString("base64")),
      ),
    ).toEqual({ status: "rejected", reason: "invalid" });
  expect(
    attachmentMediaAdmission(
      image(bytes.subarray(0, 32).toString("base64"), "image/jpeg"),
    ),
  ).toEqual({ status: "rejected", reason: "invalid" });
});

it("keeps the exact small PNG and other supported non-PNG sources unchanged", () => {
  const source = `data:image/png;base64,${PNG_IMAGE_TEST_DATA}`;
  expect(attachmentMediaAdmission(image(PNG_IMAGE_TEST_DATA))).toEqual({
    status: "available",
    media: { kind: "image", src: source },
  });
  for (const [mime, data] of [
    ["jpeg", MESSAGE_RASTER_TEST_DATA.JPEG],
    ["gif", MESSAGE_RASTER_TEST_DATA.GIF],
    ["webp", MESSAGE_RASTER_TEST_DATA.WEBP],
  ])
    expect(attachmentMediaAdmission(image(data, `image/${mime}`))).toEqual({
      status: "available",
      media: { kind: "image", src: `data:image/${mime};base64,${data}` },
    });
  // AVIF metadata admission remains outside this slice; its browser decoding
  // outcome is not inferred from Base64 admission.
  expect(attachmentMediaAdmission(image("YWJj", "image/avif")).status).toBe(
    "available",
  );
  expect(attachmentMediaAdmission(image("YWJj", "image/svg+xml"))).toEqual({
    status: "unavailable",
  });
});

it("extracts only a fixed 33-byte header after the existing Base64 gate", () => {
  const atob = vi.spyOn(globalThis, "atob");
  try {
    attachmentMediaAdmission(image(PNG_IMAGE_TEST_DATA));
    expect(atob.mock.calls).toEqual([[PNG_IMAGE_TEST_DATA.slice(0, 44)]]);
  } finally {
    atob.mockRestore();
  }
});

it.each([
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
])(
  "retains legal header color/depth %s/%s with either interlace",
  (color, depth) => {
    for (const interlace of [0, 1])
      expect(
        attachmentMediaAdmission(
          image(
            pngHeader(2, 1, (bytes) => {
              bytes[24] = depth;
              bytes[25] = color;
              bytes[28] = interlace;
            }),
          ),
        ).status,
      ).toBe("available");
  },
);

it("does not extract any header until byte and canonical Base64 gates pass", () => {
  const atob = vi.spyOn(globalThis, "atob");
  try {
    for (const data of ["!".repeat(44), "Zg", "Zh==", "AAAA".repeat(5_592_406)])
      expect(attachmentMediaAdmission(image(data)).status).toBe("rejected");
    expect(atob).not.toHaveBeenCalled();
  } finally {
    atob.mockRestore();
  }
});

it("does not pretend a budgeted IHDR proves later image data or animation validity", () => {
  const header = Buffer.from(PNG_IMAGE_TEST_DATA, "base64").subarray(0, 33);
  // This only admits a declared canvas. Missing IDAT/IEND still fails decoding.
  expect(
    attachmentMediaAdmission(image(header.toString("base64"))).status,
  ).toBe("available");
  expect(
    attachmentMediaAdmission(image(PNG_IMAGE_TEST_DATA, "IMAGE/PNG")).status,
  ).toBe("available");
});
