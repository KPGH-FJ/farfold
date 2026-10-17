import { expect, it } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import { MESSAGE_AVIF_TEST_DATA as F } from "./message_avif_fixtures.test-support";

it.each(["STATIC", "SEQUENCE", "GRID", "ALPHA_GRID"] as const)(
  "keeps the actual official %s fixture within its container declaration budget",
  (kind) => expect(messageAvifAdmission(F[kind], true)).toBe("withinBudget"),
);

it("keeps legacy alpha support while explicitly leaving its missing size uncovered", () => {
  expect(messageAvifAdmission(F.LEGACY_ALPHA, true)).toBe("notCovered");
});

it.each(["STATIC", "SEQUENCE", "GRID", "ALPHA_GRID"] as const)(
  "recognizes the actual %s bytes independently of a caller's MIME declaration",
  (kind) => expect(messageAvifAdmission(F[kind], false)).toBe("withinBudget"),
);

it.each(["not an image", "GIF89a", "\xff\xd8\xff"])(
  "distinguishes a non-AVIF from a false declared AVIF",
  (raw) => {
    const data = Buffer.from(raw, "latin1").toString("base64");
    expect(messageAvifAdmission(data, false)).toBe("notAvif");
    expect(messageAvifAdmission(data, true)).toBe("invalid");
  },
);

it("refuses every excessive ispe including auxiliary and tile declarations", () => {
  for (const source of [F.STATIC, F.GRID, F.ALPHA_GRID]) {
    const bytes = Buffer.from(source, "base64");
    for (const at of [bytes.indexOf("ispe"), bytes.lastIndexOf("ispe")]) {
      const changed = Buffer.from(bytes);
      changed.writeUInt32BE(8193, at + 8);
      expect(messageAvifAdmission(changed.toString("base64"), false)).toBe(
        "tooManyPixels",
      );
    }
  }
});

it("rejects a sequence count over the existing 128 sample budget", () => {
  const bytes = Buffer.from(F.SEQUENCE, "base64");
  bytes.writeUInt32BE(129, bytes.indexOf("stsz") + 12);
  expect(messageAvifAdmission(bytes.toString("base64"), false)).toBe(
    "tooComplex",
  );
});
