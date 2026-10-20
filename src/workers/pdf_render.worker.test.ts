import { afterEach, beforeEach, expect, it, vi } from "vitest";

const render = vi.hoisted(() => vi.fn());
vi.mock("../runtime/pdf_render_core", () => ({ renderPdfPixels: render }));

// Run the actual dedicated-worker wrapper. Only the parser port and rendering
// Promise are controlled; this does not simulate a genuine PDF.js/browser
// deserialization failure or prove physical descendant-worker termination.
class ParserPeer extends EventTarget {
  static instances: ParserPeer[] = [];
  terminate = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    super();
    ParserPeer.instances.push(this);
  }
}
type Result = {
  bitmap: { close: ReturnType<typeof vi.fn> };
  pages: number;
  pageNumber: number;
};
let complete: (result: Result) => void;
let handling: Promise<void> | undefined;
let bitmap: Result["bitmap"];
let sent: ReturnType<typeof vi.fn>;
let previousConsole: Pick<Console, "warn" | "error">;
let previousMessage: typeof globalThis.onmessage;

beforeEach(() => {
  previousConsole = { warn: console.warn, error: console.error };
  previousMessage = globalThis.onmessage;
  vi.resetModules();
  render.mockReset();
  ParserPeer.instances = [];
  handling = undefined;
  render.mockReturnValue(
    new Promise<Result>((resolve) => {
      complete = resolve;
    }),
  );
  bitmap = { close: vi.fn() };
  sent = vi.fn();
  vi.stubGlobal("Worker", ParserPeer);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("Path2D", class {});
  vi.stubGlobal("postMessage", sent);
});
afterEach(async () => {
  try {
    complete({ bitmap, pages: 2, pageNumber: 1 });
    await handling;
  } finally {
    console.warn = previousConsole.warn;
    console.error = previousConsole.error;
    globalThis.onmessage = previousMessage;
    vi.unstubAllGlobals();
  }
});

it.each(["ready", "error", "messageerror"] as const)(
  "keeps parser %s distinct from a late successful render result",
  async (mode) => {
    await import("./pdf_render.worker");
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = globalThis.onmessage as unknown as (
      event: MessageEvent,
    ) => Promise<void>;
    handling = handle(
      new MessageEvent("message", {
        data: { data: bytes, pageNumber: 1, displayWidth: 800 },
      }),
    );
    expect(ParserPeer.instances).toHaveLength(1);
    expect(render).toHaveBeenCalledOnce();
    const parser = ParserPeer.instances[0];
    expect(render.mock.calls[0].slice(0, 4)).toEqual([bytes, 1, 800, parser]);
    const failed = render.mock.calls[0][4] as () => boolean;
    expect(failed()).toBe(false);
    if (mode !== "ready") {
      parser.dispatchEvent(new Event(mode));
      parser.dispatchEvent(new Event(mode));
      expect(failed()).toBe(true);
      expect(sent.mock.calls.map(([value]) => value)).toEqual([
        { kind: "error", code: "incomplete" },
      ]);
    }
    complete({ bitmap, pages: 2, pageNumber: 1 });
    await handling;
    if (mode === "ready") {
      expect(failed()).toBe(false);
      expect(sent).toHaveBeenCalledExactlyOnceWith(
        { kind: "ready", bitmap, pages: 2, pageNumber: 1 },
        { transfer: [bitmap] },
      );
      expect(bitmap.close).not.toHaveBeenCalled();
    } else {
      expect(sent).toHaveBeenCalledExactlyOnceWith({
        kind: "error",
        code: "incomplete",
      });
      expect(bitmap.close).toHaveBeenCalledOnce();
    }
    expect(parser.terminate).toHaveBeenCalledOnce();
  },
);
