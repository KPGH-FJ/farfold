import { expect, it } from "vitest";
import { pdfInputText } from "./pdf_input_text";
import { pdfResult } from "./pdf_input_fixture.test-support";

it("copies literal strings and item boundaries, directions, EOL hints and page rotation", () => {
  const input = pdfResult("fiﬁ中🚀\n [1] ", 2);
  input.pages[0].items.push({ text: 'quote"\\\n', dir: "rtl", hasEOL: true });
  input.pages[1].decodedRotation = 90;
  input.pages[1].items[0].dir = "ttb";
  const result = pdfInputText(input);
  expect(JSON.parse(result.text.split("\n\n").at(-1)!)).toEqual({
    pages: input.pages,
  });
  expect(result.actualTextChars).toBe(25);
  expect(result.text).toContain("可能包含页面上看不见的文字");
  expect(result.text).toContain("阅读顺序和显示效果不保证");
  expect(result.text).toContain("不猜测或替换文字");
});
it("does not turn generated scope/page labels into author text or OCR", () => {
  const result = pdfInputText(pdfResult("\n\t ", 2));
  expect(result.actualTextChars).toBe(0);
  expect(result.text).toContain("有 2 页未提取到文字");
});
it("budgets the entire representation, including JSON escaping and range explanations", () => {
  expect(() => pdfInputText(pdfResult('"'.repeat(131000)))).toThrow(
    "textLimit",
  );
  expect(() => pdfInputText(pdfResult("a".repeat(261500)))).toThrow(
    "textLimit",
  );
  const accepted = pdfInputText(pdfResult("a".repeat(260000)));
  expect(accepted.actualTextChars).toBe(260000);
  expect(new TextEncoder().encode(accepted.text).length).toBeLessThanOrEqual(
    262144,
  );
});
it("keeps exact three-field Agent input and the original whole-text boundary with geometry", () => {
  const overhead = Buffer.byteLength(pdfInputText(pdfResult("x")).text) - 1;
  const text = "x".repeat(262144 - overhead),
    plain = pdfResult(text);
  const expected = pdfInputText(plain);
  expect(Buffer.byteLength(expected.text)).toBe(262144);
  const enriched = pdfResult(text);
  enriched.pages[0].items[0].geometry = {
    transform: [12, 0, 0, 12, 10, 100],
    width: 200,
    height: 12,
  };
  expect(pdfInputText(enriched)).toEqual(expected);
  const body = JSON.parse(expected.text.split("\n\n").at(-1)!);
  expect(Object.keys(body.pages[0].items[0])).toEqual([
    "text",
    "dir",
    "hasEOL",
  ]);
  enriched.pages[0].items[0].text += "x";
  expect(() => pdfInputText(enriched)).toThrow("textLimit");
});
