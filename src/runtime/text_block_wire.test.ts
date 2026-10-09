import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseTextBlock, type TextBlockPreview } from "./text_block_preview";
import { parseCopyStatus, type CopyStatus } from "./file_copy_types";
const base =
  "docs/evidence/2026-10-09-capability-hardening/large-file-segments/";
it("accepts actual Rust UTF-8/BOM/CRLF first-middle-last wire receipts and reconstructs its verified digest", () => {
  const blocks = JSON.parse(
    readFileSync(base + "text-block-wire.json", "utf8"),
  ) as TextBlockPreview[];
  for (const b of blocks)
    expect(parseTextBlock(b, b.file, b.blockIndex)).toEqual(b);
  const body = blocks.map((b) => b.text).join("");
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    blocks[0].file.sha256,
  );
  expect(Buffer.byteLength(body)).toBe(blocks[0].file.size);
  expect(body.charCodeAt(0)).toBe(0xfeff);
  expect(body).toContain("\r\n");
});
it("accepts actual prepare and completed Rust copy receipts including settlement proof", () => {
  const statuses = JSON.parse(
    readFileSync(base + "copy-status-wire.json", "utf8"),
  ) as CopyStatus[];
  expect(statuses.map((s) => s.state)).toEqual(["ready", "completed"]);
  for (const s of statuses)
    expect(
      parseCopyStatus(s, s.file, s.destination, statuses[0].operationId),
    ).toEqual(s);
});
