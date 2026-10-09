import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  captureDocument: vi.fn(),
  captureWorkbook: vi.fn(),
  parseDocument: vi.fn(),
  parseWorkbook: vi.fn(),
}));
vi.mock("react", async (original) => {
  const api = await original<typeof import("react")>();
  const effect = (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++,
      previous = h.slots[index];
    const next = { deps, cleanup: previous?.cleanup };
    h.slots[index] = next;
    if (!previous || deps.some((v, i) => !Object.is(v, previous.deps?.[i])))
      h.effects.push(() => {
        previous?.cleanup?.();
        next.cleanup = callback() || undefined;
      });
  };
  return {
    ...api,
    useState: (initial: unknown) => {
      const slot = (h.slots[h.cursor++] ??= {
        value: typeof initial === "function" ? initial() : initial,
      });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useRef: (initial: unknown) =>
      (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
    useMemo: (read: () => unknown, deps: unknown[]) => {
      const index = h.cursor++,
        previous = h.slots[index];
      if (!previous || deps.some((v, i) => !Object.is(v, previous.deps?.[i])))
        h.slots[index] = { value: read(), deps };
      return h.slots[index].value;
    },
    useLayoutEffect: effect,
    useEffect: effect,
  };
});
vi.mock("../runtime/docx_preview", () => ({
  readDocxCapture: h.captureDocument,
  readDocxPreview: h.parseDocument,
}));
vi.mock("../runtime/xlsx_preview", () => ({
  readWorkbookCapture: h.captureWorkbook,
  readWorkbookPreview: h.parseWorkbook,
}));
vi.mock("./DocxDocumentView", () => ({ DocxDocumentView: () => null }));
import { DocxFilePreview } from "./DocxFilePreview";
import { WorkbookFilePreview } from "./WorkbookFilePreview";
import { DocxError } from "../runtime/docx_types";
import { XlsxError } from "../runtime/xlsx_types";
import { DOCUMENT_STRINGS } from "../runtime/document_strings";
import { WORKBOOK_STRINGS } from "../runtime/workbook_strings";

const file = {
  root: "/work",
  path: "/work/report",
  resolvedPath: "/work/report",
  name: "report",
  size: 100,
  version: "one",
  sha256: "one",
};
function render(component: () => ReactNode) {
  h.cursor = 0;
  const tree = component();
  for (const effect of h.effects.splice(0)) effect();
  return renderToStaticMarkup(tree);
}
const settle = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  h.captureDocument.mockReset().mockRejectedValue(new DocxError("readPending"));
  h.captureWorkbook.mockReset().mockRejectedValue(new XlsxError("readPending"));
  h.parseDocument.mockReset();
  h.parseWorkbook.mockReset();
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
});

// Actual leaf lifecycle, only capture and parser boundaries mocked. An OS-read
// timeout is not a completed operation; hiding is not consent to retry it.
it.each(["docx", "xlsx"] as const)(
  "%s does not automatically recapture after readPending on hide/show",
  async (kind) => {
    const capture = kind === "docx" ? h.captureDocument : h.captureWorkbook;
    const component = kind === "docx" ? DocxFilePreview : WorkbookFilePreview;
    const source = { ...file, name: `report.${kind}` };
    render(() => component({ file: source, active: true }));
    await settle();
    const failed = render(() => component({ file: source, active: true }));
    expect(capture).toHaveBeenCalledOnce();
    expect(failed).toContain(
      kind === "docx"
        ? DOCUMENT_STRINGS.readPending
        : WORKBOOK_STRINGS.readPending,
    );
    render(() => component({ file: source, active: false }));
    render(() => component({ file: source, active: true }));
    await settle();
    render(() => component({ file: source, active: true }));
    expect(capture).toHaveBeenCalledOnce();
  },
);
