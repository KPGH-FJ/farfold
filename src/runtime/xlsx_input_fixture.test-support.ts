import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { expect } from "vitest";
import type { WorkbookCapture, XlsxWorkerInput } from "./xlsx_types";
export const inputFixtureDirectory = new URL(
  "../../docs/evidence/2026-10-09-capability-hardening/xlsx-input/fixtures/",
  import.meta.url,
);
export const inputOracle = JSON.parse(
  readFileSync(new URL("oracle.json", inputFixtureDirectory), "utf8"),
);
const hashes: Record<string, string> = {
  "01-values-scope":
    "834df0bafb40c08b376d5da8c6e25e1712ec98dfcfcf1492a59582fd94d5e80d",
  "02-protection-format":
    "d588dd30f65be1d70f415d7fbe364f2ec3679ca2d97ffd94861cacfcdc3538c0",
  "03-unread-surfaces":
    "91658ecea876200f17650d9d2b390d9fe22c9945510f6787f149ff7eecb51063",
  "04-invalid-late-sheet":
    "ee34f95a0518f05d71a084c71a385be074d8a616cfb75f61d19f91af210074f3",
  "05-text-budget":
    "00047c47312fdd97c77a19781b5a4017244c68047b588e0064397a16e5444c6a",
  "06-hidden-formula-missing":
    "65c7ab393bd312385934e59371b662e68288467c67b15e286f97684b3ee357f3",
  "07-hidden-formula-empty":
    "f1cabae8417243ee4372b351a557bbb7a7ab3e62c2a7306b04a53d44be4ab3dd",
  "08-hidden-formula-cached":
    "e603c60333f35ffe08a8a6d2a149931467920fdc00642530c6b2d119fa69a605",
};
/** Hash-checked synthetic ZIP only. Native capture is tested independently. */
export function inputZipFixture(id: string): WorkbookCapture {
  const zip = readFileSync(new URL(id + ".xlsx", inputFixtureDirectory));
  expect(createHash("sha256").update(zip).digest("hex")).toBe(hashes[id]);
  const entries: string[] = [],
    parts: XlsxWorkerInput["parts"] = [];
  let inflatedBytes = 0;
  let at = zip.indexOf(Buffer.from("PK\x01\x02", "binary"));
  while (at >= 0 && zip.readUInt32LE(at) === 0x02014b50) {
    const length = zip.readUInt16LE(at + 28),
      name = zip.subarray(at + 46, at + 46 + length).toString();
    const local = zip.readUInt32LE(at + 42),
      packed = zip.readUInt32LE(at + 20),
      method = zip.readUInt16LE(at + 10);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    expect([0, 8]).toContain(method);
    const bytes =
      method === 0
        ? zip.subarray(start, start + packed)
        : inflateRawSync(zip.subarray(start, start + packed), {
            maxOutputLength: 16 * 1024 * 1024,
          });
    expect(bytes.length).toBe(zip.readUInt32LE(at + 24));
    inflatedBytes += bytes.length;
    entries.push(name);
    if (/\.(xml|rels)$/.test(name))
      parts.push({ name, data: bytes.toString("base64") });
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return {
    entries,
    parts,
    inflatedBytes,
    file: {
      root: "/fixture",
      path: "/fixture/" + id + ".xlsx",
      resolvedPath: "/fixture/" + id + ".xlsx",
      name: id + ".xlsx",
      size: zip.length,
      sha256: hashes[id],
      version: "fixture-v2",
    },
  };
}
