import { afterEach, expect, it, vi } from "vitest";
import { scrollTranscriptRange } from "./transcript_find_scroll";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const outerPage = { scrollTop: 37, scrollLeft: 19 };
  const root = {
    parentElement: outerPage,
    clientTop: 0,
    clientLeft: 0,
    clientWidth: 100,
    clientHeight: 100,
    scrollWidth: 500,
    scrollHeight: 100,
    scrollTop: 0,
    scrollLeft: 0,
    contains: (node: unknown) => node === root,
    getBoundingClientRect: () => ({ top: 0, left: 0 }),
    scrollTo: vi.fn((options: ScrollToOptions) => {
      root.scrollTop = options.top ?? root.scrollTop;
      root.scrollLeft = options.left ?? root.scrollLeft;
    }),
  };
  const rectangle = () => ({
    left: 400 - root.scrollLeft,
    right: 420 - root.scrollLeft,
    top: 20,
    bottom: 40,
    width: 20,
    height: 20,
  });
  const range = {
    startContainer: { parentElement: root },
    getClientRects: vi.fn(() => [rectangle()]),
  };
  vi.stubGlobal("getComputedStyle", () => ({
    overflowX: "auto",
    overflowY: "visible",
  }));
  const run = () =>
    scrollTranscriptRange(
      range as unknown as Range,
      root as unknown as HTMLElement,
    );
  return { root, outerPage, range, rectangle, run };
}

it("brings an exact code match into the horizontal viewport without scrolling outside its transcript", () => {
  const f = fixture();
  f.run();
  expect(f.rectangle().left).toBeGreaterThanOrEqual(0);
  expect(f.rectangle().right).toBeLessThanOrEqual(f.root.clientWidth);
  expect(f.root.scrollTop).toBe(0);
  expect(f.outerPage).toEqual({ scrollTop: 37, scrollLeft: 19 });
});

it("keeps an already visible match stationary", () => {
  const f = fixture();
  f.root.scrollLeft = 350;
  f.run();
  expect(f.root.scrollLeft).toBe(350);
  expect(f.root.scrollTo).not.toHaveBeenCalled();
});

it("uses the first painted range fragment after empty layout rectangles", () => {
  const f = fixture();
  f.range.getClientRects.mockImplementation(() => [
    { left: -900, right: -900, top: 0, bottom: 0, width: 0, height: 0 },
    f.rectangle(),
  ]);
  f.run();
  expect(f.rectangle().left).toBeGreaterThanOrEqual(0);
  expect(f.rectangle().right).toBeLessThanOrEqual(f.root.clientWidth);
});

it("leaves an unpainted range alone while its disclosure is still committing", () => {
  const f = fixture();
  f.range.getClientRects.mockReturnValue([]);
  f.run();
  expect(f.root.scrollTo).not.toHaveBeenCalled();
  expect(f.root.scrollLeft).toBe(0);
});

it("does not read geometry or scroll for a range outside the owning transcript", () => {
  const f = fixture();
  f.root.contains = () => false;
  f.run();
  expect(f.range.getClientRects).not.toHaveBeenCalled();
  expect(f.root.scrollTo).not.toHaveBeenCalled();
});
