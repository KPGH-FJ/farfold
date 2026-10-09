import { expect, it, vi } from "vitest";

it("forwards only an incomplete signal for parser warnings and errors", async () => {
  const previous = { warn: console.warn, error: console.error };
  const post = vi.fn();
  vi.stubGlobal("postMessage", post);
  try {
    await import("./pdf_parser_diagnostics");
    console.warn("fixture document text", { secret: "fixture diagnostic" });
    console.error(new Error("fixture parser error"));
    expect(post.mock.calls).toEqual([
      [{ farfoldPdfIncomplete: true }],
      [{ farfoldPdfIncomplete: true }],
    ]);
  } finally {
    console.warn = previous.warn;
    console.error = previous.error;
    vi.unstubAllGlobals();
  }
});
