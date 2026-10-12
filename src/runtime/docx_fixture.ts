/** Controlled test fixtures only. Never used by the product ZIP reader. */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { DocxWorkerInput } from "./docx_types";

export function docxFixture(
  name: string,
  directory = "docx-fixtures",
): DocxWorkerInput {
  const data = readFileSync(
    new URL(
      `../../docs/evidence/2026-10-09-capability-hardening/${directory}/${name}.docx`,
      import.meta.url,
    ),
  );
  return docxFixtureBytes(data);
}

/** Decode controlled ZIP bytes for parser tests; never a product ZIP reader. */
export function docxFixtureBytes(data: Buffer): DocxWorkerInput {
  const entries: string[] = [],
    parts: { name: string; data: string }[] = [];
  let at = data.indexOf(Buffer.from("PK\x01\x02", "binary"));
  while (at >= 0 && data.readUInt32LE(at) === 0x02014b50) {
    const length = data.readUInt16LE(at + 28),
      extra = data.readUInt16LE(at + 30),
      comment = data.readUInt16LE(at + 32);
    const name = data.subarray(at + 46, at + 46 + length).toString();
    const local = data.readUInt32LE(at + 42),
      packed = data.readUInt32LE(at + 20);
    const start =
      local +
      30 +
      data.readUInt16LE(local + 26) +
      data.readUInt16LE(local + 28);
    const method = data.readUInt16LE(at + 10);
    if (method !== 0 && method !== 8) throw Error("unsupported test archive");
    const bytes =
      method === 0
        ? data.subarray(start, start + packed)
        : inflateRawSync(data.subarray(start, start + packed), {
            maxOutputLength: 17 * 1024 * 1024,
          });
    entries.push(name);
    if (/\.(xml|rels|png|jpg|jpeg)$/.test(name))
      parts.push({ name, data: bytes.toString("base64") });
    at += 46 + length + extra + comment;
  }
  return { entries, parts };
}
export function replaceDocxPart(
  input: DocxWorkerInput,
  name: string,
  edit: (xml: string) => string,
): DocxWorkerInput {
  return {
    ...input,
    parts: input.parts.map((p) =>
      p.name === name
        ? {
            ...p,
            data: Buffer.from(
              edit(Buffer.from(p.data, "base64").toString()),
            ).toString("base64"),
          }
        : p,
    ),
  };
}
