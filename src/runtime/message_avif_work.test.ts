import { expect, it } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import { MessageRasterReader } from "./message_raster_reader";
import { MESSAGE_AVIF_TEST_DATA as F } from "./message_avif_fixtures.test-support";
import {
  avifBox as box,
  avifFile as file,
  avifIspe as ispe,
  avifMeta as meta,
} from "./message_avif_builders.test-support";

function counted(data: string) {
  const read = MessageRasterReader.prototype.u8;
  let reads = 0;
  MessageRasterReader.prototype.u8 = function (at) {
    reads++;
    return read.call(this, at);
  };
  const started = performance.now();
  try {
    const result = messageAvifAdmission(data, true);
    return { result, reads, elapsedMs: performance.now() - started };
  } finally {
    MessageRasterReader.prototype.u8 = read;
  }
}

it("bounds sparse 16MiB opaque payload work to metadata without a full decode", () => {
  const source = Buffer.from(F.STATIC, "base64");
  const data = Buffer.concat([
    source,
    box("free", Buffer.alloc(16 * 1024 * 1024 - source.length - 8)),
  ]).toString("base64");
  const result = counted(data);
  expect(result.result).toBe("withinBudget");
  expect(result.reads).toBeLessThan(2_000);
  console.info(
    JSON.stringify({
      case: "16MiB-opaque",
      encodedBytes: data.length,
      ...result,
    }),
  );
});

it("caps box-heavy work at the common record limit", () => {
  const leaf = box("free");
  const source = Buffer.from(F.STATIC, "base64");
  for (const count of [65_000, 65_536]) {
    const data = Buffer.concat([
      source,
      ...Array.from({ length: count }, () => leaf),
    ]).toString("base64");
    const result = counted(data);
    expect(result.result).toBe(
      count === 65_000 ? "withinBudget" : "tooComplex",
    );
    expect(result.reads).toBeLessThan(600_000);
    console.info(
      JSON.stringify({
        case: "many-opaque-boxes",
        count,
        encodedBytes: data.length,
        ...result,
      }),
    );
  }
});

it("uses linear direct associations for thousands of items and properties", () => {
  const count = 5_000;
  const items = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    properties: [1],
  }));
  const properties = [
    ispe(1, 1),
    ...Array.from({ length: count - 1 }, () => box("pixi")),
  ];
  const data = file(meta(items, properties));
  const result = counted(data);
  expect(result.result).toBe("withinBudget");
  expect(result.reads).toBeLessThan(200_000);
  console.info(
    JSON.stringify({
      case: "5000-items-5000-properties",
      count,
      encodedBytes: data.length,
      ...result,
    }),
  );
});
